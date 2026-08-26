import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { guardSession } from '../lib/snmp-client.mjs';

/**
 * The crash this file exists to prevent.
 *
 * net-snmp parses every datagram that lands on its socket. When one is not
 * valid SNMP it catches the parse failure and re-emits it as an `error` event —
 * and an EventEmitter with no `error` listener rethrows. That throw happens
 * inside the socket's own message handler, outside every promise chain the app
 * has, so no `try`/`catch` around a read can reach it and the app dies:
 *
 *   TypeError: Value read as integer null is not an integer
 *       at readInt32 → Message.createFromBuffer → Session.onMsg
 *       → Socket.emit → UDP.onMessage
 *
 * Real crash reports from 1.1.3 on a live network. Node's own semantics are
 * what make it fatal, so the test is about those semantics rather than about
 * SNMP: an unguarded emitter throws, a guarded one does not.
 */
describe('a session that receives something that is not SNMP', () => {
  it('would kill the app without a guard — this is the behaviour being fixed', () => {
    const bare = new EventEmitter();

    // Node rethrows an 'error' event nobody is listening for. If this ever
    // stops being true the guard is pointless, and this test says so.
    assert.throws(
      () => bare.emit('error', new TypeError('Value read as integer null is not an integer')),
      /not an integer/,
    );
  });

  it('survives the parse failure once guarded', () => {
    const session = new EventEmitter();
    guardSession(session);

    assert.doesNotThrow(() => {
      session.emit('error', new TypeError('Value read as integer null is not an integer'));
    });
  });

  it('hands the reason back, so a timeout can say why it timed out', () => {
    const session = new EventEmitter();
    const seen: string[] = [];
    guardSession(session, (message) => seen.push(message));

    session.emit('error', new TypeError('Value read as integer null is not an integer'));

    assert.deepEqual(seen, ['Value read as integer null is not an integer']);
  });

  it('keeps working when the emitted error is not an Error at all', () => {
    // A malformed datagram is already off the happy path; whatever net-snmp
    // hands over must not be assumed to have `.message`.
    const session = new EventEmitter();
    const seen: string[] = [];
    guardSession(session, (message) => seen.push(message));

    assert.doesNotThrow(() => session.emit('error', 'plain string' as unknown as Error));
    assert.doesNotThrow(() => session.emit('error', undefined as unknown as Error));

    assert.equal(seen.length, 2);
    for (const message of seen) assert.equal(typeof message, 'string');
  });

  it('survives a burst, which is what a subnet sweep produces', () => {
    // The sweep asks 254 addresses at once. One badly behaved device answering
    // repeatedly must not be able to take the app down either.
    const session = new EventEmitter();
    let count = 0;
    guardSession(session, () => { count += 1; });

    assert.doesNotThrow(() => {
      for (let i = 0; i < 254; i += 1) session.emit('error', new TypeError('nope'));
    });
    assert.equal(count, 254);
  });
});
