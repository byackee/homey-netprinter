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

import { VENDOR_WALK, formatVendorWalk, renderVendorValue, vendorWalkRoot } from './vendor-walk.mjs';
import { BROTHER_ENTERPRISE } from './vendors/brother.mjs';
import { CANON_ENTERPRISE, CANON_STATUS_ROOT, decodeCanonWalk } from './vendors/canon.mjs';
import { RICOH_ENTERPRISE, RICOH_TONER_ROOT, decodeRicohWalk } from './vendors/ricoh.mjs';

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
  /** Firmware version, from whichever source had one. */
  firmware: string | null;
  /** The standard table, as the app itself read it. */
  supplies: Supply[];
  /**
   * One branch to read instead of the manufacturer's whole private branch.
   *
   * Null for an ordinary report. A report that stopped at a cap says so and
   * asks its reader to say where to look next; this is what that promise is
   * worth. A Canon owner's report ran out of room part-way through the document
   * their printer keeps its ink levels in — with the root of that document
   * here, the next report starts where the last one stopped instead of hoping
   * the cap falls in a luckier place.
   */
  branch: string | null;
  /** Walks the manufacturer's own branch, bounded. */
  walkVendorBranch(root: string): Promise<BoundedWalk>;
  /** Brother's private branch, raw and decoded — the one brand with a decoder. */
  brotherSection(): Promise<string[]>;
  /** Canon's status document, walked at the root the levels actually live under. */
  canonSection(): Promise<BoundedWalk>;
  /** Ricoh's toner table, walked at the entry the levels actually live under. */
  ricohSection(): Promise<BoundedWalk>;
  /** What the printer answers over IPP. */
  ippSection(): Promise<string[]>;
  /**
   * When this report has to be finished, as an epoch time.
   *
   * A Homey API call is cut off at ten seconds, and a report that overruns is
   * not a late report — it is no report at all, which is exactly what a Canon
   * owner got after the IPP section started running for every brand. Each
   * section that needs the printer is raced against this, so running out of
   * time costs that section and nothing else.
   */
  deadlineAt: number;
}

/**
 * A section, or a note saying it ran out of time.
 *
 * The work is left running rather than cancelled: an SNMP session and an HTTP
 * request each close themselves, and nothing here can hurry a printer. What
 * matters is that the report stops waiting for one.
 */
function inTime(work: Promise<string[]>, deadlineAt: number, ranOut: string[]): Promise<string[]> {
  let timer: NodeJS.Timeout | null = null;

  const clock = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve(ranOut), Math.max(0, deadlineAt - Date.now()));
  });

  return Promise.race([work, clock]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** The lines above the first section: who answered, and how. */
function header(sources: DumpReportSources): string[] {
  const { host, community, version, identity, vendor, firmware } = sources;
  return [
    `# ${[vendor, identity.model].filter(Boolean).join(' ') || host}`,
    `host        ${host}`,
    `snmp        ${version}, community "${community}"`,
    `sysObjectID enterprise ${identity.enterprise ?? 'unknown'}${vendor ? ` (${vendor})` : ''}`,
    `serial      ${identity.serial ?? '—'}`,
    `firmware    ${firmware ?? '—'}`,
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
 * Canon's status document, decoded.
 *
 * A Canon's whole private branch is not where its levels are. It opens with
 * hundreds of rows of network configuration, and the document holding the ink
 * runs past every cap a report can afford — which is exactly what happened to
 * the first Canon owner who sent one in: the report stopped, politely, several
 * hundred rows short of the only thing it was asked for. So a Canon is walked at
 * the document instead of at the branch, and the branch is still one line in the
 * box beside the button for anyone who wants it.
 *
 * The decoded levels come first because they are the answer, and the raw chunks
 * follow only when nothing decoded — a document that parsed needs no dump, and a
 * document that did not is the one case where the bytes are the whole point.
 */
export function formatCanonStatus(walk: BoundedWalk): string[] {
  const lines = [`## Canon status document, ${CANON_STATUS_ROOT}`];

  if (walk.rows.length === 0) {
    lines.push(
      'This Canon answers nothing here. That is a finding rather than a failure: it',
      'means the standard table above is the only place a level could come from, and',
      "the whole private branch — 1.3.6.1.4.1.1602 — is worth a look in the box",
      'beside the report button.',
    );
    return lines;
  }

  const reading = decodeCanonWalk(walk.rows.map((row) => [row.oid, row.value] as const));

  if (!reading.document) {
    lines.push(
      `${walk.rows.length} chunk${walk.rows.length === 1 ? '' : 's'} answered, and none of them`,
      'assembled into a status document this app can read. The bytes follow, which is',
      'what makes this worth pasting: they are what a decoder gets written from.',
      '',
    );
    for (const row of walk.rows) {
      lines.push(row.oid, `      ${renderVendorValue(row.value)}`);
    }
    return lines;
  }

  lines.push(
    `Assembled from ${walk.rows.length} chunk${walk.rows.length === 1 ? '' : 's'}. These are the`,
    "levels the printer's own status monitor reads, and the app fills a standard row",
    'from one only where the standard table gave no number.',
    '',
  );

  for (const ink of reading.inks) {
    lines.push(`${ink.colour}`, `      ${ink.level} %` +
      (ink.model ? ` · ${ink.model}` : '') +
      (ink.icon ? ` · ${ink.icon}` : ''));
  }

  for (const waste of reading.waste) {
    lines.push(
      `waste ink${waste.model ? ` · ${waste.model}` : ''}`,
      `      ${waste.level} — shown, not used. Nothing here says whether this counts`,
      '      down as the tank fills or up, and a maintenance cartridge read backwards',
      '      is a false alarm on a healthy printer. If your printer shows a figure for',
      '      it, say what it is in the topic and it becomes a row.',
    );
  }

  const note = walk.stoppedBy === null ? null
    : 'The document was cut short by a report cap, so the levels above may be'
      + ' incomplete.';
  if (note) lines.push('', note);

  return lines;
}

/**
 * Ricoh's toner table, decoded.
 *
 * The one private branch in this app whose meaning is published rather than
 * inferred, so the report can say what each row is instead of printing bytes
 * and asking. It is still read at the table rather than at the branch, for the
 * reason Canon's document is: 1.3.6.1.4.1.367 was 104 rows on the printer this
 * was written from and will not be on a busy MFP, and the rows that matter must
 * not be the ones a cap eats.
 *
 * The raw level travels beside the percentage because they disagree exactly
 * where something is interesting — a sentinel this app has not met yet shows up
 * as a level with no percentage, in a report its owner can paste.
 */
export function formatRicohToner(walk: BoundedWalk): string[] {
  const lines = [`## Ricoh toner table, ${RICOH_TONER_ROOT}`];

  if (walk.rows.length === 0) {
    lines.push(
      'This Ricoh answers nothing here. That is a finding rather than a failure: it',
      'means the standard table above is the only place a level could come from, and',
      'the whole private branch — 1.3.6.1.4.1.367 — is worth a look in the box',
      'beside the report button.',
    );
    return lines;
  }

  const reading = decodeRicohWalk(walk.rows.map((row) => [row.oid, row.value] as const));

  if (reading.toners.length === 0) {
    lines.push(
      `${walk.rows.length} row${walk.rows.length === 1 ? '' : 's'} answered, and none of them`,
      'is a toner this app could read. The bytes follow, which is what makes this',
      'worth pasting.',
      '',
    );
    for (const row of walk.rows) {
      lines.push(row.oid, `      ${renderVendorValue(row.value)}`);
    }
    return lines;
  }

  lines.push(
    'Ricoh documents this table: the level is a percentage of toner remaining, in',
    'steps of ten, and -100 means near empty — somewhere between 10 % and 1 %. The',
    'app fills a standard row from one of these only where the standard table gave',
    'no number.',
    '',
  );

  for (const toner of reading.toners) {
    const name = toner.descr ?? toner.name ?? `toner ${toner.index}`;
    const colour = toner.colour === null
      ? `type ${toner.type ?? '—'}, which this app does not know`
      : toner.colour;
    lines.push(
      `[${toner.index}] ${name}`,
      `      level ${toner.level ?? '—'} · ${colour} → `
        + (toner.percent === null ? 'no number' : `${toner.percent} %`),
    );
  }

  lines.push(
    '',
    'Only this table is shown, not the rest of 1.3.6.1.4.1.367 — a Ricoh answers',
    'a great deal more under its own branch. If something above looks wrong, put',
    'that number in the box beside the report button and the next report walks it.',
  );

  if (walk.stoppedBy !== null) {
    lines.push('', 'The table was cut short by a report cap, so the toners above may be'
      + ' incomplete.');
  }

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
  const { identity, vendor, branch } = sources;

  // A branch asked for by name is read as asked, whoever made the printer. The
  // Brother decoder below reads six OIDs it knows; that is the opposite of what
  // someone naming a branch wants, and it would silently ignore them.
  if (branch !== null) {
    try {
      return formatVendorWalk(branch, vendor, await sources.walkVendorBranch(branch));
    } catch (error) {
      return [
        `## private branch, ${branch} (${vendor ?? 'this manufacturer'})`,
        `Could not be read: ${(error as Error).message}`,
        'Everything above still stands — it was read before this failed.',
      ];
    }
  }

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

  if (identity.enterprise === CANON_ENTERPRISE) {
    try {
      return formatCanonStatus(await sources.canonSection());
    } catch (error) {
      return [
        `## Canon status document, ${CANON_STATUS_ROOT}`,
        `Could not be read: ${(error as Error).message}`,
        'Everything above still stands — it was read before this failed.',
      ];
    }
  }

  if (identity.enterprise === RICOH_ENTERPRISE) {
    try {
      return formatRicohToner(await sources.ricohSection());
    } catch (error) {
      return [
        `## Ricoh toner table, ${RICOH_TONER_ROOT}`,
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
  const ipp = inTime(
    (async (): Promise<string[]> => {
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
    })(),
    sources.deadlineAt,
    [
      '',
      '## IPP',
      'Not read: the ten seconds a Homey API call gets ran out first. A printer that',
      'answers nothing on port 631 costs one timeout per path tried, which is the',
      'usual reason to see this. Say so in the topic and I will narrow the search.',
    ],
  );

  return [
    ...header(sources),
    ...standardTable(sources.supplies),
    ...await inTime(privateBranch(sources), sources.deadlineAt, [
      '## private branch',
      'Not read: the ten seconds a Homey API call gets ran out first. Everything above',
      'still stands, and the section below was read alongside this one.',
    ]),
    ...await ipp,
  ].join('\n');
}

