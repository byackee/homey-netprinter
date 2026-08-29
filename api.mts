/**
 * The app's own HTTP API, backing the settings page.
 *
 * This exists because an app installed with `homey app install` has no readable
 * log anywhere: Developer Tools lists only App Store submissions, and the CLI
 * has no log command. Without an endpoint like this, a failing SNMP read is
 * completely opaque to the user — and to anyone debugging it later.
 */

import type Homey from 'homey';

import type NetworkPrinterApp from './app.mjs';
import type PrinterDevice from './drivers/printer/device.mjs';

import type { Supply } from './lib/printer-mib.mjs';
import type { SnmpVersion } from './lib/snmp-client.mjs';

import { PrinterReader } from './lib/printer-reader.mjs';
import { INPUT_SHEETS_REMAINING, classifyOutputTray } from './lib/printer-mib.mjs';
import { SnmpClient, negotiateVersion } from './lib/snmp-client.mjs';
import { buildDumpReport } from './lib/report.mjs';
import { subnetOf } from './lib/network-scan.mjs';
import { vendorName } from './lib/vendors.mjs';
import { VENDOR_WALK, renderVendorValue } from './lib/vendor-walk.mjs';
import { probeIpp } from './lib/ipp-client.mjs';
import { IPP_ATTRIBUTES, ippReading } from './lib/ipp-printer.mjs';
import {
  BROTHER_OIDS,
  decodeBrotherReading,
  printerKindFrom,
} from './lib/vendors/brother.mjs';

/**
 * A Homey API call is cut off after ten seconds. Every endpoint here has to
 * answer well inside that, which is why the subnet sweep is started rather than
 * awaited, and why reads use a short timeout with no retry.
 */
const API_READ_TIMEOUT_MS = 2_500;

/**
 * What the report is allowed to spend, of the ten seconds Homey allows.
 *
 * The remaining two are for assembling and returning it. Every step of a report
 * now works to this one deadline rather than to a budget of its own, because
 * the budgets were what overran: a version negotiation, a full read, a bounded
 * walk and an IPP search each had a defensible limit, and their sum did not
 * fit. A Canon owner on 1.3.1 pressed the button and got a timeout where 1.3.0
 * had given them a report.
 */
const REPORT_BUDGET_MS = 8_000;

/**
 * How many IPP attributes one report prints.
 *
 * A printer asked for everything answers with a hundred-odd attributes, most of
 * them about page sizes. Enough to hold every supply and status attribute there
 * is, and short of the point where nobody reads the report.
 */
const IPP_REPORT_ATTRIBUTES = 80;

/**
 * An OID and nothing else.
 *
 * This value is walked on the user's own network, so it is checked rather than
 * trusted: numbers separated by dots is the whole of what an OID is, and
 * anything else is a mistake worth naming before a printer is asked about it.
 */
const OID_SHAPE = /^\d+(\.\d+)+$/;

/** The shape Homey hands every endpoint. */
interface Request {
  homey: NetworkPrinterApp['homey'];
  body: Record<string, unknown>;
  query: Record<string, string>;
  params: Record<string, string>;
}

/** What the settings page shows for each paired printer. */
interface DeviceReport {
  name: string;
  host: string;
  version: string;
  available: boolean;
  /** The live reading, or the reason it could not be taken. */
  reading?: {
    model: string | null;
    /** Firmware version, as the printer writes it. */
    firmware: string | null;
    status: string;
    display: string | null;
    pages: number | null;
    errors: string[];
    /**
     * The raw level and capacity travel alongside the percentage on purpose. A
     * printer whose alarm fires while every visible level reads fine is exactly
     * the case the percentage cannot explain, and the two numbers it was derived
     * from can.
     */
    supplies: Array<{
      description: string;
      colour: string;
      percent: number | null;
      level: number;
      maxCapacity: number;
      unit: string;
      /** prtMarkerSuppliesClass: 3 counts down as it is used, 4 counts up as it fills. */
      supplyClass: number | null;
      receptacle: boolean;
      /** The printer says there is some left but will not put a number on it. */
      someRemaining: boolean;
      /** The percentage came from the manufacturer's private branch, not the standard table. */
      vendorSourced: boolean;
      /** The percentage came from the printer's IPP reply, not from SNMP. */
      ippSourced: boolean;
    }>;
    trays: Array<{
      name: string;
      media: string;
      percent: number | null;
      someRemaining: boolean;
    }>;
    /**
     * What the device currently holds, next to what the printer just said.
     *
     * The page read the printer live and never showed the other half, so a
     * capability stuck on an old value looked identical to a printer still
     * reporting it. A user spent an evening on that distinction.
     */
    stored: { message: string | null; status: string | null };
    /**
     * The capability ids this device actually carries.
     *
     * The one thing the page could never show, and the thing that made a
     * migration impossible to diagnose from outside: a device holding the ids
     * of a previous release looks identical, from the printer's side, to one
     * that migrated cleanly.
     */
    capabilities: string[];
    /** When the device itself last polled, and how that went. */
    lastPoll: { at: string; outcome: string; capabilityErrors: string[] } | null;
    outputTray: string;
    covers: Array<{ description: string; open: boolean }>;
    /** What the printer itself says is wrong, in its own words. */
    alerts: string[];
  };
  error?: string;
}

/**
 * Reports every paired printer, reading each one live rather than echoing the
 * last known capability values — the point is to show whether the printer
 * answers *now*.
 */
async function getDiagnostics({ homey }: Request): Promise<{
  subnet: string | null;
  driverCapabilities: string[] | null;
  devices: DeviceReport[];
}> {
  const driver = homey.drivers.getDriver('printer');
  const devices = driver.getDevices();

  const localAddress = await homey.cloud.getLocalAddress().catch(() => '');
  const subnet = subnetOf(String(localAddress));

  const reports = await Promise.all(devices.map(async (device: Homey.Device): Promise<DeviceReport> => {
    const host = String(device.getSetting('host') ?? '');
    const community = String(device.getSetting('community') ?? 'public');
    const version = String(device.getSetting('version') ?? 'v2c');

    const base = {
      name: device.getName(),
      host,
      version,
      available: device.getAvailable(),
    };

    try {
      // A short timeout, because one unreachable printer must not push the
      // whole page past the ten-second API limit.
      const snapshot = await new PrinterReader(
        host,
        community,
        version === 'v1' ? 'v1' : 'v2c',
        API_READ_TIMEOUT_MS,
      ).read();

      return {
        ...base,
        reading: {
          model: snapshot.model,
          firmware: snapshot.firmware,
          status: snapshot.status,
          display: snapshot.displayText,
          pages: snapshot.pageCount,
          errors: snapshot.errors,
          supplies: snapshot.supplies.map((s) => ({
            description: s.description,
            colour: s.colour,
            percent: s.percent,
            level: s.level,
            maxCapacity: s.maxCapacity,
            unit: s.unit,
            supplyClass: s.supplyClass,
            receptacle: s.isReceptacle,
            someRemaining: s.someRemaining,
            vendorSourced: s.vendorSourced === true,
            ippSourced: s.ippSourced === true,
          })),
          trays: snapshot.inputTrays.map((t) => ({
            name: t.name,
            media: t.media,
            percent: t.percent,
            // A tray reporting -3 has paper it will not count, which is a
            // different thing from a tray that cannot be read at all.
            someRemaining: t.level === INPUT_SHEETS_REMAINING,
          })),
          stored: {
            message: device.hasCapability('printer_message')
              ? (device.getCapabilityValue('printer_message') as string | null) : null,
            status: device.hasCapability('printer_status')
              ? (device.getCapabilityValue('printer_status') as string | null) : null,
          },
          capabilities: device.getCapabilities(),
          lastPoll: (device as PrinterDevice).pollReport(),
          outputTray: classifyOutputTray(snapshot.outputTrays, snapshot.errors),
          covers: snapshot.covers.map((c) => ({ description: c.description, open: c.open })),
          alerts: snapshot.alerts
            .map((a) => a.description.trim())
            .filter((d) => d.length > 0),
        },
      };
    } catch (error) {
      return { ...base, error: (error as Error).message };
    }
  }));

  // What the driver says it declares, which is what an existing device is
  // brought up to on init. Reported because a silent mismatch here is
  // invisible from every other angle: a device simply never gains the row.
  const declared = (driver.manifest as { capabilities?: string[] } | undefined)?.capabilities ?? null;

  return { subnet, driverCapabilities: declared, devices: reports };
}

/** One sweep result as the settings page consumes it. */
interface ScanReply {
  running: boolean;
  subnet: string | null;
  error: string | null;
  found: Array<{ host: string; model: string | null; serial: string | null; vendor: string | null }>;
}

function scanReply(state: {
  running: boolean;
  subnet: string | null;
  error: string | null;
  found: Array<{ host: string; model: string | null; serial: string | null; vendor: string | null }>;
}): ScanReply {
  return {
    running: state.running,
    subnet: state.subnet,
    error: state.error,
    found: state.found.map((p) => ({
      host: p.host, model: p.model, serial: p.serial, vendor: p.vendor,
    })),
  };
}

/**
 * Starts a subnet sweep and returns at once.
 *
 * Awaiting the sweep here is what made the settings page fail with a ten-second
 * timeout: a /24 takes around sixteen. The app owns the sweep; this only kicks
 * it off, and `getScan` reports progress.
 */
async function postScan({ homey }: Request): Promise<ScanReply> {
  const app = homey.app as NetworkPrinterApp;
  return scanReply(await app.startScan());
}

/** Reports the running or last-finished sweep, including partial results. */
async function getScan({ homey }: Request): Promise<ScanReply> {
  const app = homey.app as NetworkPrinterApp;
  return scanReply(app.getScanState());
}

/** Tests one address, reporting exactly what it answered — or exactly why it did not. */
async function postTest({ body }: Request): Promise<{
  ok: boolean;
  message?: string;
  version?: string;
  model?: string | null;
  vendor?: string | null;
  serial?: string | null;
  supplies?: Array<{ description: string; percent: number | null }>;
}> {
  const host = String(body.host ?? '').trim();
  const community = String(body.community ?? 'public').trim() || 'public';

  if (!host) return { ok: false, message: 'Enter an IP address.' };

  // Two versions tried at this timeout each, then one read: comfortably inside
  // the ten seconds the API allows.
  const version = await negotiateVersion(host, community, API_READ_TIMEOUT_MS);

  // No SNMP is no longer the end of the conversation. The reply is assembled
  // from the probe itself rather than by handing the address to a reader: a
  // reader would look for the endpoint all over again, and this endpoint has
  // already spent five seconds finding out that SNMP is silent.
  if (version === null) {
    const found = await probeIpp(host, IPP_ATTRIBUTES, API_READ_TIMEOUT_MS, ['/ipp/print', '/'])
      .catch(() => null);
    if (found === null) {
      return { ok: false, message: `No SNMP or IPP answer from ${host}.` };
    }

    const reading = ippReading(found.response.attributes);
    return {
      ok: true,
      version: 'ipp',
      model: reading.model,
      vendor: null,
      serial: reading.serial,
      supplies: reading.supplies.map((s) => ({ description: s.description, percent: s.percent })),
    };
  }

  try {
    const reader = new PrinterReader(host, community, version, API_READ_TIMEOUT_MS);
    const identity = await reader.readIdentity();
    const snapshot = await reader.read();

    return {
      ok: true,
      version,
      model: identity.model,
      vendor: vendorName(identity.enterprise),
      serial: identity.serial,
      supplies: snapshot.supplies.map((s) => ({ description: s.description, percent: s.percent })),
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/**
 * What the pairing view did, and what Homey's mDNS discovery currently sees.
 *
 * Both are otherwise unobservable: a CLI-installed app has no readable log, so a
 * pairing view that quietly does nothing gives no clue why, and discovery
 * failing shows no symptom until a printer changes address.
 */
async function getTrace({ homey }: Request): Promise<{
  trace: string[];
  announced: Array<{ address: string; name: string; model: string | null }>;
}> {
  const driver = homey.drivers.getDriver('printer') as unknown as {
    getTrace(): string[];
    announcedPrinters(): Array<{ address: string; name: string; model: string | null }>;
  };
  return { trace: driver.getTrace(), announced: driver.announcedPrinters() };
}

/**
 * Dumps what one printer answers, on every protocol it answers on, as text a
 * user can copy into a bug report.
 *
 * This endpoint exists because of how the last gap was actually diagnosed. The
 * only way to see a private OID was to ask the owner to install a command-line
 * SNMP tool, work out the argument syntax for their platform, and screenshot
 * pages of output — and what came back was the wrong pages, through no fault of
 * theirs. A button that reads the same thing from Homey, on the network the
 * printer is already on, removes every one of those steps.
 *
 * What goes into the report, and in what order, is decided in lib/report.mts.
 * Everything here is wiring: this function knows how to reach a printer, and
 * nothing about which sections a report has. That split is the fix for a report
 * that used to end at the private branch for every brand but one — see the note
 * at the top of that module.
 */
async function postDump({ homey, body }: Request): Promise<{
  ok: boolean;
  message?: string;
  text?: string;
}> {
  const deadlineAt = Date.now() + REPORT_BUDGET_MS;

  const host = String(body.host ?? '').trim();
  const community = String(body.community ?? 'public').trim() || 'public';
  const branch = String(body.branch ?? '').trim();

  if (!host) return { ok: false, message: 'Enter an IP address.' };
  if (branch !== '' && !OID_SHAPE.test(branch)) {
    return { ok: false, message: `"${branch}" is not an OID. Numbers separated by dots, e.g. 1.3.6.1.4.1.1602.1.5.` };
  }

  // A printer already paired has been read for months on a version somebody
  // negotiated once. Asking again costs a full timeout on every printer that
  // answers only v1 — a third of the whole budget, spent to learn what the
  // device settings already say.
  const paired = pairedVersion(homey, host);
  let version = paired ?? await negotiateVersion(host, community, API_READ_TIMEOUT_MS);
  if (version === null) {
    return { ok: false, message: `No SNMP answer from ${host} on v2c or v1.` };
  }

  let reader = new PrinterReader(host, community, version, API_READ_TIMEOUT_MS, deadlineAt);
  let identity = await reader.readIdentity().catch(() => null);

  // The stored version is a shortcut, not a fact: a printer whose firmware
  // update switched v2c off still carries whatever it was paired on. Ask
  // properly rather than hand back a report of a printer that "does not
  // answer" — which is the state this whole endpoint exists to explain.
  if (identity === null && paired !== null) {
    const found = await negotiateVersion(host, community, API_READ_TIMEOUT_MS);
    if (found === null) {
      return { ok: false, message: `No SNMP answer from ${host} on v2c or v1.` };
    }
    // The header says which version answered, and the sections below are read
    // on it — a report naming the version that failed would be worse than none.
    version = found;
    reader = new PrinterReader(host, community, version, API_READ_TIMEOUT_MS, deadlineAt);
    identity = await reader.readIdentity();
  }
  if (identity === null) throw new Error(`No answer from ${host}`);

  const snapshot = await reader.read();

  const text = await buildDumpReport({
    host,
    community,
    version,
    identity,
    firmware: snapshot.firmware,
    vendor: vendorName(identity.enterprise),
    supplies: snapshot.supplies,
    branch: branch === '' ? null : branch,
    deadlineAt,
    // No retries: the clock in walkBounded can only be checked between replies,
    // so a retried timeout is the one thing that can still overrun the ten
    // seconds this call gets.
    walkVendorBranch: (root) => new SnmpClient({
      host, community, version, timeout: API_READ_TIMEOUT_MS, retries: 0,
    }).walkBounded(root, { ...VENDOR_WALK, budgetMs: walkBudgetMs(deadlineAt), keepRaw: true }),
    brotherSection: () => brotherSection(host, community, version, snapshot.supplies),
    ippSection: () => ippSection(host, deadlineAt),
  });

  return { ok: true, text };
}

/**
 * The SNMP version a paired device is already read on, when this address is one.
 *
 * Null for an address nobody has paired, and for a device set to IPP — that one
 * has no SNMP version to reuse, so the negotiation is the honest thing to do.
 */
function pairedVersion(homey: Request['homey'], host: string): SnmpVersion | null {
  const devices = homey.drivers.getDriver('printer').getDevices();
  for (const device of devices) {
    if (String(device.getSetting('host') ?? '') !== host) continue;
    const version = String(device.getSetting('version') ?? '');
    if (version === 'v1' || version === 'v2c') return version;
  }
  return null;
}

/**
 * What is left for the vendor walk, which is the one section that can be told
 * when to stop.
 *
 * It keeps its four seconds when there are four to spare and gives them back
 * when there are not, down to a floor worth a round trip. A second is held back
 * for assembling the report: the walk is the last thing that has to finish, and
 * a walk that runs to the deadline leaves nothing to return.
 */
function walkBudgetMs(deadlineAt: number): number {
  return Math.max(1_000, Math.min(VENDOR_WALK.budgetMs, deadlineAt - Date.now() - 1_000));
}

/**
 * Brother's private branch, raw bytes as well as decoded values.
 *
 * The decode is only as good as the map behind it, and a marker this app has no
 * name for is invisible once decoded — so the hex has to survive into the
 * report, or the next unknown supply is undiagnosable from it.
 */
async function brotherSection(
  host: string,
  community: string,
  version: SnmpVersion,
  supplies: Supply[],
): Promise<string[]> {
  const client = new SnmpClient({ host, community, version, timeout: API_READ_TIMEOUT_MS });
  const kind = printerKindFrom(supplies.map((s) => s.type));
  const raw = await client.get([...BROTHER_OIDS], true);
  const decoded = decodeBrotherReading(raw, kind);

  const lines = ['## Brother private branch, raw'];
  for (const oid of BROTHER_OIDS) {
    const value = raw.get(oid);
    lines.push(
      `${oid}`,
      `      ${Buffer.isBuffer(value) ? value.toString('hex') : '(no answer)'}`,
    );
  }

  lines.push(
    '',
    '## Brother private branch, decoded',
    `model     ${decoded.model ?? '—'}`,
    `firmware  ${decoded.firmware ?? '—'}`,
    `layout    ${decoded.legacy ? 'legacy (five-byte entries)' : 'current (seven-byte entries)'}`,
    `read as   ${kind}`,
    '',
  );

  const groups: Array<[string, typeof decoded.maintenance]> = [
    ['maintenance', decoded.maintenance],
    ['nextcare', decoded.nextcare],
    ['counters', decoded.counters],
  ];
  for (const [name, values] of groups) {
    lines.push(`${name}:`);
    if (values.length === 0) lines.push('      (nothing decoded)');
    for (const v of values) {
      lines.push(`      ${v.marker}  ${v.key} = ${v.value}${v.isPercent ? ' %' : ''}`);
    }
  }

  return lines;
}

/**
 * What the printer says over IPP, appended to every report.
 *
 * Unconditional, and that is the point. A missing level is exactly the case
 * where nobody yet knows which protocol holds the answer, so a report that
 * covers only the one the app happens to be using cannot settle it. This costs
 * one HTTP round trip and turns "supplies do not show" into a question with an
 * answer in it.
 *
 * `all` rather than the poll's short list: this is not the hot path, and an
 * attribute nobody thought to ask for is precisely what a diagnostic is for.
 */
async function ippSection(host: string, deadlineAt: number): Promise<string[]> {
  const lines = ['', '## IPP'];

  const found = await probeIpp(host, ['all'], API_READ_TIMEOUT_MS, undefined, deadlineAt)
    .catch(() => null);
  if (found === null) {
    lines.push(
      'No IPP answer on any of the usual paths. On a printer that Homey found by',
      'itself that is worth knowing: discovery watches _ipp._tcp, so a printer that',
      'announced itself and then will not answer is telling us something.',
    );
    return lines;
  }

  const attributes = found.response.attributes;
  lines.push(`answered at ${found.client.printerUri}`, `${attributes.size} attributes`, '');

  let shown = 0;
  for (const [name, values] of attributes) {
    if (shown >= IPP_REPORT_ATTRIBUTES) {
      lines.push('', `(${attributes.size - shown} more attributes, not shown)`);
      break;
    }
    shown += 1;
    lines.push(name, `      ${values.map((v) => renderVendorValue(v)).join('  ')}`);
  }

  return lines;
}

/**
 * Homey resolves endpoints off the default export, keyed by the names declared
 * in `.homeycompose/app.json`.
 */
export default { getDiagnostics, getScan, postScan, postTest, getTrace, postDump };
