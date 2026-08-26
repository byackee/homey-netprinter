import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BROTHER_OID,
  decodeBrotherBlob,
  decodeBrotherReading,
  isLegacyBlob,
  modelName,
  printerKindFrom,
  supplyKind,
  targetOf,
  vendorPercentFor,
  type MatchableSupply,
} from '../lib/vendors/brother.mjs';

/**
 * The maintenance blob bieniu/brother documents in its own source, byte for
 * byte. Using their worked example rather than one of ours is the point: it is
 * the only sample here whose expected output was established by someone with a
 * Brother in front of them.
 *
 * Entries: drum status 1, drum counter 0x52c, drum remaining 0x22c4, black toner
 * status 1, black toner remaining 0x1900, black toner 0x46, and an `86` that no
 * laser map claims.
 */
const HA_MAINTENANCE =
  '630104000000011101040000052c410104000022c4310104000000016f010400001900810104000000468601040000000a';

/** The laser marker map, reached through the same door the reader uses. */
function laser(hex: string) {
  return decodeBrotherBlob(hex, LASER_MARKERS);
}

// Rebuilt from the public target lookup so the test does not reach into the
// module's private map: every marker the reader can act on, and nothing else.
const LASER_MARKERS: Record<string, { key: string; percent: boolean }> = {
  '11': { key: 'drum_counter', percent: false },
  '31': { key: 'black_toner_status', percent: false },
  '41': { key: 'drum_remaining_life', percent: true },
  '63': { key: 'drum_status', percent: false },
  '6f': { key: 'black_toner_remaining', percent: true },
  '81': { key: 'black_toner', percent: false },
  a1: { key: 'black_toner_remaining', percent: true },
};

describe('decodeBrotherBlob', () => {
  it("reads Home Assistant's own worked example to the same numbers", () => {
    const values = laser(HA_MAINTENANCE);
    const byKey = Object.fromEntries(values.map((v) => [v.key, v.value]));

    assert.equal(byKey.drum_status, 1);
    assert.equal(byKey.drum_counter, 0x52c);
    // 0x22c4 is 8900, which is 89 % — the scale is a hundredth of a percent.
    assert.equal(byKey.drum_remaining_life, 89);
    assert.equal(byKey.black_toner_status, 1);
    assert.equal(byKey.black_toner_remaining, 64);
    assert.equal(byKey.black_toner, 0x46);
  });

  it('skips markers it does not recognise rather than guessing at them', () => {
    const values = laser(HA_MAINTENANCE);
    // The trailing `86` entry is real data this map has no meaning for.
    assert.ok(!values.some((v) => v.marker === '86'));
  });

  it('refuses a percentage outside 0-100, which is a sentinel and not a level', () => {
    // 0xFFFFFFFF / 100 is nowhere near a percentage; reporting it as one would
    // put a confident, meaningless number in front of a user.
    assert.deepEqual(laser('6f0104ffffffff'), []);
  });

  it('reads the value as big-endian across all four bytes', () => {
    // 0x00023F80 is 147328; a decoder that only read the last two bytes would
    // land on 0x3F80 and report 163 instead.
    assert.deepEqual(laser('11010400023f80'), [
      { key: 'drum_counter', value: 147328, isPercent: false, marker: '11' },
    ]);
  });

  it('reads the later a1 marker as the same black toner reading as 6f', () => {
    assert.deepEqual(laser('a1010400002328'), [
      { key: 'black_toner_remaining', value: 90, isPercent: true, marker: 'a1' },
    ]);
  });

  it('ignores a trailing partial entry instead of decoding a truncated value', () => {
    const values = laser(`${HA_MAINTENANCE}6f0104`);
    assert.equal(values.filter((v) => v.key === 'black_toner_remaining').length, 1);
  });
});

describe('isLegacyBlob', () => {
  it('recognises the five-byte layout by its fixed denominator', () => {
    // Four entries, each ending in the 0x14 scale.
    assert.equal(isLegacyBlob('a101020414a201020c14a301020614a401020b14'), true);
  });

  it('does not mistake a modern blob for a legacy one', () => {
    assert.equal(isLegacyBlob(HA_MAINTENANCE), false);
  });

  it('rejects a length that is not a whole number of legacy entries', () => {
    assert.equal(isLegacyBlob('a1010204'), false);
  });
});

describe('decodeBrotherBlob, legacy layout', () => {
  it('reads a legacy entry as current over maximum', () => {
    // 0x04 of 0x14 is 4 of 20, which is 20 %.
    const values = decodeBrotherBlob('a101020414a201020c14a301020614a401020b14', {
      a1: { key: 'black_ink_remaining', percent: true },
      a2: { key: 'cyan_ink_remaining', percent: true },
    } as never);

    assert.deepEqual(values, [
      { key: 'black_ink_remaining', value: 20, isPercent: true, marker: 'a1' },
      // 0x0c of 0x14 is 12 of 20, which is 60 %.
      { key: 'cyan_ink_remaining', value: 60, isPercent: true, marker: 'a2' },
    ]);
  });
});

describe('printerKindFrom', () => {
  it('calls a printer with toner a laser', () => {
    assert.equal(printerKindFrom(['toner', 'opc']), 'laser');
  });

  it('calls a printer with ink cartridges an inkjet', () => {
    assert.equal(printerKindFrom(['inkCartridge', 'wasteInk']), 'ink');
  });

  it('falls back to laser when the table says neither, because the colour markers agree anyway', () => {
    assert.equal(printerKindFrom(['unknown']), 'laser');
  });
});

describe('supplyKind', () => {
  it('reads the family off the declared type first', () => {
    assert.equal(supplyKind('toner', 'Black Toner Cartridge'), 'marker');
    assert.equal(supplyKind('opc', 'Drum Unit'), 'drum');
    assert.equal(supplyKind('transferUnit', 'Belt Unit'), 'belt');
  });

  it('falls back to the description for the parts the MIB has no type for', () => {
    assert.equal(supplyKind('unknown', 'Laser Unit'), 'laser');
    assert.equal(supplyKind('unknown', 'PF Kit MP'), 'pf_kit');
    assert.equal(supplyKind('unknown', 'Drum Unit'), 'drum');
  });
});

describe('targetOf', () => {
  it('places a black toner reading on a black marker row', () => {
    assert.deepEqual(targetOf('black_toner_remaining', 'laser'), { colour: 'black', kind: 'marker' });
  });

  it('leaves the single drum colourless, because there is only one of it', () => {
    assert.deepEqual(targetOf('drum_remaining_life', 'laser'), { colour: null, kind: 'drum' });
  });

  it('has no target for a counter, which is not a level', () => {
    assert.equal(targetOf('black_toner', 'laser'), null);
  });
});

/** A supply row as the matcher sees it. */
function row(over: Partial<MatchableSupply> = {}): MatchableSupply {
  return {
    description: 'Black Toner Cartridge',
    type: 'toner',
    colour: 'black',
    percent: null,
    someRemaining: true,
    ...over,
  };
}

describe('vendorPercentFor', () => {
  const toner = { key: 'black_toner_remaining', value: 92, isPercent: true, marker: '6f' };

  it('fills the row the standard table declined to number', () => {
    const supplies = [row()];
    assert.equal(vendorPercentFor(supplies[0]!, supplies, [toner], 'laser'), 92);
  });

  it('leaves a row the standard table already answered alone', () => {
    // The whole discipline of this module. Undertaker's drum reads 78 % from the
    // standard table and agrees with Home Assistant; there is nothing to improve
    // and a vendor OID must not get a vote.
    const supplies = [row({ percent: 78, someRemaining: false })];
    assert.equal(vendorPercentFor(supplies[0]!, supplies, [toner], 'laser'), null);
  });

  it('does not put a toner reading on a drum row', () => {
    const supplies = [row({ description: 'Drum Unit', type: 'opc', colour: 'other' })];
    assert.equal(vendorPercentFor(supplies[0]!, supplies, [toner], 'laser'), null);
  });

  it('drops a value when two rows could equally claim it', () => {
    // Two unnumbered black markers and one black reading: nothing here says
    // which, so neither gets it.
    const supplies = [row(), row({ description: 'Black Toner Cartridge 2' })];
    assert.equal(vendorPercentFor(supplies[0]!, supplies, [toner], 'laser'), null);
    assert.equal(vendorPercentFor(supplies[1]!, supplies, [toner], 'laser'), null);
  });

  it('matches a colourless drum reading to the one drum row', () => {
    const drum = { key: 'drum_remaining_life', value: 78, isPercent: true, marker: '41' };
    const supplies = [row({ description: 'Drum Unit', type: 'opc', colour: 'other' })];
    assert.equal(vendorPercentFor(supplies[0]!, supplies, [drum], 'laser'), 78);
  });

  it('ignores a counter, which is a number but not a percentage', () => {
    const counter = { key: 'black_toner', value: 70, isPercent: false, marker: '81' };
    const supplies = [row()];
    assert.equal(vendorPercentFor(supplies[0]!, supplies, [counter], 'laser'), null);
  });

  it('does not cross colours', () => {
    const supplies = [row({ description: 'Cyan Toner Cartridge', colour: 'cyan' })];
    assert.equal(vendorPercentFor(supplies[0]!, supplies, [toner], 'laser'), null);
  });
});

describe('modelName', () => {
  it('pulls the model out of the device-ID string the OID actually returns', () => {
    // Exactly what an MFC-L2827DW answered on the forum.
    assert.equal(
      modelName(
        'MFG:Brother;CMD:PJL,HBP,URF;MDL:MFC-L2827DW;CLS:PRINTER;CID:Brother Laser Type1;URF:W8,CP1;',
      ),
      'MFC-L2827DW',
    );
  });

  it('returns the string whole when there is no MDL field, because that still tells a user something', () => {
    assert.equal(modelName('Brother NC-8300w'), 'Brother NC-8300w');
  });

  it('passes null through', () => {
    assert.equal(modelName(null), null);
  });
});

describe('decodeBrotherReading', () => {
  /** The private OIDs, as a poll would hand them over: raw buffers. */
  function raw(over: Record<string, Buffer | null> = {}) {
    return new Map<string, Buffer | null>([
      [BROTHER_OID.model, Buffer.from('MFG:Brother;CMD:PJL;MDL:MFC-L2827DW;CLS:PRINTER;', 'latin1')],
      [BROTHER_OID.serial, Buffer.from('E1234567890', 'latin1')],
      [BROTHER_OID.firmware, Buffer.from('ZA2503132156', 'latin1')],
      // The same blob as above plus the trailing FF a Brother really sends.
      [BROTHER_OID.maintenance, Buffer.from(`${HA_MAINTENANCE}ff`, 'hex')],
      [BROTHER_OID.nextcare, null],
      [BROTHER_OID.counters, null],
      ...Object.entries(over),
    ]);
  }

  it('strips the trailing checksum instead of decoding it as an entry', () => {
    const reading = decodeBrotherReading(raw() as never, 'laser');
    // An `ff` marker matches nothing, so a decoder that kept the checksum would
    // still pass every value assertion — this is the test that would not.
    assert.ok(!reading.maintenance.some((v) => v.marker === 'ff'));
    assert.equal(reading.maintenance.find((v) => v.key === 'black_toner_remaining')?.value, 64);
  });

  it('reads the model out of the device-ID string, not the whole string', () => {
    assert.equal(decodeBrotherReading(raw() as never, 'laser').model, 'MFC-L2827DW');
  });

  it('carries serial and firmware through as text', () => {
    const reading = decodeBrotherReading(raw() as never, 'laser');
    assert.equal(reading.serial, 'E1234567890');
    assert.equal(reading.firmware, 'ZA2503132156');
  });

  it('reports an OID that did not answer as nothing decoded, not as a failure', () => {
    const reading = decodeBrotherReading(raw({ [BROTHER_OID.maintenance]: null }) as never, 'laser');
    assert.deepEqual(reading.maintenance, []);
    assert.equal(reading.legacy, false);
    // The rest of the read still stands.
    assert.equal(reading.model, 'MFC-L2827DW');
  });

  it('reads the same blob as ink when the printer marks with ink', () => {
    // 6f is black-remaining in both maps, which is why guessing the kind wrong
    // costs an extra and never a wrong number.
    const reading = decodeBrotherReading(raw() as never, 'ink');
    assert.equal(reading.maintenance.find((v) => v.key === 'black_ink_remaining')?.value, 64);
    // The drum markers are laser-only, so they are absent rather than misread.
    assert.ok(!reading.maintenance.some((v) => v.key === 'drum_remaining_life'));
  });
})
