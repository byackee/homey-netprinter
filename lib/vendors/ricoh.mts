/**
 * Ricoh's toner table, read where the standard table refuses to answer.
 *
 * An Aficio SP C242SF publishes five supplies in prtMarkerSuppliesTable, names
 * all five — Cyan, Magenta, Yellow, Black, Waste — and puts `-3` on every one
 * of them. `-3` is the Printer-MIB's "there is some left and I will not say how
 * much", so the tile shows four cartridges and no numbers at all. Its owner
 * watched that for weeks while the printer's own panel showed levels.
 *
 * The numbers are on the printer, in Ricoh's own branch, and unlike every other
 * private branch this app has met they are documented. `ricohEngToner`, at
 * 1.3.6.1.4.1.367.3.2.1.2.24, exists precisely because the standard table
 * cannot carry them — Ricoh's specification says so in as many words:
 *
 *   "Overlaps with prtMarker group … but has the following differences:
 *    - It does not include an object to describe total toner capacity.
 *    - The remaining toner is described as a percentage, not as a measured
 *      quantity."
 *
 *   3.2.1.2.24.1.1.5  ricohEngTonerLevel  "Percentage of toner remaining.
 *                                          -100 is returned when toner is near
 *                                          empty."
 *
 * That sentence is what makes this defensible on one report. Canon's document
 * had to be argued from six levels agreeing with six standard rows, because
 * nothing said which direction its numbers counted; here the manufacturer says
 * which direction, in the specification for the object being read. A number in
 * 0-100 is remaining toner, and no reading has to establish it.
 *
 * What one report is still needed for is the shape, and it corrects a mistake
 * the public monitoring templates all make. They read `…24.1.1.5.1` as black,
 * `.2` as cyan and so on, following the specification's own example table. This
 * printer answers "Cyan" at index 1 and "Black" at index 4 — the order is the
 * model's, not the standard's, and a fixed index would have shown this owner
 * their cyan level on their black cartridge. So the row is identified by
 * `ricohEngTonerType`, the documented enumeration (10 cyan, 11 magenta,
 * 12 yellow, 13 black, 3 black on a mono machine), and a row carrying any other
 * type is left alone rather than guessed at from its position.
 */

import type { SupplyColour } from '../printer-mib.mjs';
import type { SnmpClient, SnmpValue } from '../snmp-client.mjs';
import { supplyKind } from './brother.mjs';

/** IANA Private Enterprise Number that identifies a Ricoh printer in sysObjectID. */
export const RICOH_ENTERPRISE = 367;

/**
 * `ricohEngTonerEntry` — the row of the toner table.
 *
 * The whole 367 branch is walked for the report and this table sits inside it,
 * which is why the first Ricoh report arrived complete. It is read here at the
 * entry instead, for the same reason Canon's document is: a branch's size is
 * the model's business, and a busy MFP that answers hundreds of rows of network
 * configuration first would push the only rows that matter past any cap.
 */
export const RICOH_TONER_ROOT = '1.3.6.1.4.1.367.3.2.1.2.24.1.1';

/**
 * Columns of `ricohEngTonerEntry`, by their position in the OID.
 *
 * `ricohEngTonerIndex` (column 1) is not-accessible — an agent never sends it —
 * so a row is identified by the suffix that follows the column instead.
 */
const COLUMN = { name: '2', descr: '3', type: '4', level: '5' } as const;

/**
 * `ricohEngTonerType`, as the specification enumerates it.
 *
 * Five values, and every Ricoh laser is one of the two shapes they describe:
 * a mono machine with one black, or a four-colour machine. A type outside this
 * table is a machine nobody has reported, and it gets no colour rather than the
 * nearest-looking one.
 */
const TYPE_COLOUR: Record<number, SupplyColour> = {
  3: 'black', // blackTonerMono
  10: 'cyan', // cyanToner4Color
  11: 'magenta', // magentaToner4Color
  12: 'yellow', // yellowToner4Color
  13: 'black', // blackToner4Color
};

/**
 * What the app shows for `-100`.
 *
 * Ricoh reports a level in steps of ten down to 20 and then stops counting.
 * Its own table for this object gives the band in as many words — "10 % - 1 %
 * remaining: Toner near empty (-100)" — so the number is not a guess about what
 * `-100` means, only about where in a band the manufacturer will not resolve.
 * The alternative is a tile that goes blank exactly when a cartridge is about
 * to run out, which is the one moment its owner is looking at it.
 *
 * Ten is the top of that band and the next step down Ricoh's own scale, so it
 * never reads lower than the band Ricoh states and never more than nine points
 * above its floor — and it is below every step the printer does report, which
 * is what keeps the readings ordered.
 *
 * A consequence worth knowing rather than hiding: on Ricoh's scale a cartridge
 * goes 20 %, then near empty. A low-supply alarm set anywhere between those two
 * fires on the second of them, not before. That is the printer's granularity,
 * not a threshold this app can improve on.
 */
export const RICOH_NEAR_EMPTY_PERCENT = 10;

/** One row of the toner table. */
export interface RicohToner {
  /** The row's own suffix, e.g. "1" — Ricoh's index, not a position in this list. */
  index: string;
  /** `ricohEngTonerName`, unlocalised, e.g. "Cyan". */
  name: string | null;
  /** `ricohEngTonerDescr`, in the printer's display language, e.g. "Cyan Toner". */
  descr: string | null;
  /** `ricohEngTonerType`, raw. */
  type: number | null;
  /** `ricohEngTonerLevel` exactly as sent, sentinels included. */
  level: number | null;
  /** The colour {@link RicohToner.type} names, or null for a type we do not know. */
  colour: SupplyColour | null;
  /** {@link RicohToner.level} as a percentage, or null when it is not one. */
  percent: number | null;
}

/** Everything the toner table had to say. */
export interface RicohReading {
  toners: RicohToner[];
}

/** An empty reading, for a printer that answered nothing. */
const NOTHING: RicohReading = { toners: [] };

/** An integer, or null for anything else an agent might have sent. */
function asInteger(value: SnmpValue): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  return null;
}

/** A column's text, latin1 as every other string in this app is read. */
function asText(value: SnmpValue): string | null {
  if (Buffer.isBuffer(value)) return value.toString('latin1').trim() || null;
  if (typeof value === 'string') return value.trim() || null;
  return null;
}

/**
 * A level as a percentage, or null when the printer sent a sentinel instead.
 *
 * The sentinels are the documented ones: `-2` unknown, `-3` some remaining and
 * no figure — the same `-3` the standard table sent, which is what made this
 * read necessary — and `-100` near empty, which is a band rather than a
 * sentinel and is the one that becomes a number. `0` is empty and is a reading:
 * a cartridge with nothing in it is exactly what a user wants to see.
 */
export function ricohPercent(level: number | null): number | null {
  if (level === null) return null;
  if (level === -100) return RICOH_NEAR_EMPTY_PERCENT;
  if (level < 0 || level > 100) return null;
  return level;
}

/** Decodes an already-walked table, for a caller that has the rows in hand. */
export function decodeRicohWalk(rows: Iterable<readonly [string, SnmpValue]>): RicohReading {
  const prefix = `${RICOH_TONER_ROOT}.`;
  const byIndex = new Map<string, RicohToner>();

  for (const [oid, value] of rows) {
    if (!oid.startsWith(prefix)) continue;
    const rest = oid.slice(prefix.length);
    const dot = rest.indexOf('.');
    if (dot <= 0) continue;

    const column = rest.slice(0, dot);
    const index = rest.slice(dot + 1);
    if (index.length === 0) continue;

    const row = byIndex.get(index) ?? {
      index,
      name: null,
      descr: null,
      type: null,
      level: null,
      colour: null,
      percent: null,
    };

    switch (column) {
      case COLUMN.name: row.name = asText(value); break;
      case COLUMN.descr: row.descr = asText(value); break;
      case COLUMN.type: row.type = asInteger(value); break;
      case COLUMN.level: row.level = asInteger(value); break;
      default: continue;
    }

    byIndex.set(index, row);
  }

  const toners = [...byIndex.values()].filter((row) => row.type !== null || row.level !== null);
  for (const row of toners) {
    row.colour = row.type === null ? null : TYPE_COLOUR[row.type] ?? null;
    row.percent = ricohPercent(row.level);
  }

  // Ricoh's own index order, so the report reads the way the printer answered.
  toners.sort((a, b) => Number(a.index) - Number(b.index) || a.index.localeCompare(b.index));
  return { toners };
}

/**
 * What one read of the toner table may cost.
 *
 * Four columns times four toners is sixteen rows on the printer this was
 * written against. The caps are an order of magnitude above that for the same
 * reason every other walk here has them: the OID space below an entry is
 * unbounded, and this one runs on a poll rather than on a user pressing a
 * button.
 */
const RICOH_WALK = { maxRows: 200, maxBytes: 20_000 } as const;

/**
 * Reads Ricoh's toner table.
 *
 * Optional in exactly the way Brother's and Canon's are: this runs only after
 * the standard read has already succeeded, and a Ricoh that answers nothing
 * here is a Ricoh with blank rows rather than a failed poll.
 */
export async function readRicoh(client: SnmpClient): Promise<RicohReading> {
  const walk = await client.walkBounded(RICOH_TONER_ROOT, RICOH_WALK);
  if (walk.rows.length === 0) return NOTHING;
  return decodeRicohWalk(walk.rows.map((row) => [row.oid, row.value] as const));
}

/** The subset of a supply row this matching needs, so tests need not build a whole one. */
export interface MatchableSupply {
  description: string;
  type: string;
  colour: SupplyColour;
  percent: number | null;
  isReceptacle: boolean;
}

/** True for a standard row a toner reading could ever belong to. */
function isMarker(supply: MatchableSupply): boolean {
  return !supply.isReceptacle && supplyKind(supply.type, supply.description) === 'marker';
}

/**
 * Chooses the toner table's level for one standard supply row, or null for none.
 *
 * Brother's rule, for Brother's reason. A row the standard table numbered keeps
 * its number: this fills silence, it is not a second opinion. And a value with
 * no unambiguous row is dropped — the table names a colour and nothing else, so
 * a reading matches only when exactly one toner and exactly one unnumbered
 * marker row share that colour. Two black cartridges means no number, which is
 * the same answer the app already gives when it does not know.
 *
 * The kind test is what keeps a colour from crossing parts. A Ricoh laser
 * reports photoconductors, and on the models that colour them a "Cyan" drum
 * would otherwise take the cyan toner's level.
 */
export function ricohPercentFor(
  supply: MatchableSupply,
  supplies: readonly MatchableSupply[],
  reading: RicohReading,
): number | null {
  if (supply.percent !== null) return null;
  if (!isMarker(supply)) return null;

  const candidates = reading.toners.filter(
    (toner) => toner.percent !== null && toner.colour === supply.colour,
  );

  if (candidates.length === 0) return soleTonerFor(supply, supplies, reading);
  if (candidates.length !== 1) return null;

  const peers = supplies.filter((s) => s.percent === null && s.colour === supply.colour && isMarker(s));
  if (peers.length !== 1) return null;

  return candidates[0]!.percent;
}

/**
 * The level of a mono machine's only toner, when there is nothing to match on.
 *
 * A black-and-white Ricoh calls its toner "Toner" in both tables, and a
 * description with no colour word in it classifies as `other` — so the colour
 * match above can never fire, and the one machine shape `blackTonerMono` exists
 * for would have been decoded, printed in the report, and filled into nothing.
 *
 * The rule that replaces the colour is the same unambiguity the rest of this
 * module runs on, applied to the whole table instead of to one colour: one
 * toner on the printer, one unnumbered marker row, and no colour on either side
 * that contradicts the other. A four-colour machine has four toners in this
 * table and never reaches here, whatever its standard table left blank.
 */
function soleTonerFor(
  supply: MatchableSupply,
  supplies: readonly MatchableSupply[],
  reading: RicohReading,
): number | null {
  if (reading.toners.length !== 1) return null;

  const only = reading.toners[0]!;
  if (only.percent === null) return null;
  // One of the two sides has to be silent about colour. Two sides that both
  // name one and disagree are a mismatch, not a machine with one toner.
  if (supply.colour !== 'other' && only.colour !== null) return null;

  const markers = supplies.filter((s) => s.percent === null && isMarker(s));
  if (markers.length !== 1) return null;

  return only.percent;
}
