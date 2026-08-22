/**
 * Manufacturer identification from the IANA enterprise number in sysObjectID.
 *
 * This is presentation only: every reading in the app comes from the standard
 * Printer-MIB, so an unrecognised manufacturer loses a pretty name and nothing
 * else. Adding a brand here must never become a prerequisite for support.
 */

/** IANA Private Enterprise Numbers of printer manufacturers. */
const ENTERPRISES: Record<number, string> = {
  2: 'IBM',
  11: 'HP',
  18: 'Wang',
  23: 'Novell',
  24: 'Xerox',
  25: 'Ricoh',
  27: 'Sharp',
  33: 'Toshiba',
  36: 'DEC',
  42: 'Sun',
  43: '3Com',
  47: 'Panasonic',
  62: 'Fujitsu',
  77: 'Konica Minolta',
  128: 'Tektronix',
  236: 'Samsung',
  253: 'Xerox',
  256: 'OKI',
  297: 'Brother',
  318: 'Adobe',
  367: 'Ricoh',
  641: 'Lexmark',
  674: 'Dell',
  1129: 'Kyocera',
  1248: 'Epson',
  1347: 'Kyocera',
  1602: 'Canon',
  1793: 'Sagem',
  2001: 'Canon',
  2385: 'Sharp',
  2435: 'Brother',
  2001180: 'Zebra',
  10642: 'Zebra',
  18334: 'Konica Minolta',
  23120: 'Bixolon',
};

/**
 * A vendor's display name, or null when the number is not one we know.
 *
 * Callers must treat null as "unbranded", not as "unsupported".
 */
export function vendorName(enterprise: number | null): string | null {
  if (enterprise === null) return null;
  return ENTERPRISES[enterprise] ?? null;
}

/**
 * Builds the name a newly paired device gets.
 *
 * Printers usually put the brand in the model already ("EPSON XP-6100 Series"),
 * so the vendor is only prepended when the model does not mention it — otherwise
 * the user ends up adopting an "Epson EPSON XP-6100 Series".
 */
export function suggestDeviceName(
  model: string | null,
  vendor: string | null,
  fallbackName: string | null,
  host: string,
): string {
  if (model) {
    if (!vendor) return model;
    return model.toLowerCase().includes(vendor.toLowerCase()) ? model : `${vendor} ${model}`;
  }
  if (fallbackName) return fallbackName;
  return `Printer ${host}`;
}
