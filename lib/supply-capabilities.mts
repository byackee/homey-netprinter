/**
 * Decides which capability each supply and tray belongs on.
 *
 * Until 1.1.0 every supply had a capability of its own — `supply_black`,
 * `supply_cyan`, and eight numbered `supply_other_N` slots for the ones no
 * colour fitted. Twenty-two definitions that differed only by a title, and a
 * hard ceiling: a laser reporting a ninth consumable had nowhere to put it, so
 * the low-supply alarm could fire for a part the user had no row for.
 *
 * Homey's answer to "the same capability more than once" is a sub-capability:
 * an id, a dot, and a discriminator. So three capabilities now cover every
 * consumable a printer can report, with no ceiling at all:
 *
 * - `measure_supply.<colour>` — a colorant that drains, ink or toner
 * - `measure_waste.<index>`   — a receptacle that fills
 * - `measure_part.<index>`    — everything else: fuser, photoconductor,
 *                               transfer unit, rollers
 *
 * Three rather than one because the icon is the one thing a sub-capability
 * cannot vary: `icon` belongs to a capability's definition and is not a
 * capability option, so every sub-capability wears its base's icon. A waste
 * bottle and a drum showing the same ink drop as the black cartridge would lose
 * information the user reads at a glance. Three capabilities that differ by
 * icon and by kind are not the near-duplicates the rule is aimed at; twenty-two
 * that differ by a title are.
 *
 * The `measure_` prefix is not decoration either. Homey only lets a user pick a
 * number capability as the indicator beside the device icon when its id starts
 * with `measure_` or `meter_`, and not one of the old names did.
 */

import type { InputTray, Supply, SupplyColour } from './printer-mib.mjs';

/** Colorants that get a sub-capability named after them. */
const NAMED_COLOURS: readonly SupplyColour[] = [
  'black', 'photo_black', 'matte_black', 'grey',
  'cyan', 'magenta', 'yellow',
  'light_cyan', 'light_magenta',
  'red', 'green', 'blue', 'orange',
];

export const SUPPLY_CAPABILITY = 'measure_supply';
export const WASTE_CAPABILITY = 'measure_waste';
export const PART_CAPABILITY = 'measure_part';
export const TRAY_CAPABILITY = 'measure_tray';

/**
 * Sub-capability ids may not contain a dot.
 *
 * Homey splits a capability id on the first dot to find its base, and a second
 * dot would leave an id nothing can match back. A supply's table index is
 * exactly that shape — "1.3" is supply 3 of device 1 — so it is not optional
 * mangling here, it is what makes the index usable as a sub-id at all.
 */
function safeSubId(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * The capability id for one supply row.
 *
 * A colorant is named after its colour, which is stable across restarts and
 * means something in Insights. Two supplies can legitimately share one — a
 * wide-format printer with two blacks — so a repeat falls back to the colour
 * plus the printer's own row index rather than silently overwriting the first.
 *
 * Receptacles and unnamed parts have no colour to be named after, so they carry
 * the printer's own table index. That is stable for a given printer, and unlike
 * a position in our list it does not renumber when a printer starts reporting
 * one more consumable than it used to — which matters more than it used to,
 * because the id is now the key an Insights history hangs on.
 */
export function supplyCapability(supply: Supply, colourTaken: (id: string) => boolean): string {
  if (supply.isReceptacle) return `${WASTE_CAPABILITY}.${safeSubId(supply.index)}`;

  if (NAMED_COLOURS.includes(supply.colour)) {
    const named = `${SUPPLY_CAPABILITY}.${supply.colour}`;
    if (!colourTaken(named)) return named;
    return `${SUPPLY_CAPABILITY}.${supply.colour}_${safeSubId(supply.index)}`;
  }

  return `${PART_CAPABILITY}.${safeSubId(supply.index)}`;
}

/**
 * The capability id for one paper tray.
 *
 * Position rather than the MIB index, which is dotted — "1.1" for the first
 * tray of the first input sub-unit — and would need mangling to survive as a
 * sub-capability id. Position is what the old `printer_tray_N` used, so nothing
 * about a tray's identity changes in this migration.
 */
export function trayCapability(position: number): string {
  return `${TRAY_CAPABILITY}.${position}`;
}

/** Every capability id this module can produce, for a whole snapshot. */
export function assignSupplyCapabilities(supplies: readonly Supply[]): Array<{
  supply: Supply;
  capability: string;
}> {
  const taken = new Set<string>();
  const assignments: Array<{ supply: Supply; capability: string }> = [];

  for (const supply of supplies) {
    const capability = supplyCapability(supply, (id) => taken.has(id));
    taken.add(capability);
    assignments.push({ supply, capability });
  }

  return assignments;
}

/** True for any capability this module owns, whatever its sub-id. */
export function isSupplyCapability(id: string): boolean {
  const base = id.split('.')[0];
  return base === SUPPLY_CAPABILITY
    || base === WASTE_CAPABILITY
    || base === PART_CAPABILITY
    || base === TRAY_CAPABILITY;
}

/** Convenience for the tray list, mirroring {@link assignSupplyCapabilities}. */
export function assignTrayCapabilities(trays: readonly InputTray[]): Array<{
  tray: InputTray;
  capability: string;
}> {
  return trays.map((tray, i) => ({ tray, capability: trayCapability(i + 1) }));
}
