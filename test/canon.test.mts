import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SnmpValue } from '../lib/snmp-client.mjs';

import {
  CANON_STATUS_ROOT,
  assembleCanonDocument,
  canonPercentFor,
  decodeCanonStatus,
  decodeCanonWalk,
  type MatchableSupply,
} from '../lib/vendors/canon.mjs';

/**
 * The status document of Tom_Van_Zele's PRO-1000, rebuilt from the report he
 * posted in the support topic.
 *
 * The forum's own sanitiser ate the opening tags out of his paste, so this is
 * the document with those put back rather than a byte-for-byte copy — but every
 * colour token, every level and the order they arrive in are his printer's. Six
 * of these twelve also appear in his standard supplies table, and those six are
 * asserted against it below: that agreement is the whole reason the other six
 * are trusted.
 */
const INKS: Array<[string, number, string | null, string]> = [
  ['PM', 10, null, 'warning'],
  ['R', 80, null, 'none'],
  ['C', 80, null, 'none'],
  ['PGY', 10, null, 'warning'],
  ['MBK', 20, null, 'none'],
  ['PBK', 20, null, 'none'],
  ['B', 30, null, 'none'],
  ['CO', 100, null, 'none'],
  ['GY', 80, null, 'none'],
  ['Y', 10, 'PFI-1000', 'warning'],
  ['M', 100, null, 'none'],
  ['PC', 10, null, 'warning'],
];

/** What his standard table did answer, from the same report. */
const STANDARD: Record<string, number> = { C: 80, MBK: 20, PBK: 20, GY: 80, Y: 10, M: 100 };

function canonDocument(): string {
  const inks = INKS.map(([colour, level, model, icon]) =>
    '<ivec:ink>'
    + `<ivec:model>${model === null ? '' : `<![CDATA[${model}]]>`}</ivec:model>`
    + `<ivec:color>${colour}</ivec:color>`
    + `<ivec:icon>${icon}</ivec:icon>`
    + `<ivec:level>${level}</ivec:level>`
    + '<vcn:tca>AC</vcn:tca>'
    + `<ivec:order>${INKS.findIndex(([c]) => c === colour) + 1}</ivec:order>`
    + '</ivec:ink>').join('');

  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<ivec:contents>'
    + '<ivec:operation>GetStatusResponse</ivec:operation>'
    + '<ivec:param_set servicetype="print">'
    + '<ivec:response>OK</ivec:response>'
    + '<ivec:status>idle</ivec:status>'
    + '<ivec:status_detail>MarkerSupplyAttention</ivec:status_detail>'
    + `<ivec:marker_info>${inks}</ivec:marker_info>`
    + '<ivec:wasteink><ivec:item><ivec:icon>none</ivec:icon>'
    + '<ivec:model>MC-20</ivec:model><ivec:level>30</ivec:level></ivec:item></ivec:wasteink>'
    + '</ivec:param_set></ivec:contents>\n';
}

/**
 * The document as the printer actually hands it over: cut into fixed-length
 * pieces, one per table row, with no regard for where a tag ends. His had
 * eighteen of them and one boundary fell inside `<ivec:color>`.
 */
function chunked(document: string, size = 250): Array<readonly [string, SnmpValue]> {
  const rows: Array<readonly [string, SnmpValue]> = [];
  for (let i = 0; i * size < document.length; i += 1) {
    rows.push([`${CANON_STATUS_ROOT}.1.2.1.${i + 1}`, document.slice(i * size, (i + 1) * size)]);
  }
  return rows;
}

const supply = (description: string, percent: number | null): MatchableSupply =>
  ({ description, percent });

describe('assembleCanonDocument', () => {
  it('splices the chunks back into the document they came from', () => {
    const document = canonDocument();
    assert.equal(assembleCanonDocument(chunked(document)), document);
  });

  /**
   * The failure this is guarding: a printer answers eighteen rows, and string
   * order puts row 10 between row 1 and row 2. The document still parses — into
   * inks with the wrong levels, which is worse than not parsing at all.
   */
  it('orders chunks as numbers, so ten does not land between one and two', () => {
    const document = canonDocument();
    const shuffled = [...chunked(document)].reverse();
    assert.equal(assembleCanonDocument(shuffled), document);
  });

  it('keeps two documents in the same table apart', () => {
    const rows: Array<readonly [string, SnmpValue]> = [
      [`${CANON_STATUS_ROOT}.1.2.9.1`, 'not the one'],
      ...chunked(canonDocument()),
    ];
    assert.equal(assembleCanonDocument(rows), canonDocument());
  });

  it('has nothing to say about a printer that answered nothing', () => {
    assert.equal(assembleCanonDocument([]), null);
  });
});

describe('decodeCanonStatus', () => {
  it("reads every ink in Tom_Van_Zele's PRO-1000 document", () => {
    const reading = decodeCanonStatus(canonDocument());

    assert.equal(reading.document, true);
    assert.deepEqual(
      reading.inks.map((ink) => [ink.colour, ink.level]),
      INKS.map(([colour, level]) => [colour, level]),
    );
  });

  /**
   * The reason the other six are trusted. His standard table numbered six of
   * the twelve, and the document agrees with the table on every one of them —
   * the same reading arriving twice by two unrelated routes.
   */
  it('agrees with the standard table on every level the standard table gave', () => {
    const reading = decodeCanonStatus(canonDocument());
    for (const [colour, percent] of Object.entries(STANDARD)) {
      const ink = reading.inks.find((i) => i.colour === colour);
      assert.equal(ink?.level, percent, `${colour} disagrees with the standard table`);
    }
  });

  it('unwraps a CDATA model and keeps the icon', () => {
    const ink = decodeCanonStatus(canonDocument()).inks.find((i) => i.colour === 'Y');
    assert.equal(ink?.model, 'PFI-1000');
    assert.equal(ink?.icon, 'warning');
  });

  it('reads the waste item without mistaking it for an ink', () => {
    const reading = decodeCanonStatus(canonDocument());
    assert.deepEqual(reading.waste, [{ model: 'MC-20', level: 30 }]);
    assert.ok(!reading.inks.some((ink) => ink.colour === 'MC-20'));
    assert.equal(reading.inks.length, INKS.length, 'the waste level must not become a thirteenth ink');
  });

  it('survives a document whose namespace prefix is not ivec', () => {
    const reading = decodeCanonStatus(
      '<x:contents><x:marker_info><x:ink><x:color>C</x:color><x:level>55</x:level></x:ink>'
      + '</x:marker_info></x:contents>',
    );
    assert.deepEqual(reading.inks.map((i) => [i.colour, i.level]), [['C', 55]]);
  });

  it('refuses a level that is not a percentage rather than printing the sentinel', () => {
    const reading = decodeCanonStatus(
      '<ivec:ink><ivec:color>C</ivec:color><ivec:level>-3</ivec:level></ivec:ink>'
      + '<ivec:ink><ivec:color>M</ivec:color><ivec:level>255</ivec:level></ivec:ink>'
      + '<ivec:ink><ivec:color>Y</ivec:color><ivec:level>0</ivec:level></ivec:ink>',
    );
    assert.deepEqual(reading.inks.map((i) => [i.colour, i.level]), [['Y', 0]]);
  });

  it('reports nothing, rather than throwing, on something that is not a document', () => {
    const reading = decodeCanonStatus('<html><body>Not a printer status</body></html>');
    assert.equal(reading.document, false);
    assert.deepEqual(reading.inks, []);
  });
});

describe('canonPercentFor', () => {
  const reading = decodeCanonWalk(chunked(canonDocument()));

  it('fills a row the standard table refused to number', () => {
    const supplies = [supply('PM', null), supply('C', 80)];
    assert.equal(canonPercentFor(supplies[0]!, supplies, reading), 10);
  });

  /**
   * The rule this shares with Brother, and the more important half of it. The
   * standard table is the source of truth wherever it answers; a private branch
   * is a patch for silence, not a second opinion.
   */
  it('never overrides a number the standard table already gave', () => {
    const supplies = [supply('C', 80)];
    assert.equal(canonPercentFor(supplies[0]!, supplies, reading), null);
  });

  it('leaves a row the document does not name', () => {
    const supplies = [supply('Waste Toner', null)];
    assert.equal(canonPercentFor(supplies[0]!, supplies, reading), null);
  });

  it('refuses to choose between two rows with the same description', () => {
    const supplies = [supply('C', null), supply('C', null)];
    assert.equal(canonPercentFor(supplies[0]!, supplies, reading), null);
  });

  it('matches whatever the printer capitalised, on both sides', () => {
    const supplies = [supply('  pgy ', null)];
    assert.equal(canonPercentFor(supplies[0]!, supplies, reading), 10);
  });

  it('has nothing to offer a row with no description at all', () => {
    const supplies = [supply('   ', null)];
    assert.equal(canonPercentFor(supplies[0]!, supplies, reading), null);
  });

  it('fills the six his printer left blank, and only those six', () => {
    const supplies = INKS.map(([colour]) => supply(colour, STANDARD[colour] ?? null));
    const filled = supplies
      .map((s) => [s.description, canonPercentFor(s, supplies, reading)] as const)
      .filter(([, percent]) => percent !== null);

    assert.deepEqual(filled, [
      ['PM', 10], ['R', 80], ['PGY', 10], ['B', 30], ['CO', 100], ['PC', 10],
    ]);
  });
});
