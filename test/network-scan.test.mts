import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { subnetOf } from '../lib/network-scan.mjs';

describe('subnetOf', () => {
  it('reads the /24 from the address Homey reports', () => {
    // The exact shape getLocalAddress() returns.
    assert.equal(subnetOf('192.168.50.251:80'), '192.168.50');
  });

  it('accepts a bare address without a port', () => {
    assert.equal(subnetOf('10.0.1.4'), '10.0.1');
  });

  it('refuses anything that is not IPv4 rather than guessing a subnet', () => {
    // Guessing here would sweep an address range that does not exist.
    assert.equal(subnetOf(''), null);
    assert.equal(subnetOf('homey.local'), null);
    assert.equal(subnetOf('192.168.50'), null);
    assert.equal(subnetOf('fe80::1'), null);
  });

  it('refuses octets outside 0-255', () => {
    assert.equal(subnetOf('192.168.300.1'), null);
  });

  it('refuses an address with an empty octet', () => {
    assert.equal(subnetOf('192..50.251'), null);
  });
});
