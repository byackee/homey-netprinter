/**
 * Turns raw SNMP traffic into one printer snapshot.
 *
 * This is the only place that knows both the wire format and the domain, so the
 * driver and the device never touch an OID.
 */

import { SnmpClient, type SnmpVersion, type SnmpValue } from './snmp-client.mjs';
import {
  OID,
  classifySupplyColour,
  decodeErrorState,
  decodePrinterStatus,
  decodeSupplyType,
  enterpriseNumber,
  isReceptacle,
  supplyPercent,
  type PrinterErrorFlag,
  type PrinterStatus,
  type Supply,
} from './printer-mib.mjs';

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

  constructor(host: string, community: string, version: SnmpVersion, timeout?: number) {
    this.client = new SnmpClient({ host, community, version, timeout });
  }

  /**
   * Reads the fields that identify a printer, without the supplies table.
   *
   * Pairing uses this: it is one round trip, so an unreachable address fails fast
   * instead of making the user wait through a full walk.
   */
  async readIdentity(): Promise<PrinterIdentity> {
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
    const scalarOids = [
      OID.hrDeviceDescr,
      OID.prtGeneralPrinterName,
      OID.sysName,
      OID.prtGeneralSerialNumber,
      OID.sysObjectID,
      OID.hrPrinterStatus,
      OID.prtConsoleDisplayBufferText,
      OID.prtMarkerLifeCount,
    ];

    // The error state is a bit string, so it is fetched raw: decoding it as text
    // would mangle the bytes we need to test.
    const [scalars, errorRaw, supplies] = await Promise.all([
      this.client.get(scalarOids),
      this.client.get([OID.hrPrinterDetectedErrorState], true),
      this.readSupplies(),
    ]);

    const rawError = errorRaw.get(OID.hrPrinterDetectedErrorState);

    return {
      model: asString(scalars.get(OID.hrDeviceDescr)) ?? asString(scalars.get(OID.prtGeneralPrinterName)),
      name: asString(scalars.get(OID.sysName)),
      serial: asString(scalars.get(OID.prtGeneralSerialNumber)),
      enterprise: enterpriseNumber(asString(scalars.get(OID.sysObjectID))),
      status: decodePrinterStatus(asNumber(scalars.get(OID.hrPrinterStatus))),
      displayText: asString(scalars.get(OID.prtConsoleDisplayBufferText)),
      pageCount: asNumber(scalars.get(OID.prtMarkerLifeCount)),
      errors: decodeErrorState(Buffer.isBuffer(rawError) ? rawError : null),
      supplies,
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
    const [descriptions, levels, capacities, types, classes, colorantIndices, colorants] =
      await Promise.all([
        this.client.walk(OID.suppliesDescription),
        this.client.walk(OID.suppliesLevel),
        this.client.walk(OID.suppliesMaxCapacity),
        this.client.walk(OID.suppliesType),
        this.client.walk(OID.suppliesClass),
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
    indices.forEach((index, position) => {
      const level = asNumber(levels.get(`${OID.suppliesLevel}.${index}`)) ?? -2;
      const capacity = asNumber(capacities.get(`${OID.suppliesMaxCapacity}.${index}`)) ?? -2;
      const type = decodeSupplyType(asNumber(types.get(`${OID.suppliesType}.${index}`)));
      const supplyClass = asNumber(classes.get(`${OID.suppliesClass}.${index}`));
      const description = asString(descriptions.get(`${OID.suppliesDescription}.${index}`)) ?? '';

      // The colorant index points into a second table; when it is absent or zero
      // the printer is telling us this supply has no colour of its own.
      const colorantIndex = asNumber(colorantIndices.get(`${OID.suppliesColorantIndex}.${index}`));
      const colorant =
        colorantIndex && colorantIndex > 0
          ? asString(colorants.get(`${OID.colorantValue}.${deviceOf(index)}.${colorantIndex}`))
          : null;

      const receptacle = isReceptacle(supplyClass, type);

      supplies.push({
        index: position + 1,
        description,
        type,
        colour: classifySupplyColour(description, colorant, type),
        percent: supplyPercent(level, capacity, receptacle),
        someRemaining: level === -3,
        isReceptacle: receptacle,
      });
    });

    return supplies;
  }
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
