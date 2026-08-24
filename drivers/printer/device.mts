import Homey from 'homey';

import { planCapabilities } from '../../lib/capability-map.mjs';
import {
  isLegacyCapability,
  legacyAssignments,
  resolveCapability,
} from '../../lib/legacy-capabilities.mjs';
import { assignSupplyCapabilities, isSupplyCapability } from '../../lib/supply-capabilities.mjs';
import { PrinterReader, type PrinterSnapshot } from '../../lib/printer-reader.mjs';
import { SnmpUnreachableError, type SnmpVersion } from '../../lib/snmp-client.mjs';

/** What pairing stored on the device; the address can later be corrected in settings. */
interface PrinterSettings {
  host: string;
  community: string;
  version: SnmpVersion;
  pollInterval: number;
  lowThreshold: number;
  offlineAfter: number;
}

/**
 * How many polls in a row must fail before the device is shown as unavailable.
 *
 * Consumer printers drop off the network while asleep and answer again on the
 * next job. Marking the device unavailable on the first timeout would make it
 * flicker all day, so a short outage is absorbed silently.
 *
 * This is only the default: how long a printer may stay silent before it counts
 * as off is a property of the printer, not of the app. One that sleeps deeply
 * needs the grace; one the user switches off at the wall is off the moment it
 * stops answering, and waiting three checks to grey it out just looks broken.
 */
const DEFAULT_FAILURES_BEFORE_UNAVAILABLE = 3;

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
  /**
   * Titles already stored, so a capability is only renamed when it really
   * changes. Keyed on the serialised title rather than the title itself: a
   * fallback title is a translation object, and a fresh object is never `===`
   * the previous poll's, which would mean an expensive `setCapabilityOptions`
   * write every five minutes for ever.
   */
  private appliedTitles = new Map<string, string>();
  /**
   * The warning this instance last wrote, so it is rewritten only when it changes.
   *
   * `undefined` means "we have not written one yet and do not know what Homey is
   * holding" — which is the state every app start begins in. It must not be
   * `null`, because `null` means "there is no warning", and a device warning
   * survives an app restart: starting at `null` made the first poll of a healthy
   * printer conclude the warning was already cleared and skip clearing it. A
   * user was left with a permanent "Low: Waste Toner Bottle" badge on a printer
   * whose bottle read 100 %.
   */
  private lastWarning: string | null | undefined = undefined;

  override async onInit(): Promise<void> {
    this.buildReader();

    await this.adoptDeclaredCapabilities();

    // The first poll is started, not awaited. Homey initialises devices in
    // sequence, so blocking here for a printer that is asleep — up to a full
    // SNMP timeout per OID — would hold up every other device behind it.
    void this.poll().finally(() => this.scheduleNextPoll());
  }

  /**
   * Gives an existing device the capabilities the driver now declares.
   *
   * Homey hands the manifest's capability list to devices added *after* it
   * changed; ones already paired keep whatever they had. Every other capability
   * here is added from a snapshot instead, which is right for them — they
   * describe what the printer reported. `onoff` describes whether it reported
   * at all, so the case that matters most is a printer switched off when the
   * app starts, which is exactly the case no snapshot can cover: a device
   * updated while its printer was off got no `onoff` and no dimmed tile, which
   * is the whole point of having one.
   *
   * Done from the manifest rather than by naming `onoff` so the next capability
   * added to the driver does not repeat this.
   */
  private async adoptDeclaredCapabilities(): Promise<void> {
    const declared = (this.driver.manifest as { capabilities?: string[] }).capabilities ?? [];
    for (const capability of declared) {
      if (this.hasCapability(capability)) continue;
      await this.addCapability(capability).catch((e: Error) =>
        this.error(`Could not add ${capability}: ${e.message}`));
    }
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
      offlineAfter: Math.max(0, Number(this.getSetting('offline_after') ?? DEFAULT_FAILURES_BEFORE_UNAVAILABLE)),
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

    await this.safeSet('onoff', false);
    await this.safeSet('printer_status', 'offline');
    await this.triggerStatusChange('offline');

    const { offlineAfter } = this.readSettings();

    // Zero means never mark it unavailable.
    //
    // Homey's `unavailable` means "this device is broken": it greys the tile,
    // but it also hides every reading and — because this driver offers a repair
    // flow — asks the user to repair a printer they switched off themselves. A
    // user who wanted the tile greyed found that trade a bad one: "no stats
    // available as homey insists on a repair". The status capability still says
    // `offline` on the first missed check either way, so Flows lose nothing.
    if (offlineAfter === 0) {
      // Clearing, not just abstaining. The flag survives an app restart, and
      // only a successful read ever lifted it — so a device flagged before the
      // setting was turned off stayed flagged, showing a repair screen the
      // setting promised to prevent, with no way out but the printer coming
      // back on. "Never mark it unavailable" has to mean it is not marked now.
      await this.clearUnavailable();
      this.log(`${message} (not marking unavailable: offline_after is 0)`);
      return;
    }

    if (this.consecutiveFailures < offlineAfter) {
      this.log(`${message} (attempt ${this.consecutiveFailures}, still treating as asleep)`);
      return;
    }

    this.error(message);
    await this.setUnavailable(this.homey.__('device.unreachable')).catch(() => {});
  }

  /** Lifts the unavailable flag if it is set. Safe to call when it is not. */
  private async clearUnavailable(): Promise<void> {
    if (this.getAvailable()) return;
    await this.setAvailable().catch((e: Error) =>
      this.error(`Could not clear the unavailable flag: ${e.message}`));
  }

  /** Writes a snapshot to capabilities, adding or removing rows as the printer's supplies change. */
  private async applySnapshot(snapshot: PrinterSnapshot): Promise<void> {
    const plan = planCapabilities(snapshot, this.readSettings().lowThreshold);

    // Before anything is written, because migration decides what the old rows
    // become and this is the one poll that still has both lists in hand.
    await this.migrateLegacyCapabilities(snapshot);

    // An empty supplies table means the walk returned nothing, which is a failed
    // read rather than a printer with no cartridges. Every printer has at least one.
    await this.syncCapabilities(plan.capabilities, snapshot.supplies.length > 0);

    await this.reportLowSupplies(plan.lowSupplies);

    // The printer's own wording names the exact cartridge to reorder. Writing it
    // is persistent and the SDK calls it an expensive operation, and these
    // titles change only when a cartridge is replaced by a different type — so
    // it is written on change, not on every poll.
    for (const [capability, title] of plan.titles) {
      const key = JSON.stringify(title);
      if (this.appliedTitles.get(capability) === key) continue;

      await this.setCapabilityOptions(capability, { title })
        .then(() => this.appliedTitles.set(capability, key))
        .catch((e: Error) => this.error(`Could not title ${capability}: ${e.message}`));
    }

    for (const { id, value } of plan.values) {
      await this.safeSet(id, value);
    }

    await this.fireTriggers(snapshot, plan.values);
  }

  /**
   * Moves a device paired before 1.1.0 onto the sub-capability ids.
   *
   * Runs on the first successful poll after the update and then never again,
   * because it only does anything while old capabilities are still present.
   *
   * Two things have to happen in the same pass. The old ids are removed, which
   * is what actually costs the user something: `removeCapability` destroys that
   * capability's Insights history and adding it back does not restore it. And
   * before they go, each one is paired with the id that replaces it, because
   * that pairing is knowable only here — `supply_other_3` was the third supply
   * without a colour in the printer's table, and nothing about the string says
   * which row that was. The map is stored so a Flow saved against the old name
   * keeps resolving for as long as the device lives.
   *
   * Only ever called with a snapshot whose supplies table was actually read: a
   * printer waking from sleep can answer some OIDs and not others, and pairing
   * old rows against a thin read would record a wrong map permanently.
   */
  private async migrateLegacyCapabilities(snapshot: PrinterSnapshot): Promise<void> {
    const legacy = this.getCapabilities().filter(isLegacyCapability);
    if (legacy.length === 0) return;
    if (snapshot.supplies.length === 0) return;

    const renamed: Record<string, string> = {
      ...(this.getStoreValue('renamedCapabilities') as Record<string, string> | undefined ?? {}),
    };

    const before = legacyAssignments(snapshot.supplies);
    const after = assignSupplyCapabilities(snapshot.supplies);
    before.forEach((old, i) => {
      const now = after[i]?.capability;
      if (old !== null && now !== undefined) renamed[old] = now;
    });

    await this.setStoreValue('renamedCapabilities', renamed).catch((e: Error) =>
      this.error(`Could not record the renamed capabilities: ${e.message}`));

    this.log(`Migrating ${legacy.length} capability/ies to sub-capabilities: ${legacy.join(', ')}`);

    for (const capability of legacy) {
      await this.removeCapability(capability).catch((e: Error) =>
        this.error(`Could not remove ${capability}: ${e.message}`));
      this.appliedTitles.delete(capability);
    }
  }

  /**
   * Puts the names of the low supplies on the device itself.
   *
   * The alarm capability is a bare boolean: it can say that something is low and
   * never which thing. On a laser that reports a photoconductor and a waste
   * bottle alongside its toner, that leaves the user looking at a lit alarm with
   * every level on screen reading fine. Homey's own warning banner is the one
   * place a device can say why, so the names go there.
   */
  private async reportLowSupplies(low: string[]): Promise<void> {
    const message = low.length > 0 ? this.homey.__('device.supply_low', { supplies: low.join(', ') }) : null;
    // Never skips on the first poll, whatever the outcome: see lastWarning.
    if (message === this.lastWarning) return;

    const write = message === null ? this.unsetWarning() : this.setWarning(message);
    // Only remember it once Homey has taken it. Caching a write that failed
    // would leave the device showing one thing and this instance believing
    // another, with no poll able to reconcile them.
    await write
      .then(() => { this.lastWarning = message; })
      .catch((e: Error) => this.error(`Could not set the warning: ${e.message}`));
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
   * conclusive: supply and tray rows when the supplies table was read
   * successfully, and never the scalar rows, whose absence only ever means the
   * printer stayed silent about them this time.
   */
  private async syncCapabilities(wanted: string[], suppliesWereRead: boolean): Promise<void> {
    const current = this.getCapabilities();

    if (suppliesWereRead) {
      const stale = current.filter((c) =>
        isSupplyCapability(c) && !wanted.includes(c));
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

  /**
   * Decides whether an mDNS result is this printer.
   *
   * The first match is by address, which is all we have when a device was added
   * by the subnet sweep. From then on the discovery id is remembered, because
   * the address is exactly the thing that changes when a DHCP lease moves — and
   * matching on it would lose the printer at the moment we most need to follow it.
   */
  override onDiscoveryResult(result: Homey.DiscoveryResult): boolean {
    const known = this.getStoreValue('discoveryId') as string | undefined;
    if (known) return known === result.id;

    const address = (result as Homey.DiscoveryResultMDNSSD).address;
    return typeof address === 'string' && address === this.readSettings().host;
  }

  /** Called once when the printer is first seen on the network. */
  override async onDiscoveryAvailable(result: Homey.DiscoveryResult): Promise<void> {
    await this.setStoreValue('discoveryId', result.id).catch(() => {});
    await this.adoptDiscoveredAddress(result);
  }

  /**
   * Called when the printer turns up at a different address.
   *
   * This is the whole point of discovery for this app: a DHCP lease change used
   * to mean the device went unavailable until the user repaired it by hand.
   */
  override async onDiscoveryAddressChanged(result: Homey.DiscoveryResult): Promise<void> {
    await this.adoptDiscoveredAddress(result);
  }

  /** Writes a newly discovered address into settings and re-reads the printer. */
  private async adoptDiscoveredAddress(result: Homey.DiscoveryResult): Promise<void> {
    const address = (result as Homey.DiscoveryResultMDNSSD).address;
    if (typeof address !== 'string' || address.length === 0) return;
    if (address === this.readSettings().host) return;

    this.log(`Discovery moved this printer to ${address}`);
    await this.setSettings({ host: address }).catch((e: Error) =>
      this.error(`Could not store the new address: ${e.message}`));

    await this.reconfigure();
  }

  /**
   * Picks up settings that were written to the device from outside it.
   *
   * `setSettings()` called from code does not fire `onSettings()` — that hook is
   * for changes a user makes in the settings UI. So a repair, or a discovered
   * address change, would store a new host and leave this device polling the old
   * one until the app restarted. Repair exists precisely to follow a printer
   * whose address moved, so that was the one path where it mattered most.
   *
   * Polling immediately is what clears the unavailable flag: `poll()` calls
   * `setAvailable()` the moment a read succeeds, and a user who has just proved
   * their printer answers should not then wait out a five-minute poll interval
   * watching it sit greyed out.
   */
  async reconfigure(): Promise<void> {
    this.buildReader();
    this.consecutiveFailures = 0;
    await this.poll();
  }

  /** Reads the printer now, outside the poll schedule. Backs the "refresh" Flow action. */
  async refreshNow(): Promise<void> {
    await this.poll();
  }

  /**
   * Exposes the current supply levels to Flow conditions without a second SNMP
   * round trip.
   *
   * The id is resolved first, because a Flow written before 1.1.0 still holds
   * the capability name it was saved with. Reading a missing capability as null
   * would make the condition answer "not below", so a Flow built to catch a low
   * cartridge would quietly stop firing rather than fail visibly.
   */
  supplyLevel(capability: string): number | null {
    const id = resolveCapability(
      capability,
      (c) => this.hasCapability(c),
      this.getStoreValue('renamedCapabilities') as Record<string, string> | undefined ?? {},
    );
    if (id === null) return null;

    const value = this.getCapabilityValue(id);
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
    // Turning the flag off has to act on the device that is greyed out right
    // now — that is the state the user is looking at when they come to change
    // it. Waiting for the next failed poll would leave the repair screen up for
    // a whole poll interval after the setting said it should be gone.
    if (changedKeys.includes('offline_after')) {
      this.homey.setTimeout(() => {
        if (this.readSettings().offlineAfter === 0) void this.clearUnavailable();
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
