import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Guards the one thing `homey app validate` will not check for us.
 *
 * The validator walks `drivers[].pair[]` and asserts each view has a file at
 * `drivers/<id>/pair/<viewId>.html`. It never looks at `drivers[].repair[]` —
 * `repair` is not even in Homey's app manifest schema. So a repair view in the
 * wrong folder passes validation at publish level, ships, and fails only when a
 * user taps Repair and gets `unknown_error_getting_file`. That is exactly how
 * this app shipped a broken repair flow for three releases.
 *
 * Repair views resolve from `drivers/<id>/repair/<viewId>.html`, confirmed on a
 * Homey Pro by moving the file there and watching the view open.
 */

// .testbuild/test/<file>.test.mjs → up two levels to the app root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface DriverView { id?: string; template?: string }
interface Driver { id: string; pair?: DriverView[]; repair?: DriverView[] }

function drivers(): Driver[] {
  const manifest = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')) as { drivers?: Driver[] };
  return manifest.drivers ?? [];
}

/** A view with a `template` is one of Homey's own, so it has no file of ours. */
function customViews(views: DriverView[] | undefined): string[] {
  return (views ?? []).filter((v) => v.template === undefined && v.id).map((v) => v.id as string);
}

describe('driver views have the files Homey will look for', () => {
  it('has drivers to check, so a broken manifest cannot pass this silently', () => {
    assert.ok(drivers().length > 0, 'app.json declares no drivers');
  });

  it('puts every repair view in drivers/<id>/repair/', () => {
    for (const driver of drivers()) {
      for (const view of customViews(driver.repair)) {
        const path = join('drivers', driver.id, 'repair', `${view}.html`);
        assert.ok(existsSync(join(root, path)), `missing ${path}`);
      }
    }
  });

  it('puts every pair view in drivers/<id>/pair/', () => {
    for (const driver of drivers()) {
      for (const view of customViews(driver.pair)) {
        const path = join('drivers', driver.id, 'pair', `${view}.html`);
        assert.ok(existsSync(join(root, path)), `missing ${path}`);
      }
    }
  });

  it('leaves no orphan view in pair/ that only repair declares', () => {
    // The dead copy this bug left behind: a file in pair/ that nothing pairs
    // with, quietly shipped in every build.
    for (const driver of drivers()) {
      const paired = new Set(customViews(driver.pair));
      for (const view of customViews(driver.repair)) {
        if (paired.has(view)) continue;
        const stray = join('drivers', driver.id, 'pair', `${view}.html`);
        assert.ok(!existsSync(join(root, stray)), `${stray} is dead weight; repair reads repair/`);
      }
    }
  });
});
