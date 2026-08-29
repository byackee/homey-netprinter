import Homey from 'homey';

import { planCapabilities } from '../../lib/capability-map.mjs';
import {
  RENAMED,
  isLegacyCapability,
  legacyAssignments,
  replayIsTrustworthy,
  resolveCapability,
} from '../../lib/legacy-capabilities.mjs';
import {
  TRAY_CAPABILITY,
  assignSupplyCapabilities,
  isSupplyCapability,
} from '../../lib/supply-capabilities.mjs';
import {
  PrinterReader,
  snmpVersionOf,
  type PrinterSnapshot,
  type ReadProtocol,
} from '../../lib/printer-reader.mjs';
import { SnmpUnreachableError, negotiateVersion, type SnmpVersion } from '../../lib/snmp-client.mjs';

/** What pairing stored on the device; the address can later be corrected in settings. */
interface PrinterSettings {
  host: string;
  community: string;
  version: ReadProtocol;
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

/** How long one whole read may take before the poll is failed. See withDeadline. */
const POLL_DEADLINE_MS = 120_000;

/**
 * How long each version gets when the stored one has stopped working.
 *
 * Short on purpose: this runs against a printer that has already missed several
 * polls, so the likeliest answer is silence on both versions, and nothing waits
 * on it — the device is about to be marked unavailable either way.
 */
const RENEGOTIATE_TIMEOUT_MS = 2_000;

export default class PrinterDevice extends Homey.Device {
  private reader!: PrinterReader;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  /** Guards against a slow poll overlapping the next tick. */
  private polling = false;
  /**
   * Whether this outage has already had its SNMP version questioned.
   *
   * One negotiation per outage, not one per poll: a printer that is simply off
   * would otherwise be interrogated on two versions every five minutes for as
   * long as it stays off.
   */
  private renegotiated = false;
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
  /**
   * What the last poll did, for the settings page.
   *
   * A device that silently stops polling is indistinguishable from one whose
   * printer simply has not changed, and both look identical to a page that only
   * ever reads the printer live. This is the missing half.
   */
  private lastPoll: { at: string; outcome: string } | null = null;
  /**
   * Capability writes that failed on the last poll.
   *
   * These are caught so one bad row cannot abort a whole poll, which is right —
   * but caught and logged means invisible, because a devkit install has no
   * readable log. A migration that fails every single add looks exactly like a
   * migration that never ran.
   */
  private capabilityErrors: string[] = [];

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
    this.reader = new PrinterReader(s.host, s.community, snmpVersionOf(s.version));
  }

  private readSettings(): PrinterSettings {
    return {
      host: String(this.getSetting('host') ?? ''),
      community: String(this.getSetting('community') ?? 'public'),
      version: (this.getSetting('version') as ReadProtocol) ?? 'v2c',
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

  /**
   * Fails a read that never finishes, so the schedule cannot be lost.
   *
   * Every SNMP timeout in this app is per-request: an agent that answers each
   * one promptly but never stops answering never trips any of them. That would
   * be an odd printer rather than an impossible one — and the consequence is
   * out of all proportion, because `poll()` sets `polling` and the next poll is
   * chained off this one finishing. A read that never returns therefore does
   * not just fail; it silently ends the device's polling for the lifetime of
   * the app, with the tile still showing its last values and nothing anywhere
   * saying why.
   *
   * Generous on purpose: a sleeping printer answering twelve walks over a slow
   * link is normal, and this is a backstop, not a latency budget.
   */
  private async withDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = this.homey.setTimeout(
            () => reject(new Error(`No complete answer within ${POLL_DEADLINE_MS / 1000}s`)),
            POLL_DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== null) this.homey.clearTimeout(timer);
    }
  }

  /** Reads the printer and writes the result to Homey. Never throws. */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const snapshot = await this.withDeadline(this.reader.read());
      this.consecutiveFailures = 0;
      this.renegotiated = false;
      if (!this.getAvailable()) await this.setAvailable();
      await this.applySnapshot(snapshot);
      await this.rememberFirmware(snapshot.firmware);
      this.lastPoll = { at: new Date().toISOString(), outcome: 'ok' };
    } catch (error) {
      this.lastPoll = { at: new Date().toISOString(), outcome: `failed: ${(error as Error).message}` };
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

    const { offlineAfter } = this.readSettings();

    // Before the writes, not after. Homey blocks capability values on a device
    // it considers unavailable, so a device still carrying that flag would have
    // dropped the very writes meant to dim its tile, and only caught up a poll
    // later. Pointed out by smarthomesven on the community forum.
    if (offlineAfter === 0) await this.clearUnavailable();

    await this.safeSet('onoff', false);
    await this.safeSet('printer_status', 'offline');
    await this.triggerStatusChange('offline');

    // Zero means never mark it unavailable.
    //
    // Homey's `unavailable` means "this device is broken": it greys the tile,
    // but it also hides every reading and — because this driver offers a repair
    // flow — asks the user to repair a printer they switched off themselves. A
    // user who wanted the tile greyed found that trade a bad one: "no stats
    // available as homey insists on a repair". The status capability still says
    // `offline` on the first missed check either way, so Flows lose nothing.
    if (offlineAfter === 0) {
      // The flag was cleared above rather than merely not set: it survives an
      // app restart and only a successful read ever lifted it, so a device
      // flagged before the setting was turned off stayed flagged, showing a
      // repair screen the setting promised to prevent, with no way out but the
      // printer coming back on. "Never mark it unavailable" has to mean it is
      // not marked now.
      this.log(`${message} (not marking unavailable: offline_after is 0)`);
      return;
    }

    if (this.consecutiveFailures < offlineAfter) {
      this.log(`${message} (attempt ${this.consecutiveFailures}, still treating as asleep)`);
      return;
    }

    // The last thing tried before telling a user their printer is broken.
    if (await this.renegotiateVersion()) return;

    this.error(message);
    await this.setUnavailable(this.homey.__('device.unreachable')).catch(() => {});
  }

  /**
   * Asks which SNMP version this printer answers on, once per outage.
   *
   * A wrong version does not look like a wrong version. It looks like a printer
   * that has stopped answering: the same timeout, the same greyed tile, the
   * same repair screen — and the printer is on the whole time, answering
   * anything that asks it correctly. Pairing negotiates, so this can only be a
   * device whose printer changed under it, which happens: a firmware update
   * turns v2c off, or a setting is restored from a backup taken elsewhere.
   *
   * Only when there is another version to move to, and only after the failures
   * that would otherwise have marked the device unavailable, so a sleeping
   * printer is never interrogated on the strength of one missed poll.
   */
  private async renegotiateVersion(): Promise<boolean> {
    if (this.renegotiated) return false;
    this.renegotiated = true;

    const { host, community, version } = this.readSettings();
    // IPP is not an SNMP version and has nothing to negotiate against.
    if (version === 'ipp') return false;

    const found = await negotiateVersion(host, community, RENEGOTIATE_TIMEOUT_MS).catch(() => null);
    if (found === null || found === version) return false;

    this.log(`${host} no longer answers ${version} but does answer ${found} — switching`);
    await this.setSettings({ version: found }).catch((e: Error) =>
      this.error(`Could not store the version: ${e.message}`));

    // setSettings() from code does not fire onSettings(), so the reader that
    // reads the settings has to be rebuilt here.
    this.buildReader();
    this.consecutiveFailures = 0;

    // On the next tick, because this runs inside the failed poll that found the
    // problem and `polling` is still set. Without it the tile keeps saying
    // offline for a whole poll interval after the version was corrected.
    this.homey.setTimeout(() => { void this.poll(); }, 500);
    return true;
  }

  /**
   * Stores the firmware version where a user can read it.
   *
   * Written to settings rather than to a capability: it is a fact about the
   * printer, not a measurement, and a capability would give it an Insights
   * graph of a string that changes once a year. Written only when it changes,
   * because storing a setting is persistent and this runs on every poll.
   */
  private async rememberFirmware(firmware: string | null): Promise<void> {
    if (firmware === null) return;
    if (String(this.getSetting('firmware') ?? '') === firmware) return;

    await this.setSettings({ firmware }).catch((e: Error) =>
      this.error(`Could not store the firmware version: ${e.message}`));
  }

  /** Lifts the unavailable flag if it is set. Safe to call when it is not. */
  private async clearUnavailable(): Promise<void> {
    if (this.getAvailable()) return;
    await this.setAvailable().catch((e: Error) =>
      this.error(`Could not clear the unavailable flag: ${e.message}`));
  }

  /** Writes a snapshot to capabilities, adding or removing rows as the printer's supplies change. */
  private async applySnapshot(snapshot: PrinterSnapshot): Promise<void> {
    this.capabilityErrors = [];
    const plan = planCapabilities(snapshot, this.readSettings().lowThreshold);

    // Before anything is written, because migration decides what the old rows
    // become and this is the one poll that still has both lists in hand.
    await this.migrateLegacyCapabilities(snapshot);

    // An empty supplies table means the walk returned nothing, which is a failed
    // read rather than a printer with no cartridges. Every printer has at least one.
    await this.syncCapabilities(plan.capabilities, {
      supplies: snapshot.supplies.length > 0,
      trays: snapshot.inputTrays.length > 0,
    });

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

    // The rows whose new id only this device can work out. A supply's old slot
    // number was its position among the colourless ones in the printer's table,
    // so the pairing needs the table — and a thin read would record a wrong map
    // permanently. The renames a name determines need none of that, which is
    // why they are not behind this guard: a printer that reports no supplies at
    // all must still have its alarms migrated.
    const before = legacyAssignments(snapshot.supplies);
    const after = assignSupplyCapabilities(snapshot.supplies);

    // The replay is only trustworthy if it reproduces what this device actually
    // holds.
    //
    // `legacyAssignments` is run over the snapshot we have *now*, but the ids
    // being replaced were handed out against a snapshot from whenever the device
    // last polled before the update — possibly months ago. A slot number was a
    // position among the colourless supplies, so a printer that has since begun
    // reporting one more of them, ahead of an existing one, replays to a
    // different pairing than it originally got. Recording that would point a
    // user's "toner below 20 %" Flow at the fuser, quietly, and read a real
    // number off the wrong part — which is worse than reading nothing, because
    // nothing at least stops the Flow firing instead of firing on a lie.
    //
    // So the replay has to agree with the device before it is believed.
    // Compared like with like, which the first version of this check was not.
    //
    // `legacyAssignments` only ever produces `supply_*` ids, so that is what the
    // device's side of the comparison has to be. It was written as "the legacy
    // ids RENAMED does not cover", which is a different set: the replay yields
    // every colour it finds while that side yields only the waste and part rows,
    // so the two sizes never matched and the guard fired on every colour printer
    // alive. A Ricoh SP C242SF reported it — five supplies replayed, one id
    // compared, no map ever recorded, `supply_waste` stranded on the device for
    // good and the warning logged every five minutes.
    const held = new Set(legacy.filter((id) => id.startsWith('supply_')));
    const trustworthy = replayIsTrustworthy(before, legacy);

    let recorded = false;

    if (snapshot.supplies.length > 0 && trustworthy) {
      const renamed: Record<string, string> = {
        ...(this.getStoreValue('renamedCapabilities') as Record<string, string> | undefined ?? {}),
      };

      before.forEach((old, i) => {
        const now = after[i]?.capability;
        if (old !== null && now !== undefined && held.has(old)) renamed[old] = now;
      });

      recorded = await this.setStoreValue('renamedCapabilities', renamed)
        .then(() => true)
        .catch((e: Error) => {
          this.noteCapabilityError('record the renamed capabilities', e);
          return false;
        });
    } else if (snapshot.supplies.length > 0) {
      this.log(
        `Not recording a rename map: the printer's supplies no longer replay to `
        + `what this device holds (${[...held].join(', ')}). Flows naming those `
        + `will stop resolving rather than resolve to the wrong consumable.`,
      );
    }

    // A row is only removed once its replacement is written down somewhere.
    //
    // The renames a name determines need no map, so they always go. The supply
    // rows go only if the map that replaces them actually reached the store: if
    // that write failed and they were removed anyway, `legacy` would be empty
    // on every later poll, this method would return at the top, and the pairing
    // could never be rebuilt — nothing else in the app holds it. A Flow naming
    // a waste bottle would resolve to null for ever, and the condition card
    // reads null as "not below", so it would go silent rather than fail.
    const removable = recorded ? legacy : legacy.filter((c) => RENAMED.has(c));

    this.log(`Migrating ${removable.length} capability/ies: ${removable.join(', ')}`);

    for (const capability of removable) {
      await this.removeCapability(capability).catch((e: Error) =>
        this.noteCapabilityError(`remove ${capability}`, e));
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
  private async syncCapabilities(
    wanted: string[],
    conclusive: { supplies: boolean; trays: boolean },
  ): Promise<void> {
    const current = this.getCapabilities();

    // Each kind of row is removed only on the strength of the read it came
    // from. They used to share one flag, the supplies one, and that was wrong
    // in a way that destroyed data: `readInputTrays` swallows its own failure
    // and returns an empty list, so a single dropped UDP response on the tray
    // walk — a printer busy with a job is enough — produced a snapshot with
    // real supplies and no trays. The supplies flag was true, every
    // `measure_tray.*` row counted as stale, and all of them were removed,
    // taking their Insights history with them for good. The next poll added
    // them back with empty graphs, so it looked like nothing had happened.
    const removable = (c: string) => {
      if (!isSupplyCapability(c) || wanted.includes(c)) return false;
      return c.startsWith(`${TRAY_CAPABILITY}.`) ? conclusive.trays : conclusive.supplies;
    };

    for (const capability of current.filter(removable)) {
      await this.removeCapability(capability).catch((e: Error) =>
        this.noteCapabilityError(`remove ${capability}`, e));
      // A removed row must forget its stored title, or a later re-add keeps the
      // cached key, skips the write, and shows the capability's bare default —
      // two trays both reading "Tray", indistinguishable in the Flow picker.
      this.appliedTitles.delete(capability);
    }

    for (const capability of wanted) {
      if (!current.includes(capability)) {
        await this.addCapability(capability).catch((e: Error) =>
          this.noteCapabilityError(`add ${capability}`, e));
      }
    }
  }

  /** Records a failed capability write so the settings page can show it. */
  private noteCapabilityError(what: string, error: Error): void {
    this.error(`Could not ${what}: ${error.message}`);
    if (this.capabilityErrors.length < 8) this.capabilityErrors.push(`${what}: ${error.message}`);
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

    const errorAlarm = values.find((v) => v.id === 'alarm_problem')?.value === true;
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

  /** What the last poll did and when, for the settings page. */
  pollReport(): { at: string; outcome: string; capabilityErrors: string[] } | null {
    if (this.lastPoll === null) return null;
    return { ...this.lastPoll, capabilityErrors: [...this.capabilityErrors] };
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
