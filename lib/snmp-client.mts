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

  private openSession(): snmp.Session {
    return snmp.createSession(this.host, this.community, {
      version: this.version === 'v1' ? snmp.Version1 : snmp.Version2c,
      timeout: this.timeout,
      retries: this.retries,
      port: this.port,
    });
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
      throw new SnmpUnreachableError(this.host, (error as Error).message);
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
        if (/NoSuchName/i.test(message)) reachable = true;
        else lastError = message;
        out.set(oid, null);
      } finally {
        session.close();
      }
    }

    if (!reachable) throw new SnmpUnreachableError(this.host, lastError);
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

    try {
      await new Promise<void>((resolve, reject) => {
        session.subtree(
          rootOid,
          maxRepetitions,
          (varbinds: snmp.Varbind[]) => {
            for (const vb of varbinds) {
              if (!snmp.isVarbindError(vb)) out.set(vb.oid, toValue(vb));
            }
          },
          (error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
      return out;
    } catch (error) {
      throw new SnmpUnreachableError(this.host, (error as Error).message);
    } finally {
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
