/**
 * Printer-MIB (RFC 3805) and Host Resources MIB (RFC 2790) decoding.
 *
 * Every OID here is standard, so the same code reads an Epson, an HP, a Brother
 * or a Kyocera. Vendor profiles only add extras on top; nothing in this file is
 * brand-specific.
 */

/** Branches walked or fetched. Leaf OIDs end in the instance index. */
export const OID = {
  /** sysDescr.0 — free-form, e.g. "EPSON Built-in 11b/g/n Print Server". */
  sysDescr: '1.3.6.1.2.1.1.1.0',
  /** sysObjectID.0 — carries the IANA enterprise number used for vendor detection. */
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  /** sysName.0 — the printer's network name, e.g. "EPSONC618AD". */
  sysName: '1.3.6.1.2.1.1.5.0',
  /** hrDeviceDescr.1 — the marketing model, e.g. "EPSON XP-6100 Series". */
  hrDeviceDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
  /** hrPrinterStatus.1 — see {@link PRINTER_STATUS}. */
  hrPrinterStatus: '1.3.6.1.2.1.25.3.5.1.1.1',
  /**
   * hrDeviceStatus.1 — see {@link DEVICE_STATUS}.
   *
   * Read alongside hrPrinterStatus because the two answer different questions:
   * hrPrinterStatus says what the print engine is doing, hrDeviceStatus whether
   * the machine is usable at all. A printer with a jam commonly reports `idle`
   * on the first and `down` on the second.
   */
  hrDeviceStatus: '1.3.6.1.2.1.25.3.2.1.5.1',
  /** hrPrinterDetectedErrorState.1 — a bit string, see {@link ERROR_BITS}. */
  hrPrinterDetectedErrorState: '1.3.6.1.2.1.25.3.5.1.2.1',
  /** prtGeneralPrinterName.1 — often shorter than hrDeviceDescr. */
  prtGeneralPrinterName: '1.3.6.1.2.1.43.5.1.1.16.1',
  /** prtGeneralSerialNumber.1 — the stable identity we pair on. */
  prtGeneralSerialNumber: '1.3.6.1.2.1.43.5.1.1.17.1',
  /** prtConsoleDisplayBufferText.1.1 — what the physical panel shows, e.g. "Ready". */
  prtConsoleDisplayBufferText: '1.3.6.1.2.1.43.16.5.1.2.1.1',
  /** prtMarkerLifeCount.1.1 — the lifetime page counter. */
  prtMarkerLifeCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',

  /** prtMarkerSuppliesTable — walked, one row per consumable. */
  suppliesClass: '1.3.6.1.2.1.43.11.1.1.4',
  suppliesType: '1.3.6.1.2.1.43.11.1.1.5',
  suppliesDescription: '1.3.6.1.2.1.43.11.1.1.6',
  /** prtMarkerSuppliesSupplyUnit — what the level is counted in, see {@link SUPPLY_UNIT}. */
  suppliesUnit: '1.3.6.1.2.1.43.11.1.1.7',
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9',

  /** prtInputTable — walked, one row per paper tray. */
  inputCapacityUnit: '1.3.6.1.2.1.43.8.2.1.8',
  inputMaxCapacity: '1.3.6.1.2.1.43.8.2.1.9',
  inputCurrentLevel: '1.3.6.1.2.1.43.8.2.1.10',
  inputStatus: '1.3.6.1.2.1.43.8.2.1.11',
  /** prtInputMediaName — the paper loaded, e.g. "A4" or "Letter". */
  inputMediaName: '1.3.6.1.2.1.43.8.2.1.12',
  inputName: '1.3.6.1.2.1.43.8.2.1.13',
  inputDescription: '1.3.6.1.2.1.43.8.2.1.18',

  /** prtCoverTable — walked, one row per door, lid or interlock. */
  coverDescription: '1.3.6.1.2.1.43.6.1.1.2',
  coverStatus: '1.3.6.1.2.1.43.6.1.1.3',
  /** prtMarkerColorantValue — the colour name a supply row points at. */
  colorantValue: '1.3.6.1.2.1.43.12.1.1.4',
  /** prtMarkerSuppliesColorantIndex — links a supply row to a colorant row. */
  suppliesColorantIndex: '1.3.6.1.2.1.43.11.1.1.3',

  /** prtOutputTable — walked, one row per output bin or finisher tray. */
  outputMaxCapacity: '1.3.6.1.2.1.43.9.2.1.4',
  outputRemainingCapacity: '1.3.6.1.2.1.43.9.2.1.5',
  outputName: '1.3.6.1.2.1.43.9.2.1.7',
  outputDescription: '1.3.6.1.2.1.43.9.2.1.12',

  /**
   * prtAlertTable — the printer's own list of what is wrong, in its own words.
   *
   * This is the only branch that can name *which* consumable is low. Everything
   * else says only that one of them is, which leaves the user staring at an
   * alarm with nothing to act on.
   */
  alertSeverity: '1.3.6.1.2.1.43.18.1.1.2',
  alertGroup: '1.3.6.1.2.1.43.18.1.1.4',
  alertCode: '1.3.6.1.2.1.43.18.1.1.7',
  alertDescription: '1.3.6.1.2.1.43.18.1.1.8',
} as const;

/**
 * hrDeviceStatus enumeration (RFC 2790).
 *
 * Only `down` is acted on. `warning` covers everything from a low cartridge to a
 * cover left ajar, so promoting it to a status of its own would replace a useful
 * "Ready" with a permanent "Warning" on any printer that is merely low on toner.
 */
export const DEVICE_STATUS: Record<number, 'unknown' | 'running' | 'warning' | 'testing' | 'down'> = {
  1: 'unknown',
  2: 'running',
  3: 'warning',
  4: 'testing',
  5: 'down',
};

/** hrPrinterStatus enumeration (RFC 2790). */
export const PRINTER_STATUS: Record<number, PrinterStatus> = {
  1: 'other',
  2: 'unknown',
  3: 'idle',
  4: 'printing',
  5: 'warmup',
};

export type PrinterStatus = 'other' | 'unknown' | 'idle' | 'printing' | 'warmup' | 'offline';

/**
 * hrPrinterDetectedErrorState bits, most significant bit of byte 0 first.
 * The printer may return a zero-length string, one byte, or two.
 */
export const ERROR_BITS = [
  'lowPaper', 'noPaper', 'lowToner', 'noToner',
  'doorOpen', 'jammed', 'offline', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputNearFull',
  'outputFull', 'inputTrayEmpty', 'overduePreventMaint',
] as const;

export type PrinterErrorFlag = (typeof ERROR_BITS)[number];

/**
 * prtMarkerSuppliesClass. The distinction matters: a receptacle reports how full
 * it is, a consumed supply reports how much is left. Treating them alike shows a
 * nearly-full waste tank as a nearly-full ink tank.
 */
export const SUPPLY_CLASS = { other: 1, consumed: 3, receptacle: 4 } as const;

/** prtMarkerSuppliesType values we give a meaningful name to. */
export const SUPPLY_TYPE: Record<number, string> = {
  1: 'other', 2: 'unknown', 3: 'toner', 4: 'wasteToner', 5: 'ink', 6: 'inkCartridge',
  7: 'inkRibbon', 8: 'wasteInk', 9: 'opc', 10: 'developer', 11: 'fuserOil', 12: 'solidWax',
  13: 'ribbonWax', 14: 'wasteWax', 15: 'fuser', 16: 'coronaWire', 17: 'fuserOilWick',
  18: 'cleanerUnit', 19: 'fuserCleaningPad', 20: 'transferUnit', 21: 'tonerCartridge',
  22: 'fuserOiler', 23: 'water', 24: 'wasteWater', 25: 'glueWaterAdditive', 26: 'wastePaper',
  27: 'bindingSupply', 28: 'bandingSupply', 29: 'stitchingWire', 30: 'shrinkWrap',
  31: 'paperWrap', 32: 'staples', 33: 'inserts', 34: 'covers',
};

/**
 * prtMarkerSuppliesSupplyUnit. Only `percent` changes any behaviour, but the
 * rest are named so the settings page can say "48 impressions" rather than
 * leaving a user to guess what 48 means.
 */
export const SUPPLY_UNIT: Record<number, string> = {
  1: 'other', 2: 'unknown', 3: 'tenThousandthsOfInches', 4: 'micrometers',
  7: 'impressions', 8: 'sheets', 11: 'hours', 12: 'thousandthsOfOunces',
  13: 'tenthsOfGrams', 14: 'hundredthsOfFluidOunces', 15: 'tenthsOfMilliliters',
  16: 'feet', 17: 'meters', 18: 'items', 19: 'percent',
};

/** prtMarkerSuppliesSupplyUnit value for a level that is already a percentage. */
export const UNIT_PERCENT = 19;

/** Types whose level counts up as they fill rather than down as they drain. */
const WASTE_TYPES = new Set(['wasteToner', 'wasteInk', 'wasteWax', 'wasteWater', 'wastePaper']);

/**
 * Printer-MIB sentinel levels. These are negative on purpose: reporting them as a
 * percentage would put "-2 %" in front of the user, and reporting them as 0 would
 * raise a false empty-cartridge alarm.
 */
export const LEVEL_OTHER = -1;
export const LEVEL_UNKNOWN = -2;
export const LEVEL_SOME_REMAINING = -3;

/** One decoded row of prtMarkerSuppliesTable. */
export interface Supply {
  /** The row index within the table, stable for a given printer. */
  index: number;
  /** prtMarkerSuppliesDescription, e.g. "Black Ink Cartridge 202/202XL". */
  description: string;
  /** A {@link SUPPLY_TYPE} name. */
  type: string;
  /** The colour this supply lays down, when the printer links one. */
  colour: SupplyColour;
  /**
   * Percentage remaining, 0-100, or null when the printer will not say.
   * Already inverted for receptacles, so 100 always means "nothing to do".
   */
  percent: number | null;
  /** True when the printer reports presence without a quantity (-3). */
  someRemaining: boolean;
  /** True for waste tanks and other receptacles. */
  isReceptacle: boolean;
  /**
   * prtMarkerSuppliesLevel exactly as the printer sent it, sentinels included.
   *
   * Kept alongside the derived percentage because the two disagree exactly when
   * something is wrong — a printer reporting a level against a capacity we
   * misread is invisible in `percent` and obvious here. The settings page shows
   * it so a user can report what their printer actually said.
   */
  level: number;
  /** prtMarkerSuppliesMaxCapacity as sent, for the same reason. */
  maxCapacity: number;
  /** A {@link SUPPLY_UNIT} name — what {@link Supply.level} is counted in. */
  unit: string;
}

/**
 * Colours we can render with a dedicated icon. Anything else falls back to
 * `other`, which still shows a level — it just uses a neutral icon.
 */
export type SupplyColour =
  | 'black' | 'photo_black' | 'matte_black' | 'grey'
  | 'cyan' | 'magenta' | 'yellow'
  | 'light_cyan' | 'light_magenta' | 'red' | 'green' | 'blue' | 'orange'
  | 'waste' | 'other';

/**
 * Derives a colour from the printer's own colorant name plus the supply
 * description. Vendors are inconsistent about which one they fill in, so both
 * are consulted; the colorant wins when it is specific enough.
 */
export function classifySupplyColour(
  description: string,
  colorant: string | null,
  type: string,
): SupplyColour {
  if (WASTE_TYPES.has(type)) return 'waste';

  const text = `${description} ${colorant ?? ''}`.toLowerCase();

  // Order matters: "photo black" and "light cyan" must be tested before the
  // plain colour they contain, or every one of them would match "black"/"cyan".
  if (/photo\s*black|\bpbk\b|\bphk\b/.test(text)) return 'photo_black';
  if (/matte\s*black|\bmbk\b/.test(text)) return 'matte_black';
  if (/light\s*cyan|\blc\b/.test(text)) return 'light_cyan';
  if (/light\s*magenta|\blm\b/.test(text)) return 'light_magenta';
  if (/\bgrey\b|\bgray\b|\bgy\b/.test(text)) return 'grey';
  if (/\bblack\b|\bbk\b|\bk\b(?!\w)/.test(text)) return 'black';
  if (/\bcyan\b|\bc\b(?!\w)/.test(text)) return 'cyan';
  if (/\bmagenta\b|\bm\b(?!\w)/.test(text)) return 'magenta';
  if (/\byellow\b|\by\b(?!\w)/.test(text)) return 'yellow';
  if (/\bred\b/.test(text)) return 'red';
  if (/\bgreen\b/.test(text)) return 'green';
  if (/\bblue\b/.test(text)) return 'blue';
  if (/\borange\b/.test(text)) return 'orange';

  return 'other';
}

/**
 * Turns a raw supply row into a percentage.
 *
 * Returns null rather than a number whenever the printer declines to answer, so
 * a caller can tell "I do not know" apart from "it is empty". Receptacles are
 * inverted here so that every {@link Supply.percent} in the app means the same
 * thing: how much headroom is left before the user must act.
 */
export function supplyPercent(
  level: number,
  maxCapacity: number,
  isReceptacle: boolean,
  unit: string = 'unknown',
): number | null {
  if (level === LEVEL_OTHER || level === LEVEL_UNKNOWN || level === LEVEL_SOME_REMAINING) return null;
  if (level < 0) return null;

  // A level already expressed as a percentage needs no scale, and plenty of
  // printers that report one leave the capacity at -2. Reading those as
  // "unknown" threw away a level the printer had just told us outright.
  const scale = maxCapacity > 0 ? maxCapacity : (unit === 'percent' ? 100 : 0);
  // -1 (other) and -2 (unknown) capacities give no scale to divide by.
  if (scale <= 0) return null;

  const filled = Math.min(100, Math.round((level / scale) * 100));
  return isReceptacle ? 100 - filled : filled;
}

/** Maps prtMarkerSuppliesSupplyUnit to a name, defaulting to `unknown`. */
export function decodeSupplyUnit(value: number | null): string {
  if (value === null) return 'unknown';
  return SUPPLY_UNIT[value] ?? 'unknown';
}

/**
 * prtOutputRemainingCapacity sentinels. Note that -3 differs in meaning from the
 * supplies table: here it means the tray can still take at least one more sheet,
 * which is the whole question being asked.
 */
export const OUTPUT_OTHER = -1;
export const OUTPUT_UNKNOWN = -2;
export const OUTPUT_ROOM_REMAINING = -3;

/** One decoded row of prtOutputTable. */
export interface OutputTray {
  /** The row index within the table. */
  index: string;
  /** prtOutputName, falling back to prtOutputDescription, e.g. "Standard Bin". */
  name: string;
  /** prtOutputRemainingCapacity as sent, sentinels included. */
  remaining: number;
  /** prtOutputMaxCapacity as sent. */
  maxCapacity: number;
  /** Percentage of the tray still free, or null when the printer will not say. */
  percentFree: number | null;
}

/**
 * How full the output tray is, in the three steps printers themselves use.
 *
 * `unknown` is a real answer, not a failure: plenty of printers have no sheet
 * sensor in the output bin at all, and guessing "ok" for those would be a lie
 * that a Flow could act on.
 */
export type OutputTrayLevel = 'ok' | 'near_full' | 'full' | 'unknown';

/** Turns a prtOutputTable row into the fraction of the tray still free. */
export function outputPercentFree(remaining: number, maxCapacity: number): number | null {
  if (remaining === OUTPUT_ROOM_REMAINING) return null;
  if (remaining < 0) return null;
  // -1 means "no restriction" and -2 "unknown"; neither gives a scale to divide by.
  if (maxCapacity <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((remaining / maxCapacity) * 100)));
}

/** Below this much free space the tray is called near-full. */
const NEAR_FULL_PERCENT = 50;

/**
 * Decides how full the output tray is.
 *
 * The error bits win over the capacity numbers because they are what the printer
 * itself decided to raise: a printer that says `outputFull` is full whatever its
 * sheet count claims, and many printers report only the bits.
 *
 * When several trays are reported the fullest one wins, since that is the one
 * the user has to go and empty.
 */
export function classifyOutputTray(
  trays: readonly OutputTray[],
  errors: readonly string[],
): OutputTrayLevel {
  if (errors.includes('outputFull')) return 'full';
  if (errors.includes('outputNearFull')) return 'near_full';

  let fullest: number | null = null;
  for (const tray of trays) {
    if (tray.percentFree === null) continue;
    if (fullest === null || tray.percentFree < fullest) fullest = tray.percentFree;
  }

  if (fullest === null) {
    // No usable number anywhere. A tray that says "room for at least one more"
    // is still a genuine answer; anything else is the printer declining to say.
    return trays.some((t) => t.remaining === OUTPUT_ROOM_REMAINING) ? 'ok' : 'unknown';
  }
  if (fullest <= 0) return 'full';
  if (fullest < NEAR_FULL_PERCENT) return 'near_full';
  return 'ok';
}

/**
 * prtInputCurrentLevel sentinels, which mirror the supplies table but are worth
 * naming separately: -3 here means the tray still holds at least one sheet,
 * which is a perfectly good answer to "can it print?".
 */
export const INPUT_OTHER = -1;
export const INPUT_UNKNOWN = -2;
export const INPUT_SHEETS_REMAINING = -3;

/** One decoded row of prtInputTable. */
export interface InputTray {
  /** The row index within the table. */
  index: string;
  /** prtInputName, falling back to prtInputDescription, e.g. "Tray 1". */
  name: string;
  /** prtInputMediaName, e.g. "A4". Empty when the printer does not say. */
  media: string;
  /** prtInputCurrentLevel as sent, sentinels included. */
  level: number;
  /** prtInputMaxCapacity as sent. */
  maxCapacity: number;
  /** Percentage of paper left, or null when the printer will not say. */
  percent: number | null;
}

/** Turns a prtInputTable row into the percentage of paper still in the tray. */
export function inputPercent(level: number, maxCapacity: number): number | null {
  if (level < 0) return null;
  // -1 means the tray places no limit on this, -2 that it cannot tell.
  if (maxCapacity <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((level / maxCapacity) * 100)));
}

/**
 * Whether any tray is out of paper or nearly so.
 *
 * The error bits are checked first because they are the printer's own verdict,
 * and because a printer with no level sensor still raises them. A tray reporting
 * `-3` — at least one sheet left — deliberately does not count as low: it is the
 * answer of a printer that has paper and no way to weigh it.
 */
export function isPaperLow(
  trays: readonly InputTray[],
  errors: readonly string[],
  thresholdPercent: number,
): boolean {
  if (errors.includes('noPaper') || errors.includes('lowPaper') || errors.includes('inputTrayEmpty')) {
    return true;
  }
  return trays.some((t) => t.percent !== null && t.percent <= thresholdPercent);
}

/** prtCoverStatus (RFC 3805). Interlocks are doors too, from the user's side. */
export const COVER_STATUS: Record<number, 'other' | 'open' | 'closed'> = {
  1: 'other',
  3: 'open',
  4: 'closed',
  5: 'open',
  6: 'closed',
};

/** One decoded row of prtCoverTable. */
export interface PrinterCover {
  /** prtCoverDescription, e.g. "Front Door". */
  description: string;
  open: boolean;
}

/**
 * Whether any door, lid or interlock is open.
 *
 * Falls back to the `doorOpen` error bit, which several printers raise without
 * ever populating a cover table.
 */
export function isCoverOpen(covers: readonly PrinterCover[], errors: readonly string[]): boolean {
  return covers.some((c) => c.open) || errors.includes('doorOpen');
}

/** Maps prtCoverStatus to open/closed, defaulting to closed for values we do not know. */
export function decodeCoverStatus(value: number | null): boolean {
  if (value === null) return false;
  return COVER_STATUS[value] === 'open';
}

/** prtAlertSeverityLevel (RFC 3805). Both warning flavours mean the same to us. */
export const ALERT_SEVERITY: Record<number, AlertSeverity> = {
  1: 'other',
  3: 'critical',
  4: 'warning',
  5: 'warning',
};

export type AlertSeverity = 'other' | 'critical' | 'warning';

/** One decoded row of prtAlertTable. */
export interface PrinterAlert {
  severity: AlertSeverity;
  /** prtAlertCode, kept raw: the enumeration is long and vendor-extended. */
  code: number | null;
  /** prtAlertGroup, i.e. which sub-unit the alert is about. */
  group: number | null;
  /** The printer's own wording, e.g. "88 Cartridge low". May be empty. */
  description: string;
}

/** Maps prtAlertSeverityLevel to a name, defaulting to `other`. */
export function decodeAlertSeverity(value: number | null): AlertSeverity {
  if (value === null) return 'other';
  return ALERT_SEVERITY[value] ?? 'other';
}

/**
 * Reduces the alert table to the one line worth showing next to an alarm.
 *
 * Rows without a description are dropped rather than rendered as an empty
 * bullet: the MIB explicitly allows a null string, and a printer that sends one
 * has told us nothing. Duplicates are collapsed because a printer with two trays
 * routinely raises the same alert twice.
 */
export function summariseAlerts(alerts: readonly PrinterAlert[]): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];

  // Critical alerts first: the table is in the printer's own order, and a jam
  // must not be pushed off the end by four rows about paper sizes.
  const ordered = [...alerts].sort((a, b) =>
    Number(b.severity === 'critical') - Number(a.severity === 'critical'));

  for (const alert of ordered) {
    const text = alert.description.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
    if (lines.length === MAX_ALERTS) break;
  }

  if (lines.length === 0) return null;

  // A tile is read at a glance. Some printers keep a dozen rows here, and a
  // paragraph of them tells the user less than the first line alone would.
  const summary = lines.join(' · ');
  return summary.length > MAX_ALERT_LENGTH
    ? `${summary.slice(0, MAX_ALERT_LENGTH - 1).trimEnd()}…`
    : summary;
}

/** How many alert lines are worth showing, and how much text in total. */
const MAX_ALERTS = 5;
const MAX_ALERT_LENGTH = 200;

/**
 * Decodes hrPrinterDetectedErrorState into the flags that are set.
 *
 * The value is a bit string whose length varies by printer — an empty buffer is
 * a legitimate "no errors" and must not be read as a missing value.
 */
export function decodeErrorState(raw: Buffer | null): PrinterErrorFlag[] {
  if (!raw) return [];

  const flags: PrinterErrorFlag[] = [];
  for (let bit = 0; bit < ERROR_BITS.length; bit += 1) {
    const byte = raw[bit >> 3];
    if (byte === undefined) break;
    if ((byte & (0x80 >> (bit & 7))) !== 0) flags.push(ERROR_BITS[bit]!);
  }
  return flags;
}

/**
 * Reads the IANA enterprise number out of a sysObjectID, which is what
 * identifies the manufacturer. Epson is 1248, HP 11, Brother 2435, Canon 1602.
 */
export function enterpriseNumber(sysObjectID: string | null): number | null {
  if (!sysObjectID) return null;
  const match = /^(?:\.)?1\.3\.6\.1\.4\.1\.(\d+)/.exec(sysObjectID.trim());
  return match ? Number(match[1]) : null;
}

/** Maps hrPrinterStatus to a name, defaulting to `unknown` for values we do not know. */
export function decodePrinterStatus(value: number | null): PrinterStatus {
  if (value === null) return 'unknown';
  return PRINTER_STATUS[value] ?? 'unknown';
}

/** Maps prtMarkerSuppliesType to a name, defaulting to `other`. */
export function decodeSupplyType(value: number | null): string {
  if (value === null) return 'other';
  return SUPPLY_TYPE[value] ?? 'other';
}

/** True when a supply row is a receptacle that fills up rather than drains. */
export function isReceptacle(supplyClass: number | null, type: string): boolean {
  if (supplyClass === SUPPLY_CLASS.receptacle) return true;
  // Some printers leave the class at `other` but still name a waste type.
  return WASTE_TYPES.has(type);
}
