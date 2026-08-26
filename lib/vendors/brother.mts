/**
 * Brother's private branch, read only where the standard table declines to answer.
 *
 * Everything else in this app comes from the Printer-MIB, and that is deliberate:
 * one driver serves every brand precisely because it asks nobody for a vendor
 * quirk. Brother is the one place where the standard answer is not an answer.
 * An MFC-L2827DW reports its toner as `-3 tenthsOfGrams` — RFC 3805's way of
 * saying "there is some left and I will not put a number on it" — while the same
 * printer will hand the actual percentage to anyone who asks a private OID.
 *
 * So this module exists to fill *gaps*, never to override. A row the standard
 * table answered keeps the standard answer; only a row that came back `-3`, `-2`
 * or unreadable is offered a vendor number. That rule is what keeps a vendor
 * quirk from quietly becoming the thing the app depends on.
 *
 * The decoding is not invented here. It is Home Assistant's `brother` library
 * (bieniu/brother), which has been read against thousands of Brother machines
 * over several years — the field experience this app has no way to reproduce.
 * The blob layout, the marker bytes, the /100 scale and the legacy variant are
 * all reproduced from it, and the divergences are commented where they occur.
 */

import { SnmpClient, type SnmpValue } from '../snmp-client.mjs';
import type { SupplyColour } from '../printer-mib.mjs';

/** IANA Private Enterprise Number that identifies a Brother printer in sysObjectID. */
export const BROTHER_ENTERPRISE = 2435;

/**
 * The private OIDs worth reading. Each is a scalar, not a table — which is why
 * the walk we asked a user for was the wrong request: the toner percentage is
 * one GET, not several pages of output.
 */
export const BROTHER_OID = {
  /** Model string, e.g. "MFG:Brother;CMD:PJL,HBP,URF;MDL:MFC-L2827DW;…". */
  model: '1.3.6.1.4.1.2435.2.3.9.1.1.7.0',
  /** Serial number. */
  serial: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.1.0',
  /** Firmware version. */
  firmware: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.17.0',
  /** The maintenance blob: supply levels and part life, packed into one OctetString. */
  maintenance: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8.0',
  /** The "nextcare" blob: pages remaining on each replaceable part. */
  nextcare: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.11.0',
  /** The counters blob: page counts by kind. */
  counters: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.10.0',
} as const;

/** Every private OID this module reads, in the order a diagnostic should show them. */
export const BROTHER_OIDS: readonly string[] = [
  BROTHER_OID.model,
  BROTHER_OID.serial,
  BROTHER_OID.firmware,
  BROTHER_OID.maintenance,
  BROTHER_OID.nextcare,
  BROTHER_OID.counters,
];

/**
 * A decoded reading, named the way Home Assistant names it.
 *
 * The names are kept identical on purpose: when a user posts what HA shows and
 * what this app shows, the two lists have to be comparable line by line, or the
 * next bug report is unreadable.
 */
export interface BrotherValue {
  /** e.g. "black_toner_remaining". */
  key: string;
  /** The decoded number. A percentage when {@link isPercent}, otherwise a count. */
  value: number;
  /** True when the number is 0-100 rather than a raw count. */
  isPercent: boolean;
  /** The marker byte it was decoded from, e.g. "6f". Kept so a diagnostic can show it. */
  marker: string;
}

/** Everything the private branch had to say. */
export interface BrotherReading {
  /** Model as the private branch reports it, e.g. "MFC-L2827DW". */
  model: string | null;
  serial: string | null;
  firmware: string | null;
  /** Decoded maintenance values — supply levels and part life. */
  maintenance: BrotherValue[];
  /** Decoded nextcare values — pages remaining per part. */
  nextcare: BrotherValue[];
  /** Decoded counters — page counts by kind. */
  counters: BrotherValue[];
  /** True when the blob used the older five-byte layout. */
  legacy: boolean;
}

/**
 * Where a decoded value belongs among the standard supply rows.
 *
 * A vendor number is only useful if we can say *which* cartridge it describes,
 * and the private blob names nothing — it identifies a supply by a marker byte
 * and nothing else. So each marker carries the colour and the kind of part it
 * refers to, and matching happens against the standard row's own colour and
 * type. That way an unmatched vendor value is dropped rather than guessed onto
 * the nearest row.
 */
export interface BrotherTarget {
  colour: SupplyColour | null;
  kind: SupplyKind;
}

/** The families a standard supply row can belong to, for matching purposes. */
export type SupplyKind = 'marker' | 'drum' | 'belt' | 'fuser' | 'laser' | 'pf_kit';

/** A marker byte, what it means, and whether its value is a percentage. */
interface Marker {
  key: string;
  percent: boolean;
  target?: BrotherTarget;
}

const pct = (key: string, target?: BrotherTarget): Marker => ({ key, percent: true, target });
const count = (key: string): Marker => ({ key, percent: false });

/**
 * Laser maintenance markers.
 *
 * Reproduced from bieniu/brother `VALUES_LASER_MAINTENANCE`. Note that `6f`-`72`
 * and `a1`-`a4` both mean "toner remaining": Brother moved the marker between
 * firmware generations and the library reads either, so this does too.
 */
const LASER_MAINTENANCE: Record<string, Marker> = {
  '11': count('drum_counter'),
  '31': count('black_toner_status'),
  '32': count('cyan_toner_status'),
  '33': count('magenta_toner_status'),
  '34': count('yellow_toner_status'),
  '41': pct('drum_remaining_life', { colour: null, kind: 'drum' }),
  '63': count('drum_status'),
  '69': pct('belt_unit_remaining_life', { colour: null, kind: 'belt' }),
  '6a': pct('fuser_remaining_life', { colour: null, kind: 'fuser' }),
  '6b': pct('laser_remaining_life', { colour: null, kind: 'laser' }),
  '6c': pct('pf_kit_mp_remaining_life', { colour: null, kind: 'pf_kit' }),
  '6d': pct('pf_kit_1_remaining_life', { colour: null, kind: 'pf_kit' }),
  '6f': pct('black_toner_remaining', { colour: 'black', kind: 'marker' }),
  '70': pct('cyan_toner_remaining', { colour: 'cyan', kind: 'marker' }),
  '71': pct('magenta_toner_remaining', { colour: 'magenta', kind: 'marker' }),
  '72': pct('yellow_toner_remaining', { colour: 'yellow', kind: 'marker' }),
  '73': count('cyan_drum_counter'),
  '74': count('magenta_drum_counter'),
  '75': count('yellow_drum_counter'),
  '79': pct('cyan_drum_remaining_life', { colour: 'cyan', kind: 'drum' }),
  '7a': pct('magenta_drum_remaining_life', { colour: 'magenta', kind: 'drum' }),
  '7b': pct('yellow_drum_remaining_life', { colour: 'yellow', kind: 'drum' }),
  '7e': count('black_drum_counter'),
  '80': pct('black_drum_remaining_life', { colour: 'black', kind: 'drum' }),
  '81': count('black_toner'),
  '82': count('cyan_toner'),
  '83': count('magenta_toner'),
  '84': count('yellow_toner'),
  a1: pct('black_toner_remaining', { colour: 'black', kind: 'marker' }),
  a2: pct('cyan_toner_remaining', { colour: 'cyan', kind: 'marker' }),
  a3: pct('magenta_toner_remaining', { colour: 'magenta', kind: 'marker' }),
  a4: pct('yellow_toner_remaining', { colour: 'yellow', kind: 'marker' }),
};

/** Inkjet maintenance markers, from bieniu/brother `VALUES_INK_MAINTENANCE`. */
const INK_MAINTENANCE: Record<string, Marker> = {
  '31': count('black_ink_status'),
  '32': count('cyan_ink_status'),
  '33': count('magenta_ink_status'),
  '34': count('yellow_ink_status'),
  '6f': pct('black_ink_remaining', { colour: 'black', kind: 'marker' }),
  '70': pct('cyan_ink_remaining', { colour: 'cyan', kind: 'marker' }),
  '71': pct('magenta_ink_remaining', { colour: 'magenta', kind: 'marker' }),
  '72': pct('yellow_ink_remaining', { colour: 'yellow', kind: 'marker' }),
  '81': count('black_ink'),
  '82': count('cyan_ink'),
  '83': count('magenta_ink'),
  '84': count('yellow_ink'),
  a1: pct('black_ink_remaining', { colour: 'black', kind: 'marker' }),
  a2: pct('cyan_ink_remaining', { colour: 'cyan', kind: 'marker' }),
  a3: pct('magenta_ink_remaining', { colour: 'magenta', kind: 'marker' }),
  a4: pct('yellow_ink_remaining', { colour: 'yellow', kind: 'marker' }),
};

/** Nextcare markers — pages remaining, never percentages. */
const LASER_NEXTCARE: Record<string, Marker> = {
  '73': count('laser_unit_remaining_pages'),
  '77': count('pf_kit_1_remaining_pages'),
  '82': count('drum_remaining_pages'),
  '86': count('pf_kit_mp_remaining_pages'),
  '88': count('belt_unit_remaining_pages'),
  '89': count('fuser_unit_remaining_pages'),
  a4: count('black_drum_remaining_pages'),
  a5: count('cyan_drum_remaining_pages'),
  a6: count('magenta_drum_remaining_pages'),
  a7: count('yellow_drum_remaining_pages'),
};

/** Counter markers, from bieniu/brother `VALUES_COUNTERS`. */
const COUNTERS: Record<string, Marker> = {
  '00': count('page_counter'),
  '01': count('bw_counter'),
  '02': count('color_counter'),
  '06': count('duplex_unit_pages_counter'),
  '12': count('black_counter'),
  '13': count('cyan_counter'),
  '14': count('magenta_counter'),
  '15': count('yellow_counter'),
  '16': count('image_counter'),
};

/** Bytes per entry in the modern blob: marker, index, length, then a four-byte value. */
const CHUNK_BYTES = 7;
/** Bytes per entry in the older blob: marker, index, length, then current and max. */
const LEGACY_CHUNK_BYTES = 5;
/** The denominator every legacy entry scales against — 20 steps of five percent. */
const LEGACY_SCALE = 0x14;

/**
 * Strips the trailing checksum byte and returns the rest as lower-case hex.
 *
 * Brother terminates each blob with an `FF` that is not an entry. Decoding it as
 * one yields a marker of `ff` that matches nothing, so dropping it changes no
 * result — but it keeps the chunk count honest, which the legacy heuristic below
 * depends on.
 */
function blobHex(value: SnmpValue | undefined): string | null {
  if (!Buffer.isBuffer(value) || value.length < 2) return null;
  return value.subarray(0, -1).toString('hex').toLowerCase();
}

/**
 * Recognises the older five-byte layout.
 *
 * A legacy entry ends in a fixed denominator of 0x14, so a blob whose every
 * five-byte entry ends that way is legacy and one that does not is modern. This
 * checks every chunk where Home Assistant's version skips the last one; a
 * stricter test can only refuse to treat a modern blob as legacy, which is the
 * direction we want to be wrong in — misreading a modern blob as legacy would
 * divide the wrong two bytes and print a confident, meaningless percentage.
 */
export function isLegacyBlob(hex: string): boolean {
  const chunkChars = LEGACY_CHUNK_BYTES * 2;
  if (hex.length === 0 || hex.length % chunkChars !== 0) return false;

  const scale = LEGACY_SCALE.toString(16).padStart(2, '0');
  for (let i = 0; i < hex.length; i += chunkChars) {
    if (hex.slice(i + chunkChars - 2, i + chunkChars) !== scale) return false;
  }
  return true;
}

/**
 * Decodes one blob into named values.
 *
 * The modern layout packs each reading into seven bytes: a marker byte saying
 * what it is, an index and a length that are always `01 04`, then a big-endian
 * four-byte value. Percentages arrive multiplied by a hundred, so 92 % is sent
 * as 9200 — dividing is not a fudge factor, it is the unit.
 */
export function decodeBrotherBlob(hex: string, markers: Record<string, Marker>): BrotherValue[] {
  const legacy = isLegacyBlob(hex);
  const chunkChars = (legacy ? LEGACY_CHUNK_BYTES : CHUNK_BYTES) * 2;
  const out: BrotherValue[] = [];

  for (let i = 0; i + chunkChars <= hex.length; i += chunkChars) {
    const chunk = hex.slice(i, i + chunkChars);
    const marker = chunk.slice(0, 2);
    const spec = markers[marker];
    if (!spec) continue;

    if (legacy) {
      // Current over maximum, as a fraction of the fixed scale.
      const current = Number.parseInt(chunk.slice(6, 8), 16);
      const max = Number.parseInt(chunk.slice(8, 10), 16);
      if (!Number.isFinite(current) || !Number.isFinite(max) || max === 0) continue;
      out.push({ key: spec.key, value: Math.round((current / max) * 100), isPercent: true, marker });
      continue;
    }

    const raw = Number.parseInt(chunk.slice(-8), 16);
    if (!Number.isFinite(raw)) continue;

    if (spec.percent) {
      const percent = Math.round(raw / 100);
      // A blob entry can carry a sentinel rather than a reading. Anything outside
      // 0-100 is not a percentage, and printing it as one would be worse than
      // saying nothing — which is exactly the failure this whole module exists
      // to correct.
      if (percent < 0 || percent > 100) continue;
      out.push({ key: spec.key, value: percent, isPercent: true, marker });
    } else {
      out.push({ key: spec.key, value: raw, isPercent: false, marker });
    }
  }

  return out;
}

/**
 * Whether a printer marks with ink or with toner.
 *
 * Home Assistant asks the user; this app must not, so it reads the answer off
 * the standard supplies table the poll already fetched. The two marker maps
 * agree on every colour reading anyway — `6f` is black-remaining in both — so
 * this choice only decides whether drum and fuser markers are looked for, and
 * getting it wrong costs a missing extra, never a wrong number.
 */
export function printerKindFrom(supplyTypes: readonly string[]): 'laser' | 'ink' {
  const inkish = supplyTypes.some((t) => t === 'ink' || t === 'inkCartridge' || t === 'wasteInk');
  const tonerish = supplyTypes.some(
    (t) => t === 'toner' || t === 'tonerCartridge' || t === 'wasteToner' || t === 'opc',
  );
  if (tonerish) return 'laser';
  return inkish ? 'ink' : 'laser';
}

/** The marker map for a printer of this kind. */
function maintenanceMarkers(kind: 'laser' | 'ink'): Record<string, Marker> {
  return kind === 'laser' ? LASER_MAINTENANCE : INK_MAINTENANCE;
}

/** Where a decoded key belongs among the standard rows, or null when it is not a level. */
export function targetOf(key: string, kind: 'laser' | 'ink'): BrotherTarget | null {
  for (const marker of Object.values(maintenanceMarkers(kind))) {
    if (marker.key === key && marker.target) return marker.target;
  }
  return null;
}

/**
 * Reads Brother's private branch.
 *
 * Every OID here is optional: a Brother that does not answer one of them is a
 * Brother with one fewer reading, not a failed poll. The caller treats a thrown
 * error the same way, because the standard read has already succeeded by the
 * time this runs and must not be discarded over a vendor extra.
 */
export async function readBrother(
  client: SnmpClient,
  kind: 'laser' | 'ink',
): Promise<BrotherReading> {
  return decodeBrotherReading(await client.get([...BROTHER_OIDS], true), kind);
}

/**
 * Decodes an already-fetched set of private OIDs.
 *
 * Split from the read so a caller that wants the raw bytes as well as the
 * decoded values — the diagnostic report does — pays for one round trip rather
 * than two. The report needs both: a decode is only as good as the marker map
 * behind it, and a marker this app has no name for vanishes once decoded.
 */
export function decodeBrotherReading(
  raw: Map<string, SnmpValue>,
  kind: 'laser' | 'ink',
): BrotherReading {
  const text = (oid: string): string | null => {
    const value = raw.get(oid);
    if (!Buffer.isBuffer(value)) return null;
    const s = value.toString('latin1').replace(/\0+$/, '').trim();
    return s.length > 0 ? s : null;
  };

  const maintenanceHex = blobHex(raw.get(BROTHER_OID.maintenance));
  const nextcareHex = blobHex(raw.get(BROTHER_OID.nextcare));
  const countersHex = blobHex(raw.get(BROTHER_OID.counters));

  return {
    model: modelName(text(BROTHER_OID.model)),
    serial: text(BROTHER_OID.serial),
    firmware: text(BROTHER_OID.firmware),
    maintenance: maintenanceHex ? decodeBrotherBlob(maintenanceHex, maintenanceMarkers(kind)) : [],
    nextcare: nextcareHex ? decodeBrotherBlob(nextcareHex, LASER_NEXTCARE) : [],
    counters: countersHex ? decodeBrotherBlob(countersHex, COUNTERS) : [],
    legacy: maintenanceHex !== null && isLegacyBlob(maintenanceHex),
  };
}

/**
 * Pulls the model out of Brother's device-ID string.
 *
 * The OID answers with a whole IEEE 1284 device ID —
 * `MFG:Brother;CMD:PJL,HBP,URF;MDL:MFC-L2827DW;CLS:PRINTER;…` — and only the
 * `MDL` field is a model. Returned whole when there is no `MDL`, because an
 * unparsed string still tells a user more than a null does.
 */
export function modelName(deviceId: string | null): string | null {
  if (deviceId === null) return null;
  const match = /(?:^|;)\s*(?:MDL|MODEL)\s*:\s*([^;]+)/i.exec(deviceId);
  return match ? match[1]!.trim() : deviceId;
}

/**
 * The family a standard supply row belongs to.
 *
 * Derived from prtMarkerSuppliesType first, because that is what the printer
 * actually declares, and from the description only for the parts the MIB has no
 * type for — Brother's belt and laser units both come through as `unknown`.
 */
export function supplyKind(type: string, description: string): SupplyKind {
  if (type === 'toner' || type === 'tonerCartridge' || type === 'ink' || type === 'inkCartridge') {
    return 'marker';
  }
  if (type === 'opc') return 'drum';
  if (type === 'transferUnit') return 'belt';
  if (type === 'fuser' || type === 'fuserOil' || type === 'fuserOiler' || type === 'fuserOilWick') {
    return 'fuser';
  }

  const text = description.toLowerCase();
  if (/\bdrum\b|photoconductor|\bopc\b/.test(text)) return 'drum';
  if (/belt|transfer/.test(text)) return 'belt';
  if (/fuser|fixing/.test(text)) return 'fuser';
  if (/laser/.test(text)) return 'laser';
  if (/\bpf\b|paper\s*feed/.test(text)) return 'pf_kit';
  if (/toner|\bink\b|cartridge/.test(text)) return 'marker';
  return 'marker';
}

/** The subset of a supply row this matching needs, so tests need not build a whole one. */
export interface MatchableSupply {
  description: string;
  type: string;
  colour: SupplyColour;
  percent: number | null;
  someRemaining: boolean;
}

/**
 * Chooses the vendor percentage for one standard supply row, or null for none.
 *
 * Two rules, and both matter more than the matching itself:
 *
 * A row that already has a percentage keeps it. The standard table is the source
 * of truth wherever it answers; this is a patch for silence, not a second
 * opinion. Undertaker's drum reads 78 % from the standard table and agrees with
 * Home Assistant to the page — there is nothing here to improve, and overriding
 * it would put the app's correctness at the mercy of a private OID.
 *
 * A vendor value with no clear row is dropped. The blob names a colour and a
 * kind and nothing else, so a value matches only when exactly one row shares
 * both. Two black toners and an ambiguous marker means no number, which is the
 * same answer the app already gives when it does not know.
 */
export function vendorPercentFor(
  supply: MatchableSupply,
  supplies: readonly MatchableSupply[],
  values: readonly BrotherValue[],
  kind: 'laser' | 'ink',
): number | null {
  if (supply.percent !== null) return null;

  const wanted = supplyKind(supply.type, supply.description);

  const candidates = values.filter((v) => {
    if (!v.isPercent) return false;
    const target = targetOf(v.key, kind);
    if (target === null || target.kind !== wanted) return false;
    return target.colour === null || target.colour === supply.colour;
  });
  if (candidates.length !== 1) return null;

  // The row must be unambiguous too: one value cannot name which of two black
  // toners it describes, so neither may take it.
  const peers = supplies.filter(
    (s) =>
      s.percent === null &&
      supplyKind(s.type, s.description) === wanted &&
      s.colour === supply.colour,
  );
  if (peers.length !== 1) return null;

  return candidates[0]!.value;
}
