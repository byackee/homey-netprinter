/**
 * Canon's private branch, read only where the standard table declines to answer.
 *
 * A PRO-1000 publishes twelve inks in prtMarkerSuppliesTable, names all twelve
 * correctly — PM, R, C, PGY, MBK, PBK, B, CO, GY, Y, M, PC — and then puts a
 * level on six of them. The other six answer `-2`, the Printer-MIB's "I will
 * not say". Their owner watched half a tile stay blank while the printer's own
 * web page showed all twelve.
 *
 * The numbers are on the printer. Canon keeps them in a status document its own
 * drivers fetch, held in SNMP as a table of OctetString chunks that concatenate
 * into one XML reply — the `ivec` protocol behind Canon's IJ status monitor.
 * Nothing decodes it for us, so this module does, and the confidence for that
 * comes from the overlap rather than from the specification: on the report this
 * was written against, every one of the six levels the standard table *did*
 * answer appears in the document with the identical number.
 *
 *   standard   C 80   MBK 20   PBK 20   GY 80   Y 10   M 100
 *   ivec       C 80   MBK 20   PBK 20   GY 80   Y 10   M 100
 *
 * Six agreements is not a proof, but it is the same reading arriving twice by
 * two unrelated routes, and it is what makes filling the other six defensible
 * rather than a guess. The rule is Brother's rule, for the same reason: a row
 * the standard table numbered keeps the standard number. This fills silence.
 *
 * The waste-ink item in the same document is deliberately *not* filled in. It
 * carries a level like the inks do, and no reading here establishes which
 * direction it counts — RFC 3805 has receptacles counting down as they fill,
 * and one number from one printer cannot tell that apart from the opposite
 * convention. Getting it backwards is how a healthy maintenance cartridge
 * reads 30 % and rings a low-supply alarm, which this app has already shipped
 * once. It is decoded and shown in the report, so the next owner to look can
 * settle it, and it stays out of the capabilities until they do.
 */

import { SnmpClient, type SnmpValue } from '../snmp-client.mjs';

/** IANA Private Enterprise Number that identifies a Canon printer in sysObjectID. */
export const CANON_ENTERPRISE = 1602;

/**
 * The table holding Canon's status document.
 *
 * One row per chunk, each an OctetString of roughly 250 bytes, which in OID
 * order concatenate into the XML reply. The chunking is why a walk of the whole
 * 1602 branch never reaches it: the branch runs to hundreds of rows of network
 * configuration first, and the document sits past every cap a report can afford.
 */
export const CANON_STATUS_ROOT = '1.3.6.1.4.1.1602.1.5.1.6.2.2';

/** One ink, as the status document describes it. */
export interface CanonInk {
  /** The colour token, e.g. "PM" — the same string the standard table uses as its description. */
  colour: string;
  /** 0-100, as the document gives it. */
  level: number;
  /** The cartridge model, e.g. "PFI-1000", when the document names one. */
  model: string | null;
  /** Canon's own severity for this ink: "none", "warning", … */
  icon: string | null;
}

/** A waste-ink receptacle, decoded but never written to a capability. See the module note. */
export interface CanonWaste {
  model: string | null;
  level: number;
}

/** Everything the status document had to say. */
export interface CanonReading {
  /** True when a document was found and parsed at all. */
  document: boolean;
  inks: CanonInk[];
  waste: CanonWaste[];
}

/** An empty reading, for a printer that answered nothing. */
const NOTHING: CanonReading = { document: false, inks: [], waste: [] };

/**
 * Compares two OIDs the way an agent orders them: component by component, as
 * numbers. String order puts chunk 10 before chunk 2, which would splice the
 * document together in the wrong order and produce XML that parses to nothing —
 * or, worse, to something.
 */
function compareOid(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = Number(left[i] ?? -1);
    const r = Number(right[i] ?? -1);
    if (l !== r) return l - r;
  }
  return 0;
}

/** One chunk as text. Canon sends latin1 bytes; anything else is not a chunk. */
function chunkText(value: SnmpValue): string | null {
  if (Buffer.isBuffer(value)) return value.toString('latin1');
  if (typeof value === 'string') return value;
  return null;
}

/**
 * Splices the chunks of one walk back into the document they came from.
 *
 * Rows are grouped by everything but their last component, because the table
 * may hold more than one document and concatenating across two of them would
 * produce a single unparseable — or misparsed — blob. The group that looks like
 * a status reply wins; when none does, the largest is returned so that a
 * printer answering a shape nobody has seen still reaches the parser rather
 * than being dropped silently.
 */
export function assembleCanonDocument(rows: Iterable<readonly [string, SnmpValue]>): string | null {
  const groups = new Map<string, Array<{ oid: string; text: string }>>();

  for (const [oid, value] of rows) {
    const text = chunkText(value);
    if (text === null) continue;
    const prefix = oid.slice(0, oid.lastIndexOf('.'));
    const group = groups.get(prefix) ?? [];
    group.push({ oid, text });
    groups.set(prefix, group);
  }

  const documents = [...groups.values()].map((group) =>
    group.sort((a, b) => compareOid(a.oid, b.oid)).map((row) => row.text).join(''));
  if (documents.length === 0) return null;

  const status = documents.find((d) => d.includes(':marker_info') || d.includes(':contents'));
  if (status !== undefined) return status;

  return documents.reduce((longest, d) => (d.length > longest.length ? d : longest));
}

/**
 * Matches one element whatever namespace prefix it carries.
 *
 * The prefix is `ivec` on every printer seen so far, but a namespace prefix is
 * the document author's choice and not part of the format. `[\w-]+` cannot
 * cross the `:`, which is what keeps `<ivec:ink>` from also matching
 * `<ivec:wasteink>` — the two carry a level each and mean opposite things.
 */
function element(name: string, flags = ''): RegExp {
  return new RegExp(`<(?:[\\w-]+:)?${name}>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, flags);
}

/** The text of one child element, CDATA unwrapped, or null when it is absent or blank. */
function childText(block: string, name: string): string | null {
  const match = element(name).exec(block);
  if (match === null) return null;
  const text = match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return text.length > 0 ? text : null;
}

/**
 * A level, or null when it is not one.
 *
 * Canon uses the same element for a reading and for "no reading", so anything
 * outside 0-100 is refused here rather than shown. A sentinel printed as a
 * percentage is precisely the failure this module exists to correct.
 */
function childLevel(block: string): number | null {
  const text = childText(block, 'level');
  if (text === null) return null;
  const level = Number(text);
  if (!Number.isInteger(level) || level < 0 || level > 100) return null;
  return level;
}

/** Decodes the assembled document. A document that is not one yields nothing, never a throw. */
export function decodeCanonStatus(xml: string): CanonReading {
  const inks: CanonInk[] = [];
  for (const match of xml.matchAll(element('ink', 'g'))) {
    const block = match[1]!;
    const colour = childText(block, 'color');
    const level = childLevel(block);
    if (colour === null || level === null) continue;
    inks.push({
      colour,
      level,
      model: childText(block, 'model'),
      icon: childText(block, 'icon'),
    });
  }

  const waste: CanonWaste[] = [];
  const wasteBlock = element('wasteink').exec(xml);
  if (wasteBlock !== null) {
    for (const match of wasteBlock[1]!.matchAll(element('item', 'g'))) {
      const level = childLevel(match[1]!);
      if (level === null) continue;
      waste.push({ model: childText(match[1]!, 'model'), level });
    }
  }

  return { document: inks.length > 0 || waste.length > 0, inks, waste };
}

/** Decodes an already-walked table, for a caller that has the rows in hand. */
export function decodeCanonWalk(rows: Iterable<readonly [string, SnmpValue]>): CanonReading {
  const document = assembleCanonDocument(rows);
  if (document === null) return NOTHING;
  return decodeCanonStatus(document);
}

/**
 * What one read of the document may cost.
 *
 * A PRO-1000 answers eighteen chunks of about 250 bytes. The caps are an order
 * of magnitude above that and exist for the same reason every other walk in
 * this app has them: the OID space below a branch is unbounded, and this one
 * runs on a poll rather than on a user pressing a button.
 */
const CANON_WALK = { maxRows: 400, maxBytes: 400_000, keepRaw: true } as const;

/**
 * Reads Canon's status document.
 *
 * Optional in exactly the way Brother's is: this runs only after the standard
 * read has already succeeded, and a Canon that answers nothing here is a Canon
 * with six blank rows rather than a failed poll.
 *
 * Read as raw bytes rather than as strings. The ordinary walk trims each value,
 * which is right for a model name and wrong here: a chunk boundary can fall on
 * a space inside the document, and trimming it away closes a gap the XML needed.
 */
export async function readCanon(client: SnmpClient): Promise<CanonReading> {
  const walk = await client.walkBounded(CANON_STATUS_ROOT, CANON_WALK);
  return decodeCanonWalk(walk.rows.map((row) => [row.oid, row.value] as const));
}

/** The subset of a supply row this matching needs, so tests need not build a whole one. */
export interface MatchableSupply {
  description: string;
  percent: number | null;
}

/**
 * Chooses the document's level for one standard supply row, or null for none.
 *
 * Matching is on the description, and that is not a shortcut: Canon writes the
 * same token in both places — the standard row is described "PM" and the
 * document calls that ink "PM" — so this is the printer's own identification of
 * its own cartridge, not a colour guessed from a name. Which is why it has to
 * be exact on both sides: one document entry and one table row, or no number.
 * Two rows sharing a description means neither can claim the level.
 */
export function canonPercentFor(
  supply: MatchableSupply,
  supplies: readonly MatchableSupply[],
  reading: CanonReading,
): number | null {
  if (supply.percent !== null) return null;

  const token = supply.description.trim().toLowerCase();
  if (token.length === 0) return null;

  const matches = reading.inks.filter((ink) => ink.colour.trim().toLowerCase() === token);
  if (matches.length !== 1) return null;

  const peers = supplies.filter((s) => s.description.trim().toLowerCase() === token);
  if (peers.length !== 1) return null;

  return matches[0]!.level;
}
