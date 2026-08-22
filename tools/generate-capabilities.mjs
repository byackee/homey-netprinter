/**
 * Writes one capability definition per supply colour.
 *
 * These files are generated rather than hand-written because they differ only by
 * colour name: eighteen near-identical JSON files drift apart the moment one is
 * edited by hand. Re-run with `npm run gen:capabilities` after changing a title.
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
 * them. `icon` picks which of the three shapes below the capability wears.
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
  // Fallbacks for supplies whose colour the printer does not name.
  { id: 'other_1', icon: 'cartridge', en: 'Supply 1', fr: 'Consommable 1', nl: 'Verbruiksartikel 1' },
  { id: 'other_2', icon: 'cartridge', en: 'Supply 2', fr: 'Consommable 2', nl: 'Verbruiksartikel 2' },
  { id: 'other_3', icon: 'cartridge', en: 'Supply 3', fr: 'Consommable 3', nl: 'Verbruiksartikel 3' },
  { id: 'other_4', icon: 'cartridge', en: 'Supply 4', fr: 'Consommable 4', nl: 'Verbruiksartikel 4' },
];

/**
 * Homey re-colours capability icons to match the theme, so these are outlines
 * rather than coloured drops — the colour lives in the title instead.
 */
const ICONS = {
  ink: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c3.5 4.2 5.5 7.1 5.5 9.6A5.5 5.5 0 0 1 12 18a5.5 5.5 0 0 1-5.5-5.4C6.5 10.1 8.5 7.2 12 3Z"/></svg>',
  waste: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M6.5 7l1 12.5h9L17.5 7M10 4h4"/><path d="M8 13.5h8"/></svg>',
  cartridge: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="16" height="12" rx="1.5"/><path d="M8 6v12M8 10h8"/></svg>',
};

for (const [name, svg] of Object.entries(ICONS)) {
  writeFileSync(join(iconDir, `supply_${name}.svg`), `${svg}\n`);
}

for (const supply of SUPPLIES) {
  const definition = {
    type: 'number',
    title: { en: supply.en, fr: supply.fr, nl: supply.nl },
    uiComponent: 'sensor',
    getable: true,
    setable: false,
    insights: true,
    units: { en: '%' },
    min: 0,
    max: 100,
    decimals: 0,
    icon: `/assets/capability/supply_${supply.icon}.svg`,
  };
  writeFileSync(
    join(capDir, `supply_${supply.id}.json`),
    `${JSON.stringify(definition, null, 2)}\n`,
  );
}

console.log(`wrote ${SUPPLIES.length} supply capabilities and ${Object.keys(ICONS).length} icons`);
