/**
 * Names for the rows the printer does not name itself.
 *
 * Before 1.1.0 every colour was its own capability, so "Black" and "Noir" came
 * from that capability's own definition and Homey translated them. One
 * `measure_supply` capability with a sub-capability per colour has one title
 * between them all, so the colour has to arrive as a per-row override instead —
 * which means this app now owns those words rather than the manifest.
 *
 * The printer's own description still wins wherever there is one: "Black Ink
 * Cartridge 202/202XL" names the thing to reorder, and no translation of ours
 * improves on it. This is the fallback for a printer that reports a colorant
 * and no wording, which would otherwise show every row as a bare "Supply".
 */

import type { SupplyColour } from './printer-mib.mjs';

/** A Homey translation object, in the languages this app ships. */
export interface Translated {
  en: string;
  fr: string;
  nl: string;
}

const COLOUR_NAMES: Partial<Record<SupplyColour, Translated>> = {
  black: { en: 'Black', fr: 'Noir', nl: 'Zwart' },
  photo_black: { en: 'Photo black', fr: 'Noir photo', nl: 'Fotozwart' },
  matte_black: { en: 'Matte black', fr: 'Noir mat', nl: 'Mat zwart' },
  grey: { en: 'Grey', fr: 'Gris', nl: 'Grijs' },
  cyan: { en: 'Cyan', fr: 'Cyan', nl: 'Cyaan' },
  magenta: { en: 'Magenta', fr: 'Magenta', nl: 'Magenta' },
  yellow: { en: 'Yellow', fr: 'Jaune', nl: 'Geel' },
  light_cyan: { en: 'Light cyan', fr: 'Cyan clair', nl: 'Lichtcyaan' },
  light_magenta: { en: 'Light magenta', fr: 'Magenta clair', nl: 'Lichtmagenta' },
  red: { en: 'Red', fr: 'Rouge', nl: 'Rood' },
  green: { en: 'Green', fr: 'Vert', nl: 'Groen' },
  blue: { en: 'Blue', fr: 'Bleu', nl: 'Blauw' },
  orange: { en: 'Orange', fr: 'Orange', nl: 'Oranje' },
  waste: { en: 'Waste tank', fr: 'Réservoir usagé', nl: 'Afvalreservoir' },
};

/** The translated name of a colour, or null for one we have no word for. */
export function colourName(colour: SupplyColour): Translated | null {
  return COLOUR_NAMES[colour] ?? null;
}

/** "Supply 3" in each language, for a part the printer left unnamed. */
export function partName(position: number): Translated {
  return {
    en: `Supply ${position}`,
    fr: `Consommable ${position}`,
    nl: `Verbruiksartikel ${position}`,
  };
}

/** "Tray 2" in each language, for a tray the printer left unnamed. */
export function trayName(position: number): Translated {
  return {
    en: `Tray ${position}`,
    fr: `Bac ${position}`,
    nl: `Lade ${position}`,
  };
}
