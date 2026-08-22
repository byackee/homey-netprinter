import { scanSubnet, subnetOf } from '../lib/network-scan.mjs';

const subnet = subnetOf(process.argv[2] ?? '192.168.50.251:80');
if (!subnet) { console.error('bad address'); process.exit(1); }
console.log('sweeping', `${subnet}.1-254`);
const start = Date.now();
const found = await scanSubnet(subnet);
console.log(`took ${((Date.now() - start) / 1000).toFixed(1)}s, found ${found.length}`);
console.table(found);
process.exit(0);
