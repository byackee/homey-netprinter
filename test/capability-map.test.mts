import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasBlockingError, isSupplyLow, planCapabilities } from '../lib/capability-map.mjs';
import type { Supply, SupplyColour } from '../lib/printer-mib.mjs';
import type { PrinterSnapshot } from '../lib/printer-reader.mjs';

function supply(colour: SupplyColour, percent: number | null, description = ''): Supply {
  return {
    index: 1,
    description,
    type: colour === 'waste' ? 'wasteInk' : 'inkCartridge',
    colour,
    percent,
    someRemaining: false,
    isReceptacle: colour === 'waste',
  };
}

function snapshot(overrides: Partial<PrinterSnapshot> = {}): PrinterSnapshot {
  return {
    model: 'EPSON XP-6100 Series',
    name: 'EPSONC618AD',
    serial: 'X5CW048422',
    enterprise: 1248,
    status: 'idle',
    displayText: 'Ready',
    pageCount: 1116,
    errors: [],
    supplies: [],
    ...overrides,
  };
}

describe('planCapabilities', () => {
  it('gives every named colour its own capability', () => {
    const plan = planCapabilities(
      snapshot({
        supplies: [
          supply('photo_black', 52, 'Photo Black Ink Cartridge 202/202XL'),
          supply('black', 20, 'Black Ink Cartridge 202/202XL'),
          supply('cyan', 28, 'Cyan Ink Cartridge 202/202XL'),
          supply('magenta', 37, 'Magenta Ink Cartridge 202/202XL'),
          supply('yellow', 30, 'Yellow Ink Cartridge 202/202XL'),
        ],
      }),
      15,
    );

    assert.deepEqual(plan.capabilities.slice(0, 5), [
      'supply_photo_black', 'supply_black', 'supply_cyan', 'supply_magenta', 'supply_yellow',
    ]);
    assert.equal(plan.values[1]?.value, 20);
    assert.equal(plan.dropped.length, 0);
  });

  it('names each slot after the cartridge the printer asks for', () => {
    const plan = planCapabilities(
      snapshot({ supplies: [supply('black', 20, 'Black Ink Cartridge 202/202XL')] }),
      15,
    );
    assert.equal(plan.titles.get('supply_black'), 'Black Ink Cartridge 202/202XL');
  });

  it('moves a second supply of the same colour to a numbered slot', () => {
    // Two black cartridges must not both write to supply_black, or the second
    // would silently overwrite the first and one of them would vanish.
    const plan = planCapabilities(
      snapshot({ supplies: [supply('black', 80, 'Black A'), supply('black', 10, 'Black B')] }),
      15,
    );

    assert.deepEqual(plan.capabilities.slice(0, 2), ['supply_black', 'supply_other_1']);
    assert.equal(plan.values[0]?.value, 80);
    assert.equal(plan.values[1]?.value, 10);
  });

  it('routes unnamed colours to numbered slots in order', () => {
    const plan = planCapabilities(
      snapshot({ supplies: [supply('other', 90, 'Fuser'), supply('other', 40, 'Drum')] }),
      15,
    );
    assert.deepEqual(plan.capabilities.slice(0, 2), ['supply_other_1', 'supply_other_2']);
  });

  it('reports supplies it had no slot left for instead of dropping them silently', () => {
    const many = Array.from({ length: 6 }, (_, i) => supply('other', 50, `Unit ${i}`));
    const plan = planCapabilities(snapshot({ supplies: many }), 15);

    assert.equal(plan.capabilities.filter((c) => c.startsWith('supply_other_')).length, 4);
    assert.equal(plan.dropped.length, 2);
  });

  it('passes an unknown level through as null rather than zero', () => {
    const plan = planCapabilities(snapshot({ supplies: [supply('black', null, 'Black')] }), 15);
    assert.equal(plan.values[0]?.value, null);
  });

  it('omits the page counter and panel message when the printer has neither', () => {
    const plan = planCapabilities(snapshot({ pageCount: null, displayText: null }), 15);
    assert.ok(!plan.capabilities.includes('printer_pages'));
    assert.ok(!plan.capabilities.includes('printer_message'));
  });

  it('always exposes status and both alarms', () => {
    const plan = planCapabilities(snapshot(), 15);
    for (const id of ['printer_status', 'alarm_printer_error', 'alarm_supply_low']) {
      assert.ok(plan.capabilities.includes(id), `missing ${id}`);
    }
  });
});

describe('isSupplyLow', () => {
  it('fires at or below the threshold', () => {
    assert.equal(isSupplyLow([supply('black', 15)], 15), true);
    assert.equal(isSupplyLow([supply('black', 14)], 15), true);
    assert.equal(isSupplyLow([supply('black', 16)], 15), false);
  });

  it('ignores supplies whose level is unknown', () => {
    // A printer that never reports a level must not ring the alarm forever.
    assert.equal(isSupplyLow([supply('black', null)], 15), false);
  });

  it('counts a nearly-full waste tank, which stops printing just as surely', () => {
    // percent is headroom left, so 5 means the tank is 95 % full.
    assert.equal(isSupplyLow([supply('waste', 5)], 15), true);
  });
});

describe('hasBlockingError', () => {
  it('fires on errors that stop the printer', () => {
    assert.equal(hasBlockingError(['jammed']), true);
    assert.equal(hasBlockingError(['noPaper']), true);
    assert.equal(hasBlockingError(['doorOpen']), true);
  });

  it('ignores advisory flags that the supply alarm already covers', () => {
    // lowToner would otherwise leave the error alarm stuck on for weeks and
    // train the user to ignore it.
    assert.equal(hasBlockingError(['lowToner']), false);
    assert.equal(hasBlockingError(['lowPaper']), false);
  });

  it('is false for no errors at all', () => {
    assert.equal(hasBlockingError([]), false);
  });
});
