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

/**
 * width, height and destination for each image Homey asks for.
 *
 * The app image is a 10:7 banner for the App Store listing, so it stays the
 * rendered illustration. The driver images come from the same drawing as the
 * icon: guideline 1.4.3 asks for the device on a white background, which is
 * exactly what that drawing is, and sharing it keeps the icon and the device
 * page looking like the same app.
 */
const TARGETS = [
  { source: 'app-source.png', out: 'assets/images/small.png', width: 250, height: 175 },
  { source: 'app-source.png', out: 'assets/images/large.png', width: 500, height: 350 },
  { source: 'app-source.png', out: 'assets/images/xlarge.png', width: 1000, height: 700 },
  { source: 'icon-source.svg', out: 'drivers/printer/assets/images/small.png', width: 75, height: 75, contain: true },
  { source: 'icon-source.svg', out: 'drivers/printer/assets/images/large.png', width: 500, height: 500, contain: true },
  { source: 'icon-source.svg', out: 'drivers/printer/assets/images/xlarge.png', width: 1000, height: 1000, contain: true },
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
    // `cover` crops a photo rather than letterboxing it, so the printer keeps the
    // same size relative to the frame at every resolution. A drawing is already
    // framed with its own margins, so it is contained on white instead — cropping
    // it would cut the printer off.
    .resize(target.width, target.height, target.contain
      ? { fit: 'contain', background: '#ffffff' }
      : { fit: 'cover', position: 'centre' })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toFile(output);

  built += 1;
  console.log(`${target.out}  ${target.width}x${target.height}`);
}

console.log(`built ${built}/${TARGETS.length} images`);
