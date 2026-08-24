import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RENAMED,
  isLegacyCapability,
  legacyAssignments,
  resolveCapability,
} from '../lib/legacy-capabilities.mjs';
import { assignSupplyCapabilities } from '../lib/supply-capabilities.mjs';
import type { Supply, SupplyColour } from '../lib/printer-mib.mjs';

function supply(colour: SupplyColour, description: string, index: string): Supply {
  return {
    index,
    description,
    type: colour === 'waste' ? 'wasteToner' : 'toner',
    colour,
    percent: 50,
    someRemaining: false,
    isReceptacle: colour === 'waste',
    supplyClass: colour === 'waste' ? 4 : 3,
    level: 50,
    maxCapacity: 100,
    unit: 'percent',
  };
}

describe('recognising the ids this app used before 1.1.0', () => {
  it('knows the named colours, the numbered slots and the two renames', () => {
    for (const id of ['supply_black', 'supply_cyan', 'supply_light_magenta', 'supply_waste']) {
      assert.ok(isLegacyCapability(id), `${id} should be recognised`);
    }
    for (let n = 1; n <= 8; n += 1) {
      assert.ok(isLegacyCapability(`supply_other_${n}`), `supply_other_${n} should be recognised`);
    }
    assert.ok(isLegacyCapability('printer_tray_3'));
    assert.ok(isLegacyCapability('printer_pages'));
    assert.ok(isLegacyCapability('alarm_printer_error'));
    assert.ok(isLegacyCapability('alarm_cover_open'));
  });

  it('does not mistake a current id for an old one', () => {
    // The migration removes everything this returns true for. A false positive
    // here would delete a row the app had just written, every poll, for ever.
    for (const id of [
      'measure_supply.black', 'measure_waste.1_2', 'measure_part.1_5',
      'measure_tray.1', 'meter_pages', 'onoff', 'printer_status',
      'alarm_supply_low', 'alarm_problem', 'alarm_open', 'alarm_paper_low',
      'printer_message', 'printer_alert',
    ]) {
      assert.equal(isLegacyCapability(id), false, `${id} must not be treated as legacy`);
    }
  });

  it('does not claim a slot number the app never issued', () => {
    assert.equal(isLegacyCapability('supply_other_9'), false);
    assert.equal(isLegacyCapability('supply_other_0'), false);
  });
});

describe('resolving an id a Flow is still holding', () => {
  const has = (ids: string[]) => (id: string) => ids.includes(id);

  it('passes a current id straight through', () => {
    assert.equal(resolveCapability('measure_supply.black', has(['measure_supply.black'])), 'measure_supply.black');
  });

  it('follows a rename the name alone determines', () => {
    assert.equal(resolveCapability('supply_black', has(['measure_supply.black'])), 'measure_supply.black');
    assert.equal(resolveCapability('printer_tray_2', has(['measure_tray.2'])), 'measure_tray.2');
    assert.equal(resolveCapability('printer_pages', has(['meter_pages'])), 'meter_pages');
  });

  it('follows a rename only the device could have recorded', () => {
    // supply_other_3 was the third supply without a colour in this printer's
    // table. Nothing about the string says which row that was.
    assert.equal(
      resolveCapability('supply_other_3', has(['measure_part.1_7']), { supply_other_3: 'measure_part.1_7' }),
      'measure_part.1_7',
    );
  });

  it('returns null rather than an id the device does not have', () => {
    // The condition card reads null as "not below". Returning a plausible but
    // absent id would make it read a missing capability instead, which is the
    // same silence by a longer route.
    assert.equal(resolveCapability('supply_black', has([])), null);
    assert.equal(resolveCapability('supply_other_3', has(['measure_part.1_7'])), null);
    assert.equal(resolveCapability('nonsense', has(['measure_supply.black'])), null);
  });

  it('maps every named colour it ever shipped', () => {
    for (const [old, now] of RENAMED) {
      assert.ok(now.length > 0, `${old} maps to nothing`);
      assert.notEqual(old, now);
    }
    assert.equal(RENAMED.size, 13 + 4 + 1 + 2);
  });
});

describe('pairing old rows with new ones during migration', () => {
  /**
   * The Lexmark C3326dw from the forum thread, which is the printer that made
   * the eight-slot ceiling a real problem rather than a theoretical one.
   */
  const lexmark = [
    supply('black', 'Black Cartridge', '1.1'),
    supply('cyan', 'Cyan Cartridge', '1.2'),
    supply('waste', 'Waste Toner Bottle', '1.3'),
    supply('other', 'Photoconductor Unit', '1.4'),
    supply('other', 'Fuser', '1.5'),
  ];

  it('reproduces the ids this printer actually had before the update', () => {
    assert.deepEqual(legacyAssignments(lexmark), [
      'supply_black', 'supply_cyan', 'supply_waste', 'supply_other_1', 'supply_other_2',
    ]);
  });

  it('lines the two lists up row for row, which is what makes the map right', () => {
    const before = legacyAssignments(lexmark);
    const after = assignSupplyCapabilities(lexmark);

    const map: Record<string, string> = {};
    before.forEach((old, i) => {
      if (old !== null) map[old] = after[i]!.capability;
    });

    assert.deepEqual(map, {
      supply_black: 'measure_supply.black',
      supply_cyan: 'measure_supply.cyan',
      supply_waste: 'measure_waste.1_3',
      supply_other_1: 'measure_part.1_4',
      supply_other_2: 'measure_part.1_5',
    });
  });

  it('marks the ninth unnamed supply as having had no slot at all', () => {
    // Nine parts, eight slots. The last one is null because it never existed as
    // a capability, so there is nothing to map and nothing to remove.
    const many = Array.from({ length: 9 }, (_, i) => supply('other', `Unit ${i}`, `1.${i + 1}`));
    const before = legacyAssignments(many);

    assert.equal(before.filter((id) => id !== null).length, 8);
    assert.equal(before[8], null);
  });

  it('gives a second black the numbered slot it used to get', () => {
    const two = [supply('black', 'Black A', '1.1'), supply('black', 'Black B', '1.2')];
    assert.deepEqual(legacyAssignments(two), ['supply_black', 'supply_other_1']);
  });
});
