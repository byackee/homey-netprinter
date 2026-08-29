import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Supply } from '../lib/printer-mib.mjs';
import type { BoundedWalk } from '../lib/snmp-client.mjs';
import type { PrinterIdentity } from '../lib/printer-reader.mjs';
import type { DumpReportSources } from '../lib/report.mjs';

import { buildDumpReport } from '../lib/report.mjs';
import { BROTHER_ENTERPRISE } from '../lib/vendors/brother.mjs';

const identity = (enterprise: number | null): PrinterIdentity => ({
  model: 'Pro-1000S',
  name: 'printer',
  serial: 'ABC123',
  enterprise,
  description: null,
});

const supply = (over: Partial<Supply> = {}): Supply => ({
  index: '1.1',
  description: 'Black Ink',
  type: 'toner',
  colour: 'black',
  percent: 92,
  someRemaining: false,
  isReceptacle: false,
  level: 92,
  maxCapacity: 100,
  unit: 'percent',
  supplyClass: 4,
  ...over,
});

const walked = (rows: BoundedWalk['rows'], stoppedBy: BoundedWalk['stoppedBy'] = null): BoundedWalk =>
  ({ rows, stoppedBy });

/** A report of a printer that answers everything, with each source recorded. */
function sources(over: Partial<DumpReportSources> = {}): DumpReportSources {
  return {
    host: '192.168.1.42',
    community: 'public',
    version: 'v2c',
    identity: identity(1602),
    vendor: 'Canon',
    firmware: '4.000',
    supplies: [supply()],
    branch: null,
    deadlineAt: Date.now() + 5_000,
    walkVendorBranch: async () => walked([{ oid: '1.3.6.1.4.1.1602.1', value: 42 }]),
    brotherSection: async () => ['## Brother private branch, raw', '(brother lines)'],
    ippSection: async () => ['', '## IPP', 'answered at ipp://192.168.1.42/ipp/print'],
    ...over,
  };
}

describe('buildDumpReport', () => {
  /**
   * The bug this module exists for. Every one of these identities used to leave
   * the report before IPP was reached — every brand but Brother, which is to
   * say every owner who was asked for a report because a level was missing.
   */
  for (const [what, over] of [
    ['a manufacturer with no decoder', { identity: identity(1602), vendor: 'Canon' }],
    ['a manufacturer nobody has met', { identity: identity(9999), vendor: null }],
    ['a printer that will not say who made it', { identity: identity(null), vendor: null }],
    ['Brother, which has a decoder', { identity: identity(BROTHER_ENTERPRISE), vendor: 'Brother' }],
  ] as Array<[string, Partial<DumpReportSources>]>) {
    it(`asks IPP for ${what}`, async () => {
      let asked = false;
      const text = await buildDumpReport(sources({
        ...over,
        ippSection: async () => {
          asked = true;
          return ['', '## IPP', '48 attributes'];
        },
      }));

      assert.ok(asked, 'the IPP section was never read');
      assert.ok(text.includes('## IPP'), text);
    });
  }

  it('puts IPP after the private branch, not instead of it', async () => {
    const text = await buildDumpReport(sources());

    const standard = text.indexOf('## prtMarkerSuppliesTable');
    const branch = text.indexOf('## private branch');
    const ipp = text.indexOf('## IPP');

    assert.ok(standard >= 0 && branch > standard, text);
    assert.ok(ipp > branch, 'IPP has to come last, and it has to come');
  });

  /**
   * The Lexmark of the support topic: a branch big enough to hit the row cap.
   * The stop note said "this branch has more", which read as the report having
   * been cut off there — and it had been, because nothing followed it.
   */
  it('still reports IPP when the vendor branch stopped at the row cap', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      oid: `1.3.6.1.4.1.641.2.1.${i}`,
      value: i,
    }));
    const text = await buildDumpReport(sources({
      identity: identity(641),
      vendor: 'Lexmark',
      walkVendorBranch: async () => walked(rows, 'rows'),
    }));

    assert.ok(text.includes('Stopped at 250 rows'), 'the walk should still say it stopped early');
    assert.ok(text.indexOf('## IPP') > text.indexOf('Stopped at 250 rows'), text.slice(-400));
  });

  it('reports a vendor branch that failed, and reads IPP anyway', async () => {
    const text = await buildDumpReport(sources({
      walkVendorBranch: async () => { throw new Error('request timed out'); },
    }));

    assert.ok(text.includes('Could not be read: request timed out'), text);
    assert.ok(text.includes('## prtMarkerSuppliesTable'), 'the standard read was already done');
    assert.ok(text.includes('## IPP'), 'a failed branch must not take IPP down with it');
  });

  it('reports a Brother decode that failed, and reads IPP anyway', async () => {
    const text = await buildDumpReport(sources({
      identity: identity(BROTHER_ENTERPRISE),
      vendor: 'Brother',
      brotherSection: async () => { throw new Error('no answer'); },
    }));

    assert.ok(text.includes('## Brother private branch'), text);
    assert.ok(text.includes('Could not be read: no answer'), text);
    assert.ok(text.includes('## IPP'), text);
  });

  it('reports IPP failing without losing the report it was appended to', async () => {
    const text = await buildDumpReport(sources({
      ippSection: async () => { throw new Error('socket hang up'); },
    }));

    assert.ok(text.includes('## IPP'), 'the section has to be there to say it failed');
    assert.ok(text.includes('Could not be read: socket hang up'), text);
    assert.ok(text.includes('## prtMarkerSuppliesTable'), 'everything above still stands');
  });

  it('names the printer and how it was reached', async () => {
    const text = await buildDumpReport(sources());

    assert.ok(text.startsWith('# Canon Pro-1000S'), text.slice(0, 80));
    assert.ok(text.includes('host        192.168.1.42'), text);
    assert.ok(text.includes('snmp        v2c, community "public"'), text);
    assert.ok(text.includes('sysObjectID enterprise 1602 (Canon)'), text);
    assert.ok(text.includes('serial      ABC123'), text);
  });

  it('falls back to the address when nothing names the printer', async () => {
    const text = await buildDumpReport(sources({
      identity: { ...identity(null), model: null, serial: null },
      vendor: null,
    }));

    assert.ok(text.startsWith('# 192.168.1.42'), text.slice(0, 80));
    assert.ok(text.includes('sysObjectID enterprise unknown'), text);
    assert.ok(text.includes('serial      —'), text);
  });

  it('says a supply has no number rather than printing a sentinel as one', async () => {
    const text = await buildDumpReport(sources({
      supplies: [supply({ percent: null, level: -3, someRemaining: true })],
    }));

    assert.ok(text.includes('[1.1] Black Ink'), text);
    assert.ok(text.includes('level -3 / 100 percent'), text);
    assert.ok(text.includes('→ no number'), text);
  });

  it('marks a level that came from the vendor branch, so the two are not confused', async () => {
    const text = await buildDumpReport(sources({
      supplies: [supply({ vendorSourced: true })],
    }));

    assert.ok(text.includes('→ 92 % (from the vendor branch)'), text);
  });

  it('says a printer reports no supplies at all, and still reads on', async () => {
    const text = await buildDumpReport(sources({ supplies: [] }));

    assert.ok(text.includes('(no rows — this printer reports no supplies table)'), text);
    assert.ok(text.includes('## IPP'), text);
  });

  it('does not walk a private branch a printer has not claimed', async () => {
    let walkedBranch = false;
    const text = await buildDumpReport(sources({
      identity: identity(null),
      vendor: null,
      walkVendorBranch: async () => { walkedBranch = true; return walked([]); },
    }));

    assert.equal(walkedBranch, false, 'there is no branch to walk without an enterprise number');
    assert.ok(text.includes('does not say who made it'), text);
  });

  it('walks the branch of the enterprise number the printer gave', async () => {
    const roots: string[] = [];
    await buildDumpReport(sources({
      identity: identity(1602),
      walkVendorBranch: async (root) => { roots.push(root); return walked([]); },
    }));

    assert.deepEqual(roots, ['1.3.6.1.4.1.1602']);
  });
});

/**
 * The ten seconds a Homey API call gets are the constraint that shaped the
 * vendor walk's four-second budget, and IPP now runs on the same call. Read one
 * after the other, the section that was missing would go missing again — this
 * time to a timeout, on exactly the printers it was added for.
 */
describe('buildDumpReport, against the clock', () => {
  it('starts the IPP read without waiting for the private branch', async () => {
    const order: string[] = [];
    let releaseWalk: (() => void) | null = null;
    const walkStarted = new Promise<void>((resolve) => {
      releaseWalk = resolve;
    });

    const text = await buildDumpReport(sources({
      walkVendorBranch: async () => {
        order.push('walk started');
        // Resolves only once IPP has run, so the walk can only finish if the two
        // overlap. A serial report deadlocks here rather than passing slowly.
        await walkStarted;
        order.push('walk finished');
        return walked([]);
      },
      ippSection: async () => {
        order.push('ipp');
        releaseWalk?.();
        return ['', '## IPP', 'answered'];
      },
    }));

    // Which of the two starts first is an implementation detail; that IPP does
    // not have to wait for the branch to finish is the property being kept.
    assert.deepEqual(order.slice().sort(), ['ipp', 'walk finished', 'walk started']);
    assert.ok(order.indexOf('ipp') < order.indexOf('walk finished'), order.join(' → '));
    assert.ok(text.indexOf('## IPP') > text.indexOf('## private branch'), text);
  });

  it('keeps IPP last in the text even when it answers first', async () => {
    const text = await buildDumpReport(sources({
      walkVendorBranch: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return walked([{ oid: '1.3.6.1.4.1.1602.1', value: 1 }]);
      },
    }));

    assert.ok(text.indexOf('## IPP') > text.indexOf('1.3.6.1.4.1.1602.1'), text);
  });
  /**
   * The regression this deadline exists for. A section that never answers used
   * to take the whole report with it: the endpoint hit Homey's ten-second cut
   * and the user got a timeout where the version before had given them a
   * report they could paste.
   */
  it('returns the report when a section never answers', async () => {
    const text = await buildDumpReport(sources({
      deadlineAt: Date.now() + 30,
      ippSection: () => new Promise<string[]>(() => {}),
    }));

    assert.match(text, /## prtMarkerSuppliesTable/);
    assert.match(text, /1\.3\.6\.1\.4\.1\.1602\.1/);
    assert.match(text, /## IPP/);
    assert.match(text, /ran out first/);
  });

  it('keeps IPP when it is the private branch that hangs', async () => {
    const text = await buildDumpReport(sources({
      deadlineAt: Date.now() + 30,
      walkVendorBranch: () => new Promise<never>(() => {}),
    }));

    assert.match(text, /## private branch/);
    assert.match(text, /ran out first/);
    assert.match(text, /answered at ipp:/);
  });

  it('names the firmware version in the header', async () => {
    const text = await buildDumpReport(sources());
    assert.match(text, /^firmware {4}4\.000$/m);
  });

  it('says so rather than lying when no firmware was found', async () => {
    const text = await buildDumpReport(sources({ firmware: null }));
    assert.match(text, /^firmware {4}—$/m);
  });
  /**
   * The follow-through on what a truncated report promises its reader. Tom's
   * Canon stopped at the size cap part-way through the document its ink levels
   * live in; pointed at that document, the next report starts there.
   */
  it('reads the one branch it was pointed at, and says which', async () => {
    const asked: string[] = [];
    const text = await buildDumpReport(sources({
      branch: '1.3.6.1.4.1.1602.1.5.1.6.2.2',
      walkVendorBranch: async (root) => {
        asked.push(root);
        return walked([{ oid: `${root}.1`, value: 'PM 10 R 80' }]);
      },
    }));

    assert.deepEqual(asked, ['1.3.6.1.4.1.1602.1.5.1.6.2.2']);
    assert.match(text, /## private branch, 1\.3\.6\.1\.4\.1\.1602\.1\.5\.1\.6\.2\.2/);
    assert.match(text, /PM 10 R 80/);
  });

  /**
   * Brother is the one brand with a decoder, and the decoder reads six OIDs it
   * already knows. Someone naming a branch is asking for the branch.
   */
  it('walks a named branch on a Brother rather than running the decoder', async () => {
    const text = await buildDumpReport(sources({
      identity: identity(BROTHER_ENTERPRISE),
      vendor: 'Brother',
      branch: '1.3.6.1.4.1.2435.2.4.3',
      walkVendorBranch: async (root) => walked([{ oid: `${root}.9`, value: 7 }]),
    }));

    assert.doesNotMatch(text, /brother lines/);
    assert.match(text, /1\.3\.6\.1\.4\.1\.2435\.2\.4\.3\.9/);
  });
});
