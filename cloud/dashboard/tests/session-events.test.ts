import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, deriveStatus, mergeEvents, isTerminal } from '../lib/session-events';

test('malformed stream frames do not crash the session view', () => {
  for (const raw of ['{', 'null', '[]', '{"type":"session_state"}', '{"type":"session_state","payload":{}}']) assert.equal(parseFrame(raw), null);
});
test('tool warnings do not terminate the session', () => {
  assert.equal(deriveStatus({ type: 'error', payload: { message: 'embedding index unavailable' } }), null);
  assert.equal(deriveStatus({ type: 'session_error' }), 'failed');
  assert.equal(deriveStatus({ type: 'plan_approved' }), 'running');
  assert.equal(deriveStatus({ type: 'session_cancelled' }), 'aborted');
});
test('replay preserves existing activity, removes duplicates by id, and sorts oldest first', () => {
  const a = { id: 'a', type: 'tool_call', timestamp: 1 };
  const b = { id: 'b', type: 'tool_result', timestamp: 2 };
  const c = { id: 'c', type: 'done', timestamp: 3 };
  assert.deepEqual(mergeEvents([a, b], [c, b, a]), [a, b, c]);
  assert.deepEqual(mergeEvents([a, b], [c], 2), [b, c]);
});
test('only terminal session statuses stop reconnecting', () => {
  assert.equal(isTerminal('reviewing'), false); assert.equal(isTerminal('failed'), true); assert.equal(isTerminal('complete'), true);
});
