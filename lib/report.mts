/**
 * The diagnostic report, assembled.
 *
 * This lives apart from the endpoint because of how it broke. The report grew a
 * section per protocol, each added where it was needed, and the vendor branches
 * each returned their text as soon as they had it. That reads fine one branch at
 * a time — and it meant the IPP section, written to be unconditional, was
 * reached only by a Brother. Everyone else got a report that stopped at the
 * private branch, including the Canon owner who had just been asked for one
 * precisely to see what IPP said. The section that would have answered the
 * question was the section their path skipped.
 *
 * So the order is written once, here, with a single exit. A section can be
 * empty, and a section can fail, but no path can leave one out: what follows the
 * private branch is IPP, whatever the private branch turned out to be. The
 * sources are injected so the whole thing can be exercised — every identity, and
 * a branch that throws — without a printer on the network.
 */

import type { Supply } from './printer-mib.mjs';
import type { BoundedWalk, SnmpVersion } from './snmp-client.mjs';
import type { PrinterIdentity } from './printer-reader.mjs';

import { VENDOR_WALK, formatVendorWalk, vendorWalkRoot } from './vendor-walk.mjs';
import { BROTHER_ENTERPRISE } from './vendors/brother.mjs';

/**
 * Everything one report is made of: what was read, and how to read the rest.
 *
 * The two sections that need a printer arrive as functions rather than as text,
 * so that the order below decides when they run — and so that the order is the
 * only thing this module has to get right.
 */
export interface DumpReportSources {
  host: string;
  community: string;
  version: SnmpVersion;
  identity: PrinterIdentity;
  /** The manufacturer's name, when the enterprise number names one. */
  vendor: string | null;
  /** The standard table, as the app itself read it. */
  supplies: Supply[];
  /** Walks the manufacturer's own branch, bounded. */
  walkVendorBranch(root: string): Promise<BoundedWalk>;
  /** Brother's private branch, raw and decoded — the one brand with a decoder. */
  brotherSection(): Promise<string[]>;
  /** What the printer answers over IPP. */
  ippSection(): Promise<string[]>;
}

/** The lines above the first section: who answered, and how. */
function header(sources: DumpReportSources): string[] {
  const { host, community, version, identity, vendor } = sources;
  return [
    `# ${[vendor, identity.model].filter(Boolean).join(' ') || host}`,
    `host        ${host}`,
    `snmp        ${version}, community "${community}"`,
    `sysObjectID enterprise ${identity.enterprise ?? 'unknown'}${vendor ? ` (${vendor})` : ''}`,
    `serial      ${identity.serial ?? '—'}`,
    '',
  ];
}

/**
 * The standard table first, always. It is the reading the app actually depends
 * on, and a report that shows only the vendor branch cannot say whether the
 * vendor branch was needed.
 */
function standardTable(supplies: Supply[]): string[] {
  const lines = ['## prtMarkerSuppliesTable (the standard read)'];

  if (supplies.length === 0) {
    lines.push('(no rows — this printer reports no supplies table)');
  }
  for (const supply of supplies) {
    const percent = supply.percent === null ? 'no number' : `${supply.percent} %`;
    lines.push(
      `[${supply.index}] ${supply.description || supply.colour}`,
      `      level ${supply.level} / ${supply.maxCapacity} ${supply.unit}` +
        ` · type ${supply.type} · class ${supply.supplyClass ?? '—'} → ${percent}` +
        (supply.vendorSourced ? ' (from the vendor branch)' : ''),
    );
  }
  lines.push('');

  return lines;
}

/**
 * The private branch, whichever kind of private branch this printer has.
 *
 * Three outcomes, one return: a printer that will not say who made it has no
 * branch to look under, Brother has a decoder, and everyone else gets their
 * branch walked undecoded. A walk that fails is reported as a failed walk rather
 * than thrown, because the standard table above was already read and the report
 * is still worth pasting — and because a throw here is exactly how IPP would go
 * missing again.
 */
async function privateBranch(sources: DumpReportSources): Promise<string[]> {
  const { identity, vendor } = sources;

  if (identity.enterprise === null) {
    return [
      '## private branch',
      'This printer does not say who made it — sysObjectID carries no enterprise',
      'number — so there is no private branch to look under. Everything above comes',
      'from the standard Printer-MIB.',
    ];
  }

  if (identity.enterprise === BROTHER_ENTERPRISE) {
    try {
      return await sources.brotherSection();
    } catch (error) {
      return [
        '## Brother private branch',
        `Could not be read: ${(error as Error).message}`,
        'Everything above still stands — it was read before this failed.',
      ];
    }
  }

  const root = vendorWalkRoot(identity.enterprise);
  try {
    return formatVendorWalk(root, vendor, await sources.walkVendorBranch(root));
  } catch (error) {
    return [
      `## private branch, ${root} (${vendor ?? 'this manufacturer'})`,
      `Could not be read: ${(error as Error).message}`,
      'Everything above still stands — it was read before this failed.',
    ];
  }
}

/**
 * One report, in the order a reader needs it: what answered, what the standard
 * table said, what the manufacturer's branch said, and what IPP said.
 *
 * The last of those is the point of the single exit. A missing level is exactly
 * the case where nobody yet knows which protocol holds the answer, so the
 * section that names the other protocol has to survive every path through here.
 */
export async function buildDumpReport(sources: DumpReportSources): Promise<string> {
  // Started before the private branch is awaited, rather than after it. The two
  // speak different protocols on different sockets, and the whole call is cut
  // off at ten seconds — of which the vendor walk alone may spend four. Read one
  // after the other and this section goes missing again for a new reason, a
  // timeout, on exactly the printers it was added for. Overlapped, IPP costs the
  // report nothing.
  const ipp = (async (): Promise<string[]> => {
    try {
      return await sources.ippSection();
    } catch (error) {
      return [
        '',
        '## IPP',
        `Could not be read: ${(error as Error).message}`,
        'Everything above still stands — it was read before this failed.',
      ];
    }
  })();

  return [
    ...header(sources),
    ...standardTable(sources.supplies),
    ...await privateBranch(sources),
    ...await ipp,
  ].join('\n');
}

