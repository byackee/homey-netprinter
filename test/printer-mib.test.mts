import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyOutputTray,
  classifySupplyColour,
  decodeCoverStatus,
  decodeErrorState,
  decodePrinterStatus,
  decodeSupplyUnit,
  enterpriseNumber,
  inputPercent,
  isCoverOpen,
  isPaperLow,
  isReceptacle,
  outputPercentFree,
  summariseAlerts,
  supplyPercent,
  type InputTray,
  type OutputTray,
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

function outputTray(remaining: number, maxCapacity: number): OutputTray {
  return {
    index: '1.1',
    name: 'Standard Bin',
    remaining,
    maxCapacity,
    percentFree: outputPercentFree(remaining, maxCapacity),
  };
}

function inputTray(level: number, maxCapacity: number): InputTray {
  return {
    index: '1.1',
    name: 'Tray 1',
    media: 'A4',
    level,
    maxCapacity,
    percent: inputPercent(level, maxCapacity),
  };
}

describe('supplyPercent with a unit', () => {
  it('reads a level the printer already gave as a percentage', () => {
    // Several printers report a percentage and leave the capacity at -2. Before
    // the unit column was read, that showed as "unknown" on a printer that had
    // just answered the question outright.
    assert.equal(supplyPercent(45, -2, false, 'percent'), 45);
  });

  it('still refuses to guess when the unit is anything else', () => {
    assert.equal(supplyPercent(45, -2, false, 'impressions'), null);
    assert.equal(supplyPercent(45, -2, false), null);
  });

  it('prefers a real capacity over the unit shortcut', () => {
    assert.equal(supplyPercent(45, 90, false, 'percent'), 50);
  });
});

describe('decodeSupplyUnit', () => {
  it('names the units the settings page has to print', () => {
    assert.equal(decodeSupplyUnit(19), 'percent');
    assert.equal(decodeSupplyUnit(7), 'impressions');
    assert.equal(decodeSupplyUnit(8), 'sheets');
  });

  it('degrades anything it does not know to unknown', () => {
    assert.equal(decodeSupplyUnit(null), 'unknown');
    assert.equal(decodeSupplyUnit(99), 'unknown');
  });
});

describe('outputPercentFree', () => {
  it('reports how much room is left in the bin', () => {
    assert.equal(outputPercentFree(250, 500), 50);
    assert.equal(outputPercentFree(0, 500), 0);
  });

  it('returns null for the sentinels rather than a made-up number', () => {
    assert.equal(outputPercentFree(-3, 500), null);
    assert.equal(outputPercentFree(-2, 500), null);
    assert.equal(outputPercentFree(100, -2), null);
  });
});

describe('classifyOutputTray', () => {
  it('trusts the printer’s own error bits over any sheet count', () => {
    assert.equal(classifyOutputTray([outputTray(500, 500)], ['outputFull']), 'full');
    assert.equal(classifyOutputTray([outputTray(500, 500)], ['outputNearFull']), 'near_full');
  });

  it('maps the remaining capacity onto the three steps printers use', () => {
    assert.equal(classifyOutputTray([outputTray(400, 500)], []), 'ok');
    assert.equal(classifyOutputTray([outputTray(150, 500)], []), 'near_full');
    assert.equal(classifyOutputTray([outputTray(0, 500)], []), 'full');
  });

  it('reports the fullest bin, which is the one to go and empty', () => {
    assert.equal(
      classifyOutputTray([outputTray(450, 500), outputTray(50, 500)], []),
      'near_full',
    );
  });

  it('says unknown rather than ok when nothing can be sensed', () => {
    assert.equal(classifyOutputTray([], []), 'unknown');
    assert.equal(classifyOutputTray([outputTray(-2, -2)], []), 'unknown');
  });

  it('counts "room for at least one more" as a real ok', () => {
    assert.equal(classifyOutputTray([outputTray(-3, -2)], []), 'ok');
  });
});

describe('isPaperLow', () => {
  it('fires on the printer’s own warning even with no level to read', () => {
    assert.equal(isPaperLow([], ['lowPaper'], 15), true);
    assert.equal(isPaperLow([], ['noPaper'], 15), true);
    assert.equal(isPaperLow([], ['inputTrayEmpty'], 15), true);
  });

  it('fires on a tray at or below the threshold', () => {
    assert.equal(isPaperLow([inputTray(10, 100)], [], 15), true);
    assert.equal(isPaperLow([inputTray(40, 100)], [], 15), false);
  });

  it('does not call a tray low just because it cannot be measured', () => {
    // -3 means the tray holds at least one sheet, which is not a warning.
    assert.equal(isPaperLow([inputTray(-3, -2)], [], 15), false);
    assert.equal(isPaperLow([inputTray(-2, -2)], [], 15), false);
  });
});

describe('isCoverOpen', () => {
  it('is open when any door is', () => {
    assert.equal(isCoverOpen([{ description: 'Front Door', open: true }], []), true);
    assert.equal(isCoverOpen([{ description: 'Front Door', open: false }], []), false);
  });

  it('falls back to the error bit for printers with no cover table', () => {
    assert.equal(isCoverOpen([], ['doorOpen']), true);
  });
});

describe('decodeCoverStatus', () => {
  it('treats an open interlock as an open cover, which is what it is', () => {
    assert.equal(decodeCoverStatus(3), true);
    assert.equal(decodeCoverStatus(5), true);
    assert.equal(decodeCoverStatus(4), false);
    assert.equal(decodeCoverStatus(6), false);
  });

  it('assumes closed for codes it does not know', () => {
    assert.equal(decodeCoverStatus(null), false);
    assert.equal(decodeCoverStatus(99), false);
  });
});

describe('summariseAlerts', () => {
  it('joins what the printer said, which is what names the consumable', () => {
    assert.equal(
      summariseAlerts([
        { severity: 'warning', code: 1101, group: 9, description: '84 Photoconductor low' },
        { severity: 'critical', code: 8, group: 5, description: 'Close front door' },
      ]),
      // The critical row leads: it is the one that stopped the printer.
      'Close front door · 84 Photoconductor low',
    );
  });

  it('collapses the duplicates a two-tray printer raises', () => {
    assert.equal(
      summariseAlerts([
        { severity: 'warning', code: 4, group: 5, description: 'Tray 1 empty' },
        { severity: 'warning', code: 4, group: 5, description: 'Tray 1 empty' },
      ]),
      'Tray 1 empty',
    );
  });

  it('is null when the printer sent rows with nothing in them', () => {
    assert.equal(summariseAlerts([]), null);
    assert.equal(
      summariseAlerts([{ severity: 'other', code: null, group: null, description: '  ' }]),
      null,
    );
  });
});

describe('summariseAlerts bounds', () => {
  const alert = (description: string, severity: 'critical' | 'warning' = 'warning') =>
    ({ severity, code: null, group: null, description });

  it('puts what stops the printer first', () => {
    assert.equal(
      summariseAlerts([alert('Toner low'), alert('Paper jam', 'critical')]),
      'Paper jam · Toner low',
    );
  });

  it('does not turn a tile into a paragraph', () => {
    const many = Array.from({ length: 12 }, (_, i) => alert(`Alert number ${i}`));
    const summary = summariseAlerts(many);
    assert.ok(summary !== null);
    assert.equal(summary.split(' · ').length, 5);
  });

  it('truncates rather than emitting an unbounded string', () => {
    const summary = summariseAlerts([alert('x'.repeat(400))]);
    assert.ok(summary !== null);
    assert.ok(summary.length <= 200);
    assert.ok(summary.endsWith('…'));
  });
});
