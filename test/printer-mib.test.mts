import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifySupplyColour,
  decodeErrorState,
  decodePrinterStatus,
  enterpriseNumber,
  isReceptacle,
  supplyPercent,
} from '../lib/printer-mib.mjs';

describe('supplyPercent', () => {
  it('scales a level against its capacity', () => {
    assert.equal(supplyPercent(20, 100, false), 20);
    assert.equal(supplyPercent(3, 6, false), 50);
  });

  it('returns null for every Printer-MIB sentinel rather than a negative percentage', () => {
    // -1 other, -2 unknown, -3 someRemaining. Showing these as numbers would put
    // "-2 %" in the UI; showing them as 0 would raise a false empty alarm.
    assert.equal(supplyPercent(-1, 100, false), null);
    assert.equal(supplyPercent(-2, 100, false), null);
    assert.equal(supplyPercent(-3, 100, false), null);
  });

  it('returns null when the capacity gives no scale to divide by', () => {
    assert.equal(supplyPercent(50, -2, false), null);
    assert.equal(supplyPercent(50, 0, false), null);
  });

  it('inverts a receptacle, because it fills up instead of draining', () => {
    // A waste tank at 90 % full has 10 % of headroom left.
    assert.equal(supplyPercent(90, 100, true), 10);
    assert.equal(supplyPercent(0, 100, true), 100);
  });

  it('keeps a full cartridge at 100 rather than overshooting', () => {
    assert.equal(supplyPercent(120, 100, false), 100);
  });

  it('reports a genuinely empty cartridge as 0, not unknown', () => {
    assert.equal(supplyPercent(0, 100, false), 0);
  });
});

describe('decodeErrorState', () => {
  it('treats an empty buffer as no errors, not as missing data', () => {
    assert.deepEqual(decodeErrorState(Buffer.from([])), []);
    assert.deepEqual(decodeErrorState(Buffer.from([0x00])), []);
  });

  it('returns null-safe empty for an absent value', () => {
    assert.deepEqual(decodeErrorState(null), []);
  });

  it('decodes the high bit of byte 0 as lowPaper', () => {
    assert.deepEqual(decodeErrorState(Buffer.from([0x80])), ['lowPaper']);
  });

  it('decodes jammed and offline together', () => {
    // bit 5 = jammed (0x04), bit 6 = offline (0x02)
    assert.deepEqual(decodeErrorState(Buffer.from([0x06])), ['jammed', 'offline']);
  });

  it('reads flags in the second byte', () => {
    // byte 1 bit 0 = inputTrayMissing
    assert.deepEqual(decodeErrorState(Buffer.from([0x00, 0x80])), ['inputTrayMissing']);
  });

  it('stops cleanly when the printer sends a shorter string than the bit list', () => {
    // One byte can only carry the first eight flags; nothing after may be invented.
    const flags = decodeErrorState(Buffer.from([0xff]));
    assert.equal(flags.length, 8);
    assert.ok(!flags.includes('inputTrayMissing'));
  });
});

describe('classifySupplyColour', () => {
  it('prefers photo black over black, which it contains', () => {
    assert.equal(classifySupplyColour('Photo Black Ink Cartridge 202/202XL', 'black', 'inkCartridge'), 'photo_black');
  });

  it('still recognises plain black', () => {
    assert.equal(classifySupplyColour('Black Ink Cartridge 202/202XL', 'black', 'inkCartridge'), 'black');
  });

  it('prefers light cyan over cyan', () => {
    assert.equal(classifySupplyColour('Light Cyan T0805', null, 'inkCartridge'), 'light_cyan');
  });

  it('falls back to the colorant when the description is unhelpful', () => {
    assert.equal(classifySupplyColour('Cartridge 1', 'magenta', 'inkCartridge'), 'magenta');
  });

  it('classifies any waste type as waste regardless of wording', () => {
    assert.equal(classifySupplyColour('Maintenance Box', null, 'wasteInk'), 'waste');
    assert.equal(classifySupplyColour('Waste Toner Bottle', 'black', 'wasteToner'), 'waste');
  });

  it('returns other when nothing identifies a colour', () => {
    assert.equal(classifySupplyColour('Fuser Unit', null, 'fuser'), 'other');
  });
});

describe('isReceptacle', () => {
  it('trusts the class when the printer sets it', () => {
    assert.equal(isReceptacle(4, 'inkCartridge'), true);
    assert.equal(isReceptacle(3, 'inkCartridge'), false);
  });

  it('falls back to the type for printers that leave the class at other', () => {
    assert.equal(isReceptacle(1, 'wasteInk'), true);
    assert.equal(isReceptacle(null, 'wasteToner'), true);
  });
});

describe('enterpriseNumber', () => {
  it('extracts the vendor number from a sysObjectID', () => {
    // The real value read from an Epson XP-6100.
    assert.equal(enterpriseNumber('1.3.6.1.4.1.1248.1.1.2.1.3.5.69.69.80.83.50'), 1248);
    assert.equal(enterpriseNumber('1.3.6.1.4.1.11.2.3.9.1'), 11);
  });

  it('tolerates a leading dot', () => {
    assert.equal(enterpriseNumber('.1.3.6.1.4.1.2435.2.3.9.1'), 2435);
  });

  it('returns null for anything that is not an enterprise OID', () => {
    assert.equal(enterpriseNumber(null), null);
    assert.equal(enterpriseNumber('1.3.6.1.2.1.1.1.0'), null);
  });
});

describe('decodePrinterStatus', () => {
  it('maps the RFC 2790 enumeration', () => {
    assert.equal(decodePrinterStatus(3), 'idle');
    assert.equal(decodePrinterStatus(4), 'printing');
    assert.equal(decodePrinterStatus(5), 'warmup');
  });

  it('degrades an unknown or absent code to unknown', () => {
    assert.equal(decodePrinterStatus(99), 'unknown');
    assert.equal(decodePrinterStatus(null), 'unknown');
  });
});
