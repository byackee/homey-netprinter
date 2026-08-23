/**
 * Writes the per-supply capability definitions and every capability icon.
 *
 * The supply and tray definitions are generated rather than hand-written because
 * they differ only by a name: twenty-odd near-identical JSON files drift apart
 * the moment one is edited by hand. Re-run with `npm run gen:capabilities` after
 * changing a title or an icon.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const capDir = join(root, '.homeycompose', 'capabilities');
const iconDir = join(root, 'assets', 'capability');

mkdirSync(capDir, { recursive: true });
mkdirSync(iconDir, { recursive: true });

/**
 * Supply colours we give a named capability to, in the order Homey should show
 * them. `icon` picks which of the shapes below the capability wears.
 */
const SUPPLIES = [
  { id: 'black',         icon: 'ink', en: 'Black',           fr: 'Noir',            nl: 'Zwart' },
  { id: 'photo_black',   icon: 'ink', en: 'Photo black',     fr: 'Noir photo',      nl: 'Fotozwart' },
  { id: 'matte_black',   icon: 'ink', en: 'Matte black',     fr: 'Noir mat',        nl: 'Mat zwart' },
  { id: 'grey',          icon: 'ink', en: 'Grey',            fr: 'Gris',            nl: 'Grijs' },
  { id: 'cyan',          icon: 'ink', en: 'Cyan',            fr: 'Cyan',            nl: 'Cyaan' },
  { id: 'magenta',       icon: 'ink', en: 'Magenta',         fr: 'Magenta',         nl: 'Magenta' },
  { id: 'yellow',        icon: 'ink', en: 'Yellow',          fr: 'Jaune',           nl: 'Geel' },
  { id: 'light_cyan',    icon: 'ink', en: 'Light cyan',      fr: 'Cyan clair',      nl: 'Lichtcyaan' },
  { id: 'light_magenta', icon: 'ink', en: 'Light magenta',   fr: 'Magenta clair',   nl: 'Lichtmagenta' },
  { id: 'red',           icon: 'ink', en: 'Red',             fr: 'Rouge',           nl: 'Rood' },
  { id: 'green',         icon: 'ink', en: 'Green',           fr: 'Vert',            nl: 'Groen' },
  { id: 'blue',          icon: 'ink', en: 'Blue',            fr: 'Bleu',            nl: 'Blauw' },
  { id: 'orange',        icon: 'ink', en: 'Orange',          fr: 'Orange',          nl: 'Oranje' },
  // A waste tank is reported as headroom left, so 100 % always means "nothing to do".
  { id: 'waste',         icon: 'waste', en: 'Waste tank',    fr: 'Réservoir d’encre usée', nl: 'Afvalreservoir' },
  // Fallbacks for supplies whose colour the printer does not name. A laser fills
  // most of these on its own: photoconductor, fuser, transfer unit, rollers.
  { id: 'other_1', icon: 'cartridge', en: 'Supply 1', fr: 'Consommable 1', nl: 'Verbruiksartikel 1' },
  { id: 'other_2', icon: 'cartridge', en: 'Supply 2', fr: 'Consommable 2', nl: 'Verbruiksartikel 2' },
  { id: 'other_3', icon: 'cartridge', en: 'Supply 3', fr: 'Consommable 3', nl: 'Verbruiksartikel 3' },
  { id: 'other_4', icon: 'cartridge', en: 'Supply 4', fr: 'Consommable 4', nl: 'Verbruiksartikel 4' },
  { id: 'other_5', icon: 'cartridge', en: 'Supply 5', fr: 'Consommable 5', nl: 'Verbruiksartikel 5' },
  { id: 'other_6', icon: 'cartridge', en: 'Supply 6', fr: 'Consommable 6', nl: 'Verbruiksartikel 6' },
  { id: 'other_7', icon: 'cartridge', en: 'Supply 7', fr: 'Consommable 7', nl: 'Verbruiksartikel 7' },
  { id: 'other_8', icon: 'cartridge', en: 'Supply 8', fr: 'Consommable 8', nl: 'Verbruiksartikel 8' },
];

/** Paper trays. The device renames each one after what the printer calls it. */
const TRAYS = [1, 2, 3, 4].map((n) => ({
  id: `tray_${n}`,
  icon: 'tray',
  en: `Tray ${n}`,
  fr: `Bac ${n}`,
  nl: `Lade ${n}`,
}));

/**
 * Every capability icon, as a filled path with no stroke anywhere.
 *
 * This is not a style choice. The web app renders real SVG, but the mobile app
 * rasterises each icon into a monochrome mask, and a shape drawn only with
 * `stroke` has no fill to rasterise — so stroked icons appeared correctly in the
 * browser and as nothing at all on a phone. Athom's own capability vectors are
 * filled paths for the same reason. Keep them that way.
 */
const ICONS = {
  ink: '<path d="M12 2.3c4.1 5 6.2 8.4 6.2 11.1a6.2 6.2 0 0 1-12.4 0c0-2.7 2.1-6.1 6.2-11.1Z"/>',

  waste: '<path d="M9.5 2.4h5a1.1 1.1 0 0 1 1.1 1.1v1H8.4v-1a1.1 1.1 0 0 1 1.1-1.1Z"/>'
    + '<path d="M3.9 5.6h16.2v2.2H3.9Z"/>'
    + '<path fill-rule="evenodd" d="M5.9 9.1h12.2l-.9 11a1.7 1.7 0 0 1-1.7 1.5H8.5a1.7 1.7 0 0 1-1.7-1.5l-.9-11Zm3.3 2.6v7.5h1.7v-7.5H9.2Zm3.9 0v7.5h1.7v-7.5h-1.7Z"/>',

  cartridge: '<path fill-rule="evenodd" d="M3.5 5.5h17v13h-17V5.5Zm2 2v9h13v-9h-13Z"/>'
    + '<path d="M7.4 5.5h2v13h-2Z"/>'
    + '<path d="M9.4 10.5h9.1v2H9.4Z"/>',

  tray: '<path d="M9.3 2.6h5.4v1.9H9.3Z"/>'
    + '<path d="M8 5.9h8v1.9H8Z"/>'
    + '<path d="M6.7 9.2h10.6v1.9H6.7Z"/>'
    + '<path d="M2.9 12.9h2.2v4.8h13.8v-4.8h2.2v6.9H2.9Z"/>',

  // An arrow into the tray, because the output bin is where paper arrives.
  output_tray: '<path d="M10.9 2.6h2.2v6.3h3.2L12 14.4 7.7 8.9h3.2V2.6Z"/>'
    + '<path d="M2.9 12.9h2.2v4.8h13.8v-4.8h2.2v6.9H2.9Z"/>',

  printer: '<path fill-rule="evenodd" d="M6.8 2.5h10.4v5.7H6.8V2.5Zm1.9 1.9v1.9h6.6V4.4H8.7Z"/>'
    + '<path fill-rule="evenodd" d="M3.2 8.2h17.6v7.5H3.2V8.2Zm13.5 2.2v2.2h2.1v-2.2h-2.1Z"/>'
    + '<path fill-rule="evenodd" d="M6.8 15.7h10.4v5.8H6.8v-5.8Zm1.9 1.9v2h6.6v-2H8.7Z"/>',

  message: '<path fill-rule="evenodd" d="M3.3 4.4h17.4v11.2H3.3V4.4Zm1.9 1.9v7.4h13.6V6.3H5.2Z"/>'
    + '<path d="M7 8h10v1.5H7Z"/>'
    + '<path d="M7 10.8h5.8v1.5H7Z"/>'
    + '<path d="M11 15.6h2v3h-2Z"/>'
    + '<path d="M7.7 18.1h8.6v1.9H7.7Z"/>',

  pages: '<path fill-rule="evenodd" d="M6.1 2.6h8.3l4.5 4.5v14.3H6.1V2.6ZM8 4.5h4.4v4.4h4.5v9.9H8V4.5Z"/>'
    + '<path d="M9.4 12h5.2v1.7H9.4Z"/>'
    + '<path d="M9.4 15h5.2v1.7H9.4Z"/>',

  supply_low: '<path fill-rule="evenodd" d="M12 2.3c4.1 5 6.2 8.4 6.2 11.1a6.2 6.2 0 0 1-12.4 0c0-2.7 2.1-6.1 6.2-11.1Zm0 3.3c-2.8 3.6-4.2 6.2-4.2 7.8a4.2 4.2 0 0 0 8.4 0c0-1.6-1.4-4.2-4.2-7.8Z"/>'
    + '<path d="M11.1 9.4h1.8v4.3h-1.8Z"/>'
    + '<path d="M11.1 14.9h1.8v1.9h-1.8Z"/>',

  printer_error: '<path fill-rule="evenodd" d="M12 2.9 22.5 21H1.5L12 2.9Zm0 3.9L5.1 18.8h13.8L12 6.8Z"/>'
    + '<path d="M11.1 10.1h1.8v4.6h-1.8Z"/>'
    + '<path d="M11.1 15.9h1.8v1.9h-1.8Z"/>',

  paper_low: '<path fill-rule="evenodd" d="M5.2 2.6h8.2l4.4 4.4v14.4H5.2V2.6ZM7.1 4.5h4.3v4.3h4.4v10.1H7.1V4.5Z"/>'
    + '<path d="M10.4 9.9h2v5h-2Z"/>'
    + '<path d="M10.4 16.1h2v2h-2Z"/>',

  cover_open: '<path d="M3.5 7.1 13.5 3l.8 1.9-10 4.1Z"/>'
    + '<path fill-rule="evenodd" d="M3.4 9.6h17.2v11.4H3.4V9.6Zm1.9 1.9v7.6h13.4v-7.6H5.3Z"/>',

  alert: '<path d="M12 2.2a2 2 0 0 1 2 2v.4a6.2 6.2 0 0 1 4.2 5.9v3.6l1.7 3.1v1.5H4.1v-1.5l1.7-3.1v-3.6A6.2 6.2 0 0 1 10 4.6v-.4a2 2 0 0 1 2-2Z"/>'
    + '<path d="M9.6 20.1h4.8a2.4 2.4 0 0 1-4.8 0Z"/>',
};

/** The file each icon is written to. Several capabilities share one shape. */
const ICON_FILES = {
  supply_ink: 'ink',
  supply_waste: 'waste',
  supply_cartridge: 'cartridge',
  printer_tray: 'tray',
  printer_output_tray: 'output_tray',
  printer_status: 'printer',
  printer_message: 'message',
  printer_pages: 'pages',
  printer_alert: 'alert',
  alarm_supply_low: 'supply_low',
  alarm_printer_error: 'printer_error',
  alarm_paper_low: 'paper_low',
  alarm_cover_open: 'cover_open',
};

for (const [file, shape] of Object.entries(ICON_FILES)) {
  const body = ICONS[shape];
  if (!body) throw new Error(`No shape named ${shape} for ${file}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="#000">${body}</svg>`;
  writeFileSync(join(iconDir, `${file}.svg`), `${svg}\n`);
}

/** A percentage capability, which is what both supplies and trays are. */
function levelCapability({ en, fr, nl }, icon) {
  return {
    type: 'number',
    title: { en, fr, nl },
    uiComponent: 'sensor',
    getable: true,
    setable: false,
    insights: true,
    units: { en: '%' },
    min: 0,
    max: 100,
    decimals: 0,
    icon: `/assets/capability/${icon}.svg`,
  };
}

for (const supply of SUPPLIES) {
  writeFileSync(
    join(capDir, `supply_${supply.id}.json`),
    `${JSON.stringify(levelCapability(supply, `supply_${supply.icon}`), null, 2)}\n`,
  );
}

for (const tray of TRAYS) {
  writeFileSync(
    join(capDir, `printer_${tray.id}.json`),
    `${JSON.stringify(levelCapability(tray, `printer_${tray.icon}`), null, 2)}\n`,
  );
}

console.log(
  `wrote ${SUPPLIES.length} supply and ${TRAYS.length} tray capabilities, `
  + `and ${Object.keys(ICON_FILES).length} icons`,
);
