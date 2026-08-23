/**
 * Draws the app and driver icon.
 *
 * Homey renders these as a filled silhouette — it takes the shape and paints it
 * one colour — so a stroke-based drawing comes out as a solid blob. To read as
 * line art after that, the outline has to *be* the filled shape: an outer path
 * with an inner path subtracted from it under `fill-rule="evenodd"`.
 *
 * Two earlier attempts are worth recording, because both looked wrong for
 * reasons the geometry does not make obvious:
 *
 *   Three separate rings, one per part, read as three stacked bars. Nothing
 *   connected them, so it was not a printer.
 *
 *   One continuous outline with all three parts a similar height read as a plus
 *   sign. The body has to dominate — much taller than the tray, much wider than
 *   both tray and sheet.
 *
 * The output tray now overlaps up into the body, which is what says "paper comes
 * out here" rather than "there is a third box below".
 *
 * Run with `npm run gen:icon`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Line weight: thin enough to leave the openings open at 24 px, thick enough to survive. */
const W = 1.45;

const TOP = 3.0;        // top of the paper tray
const TRAY_L = 7.4;     // the tray is the narrowest part
const TRAY_R = 16.6;
const BODY_T = 7.6;     // the body: tallest and widest, it carries the shape
const BODY_B = 17.2;
const BODY_L = 2.5;
const BODY_R = 21.5;
const SHEET_L = 6.6;    // the output tray, wider than the paper tray above
const SHEET_R = 17.4;
const SHEET_T = 14.5;   // above BODY_B on purpose: it reaches up into the body
const BOTTOM = 21.2;

/**
 * The outline of the printer as one closed loop: tray, body, and the part of the
 * output tray that sticks out below. Inset by `d` on every edge; 0 traces the
 * silhouette itself.
 */
function silhouette(d) {
  return [
    `M${TRAY_L + d} ${TOP + d}`,
    `H${TRAY_R - d}`,
    `V${BODY_T + d}`,
    `H${BODY_R - d}`,
    `V${BODY_B - d}`,
    `H${SHEET_R - d}`,
    `V${BOTTOM - d}`,
    `H${SHEET_L + d}`,
    `V${BODY_B - d}`,
    `H${BODY_L + d}`,
    `V${BODY_T + d}`,
    `H${TRAY_L + d}`,
    'Z',
  ].join(' ');
}

/**
 * The top of the output tray, drawn inside the body's opening.
 *
 * An upside-down U: up one side, across, down the other. Because it sits in the
 * hollow left by the two paths above, evenodd flips it back to solid — so it
 * reads as the tray passing in front of the body, which is the whole point.
 */
const outputTray = [
  `M${SHEET_L} ${BODY_B}`,
  `V${SHEET_T}`,
  `H${SHEET_R}`,
  `V${BODY_B}`,
  `H${SHEET_R - W}`,
  `V${SHEET_T + W}`,
  `H${SHEET_L + W}`,
  `V${BODY_B}`,
  'Z',
].join(' ');

/*
 * A status light, top right of the body. Solid on purpose: at 24 px a ring this
 * small closes up and reads as a smudge.
 */
const LIGHT_X = 18.7;
const LIGHT_Y = 10.6;
const LIGHT_R = 1.05;
const light = [
  `M${LIGHT_X} ${LIGHT_Y - LIGHT_R}`,
  `a${LIGHT_R} ${LIGHT_R} 0 1 1 0 ${LIGHT_R * 2}`,
  `a${LIGHT_R} ${LIGHT_R} 0 1 1 0 ${-LIGHT_R * 2}`,
  'Z',
].join(' ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path fill="#000" fill-rule="evenodd" d="${silhouette(0)} ${silhouette(W)} ${outputTray} ${light}"/>
</svg>
`;

for (const target of ['assets/icon.svg', 'drivers/printer/assets/icon.svg']) {
  writeFileSync(join(root, target), svg);
  console.log(`wrote ${target}`);
}
