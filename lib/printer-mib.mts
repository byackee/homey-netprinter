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
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9',
  /** prtMarkerColorantValue — the colour name a supply row points at. */
  colorantValue: '1.3.6.1.2.1.43.12.1.1.4',
  /** prtMarkerSuppliesColorantIndex — links a supply row to a colorant row. */
  suppliesColorantIndex: '1.3.6.1.2.1.43.11.1.1.3',
} as const;

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
export function supplyPercent(level: number, maxCapacity: number, isReceptacle: boolean): number | null {
  if (level === LEVEL_OTHER || level === LEVEL_UNKNOWN || level === LEVEL_SOME_REMAINING) return null;
  if (level < 0) return null;
  // -1 (other) and -2 (unknown) capacities give no scale to divide by.
  if (maxCapacity <= 0) return null;

  const filled = Math.min(100, Math.round((level / maxCapacity) * 100));
  return isReceptacle ? 100 - filled : filled;
}

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
