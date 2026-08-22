import { negotiateVersion } from '../lib/snmp-client.mjs';
import { PrinterReader } from '../lib/printer-reader.mjs';

const host = process.argv[2] ?? '192.168.50.75';
const community = process.argv[3] ?? 'public';

const version = await negotiateVersion(host, community);
if (!version) { console.error('unreachable'); process.exit(1); }
console.log('negotiated version:', version);

const reader = new PrinterReader(host, community, version);
console.log('--- identity ---');
console.log(await reader.readIdentity());
console.log('--- snapshot ---');
const snap = await reader.read();
const { supplies, ...rest } = snap;
console.log(rest);
console.table(supplies);
process.exit(0);
