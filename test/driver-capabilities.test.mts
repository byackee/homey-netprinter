import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Guards the capability contract the driver manifest ships.
 *
 * A device only ever gets the manifest's capability list at pairing time, so
 * what is declared here is also what an existing device is brought up to on
 * init. Two things about that list have to hold, and neither is checked by
 * `homey app validate`.
 */

// .testbuild/test/<file>.test.mjs → up two levels to the app root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Driver {
  id: string;
  capabilities?: string[];
  capabilitiesOptions?: Record<string, { setable?: boolean }>;
}

function manifest(): { drivers?: Driver[]; capabilities?: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
}

describe('the driver declares capabilities the app can honour', () => {
  it('has drivers to check, so a broken manifest cannot pass this silently', () => {
    assert.ok((manifest().drivers ?? []).length > 0, 'app.json declares no drivers');
  });

  it('defines every custom capability it declares', () => {
    // A capability id with no definition and no Homey equivalent is added to
    // the device and then renders as nothing at all.
    const app = manifest();
    const defined = new Set(Object.keys(app.capabilities ?? {}));
    for (const driver of app.drivers ?? []) {
      for (const capability of driver.capabilities ?? []) {
        if (!capability.startsWith('printer_') && !capability.startsWith('supply_')) continue;
        assert.ok(defined.has(capability), `${driver.id} declares undefined ${capability}`);
      }
    }
  });

  it('never offers a settable onoff, because SNMP cannot switch a printer on', () => {
    // `onoff` is here to dim the tile when the printer stops answering. Homey
    // makes it settable by default, which would put a switch on every printer
    // that silently does nothing when pressed.
    for (const driver of manifest().drivers ?? []) {
      if (!(driver.capabilities ?? []).includes('onoff')) continue;
      assert.equal(
        driver.capabilitiesOptions?.onoff?.setable, false,
        `${driver.id} declares onoff without setable: false`,
      );
    }
  });
});
