import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasBlockingError,
  isSupplyLow,
  lowSupplyNames,
  planCapabilities,
  shortTitle,
} from '../lib/capability-map.mjs';
import type { InputTray, Supply, SupplyColour } from '../lib/printer-mib.mjs';
import type { PrinterSnapshot } from '../lib/printer-reader.mjs';

function supply(
  colour: SupplyColour,
  percent: number | null,
  description = '',
  // The printer's own table index, which names the sub-capability for anything
  // without a colour. Distinct per row, exactly as a real printer reports it.
  index = '1.1',
): Supply {
  return {
    index,
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

function tray(name: string, percent: number | null, media = 'A4', type = 'sheetFeedAutoRemovableTray'): InputTray {
  return {
    index: '1.1',
    name,
    media,
    type,
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
    alertsRead: true,
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
      'measure_supply.photo_black', 'measure_supply.black', 'measure_supply.cyan',
      'measure_supply.magenta', 'measure_supply.yellow',
    ]);
    assert.equal(plan.values[1]?.value, 20);
  });

  it('names each slot after the cartridge the printer asks for', () => {
    const plan = planCapabilities(
      snapshot({ supplies: [supply('black', 20, 'Black Ink Cartridge 202/202XL')] }),
      15,
    );
    assert.equal(plan.titles.get('measure_supply.black'), 'Black Ink Cartridge 202/202XL');
  });

  it('keeps a second supply of the same colour off the first one', () => {
    // Two black cartridges must not both write to measure_supply.black, or the
    // second would silently overwrite the first and one of them would vanish.
    const plan = planCapabilities(
      snapshot({
        supplies: [
          supply('black', 80, 'Black A', '1.1'),
          supply('black', 10, 'Black B', '1.2'),
        ],
      }),
      15,
    );

    assert.deepEqual(plan.capabilities.slice(0, 2), [
      'measure_supply.black', 'measure_supply.black_1_2',
    ]);
    assert.equal(plan.values[0]?.value, 80);
    assert.equal(plan.values[1]?.value, 10);
  });

  it('puts an unnamed part on its own row, keyed by the printer\u2019s index', () => {
    const plan = planCapabilities(
      snapshot({
        supplies: [
          supply('other', 90, 'Fuser', '1.4'),
          supply('other', 40, 'Drum', '1.7'),
        ],
      }),
      15,
    );
    assert.deepEqual(plan.capabilities.slice(0, 2), ['measure_part.1_4', 'measure_part.1_7']);
  });

  it('has no ceiling: every supply gets a row, however many there are', () => {
    // The whole reason for the change. Eight numbered slots meant a printer
    // reporting a ninth consumable had it dropped on the floor — while the
    // low-supply alarm still counted it, so the alarm could fire for a part the
    // user had no row for.
    const many = Array.from({ length: 20 }, (_, i) => supply('other', 50, `Unit ${i}`, `1.${i + 1}`));
    const plan = planCapabilities(snapshot({ supplies: many }), 15);

    assert.equal(plan.capabilities.filter((c) => c.startsWith('measure_part.')).length, 20);
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

    assert.equal(plan.capabilities.filter((c) => c.startsWith('measure_')).length, 7);
    assert.deepEqual(plan.lowSupplies, ['Maintenance Kit']);
  });

  it('gives each paper tray a row named after the tray and its paper', () => {
    const plan = planCapabilities(
      snapshot({ inputTrays: [tray('Tray 1', 80), tray('Multipurpose Feeder', 0, '')] }),
      15,
    );

    assert.deepEqual(plan.capabilities.slice(0, 2), ['measure_tray.1', 'measure_tray.2']);
    assert.equal(plan.values[0]?.value, 80);
    assert.equal(plan.titles.get('measure_tray.1'), 'Tray 1 · A4');
    // No media name means no separator dangling off the end of the title.
    assert.equal(plan.titles.get('measure_tray.2'), 'Multipurpose Feeder');
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

  it('clears an alert the printer has stopped raising', () => {
    // A user watched "Tray 1 Missing" sit in this capability for hours after
    // the tray was back, because an empty alert list skipped the write.
    const plan = planCapabilities(snapshot({ alerts: [], alertsRead: true }), 15);
    const alert = plan.values.find((v) => v.id === 'printer_alert');

    assert.equal(alert?.value, null, 'an answered, empty alert table must clear the row');
    assert.ok(!plan.capabilities.includes('printer_alert'));
  });

  it('leaves the alert alone when the walk did not answer', () => {
    // A failed walk is not an empty one. Blanking on a missed read would make
    // the capability flicker every time the printer declines to answer once.
    const plan = planCapabilities(snapshot({ alerts: [], alertsRead: false }), 15);
    assert.ok(!plan.values.some((v) => v.id === 'printer_alert'));
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

  it('clears a panel message the printer has stopped reporting', () => {
    // A user's Lexmark kept showing "Tray 1 Missing" after the tray was back,
    // because a null message skipped the write instead of blanking the tile.
    const plan = planCapabilities(snapshot({ displayText: null }), 15);
    const message = plan.values.find((v) => v.id === 'printer_message');

    assert.equal(message?.value, null, 'the message must be written, not skipped');
    // Still no row for a printer that has never reported one.
    assert.ok(!plan.capabilities.includes('printer_message'));
  });

  it('keeps writing the panel message while the printer reports one', () => {
    const plan = planCapabilities(snapshot({ displayText: 'Ready' }), 15);
    assert.equal(plan.values.find((v) => v.id === 'printer_message')?.value, 'Ready');
    assert.ok(plan.capabilities.includes('printer_message'));
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

describe('the Lexmark C3326dw that reported this', () => {
  /** Every row exactly as the printer's own diagnostics showed it. */
  function c3326dw(): PrinterSnapshot {
    const impressions = (
      description: string, colour: SupplyColour, level: number, max: number, index = '1.1',
    ): Supply => ({
      index,
      description,
      type: colour === 'waste' ? 'wasteToner' : 'toner',
      colour,
      percent: Math.round((level / max) * 100),
      someRemaining: false,
      isReceptacle: colour === 'waste',
      supplyClass: colour === 'waste' ? 4 : 3,
      level,
      maxCapacity: max,
      unit: 'impressions',
    });

    return snapshot({
      model: 'Lexmark C3326dw',
      displayText: 'Gereed',
      pageCount: 1027,
      supplies: [
        impressions('Black Cartridge', 'black', 2430, 3000),
        impressions('Cyan Cartridge', 'cyan', 2000, 2500),
        impressions('Fuser', 'other', 50000, 50000),
        impressions('Transfer Module', 'other', 50000, 50000),
        impressions('Magenta Cartridge', 'magenta', 2075, 2500),
        impressions('Waste Toner Bottle', 'waste', 15000, 15000),
        impressions('Yellow Cartridge', 'yellow', 2150, 2500),
      ],
      inputTrays: [
        tray('Manual Envelope', 0, 'iso-designated-long-envelope', 'sheetFeedManual'),
        tray('Manual Paper', 0, 'iso-a5-white', 'sheetFeedManual'),
        tray('Tray 1', 100, 'iso-a4-white'),
      ],
    });
  }

  it('leaves the waste bottle at 100 %, because it is new', () => {
    const plan = planCapabilities(c3326dw(), 15);
    assert.equal(plan.values.find((v) => v.id.startsWith('measure_waste.'))?.value, 100);
  });

  it('raises neither alarm on a printer with nothing wrong', () => {
    const plan = planCapabilities(c3326dw(), 15);
    assert.equal(plan.values.find((v) => v.id === 'alarm_supply_low')?.value, false);
    assert.equal(plan.values.find((v) => v.id === 'alarm_paper_low')?.value, false);
    assert.deepEqual(plan.lowSupplies, []);
  });

  it('still names a genuinely empty cassette in the warning', () => {
    const empty = c3326dw();
    empty.inputTrays[2] = tray('Tray 1', 4, 'iso-a4-white');
    const plan = planCapabilities(empty, 15);

    assert.equal(plan.values.find((v) => v.id === 'alarm_paper_low')?.value, true);
    assert.deepEqual(plan.lowSupplies, ['Tray 1 · iso-a4-white']);
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

describe('the responding capability', () => {
  it('is on whenever a read succeeded', () => {
    // Reaching planCapabilities at all means the printer answered.
    const plan = planCapabilities(snapshot(), 15);
    assert.equal(plan.values.find((v) => v.id === 'onoff')?.value, true);
    assert.ok(plan.capabilities.includes('onoff'));
  });
});

describe('shortTitle', () => {
  /**
   * Homey asks for a capability title of two or three words: it sits beside a
   * value on a narrow row, and the UI cuts a long one off wherever it lands.
   * The printer's own wording is what we put there, and printers are not
   * bound by that — a Lexmark answers with its model and yield class in the
   * same string.
   */
  it('leaves a title that already fits exactly as it is', () => {
    assert.equal(shortTitle('Waste Toner Bottle'), 'Waste Toner Bottle');
    // Four words, and the last one is the part number to reorder. The budget
    // exists to bound the row, not to enforce a word count that would throw
    // away the most useful half of a real Epson title.
    assert.equal(shortTitle('Black Ink Cartridge 202/202XL'), 'Black Ink Cartridge 202/202XL');
  });

  it('keeps whole words rather than severing one', () => {
    const title = shortTitle('Lexmark C3326 Cyan Toner Cartridge High Yield');
    assert.ok(title.length <= 32, `too long: ${title}`);
    assert.equal(title, 'Lexmark C3326 Cyan Toner');
    assert.ok(!title.endsWith(' '), 'left a trailing space');
  });

  it('cuts a single overlong word, since there is no word boundary to use', () => {
    const title = shortTitle('Photoconductorunitreplacementkitblack');
    assert.ok(title.length <= 32, `too long: ${title}`);
    assert.ok(title.endsWith('\u2026'), 'a severed word should say so');
  });

  it('collapses the whitespace printers pad their strings with', () => {
    assert.equal(shortTitle('  Cyan   Cartridge \n'), 'Cyan Cartridge');
  });

  it('is applied to the titles the plan hands to Homey', () => {
    const plan = planCapabilities(snapshot({
      supplies: [supply('cyan', 50, 'Lexmark C3326 Cyan Toner Cartridge High Yield')],
    }), 15);
    assert.equal(plan.titles.get('measure_supply.cyan'), 'Lexmark C3326 Cyan Toner');
  });
});
