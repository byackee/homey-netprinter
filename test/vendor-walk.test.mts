import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundedWalk } from '../lib/snmp-client.mjs';
import {
  VENDOR_WALK,
  formatVendorWalk,
  renderVendorValue,
  vendorWalkRoot,
} from '../lib/vendor-walk.mjs';

const walk = (rows: BoundedWalk['rows'], stoppedBy: BoundedWalk['stoppedBy'] = null): BoundedWalk =>
  ({ rows, stoppedBy });

describe('vendorWalkRoot', () => {
  it('is the enterprise branch of the IANA number', () => {
    assert.equal(vendorWalkRoot(1602), '1.3.6.1.4.1.1602');
    assert.equal(vendorWalkRoot(2435), '1.3.6.1.4.1.2435');
  });
});

describe('renderVendorValue', () => {
  it('shows text as text, because a model string in hex helps nobody', () => {
    assert.equal(renderVendorValue(Buffer.from('iR-ADV C5535', 'latin1')), '"iR-ADV C5535"');
  });

  it('shows a packed structure as hex, because that is what a decoder needs', () => {
    // The shape of Brother's maintenance blob: marker byte, length, value.
    const blob = Buffer.from([0x6f, 0x01, 0x04, 0x00, 0x00, 0x23, 0x28]);
    assert.equal(renderVendorValue(blob), '6f010400002328');
  });

  it('keeps a number a number', () => {
    assert.equal(renderVendorValue(78), '78');
  });

  it('says so rather than inventing a value when the printer stayed silent', () => {
    assert.equal(renderVendorValue(null), '(no answer)');
  });

  it('truncates a long value but says how much there was', () => {
    const long = Buffer.alloc(400, 0xff);
    const rendered = renderVendorValue(long, 32);
    assert.ok(rendered.startsWith('ff'));
    assert.ok(rendered.includes('400 bytes'), rendered);
  });

  it('renders the boolean IPP has and SNMP does not', () => {
    assert.equal(renderVendorValue(true), 'true');
    assert.equal(renderVendorValue(false), 'false');
  });

  it('says an OID answered blank rather than rendering nothing at all', () => {
    assert.equal(renderVendorValue(Buffer.alloc(0)), '(empty)');
  });
});

describe('formatVendorWalk', () => {
  it('reports an empty branch as a finding, not as a failure', () => {
    const text = formatVendorWalk('1.3.6.1.4.1.1248', 'Epson', walk([])).join('\n');
    assert.ok(text.includes('Epson answers nothing under its own branch'), text);
  });

  it('prints every row undecoded, oid then value', () => {
    const text = formatVendorWalk('1.3.6.1.4.1.1602', 'Canon', walk([
      { oid: '1.3.6.1.4.1.1602.1.1.1.1.0', value: Buffer.from('PRO-1000S', 'latin1') },
      { oid: '1.3.6.1.4.1.1602.1.11.1.3.1.4.1', value: 92 },
    ])).join('\n');

    assert.ok(text.includes('## private branch, 1.3.6.1.4.1.1602 (Canon)'), text);
    assert.ok(text.includes('2 rows'), text);
    assert.ok(text.includes('1.3.6.1.4.1.1602.1.11.1.3.1.4.1\n      92'), text);
  });

  it('says out loud when it stopped early, so a partial branch is not read as a whole one', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ oid: `1.3.6.1.4.1.11.${i}`, value: i }));
    for (const [stoppedBy, expected] of [
      ['rows', String(VENDOR_WALK.maxRows)],
      ['bytes', 'forum post can hold'],
      ['time', 'ran out'],
    ] as const) {
      const text = formatVendorWalk('1.3.6.1.4.1.11', 'HP', walk(rows, stoppedBy)).join('\n');
      assert.ok(text.includes('this branch has more'), `${stoppedBy}: ${text}`);
      assert.ok(text.includes(expected), `${stoppedBy}: ${text}`);
    }
  });

  it('does not claim more when the branch simply ended', () => {
    const text = formatVendorWalk('1.3.6.1.4.1.11', 'HP', walk([
      { oid: '1.3.6.1.4.1.11.1', value: 1 },
    ])).join('\n');
    assert.ok(!text.includes('this branch has more'), text);
  });

  it('names an unknown manufacturer without pretending to know it', () => {
    const text = formatVendorWalk('1.3.6.1.4.1.99999', null, walk([])).join('\n');
    assert.ok(text.includes('this manufacturer answers nothing'), text);
  });
});
