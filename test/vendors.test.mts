import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { suggestDeviceName, vendorName } from '../lib/vendors.mjs';

describe('vendorName', () => {
  it('names the manufacturers we know', () => {
    assert.equal(vendorName(1248), 'Epson');
    assert.equal(vendorName(11), 'HP');
    assert.equal(vendorName(2435), 'Brother');
  });

  it('returns null for an unknown number, which means unbranded, not unsupported', () => {
    assert.equal(vendorName(999999), null);
    assert.equal(vendorName(null), null);
  });
});

describe('suggestDeviceName', () => {
  it('does not repeat a brand the model already states', () => {
    // Otherwise the user adopts an "Epson EPSON XP-6100 Series".
    assert.equal(
      suggestDeviceName('EPSON XP-6100 Series', 'Epson', 'EPSONC618AD', '192.168.50.75'),
      'EPSON XP-6100 Series',
    );
  });

  it('prepends the brand when the model omits it', () => {
    assert.equal(
      suggestDeviceName('ECOSYS M5526CDW', 'Kyocera', null, '192.168.1.9'),
      'Kyocera ECOSYS M5526CDW',
    );
  });

  it('falls back to the network name when there is no model', () => {
    assert.equal(suggestDeviceName(null, null, 'EPSONC618AD', '192.168.50.75'), 'EPSONC618AD');
  });

  it('falls back to the address when the printer says nothing about itself', () => {
    assert.equal(suggestDeviceName(null, null, null, '192.168.50.75'), 'Printer 192.168.50.75');
  });
});
