import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SnmpValue } from '../lib/snmp-client.mjs';

import {
  RICOH_NEAR_EMPTY_PERCENT,
  RICOH_TONER_ROOT,
  decodeRicohWalk,
  ricohPercent,
  ricohPercentFor,
  type MatchableSupply,
} from '../lib/vendors/ricoh.mjs';

/**
 * The toner table of Henk_Renting's Aficio SP C242SF, exactly as his report
 * printed it in the support topic.
 *
 * Two things in here are the whole reason this module exists. Every one of his
 * five standard supply rows answered `-3` — the printer has toner and will not
 * say how much — so unlike Canon's document there is no overlap to argue from,
 * and the direction of these numbers rests on Ricoh's own specification for
 * `ricohEngTonerLevel` instead. And his cyan is at index 1 while his black is
 * at index 4, which is the reverse of the order the specification's example
 * table shows and of the order every public monitoring template hard-codes.
 */
const HENK: Array<[column: number, index: number, value: SnmpValue]> = [
  [2, 1, 'Cyan'], [2, 2, 'Magenta'], [2, 3, 'Yellow'], [2, 4, 'Black'],
  [3, 1, 'Cyan Toner'], [3, 2, 'Magenta Toner'], [3, 3, 'Yellow Toner'], [3, 4, 'Black Toner'],
  [4, 1, 10], [4, 2, 11], [4, 3, 12], [4, 4, 13],
  [5, 1, 80], [5, 2, 80], [5, 3, 80], [5, 4, 80],
];

function rows(
  table: Array<[column: number, index: number, value: SnmpValue]> = HENK,
): Array<readonly [string, SnmpValue]> {
  return table.map(([column, index, value]) =>
    [`${RICOH_TONER_ROOT}.${column}.${index}`, value] as const);
}

/** His standard table: four cartridges and a waste bottle, none of them numbered. */
function standardSupplies(): MatchableSupply[] {
  return [
    { description: 'Cyan Cartridge', type: 'toner', colour: 'cyan', percent: null, isReceptacle: false },
    { description: 'Magenta Cartridge', type: 'toner', colour: 'magenta', percent: null, isReceptacle: false },
    { description: 'Yellow Cartridge', type: 'toner', colour: 'yellow', percent: null, isReceptacle: false },
    { description: 'Black Cartridge', type: 'toner', colour: 'black', percent: null, isReceptacle: false },
    { description: 'Waste Cartridge', type: 'wasteToner', colour: 'waste', percent: null, isReceptacle: true },
  ];
}

describe('decodeRicohWalk', () => {
  it('reads the table an Aficio SP C242SF answers with', () => {
    const { toners } = decodeRicohWalk(rows());

    assert.equal(toners.length, 4);
    assert.deepEqual(toners.map((t) => t.colour), ['cyan', 'magenta', 'yellow', 'black']);
    assert.deepEqual(toners.map((t) => t.percent), [80, 80, 80, 80]);
    assert.deepEqual(toners.map((t) => t.descr), [
      'Cyan Toner', 'Magenta Toner', 'Yellow Toner', 'Black Toner',
    ]);
  });

  it('takes the colour from the type, not from the row index', () => {
    const { toners } = decodeRicohWalk(rows());
    const black = toners.find((t) => t.colour === 'black');

    // The templates that read index 1 as black would have put his cyan here.
    assert.equal(black?.index, '4');
    assert.equal(black?.type, 13);
  });

  it('gives no colour to a type nobody has reported', () => {
    const { toners } = decodeRicohWalk(rows([[4, 1, 99], [5, 1, 40]]));

    assert.equal(toners.length, 1);
    assert.equal(toners[0]!.colour, null);
    assert.equal(toners[0]!.percent, 40);
  });

  it('keeps the level even when the row has no type at all', () => {
    const { toners } = decodeRicohWalk(rows([[5, 1, 60]]));

    assert.equal(toners[0]!.level, 60);
    assert.equal(toners[0]!.colour, null);
  });

  it('reads a mono machine, which numbers its one black toner 1', () => {
    const { toners } = decodeRicohWalk(rows([[2, 1, 'Toner'], [4, 1, 3], [5, 1, 20]]));

    assert.equal(toners[0]!.colour, 'black');
    assert.equal(toners[0]!.percent, 20);
  });

  it('ignores rows from outside the table', () => {
    const { toners } = decodeRicohWalk([
      ['1.3.6.1.4.1.367.3.2.1.1.1.1.0', 'Aficio SP C242SF'],
      ...rows([[4, 1, 13], [5, 1, 90]]),
    ]);

    assert.equal(toners.length, 1);
    assert.equal(toners[0]!.percent, 90);
  });

  it('reads a value the agent sent as bytes', () => {
    const { toners } = decodeRicohWalk(rows([
      [3, 1, Buffer.from('Black Toner', 'latin1')], [4, 1, 13], [5, 1, 50],
    ]));

    assert.equal(toners[0]!.descr, 'Black Toner');
  });
});

describe('ricohPercent', () => {
  it('takes a level in range as the percentage remaining that Ricoh documents', () => {
    for (const level of [0, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      assert.equal(ricohPercent(level), level);
    }
  });

  it('shows near empty as the top of the band Ricoh defines for it', () => {
    assert.equal(ricohPercent(-100), RICOH_NEAR_EMPTY_PERCENT);
    // Below every step the printer does report, so the readings stay ordered.
    assert.ok(RICOH_NEAR_EMPTY_PERCENT < 20);
  });

  it('refuses the sentinels that carry no quantity', () => {
    assert.equal(ricohPercent(-2), null); // unknown
    assert.equal(ricohPercent(-3), null); // some remaining, no figure
    assert.equal(ricohPercent(101), null);
    assert.equal(ricohPercent(null), null);
  });
});

describe('ricohPercentFor', () => {
  it('fills the four cartridges his standard table would not number', () => {
    const supplies = standardSupplies();
    const reading = decodeRicohWalk(rows());

    assert.deepEqual(
      supplies.map((s) => ricohPercentFor(s, supplies, reading)),
      [80, 80, 80, 80, null],
    );
  });

  it('leaves a waste bottle alone: the toner table says nothing about one', () => {
    const supplies = standardSupplies();
    const waste = supplies[4]!;

    assert.equal(ricohPercentFor(waste, supplies, decodeRicohWalk(rows())), null);
  });

  it('never overrides a number the standard table did give', () => {
    const supplies = standardSupplies();
    supplies[0]!.percent = 45;

    assert.equal(ricohPercentFor(supplies[0]!, supplies, decodeRicohWalk(rows())), null);
  });

  it('does not let a toner level land on a drum of the same colour', () => {
    const supplies: MatchableSupply[] = [
      { description: 'Cyan Cartridge', type: 'toner', colour: 'cyan', percent: null, isReceptacle: false },
      { description: 'Cyan Photoconductor Unit', type: 'opc', colour: 'cyan', percent: null, isReceptacle: false },
    ];
    const reading = decodeRicohWalk(rows([[4, 1, 10], [5, 1, 70]]));

    assert.equal(ricohPercentFor(supplies[0]!, supplies, reading), 70);
    assert.equal(ricohPercentFor(supplies[1]!, supplies, reading), null);
  });

  it('gives no number when two rows share a colour', () => {
    const supplies: MatchableSupply[] = [
      { description: 'Black Cartridge', type: 'toner', colour: 'black', percent: null, isReceptacle: false },
      { description: 'Black Cartridge 2', type: 'toner', colour: 'black', percent: null, isReceptacle: false },
    ];
    const reading = decodeRicohWalk(rows([[4, 1, 13], [5, 1, 70]]));

    assert.equal(ricohPercentFor(supplies[0]!, supplies, reading), null);
    assert.equal(ricohPercentFor(supplies[1]!, supplies, reading), null);
  });

  it('gives no number when the toner table is as silent as the standard one', () => {
    const supplies = standardSupplies();
    const reading = decodeRicohWalk(rows([[4, 1, 13], [5, 1, -3]]));

    assert.equal(ricohPercentFor(supplies[3]!, supplies, reading), null);
  });

  it('fills a near-empty cartridge rather than blanking it', () => {
    const supplies = standardSupplies();
    const reading = decodeRicohWalk(rows([[4, 1, 13], [5, 1, -100]]));

    assert.equal(ricohPercentFor(supplies[3]!, supplies, reading), RICOH_NEAR_EMPTY_PERCENT);
  });

  it('fills a mono machine, whose toner names no colour on either side', () => {
    // A black-and-white Ricoh calls it "Toner" in both tables, and a description
    // with no colour word in it classifies as `other` — so there is nothing to
    // match on but the fact that there is one of each.
    const supplies: MatchableSupply[] = [
      { description: 'Toner Cartridge', type: 'toner', colour: 'other', percent: null, isReceptacle: false },
    ];
    const reading = decodeRicohWalk(rows([[2, 1, 'Toner'], [4, 1, 3], [5, 1, 30]]));

    assert.equal(ricohPercentFor(supplies[0]!, supplies, reading), 30);
  });

  it('will not pair a lone toner with a row that names a different colour', () => {
    const supplies: MatchableSupply[] = [
      { description: 'Black Cartridge', type: 'toner', colour: 'black', percent: null, isReceptacle: false },
    ];
    const reading = decodeRicohWalk(rows([[4, 1, 10], [5, 1, 30]]));

    assert.equal(ricohPercentFor(supplies[0]!, supplies, reading), null);
  });

  it('does not pair a lone toner when the printer has more than one row to put it on', () => {
    const supplies: MatchableSupply[] = [
      { description: 'Toner Cartridge', type: 'toner', colour: 'other', percent: null, isReceptacle: false },
      { description: 'Toner Cartridge 2', type: 'toner', colour: 'other', percent: null, isReceptacle: false },
    ];
    const reading = decodeRicohWalk(rows([[4, 1, 3], [5, 1, 30]]));

    assert.equal(ricohPercentFor(supplies[0]!, supplies, reading), null);
    assert.equal(ricohPercentFor(supplies[1]!, supplies, reading), null);
  });

  it('never reaches the lone-toner rule on a four-colour machine', () => {
    // His four toners are all in the table, so a row the colours cannot place
    // stays blank rather than taking the first level going.
    const supplies: MatchableSupply[] = [
      ...standardSupplies().slice(0, 4),
      { description: 'Toner Cartridge', type: 'toner', colour: 'other', percent: null, isReceptacle: false },
    ];

    assert.equal(ricohPercentFor(supplies[4]!, supplies, decodeRicohWalk(rows())), null);
  });

  it('reports an empty cartridge as empty, which is a reading', () => {
    const supplies = standardSupplies();
    const reading = decodeRicohWalk(rows([[4, 1, 13], [5, 1, 0]]));

    assert.equal(ricohPercentFor(supplies[3]!, supplies, reading), 0);
  });
});
