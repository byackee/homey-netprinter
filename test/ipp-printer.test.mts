import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IppAttributes, IppValue } from '../lib/ipp-client.mjs';
import type { Supply } from '../lib/printer-mib.mjs';
import {
  colourNameFor,
  fillFromIpp,
  ippErrorFlags,
  ippInputTrays,
  ippReading,
  ippSerial,
  ippStatus,
  ippSupplies,
  normaliseSupplyType,
  parseDeviceId,
  parsePacked,
} from '../lib/ipp-printer.mjs';

const attrs = (entries: Record<string, IppValue[]>): IppAttributes => new Map(Object.entries(entries));

/** A standard-table row that came back without a number, as the MIB would give it. */
const blank = (index: string, colour: Supply['colour'], level = -3): Supply => ({
  index,
  description: `${colour} cartridge`,
  type: 'inkCartridge',
  colour,
  percent: null,
  someRemaining: level === -3,
  isReceptacle: false,
  level,
  maxCapacity: -2,
  unit: 'tenthsOfGrams',
  supplyClass: 4,
});

describe('parsePacked', () => {
  it('splits a PWG packed string into its fields', () => {
    const fields = parsePacked('type=toner;maxcapacity=100;level=92;colorantname=black;');
    assert.equal(fields.get('type'), 'toner');
    assert.equal(fields.get('level'), '92');
    assert.equal(fields.get('colorantname'), 'black');
  });

  it('ignores a fragment that is not a field', () => {
    assert.equal(parsePacked('nonsense;level=5;').get('level'), '5');
    assert.equal(parsePacked('nonsense;level=5;').size, 1);
  });
});

describe('parseDeviceId', () => {
  it('reads the colon-separated form, which is not the packed one', () => {
    const fields = parseDeviceId('MFG:Canon;CMD:URF,PWGRaster;MDL:PRO-1000S;SN:ABC123;');
    assert.equal(fields.get('mfg'), 'Canon');
    assert.equal(fields.get('mdl'), 'PRO-1000S');
    assert.equal(fields.get('sn'), 'ABC123');
  });
});

describe('colourNameFor', () => {
  it('turns the hex a printer sends into the word the classifier reads', () => {
    assert.equal(colourNameFor('#000000'), 'black');
    assert.equal(colourNameFor('#00FFFF'), 'cyan');
  });

  it('passes a word through unchanged', () => {
    assert.equal(colourNameFor('black'), 'black');
  });

  it('gives nothing for a colour it cannot name, rather than a wrong one', () => {
    assert.equal(colourNameFor('#123456'), null);
    assert.equal(colourNameFor('none'), null);
    assert.equal(colourNameFor(''), null);
  });
});

describe('normaliseSupplyType', () => {
  it('reconciles IPP hyphens with the MIB house style', () => {
    assert.equal(normaliseSupplyType('ink-cartridge'), 'inkCartridge');
    assert.equal(normaliseSupplyType('toner'), 'toner');
  });

  it('keeps a keyword it does not recognise, rather than flattening it to other', () => {
    assert.equal(normaliseSupplyType('chromaOptimizer'), 'chromaOptimizer');
  });
});

describe('ippSupplies', () => {
  it('reads the marker attributes, matched by position', () => {
    const supplies = ippSupplies(attrs({
      'marker-names': ['Black', 'Cyan'],
      'marker-levels': [92, 44],
      'marker-colors': ['#000000', '#00FFFF'],
      'marker-types': ['ink-cartridge', 'ink-cartridge'],
      'marker-high-levels': [100, 100],
    }));

    assert.equal(supplies.length, 2);
    assert.equal(supplies[0].colour, 'black');
    assert.equal(supplies[0].percent, 92);
    assert.equal(supplies[0].type, 'inkCartridge');
    assert.equal(supplies[0].ippSourced, true);
    assert.equal(supplies[1].colour, 'cyan');
    assert.equal(supplies[1].percent, 44);
  });

  it('keeps the printer\'s sentinels meaning what they mean', () => {
    const supplies = ippSupplies(attrs({
      'marker-names': ['Black', 'Cyan'],
      'marker-levels': [-3, -2],
      'marker-types': ['toner', 'toner'],
    }));

    assert.equal(supplies[0].percent, null, '-3 is "some left", not a number');
    assert.equal(supplies[0].someRemaining, true);
    assert.equal(supplies[1].percent, null, '-2 is "I cannot tell you"');
    assert.equal(supplies[1].someRemaining, false);
  });

  it('unpacks names a printer crammed into one comma-separated value', () => {
    const supplies = ippSupplies(attrs({
      'marker-names': ['Black,Cyan,Magenta,Yellow'],
      'marker-levels': [10, 20, 30, 40],
      'marker-types': ['toner'],
    }));

    assert.equal(supplies.length, 4);
    assert.equal(supplies[0].description, 'Black');
    assert.equal(supplies[3].description, 'Yellow');
    assert.equal(supplies[3].colour, 'yellow');
  });

  it('falls back to the PWG packed form when there are no markers', () => {
    const supplies = ippSupplies(attrs({
      'printer-supply': [
        Buffer.from('type=toner;maxcapacity=100;level=92;colorantname=black;'),
        Buffer.from('type=wasteToner;maxcapacity=100;level=8;colorantname=none;'),
      ],
      'printer-supply-description': ['Black Toner', 'Waste Toner Box'],
    }));

    assert.equal(supplies.length, 2);
    assert.equal(supplies[0].percent, 92);
    assert.equal(supplies[0].colour, 'black');
    assert.equal(supplies[1].isReceptacle, true, 'a waste box fills rather than drains');
  });

  it('prefers the markers when a printer answers both', () => {
    const supplies = ippSupplies(attrs({
      'marker-names': ['Black'],
      'marker-levels': [92],
      'marker-types': ['toner'],
      'printer-supply': [Buffer.from('type=toner;level=11;colorantname=black;')],
    }));
    assert.equal(supplies.length, 1);
    assert.equal(supplies[0].percent, 92);
  });

  it('says nothing at all when the printer describes no supplies', () => {
    assert.deepEqual(ippSupplies(attrs({ 'printer-state': [3] })), []);
  });
});

describe('ippInputTrays', () => {
  it('reads a packed tray, and does not invent a media name', () => {
    const trays = ippInputTrays(attrs({
      'printer-input-tray': [
        Buffer.from('type=sheetFeedAutoRemovableTray;mediafeed=29700;maxcapacity=250;level=125;status=0;name=Tray 1;'),
      ],
    }));

    assert.equal(trays.length, 1);
    assert.equal(trays[0].name, 'Tray 1');
    assert.equal(trays[0].percent, 50);
    assert.equal(trays[0].media, '');
  });
});

describe('ippStatus', () => {
  it('maps the three states IPP has', () => {
    assert.equal(ippStatus(attrs({ 'printer-state': [3] })), 'idle');
    assert.equal(ippStatus(attrs({ 'printer-state': [4] })), 'printing');
    assert.equal(ippStatus(attrs({ 'printer-state': [5] })), 'other');
  });

  it('reads the reasons for the distinctions the enum does not draw', () => {
    assert.equal(ippStatus(attrs({ 'printer-state': [5], 'printer-state-reasons': ['shutdown'] })), 'offline');
    assert.equal(ippStatus(attrs({ 'printer-state': [3], 'printer-state-reasons': ['warming-up'] })), 'warmup');
  });

  it('is unknown when the printer said nothing, not idle', () => {
    assert.equal(ippStatus(attrs({})), 'unknown');
  });
});

describe('ippSerial', () => {
  it('digs the serial out of the device id', () => {
    assert.equal(ippSerial(attrs({
      'printer-device-id': ['MFG:Canon;CMD:URF;MDL:PRO-1000S;SN:ABC123;'],
    })), 'ABC123');
  });

  it('gives null rather than a wrong identity when there is none', () => {
    assert.equal(ippSerial(attrs({ 'printer-device-id': ['MFG:Canon;MDL:PRO-1000S;'] })), null);
    assert.equal(ippSerial(attrs({})), null);
  });
});

describe('firmware over IPP', () => {
  /**
   * The one source for a firmware version that belongs to no brand: IPP defines
   * the attribute, so a printer whose manufacturer we have no OID for can still
   * answer it.
   */
  it('reads printer-firmware-string-version', () => {
    const reading = ippReading(attrs({ 'printer-firmware-string-version': ['1.20'] }));
    assert.equal(reading.firmware, '1.20');
  });

  it('leaves it null when the printer does not publish one', () => {
    assert.equal(ippReading(attrs({ 'printer-name': ['MFC'] })).firmware, null);
  });
});

describe('ippReading', () => {
  it('assembles what a Canon-shaped reply carries', () => {
    const reading = ippReading(attrs({
      'printer-make-and-model': ['Canon PRO-1000S'],
      'printer-device-id': ['MFG:Canon;MDL:PRO-1000S;SN:XY99;'],
      'printer-state': [3],
      'printer-state-reasons': ['none'],
      'marker-names': ['Photo Black', 'Chroma Optimizer'],
      'marker-levels': [78, 55],
      'marker-types': ['ink-cartridge', 'ink-cartridge'],
    }));

    assert.equal(reading.model, 'Canon PRO-1000S');
    assert.equal(reading.serial, 'XY99');
    assert.equal(reading.status, 'idle');
    assert.deepEqual(reading.stateReasons, [], '"none" is not a reason');
    assert.equal(reading.supplies[0].colour, 'photo_black');
    assert.equal(reading.supplies[1].percent, 55);
  });
});

describe('fillFromIpp', () => {
  it('fills a row the standard table refused to number', () => {
    const supplies = [blank('1.1', 'black')];
    const filled = fillFromIpp(supplies, ippSupplies(attrs({
      'marker-names': ['Black'],
      'marker-levels': [92],
      'marker-types': ['toner'],
    })));

    assert.deepEqual(filled, ['1.1']);
    assert.equal(supplies[0].percent, 92);
    assert.equal(supplies[0].ippSourced, true);
    assert.equal(supplies[0].level, -3, 'what the standard table sent is still on the record');
  });

  it('never overrides a number the standard table already gave', () => {
    const supplies = [{ ...blank('1.1', 'black'), percent: 40, level: 40 }];
    assert.deepEqual(fillFromIpp(supplies, ippSupplies(attrs({
      'marker-names': ['Black'],
      'marker-levels': [92],
      'marker-types': ['toner'],
    }))), []);
    assert.equal(supplies[0].percent, 40);
    assert.equal(supplies[0].ippSourced, undefined);
  });

  it('drops an ambiguous match rather than guessing which black is which', () => {
    const supplies = [blank('1.1', 'black'), blank('1.2', 'black')];
    const filled = fillFromIpp(supplies, ippSupplies(attrs({
      'marker-names': ['Black', 'Black'],
      'marker-levels': [92, 44],
      'marker-types': ['toner', 'toner'],
    })));

    assert.deepEqual(filled, []);
    assert.equal(supplies[0].percent, null);
  });

  it('will not put a cartridge level on a waste box', () => {
    const waste = { ...blank('1.5', 'waste'), isReceptacle: true };
    assert.deepEqual(fillFromIpp([waste], ippSupplies(attrs({
      'marker-names': ['Black'],
      'marker-levels': [92],
      'marker-types': ['toner'],
    }))), []);
  });

  it('offers nothing when IPP could not number it either', () => {
    const supplies = [blank('1.1', 'black')];
    assert.deepEqual(fillFromIpp(supplies, ippSupplies(attrs({
      'marker-names': ['Black'],
      'marker-levels': [-2],
      'marker-types': ['toner'],
    }))), []);
    assert.equal(supplies[0].percent, null);
  });
});

describe('ippErrorFlags', () => {
  it('reads the printer\'s own reasons as the flags this app already has', () => {
    assert.deepEqual(ippErrorFlags(['media-empty', 'cover-open']).sort(), ['doorOpen', 'noPaper']);
    assert.deepEqual(ippErrorFlags(['marker-supply-low']), ['lowToner']);
    assert.deepEqual(ippErrorFlags(['media-jam']), ['jammed']);
  });

  it('ignores the qualifier, which says how bad it is and not what it is', () => {
    assert.deepEqual(ippErrorFlags(['media-empty-warning']), ['noPaper']);
    assert.deepEqual(ippErrorFlags(['cover-open-report']), ['doorOpen']);
  });

  it('says nothing for "none", which is a printer reporting that all is well', () => {
    assert.deepEqual(ippErrorFlags(['none']), []);
    assert.deepEqual(ippErrorFlags([]), []);
  });

  it('drops a reason it has no flag for rather than forcing it onto the nearest one', () => {
    assert.deepEqual(ippErrorFlags(['connecting-to-device', 'developer-low']), []);
  });

  it('does not repeat a flag two reasons both point at', () => {
    assert.deepEqual(ippErrorFlags(['media-empty', 'media-needed']), ['noPaper']);
  });
});
