import Homey from 'homey';

import { PrinterReader } from '../../lib/printer-reader.mjs';
import { negotiateVersion, type SnmpVersion } from '../../lib/snmp-client.mjs';
import { suggestDeviceName, vendorName } from '../../lib/vendors.mjs';
import type PrinterDevice from './device.mjs';

/** What the pairing form sends us. */
interface ProbeRequest {
  host?: unknown;
  community?: unknown;
}

/** What the pairing view shows the user after a successful probe. */
interface ProbeResult {
  ok: boolean;
  message?: string;
  model?: string | null;
  vendor?: string | null;
  serial?: string | null;
  supplies?: number;
}

/** A probe that succeeded, held for the duration of one pairing session. */
interface Candidate {
  host: string;
  community: string;
  version: SnmpVersion;
  name: string;
  serial: string | null;
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
        return args.device
          .getCapabilities()
          .filter((c) => c.startsWith('supply_'))
          .map((id) => ({
            id,
            name: String(args.device.getCapabilityOptions(id)?.title ?? id),
          }))
          .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
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
   * Navigation deliberately stays in the pairing view: calling
   * `session.showView()` from inside the `showView` handler deadlocks, because
   * Homey waits for the handler to return before completing the transition while
   * the handler waits for that same transition. The view calls
   * `Homey.showView('list_devices')` itself once a probe succeeds.
   */
  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let candidate: Candidate | null = null;

    session.setHandler('probe', async (data: ProbeRequest): Promise<ProbeResult> => {
      const host = String(data.host ?? '').trim();
      const community = String(data.community ?? 'public').trim() || 'public';

      if (!host) return { ok: false, message: this.homey.__('pair.error_no_host') };

      const version = await negotiateVersion(host, community);
      if (version === null) {
        candidate = null;
        return { ok: false, message: this.homey.__('pair.error_unreachable') };
      }

      try {
        const reader = new PrinterReader(host, community, version);
        const identity = await reader.readIdentity();
        const snapshot = await reader.read();
        const vendor = vendorName(identity.enterprise);

        candidate = {
          host,
          community,
          version,
          name: suggestDeviceName(identity.model, vendor, identity.name, host),
          serial: identity.serial,
        };

        return {
          ok: true,
          model: identity.model,
          vendor,
          serial: identity.serial,
          supplies: snapshot.supplies.length,
        };
      } catch (error) {
        candidate = null;
        return { ok: false, message: (error as Error).message };
      }
    });

    session.setHandler('list_devices', async () => {
      if (candidate === null) return [];

      // A pairing result may only carry name, data, store, settings, icon,
      // capabilities and capabilitiesOptions. Homey rejects an entry with any
      // other key by returning an empty list, with no error anywhere — and the
      // SDK types this as any[], so the compiler cannot catch it either.
      return [{
        name: candidate.name,
        data: {
          // The serial survives a DHCP lease change; the address does not, so it
          // is only the identity of last resort.
          id: candidate.serial ?? `host:${candidate.host}`,
        },
        settings: {
          host: candidate.host,
          community: candidate.community,
          version: candidate.version,
          poll_interval: 300,
          low_threshold: 15,
        },
      }];
    });
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
