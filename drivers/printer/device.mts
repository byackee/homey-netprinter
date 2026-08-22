import Homey from 'homey';

import { planCapabilities } from '../../lib/capability-map.mjs';
import { PrinterReader, type PrinterSnapshot } from '../../lib/printer-reader.mjs';
import { SnmpUnreachableError, type SnmpVersion } from '../../lib/snmp-client.mjs';

/** What pairing stored on the device; the address can later be corrected in settings. */
interface PrinterSettings {
  host: string;
  community: string;
  version: SnmpVersion;
  pollInterval: number;
  lowThreshold: number;
}

/**
 * How many polls in a row must fail before the device is shown as unavailable.
 *
 * Consumer printers drop off the network while asleep and answer again on the
 * next job. Marking the device unavailable on the first timeout would make it
 * flicker all day, so a short outage is absorbed silently.
 */
const FAILURES_BEFORE_UNAVAILABLE = 3;

export default class PrinterDevice extends Homey.Device {
  private reader!: PrinterReader;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  /** Guards against a slow poll overlapping the next tick. */
  private polling = false;
  /** Last values seen, so Flow triggers fire on change rather than on every poll. */
  private lastStatus: string | null = null;
  private lastPageCount: number | null = null;
  private lastErrorAlarm = false;
  /** Supplies already below the threshold, so the low trigger fires once per crossing. */
  private lowSupplies = new Set<string>();

  override async onInit(): Promise<void> {
    this.buildReader();
    await this.poll();
    this.scheduleNextPoll();
  }

  /** Rebuilds the SNMP reader from current settings. Called on init and on every settings change. */
  private buildReader(): void {
    const s = this.readSettings();
    this.reader = new PrinterReader(s.host, s.community, s.version);
  }

  private readSettings(): PrinterSettings {
    return {
      host: String(this.getSetting('host') ?? ''),
      community: String(this.getSetting('community') ?? 'public'),
      version: (this.getSetting('version') as SnmpVersion) ?? 'v2c',
      pollInterval: Number(this.getSetting('poll_interval') ?? 300),
      lowThreshold: Number(this.getSetting('low_threshold') ?? 15),
    };
  }

  /**
   * Schedules the next poll with `homey.setTimeout`, which Homey cancels when the
   * app stops — a bare global timer would keep firing against a destroyed device.
   *
   * A chained timeout is used rather than an interval so a slow printer can never
   * queue polls up behind itself.
   */
  private scheduleNextPoll(): void {
    const seconds = Math.max(30, this.readSettings().pollInterval);
    this.timer = this.homey.setTimeout(() => {
      void this.poll().finally(() => this.scheduleNextPoll());
    }, seconds * 1_000);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.homey.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Reads the printer and writes the result to Homey. Never throws. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const snapshot = await this.reader.read();
      this.consecutiveFailures = 0;
      if (!this.getAvailable()) await this.setAvailable();
      await this.applySnapshot(snapshot);
    } catch (error) {
      await this.handleFailure(error);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Absorbs a short outage, then reports the printer as unavailable.
   *
   * The status capability is set to `offline` immediately either way, so a Flow
   * watching the status reacts on the first missed poll even while the device
   * itself is still nominally available.
   */
  private async handleFailure(error: unknown): Promise<void> {
    this.consecutiveFailures += 1;
    const message = error instanceof SnmpUnreachableError
      ? error.message
      : `Poll failed: ${(error as Error).message}`;

    await this.safeSet('printer_status', 'offline');
    await this.triggerStatusChange('offline');

    if (this.consecutiveFailures < FAILURES_BEFORE_UNAVAILABLE) {
      this.log(`${message} (attempt ${this.consecutiveFailures}, still treating as asleep)`);
      return;
    }

    this.error(message);
    await this.setUnavailable(this.homey.__('device.unreachable')).catch(() => {});
  }

  /** Writes a snapshot to capabilities, adding or removing rows as the printer's supplies change. */
  private async applySnapshot(snapshot: PrinterSnapshot): Promise<void> {
    const plan = planCapabilities(snapshot, this.readSettings().lowThreshold);

    if (plan.dropped.length > 0) {
      this.log(`No capability slot left for: ${plan.dropped.map((s) => s.description).join(', ')}`);
    }

    // An empty supplies table means the walk returned nothing, which is a failed
    // read rather than a printer with no cartridges. Every printer has at least one.
    await this.syncCapabilities(plan.capabilities, snapshot.supplies.length > 0);

    for (const [capability, title] of plan.titles) {
      // The printer's own wording names the exact cartridge to reorder.
      await this.setCapabilityOptions(capability, { title }).catch(() => {});
    }

    for (const { id, value } of plan.values) {
      await this.safeSet(id, value);
    }

    await this.fireTriggers(snapshot, plan.values);
  }

  /**
   * Brings the device's capability list in line with what the printer reports.
   *
   * `removeCapability` destroys the capability's Insights history, and adding it
   * back does not restore it. Removal therefore has to mean "this supply is
   * genuinely gone", never "this poll came back thin" — a printer waking from
   * sleep can answer some OIDs and not others, and dropping a row on that basis
   * would quietly erase weeks of graphs.
   *
   * So a capability is only removed when the reading it belongs to was actually
   * conclusive: supply rows when the supplies table was read successfully, and
   * never the scalar rows, whose absence only ever means the printer stayed
   * silent about them this time.
   */
  private async syncCapabilities(wanted: string[], suppliesWereRead: boolean): Promise<void> {
    const current = this.getCapabilities();

    if (suppliesWereRead) {
      const stale = current.filter((c) => c.startsWith('supply_') && !wanted.includes(c));
      for (const capability of stale) {
        await this.removeCapability(capability).catch((e: Error) =>
          this.error(`Could not remove ${capability}: ${e.message}`));
      }
    }

    for (const capability of wanted) {
      if (!current.includes(capability)) {
        await this.addCapability(capability).catch((e: Error) =>
          this.error(`Could not add ${capability}: ${e.message}`));
      }
    }
  }

  /** Sets a capability without letting one bad value abort the rest of the poll. */
  private async safeSet(capability: string, value: unknown): Promise<void> {
    if (!this.hasCapability(capability)) return;
    await this.setCapabilityValue(capability, value).catch((e: Error) =>
      this.error(`Could not set ${capability}: ${e.message}`));
  }

  /** Fires the Flow cards whose underlying value actually changed since the last poll. */
  private async fireTriggers(
    snapshot: PrinterSnapshot,
    values: ReadonlyArray<{ id: string; value: unknown }>,
  ): Promise<void> {
    if (snapshot.status !== this.lastStatus) {
      await this.triggerStatusChange(snapshot.status);
    }

    if (snapshot.pageCount !== null && this.lastPageCount !== null
      && snapshot.pageCount > this.lastPageCount) {
      await this.homey.flow
        .getDeviceTriggerCard('pages_printed')
        .trigger(this, {
          pages: snapshot.pageCount - this.lastPageCount,
          total: snapshot.pageCount,
        })
        .catch((e: Error) => this.error(`pages_printed trigger: ${e.message}`));
    }
    if (snapshot.pageCount !== null) this.lastPageCount = snapshot.pageCount;

    const errorAlarm = values.find((v) => v.id === 'alarm_printer_error')?.value === true;
    if (errorAlarm && !this.lastErrorAlarm) {
      await this.homey.flow
        .getDeviceTriggerCard('printer_error')
        .trigger(this, { errors: snapshot.errors.join(', ') })
        .catch((e: Error) => this.error(`printer_error trigger: ${e.message}`));
    }
    this.lastErrorAlarm = errorAlarm;

    // The low-supply trigger carries which supply fell, so one Flow can cover them
    // all. It fires on the crossing, not on the state: a cartridge that sits at
    // 12 % for a fortnight must notify once, not once per poll.
    const threshold = this.readSettings().lowThreshold;
    const stillLow = new Set<string>();

    for (const supply of snapshot.supplies) {
      if (supply.percent === null || supply.percent > threshold) continue;
      const key = supply.description || supply.colour;
      stillLow.add(key);
      if (this.lowSupplies.has(key)) continue;

      await this.homey.flow
        .getDeviceTriggerCard('supply_low')
        .trigger(this, {
          supply: key,
          level: supply.percent,
        }, { colour: supply.colour })
        .catch((e: Error) => this.error(`supply_low trigger: ${e.message}`));
    }
    // Dropping refilled supplies re-arms the trigger for the next cartridge.
    this.lowSupplies = stillLow;
  }

  private async triggerStatusChange(status: string): Promise<void> {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    await this.homey.flow
      .getDeviceTriggerCard('status_changed')
      .trigger(this, { status }, { status })
      .catch((e: Error) => this.error(`status_changed trigger: ${e.message}`));
  }

  /** Reads the printer now, outside the poll schedule. Backs the "refresh" Flow action. */
  async refreshNow(): Promise<void> {
    await this.poll();
  }

  /** Exposes the current supply levels to Flow conditions without a second SNMP round trip. */
  supplyLevel(capability: string): number | null {
    if (!this.hasCapability(capability)) return null;
    const value = this.getCapabilityValue(capability);
    return typeof value === 'number' ? value : null;
  }

  override async onSettings({ changedKeys }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<void> {
    // Homey applies the new settings only after this resolves, so the reader is
    // rebuilt on the next tick rather than from the values we would read now.
    if (changedKeys.some((k) => ['host', 'community', 'version'].includes(k))) {
      this.homey.setTimeout(() => {
        this.buildReader();
        this.consecutiveFailures = 0;
        void this.poll();
      }, 500);
    }
    if (changedKeys.includes('poll_interval')) {
      this.homey.setTimeout(() => {
        this.clearTimer();
        this.scheduleNextPoll();
      }, 500);
    }
  }

  override async onUninit(): Promise<void> {
    this.clearTimer();
  }

  override async onDeleted(): Promise<void> {
    this.clearTimer();
  }
}
