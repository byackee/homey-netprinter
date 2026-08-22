/**
 * Maps a printer snapshot onto Homey capabilities.
 *
 * Kept free of any Homey import so it can be unit-tested directly: every rule
 * that decides what the user sees lives here, and none of it needs a running app.
 */

import type { PrinterSnapshot } from './printer-reader.mjs';
import type { Supply, SupplyColour } from './printer-mib.mjs';

/** Supply colours that have a capability of their own. */
const NAMED_COLOURS: readonly SupplyColour[] = [
  'black', 'photo_black', 'matte_black', 'grey',
  'cyan', 'magenta', 'yellow',
  'light_cyan', 'light_magenta',
  'red', 'green', 'blue', 'orange',
  'waste',
];

/** How many unnamed supplies we can still show before we run out of slots. */
const FALLBACK_SLOTS = 4;

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

  addScalar('printer_status', snapshot.status);
  addScalar('alarm_printer_error', hasBlockingError(snapshot.errors));
  addScalar('alarm_supply_low', isSupplyLow(snapshot.supplies, threshold));

  // These two are only worth a row when the printer actually reports them;
  // an always-empty tile is clutter.
  if (snapshot.displayText !== null) addScalar('printer_message', snapshot.displayText);
  if (snapshot.pageCount !== null) addScalar('printer_pages', snapshot.pageCount);

  return { capabilities, values, titles, dropped };
}
