import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeResponse,
  encodeGetPrinterAttributes,
  isSuccessful,
  probeIpp,
  type IppValue,
} from '../lib/ipp-client.mjs';

/** Encodes one attribute the way a printer would. A name of '' adds a value to the previous one. */
function attr(tag: number, name: string, value: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(3);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(nameBytes.length, 1);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(value.length, 0);
  return Buffer.concat([head, nameBytes, length, value]);
}

const int = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
};
const str = (s: string): Buffer => Buffer.from(s, 'utf8');

/** A reply carrying the given printer attributes, plus the operation group every reply has. */
function reply(statusCode: number, body: Buffer[]): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt8(1, 1);
  header.writeUInt16BE(statusCode, 2);
  header.writeUInt32BE(1, 4);
  return Buffer.concat([
    header,
    Buffer.from([0x01]), // operation-attributes
    attr(0x47, 'attributes-charset', str('utf-8')),
    Buffer.from([0x04]), // printer-attributes
    ...body,
    Buffer.from([0x03]), // end-of-attributes
  ]);
}

describe('encodeGetPrinterAttributes', () => {
  it('asks IPP/1.1 for Get-Printer-Attributes', () => {
    const request = encodeGetPrinterAttributes('ipp://printer:631/ipp/print', [], 7);
    assert.equal(request.readUInt8(0), 1);
    assert.equal(request.readUInt8(1), 1);
    assert.equal(request.readUInt16BE(2), 0x000b);
    assert.equal(request.readUInt32BE(4), 7);
  });

  it('carries charset, language and printer-uri, in that order', () => {
    const request = encodeGetPrinterAttributes('ipp://printer:631/ipp/print');
    const text = request.toString('latin1');
    const charset = text.indexOf('attributes-charset');
    const language = text.indexOf('attributes-natural-language');
    const uri = text.indexOf('printer-uri');
    assert.ok(charset > 0 && language > charset && uri > language, text);
    assert.ok(text.includes('ipp://printer:631/ipp/print'));
  });

  it('names requested-attributes once and adds the rest as extra values', () => {
    const request = encodeGetPrinterAttributes('ipp://p/ipp/print', ['marker-levels', 'marker-names']);
    const text = request.toString('latin1');
    assert.equal(text.split('requested-attributes').length - 1, 1);
    assert.ok(text.includes('marker-levels'));
    assert.ok(text.includes('marker-names'));
  });

  it('round-trips through its own decoder', () => {
    // Not a reply, but the attribute encoding is the same in both directions,
    // so this catches a length written in the wrong place.
    const decoded = decodeResponse(encodeGetPrinterAttributes('ipp://p/ipp/print', ['marker-levels']));
    assert.equal(decoded.statusCode, 0x000b);
  });
});

describe('decodeResponse', () => {
  const values = (attrs: Map<string, IppValue[]>, name: string) => attrs.get(name);

  it('reads a status code and the printer attributes', () => {
    const { statusCode, attributes } = decodeResponse(reply(0x0000, [
      attr(0x23, 'printer-state', int(3)),
      attr(0x42, 'printer-make-and-model', str('Canon PRO-1000S')),
    ]));

    assert.ok(isSuccessful(statusCode));
    assert.deepEqual(values(attributes, 'printer-state'), [3]);
    assert.deepEqual(values(attributes, 'printer-make-and-model'), ['Canon PRO-1000S']);
  });

  it('keeps a 1setOf together, in order', () => {
    const { attributes } = decodeResponse(reply(0, [
      attr(0x21, 'marker-levels', int(92)),
      attr(0x21, '', int(-3)),
      attr(0x21, '', int(44)),
    ]));
    assert.deepEqual(values(attributes, 'marker-levels'), [92, -3, 44]);
  });

  it('keeps "I will not say" as null rather than as a number', () => {
    const { attributes } = decodeResponse(reply(0, [
      attr(0x12, 'marker-levels', Buffer.alloc(0)),
    ]));
    assert.deepEqual(values(attributes, 'marker-levels'), [null]);
  });

  it('ignores the operation group, which only echoes the request back', () => {
    const { attributes } = decodeResponse(reply(0, []));
    assert.equal(attributes.has('attributes-charset'), false);
  });

  it('steps over a collection without losing its place', () => {
    const { attributes } = decodeResponse(reply(0, [
      attr(0x34, 'media-col-database', Buffer.alloc(0)),
      attr(0x4a, '', str('media-size')),
      attr(0x21, '', int(21000)),
      attr(0x37, '', Buffer.alloc(0)),
      attr(0x21, 'marker-levels', int(50)),
    ]));

    assert.equal(attributes.has('media-col-database'), false);
    assert.deepEqual(values(attributes, 'marker-levels'), [50], 'the attribute after a collection is still read');
  });

  it('hands back an unknown tag as bytes rather than guessing', () => {
    const { attributes } = decodeResponse(reply(0, [
      attr(0x30, 'printer-supply', str('type=toner;level=92;')),
    ]));
    const value = values(attributes, 'printer-supply')?.[0];
    assert.ok(Buffer.isBuffer(value), 'octetString stays bytes');
    assert.equal((value as Buffer).toString('utf8'), 'type=toner;level=92;');
  });

  it('stops at a truncated reply instead of reading past the end', () => {
    const full = reply(0, [attr(0x42, 'printer-make-and-model', str('Some Printer'))]);
    const { attributes } = decodeResponse(full.subarray(0, full.length - 6));
    // Nothing is asserted about what survives — only that it returns at all.
    assert.ok(attributes instanceof Map);
  });

  it('refuses something too short to be IPP at all', () => {
    assert.throws(() => decodeResponse(Buffer.from([1, 1, 0])), /too short/);
  });
});

describe('probeIpp', () => {
  /**
   * A printer that drops packets on port 631 costs a full timeout per path
   * tried, and four of those outlast the ten seconds a Homey API call gets.
   * With the deadline already gone there is nothing left to spend, so the
   * search must not start — which is what keeps the report that called it.
   */
  it('does not open a connection once the deadline has passed', async () => {
    const started = Date.now();
    // 203.0.113.0/24 is reserved for documentation and routes nowhere, so a
    // probe that ignored the deadline would sit here until it timed out.
    const found = await probeIpp('203.0.113.1', [], 5_000, undefined, Date.now() - 1);

    assert.equal(found, null);
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
  });
});
