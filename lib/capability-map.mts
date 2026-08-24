/**
 * Maps a printer snapshot onto Homey capabilities.
 *
 * Kept free of any Homey import so it can be unit-tested directly: every rule
 * that decides what the user sees lives here, and none of it needs a running app.
 */

import type { PrinterSnapshot } from './printer-reader.mjs';
import { classifyOutputTray, isCoverOpen, isPaperLow, isTrayLow, summariseAlerts } from './printer-mib.mjs';
import type { InputTray, Supply } from './printer-mib.mjs';
import { assignSupplyCapabilities, assignTrayCapabilities } from './supply-capabilities.mjs';
import { colourName, partName, trayName, type Translated } from './supply-titles.mjs';

/**
 * How much of a printer's own wording fits in a capability title.
 *
 * Homey's guideline counts words — two or three — but what it is really
 * protecting is a narrow row where a long title is cut off wherever it lands.
 * Counting characters serves that better here, because the four-word
 * "Black Ink Cartridge 202/202XL" an Epson answers with ends in the part
 * number the user has to go and order, which is the whole reason we prefer the
 * printer's wording to the colour we inferred.
 *
 * Thirty-six because that is what the evidence asked for. Thirty-two was set
 * against "Black Ink Cartridge 202/202XL" and held it whole — but the same
 * printer's "Photo Black Ink Cartridge 202/202XL" is thirty-five, and the cap
 * cut off exactly the part number the rule exists to keep. Still bounds a
 * Lexmark that adds its model and yield class on top.
 */
const MAX_TITLE_LENGTH = 36;

/**
 * Trims a printer's wording to something that fits a capability row.
 *
 * Whole words are kept, so a truncated title still reads as words rather than
 * a severed one. A single word longer than the budget is cut with an ellipsis,
 * which at least says out loud that there was more.
 */
export function shortTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= MAX_TITLE_LENGTH) return clean;

  const words = clean.split(' ');
  let kept = '';
  for (const word of words) {
    const next = kept === '' ? word : `${kept} ${word}`;
    if (next.length > MAX_TITLE_LENGTH) break;
    kept = next;
  }

  return kept === '' ? `${clean.slice(0, MAX_TITLE_LENGTH - 1)}…` : kept;
}

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
   * Per-capability title overrides, one per level row.
   *
   * Every row needs one now. Before 1.1.0 each colour was its own capability
   * and carried its own translated title, so an override was only worth writing
   * when the printer offered something better than "Black". One capability with
   * a sub-capability per colour has a single title between them all, so without
   * an override every consumable on the device would read "Supply".
   *
   * A plain string is the printer's own wording, which no translation of ours
   * improves on. A translation object is our fallback for a row the printer
   * left unnamed.
   */
  titles: Map<string, string | Translated>;
  /**
   * Everything currently at or below the threshold — consumables and paper
   * alike — named as the user would recognise it.
   *
   * The alarm capabilities are bare booleans, so on their own they say something
   * is low without ever saying what. This is what turns them into an actionable
   * warning on the device. Paper belongs here too: a user looking at a warning
   * wants to know the tray is empty just as much as the toner.
   */
  lowSupplies: string[];
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

/**
 * Names the paper trays that are at or below the threshold.
 *
 * Manual feeders are left out for the same reason the alarm ignores them: an
 * empty bypass slot is its resting state, not a warning.
 */
export function lowTrayNames(trays: InputTray[], thresholdPercent: number): string[] {
  return trays
    .filter(isTrayLow(thresholdPercent))
    .map((t) => [t.name.trim(), t.media.trim()].filter((x) => x.length > 0).join(' · ') || 'paper');
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
 * Names one supply row.
 *
 * The printer's own description wins wherever there is one: "Black Ink
 * Cartridge 202/202XL" names the thing to reorder, which is the whole reason we
 * prefer it to the colour we inferred. Failing that, a colorant is named after
 * its colour and an unnamed part after its position in the list — never left to
 * fall back on the capability's own title, which is the same word for all of
 * them.
 */
function supplyTitle(supply: Supply, partPosition: number): string | Translated {
  const described = shortTitle(supply.description);
  if (described.length > 0) return described;

  return colourName(supply.colour) ?? partName(partPosition);
}

/**
 * Builds the full capability plan for a snapshot.
 *
 * @param snapshot   what the last poll returned
 * @param threshold  percentage at or below which the low-supply alarm fires
 */
export function planCapabilities(snapshot: PrinterSnapshot, threshold: number): CapabilityPlan {
  const capabilities: string[] = [];
  const values: CapabilityValue[] = [];
  const titles = new Map<string, string | Translated>();

  // Every supply the printer reports gets a row. There is no ceiling any more:
  // each one is a sub-capability, so a laser listing toner, photoconductor,
  // waste bottle, fuser, transfer unit and rollers is nine rows rather than
  // eight rows and one consumable silently dropped on the floor.
  let partPosition = 0;
  for (const { supply, capability } of assignSupplyCapabilities(snapshot.supplies)) {
    if (capability.startsWith('measure_part.')) partPosition += 1;

    capabilities.push(capability);
    values.push({ id: capability, value: supply.percent });
    titles.set(capability, supplyTitle(supply, partPosition));
  }

  const addScalar = (id: string, value: CapabilityValue['value']) => {
    capabilities.push(id);
    values.push({ id, value });
  };

  // Paper trays, before the scalars, so they sit next to the supplies they are
  // conceptually part of rather than below the alarms.
  for (const { tray, capability } of assignTrayCapabilities(snapshot.inputTrays)) {
    capabilities.push(capability);
    values.push({ id: capability, value: tray.percent });

    // "Tray 2 · A4" is what tells two identical cassettes apart. Either half may
    // be missing, so the separator is only drawn when both are there.
    const label = [tray.name.trim(), tray.media.trim()].filter((s) => s.length > 0).join(' · ');
    const position = Number(capability.split('.')[1]);
    titles.set(capability, label.length > 0 ? shortTitle(label) : trayName(position));
  }

  // We only get here from a successful read, so the printer answered.
  //
  // This is `onoff` rather than setUnavailable() because the two say different
  // things: unavailable means "this device is broken, go fix it", which hides
  // every reading and — since this driver offers a repair flow — asks the user
  // to repair a printer they switched off on purpose. A read-only onoff dims
  // the tile the way people expect and leaves the last readings on screen.
  // Suggested by smarthomesven on the community forum.
  addScalar('onoff', true);

  addScalar('printer_status', snapshot.status);
  addScalar('alarm_problem', hasBlockingError(snapshot.errors));
  addScalar('alarm_supply_low', isSupplyLow(snapshot.supplies, threshold));
  addScalar('alarm_paper_low', isPaperLow(snapshot.inputTrays, snapshot.errors, threshold));

  // A cover alarm is only honest on a printer that can actually sense one.
  // `doorOpen` alone is not enough to add the row, because a printer that never
  // sets it is indistinguishable from one whose door is simply shut.
  if (snapshot.covers.length > 0) {
    addScalar('alarm_open', isCoverOpen(snapshot.covers, snapshot.errors));
  }

  // These two are only worth a *row* when the printer actually reports them; an
  // always-empty tile is clutter on a printer that never says anything.
  //
  // The row is a separate question from the value, though, and conflating them
  // is why a user watched their panel message read "Tray 1 Missing" long after
  // the tray was back: once the printer stopped reporting a message, the guard
  // skipped the write entirely and Homey kept the last text for ever. So the
  // message is always written, blank included, and only the row is conditional.
  if (snapshot.displayText !== null) capabilities.push('printer_message');
  values.push({ id: 'printer_message', value: snapshot.displayText });

  // The page count is deliberately not treated the same way. A stale message
  // asserts a condition that may be false; a stale counter only lags a total
  // that was true when it was read, and blanking it would chop up its Insights
  // graph every time the printer declines to answer once.
  if (snapshot.pageCount !== null) addScalar('meter_pages', snapshot.pageCount);

  // The output tray only earns a row on printers that can actually sense it.
  // Showing "Unknown" forever on the rest would be a tile that never says
  // anything, and worse, one a user could reasonably build a Flow on.
  const tray = classifyOutputTray(snapshot.outputTrays, snapshot.errors);
  if (tray !== 'unknown') addScalar('printer_output_tray', tray);

  // The printer's own alert wording, which is the only thing that can name the
  // consumable behind the low-supply alarm.
  //
  // Row and value are separate decisions here for the same reason as the panel
  // message: a printer that has never raised an alert gets no row, but once the
  // row exists it must be able to go quiet again. Skipping the write when the
  // list came back empty left a user staring at "Tray 1 Missing" for hours
  // after the tray was back, with nothing able to replace it.
  //
  // A walk that failed is not an empty walk, though. We clear only when the
  // printer actually answered and had nothing to say.
  const alerts = summariseAlerts(snapshot.alerts);
  if (alerts !== null) capabilities.push('printer_alert');
  if (alerts !== null || snapshot.alertsRead) values.push({ id: 'printer_alert', value: alerts });

  return {
    capabilities,
    values,
    titles,
    lowSupplies: [
      ...lowSupplyNames(snapshot.supplies, threshold),
      ...lowTrayNames(snapshot.inputTrays, threshold),
    ],
  };
}
