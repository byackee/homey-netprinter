/**
 * Draws the app and driver icon.
 *
 * Homey renders these as a filled silhouette — it takes the shape and paints it
 * in one colour — so a stroke-based drawing comes out as a solid blob. To read
 * as line art after that treatment, the outline has to *be* the filled shape:
 * every element is a ring, drawn as an outer rectangle with an inner rectangle
 * subtracted from it via `fill-rule="evenodd"`.
 *
 * Run with `npm run gen:icon`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A rounded rectangle as an SVG path, drawn clockwise.
 *
 * Direction matters: with `evenodd` an inner path drawn the same way still
 * subtracts, which is what makes the ring.
 */
function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M${x + r} ${y}`,
    `H${x + width - r}`,
    `A${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V${y + height - r}`,
    `A${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H${x + r}`,
    `A${r} ${r} 0 0 1 ${x} ${y + height - r}`,
    `V${y + r}`,
    `A${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/** A ring: the outline of a rounded rectangle, `weight` thick. */
function ring(x, y, width, height, radius, weight) {
  const inner = roundedRect(
    x + weight, y + weight,
    width - weight * 2, height - weight * 2,
    Math.max(0.1, radius - weight),
  );
  return `${roundedRect(x, y, width, height, radius)} ${inner}`;
}

/*
 * Stroke weight. A compromise: too thin and it disappears at 24 px, too thick and
 * the openings close up and each part reads as a solid bar rather than an outline.
 */
const W = 1.35;

/*
 * A printer, in three parts that touch without overlapping — overlapping rings
 * would cancel each other out under evenodd and leave holes.
 *
 *   paper tray   above
 *   body         across the middle, widest
 *   printed page below
 */
const parts = [
  ring(6.9, 2.1, 10.2, 6.3, 1.1, W),    // paper tray
  ring(2.2, 8.7, 19.6, 8.0, 2.0, W),    // body
  ring(6.9, 17.0, 10.2, 4.9, 1.1, W),   // sheet coming out
];

// A status light, the one solid element: a small dot reads at 24 px where a
// tiny ring would fill in and look like a smudge.
const light = 'M18.5 11.6 a1.1 1.1 0 1 1 0 2.2 a1.1 1.1 0 1 1 0 -2.2 Z';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path fill="#000" fill-rule="evenodd" d="${parts.join(' ')} ${light}"/>
</svg>
`;

for (const target of ['assets/icon.svg', 'drivers/printer/assets/icon.svg']) {
  writeFileSync(join(root, target), svg);
  console.log(`wrote ${target}`);
}
