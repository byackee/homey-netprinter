/**
 * What an IPP reply means, in this app's terms.
 *
 * The split from ipp-client.mts is the same one snmp-client.mts draws: that
 * module knows the wire and nothing else, this one knows what a supply is and
 * never touches a socket. Everything here is a pure function of a decoded
 * reply, which is what lets it be tested against captured printer output rather
 * than against a printer.
 *
 * Two shapes carry supply levels, and printers disagree about which to use:
 *
 * - `marker-levels` and friends, the CUPS and AirPrint convention. One
 *   attribute per property, each a list with one entry per cartridge, matched
 *   by position. Nearly everything speaks this.
 * - `printer-supply`, the PWG 5100.13 form. One packed string per cartridge —
 *   `type=toner;maxcapacity=100;level=92;colorantname=black;` — with the names
 *   in a parallel `printer-supply-description`.
 *
 * Both are read, `marker-levels` first because it is the more widely
 * implemented of the two, and a printer that answers both answers them
 * identically.
 *
 * There is deliberately no page count here. IPP has no printer-level impression
 * counter this app could rely on — the counters it does define belong to jobs —
 * and inventing an attribute name that no printer answers would put a
 * permanent "unknown" on screen while looking like support. The Printer-MIB
 * has prtMarkerLifeCount and keeps that job.
 */

import type { IppAttributes, IppValue } from './ipp-client.mjs';
import {
  classifySupplyColour,
  inputPercent,
  isReceptacle,
  supplyPercent,
  SUPPLY_TYPE,
  type InputTray,
  type PrinterErrorFlag,
  type PrinterStatus,
  type Supply,
} from './printer-mib.mjs';

/**
 * What one poll asks for.
 *
 * Named rather than "all": `all` invites a printer to answer with its entire
 * media database, which is hundreds of collections and several hundred
 * kilobytes on a mid-range office machine, none of it about ink. The diagnostic
 * asks for everything precisely because it is not on the hot path.
 */
export const IPP_ATTRIBUTES: readonly string[] = [
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'printer-make-and-model',
  'printer-name',
  'printer-info',
  'printer-device-id',
  'printer-uuid',
  'printer-firmware-string-version',
  'marker-names',
  'marker-levels',
  'marker-colors',
  'marker-types',
  'marker-high-levels',
  'marker-low-levels',
  'printer-supply',
  'printer-supply-description',
  'printer-input-tray',
];

/** Everything one IPP read learned. */
export interface IppReading {
  model: string | null;
  name: string | null;
  serial: string | null;
  /**
   * `printer-firmware-string-version` — the version as the printer writes it.
   *
   * The one source for this that is neither a brand's private branch nor a
   * guess pulled out of a model string: IPP defines the attribute, so a printer
   * that answers IPP at all may answer this whoever made it.
   */
  firmware: string | null;
  status: PrinterStatus;
  /** `printer-state-reasons`, verbatim. The printer's own words for what is wrong. */
  stateReasons: string[];
  /** `printer-state-message`, when the printer offers one. */
  displayText: string | null;
  /** `printer-state-reasons` mapped onto this app's error flags. */
  errors: PrinterErrorFlag[];
  supplies: Supply[];
  inputTrays: InputTray[];
}

function text(value: IppValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8').trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstText(attrs: IppAttributes, name: string): string | null {
  return text(attrs.get(name)?.[0]);
}

/** Every value of a list attribute, as text. */
function textList(attrs: IppAttributes, name: string): string[] {
  return (attrs.get(name) ?? []).map((v) => text(v) ?? '');
}

/** Every value of a list attribute, as numbers, with anything unreadable as -2. */
function numberList(attrs: IppAttributes, name: string): number[] {
  return (attrs.get(name) ?? []).map((v) => (typeof v === 'number' ? v : LEVEL_UNKNOWN));
}

/** IPP's "I cannot tell you", identical in meaning to the Printer-MIB's. */
const LEVEL_UNKNOWN = -2;

/**
 * Some printers pack a whole list into one comma-separated string.
 *
 * CUPS sends `marker-names` as a proper 1setOf; several printers send one
 * string with commas in it instead. Read as-is, that gives one cartridge called
 * "Black,Cyan,Magenta,Yellow" and three levels with nothing to name them.
 */
function unpack(values: string[], expected: number): string[] {
  if (values.length === expected) return values;
  if (values.length === 1 && expected > 1 && values[0].includes(',')) {
    const parts = values[0].split(',').map((p) => p.trim());
    if (parts.length === expected) return parts;
  }
  return values;
}

/**
 * The colours a hex triplet stands for.
 *
 * `marker-colors` gives `#000000` where the Printer-MIB gives the word "black",
 * and the classifier this app already has reads words. Mapping the handful of
 * values printers actually send is what lets an IPP cartridge land on the same
 * capability — and the same Insights history — as the SNMP row for the same ink.
 */
const HEX_COLOURS: Record<string, string> = {
  '#000000': 'black',
  '#00ffff': 'cyan',
  '#ff00ff': 'magenta',
  '#ffff00': 'yellow',
  '#ff0000': 'red',
  '#00ff00': 'green',
  '#0000ff': 'blue',
  '#ffa500': 'orange',
  '#808080': 'grey',
  '#767676': 'grey',
  '#7f7f7f': 'grey',
};

/** A `marker-colors` entry turned into a word, when it is one this app knows. */
export function colourNameFor(marker: string): string | null {
  const value = marker.trim().toLowerCase();
  if (value.length === 0 || value === 'none' || value === 'unknown') return null;
  if (!value.startsWith('#')) return value;
  return HEX_COLOURS[value] ?? null;
}

/** The Printer-MIB's name for an IPP supply type, when the two agree on one. */
const MIB_TYPE_NAMES = new Set(Object.values(SUPPLY_TYPE));

export function normaliseSupplyType(keyword: string): string {
  const value = keyword.trim();
  if (value.length === 0) return 'other';
  if (MIB_TYPE_NAMES.has(value)) return value;

  // IPP keywords are hyphenated where the MIB is camel-cased: `ink-cartridge`
  // against `inkCartridge`. Same part, same word, different house style.
  const camel = value.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return MIB_TYPE_NAMES.has(camel) ? camel : value;
}

/** Splits `a<delimiter>b;c<delimiter>d;` into its parts, keys lowercased. */
function parseFields(value: string, delimiter: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of value.split(';')) {
    const at = part.indexOf(delimiter);
    if (at <= 0) continue;
    out.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return out;
}

/** Splits a PWG packed string — `type=toner;level=92;` — into its parts. */
export function parsePacked(value: string): Map<string, string> {
  return parseFields(value, '=');
}

/**
 * Splits an IEEE 1284 device id — `MFG:Canon;MDL:PRO-1000S;SN:ABC123;`.
 *
 * Same shape as a PWG packed string and a different separator, which is the
 * kind of detail that costs an afternoon: read with an `=` parser, a device id
 * yields nothing at all and the printer looks like it has no serial number.
 */
export function parseDeviceId(value: string): Map<string, string> {
  return parseFields(value, ':');
}

function packedNumber(fields: Map<string, string>, key: string, fallback: number): number {
  const raw = fields.get(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function buildSupply(
  position: number,
  description: string,
  typeKeyword: string,
  colourWord: string | null,
  level: number,
  high: number,
): Supply {
  const type = normaliseSupplyType(typeKeyword);
  return {
    // The printer's own ordering is the only identity IPP offers a cartridge,
    // and it is stable for a given printer — which is what the capability id,
    // and therefore the Insights history, hangs on.
    index: `ipp.${position}`,
    description,
    type,
    colour: classifySupplyColour(description, colourWord, type),
    // IPP levels are a percentage of `marker-high-levels`, which is 100 on
    // everything that has ever been seen, and the sentinels are RFC 3805's. So
    // this is the same arithmetic the standard table gets, unchanged.
    percent: supplyPercent(level, high, 'percent'),
    someRemaining: level === -3,
    isReceptacle: isReceptacle(null, type),
    level,
    maxCapacity: high,
    unit: 'percent',
    supplyClass: null,
    ippSourced: true,
  };
}

/** Supplies as `marker-levels` and its parallel attributes describe them. */
function markerSupplies(attrs: IppAttributes): Supply[] {
  const levels = numberList(attrs, 'marker-levels');
  if (levels.length === 0) return [];

  const names = unpack(textList(attrs, 'marker-names'), levels.length);
  const colours = unpack(textList(attrs, 'marker-colors'), levels.length);
  const types = unpack(textList(attrs, 'marker-types'), levels.length);
  const highs = numberList(attrs, 'marker-high-levels');

  return levels.map((level, i) => buildSupply(
    i + 1,
    names[i] ?? `Supply ${i + 1}`,
    types[i] ?? '',
    colourNameFor(colours[i] ?? ''),
    level,
    highs[i] ?? 100,
  ));
}

/** Supplies as the PWG `printer-supply` strings describe them. */
function packedSupplies(attrs: IppAttributes): Supply[] {
  const packed = textList(attrs, 'printer-supply').filter((v) => v.length > 0);
  if (packed.length === 0) return [];

  const descriptions = unpack(textList(attrs, 'printer-supply-description'), packed.length);

  return packed.map((value, i) => {
    const fields = parsePacked(value);
    return buildSupply(
      i + 1,
      descriptions[i] || fields.get('colorantname') || `Supply ${i + 1}`,
      fields.get('type') ?? '',
      fields.get('colorantname') ?? null,
      packedNumber(fields, 'level', LEVEL_UNKNOWN),
      packedNumber(fields, 'maxcapacity', 100),
    );
  });
}

/**
 * Every supply the reply describes.
 *
 * `marker-levels` wins where both are present. Not because it is better — the
 * two carry the same numbers — but because it is the one nearly every printer
 * implements, so preferring it keeps one code path warm instead of two.
 */
export function ippSupplies(attrs: IppAttributes): Supply[] {
  const markers = markerSupplies(attrs);
  return markers.length > 0 ? markers : packedSupplies(attrs);
}

/** Paper trays, from the packed `printer-input-tray` strings. */
export function ippInputTrays(attrs: IppAttributes): InputTray[] {
  const trays = textList(attrs, 'printer-input-tray').filter((v) => v.length > 0);

  return trays.map((value, i) => {
    const fields = parsePacked(value);
    const level = packedNumber(fields, 'level', LEVEL_UNKNOWN);
    const maxCapacity = packedNumber(fields, 'maxcapacity', LEVEL_UNKNOWN);
    return {
      index: `ipp.${i + 1}`,
      name: fields.get('name') || `Tray ${i + 1}`,
      // IPP describes a tray's dimensions, not the name of what is in it. The
      // Printer-MIB's prtInputMediaName has no counterpart here, and an invented
      // "A4" would be a guess printed as a fact.
      media: '',
      type: fields.get('type') ?? 'other',
      level,
      maxCapacity,
      percent: inputPercent(level, maxCapacity),
    };
  });
}

/**
 * The printer's state.
 *
 * `printer-state` has three values and says nothing about why, so the reasons
 * are consulted for the two states this app draws a distinction the enum does
 * not: a printer warming up is not idle, and one shut down is not merely
 * stopped.
 */
export function ippStatus(attrs: IppAttributes): PrinterStatus {
  const reasons = textList(attrs, 'printer-state-reasons').map((r) => r.toLowerCase());
  if (reasons.some((r) => r.startsWith('shutdown'))) return 'offline';
  if (reasons.some((r) => r.startsWith('warming-up'))) return 'warmup';

  const state = attrs.get('printer-state')?.[0];
  switch (typeof state === 'number' ? state : 0) {
    case 3: return 'idle';
    case 4: return 'printing';
    // 5 is "stopped", which means the printer wants something from a human. It
    // is emphatically not offline: it is answering us to say so.
    case 5: return 'other';
    default: return 'unknown';
  }
}

/**
 * The serial number, dug out of the IEEE 1284 device id.
 *
 * `printer-device-id` is a semicolon-packed string built for a parallel port —
 * `MFG:Canon;MDL:PRO-1000S;SN:ABC123;` — and it is the only place IPP carries a
 * serial. That matters more than it sounds: the serial is the identity a paired
 * device is keyed on, so without one an IPP-only printer could not be recognised
 * again after a change of address.
 */
export function ippSerial(attrs: IppAttributes): string | null {
  const deviceId = firstText(attrs, 'printer-device-id');
  if (deviceId === null) return null;

  const fields = parseDeviceId(deviceId);
  return fields.get('sn') ?? fields.get('sern') ?? fields.get('serialnumber') ?? null;
}

/**
 * `printer-state-reasons` translated into the error flags this app already has.
 *
 * The Printer-MIB carries these as a bit string and IPP as keywords, and the
 * two vocabularies line up almost word for word — both were written by the same
 * people for the same machines. Mapping them is what lets a printer read over
 * IPP alone still raise "out of paper" instead of showing a bare percentage and
 * no idea why the thing has stopped.
 *
 * A reason with no counterpart is dropped rather than forced onto the nearest
 * flag: it stays visible verbatim in the diagnostic, which is the honest place
 * for something this app does not understand.
 */
const REASON_FLAGS: Array<[RegExp, PrinterErrorFlag]> = [
  [/^media-empty|^media-needed|^input-media-supply-empty/, 'noPaper'],
  [/^media-low/, 'lowPaper'],
  [/^marker-supply-empty|^toner-empty/, 'noToner'],
  [/^marker-supply-low|^toner-low/, 'lowToner'],
  [/^marker-waste-full|^marker-waste-almost-full/, 'markerSupplyMissing'],
  [/^cover-open|^door-open|^interlock-open/, 'doorOpen'],
  [/^media-jam|^jam/, 'jammed'],
  [/^shutdown|^offline/, 'offline'],
  [/^input-tray-missing/, 'inputTrayMissing'],
  [/^output-tray-missing/, 'outputTrayMissing'],
  [/^output-area-full/, 'outputFull'],
  [/^output-area-almost-full/, 'outputNearFull'],
  [/^service-request|^moving-to-paused|^paused/, 'serviceRequested'],
];

export function ippErrorFlags(reasons: readonly string[]): PrinterErrorFlag[] {
  const flags = new Set<PrinterErrorFlag>();

  for (const reason of reasons) {
    // A reason may be qualified — "media-empty-warning", "cover-open-error" —
    // and the qualifier says how bad it is, not what it is.
    const value = reason.trim().toLowerCase();
    if (value.length === 0 || value === 'none') continue;
    for (const [pattern, flag] of REASON_FLAGS) {
      if (pattern.test(value)) flags.add(flag);
    }
  }

  return [...flags];
}

/** Everything one IPP read learned, assembled. */
export function ippReading(attrs: IppAttributes): IppReading {
  const deviceId = firstText(attrs, 'printer-device-id');
  const packedModel = deviceId === null ? null : parseDeviceId(deviceId).get('mdl') ?? null;

  return {
    model: firstText(attrs, 'printer-make-and-model') ?? packedModel,
    name: firstText(attrs, 'printer-name') ?? firstText(attrs, 'printer-info'),
    serial: ippSerial(attrs),
    firmware: firstText(attrs, 'printer-firmware-string-version'),
    status: ippStatus(attrs),
    stateReasons: textList(attrs, 'printer-state-reasons').filter((r) => r.length > 0 && r !== 'none'),
    displayText: firstText(attrs, 'printer-state-message'),
    errors: ippErrorFlags(textList(attrs, 'printer-state-reasons')),
    supplies: ippSupplies(attrs),
    inputTrays: ippInputTrays(attrs),
  };
}

/**
 * Fills standard rows that came back without a number, from the IPP reading.
 *
 * The rule is the one the vendor branch already follows, and for the same
 * reason: a row the Printer-MIB numbered keeps the Printer-MIB's number. Only a
 * row that answered -1, -2 or -3 is offered one from elsewhere. That is what
 * stops a second source from quietly becoming the source.
 *
 * Matching is by colour and by whether the part fills or drains, and an
 * ambiguous match is dropped rather than guessed. Two blacks in a photo
 * printer's table would otherwise take each other's levels, and a wrong number
 * is worse than the honest blank it replaced.
 *
 * Mutates in place and returns the indices it filled, mirroring readVendor —
 * these are the rows the user sees, and a copy would leave two versions of the
 * truth in one snapshot.
 */
export function fillFromIpp(supplies: Supply[], fromIpp: readonly Supply[]): string[] {
  const filled: string[] = [];

  for (const supply of supplies) {
    if (supply.percent !== null) continue;

    const candidates = fromIpp.filter((row) =>
      row.percent !== null
      && row.colour === supply.colour
      && row.isReceptacle === supply.isReceptacle);

    if (candidates.length !== 1) continue;

    supply.percent = candidates[0].percent;
    supply.ippSourced = true;
    // `level` and `someRemaining` keep what the standard table actually sent.
    // They are the record of the read that came up empty, and a number arriving
    // from a second protocol does not change what the first one said.
    filled.push(supply.index);
  }

  return filled;
}
