// Activity feed: one readable line per agent action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCall } from '../src/activityfeed.ts';

test('tool calls read as what the agent did', () => {
  assert.equal(describeCall('exec', { command: "Remove-Item 'E:\\w\\junk5\\*.tmp'" }), "ran: Remove-Item 'E:\\w\\junk5\\*.tmp'");
  assert.equal(describeCall('write', { path: 'E:\\w\\r.md', content: 'hello' }), 'wrote: E:\\w\\r.md (5 chars)');
  assert.equal(describeCall('team_post', { to: 'user', message: 'Done: deleted b.tmp' }), '-> user: Done: deleted b.tmp');
  assert.equal(describeCall('team_assign', { worker: 'worker', model: 'fast', job: 'Delete b.tmp' }), 'assigned worker (fast): Delete b.tmp');
  assert.match(describeCall('mystery_tool', { x: 1 }), /^mystery_tool: \{"x":1\}$/);
});
