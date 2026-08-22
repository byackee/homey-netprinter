/**
 * Finds printers by asking every address on the local subnet whether it speaks
 * SNMP and describes itself as a printer.
 *
 * mDNS was the obvious alternative and was rejected: printers disagree about
 * which service they announce (`_printer._tcp`, `_ipp._tcp`,
 * `_pdl-datastream._tcp`, or none at all when only IPP-over-USB is enabled), a
 * Homey discovery strategy binds a driver to exactly one of them, and the Epson
 * this was developed against answered none of them. An SNMP sweep asks the same
 * question the app will ask later, so anything it finds is by definition usable.
 */

import { SnmpClient } from './snmp-client.mjs';
import { OID, enterpriseNumber } from './printer-mib.mjs';
import { suggestDeviceName, vendorName } from './vendors.mjs';

/** One printer the sweep turned up. */
export interface DiscoveredPrinter {
  host: string;
  model: string | null;
  serial: string | null;
  vendor: string | null;
  /** The name we would give the device if the user adopts it. */
  name: string;
}

/**
 * Addresses probed at once.
 *
 * Each probe holds a UDP socket, so this is a real resource ceiling rather than
 * a tuning knob: a /24 opened all at once exhausts descriptors on Homey.
 */
const CONCURRENCY = 24;

/** A probe is one packet with no retry — a printer that needs longer than this is not idle. */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * Derives the /24 to sweep from an address of the form "192.168.50.251" or
 * "192.168.50.251:80", which is what `homey.cloud.getLocalAddress()` returns.
 *
 * Returns null for anything that is not IPv4, rather than guessing.
 */
export function subnetOf(localAddress: string): string | null {
  const host = localAddress.split(':')[0]?.trim() ?? '';
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  if (parts.some((p) => p === '' || !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.slice(0, 3).join('.');
}

/**
 * Asks one address whether it is a printer.
 *
 * `hrDeviceDescr` and `prtGeneralPrinterName` are what separates a printer from
 * the rest of the SNMP-speaking hardware on a home network — a switch or an AP
 * answers sysDescr but has no Printer-MIB.
 */
async function probe(host: string): Promise<DiscoveredPrinter | null> {
  const client = new SnmpClient({
    host,
    community: 'public',
    version: 'v2c',
    timeout: PROBE_TIMEOUT_MS,
    retries: 0,
  });

  try {
    const r = await client.get([
      OID.hrDeviceDescr,
      OID.prtGeneralPrinterName,
      OID.prtGeneralSerialNumber,
      OID.sysObjectID,
      OID.sysName,
    ]);

    const descr = r.get(OID.hrDeviceDescr);
    const printerName = r.get(OID.prtGeneralPrinterName);
    // Both null means it answered SNMP but has no Printer-MIB: not a printer.
    if (descr === null && printerName === null) return null;

    const model = (typeof descr === 'string' ? descr : null)
      ?? (typeof printerName === 'string' ? printerName : null);
    const serialValue = r.get(OID.prtGeneralSerialNumber);
    const sysNameValue = r.get(OID.sysName);
    const objectId = r.get(OID.sysObjectID);

    const serial = typeof serialValue === 'string' ? serialValue : null;
    const sysName = typeof sysNameValue === 'string' ? sysNameValue : null;
    const vendor = vendorName(enterpriseNumber(typeof objectId === 'string' ? objectId : null));

    return { host, model, serial, vendor, name: suggestDeviceName(model, vendor, sysName, host) };
  } catch {
    // Unreachable, or not listening on 161. Neither is worth reporting.
    return null;
  }
}

/**
 * Sweeps a /24 and returns the printers on it.
 *
 * A full sweep takes on the order of fifteen seconds, which is longer than a
 * pairing view is willing to wait for a single reply. `onFound` therefore
 * reports each printer the moment it answers, so the caller can show results as
 * they arrive instead of holding one request open for the whole sweep.
 *
 * @param subnet   the first three octets, e.g. "192.168.50"
 * @param skip     addresses already paired, so the list only offers new devices
 * @param onFound  called once per printer, as soon as it is identified
 */
export async function scanSubnet(
  subnet: string,
  skip: ReadonlySet<string> = new Set(),
  onFound?: (printer: DiscoveredPrinter) => void,
): Promise<DiscoveredPrinter[]> {
  const targets: string[] = [];
  for (let last = 1; last <= 254; last += 1) {
    const host = `${subnet}.${last}`;
    if (!skip.has(host)) targets.push(host);
  }

  const found: DiscoveredPrinter[] = [];
  let next = 0;

  // A fixed pool of workers pulling from a shared cursor, so the sweep runs at a
  // steady CONCURRENCY rather than in bursts that idle at the end of each batch.
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const host = targets[index];
      if (host === undefined) return;

      const printer = await probe(host);
      if (printer === null) continue;

      found.push(printer);
      // A listener that throws must not abort the sweep it is observing.
      try { onFound?.(printer); } catch { /* the caller's problem, not the sweep's */ }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  found.sort((a, b) => {
    const left = Number(a.host.split('.')[3] ?? 0);
    const right = Number(b.host.split('.')[3] ?? 0);
    return left - right;
  });
  return found;
}
