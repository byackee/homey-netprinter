import Homey from 'homey';

import { PrinterReader } from '../../lib/printer-reader.mjs';
import { negotiateVersion, type SnmpVersion } from '../../lib/snmp-client.mjs';
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
  version: SnmpVersion;
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

export default class PrinterDriver extends Homey.Driver {
  override async onInit(): Promise<void> {
    this.homey.flow
      .getActionCard('refresh_printer')
      .registerRunListener(async (args: { device: PrinterDevice }) => {
        await args.device.refreshNow();
      });

    this.homey.flow
      .getConditionCard('supply_below')
      .registerRunListener(async (args: { device: PrinterDevice; capability: string; level: number }) => {
        const value = args.device.supplyLevel(args.capability);
        // An unknown level is not "below": a printer that will not report must
        // not silently satisfy a condition the user wrote to catch a low tank.
        if (value === null) return false;
        return value < args.level;
      });

    // The picker lists only the supplies this particular printer actually has.
    this.homey.flow
      .getConditionCard('supply_below')
      .registerArgumentAutocompleteListener('capability', async (query, args: { device: PrinterDevice }) => {
        const wanted = query.toLowerCase();
        return args.device
          .getCapabilities()
          .filter((c) => c.startsWith('supply_'))
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
    // A script error in a pairing view is invisible otherwise, because an app
    // installed from the CLI has no readable log anywhere.
    session.setHandler('viewLog', async (message: unknown) => {
      this.log(`pair view: ${String(message)}`);
    });

    // The sweep is started, not awaited. A /24 takes around fifteen seconds, and
    // holding a single `Homey.emit` open that long risks the frontend timing the
    // request out and leaving the view stuck on "searching" forever. Results are
    // pushed to the view as they arrive and a `scan_done` marks the end.
    session.setHandler('scan', async (): Promise<{ started: boolean }> => {
      const subnet = await this.localSubnet();
      if (subnet === null) {
        this.error('Could not determine the local subnet; offering manual entry only');
        return { started: false };
      }

      // Addresses already paired are skipped so the list only offers new printers.
      const taken = new Set(
        this.getDevices().map((device) => String(device.getSetting('host') ?? '')),
      );

      this.log(`Sweeping ${subnet}.0/24 for printers`);

      const emit = (event: string, payload: unknown) => {
        // The user can close the pairing dialog mid-sweep, which makes every
        // later emit reject. That is expected, not an error worth logging loudly.
        session.emit(event, payload).catch(() => {});
      };

      void scanSubnet(subnet, taken, (printer) => {
        this.log(`Found ${printer.name} at ${printer.host}`);
        emit('printer', {
          host: printer.host,
          community: 'public',
          version: 'v2c' as SnmpVersion,
          name: printer.name,
          serial: printer.serial,
        } satisfies Candidate);
      })
        .then((found) => {
          this.log(`Sweep finished, ${found.length} printer(s)`);
          emit('scan_done', { count: found.length });
        })
        .catch((error: Error) => {
          this.error(`Sweep failed: ${error.message}`);
          emit('scan_done', { count: 0, error: error.message });
        });

      return { started: true };
    });

    session.setHandler('probe', async (data: ProbeRequest): Promise<ProbeResult> => {
      const host = String(data.host ?? '').trim();
      const community = String(data.community ?? 'public').trim() || 'public';

      if (!host) return { ok: false, message: this.homey.__('pair.error_no_host') };

      const version = await negotiateVersion(host, community);
      if (version === null) {
        return { ok: false, message: this.homey.__('pair.error_unreachable') };
      }

      try {
        const reader = new PrinterReader(host, community, version);
        const identity = await reader.readIdentity();
        const snapshot = await reader.read();
        const vendor = vendorName(identity.enterprise);

        return {
          ok: true,
          model: identity.model,
          vendor,
          serial: identity.serial,
          supplies: snapshot.supplies.length,
          printer: {
            host,
            community,
            version,
            name: suggestDeviceName(identity.model, vendor, identity.name, host),
            serial: identity.serial,
          },
        };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    });
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

      const version = await negotiateVersion(host, community);
      if (version === null) return { ok: false, message: this.homey.__('pair.error_unreachable') };

      const identity = await new PrinterReader(host, community, version).readIdentity();
      await device.setSettings({ host, community, version });

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
