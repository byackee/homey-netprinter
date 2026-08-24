/**
 * Keeps Flows written against the pre-1.1.0 capability ids working.
 *
 * The "supply is below a level" condition stores the capability the user picked
 * as a plain string in the Flow. When 1.1.0 renamed every level capability, any
 * Flow already referencing `supply_black` would have gone on asking for a
 * capability the device no longer has — and the condition reads a missing
 * capability as "not below", so a Flow written to catch a low cartridge would
 * have stopped firing without ever saying why. Silence is the worst possible
 * failure for that particular card.
 *
 * Two kinds of old id, and only one of them can be translated from its name:
 *
 * - `supply_black`, `printer_tray_2` — the new id follows from the old one, so
 *   the mapping is a table and lives here.
 * - `supply_waste`, `supply_other_3` — the new id is the printer's own row
 *   index, which nothing about the string reveals. Those are recorded per
 *   device while both lists are in hand, during the one poll that migrates it.
 */

import { SUPPLY_CAPABILITY, TRAY_CAPABILITY } from './supply-capabilities.mjs';

/** Colours that had a capability of their own before 1.1.0. */
const LEGACY_COLOURS = [
  'black', 'photo_black', 'matte_black', 'grey',
  'cyan', 'magenta', 'yellow',
  'light_cyan', 'light_magenta',
  'red', 'green', 'blue', 'orange',
] as const;

/** Old id to new id, for every rename that a name alone determines. */
export const RENAMED: ReadonlyMap<string, string> = new Map([
  ...LEGACY_COLOURS.map((c) => [`supply_${c}`, `${SUPPLY_CAPABILITY}.${c}`] as const),
  ...[1, 2, 3, 4].map((n) => [`printer_tray_${n}`, `${TRAY_CAPABILITY}.${n}`] as const),
  ['printer_pages', 'meter_pages'] as const,
  // Two alarms that were re-inventing a system capability. Homey ships Flow
  // cards for every system capability and none for a custom one, so this app
  // was writing by hand what the platform already had.
  ['alarm_printer_error', 'alarm_problem'] as const,
  ['alarm_cover_open', 'alarm_open'] as const,
]);

/** True for any capability id this app used before 1.1.0 and no longer writes. */
export function isLegacyCapability(id: string): boolean {
  return RENAMED.has(id)
    || id === 'supply_waste'
    || /^supply_other_[1-8]$/.test(id);
}

/**
 * Resolves an id a Flow may be holding to one the device actually has.
 *
 * `recorded` is the per-device map built during migration, which covers the
 * waste and part rows the table above cannot. An id that is already current
 * passes straight through, so this is safe to call on every lookup.
 */
export function resolveCapability(
  id: string,
  has: (capability: string) => boolean,
  recorded: Readonly<Record<string, string>> = {},
): string | null {
  if (has(id)) return id;

  const mapped = RENAMED.get(id) ?? recorded[id];
  if (mapped !== undefined && has(mapped)) return mapped;

  return null;
}

/**
 * Replays the pre-1.1.0 slot assignment over a snapshot's supplies.
 *
 * The waste and part rows were numbered by the order they turned up in the
 * printer's table, which is why their old ids cannot be translated from the
 * string alone. Running the old rule and the new one over the same supplies
 * pairs them exactly, and it is the same printer answering, so the order is the
 * order it always was.
 *
 * This is deliberately a copy of logic that has been deleted rather than a
 * shared helper: it describes what the app used to do, and it must not follow
 * the live rule when that changes again.
 */
export function legacyAssignments(
  supplies: ReadonlyArray<{ colour: string }>,
): Array<string | null> {
  const named = new Set([...LEGACY_COLOURS, 'waste']);
  const taken = new Set<string>();
  const out: Array<string | null> = [];
  let nextFallback = 1;

  for (const supply of supplies) {
    const id = `supply_${supply.colour}`;
    if (named.has(supply.colour as (typeof LEGACY_COLOURS)[number] | 'waste') && !taken.has(id)) {
      taken.add(id);
      out.push(id);
      continue;
    }

    while (nextFallback <= 8 && taken.has(`supply_other_${nextFallback}`)) nextFallback += 1;
    if (nextFallback > 8) {
      // The ninth consumable had nowhere to go, which is the ceiling 1.1.0 lifts.
      out.push(null);
      continue;
    }
    const fallback = `supply_other_${nextFallback}`;
    taken.add(fallback);
    out.push(fallback);
  }

  return out;
}

/**
 * Whether a replay may be believed for a given device.
 *
 * {@link legacyAssignments} runs over the supplies read *now*, but the ids it
 * reproduces were handed out against whatever the printer reported the last
 * time it polled before the update. If the two disagree, the pairing is wrong
 * and recording it would point a Flow at a different consumable — so the replay
 * has to reproduce exactly the supply ids the device is actually carrying.
 *
 * Both sides must be the same kind of thing, which is the mistake this function
 * exists to make impossible: `legacyAssignments` only ever yields `supply_*`
 * ids, so the device's side is its `supply_*` capabilities and nothing else.
 * Comparing them against "the legacy ids the rename table does not cover"
 * instead — waste and parts only — made the sizes disagree on every colour
 * printer, so the guard rejected every migration it was ever asked about.
 */
export function replayIsTrustworthy(
  replayed: ReadonlyArray<string | null>,
  deviceCapabilities: readonly string[],
): boolean {
  const produced = new Set(replayed.filter((id): id is string => id !== null));
  const held = new Set(deviceCapabilities.filter((id) => id.startsWith('supply_')));

  return produced.size === held.size && [...held].every((id) => produced.has(id));
}
