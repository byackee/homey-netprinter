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

import { PrinterReader } from './lib/printer-reader.mjs';
import { classifyOutputTray } from './lib/printer-mib.mjs';
import { negotiateVersion } from './lib/snmp-client.mjs';
import { subnetOf } from './lib/network-scan.mjs';
import { vendorName } from './lib/vendors.mjs';

/**
 * A Homey API call is cut off after ten seconds. Every endpoint here has to
 * answer well inside that, which is why the subnet sweep is started rather than
 * awaited, and why reads use a short timeout with no retry.
 */
const API_READ_TIMEOUT_MS = 2_500;

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
    }>;
    trays: Array<{ name: string; media: string; percent: number | null }>;
    /**
     * What the device currently holds, next to what the printer just said.
     *
     * The page read the printer live and never showed the other half, so a
     * capability stuck on an old value looked identical to a printer still
     * reporting it. A user spent an evening on that distinction.
     */
    stored: { message: string | null; status: string | null };
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
          })),
          trays: snapshot.inputTrays.map((t) => ({
            name: t.name,
            media: t.media,
            percent: t.percent,
          })),
          stored: {
            message: device.hasCapability('printer_message')
              ? (device.getCapabilityValue('printer_message') as string | null) : null,
            status: device.hasCapability('printer_status')
              ? (device.getCapabilityValue('printer_status') as string | null) : null,
          },
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

  return { subnet, devices: reports };
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
  if (version === null) {
    return { ok: false, message: `No SNMP answer from ${host} on v2c or v1.` };
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
 * Homey resolves endpoints off the default export, keyed by the names declared
 * in `.homeycompose/app.json`.
 */
export default { getDiagnostics, getScan, postScan, postTest, getTrace };
