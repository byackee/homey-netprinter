/**
 * A small promise wrapper over net-snmp, shaped around what printers actually do.
 *
 * net-snmp is pure JavaScript over dgram, so it runs on Homey without a native
 * build step. Everything here is deliberately tolerant: a printer that is asleep,
 * powered off, or simply missing an optional OID must degrade to "unknown" rather
 * than throw the whole poll away.
 */

// A namespace import, because net-snmp is CommonJS and publishes no default export.
import * as snmp from 'net-snmp';

/** SNMP versions we offer. v3 is out of scope: no printer we target requires it. */
export type SnmpVersion = 'v2c' | 'v1';

export interface SnmpOptions {
  host: string;
  community: string;
  version: SnmpVersion;
  /** Per-attempt timeout in milliseconds. */
  timeout?: number;
  /** Retries *after* the first attempt. */
  retries?: number;
  port?: number;
}

/** A value read from the device, already converted out of net-snmp's Buffer form. */
export type SnmpValue = string | number | Buffer | null;

/** One leaf of a walk: the OID the agent answered on, and what it said. */
export interface WalkRow {
  oid: string;
  value: SnmpValue;
}

/** What a bounded walk collected, and why it stopped. */
export interface BoundedWalk {
  /** Every leaf read, in the order the agent returned them. */
  rows: WalkRow[];
  /**
   * Why the walk stopped before the branch ended, or null when it reached the
   * end on its own.
   *
   * A caller that cannot tell those apart will report a truncated branch as a
   * complete one, which is worse than not walking it at all: it turns "there is
   * more down here" into "there is nothing down here".
   */
  stoppedBy: 'rows' | 'bytes' | 'time' | null;
}

/** The ceilings one bounded walk runs under. Every one of them is optional. */
export interface WalkBudget {
  maxRows?: number;
  /** Counted over OIDs and values, as an estimate of the report's size. */
  maxBytes?: number;
  /** Wall clock. Zero or absent means no clock, only the row and byte caps. */
  budgetMs?: number;
  /** Keep OctetStrings as raw bytes, for branches whose values are structures. */
  keepRaw?: boolean;
}

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_PORT = 161;

/**
 * net-snmp reports strings as Buffers; only the caller knows which it wants.
 * `type` and `value` are both optional in the published typings, and a real
 * agent can omit either, so neither is trusted here.
 */
function toValue(varbind: snmp.Varbind): SnmpValue {
  const value = varbind.value;
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
    // OctetString is the only Buffer type printers use for human-readable text.
    // Latin-1 avoids throwing on the stray high bytes some firmwares emit.
    return varbind.type === snmp.ObjectType.OctetString ? value.toString('latin1').trim() : value;
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** Same as {@link toValue} but keeps OctetStrings as raw bytes, for bit strings. */
function toRaw(varbind: snmp.Varbind): Buffer | null {
  return Buffer.isBuffer(varbind.value) ? varbind.value : null;
}

/** Raised when the device could not be reached at all, as opposed to answering "I do not know". */
/**
 * Whether an SNMP error means "this printer has no such OID" rather than "this
 * printer did not answer".
 *
 * The distinction is the difference between a missing page counter and an
 * offline printer, and getting it wrong costs a user every reading they have.
 */
/**
 * How much of a walk this app will hold before deciding it is not a printer.
 *
 * A supplies table runs to a few dozen rows and an alert table to a handful;
 * five thousand rows or two megabytes is orders of magnitude past anything real
 * while still leaving room for a verbose printer nobody has met yet.
 */
const MAX_WALK_ROWS = 5_000;
const MAX_WALK_BYTES = 2_000_000;

/**
 * Stops an unparseable reply from killing the app.
 *
 * net-snmp reads every inbound datagram on its socket and, when one is not
 * valid SNMP, catches the parse failure and re-emits it as an `error` event.
 * An EventEmitter with no `error` listener rethrows — and that throw happens
 * inside the socket's own message handler, so it lands outside every promise
 * chain this module has. No `try`/`catch` around a `get` or a `walk` can reach
 * it. The process simply dies:
 *
 *   TypeError: Value read as integer null is not an integer
 *       at readInt32 (net-snmp/index.js)
 *       at Message.createFromBuffer
 *       at Session.onMsg
 *       at Socket.emit
 *       at UDP.onMessage
 *
 * Which is what happened: real crash reports from 1.1.3, on a network where
 * something answers port 161 with bytes that are not SNMP. The subnet sweep
 * makes that far likelier than it sounds — it asks 254 addresses at once, and
 * only needs one of them to be a device with different ideas about that port.
 *
 * The in-flight request is deliberately left alone. A malformed datagram
 * carries no request id, so there is nothing to fail; the request times out on
 * its own a moment later, which is the honest outcome. All this does is keep
 * the app alive to see it.
 */
export function guardSession(
  session: { on(event: 'error', listener: (error: Error) => void): unknown },
  onParseError: (message: string) => void = () => {},
): void {
  session.on('error', (error: Error) => {
    onParseError(error?.message ?? String(error));
  });
}

export function isMissingOidError(message: string): boolean {
  return /NoSuchName/i.test(message);
}

export class SnmpUnreachableError extends Error {
  constructor(host: string, cause: string) {
    super(`No SNMP answer from ${host}: ${cause}`);
    this.name = 'SnmpUnreachableError';
  }
}

/**
 * One SNMP conversation with one printer.
 *
 * A session owns a UDP socket, so it must be closed. Sessions are cheap; this
 * class opens one per operation rather than holding one across a poll interval,
 * because a long-lived socket survives neither a Homey app restart nor the
 * printer changing address.
 */
export class SnmpClient {
  private readonly host: string;
  private readonly community: string;
  private readonly version: SnmpVersion;
  private readonly timeout: number;
  /**
   * The last datagram this client could not parse, if any.
   *
   * Kept so a read that times out because something on the network is
   * answering rubbish can say so, rather than looking like a printer that
   * simply did not reply.
   */
  private lastSocketError: string | null = null;
  private readonly retries: number;
  private readonly port: number;

  constructor(options: SnmpOptions) {
    this.host = options.host;
    this.community = options.community;
    this.version = options.version;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.port = options.port ?? DEFAULT_PORT;
  }

  /**
   * Adds what the socket saw to a failure the caller is about to be told about.
   *
   * A timeout and a timeout-because-something-is-shouting-garbage look
   * identical from the outside, and the second one is the only clue anybody
   * gets that the address is answering but is not a printer.
   */
  private explain(message: string): string {
    return this.lastSocketError === null
      ? message
      : `${message} (an unparseable reply also arrived: ${this.lastSocketError})`;
  }

  private openSession(): snmp.Session {
    const session = snmp.createSession(this.host, this.community, {
      version: this.version === 'v1' ? snmp.Version1 : snmp.Version2c,
      timeout: this.timeout,
      retries: this.retries,
      port: this.port,
    });

    guardSession(session, (message) => { this.lastSocketError = message; });
    return session;
  }

  /**
   * Fetches several OIDs at once, mapping each to its value or to null.
   *
   * The whole point of preferring v2c is here. In v1 a single unsupported OID
   * fails the *entire* request with NoSuchName — one missing page counter would
   * cost us the ink levels too. v2c reports the failure per varbind instead, so
   * this method falls back to one request per OID when talking v1.
   */
  async get(oids: string[], keepRaw = false): Promise<Map<string, SnmpValue>> {
    if (oids.length === 0) return new Map();
    if (this.version === 'v1') return this.getOneByOne(oids, keepRaw);

    const session = this.openSession();
    try {
      const varbinds = await new Promise<snmp.Varbind[]>((resolve, reject) => {
        session.get(oids, (error, result) => {
          if (error) reject(error);
          else resolve(result ?? []);
        });
      });

      const out = new Map<string, SnmpValue>();
      oids.forEach((oid, index) => {
        const vb = varbinds[index];
        // NoSuchObject / NoSuchInstance / EndOfMibView all mean "this printer
        // does not have that", which is a null, not a failure.
        if (!vb || snmp.isVarbindError(vb)) out.set(oid, null);
        else out.set(oid, keepRaw ? toRaw(vb) : toValue(vb));
      });
      return out;
    } catch (error) {
      const message = (error as Error).message;

      // Some agents accept a v2c request and then answer it with v1 semantics:
      // one absent OID fails the entire batch with NoSuchName instead of being
      // reported per varbind. A Ricoh MFP that simply omits sysName was
      // therefore reported as unreachable, on a printer that answers fine.
      // One request per OID recovers everything it does have.
      if (isMissingOidError(message)) return this.getOneByOne(oids, keepRaw);

      throw new SnmpUnreachableError(this.host, this.explain(message));
    } finally {
      session.close();
    }
  }

  /** The v1 path: isolate each OID so one unsupported leaf cannot poison the rest. */
  private async getOneByOne(oids: string[], keepRaw: boolean): Promise<Map<string, SnmpValue>> {
    const out = new Map<string, SnmpValue>();
    let reachable = false;
    let lastError = 'no response';

    for (const oid of oids) {
      const session = this.openSession();
      try {
        const varbinds = await new Promise<snmp.Varbind[]>((resolve, reject) => {
          session.get([oid], (error, result) => {
            if (error) reject(error);
            else resolve(result ?? []);
          });
        });
        reachable = true;
        const vb = varbinds[0];
        out.set(oid, !vb || snmp.isVarbindError(vb) ? null : (keepRaw ? toRaw(vb) : toValue(vb)));
      } catch (error) {
        const message = (error as Error).message;
        // NoSuchName is the v1 way of saying the OID is absent — that is a null.
        // A timeout is a different animal and must not look like a supported-but-empty value.
        if (isMissingOidError(message)) reachable = true;
        else lastError = message;
        out.set(oid, null);
      } finally {
        session.close();
      }
    }

    if (!reachable) throw new SnmpUnreachableError(this.host, this.explain(lastError));
    return out;
  }

  /**
   * Walks a subtree and returns every leaf below it.
   *
   * Used for the supplies table, whose row count is exactly what we must not
   * hard-code: a four-cartridge Brother and a nine-cartridge photo printer both
   * come back correct because neither the count nor the indices are assumed.
   */
  async walk(rootOid: string, maxRepetitions = 20): Promise<Map<string, SnmpValue>> {
    const session = this.openSession();
    const out = new Map<string, SnmpValue>();
    let bytes = 0;
    let stopped = false;

    try {
      await new Promise<void>((resolve, reject) => {
        session.subtree(
          rootOid,
          maxRepetitions,
          (varbinds: snmp.Varbind[]) => {
            if (stopped) return;

            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue;
              const value = toValue(vb);
              out.set(vb.oid, value);
              bytes += vb.oid.length + (typeof value === 'string' ? value.length : 8);
            }

            // A walk ends when the agent returns an OID outside the subtree, so
            // the thing answering decides when we stop. That is fine for a
            // printer and not fine in general: the OID space below any branch is
            // unbounded, and anything answering on port 161 can keep returning
            // strictly-increasing OIDs inside it for ever, each carrying a large
            // OctetString. Twelve of these run concurrently per poll, so an
            // agent that answers promptly and endlessly would take the heap
            // without ever tripping the per-request timeout.
            //
            // The caps are far above any real printer — the largest table this
            // app reads is a supplies walk of a few dozen rows — so hitting one
            // means the answer was not a printer's. What was collected is
            // returned rather than thrown away, exactly as a missing branch is.
            if (out.size > MAX_WALK_ROWS || bytes > MAX_WALK_BYTES) {
              stopped = true;
              resolve();
            }
          },
          (error?: Error | null) => {
            if (stopped) return;
            if (error) reject(error);
            else resolve();
          },
        );
      });
      return out;
    } catch (error) {
      const message = (error as Error).message;

      // On a walk, NoSuchName means the branch simply is not there — a printer
      // with no supplies table, say. Whatever rows were collected before that
      // point are still good, and an empty map is a truthful answer.
      if (isMissingOidError(message)) return out;

      throw new SnmpUnreachableError(this.host, this.explain(message));
    } finally {
      session.close();
    }
  }
  /**
   * Walks a subtree under explicit ceilings, and says which one it hit.
   *
   * {@link walk} exists for tables this app knows the shape of, where the only
   * caps are the absurd ones that separate a printer from something else
   * answering on port 161. This is for the opposite case: a branch nobody has
   * read before, walked to show a human what is down there. There the caps are
   * the point. A vendor branch can run to thousands of rows — that is what a
   * user actually hit, on a Brother, and the pages of output they sent back
   * contained the answer in a place neither of us could see.
   *
   * The clock can only be checked between replies, because a walk in flight
   * cannot be interrupted from here. So the real ceiling is the budget plus one
   * request timeout, and that is why the diagnostic gives its client no retries:
   * a retried timeout would double the overrun on the one call that cannot
   * afford it.
   *
   * Whatever was collected before a cap is returned, never thrown away. A
   * partial answer from a printer is worth more than a clean failure.
   */
  async walkBounded(rootOid: string, budget: WalkBudget = {}): Promise<BoundedWalk> {
    const maxRows = Math.min(budget.maxRows ?? MAX_WALK_ROWS, MAX_WALK_ROWS);
    const maxBytes = Math.min(budget.maxBytes ?? MAX_WALK_BYTES, MAX_WALK_BYTES);
    const budgetMs = budget.budgetMs ?? 0;
    const keepRaw = budget.keepRaw ?? false;

    const session = this.openSession();
    const rows: WalkRow[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    let stoppedBy: BoundedWalk['stoppedBy'] = null;
    let stopped = false;
    let clock: ReturnType<typeof setTimeout> | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        const stop = (reason: NonNullable<BoundedWalk['stoppedBy']>) => {
          stopped = true;
          stoppedBy = reason;
          resolve();
        };

        if (budgetMs > 0) {
          clock = setTimeout(() => { if (!stopped) stop('time'); }, budgetMs);
        }

        session.subtree(
          rootOid,
          20,
          (varbinds: snmp.Varbind[]) => {
            if (stopped) return;

            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue;
              // An agent that repeats an OID would otherwise fill the row
              // budget with one value. net-snmp stops on a non-increasing OID,
              // but this walk is pointed at branches nothing has vetted.
              if (seen.has(vb.oid)) continue;
              seen.add(vb.oid);

              const value = keepRaw && Buffer.isBuffer(vb.value) ? vb.value : toValue(vb);
              rows.push({ oid: vb.oid, value });
              bytes += vb.oid.length
                + (typeof value === 'string' ? value.length : Buffer.isBuffer(value) ? value.length * 2 : 8);

              if (rows.length >= maxRows) return stop('rows');
              if (bytes >= maxBytes) return stop('bytes');
            }
          },
          (error?: Error | null) => {
            if (stopped) return;
            if (error) reject(error);
            else resolve();
          },
        );
      });

      return { rows, stoppedBy };
    } catch (error) {
      const message = (error as Error).message;

      // A branch that is simply not there is an answer, and the honest one:
      // this manufacturer publishes nothing of its own. Same reasoning as
      // {@link walk}, and the reason the report can say so in words.
      if (isMissingOidError(message)) return { rows, stoppedBy };

      throw new SnmpUnreachableError(this.host, this.explain(message));
    } finally {
      if (clock) clearTimeout(clock);
      session.close();
    }
  }

}

/**
 * Finds a version the printer answers on, preferring v2c for its per-varbind
 * error reporting. Returns null when neither version gets a reply, which is what
 * pairing shows the user as "not reachable".
 */
export async function negotiateVersion(
  host: string,
  community: string,
  timeout = 4_000,
): Promise<SnmpVersion | null> {
  const probe = '1.3.6.1.2.1.1.1.0'; // sysDescr.0 — every SNMP agent has it.

  for (const version of ['v2c', 'v1'] as const) {
    const client = new SnmpClient({ host, community, version, timeout, retries: 0 });
    try {
      const result = await client.get([probe]);
      if (result.get(probe) !== null) return version;
    } catch {
      // Try the next version; the caller only cares whether any of them worked.
    }
  }
  return null;
}
