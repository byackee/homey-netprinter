import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { planCapabilities } from '../lib/capability-map.mjs';
import type { Supply } from '../lib/printer-mib.mjs';

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

type Manifest = { drivers?: Driver[]; capabilities?: Record<string, unknown> };

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
}

/** Homey's own capability list, as shipped in the SDK this app builds against. */
function systemCapabilities(): Set<string> {
  const path = join(root, 'node_modules', 'homey-lib', 'assets', 'capability', 'capabilities.json');
  return new Set(JSON.parse(readFileSync(path, 'utf8')) as string[]);
}

/**
 * Whether a capability id resolves to something Homey can render.
 *
 * Homey finds a capability by its base id, so `measure_supply.black` is
 * `measure_supply` — which is the whole reason a sub-capability works without
 * twenty-two definitions, and also the reason a typo in the base is invisible
 * until a row shows up blank on someone's phone.
 */
function isKnown(capability: string, app: Manifest): boolean {
  const base = capability.split('.')[0] as string;
  return systemCapabilities().has(base) || Object.hasOwn(app.capabilities ?? {}, base);
}

describe('the driver declares capabilities the app can honour', () => {
  it('has drivers to check, so a broken manifest cannot pass this silently', () => {
    assert.ok((manifest().drivers ?? []).length > 0, 'app.json declares no drivers');
  });

  it('defines every capability it declares that Homey does not', () => {
    // A capability id with no definition and no system equivalent is added to
    // the device and then renders as nothing at all. Checked against Homey's
    // own list rather than a prefix, so a rename cannot quietly slip past.
    const app = manifest();
    for (const driver of app.drivers ?? []) {
      for (const capability of driver.capabilities ?? []) {
        assert.ok(isKnown(capability, app), `${driver.id} declares undefined ${capability}`);
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

describe('every row the app can produce resolves to a real capability', () => {
  /**
   * The check the sub-capability design makes necessary.
   *
   * Nothing declares `measure_supply.black` anywhere — the device adds it at
   * runtime from what the printer reported. So the manifest cannot be compared
   * against a list of rows; the rows have to be generated and compared against
   * the manifest. A base capability renamed in one place and not the other
   * would otherwise ship, and show up as a row with no title, no icon and no
   * value.
   */
  it('covers a laser reporting toner, a waste bottle, parts and trays', () => {
    const app = manifest();
    const printer: Supply[] = [
      { colour: 'black', description: 'Black Cartridge', index: '1.1' },
      { colour: 'cyan', description: 'Cyan Cartridge', index: '1.2' },
      { colour: 'black', description: 'Second Black', index: '1.3' },
      { colour: 'waste', description: 'Waste Toner Bottle', index: '1.4' },
      { colour: 'other', description: 'Fuser', index: '1.5' },
    ].map((s) => ({
      ...s,
      type: s.colour === 'waste' ? 'wasteToner' : 'toner',
      percent: 50,
      someRemaining: false,
      isReceptacle: s.colour === 'waste',
      supplyClass: s.colour === 'waste' ? 4 : 3,
      level: 50,
      maxCapacity: 100,
      unit: 'percent',
    })) as Supply[];

    const plan = planCapabilities({
      model: 'Lexmark C3326dw',
      name: 'LEXMARK',
      serial: 'X',
      enterprise: 641,
      status: 'idle',
      displayText: 'Ready',
      pageCount: 1000,
      errors: [],
      supplies: printer,
      outputTrays: [],
      inputTrays: [
        { index: '1.1', name: 'Tray 1', media: 'A4', type: 'sheetFeedAutoRemovableTray', level: 100, maxCapacity: 100, percent: 100 },
        { index: '1.2', name: 'Bypass', media: 'Plain', type: 'sheetFeedManual', level: 0, maxCapacity: 100, percent: 0 },
      ],
      covers: [{ description: 'Front Door', open: false }],
      alerts: [],
      alertsRead: true,
      vendor: null,
    }, 15);

    assert.ok(plan.capabilities.length > 10, 'the fixture should exercise a lot of rows');
    for (const capability of plan.capabilities) {
      assert.ok(isKnown(capability, app), `plan produces undefined ${capability}`);
    }
  });
});
