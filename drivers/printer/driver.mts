import Homey from 'homey';

import type NetworkPrinterApp from '../../app.mjs';
import { isSupplyCapability } from '../../lib/supply-capabilities.mjs';
import {
  PrinterReader,
  snmpVersionOf,
  type ReadProtocol,
} from '../../lib/printer-reader.mjs';
import { IPP_ATTRIBUTES, ippReading } from '../../lib/ipp-printer.mjs';
import { probeIpp } from '../../lib/ipp-client.mjs';
import { negotiateVersion } from '../../lib/snmp-client.mjs';
import { scanSubnet, subnetOf } from '../../lib/network-scan.mjs';
import { suggestDeviceName, vendorName } from '../../lib/vendors.mjs';
import type PrinterDevice from './device.mjs';

/** What the pairing form sends us. */
interface ProbeRequest {
  host?: unknown;
  community?: unknown;
}

/** A printer the view can offer the user, and adopt verbatim. */
interface Candidate {
  host: string;
  community: string;
  version: ReadProtocol;
  name: string;
  serial: string | null;
}

/** What the pairing view shows the user after a successful manual probe. */
interface ProbeResult {
  ok: boolean;
  message?: string;
  model?: string | null;
  vendor?: string | null;
  serial?: string | null;
  supplies?: number;
  /** Present only when ok — what the view passes straight back to adopt. */
  printer?: Candidate;
}

/** How many pairing trace lines to keep. Enough to cover one pairing attempt. */
const TRACE_LIMIT = 60;

/**
 * How long a pairing probe waits for an answer.
 *
 * Kept in step with the polling timeout rather than the sweep's: a sweep has a
 * whole subnet to get through and can afford to miss a slow printer, while a
 * user typing in an address has told us exactly where to look and expects us to
 * wait for it.
 */
const PAIR_TIMEOUT_MS = 5_000;

export default class PrinterDriver extends Homey.Driver {
  /**
   * A ring buffer of what happened during pairing, readable from the settings page.
   *
   * An app installed from the CLI has no readable log, so a pairing view that
   * fails silently is otherwise undiagnosable — you see a screen that does
   * nothing and have no way to learn why.
   */
  private trace: string[] = [];

  private note(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.trace.push(line);
    if (this.trace.length > TRACE_LIMIT) this.trace.shift();
    this.log(message);
  }

  /** The pairing trace, oldest first. */
  getTrace(): string[] {
    return [...this.trace];
  }

  override async onInit(): Promise<void> {
    this.homey.flow
      .getActionCard('refresh_printer')
      .registerRunListener(async (args: { device: PrinterDevice }) => {
        await args.device.refreshNow();
      });

    this.homey.flow
      .getConditionCard('supply_below')
      .registerRunListener(async (args: {
        device: PrinterDevice;
        // An `autocomplete` argument hands back the whole object the picker
        // offered, not its id: "the returned value when the card is run is one
        // of the objects provided in the autocomplete array". This was typed as
        // a string and passed straight to a lookup that takes a capability id,
        // so it matched nothing and the card answered "not below" every time it
        // ran — in every release since the first. `registerRunListener` types
        // its args as `any`, so the annotation was an assertion the compiler
        // could never check. A string is still accepted in case Homey ever
        // hands one back for a Flow saved another way.
        capability: string | { id?: string } | null;
        level: number;
      }) => {
        const id = typeof args.capability === 'string' ? args.capability : args.capability?.id;
        if (typeof id !== 'string' || id.length === 0) return false;

        const value = args.device.supplyLevel(id);
        // An unknown level is not "below": a printer that will not report must
        // not silently satisfy a condition the user wrote to catch a low tank.
        if (value === null) return false;
        return value < args.level;
      });

    // The picker lists only the supplies this particular printer actually has.
    // Paper trays are offered alongside them: they are levels measured the same
    // way, and "warn me below 20 %" is the same Flow whether it is toner or A4.
    this.homey.flow
      .getConditionCard('supply_below')
      .registerArgumentAutocompleteListener('capability', async (query, args: { device: PrinterDevice }) => {
        const wanted = query.toLowerCase();
        return args.device
          .getCapabilities()
          .filter((c) => isSupplyCapability(c))
          .map((id) => ({ id, name: this.capabilityLabel(args.device, id) }))
          .filter((item) => item.name.toLowerCase().includes(wanted));
      });

    this.homey.flow
      .getDeviceTriggerCard('status_changed')
      .registerRunListener(async (args: { status?: string }, state: { status?: string }) => {
        const wanted = args.status ?? 'any';
        return wanted === 'any' || wanted === state.status;
      });
  }

  /**
   * Runs the pairing session.
   *
   * There is exactly one view and no navigation between views, which is what
   * makes this work at all: a custom view followed by a system template cannot
   * be navigated into — `Homey.showView()` and `Homey.nextView()` both fail
   * inside Homey's pairing frontend and leave a blank, unresponsive screen. The
   * view calls `Homey.createDevice()` itself instead of handing off to
   * `list_devices`.
   */
  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    this.note('onPair start');

    // A script error in a pairing view is invisible otherwise, because an app
    // installed from the CLI has no readable log anywhere.
    session.setHandler('viewLog', async (message: unknown) => {
      this.note(`view: ${String(message)}`);
    });

    /*
     * Pairing polls for results rather than being pushed them.
     *
     * The first attempt used session.emit() into a Homey.on() listener in the
     * view. That direction was never verified to work here, and when the view
     * showed nothing there was no way to tell whether the sweep had failed or
     * the events simply never arrived. Request/response through Homey.emit() is
     * the one direction these apps have actually proven, so everything uses it.
     */
    session.setHandler('scan_start', async (): Promise<{ started: boolean }> => {
      this.note('scan_start');
      const app = this.homey.app as NetworkPrinterApp;
      const state = await app.startScan();
      this.note(`sweep running=${state.running} subnet=${state.subnet ?? 'unknown'}`);
      return { started: state.subnet !== null };
    });

    session.setHandler('scan_status', async (): Promise<{
      running: boolean;
      printers: Candidate[];
    }> => {
      const app = this.homey.app as NetworkPrinterApp;
      const state = app.getScanState();

      // Addresses already paired are dropped so the list only offers new printers.
      const taken = new Set(
        this.getDevices().map((device) => String(device.getSetting('host') ?? '')),
      );

      const printers = state.found
        .filter((printer) => !taken.has(printer.host))
        .map((printer) => ({
          host: printer.host,
          community: 'public',
          // Whatever answered the sweep. Hard-coding v2c here would pair a
          // printer found on 631 as an SNMP device, and it would never report
          // a level.
          version: printer.protocol,
          name: printer.name,
          serial: printer.serial,
        }));

      if (!state.running) this.note(`scan_status final: ${printers.length} offered`);
      return { running: state.running, printers };
    });

    session.setHandler('probe', async (data: ProbeRequest): Promise<ProbeResult> => {
      const host = String(data.host ?? '').trim();
      const community = String(data.community ?? 'public').trim() || 'public';
      this.note(`probe ${host}`);

      if (!host) return { ok: false, message: this.homey.__('pair.error_no_host') };

      const candidate = await this.identify(host, community);
      if (candidate === null) {
        this.note(`probe ${host}: no answer`);
        return { ok: false, message: this.homey.__('pair.error_unreachable') };
      }

      this.note(`probe ${host}: ${candidate.name}`);
      return {
        ok: true,
        model: candidate.name,
        serial: candidate.serial,
        printer: candidate,
      };
    });

    session.setHandler('adopted', async (data: unknown) => {
      this.note(`adopted: ${JSON.stringify(data)}`);
    });
  }

  /**
   * What Homey's mDNS discovery currently sees, for the settings page.
   *
   * Worth surfacing because discovery failing is otherwise silent: the app keeps
   * working off the subnet sweep, and the only symptom is that a printer which
   * changes address stops updating itself.
   */
  announcedPrinters(): Array<{ address: string; name: string; model: string | null }> {
    try {
      const results = this.getDiscoveryStrategy().getDiscoveryResults();
      return Object.values(results).map((result) => {
        const mdns = result as Homey.DiscoveryResultMDNSSD;
        const txt = (mdns.txt ?? {}) as Record<string, unknown>;
        const model = typeof txt.ty === 'string' ? txt.ty : null;
        return { address: String(mdns.address ?? ''), name: String(mdns.name ?? ''), model };
      });
    } catch (error) {
      this.error(`Could not read discovery results: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Addresses Homey's own mDNS discovery is already aware of.
   *
   * Homey listens continuously, so these cost nothing and arrive instantly. The
   * strategy watches `_ipp._tcp`, which AirPrint and Mopria both require, so
   * essentially every current network printer announces itself on it — but not
   * every one does, which is why the subnet sweep still runs afterwards.
   */
  private discoveredAddresses(): Set<string> {
    const addresses = new Set<string>();
    try {
      const results = this.getDiscoveryStrategy().getDiscoveryResults();
      for (const result of Object.values(results)) {
        const address = (result as Homey.DiscoveryResultMDNSSD).address;
        if (typeof address === 'string' && address.length > 0) addresses.add(address);
      }
    } catch (error) {
      this.error(`Could not read discovery results: ${(error as Error).message}`);
    }
    return addresses;
  }

  /**
   * Confirms an address really is a readable printer, and describes it.
   *
   * mDNS says a printer is there; it says nothing about whether this app can
   * read it. Offering an unreadable device would pair something that never
   * reports a level.
   *
   * SNMP is tried first because it carries more, and IPP after — not as a
   * consolation prize but as the fix for a real absurdity: discovery watches
   * `_ipp._tcp`, so every printer that reaches this method has already proved it
   * speaks IPP, and refusing to pair it for want of SNMP meant turning away a
   * printer we had just been talking to.
   */
  private async identify(host: string, community: string): Promise<Candidate | null> {
    // Five seconds with a retry, matching what polling allows. Two was too tight
    // for an older printer waking its SNMP agent: it would pair-fail on a
    // machine that then polled perfectly well once added by hand.
    const version = await negotiateVersion(host, community, PAIR_TIMEOUT_MS);
    if (version === null) return this.identifyOverIpp(host, community);

    // Past this point the printer has answered sysDescr, so there *is* an agent
    // at this address. Whatever happens next, "not reachable" is now the wrong
    // thing to tell the user.
    try {
      const identity = await new PrinterReader(host, community, version, PAIR_TIMEOUT_MS).readIdentity();
      const vendor = vendorName(identity.enterprise);
      return {
        host,
        community,
        version,
        name: suggestDeviceName(identity.model, vendor, identity.name, host),
        serial: identity.serial,
      };
    } catch (error) {
      // A printer that answers SNMP but not one of the six identity OIDs used to
      // be reported as unreachable, which sends the user hunting for a network
      // fault that is not there. On v1 a single missing OID fails the whole
      // request, so this is not a rare shape. Offer it anyway, named after its
      // address; the supplies walk is independent and usually works fine.
      this.note(`identify ${host}: agent answered but identity failed — ${(error as Error).message}`);
      return { host, community, version, name: `Printer ${host}`, serial: null };
    }
  }

  /**
   * The same question asked over IPP, for a printer with SNMP switched off.
   *
   * Deliberately stricter than the SNMP path: that one offers a printer whose
   * agent answered even if the identity read failed, because an SNMP agent on
   * port 161 is a printer. Something answering HTTP on 631 is not, so this
   * takes an actual IPP reply as the proof.
   */
  private async identifyOverIpp(host: string, community: string): Promise<Candidate | null> {
    // Two paths, not the reader's four. This runs while a user watches a pairing
    // list fill in, and a printer that announced itself on _ipp._tcp and then
    // ignores /ipp/print is not worth twenty seconds of their attention.
    const found = await probeIpp(host, IPP_ATTRIBUTES, PAIR_TIMEOUT_MS, ['/ipp/print', '/'])
      .catch(() => null);
    if (found === null) return null;

    const reading = ippReading(found.response.attributes);
    this.note(`identify ${host}: no SNMP, but IPP answered at ${found.client.printerUri}`);

    return {
      host,
      community,
      version: 'ipp',
      name: suggestDeviceName(reading.model, null, reading.name, host),
      serial: reading.serial,
    };
  }

  /**
   * The name to show for a supply capability in a Flow picker.
   *
   * A capability the device has renamed after its cartridge carries a plain
   * string; one left at its default carries the translation object declared in
   * the capability JSON. Stringifying that object blindly puts "[object Object]"
   * in front of the user, so both shapes are handled.
   */
  private capabilityLabel(device: PrinterDevice, capabilityId: string): string {
    const title = device.getCapabilityOptions(capabilityId)?.title as unknown;

    if (typeof title === 'string' && title.length > 0) return title;

    if (title !== null && typeof title === 'object') {
      const translations = title as Record<string, unknown>;
      const preferred = translations[this.homey.i18n.getLanguage()] ?? translations.en;
      if (typeof preferred === 'string' && preferred.length > 0) return preferred;
    }

    return capabilityId;
  }

  /**
   * The /24 the Homey itself sits on, which is the only subnet a sweep can reach.
   *
   * `getLocalAddress()` returns something like "192.168.50.251:80".
   */
  private async localSubnet(): Promise<string | null> {
    try {
      const address = await this.homey.cloud.getLocalAddress();
      return subnetOf(String(address));
    } catch (error) {
      this.error(`Could not read the local address: ${(error as Error).message}`);
      return null;
    }
  }

  /** Repair re-runs the same probe so a printer that moved address can be pointed at again. */
  override async onRepair(session: Homey.Driver.PairSession, device: Homey.Device): Promise<void> {
    session.setHandler('probe', async (data: ProbeRequest): Promise<ProbeResult> => {
      const host = String(data.host ?? '').trim();
      const community = String(data.community ?? 'public').trim() || 'public';

      if (!host) return { ok: false, message: this.homey.__('pair.error_no_host') };

      const snmp = await negotiateVersion(host, community, PAIR_TIMEOUT_MS);
      const candidate = snmp === null ? await this.identifyOverIpp(host, community) : null;
      if (snmp === null && candidate === null) {
        return { ok: false, message: this.homey.__('pair.error_unreachable') };
      }
      const version: ReadProtocol = snmp ?? 'ipp';

      // The printer has answered, so the repair succeeds from here whatever the
      // identity read does. A printer that omits one of the six identity OIDs is
      // still the printer this device is for; refusing to repair it would strand
      // the user on an address they have just proved works.
      const identity = await new PrinterReader(host, community, snmpVersionOf(version), PAIR_TIMEOUT_MS)
        .readIdentity()
        .catch((error: Error) => {
          this.note(`repair ${host}: answered but identity failed — ${error.message}`);
          return { model: null, name: null, serial: null, enterprise: null, description: null };
        });

      await device.setSettings({ host, community, version });

      // Storing settings is not enough: setSettings() from code does not fire
      // onSettings(), so without this the device keeps polling the old address
      // and stays flagged unavailable until the app is restarted. A user hit
      // exactly that — "the app found the printer but Homey still flags it as
      // unavailable, have to restart the app".
      await (device as PrinterDevice).reconfigure()
        .catch((error: Error) => this.note(`repair ${host}: reconfigure failed — ${error.message}`));

      return {
        ok: true,
        model: identity.model,
        vendor: vendorName(identity.enterprise),
        serial: identity.serial,
      };
    });

    session.setHandler('getConfig', async () => ({
      host: String(device.getSetting('host') ?? ''),
      community: String(device.getSetting('community') ?? 'public'),
    }));
  }
}
