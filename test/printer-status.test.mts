import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveStatus } from '../lib/printer-reader.mjs';

describe('resolveStatus', () => {
  // hrDeviceStatus: 2 running, 3 warning, 5 down.
  it('reads running and other as Standby, which is ready (RFC 3805)', () => {
    // An HP Color LaserJet Pro 3202dw said "Other" on SNMP, "Ready" over IPP.
    assert.equal(resolveStatus('other', 2), 'idle');
  });

  it('keeps other when the device is not plainly running', () => {
    assert.equal(resolveStatus('other', 3), 'other');
    assert.equal(resolveStatus('other', null), 'other');
  });

  it('does not call a printer ready while it reports a fault', () => {
    assert.equal(resolveStatus('other', 2, ['jammed']), 'other');
  });

  it('does not turn a printer declining to say into ready', () => {
    assert.equal(resolveStatus('unknown', 2), 'unknown');
  });

  it('still reads a device that is down as offline', () => {
    assert.equal(resolveStatus('other', 5), 'offline');
    assert.equal(resolveStatus('unknown', 5), 'offline');
  });

  it('leaves a status the engine states alone', () => {
    assert.equal(resolveStatus('printing', 5), 'printing');
    assert.equal(resolveStatus('idle', 2), 'idle');
  });
});
