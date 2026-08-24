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
 * Every capability icon, as a filled path with no stroke anywhere.
 *
 * This is not a style choice. The web app renders real SVG; the mobile app does
 * not honour `fill="none"` and fills each path regardless. Filling the interior
 * of an outline drawing gives a featureless silhouette, which is how a stroked
 * printer icon reached a user's phone as a solid cross and a cartridge as a
 * plain rectangle — correct in the browser, unreadable next to it. Filling a
 * shape that was drawn to be filled looks the same everywhere. Athom's own
 * capability vectors are filled paths for the same reason. Keep them that way.
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

  paper_low: '<path fill-rule="evenodd" d="M5.2 2.6h8.2l4.4 4.4v14.4H5.2V2.6ZM7.1 4.5h4.3v4.3h4.4v10.1H7.1V4.5Z"/>'
    + '<path d="M10.4 9.9h2v5h-2Z"/>'
    + '<path d="M10.4 16.1h2v2h-2Z"/>',

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
  alarm_paper_low: 'paper_low',
};

for (const [file, shape] of Object.entries(ICON_FILES)) {
  const body = ICONS[shape];
  if (!body) throw new Error(`No shape named ${shape} for ${file}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="#000">${body}</svg>`;
  writeFileSync(join(iconDir, `${file}.svg`), `${svg}\n`);
}

/**
 * A percentage capability, which is what supplies and trays both are.
 *
 * One definition now covers many rows: each supply is a sub-capability of one
 * of these, so the title here is only ever the fallback Homey shows before the
 * device renames the row after what the printer calls it.
 */
function levelCapability({ en, fr, nl }, icon) {
  return {
    type: 'number',
    title: { en, fr, nl },
    uiComponent: 'sensor',
    getable: true,
    setable: false,
    insights: true,
    // French sets a space before the percent sign, and Homey's own capabilities
    // carry it. A units object with only `en` also leaves the capability
    // half-translated in an app whose titles and Flow cards are not.
    units: { en: '%', fr: ' %', nl: '%' },
    min: 0,
    max: 100,
    decimals: 0,
    icon: `/assets/capability/${icon}.svg`,
  };
}

/**
 * The level capabilities, one per kind of thing rather than one per colour.
 *
 * Three for consumables rather than one, because `icon` belongs to a
 * capability's definition and is not a capability option: every sub-capability
 * wears its base's icon, so a waste bottle and a fuser sharing the ink drop of
 * the black cartridge would lose what the icon is there to say.
 */
const LEVELS = {
  measure_supply: [{ en: 'Supply', fr: 'Consommable', nl: 'Verbruiksartikel' }, 'supply_ink'],
  measure_waste: [{ en: 'Waste tank', fr: 'Réservoir usagé', nl: 'Afvalreservoir' }, 'supply_waste'],
  measure_part: [{ en: 'Part', fr: 'Pièce', nl: 'Onderdeel' }, 'supply_cartridge'],
  measure_tray: [{ en: 'Tray', fr: 'Bac', nl: 'Lade' }, 'printer_tray'],
};

for (const [id, [names, icon]] of Object.entries(LEVELS)) {
  writeFileSync(
    join(capDir, `${id}.json`),
    `${JSON.stringify(levelCapability(names, icon), null, 2)}\n`,
  );
}

/** The lifetime page counter. `meter_` so a user can pick it as the device indicator. */
writeFileSync(
  join(capDir, 'meter_pages.json'),
  `${JSON.stringify({
    type: 'number',
    title: { en: 'Pages printed', fr: 'Pages imprimées', nl: 'Pagina\u2019s afgedrukt' },
    uiComponent: 'sensor',
    getable: true,
    setable: false,
    insights: true,
    units: { en: 'pages', fr: 'pages', nl: "pagina's" },
    min: 0,
    decimals: 0,
    icon: '/assets/capability/printer_pages.svg',
  }, null, 2)}\n`,
);

console.log(`wrote ${Object.keys(LEVELS).length + 1} level capabilities and ${Object.keys(ICON_FILES).length} icons`);
