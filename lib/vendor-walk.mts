/**
 * A bounded look under a manufacturer's own branch, for the diagnostic report.
 *
 * The report already answers "what does the standard table say", and for one
 * brand it answers "what does the private branch say" as well — by reading six
 * OIDs known by name. That asymmetry was the gap. A Canon owner whose supplies
 * never appear got a report that told them, politely, that nothing more was
 * known about Canon; the only way forward was still to install a command-line
 * SNMP tool and paste pages of output, which is precisely what the report was
 * built to end. The tool helped exactly the brand that no longer needed it.
 *
 * So an unknown brand gets its branch walked instead of skipped. Not the full
 * walk that failed a user last week — that ran to thousands of lines, would not
 * finish inside the ten seconds a Homey API call gets, and buried the value
 * that mattered. A walk with a row cap, a byte cap and a clock is a different
 * proposition: it answers in a fixed time, produces something a forum post can
 * hold, and says out loud when it stopped early rather than pretending the
 * branch ended there.
 *
 * Nothing here decodes anything. A branch nobody has met yet has no decoder by
 * definition, and inventing one from a single report is how a vendor quirk
 * becomes a wrong reading on somebody else's printer. This prints bytes.
 */

import type { BoundedWalk, SnmpValue } from './snmp-client.mjs';

/**
 * The budget one report gets.
 *
 * The clock is the binding constraint: the endpoint has already spent time
 * negotiating a version and taking a full reading, and the whole call is cut
 * off at ten seconds. Four seconds leaves room for both and for the reply.
 *
 * The row and byte caps exist for the reader rather than the clock. A forum
 * post holds about thirty thousand characters, and a report nobody can paste
 * is a report that does not arrive.
 */
export const VENDOR_WALK = {
  maxRows: 250,
  maxBytes: 20_000,
  budgetMs: 4_000,
  /** Longest rendering of a single value, in characters. 512 hex digits = 256 bytes. */
  maxValueChars: 512,
} as const;

/** The private branch of one IANA enterprise number. */
export function vendorWalkRoot(enterprise: number): string {
  return `1.3.6.1.4.1.${enterprise}`;
}

/** True when a buffer is text a human can read, rather than a packed structure. */
function isPrintable(value: Buffer): boolean {
  if (value.length === 0) return false;
  for (const byte of value) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return true;
}

/**
 * One value, rendered so that nothing a printer answered is lost.
 *
 * Text is shown as text because that is what a model string is, and hex for a
 * model string would make the report unreadable. Everything else is shown as
 * hex because that is what a packed structure is, and Brother's toner
 * percentage lives in exactly such a structure — decoding it needed the bytes,
 * not a lossy transcription of them.
 */
export function renderVendorValue(
  value: SnmpValue | boolean,
  maxChars: number = VENDOR_WALK.maxValueChars,
): string {
  if (value === null) return '(no answer)';
  if (typeof value === 'number') return String(value);
  // Booleans arrive only from IPP, which has a tag for them where SNMP would
  // send an integer. The report prints both sides of the diagnostic, so the
  // renderer has to speak for both.
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  const buffer = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  // An empty OctetString is a real answer — the printer has that OID and left it
  // blank — and rendering it as nothing at all would read as a formatting bug.
  if (buffer.length === 0) return '(empty)';
  if (isPrintable(buffer)) {
    const text = buffer.toString('latin1');
    return text.length > maxChars ? `"${text.slice(0, maxChars)}" … (${text.length} characters)` : `"${text}"`;
  }

  const hex = buffer.toString('hex');
  return hex.length > maxChars
    ? `${hex.slice(0, maxChars)} … (${buffer.length} bytes)`
    : hex;
}

/** Why a walk stopped, said in a sentence a user can act on. */
function stopNote(stoppedBy: BoundedWalk['stoppedBy']): string | null {
  switch (stoppedBy) {
    case 'rows':
      return `Stopped at ${VENDOR_WALK.maxRows} rows — this branch has more. Say so in the`
        + ' topic and I will point the next report at the part that matters.';
    case 'bytes':
      return 'Stopped once the report reached the size a forum post can hold — this branch'
        + ' has more. Say so in the topic and I will narrow the next one.';
    case 'time':
      return 'Stopped when the time a Homey API call can spare ran out — this branch has'
        + ' more. Say so in the topic and I will narrow the next one.';
    default:
      return null;
  }
}

/**
 * The private-branch section of a report, as lines.
 *
 * Kept apart from the endpoint so it can be tested without a printer, and so
 * the wording stays in one place: this text is read by people who are doing us
 * a favour, and it has to be worth their time to paste.
 */
export function formatVendorWalk(
  root: string,
  vendor: string | null,
  walk: BoundedWalk,
  maxValueChars: number = VENDOR_WALK.maxValueChars,
): string[] {
  const who = vendor ?? 'this manufacturer';
  const lines = [`## private branch, ${root} (${who})`];

  if (walk.rows.length === 0) {
    lines.push(
      `${who} answers nothing under its own branch, so everything above is all this`,
      'printer will say. That is a finding, not a failure: it means the standard table',
      'is the only place a level could come from.',
    );
    return lines;
  }

  lines.push(
    `${walk.rows.length} row${walk.rows.length === 1 ? '' : 's'}. Nothing here is decoded —`,
    'these are the printer\'s own answers, which is what makes them worth reading.',
    '',
  );

  for (const row of walk.rows) {
    lines.push(row.oid, `      ${renderVendorValue(row.value, maxValueChars)}`);
  }

  const note = stopNote(walk.stoppedBy);
  if (note) lines.push('', note);

  return lines;
}
