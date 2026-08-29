/**
 * A small IPP client, shaped around the one question this app asks a printer.
 *
 * SNMP is what this app reads, and where a printer implements the Printer-MIB
 * properly there is nothing IPP can add: the MIB carries alerts, covers, media
 * names and page counts that IPP either models poorly or not at all. The reason
 * this module exists is coverage, not depth. Homey's own discovery watches
 * `_ipp._tcp`, which AirPrint and Mopria both require, so every printer this app
 * *finds* speaks IPP by construction — and then the driver refuses to pair it
 * unless it also answers SNMP, which more and more printers ship with turned
 * off. The app was discovering printers over one protocol and then declining to
 * read them over it.
 *
 * The two are closer than they look. IPP's supply levels use the same sentinels
 * as RFC 3805 — -1 unavailable, -2 unknown, -3 present but unquantified — so the
 * arithmetic this app already does on a Printer-MIB row applies unchanged. This
 * is a second way of asking the same question, not a second model of a printer.
 *
 * Nothing here knows what a supply is. Encoding, one HTTP round trip, decoding:
 * the mapping onto this app's idea of a printer lives in ipp-printer.mts, for
 * the same reason snmp-client.mts knows nothing about the Printer-MIB.
 *
 * No dependency. IPP's encoding (RFC 8010) is a tag, a name, a length and a
 * value, repeated — small enough that a library would be more surface than the
 * protocol it wraps, and every published one drags in a transport stack Homey
 * does not need.
 */

import * as http from 'node:http';

/** A value as it came off the wire, converted no further than its tag allows. */
export type IppValue = string | number | boolean | Buffer | null;

/**
 * The printer-attributes group of a reply, by attribute name.
 *
 * A list per name because IPP attributes are 1setOf by nature: `marker-levels`
 * is one attribute holding one number per cartridge, and the cartridges are
 * identified only by their position in that list.
 */
export type IppAttributes = Map<string, IppValue[]>;

/** Raised when the far end answered, but not with IPP. */
export class IppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IppError';
  }
}

const OPERATION_GET_PRINTER_ATTRIBUTES = 0x000b;

/** Delimiter tags (RFC 8010 §3.5.1). Everything below 0x10 delimits a group. */
const TAG_END_OF_ATTRIBUTES = 0x03;
const TAG_OPERATION_ATTRIBUTES = 0x01;
const TAG_PRINTER_ATTRIBUTES = 0x04;
const LAST_DELIMITER_TAG = 0x05;

/** Value tags this module converts. Anything else is handed back as bytes. */
const TAG_UNSUPPORTED = 0x10;
const TAG_UNKNOWN = 0x12;
const TAG_NO_VALUE = 0x13;
const TAG_INTEGER = 0x21;
const TAG_BOOLEAN = 0x22;
const TAG_ENUM = 0x23;
const TAG_TEXT_WITH_LANGUAGE = 0x35;
const TAG_NAME_WITH_LANGUAGE = 0x36;
const TAG_BEG_COLLECTION = 0x34;
const TAG_END_COLLECTION = 0x37;
const TAG_KEYWORD = 0x44;
const TAG_URI = 0x45;
const TAG_CHARSET = 0x47;
const TAG_NATURAL_LANGUAGE = 0x48;

/** Tags whose value is text, and can be read as such. */
const TEXT_TAGS = new Set([0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a]);

/** One name/value attribute, encoded. A name of '' makes it an extra value of the previous one. */
function attribute(tag: number, name: string, value: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(nameBytes.length, 1);
  head.writeUInt16BE(value.length, 3);
  // The value length sits *after* the name on the wire, so the header is split.
  return Buffer.concat([
    head.subarray(0, 3),
    nameBytes,
    head.subarray(3, 5),
    value,
  ]);
}

function textAttribute(tag: number, name: string, value: string): Buffer {
  return attribute(tag, name, Buffer.from(value, 'utf8'));
}

/**
 * A Get-Printer-Attributes request.
 *
 * IPP/1.1 rather than 2.0: a 2.0 printer answers a 1.1 request, and a printer
 * old enough to speak only 1.1 is exactly the one whose SNMP is most likely to
 * be the thing that failed.
 *
 * The three operation attributes are required, in this order, by RFC 8011 —
 * charset and language first, then the printer being asked about. Several
 * printers reject a request that reorders them.
 */
export function encodeGetPrinterAttributes(
  printerUri: string,
  requested: readonly string[] = [],
  requestId = 1,
): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt8(1, 1);
  header.writeUInt16BE(OPERATION_GET_PRINTER_ATTRIBUTES, 2);
  header.writeUInt32BE(requestId, 4);

  const parts: Buffer[] = [
    header,
    Buffer.from([TAG_OPERATION_ATTRIBUTES]),
    textAttribute(TAG_CHARSET, 'attributes-charset', 'utf-8'),
    textAttribute(TAG_NATURAL_LANGUAGE, 'attributes-natural-language', 'en'),
    textAttribute(TAG_URI, 'printer-uri', printerUri),
  ];

  // An extra value of a 1setOf carries an empty name — which is how one
  // attribute holds a list, and why the first one is written differently.
  requested.forEach((name, index) => {
    parts.push(textAttribute(TAG_KEYWORD, index === 0 ? 'requested-attributes' : '', name));
  });

  parts.push(Buffer.from([TAG_END_OF_ATTRIBUTES]));
  return Buffer.concat(parts);
}

/** What a reply carried. */
export interface IppResponse {
  /** RFC 8011 status: anything under 0x0100 is a success. */
  statusCode: number;
  /** The printer-attributes group, flattened by name. */
  attributes: IppAttributes;
}

/** True when a status code means the printer did what was asked. */
export function isSuccessful(statusCode: number): boolean {
  return statusCode < 0x0100;
}

function decodeValue(tag: number, raw: Buffer): IppValue {
  switch (tag) {
    case TAG_INTEGER:
    case TAG_ENUM:
      return raw.length === 4 ? raw.readInt32BE(0) : null;
    case TAG_BOOLEAN:
      return raw.length === 1 ? raw.readUInt8(0) !== 0 : null;
    // "This attribute exists and I will not give you a value" — the same
    // distinction the Printer-MIB draws with -2, and it must survive as a null
    // rather than becoming a zero.
    case TAG_UNSUPPORTED:
    case TAG_UNKNOWN:
    case TAG_NO_VALUE:
      return null;
    case TAG_TEXT_WITH_LANGUAGE:
    case TAG_NAME_WITH_LANGUAGE: {
      // A length-prefixed language, then a length-prefixed string. Only the
      // string is of any use here.
      if (raw.length < 4) return null;
      const languageLength = raw.readUInt16BE(0);
      const textStart = 2 + languageLength + 2;
      if (raw.length < textStart) return null;
      const textLength = raw.readUInt16BE(2 + languageLength);
      return raw.subarray(textStart, textStart + textLength).toString('utf8');
    }
    default:
      if (TEXT_TAGS.has(tag)) return raw.toString('utf8');
      // octetString, dateTime, resolution, rangeOfInteger and anything this
      // module has not met. Bytes are the honest answer for all of them, and
      // the diagnostic prints them as such.
      return raw;
  }
}

/**
 * Reads a reply into its printer attributes.
 *
 * The encoding is self-delimiting — every value states its own length — so this
 * walks it linearly and cannot lose its place, whatever the tags mean. That is
 * what makes it safe to point at a printer nobody has tested: an attribute this
 * module has never heard of costs it a `default:` branch, not a desync.
 *
 * Collections are stepped over rather than decoded. `media-col-database` alone
 * can hold hundreds of them, none of which says anything about ink, and a
 * half-decoded collection would be worse than no collection at all.
 */
export function decodeResponse(buffer: Buffer): IppResponse {
  if (buffer.length < 8) throw new IppError('reply too short to be IPP');

  const statusCode = buffer.readUInt16BE(2);
  const attributes: IppAttributes = new Map();

  let offset = 8;
  let group = 0;
  let currentName: string | null = null;
  let collectionDepth = 0;

  while (offset < buffer.length) {
    const tag = buffer.readUInt8(offset);
    offset += 1;

    if (tag === TAG_END_OF_ATTRIBUTES) break;
    if (tag <= LAST_DELIMITER_TAG) {
      group = tag;
      currentName = null;
      continue;
    }

    if (offset + 2 > buffer.length) break;
    const nameLength = buffer.readUInt16BE(offset);
    offset += 2;
    if (offset + nameLength + 2 > buffer.length) break;
    const name = buffer.subarray(offset, offset + nameLength).toString('utf8');
    offset += nameLength;

    const valueLength = buffer.readUInt16BE(offset);
    offset += 2;
    if (offset + valueLength > buffer.length) break;
    const raw = buffer.subarray(offset, offset + valueLength);
    offset += valueLength;

    if (tag === TAG_BEG_COLLECTION) {
      collectionDepth += 1;
      if (nameLength > 0) currentName = name;
      continue;
    }
    if (tag === TAG_END_COLLECTION) {
      collectionDepth = Math.max(0, collectionDepth - 1);
      continue;
    }
    if (collectionDepth > 0) continue;

    if (nameLength > 0) currentName = name;
    if (currentName === null) continue;
    // Only the printer's own attributes. An operation group echoes back the
    // charset it was asked in, which is nobody's idea of a reading.
    if (group !== TAG_PRINTER_ATTRIBUTES) continue;

    const values = attributes.get(currentName) ?? [];
    values.push(decodeValue(tag, raw));
    attributes.set(currentName, values);
  }

  return { statusCode, attributes };
}

export interface IppOptions {
  host: string;
  port?: number;
  /** The resource path, e.g. `/ipp/print`. mDNS publishes it as `rp`. */
  path?: string;
  timeout?: number;
}

/** The paths worth trying when the printer has not told us its own. */
export const IPP_PATHS: readonly string[] = ['/ipp/print', '/', '/ipp/printer', '/ipp'];

const DEFAULT_PORT = 631;
const DEFAULT_TIMEOUT = 4_000;
/** A reply larger than this is not a printer describing itself. */
const MAX_REPLY_BYTES = 2_000_000;

/** One IPP conversation with one printer. */
export class IppClient {
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private readonly timeout: number;

  constructor(options: IppOptions) {
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    this.path = options.path ?? IPP_PATHS[0];
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /** The URI the printer is asked to describe — its own name for itself. */
  get printerUri(): string {
    return `ipp://${this.host}:${this.port}${this.path}`;
  }

  /**
   * Asks the printer to describe itself.
   *
   * `requested` is honoured by well-behaved printers and ignored by the rest,
   * which simply answer with everything. Both are fine: the mapping reads the
   * attributes it knows by name and steps over the rest.
   */
  async getPrinterAttributes(requested: readonly string[] = []): Promise<IppResponse> {
    const body = encodeGetPrinterAttributes(this.printerUri, requested);
    const reply = await this.post(body);
    return decodeResponse(reply);
  }

  private post(body: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const request = http.request(
        {
          host: this.host,
          port: this.port,
          path: this.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/ipp',
            'Content-Length': body.length,
          },
          timeout: this.timeout,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            response.resume();
            reject(new IppError(`${this.host}${this.path} answered HTTP ${status}`));
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            // A printer cannot describe itself in two megabytes, so something
            // else is on the other end. Stop reading rather than grow the heap
            // on an app that also sweeps a whole subnet.
            if (size > MAX_REPLY_BYTES) {
              response.destroy();
              reject(new IppError(`${this.host} sent more than a printer description`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', (error: Error) => reject(new IppError(error.message)));
        },
      );

      // A printer asleep behind a switch accepts the connection and then says
      // nothing. Without this the request would hang until Node's own socket
      // timeout, long past the point the caller had given up.
      request.on('timeout', () => {
        request.destroy(new IppError(`${this.host} did not answer within ${this.timeout} ms`));
      });
      request.on('error', (error: Error) => {
        reject(error instanceof IppError ? error : new IppError(error.message));
      });

      request.end(body);
    });
  }
}

/**
 * Finds the path a printer answers IPP on, and reads it.
 *
 * `/ipp/print` is what IPP Everywhere requires and what nearly everything uses,
 * but a printer that predates the requirement may answer only on `/`. Trying a
 * short list costs one refused connection each and is the difference between
 * supporting that printer and telling its owner it does not speak IPP.
 *
 * A refused connection is instant; a dropped packet is not. On a printer behind
 * a firewall that answers nothing on port 631, every path costs its full
 * timeout, and four of them outlast the ten seconds a Homey API call gets — so
 * a caller working to a deadline passes it here rather than discovering
 * afterwards that the search alone spent the whole budget.
 */
export async function probeIpp(
  host: string,
  requested: readonly string[] = [],
  timeout?: number,
  paths: readonly string[] = IPP_PATHS,
  deadlineAt?: number,
): Promise<{ client: IppClient; response: IppResponse } | null> {
  for (const path of paths) {
    const remaining = deadlineAt === undefined ? null : deadlineAt - Date.now();
    if (remaining !== null && remaining <= 0) return null;

    const attempt = remaining === null
      ? timeout
      : Math.min(timeout ?? DEFAULT_TIMEOUT, remaining);
    const client = new IppClient({ host, path, timeout: attempt });
    try {
      const response = await client.getPrinterAttributes(requested);
      if (isSuccessful(response.statusCode) && response.attributes.size > 0) {
        return { client, response };
      }
    } catch {
      // Wrong path, no IPP, or nothing there at all. The next path decides.
    }
  }
  return null;
}
