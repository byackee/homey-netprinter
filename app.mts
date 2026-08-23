import 'source-map-support/register.js';
import Homey from 'homey';

import { scanSubnet, subnetOf, type DiscoveredPrinter } from './lib/network-scan.mjs';

/** A subnet sweep in progress, or the last one that finished. */
interface ScanState {
  running: boolean;
  subnet: string | null;
  found: DiscoveredPrinter[];
  error: string | null;
}

/**
 * The app owns no printers — each device polls itself — but it does own the
 * settings page's subnet sweep.
 *
 * The sweep lives here rather than inside the API endpoint because a Homey API
 * call is cut off after ten seconds, and a /24 takes longer than that. The
 * endpoint starts the sweep and returns; the page polls for the result.
 */
export default class NetworkPrinterApp extends Homey.App {
  private scan: ScanState = { running: false, subnet: null, found: [], error: null };

  override async onInit(): Promise<void> {
    this.log('Network Printer app initialised');
  }

  /** The current sweep state, safe to read at any time. */
  getScanState(): ScanState {
    return { ...this.scan, found: [...this.scan.found] };
  }

  /**
   * Starts a sweep unless one is already running, and returns immediately.
   *
   * Returns the state as it stands, so a caller that arrives mid-sweep sees the
   * results found so far rather than starting a second one.
   */
  async startScan(): Promise<ScanState> {
    if (this.scan.running) return this.getScanState();

    const localAddress = await this.homey.cloud.getLocalAddress().catch(() => '');
    const subnet = subnetOf(String(localAddress));

    if (subnet === null) {
      this.scan = {
        running: false,
        subnet: null,
        found: [],
        error: 'Could not determine the local subnet',
      };
      return this.getScanState();
    }

    // Results accumulate in place, so a poll arriving mid-sweep sees partial
    // results instead of an empty list.
    this.scan = { running: true, subnet, found: [], error: null };
    this.log(`Sweeping ${subnet}.0/24 for printers`);

    void scanSubnet(subnet, new Set(), (printer) => {
      this.log(`Found ${printer.name} at ${printer.host}`);
      this.scan.found.push(printer);
    })
      .then(() => {
        this.log(`Sweep finished, ${this.scan.found.length} printer(s)`);
      })
      .catch((error: Error) => {
        this.error(`Sweep failed: ${error.message}`);
        this.scan.error = error.message;
      })
      .finally(() => {
        this.scan.running = false;
      });

    return this.getScanState();
  }
}
