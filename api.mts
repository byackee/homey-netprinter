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
import { negotiateVersion } from './lib/snmp-client.mjs';
import { scanSubnet, subnetOf } from './lib/network-scan.mjs';
import { vendorName } from './lib/vendors.mjs';

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
    supplies: Array<{ description: string; colour: string; percent: number | null }>;
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
      const snapshot = await new PrinterReader(
        host,
        community,
        version === 'v1' ? 'v1' : 'v2c',
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
          })),
        },
      };
    } catch (error) {
      return { ...base, error: (error as Error).message };
    }
  }));

  return { subnet, devices: reports };
}

/** Sweeps the subnet on demand, so the user can see what the pairing sweep would find. */
async function getScan({ homey }: Request): Promise<{
  subnet: string | null;
  found: Array<{ host: string; model: string | null; serial: string | null; vendor: string | null }>;
}> {
  const localAddress = await homey.cloud.getLocalAddress().catch(() => '');
  const subnet = subnetOf(String(localAddress));
  if (subnet === null) return { subnet: null, found: [] };

  const found = await scanSubnet(subnet);
  return {
    subnet,
    found: found.map((p) => ({ host: p.host, model: p.model, serial: p.serial, vendor: p.vendor })),
  };
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

  const version = await negotiateVersion(host, community);
  if (version === null) {
    return { ok: false, message: `No SNMP answer from ${host} on v2c or v1.` };
  }

  try {
    const reader = new PrinterReader(host, community, version);
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
 * Homey resolves endpoints off the default export, keyed by the names declared
 * in `.homeycompose/app.json`.
 */
export default { getDiagnostics, getScan, postTest };
