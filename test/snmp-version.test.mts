import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bestVersion,
  betterVersion,
  versionScore,
  type VersionProbes,
} from '../lib/snmp-client.mjs';

const probes = (
  v2c: { answers: boolean; walks: boolean },
  v1: { answers: boolean; walks: boolean },
): VersionProbes => [['v2c', v2c], ['v1', v1]];

const silent = { answers: false, walks: false };
const replies = { answers: true, walks: false };
const reads = { answers: true, walks: true };

describe('versionScore', () => {
  it('ranks reading above replying above silence', () => {
    assert.equal(versionScore(reads), 2);
    assert.equal(versionScore(replies), 1);
    assert.equal(versionScore(silent), 0);
    assert.equal(versionScore(undefined), 0);
  });
});

describe('bestVersion', () => {
  it('prefers v2c when both versions do the same', () => {
    assert.equal(bestVersion(probes(reads, reads)), 'v2c');
    assert.equal(bestVersion(probes(replies, replies)), 'v2c');
  });

  /**
   * Mike1233's Brother MFC-DW4540W. It answers sysDescr on v2c perfectly well
   * and times out on every table walk, so a probe that asked one question chose
   * v2c and gave him a device that read nothing. The second question is what
   * separates the two.
   */
  it('chooses the version that can read a table over the one that only replies', () => {
    assert.equal(bestVersion(probes(replies, reads)), 'v1');
  });

  it('still answers for a printer that publishes no supplies table at all', () => {
    assert.equal(bestVersion(probes(replies, replies)), 'v2c');
    assert.equal(bestVersion(probes(silent, replies)), 'v1');
  });

  it('says nothing answered when nothing did', () => {
    assert.equal(bestVersion(probes(silent, silent)), null);
  });
});

describe('betterVersion', () => {
  /**
   * The regression this exists for. Mike1233 set his printer to v1 by hand,
   * twice, and found it back on v2c hours later: the outage handler probed, v2c
   * answered a plain GET, and the app moved a working device onto the version
   * that reads nothing.
   */
  it('leaves a device on v1 when v2c only answers a scalar', () => {
    assert.equal(betterVersion(probes(replies, reads), 'v1'), null);
  });

  it('leaves a device alone when both versions do exactly the same', () => {
    assert.equal(betterVersion(probes(reads, reads), 'v1'), null);
    assert.equal(betterVersion(probes(replies, replies), 'v1'), null);
  });

  /**
   * And the case renegotiation was added for, which still has to work: a
   * firmware update switches v2c off under a device paired on it.
   */
  it('moves a device off a version that has stopped answering', () => {
    assert.equal(betterVersion(probes(silent, reads), 'v2c'), 'v1');
    assert.equal(betterVersion(probes(silent, replies), 'v2c'), 'v1');
  });

  it('moves a device onto a version that can read when its own cannot', () => {
    assert.equal(betterVersion(probes(reads, replies), 'v1'), 'v2c');
  });

  it('stays put when neither version answers, rather than switching blind', () => {
    assert.equal(betterVersion(probes(silent, silent), 'v1'), null);
    assert.equal(betterVersion(probes(silent, silent), 'v2c'), null);
  });

  it('never proposes the version already in use', () => {
    assert.equal(betterVersion(probes(reads, silent), 'v2c'), null);
  });
});
