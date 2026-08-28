/**
 * Turns raw SNMP traffic into one printer snapshot.
 *
 * This is the only place that knows both the wire format and the domain, so the
 * driver and the device never touch an OID.
 */

import { SnmpClient, type SnmpVersion, type SnmpValue } from './snmp-client.mjs';
import {
  OID,
  DEVICE_STATUS,
  classifySupplyColour,
  decodeAlertSeverity,
  decodeCoverStatus,
  decodeErrorState,
  decodeInputType,
  decodePrinterStatus,
  decodeSupplyType,
  decodeSupplyUnit,
  enterpriseNumber,
  inputPercent,
  isReceptacle,
  outputPercentFree,
  supplyPercent,
  type InputTray,
  type OutputTray,
  type PrinterAlert,
  type PrinterCover,
  type PrinterErrorFlag,
  type PrinterStatus,
  type Supply,
} from './printer-mib.mjs';
import {
  BROTHER_ENTERPRISE,
  printerKindFrom,
  readBrother,
  vendorPercentFor,
  type BrotherReading,
} from './vendors/brother.mjs';
import { IPP_ATTRIBUTES, fillFromIpp, ippReading, type IppReading } from './ipp-printer.mjs';
import { IppClient, IppError, probeIpp } from './ipp-client.mjs';

/**
 * How long to leave a printer alone after it answered no IPP.
 *
 * Long enough that a printer which simply does not speak it costs nothing, and
 * short enough that one which was merely switched off is picked up the same
 * afternoon.
 */
const IPP_RETRY_AFTER_MS = 30 * 60_000;

/** Everything one poll can learn about a printer. */
export interface PrinterSnapshot {
  /** Marketing model, e.g. "EPSON XP-6100 Series". Null when the printer will not say. */
  model: string | null;
  /** Network name, e.g. "EPSONC618AD". */
  name: string | null;
  /** Serial number — the identity a paired device is keyed on. */
  serial: string | null;
  /** IANA enterprise number of the manufacturer, e.g. 1248 for Epson. */
  enterprise: number | null;
  status: PrinterStatus;
  /** The text on the printer's own panel, e.g. "Ready". */
  displayText: string | null;
  /** Lifetime page count, or null when the printer does not expose one. */
  pageCount: number | null;
  errors: PrinterErrorFlag[];
  /** One entry per consumable, in the printer's own table order. */
  supplies: Supply[];
  /** One entry per output bin, empty when the printer reports no output table. */
  outputTrays: OutputTray[];
  /** One entry per paper tray, empty when the printer reports no input table. */
  inputTrays: InputTray[];
  /** One entry per door, lid or interlock the printer can sense. */
  covers: PrinterCover[];
  /** What the printer itself says is wrong right now. Empty when it says nothing. */
  alerts: PrinterAlert[];
  /**
   * Whether the alert walk actually answered.
   *
   * An empty list means "nothing is wrong"; a failed walk means "we do not
   * know", and only the first of those is grounds for clearing what is on
   * screen. Same reasoning as the supplies table in syncCapabilities.
   */
  alertsRead: boolean;
  /**
   * What the printer's IPP reply added, when one was needed.
   *
   * Null on every printer whose SNMP read answered in full — which is the
   * common case, and the reason this costs nothing there. Kept on the snapshot
   * rather than folded silently into the supplies so the settings page can say
   * which numbers arrived over which protocol.
   */
  ipp: IppInfo | null;
  /**
   * What the manufacturer's private branch added, when one was consulted.
   *
   * Null on every printer whose standard table answered in full, which is nearly
   * all of them. Kept on the snapshot rather than folded silently into the
   * supplies so the settings page can show a user exactly which numbers came
   * from where — the same reason {@link Supply.level} is carried raw.
   */
  vendor: VendorReading | null;
}

/** A manufacturer-specific read, alongside the standard one rather than instead of it. */
export interface VendorReading {
  /** The brand whose private branch answered, e.g. "Brother". */
  vendor: string;
  /** Model as the private branch reports it, when it differs from the standard one. */
  model: string | null;
  firmware: string | null;
  /** Every decoded value, named as Home Assistant names it, for comparison. */
  values: Array<{ key: string; value: number; isPercent: boolean }>;
  /** Which supply rows this read filled in, by table index. */
  filled: string[];
}

/**
 * What a paired device stores as the way to read it.
 *
 * An SNMP version, or `ipp` for a printer that answers no SNMP at all. One
 * setting rather than two flags because they are genuinely exclusive: this is
 * the protocol the reader speaks, and a device has exactly one.
 */
export type ReadProtocol = SnmpVersion | 'ipp';

/** The SNMP version to read with, or null when the printer is IPP-only. */
export function snmpVersionOf(protocol: ReadProtocol): SnmpVersion | null {
  return protocol === 'ipp' ? null : protocol;
}

/** What one IPP read contributed to a snapshot. */
export interface IppInfo {
  /** The URI that answered, so a report can say where the numbers came from. */
  uri: string;
  model: string | null;
  serial: string | null;
  /** `printer-state-reasons` — the printer's own words for what is wrong. */
  stateReasons: string[];
  /** How many supplies the reply described. */
  supplyCount: number;
  /** Standard-table rows this reading filled in, by table index. */
  filled: string[];
  /**
   * True when the supplies on the snapshot are IPP's own rather than fills.
   *
   * That is the case the whole module exists for: a printer whose SNMP answers
   * nothing about ink, which until now had no levels at all.
   */
  sole: boolean;
}

/** Identity fields, read once during pairing. */
export interface PrinterIdentity {
  model: string | null;
  name: string | null;
  serial: string | null;
  enterprise: number | null;
  description: string | null;
}

function asString(value: SnmpValue | undefined): string | null {
  if (value === null || value === undefined || Buffer.isBuffer(value)) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function asNumber(value: SnmpValue | undefined): number | null {
  if (value === null || value === undefined || Buffer.isBuffer(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Extracts the trailing `row.column` index from a table OID, e.g. "…1.1.6.1.3" → "1.3". */
function tableIndex(oid: string, root: string): string | null {
  if (!oid.startsWith(`${root}.`)) return null;
  return oid.slice(root.length + 1);
}

export class PrinterReader {
  private readonly client: SnmpClient;
  private readonly host: string;
  private readonly timeout: number | undefined;
  /**
   * False when this printer is read over IPP alone.
   *
   * Homey discovers printers on `_ipp._tcp` and this app then reads them over
   * SNMP, which more and more printers ship with turned off — so the app was
   * finding printers it then refused to pair. A null version is that printer:
   * everything below skips SNMP entirely rather than negotiating with something
   * that is not listening.
   */
  private readonly snmpEnabled: boolean;
  /**
   * The IPP endpoint that answered, remembered between polls.
   *
   * Finding it costs up to four refused connections; doing that every five
   * minutes for the life of the device would be absurd.
   */
  private ipp: IppClient | null = null;
  /**
   * When to stop declining to ask, after an IPP probe found nothing.
   *
   * Without this, a printer with one permanently unreadable part — a laser that
   * will not number its fuser, say — would pay four refused connections on
   * every poll for the rest of its life, because the gap that triggers the IPP
   * read is one that will never close. Applied only where IPP is the second
   * source; a printer read over IPP alone is asked every time, since for it a
   * silent probe is a printer that is asleep, not one that does not speak it.
   */
  private ippSilentUntil = 0;

  constructor(host: string, community: string, version: SnmpVersion | null, timeout?: number) {
    this.host = host;
    this.timeout = timeout;
    this.snmpEnabled = version !== null;
    // Constructed either way: a client opens no socket until it is asked
    // something, so an unused one costs nothing and spares every method below a
    // null check it would never take.
    this.client = new SnmpClient({ host, community, version: version ?? 'v2c', timeout });
  }

  /**
   * Reads the fields that identify a printer, without the supplies table.
   *
   * Pairing uses this: it is one round trip, so an unreachable address fails fast
   * instead of making the user wait through a full walk.
   */
  async readIdentity(): Promise<PrinterIdentity> {
    if (!this.snmpEnabled) {
      const found = await this.readIppReading();
      if (found === null) throw new IppError(`No IPP answer from ${this.host}`);
      return {
        model: found.reading.model,
        name: found.reading.name,
        serial: found.reading.serial,
        // sysObjectID is an SNMP idea. IPP names the manufacturer in words, not
        // as an IANA number, so there is nothing honest to put here.
        enterprise: null,
        description: null,
      };
    }

    const oids = [
      OID.hrDeviceDescr,
      OID.prtGeneralPrinterName,
      OID.sysName,
      OID.prtGeneralSerialNumber,
      OID.sysObjectID,
      OID.sysDescr,
    ];
    const r = await this.client.get(oids);

    return {
      model: asString(r.get(OID.hrDeviceDescr)) ?? asString(r.get(OID.prtGeneralPrinterName)),
      name: asString(r.get(OID.sysName)),
      serial: asString(r.get(OID.prtGeneralSerialNumber)),
      enterprise: enterpriseNumber(asString(r.get(OID.sysObjectID))),
      description: asString(r.get(OID.sysDescr)),
    };
  }

  /** Reads everything: identity, status and the full supplies table. */
  async read(): Promise<PrinterSnapshot> {
    if (!this.snmpEnabled) return this.readOverIpp();

    const scalarOids = [
      OID.hrDeviceDescr,
      OID.prtGeneralPrinterName,
      OID.sysName,
      OID.prtGeneralSerialNumber,
      OID.sysObjectID,
      OID.hrPrinterStatus,
      OID.hrDeviceStatus,
      OID.prtConsoleDisplayBufferText,
      OID.prtMarkerLifeCount,
    ];

    // The error state is a bit string, so it is fetched raw: decoding it as text
    // would mangle the bytes we need to test.
    const [scalars, errorRaw, supplies, outputTrays, inputTrays, covers, alerts] = await Promise.all([
      this.client.get(scalarOids),
      this.client.get([OID.hrPrinterDetectedErrorState], true),
      this.readSupplies(),
      // None of these four exists on every printer. A missing branch is a normal
      // answer, not a failed read, so it must never fail the poll around it.
      this.readOutputTrays().catch(() => [] as OutputTray[]),
      this.readInputTrays().catch(() => [] as InputTray[]),
      this.readCovers().catch(() => [] as PrinterCover[]),
      this.readAlerts().then(
        (rows) => ({ rows, ok: true }),
        () => ({ rows: [] as PrinterAlert[], ok: false }),
      ),
    ]);

    const rawError = errorRaw.get(OID.hrPrinterDetectedErrorState);
    const enterprise = enterpriseNumber(asString(scalars.get(OID.sysObjectID)));

    // Only Brother, only when the standard table left a hole, and only ever
    // after the standard read has already succeeded. A vendor extra that fails
    // must cost the poll nothing.
    const vendor = await this.readVendor(enterprise, supplies).catch(() => null);

    // And only when something is still missing after all that. Same rule, same
    // guarantee: a second source that fails must cost the poll nothing.
    const ipp = await this.readIpp(supplies, inputTrays).catch(() => null);

    return {
      model: asString(scalars.get(OID.hrDeviceDescr)) ?? asString(scalars.get(OID.prtGeneralPrinterName)),
      name: asString(scalars.get(OID.sysName)),
      serial: asString(scalars.get(OID.prtGeneralSerialNumber)),
      enterprise,
      status: resolveStatus(
        decodePrinterStatus(asNumber(scalars.get(OID.hrPrinterStatus))),
        asNumber(scalars.get(OID.hrDeviceStatus)),
      ),
      displayText: asString(scalars.get(OID.prtConsoleDisplayBufferText)),
      pageCount: asNumber(scalars.get(OID.prtMarkerLifeCount)),
      errors: decodeErrorState(Buffer.isBuffer(rawError) ? rawError : null),
      supplies,
      outputTrays,
      inputTrays,
      covers,
      alerts: alerts.rows,
      alertsRead: alerts.ok,
      ipp,
      vendor,
    };
  }

  /**
   * The whole snapshot from IPP, for a printer that answers no SNMP at all.
   *
   * Thinner than an SNMP one, and honestly so: there is no alert table, no
   * cover sensing and no lifetime page counter in IPP, so those stay empty
   * rather than being filled with something that looks like a reading. What it
   * does carry is the part a user actually watches — levels, paper, and why the
   * printer has stopped.
   */
  private async readOverIpp(): Promise<PrinterSnapshot> {
    const found = await this.readIppReading();
    if (found === null) throw new IppError(`No IPP answer from ${this.host}`);
    const { reading, uri } = found;

    return {
      model: reading.model,
      name: reading.name,
      serial: reading.serial,
      enterprise: null,
      status: reading.status,
      displayText: reading.displayText,
      // IPP defines no printer-level impression counter — the counters it has
      // belong to jobs — so this stays null rather than becoming a wrong number.
      pageCount: null,
      errors: reading.errors,
      supplies: reading.supplies,
      outputTrays: [],
      inputTrays: reading.inputTrays,
      covers: [],
      alerts: [],
      // Not "nothing is wrong": there was no alert table to read. The
      // distinction is what stops syncCapabilities clearing rows on a protocol
      // that never had them.
      alertsRead: false,
      ipp: {
        uri,
        model: reading.model,
        serial: reading.serial,
        stateReasons: reading.stateReasons,
        supplyCount: reading.supplies.length,
        filled: [],
        sole: reading.supplies.length > 0,
      },
      vendor: null,
    };
  }

  /**
   * Reads the printer over IPP, reusing the endpoint that worked last time.
   *
   * Returns null when nothing answered, which is the ordinary case for a
   * printer whose SNMP already told us everything — this is only ever called
   * when something was missing.
   */
  private async readIppReading(): Promise<{ reading: IppReading; uri: string } | null> {
    if (this.ipp !== null) {
      try {
        const response = await this.ipp.getPrinterAttributes(IPP_ATTRIBUTES);
        return { reading: ippReading(response.attributes), uri: this.ipp.printerUri };
      } catch {
        // The path that worked has stopped working. A firmware update moves one
        // occasionally, and a printer that has just woken up refuses one round
        // trip. Forget it and look again rather than give up on the protocol.
        this.ipp = null;
      }
    }

    const found = await probeIpp(this.host, IPP_ATTRIBUTES, this.timeout);
    if (found === null) return null;

    this.ipp = found.client;
    return { reading: ippReading(found.response.attributes), uri: found.client.printerUri };
  }

  /**
   * Fills what the SNMP read left unanswered, from the printer's IPP reply.
   *
   * Two shapes, one rule. A supplies table with holes in it gets those holes
   * filled and nothing else touched — a row the Printer-MIB numbered keeps the
   * Printer-MIB's number. A printer with no supplies table at all gets IPP's
   * rows outright, because the alternative is the blank screen its owner has
   * been looking at.
   *
   * Returns null the moment there is nothing to do, which on a printer whose
   * standard read works is every poll. That short-circuit is what keeps an HTTP
   * round trip off the hot path of the printers that do not need one.
   */
  private async readIpp(supplies: Supply[], inputTrays: InputTray[]): Promise<IppInfo | null> {
    if (supplies.length > 0 && supplies.every((s) => s.percent !== null)) return null;
    if (Date.now() < this.ippSilentUntil) return null;

    const found = await this.readIppReading();
    if (found === null) {
      this.ippSilentUntil = Date.now() + IPP_RETRY_AFTER_MS;
      return null;
    }
    const { reading, uri } = found;

    let filled: string[] = [];
    let sole = false;

    if (supplies.length === 0) {
      supplies.push(...reading.supplies);
      sole = reading.supplies.length > 0;
    } else {
      filled = fillFromIpp(supplies, reading.supplies);
    }

    // Trays are all-or-nothing for the same reason: a printer that publishes no
    // input table over SNMP has nothing for IPP rows to conflict with.
    if (inputTrays.length === 0) inputTrays.push(...reading.inputTrays);

    return {
      uri,
      model: reading.model,
      serial: reading.serial,
      stateReasons: reading.stateReasons,
      supplyCount: reading.supplies.length,
      filled,
      sole,
    };
  }

  /**
   * Fills supply rows the standard table refused to number, from the vendor's
   * own branch.
   *
   * Mutates `supplies` in place, which is the honest shape here: the caller's
   * rows are the ones a user sees, and a copy would leave two versions of the
   * truth in one snapshot. Returns what it did, so the settings page can say so.
   *
   * Returns null the moment there is nothing to do — an unrecognised brand, or a
   * table that answered every row. That short-circuit matters: it is what keeps
   * this off the hot path for every printer that does not need it, which since
   * the standard read already works is almost all of them.
   */
  private async readVendor(
    enterprise: number | null,
    supplies: Supply[],
  ): Promise<VendorReading | null> {
    if (enterprise !== BROTHER_ENTERPRISE) return null;
    if (!supplies.some((s) => s.percent === null)) return null;

    const kind = printerKindFrom(supplies.map((s) => s.type));
    const reading: BrotherReading = await readBrother(this.client, kind);

    const filled: string[] = [];
    for (const supply of supplies) {
      const percent = vendorPercentFor(supply, supplies, reading.maintenance, kind);
      if (percent === null) continue;
      supply.percent = percent;
      supply.vendorSourced = true;
      // `someRemaining` and `level` keep the -3 the printer actually sent. They
      // are the record of what the standard table said, and a number arriving
      // from somewhere else does not change that; every consumer already prefers
      // a percentage when there is one.
      filled.push(supply.index);
    }

    return {
      vendor: 'Brother',
      model: reading.model,
      firmware: reading.firmware,
      values: [...reading.maintenance, ...reading.nextcare, ...reading.counters].map((v) => ({
        key: v.key,
        value: v.value,
        isPercent: v.isPercent,
      })),
      filled,
    };
  }

  /**
   * Walks prtMarkerSuppliesTable and assembles one {@link Supply} per row.
   *
   * Nothing about the table is assumed: not the number of rows, not the indices,
   * not which columns the printer bothers to fill in. That is what lets one
   * driver serve a four-cartridge office printer and a nine-cartridge photo one.
   */
  private async readSupplies(): Promise<Supply[]> {
    const [descriptions, levels, capacities, types, classes, units, colorantIndices, colorants] =
      await Promise.all([
        this.client.walk(OID.suppliesDescription),
        this.client.walk(OID.suppliesLevel),
        this.client.walk(OID.suppliesMaxCapacity),
        this.client.walk(OID.suppliesType),
        this.client.walk(OID.suppliesClass),
        this.client.walk(OID.suppliesUnit),
        this.client.walk(OID.suppliesColorantIndex),
        this.client.walk(OID.colorantValue),
      ]);

    // Rows are keyed by the table index, which is "hrDeviceIndex.supplyIndex".
    const indices: string[] = [];
    for (const oid of levels.keys()) {
      const index = tableIndex(oid, OID.suppliesLevel);
      if (index !== null) indices.push(index);
    }
    // Numeric ordering, so supply 10 does not sort before supply 2.
    indices.sort((a, b) => compareIndex(a, b));

    const supplies: Supply[] = [];
    indices.forEach((index) => {
      const level = asNumber(levels.get(`${OID.suppliesLevel}.${index}`)) ?? -2;
      const capacity = asNumber(capacities.get(`${OID.suppliesMaxCapacity}.${index}`)) ?? -2;
      const type = decodeSupplyType(asNumber(types.get(`${OID.suppliesType}.${index}`)));
      const supplyClass = asNumber(classes.get(`${OID.suppliesClass}.${index}`));
      const description = asString(descriptions.get(`${OID.suppliesDescription}.${index}`)) ?? '';
      const unit = decodeSupplyUnit(asNumber(units.get(`${OID.suppliesUnit}.${index}`)));

      // The colorant index points into a second table; when it is absent or zero
      // the printer is telling us this supply has no colour of its own.
      const colorantIndex = asNumber(colorantIndices.get(`${OID.suppliesColorantIndex}.${index}`));
      const colorant =
        colorantIndex && colorantIndex > 0
          ? asString(colorants.get(`${OID.colorantValue}.${deviceOf(index)}.${colorantIndex}`))
          : null;

      const receptacle = isReceptacle(supplyClass, type);

      supplies.push({
        index,
        description,
        type,
        colour: classifySupplyColour(description, colorant, type),
        percent: supplyPercent(level, capacity, unit),
        someRemaining: level === -3,
        isReceptacle: receptacle,
        level,
        maxCapacity: capacity,
        unit,
        supplyClass,
      });
    });

    return supplies;
  }

  /**
   * Walks prtOutputTable, one row per output bin.
   *
   * A printer with no output sensor answers with an empty walk, which is the
   * honest "I cannot tell you" the caller needs — not something to paper over
   * with an assumed empty tray.
   */
  private async readOutputTrays(): Promise<OutputTray[]> {
    const [remainings, capacities, names, descriptions] = await Promise.all([
      this.client.walk(OID.outputRemainingCapacity),
      this.client.walk(OID.outputMaxCapacity),
      this.client.walk(OID.outputName),
      this.client.walk(OID.outputDescription),
    ]);

    const indices: string[] = [];
    for (const oid of remainings.keys()) {
      const index = tableIndex(oid, OID.outputRemainingCapacity);
      if (index !== null) indices.push(index);
    }
    indices.sort(compareIndex);

    return indices.map((index) => {
      const remaining = asNumber(remainings.get(`${OID.outputRemainingCapacity}.${index}`)) ?? -2;
      const maxCapacity = asNumber(capacities.get(`${OID.outputMaxCapacity}.${index}`)) ?? -2;
      const name = asString(names.get(`${OID.outputName}.${index}`))
        ?? asString(descriptions.get(`${OID.outputDescription}.${index}`))
        ?? '';

      return { index, name, remaining, maxCapacity, percentFree: outputPercentFree(remaining, maxCapacity) };
    });
  }

  /**
   * Walks prtInputTable, one row per paper tray.
   *
   * The media name is read too, because "Tray 2 · A4" is what lets a user tell
   * two identical trays apart — which is the whole point of showing them
   * separately rather than as one paper level.
   */
  private async readInputTrays(): Promise<InputTray[]> {
    const [levels, capacities, names, medias, descriptions, types] = await Promise.all([
      this.client.walk(OID.inputCurrentLevel),
      this.client.walk(OID.inputMaxCapacity),
      this.client.walk(OID.inputName),
      this.client.walk(OID.inputMediaName),
      this.client.walk(OID.inputDescription),
      this.client.walk(OID.inputType),
    ]);

    const indices: string[] = [];
    for (const oid of levels.keys()) {
      const index = tableIndex(oid, OID.inputCurrentLevel);
      if (index !== null) indices.push(index);
    }
    indices.sort(compareIndex);

    return indices.map((index) => {
      const level = asNumber(levels.get(`${OID.inputCurrentLevel}.${index}`)) ?? -2;
      const maxCapacity = asNumber(capacities.get(`${OID.inputMaxCapacity}.${index}`)) ?? -2;
      const name = asString(names.get(`${OID.inputName}.${index}`))
        ?? asString(descriptions.get(`${OID.inputDescription}.${index}`))
        ?? '';

      return {
        index,
        name,
        media: asString(medias.get(`${OID.inputMediaName}.${index}`)) ?? '',
        type: decodeInputType(asNumber(types.get(`${OID.inputType}.${index}`))),
        level,
        maxCapacity,
        percent: inputPercent(level, maxCapacity),
      };
    });
  }

  /** Walks prtCoverTable, one row per door, lid or interlock the printer can sense. */
  private async readCovers(): Promise<PrinterCover[]> {
    const [statuses, descriptions] = await Promise.all([
      this.client.walk(OID.coverStatus),
      this.client.walk(OID.coverDescription),
    ]);

    const indices: string[] = [];
    for (const oid of statuses.keys()) {
      const index = tableIndex(oid, OID.coverStatus);
      if (index !== null) indices.push(index);
    }
    indices.sort(compareIndex);

    return indices.map((index) => ({
      description: asString(descriptions.get(`${OID.coverDescription}.${index}`)) ?? '',
      open: decodeCoverStatus(asNumber(statuses.get(`${OID.coverStatus}.${index}`))),
    }));
  }

  /**
   * Walks prtAlertTable — the printer's own account of what is wrong.
   *
   * Every severity is kept, including `other`: vendors file plenty of genuinely
   * useful rows under it, and dropping them would throw away the exact wording
   * that tells a user which cartridge to buy.
   */
  private async readAlerts(): Promise<PrinterAlert[]> {
    const [severities, descriptions, codes, groups] = await Promise.all([
      this.client.walk(OID.alertSeverity),
      this.client.walk(OID.alertDescription),
      this.client.walk(OID.alertCode),
      this.client.walk(OID.alertGroup),
    ]);

    const indices: string[] = [];
    for (const oid of severities.keys()) {
      const index = tableIndex(oid, OID.alertSeverity);
      if (index !== null) indices.push(index);
    }
    indices.sort(compareIndex);

    return indices.map((index) => ({
      severity: decodeAlertSeverity(asNumber(severities.get(`${OID.alertSeverity}.${index}`))),
      code: asNumber(codes.get(`${OID.alertCode}.${index}`)),
      group: asNumber(groups.get(`${OID.alertGroup}.${index}`)),
      description: asString(descriptions.get(`${OID.alertDescription}.${index}`)) ?? '',
    }));
  }
}

/**
 * Reconciles the two status objects the Host Resources MIB offers.
 *
 * hrPrinterStatus is the one that says what the engine is doing, so it wins
 * whenever it says anything useful. It is also the one printers most often leave
 * at `unknown` while hrDeviceStatus correctly reports `down` — a jam or an empty
 * tray that would otherwise show up as no status at all.
 */
function resolveStatus(status: PrinterStatus, deviceStatus: number | null): PrinterStatus {
  if (status !== 'unknown' && status !== 'other') return status;
  return DEVICE_STATUS[deviceStatus ?? 0] === 'down' ? 'offline' : status;
}

/** The device half of a "device.supply" table index. */
function deviceOf(index: string): string {
  return index.split('.')[0] ?? '1';
}

/** Compares dotted numeric indices component by component. */
function compareIndex(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
