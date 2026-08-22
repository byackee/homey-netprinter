/**
 * Renders the App Store images from the two sources in `.src-images/`.
 *
 * Homey checks the exact pixel dimensions, and the App Store guidelines ask for
 * two different pictures: the app image may be a branded illustration, while the
 * driver image must be the device itself on a white background. Reusing one for
 * both fails review, so they are built from separate sources here.
 *
 * Run with `npm run gen:images`. `sharp` is a devDependency, so none of this ships.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '.src-images');

/** width, height and destination for each image Homey asks for. */
const TARGETS = [
  // The app image is a 10:7 banner shown in the App Store listing.
  { source: 'app-source.png', out: 'assets/images/small.png', width: 250, height: 175 },
  { source: 'app-source.png', out: 'assets/images/large.png', width: 500, height: 350 },
  { source: 'app-source.png', out: 'assets/images/xlarge.png', width: 1000, height: 700 },
  // The driver image is square and shows the device on white.
  { source: 'driver-source.png', out: 'drivers/printer/assets/images/small.png', width: 75, height: 75 },
  { source: 'driver-source.png', out: 'drivers/printer/assets/images/large.png', width: 500, height: 500 },
  { source: 'driver-source.png', out: 'drivers/printer/assets/images/xlarge.png', width: 1000, height: 1000 },
];

let built = 0;

for (const target of TARGETS) {
  const input = join(src, target.source);
  if (!existsSync(input)) {
    console.error(`missing source: ${input}`);
    process.exitCode = 1;
    continue;
  }

  const output = join(root, target.out);
  mkdirSync(dirname(output), { recursive: true });

  await sharp(input)
    // `cover` crops rather than letterboxes, so the printer stays the same size
    // relative to the frame at every resolution instead of gaining grey bars.
    .resize(target.width, target.height, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toFile(output);

  built += 1;
  console.log(`${target.out}  ${target.width}x${target.height}`);
}

console.log(`built ${built}/${TARGETS.length} images`);
