import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasBlockingError,
  isSupplyLow,
  lowSupplyNames,
  planCapabilities,
} from '../lib/capability-map.mjs';
import type { InputTray, Supply, SupplyColour } from '../lib/printer-mib.mjs';
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
    supplyClass: colour === 'waste' ? 4 : 3,
    level: percent ?? -2,
    maxCapacity: percent === null ? -2 : 100,
    unit: 'percent',
  };
}

function tray(name: string, percent: number | null, media = 'A4'): InputTray {
  return {
    index: '1.1',
    name,
    media,
    level: percent ?? -2,
    maxCapacity: percent === null ? -2 : 100,
    percent,
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
    outputTrays: [],
    inputTrays: [],
    covers: [],
    alerts: [],
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
    const many = Array.from({ length: 10 }, (_, i) => supply('other', 50, `Unit ${i}`));
    const plan = planCapabilities(snapshot({ supplies: many }), 15);

    assert.equal(plan.capabilities.filter((c) => c.startsWith('supply_other_')).length, 8);
    assert.equal(plan.dropped.length, 2);
  });

  it('gives a laser its whole maintenance kit a row each', () => {
    // The reason the slot count went from four to eight: none of these carries a
    // colour, so before the change two of them fell off the end while still
    // being counted by the low-supply alarm.
    const lexmark = [
      supply('black', 40, 'Black Cartridge'),
      supply('waste', 90, 'Waste Toner Bottle'),
      supply('other', 60, 'Photoconductor Unit'),
      supply('other', 70, 'Fuser'),
      supply('other', 80, 'Transfer Module'),
      supply('other', 12, 'Maintenance Kit'),
      supply('other', 95, 'Separator Roller'),
    ];
    const plan = planCapabilities(snapshot({ supplies: lexmark }), 15);

    assert.equal(plan.dropped.length, 0);
    assert.deepEqual(plan.lowSupplies, ['Maintenance Kit']);
  });

  it('gives each paper tray a row named after the tray and its paper', () => {
    const plan = planCapabilities(
      snapshot({ inputTrays: [tray('Tray 1', 80), tray('Multipurpose Feeder', 0, '')] }),
      15,
    );

    assert.deepEqual(plan.capabilities.slice(0, 2), ['printer_tray_1', 'printer_tray_2']);
    assert.equal(plan.values[0]?.value, 80);
    assert.equal(plan.titles.get('printer_tray_1'), 'Tray 1 · A4');
    // No media name means no separator dangling off the end of the title.
    assert.equal(plan.titles.get('printer_tray_2'), 'Multipurpose Feeder');
  });

  it('raises the paper alarm from the printer, not only from a level', () => {
    // A printer with no sheet sensor still raises the bit, and that is the only
    // warning its owner will ever get.
    const plan = planCapabilities(snapshot({ errors: ['lowPaper'] }), 15);
    assert.equal(plan.values.find((v) => v.id === 'alarm_paper_low')?.value, true);
  });

  it('omits the output tray on a printer that cannot sense one', () => {
    const plan = planCapabilities(snapshot(), 15);
    assert.ok(!plan.capabilities.includes('printer_output_tray'));
  });

  it('shows the output tray when the printer reports one', () => {
    const plan = planCapabilities(snapshot({ errors: ['outputNearFull'] }), 15);
    assert.equal(plan.values.find((v) => v.id === 'printer_output_tray')?.value, 'near_full');
  });

  it('omits the cover alarm unless the printer has a cover it can sense', () => {
    const withCover = planCapabilities(
      snapshot({ covers: [{ description: 'Front Door', open: true }] }),
      15,
    );
    assert.equal(withCover.values.find((v) => v.id === 'alarm_cover_open')?.value, true);
    assert.ok(!planCapabilities(snapshot(), 15).capabilities.includes('alarm_cover_open'));
  });

  it('passes the printer’s own alert wording through when there is any', () => {
    const plan = planCapabilities(
      snapshot({
        alerts: [
          { severity: 'warning', code: 1101, group: 9, description: '84 Photoconductor low' },
          { severity: 'warning', code: 1101, group: 9, description: '' },
        ],
      }),
      15,
    );
    assert.equal(plan.values.find((v) => v.id === 'printer_alert')?.value, '84 Photoconductor low');
    assert.ok(!planCapabilities(snapshot(), 15).capabilities.includes('printer_alert'));
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

describe('lowSupplyNames', () => {
  it('names the supply the printer names, so the warning says what to buy', () => {
    assert.deepEqual(
      lowSupplyNames([supply('other', 8, 'Waste Toner Bottle'), supply('black', 60, 'Black')], 15),
      ['Waste Toner Bottle'],
    );
  });

  it('falls back to the colour when the printer gave no description', () => {
    assert.deepEqual(lowSupplyNames([supply('cyan', 3)], 15), ['cyan']);
  });

  it('is empty when nothing is low, so no warning is shown', () => {
    assert.deepEqual(lowSupplyNames([supply('black', 60)], 15), []);
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
