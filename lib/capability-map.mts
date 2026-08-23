/**
 * Maps a printer snapshot onto Homey capabilities.
 *
 * Kept free of any Homey import so it can be unit-tested directly: every rule
 * that decides what the user sees lives here, and none of it needs a running app.
 */

import type { PrinterSnapshot } from './printer-reader.mjs';
import { classifyOutputTray, isCoverOpen, isPaperLow, summariseAlerts } from './printer-mib.mjs';
import type { Supply, SupplyColour } from './printer-mib.mjs';

/** Supply colours that have a capability of their own. */
const NAMED_COLOURS: readonly SupplyColour[] = [
  'black', 'photo_black', 'matte_black', 'grey',
  'cyan', 'magenta', 'yellow',
  'light_cyan', 'light_magenta',
  'red', 'green', 'blue', 'orange',
  'waste',
];

/**
 * How many unnamed supplies we can still show before we run out of slots.
 *
 * Four was enough for an inkjet and far too few for a laser: a Lexmark reports
 * toner, photoconductor, waste bottle, fuser, transfer unit and rollers, none of
 * which carries a colour. The ones that overflowed were still counted by the
 * low-supply alarm, so the alarm could fire for a consumable the user had no row
 * for — an alert with nothing to act on. Eight covers every printer we have seen.
 */
const FALLBACK_SLOTS = 8;

/**
 * How many paper trays get a row of their own.
 *
 * Four covers a printer with a manual feed, a main cassette and two options,
 * which is as far as anything in a house goes. Trays beyond that are still read
 * — they just fold into the paper alarm rather than earning a tile.
 */
const TRAY_SLOTS = 4;

/** A capability id and the value to write to it. */
export interface CapabilityValue {
  id: string;
  /** null means "the printer would not say", which Homey renders as unknown. */
  value: number | string | boolean | null;
}

/** The result of mapping one snapshot. */
export interface CapabilityPlan {
  /** Every capability this printer should have, in display order. */
  capabilities: string[];
  /** The values to write, one per capability in {@link capabilities}. */
  values: CapabilityValue[];
  /**
   * Per-capability title overrides, so a slot reads "Black 202/202XL" rather
   * than a generic "Black". Only set where the printer gave us something better.
   */
  titles: Map<string, string>;
  /** Supplies that could not be shown because every fallback slot was taken. */
  dropped: Supply[];
  /**
   * The supplies currently at or below the threshold, named as the user would
   * recognise them.
   *
   * The alarm capability is a bare boolean, so on its own it says something is
   * low without ever saying what. This is what turns it into an actionable
   * warning on the device.
   */
  lowSupplies: string[];
}

/**
 * Chooses a capability id for each supply.
 *
 * Two supplies can legitimately share a colour — a wide-format printer with two
 * black cartridges, say. The first claims the named capability and later ones
 * fall back to a numbered slot, because writing both to `supply_black` would
 * make the second silently overwrite the first.
 */
function assignCapabilities(supplies: Supply[]): {
  assignments: Array<{ supply: Supply; capability: string }>;
  dropped: Supply[];
} {
  const taken = new Set<string>();
  const assignments: Array<{ supply: Supply; capability: string }> = [];
  const dropped: Supply[] = [];
  let nextFallback = 1;

  for (const supply of supplies) {
    const named = `supply_${supply.colour}`;
    if (NAMED_COLOURS.includes(supply.colour) && !taken.has(named)) {
      taken.add(named);
      assignments.push({ supply, capability: named });
      continue;
    }

    // Either an unnamed colour, or a colour already claimed by an earlier row.
    while (nextFallback <= FALLBACK_SLOTS && taken.has(`supply_other_${nextFallback}`)) {
      nextFallback += 1;
    }
    if (nextFallback > FALLBACK_SLOTS) {
      dropped.push(supply);
      continue;
    }
    const fallback = `supply_other_${nextFallback}`;
    taken.add(fallback);
    assignments.push({ supply, capability: fallback });
  }

  return { assignments, dropped };
}

/**
 * Decides whether the low-supply alarm should be on.
 *
 * Supplies whose level is unknown are ignored rather than treated as empty: a
 * printer that declines to report a level must not ring an alarm forever. Waste
 * receptacles count, because a full waste tank stops printing just as surely as
 * an empty cartridge.
 */
export function isSupplyLow(supplies: Supply[], thresholdPercent: number): boolean {
  return supplies.some((s) => s.percent !== null && s.percent <= thresholdPercent);
}

/**
 * Names the supplies that are at or below the threshold.
 *
 * Uses the printer's own description where there is one, because "Waste Toner
 * Bottle" is what is written on the part the user has to go and change, while
 * the colour we inferred is only ever a guess about it.
 */
export function lowSupplyNames(supplies: Supply[], thresholdPercent: number): string[] {
  return supplies
    .filter((s) => s.percent !== null && s.percent <= thresholdPercent)
    .map((s) => (s.description.trim() || s.colour));
}

/** The error flags that mean the printer genuinely cannot print right now. */
const BLOCKING_ERRORS = new Set([
  'noPaper', 'noToner', 'doorOpen', 'jammed', 'offline',
  'serviceRequested', 'markerSupplyMissing', 'outputFull', 'inputTrayEmpty',
]);

/**
 * Whether the error alarm should be on.
 *
 * Advisory flags such as `lowPaper` and `lowToner` are deliberately excluded:
 * they duplicate the supply alarm and would leave the error alarm stuck on for
 * weeks, training the user to ignore it.
 */
export function hasBlockingError(errors: readonly string[]): boolean {
  return errors.some((flag) => BLOCKING_ERRORS.has(flag));
}

/**
 * Builds the full capability plan for a snapshot.
 *
 * @param snapshot   what the last poll returned
 * @param threshold  percentage at or below which the low-supply alarm fires
 */
export function planCapabilities(snapshot: PrinterSnapshot, threshold: number): CapabilityPlan {
  const { assignments, dropped } = assignCapabilities(snapshot.supplies);

  const capabilities: string[] = [];
  const values: CapabilityValue[] = [];
  const titles = new Map<string, string>();

  for (const { supply, capability } of assignments) {
    capabilities.push(capability);
    values.push({ id: capability, value: supply.percent });
    // The printer's own wording names the exact cartridge to buy, which is more
    // useful at a glance than the colour we inferred from it.
    if (supply.description) titles.set(capability, supply.description);
  }

  const addScalar = (id: string, value: CapabilityValue['value']) => {
    capabilities.push(id);
    values.push({ id, value });
  };

  // Paper trays, before the scalars, so they sit next to the supplies they are
  // conceptually part of rather than below the alarms.
  snapshot.inputTrays.slice(0, TRAY_SLOTS).forEach((tray, i) => {
    const id = `printer_tray_${i + 1}`;
    capabilities.push(id);
    values.push({ id, value: tray.percent });

    // "Tray 2 · A4" is what tells two identical cassettes apart. Either half may
    // be missing, so the separator is only drawn when both are there.
    const label = [tray.name.trim(), tray.media.trim()].filter((s) => s.length > 0).join(' · ');
    if (label.length > 0) titles.set(id, label);
  });

  addScalar('printer_status', snapshot.status);
  addScalar('alarm_printer_error', hasBlockingError(snapshot.errors));
  addScalar('alarm_supply_low', isSupplyLow(snapshot.supplies, threshold));
  addScalar('alarm_paper_low', isPaperLow(snapshot.inputTrays, snapshot.errors, threshold));

  // A cover alarm is only honest on a printer that can actually sense one.
  // `doorOpen` alone is not enough to add the row, because a printer that never
  // sets it is indistinguishable from one whose door is simply shut.
  if (snapshot.covers.length > 0) {
    addScalar('alarm_cover_open', isCoverOpen(snapshot.covers, snapshot.errors));
  }

  // These two are only worth a row when the printer actually reports them;
  // an always-empty tile is clutter.
  if (snapshot.displayText !== null) addScalar('printer_message', snapshot.displayText);
  if (snapshot.pageCount !== null) addScalar('printer_pages', snapshot.pageCount);

  // The output tray only earns a row on printers that can actually sense it.
  // Showing "Unknown" forever on the rest would be a tile that never says
  // anything, and worse, one a user could reasonably build a Flow on.
  const tray = classifyOutputTray(snapshot.outputTrays, snapshot.errors);
  if (tray !== 'unknown') addScalar('printer_output_tray', tray);

  // The printer's own alert wording, which is the only thing that can name the
  // consumable behind the low-supply alarm.
  const alerts = summariseAlerts(snapshot.alerts);
  if (alerts !== null) addScalar('printer_alert', alerts);

  return {
    capabilities,
    values,
    titles,
    dropped,
    lowSupplies: lowSupplyNames(snapshot.supplies, threshold),
  };
}
