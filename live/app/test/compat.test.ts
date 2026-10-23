import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { Compat } from '../src/compat.ts';

test('a post appended to BOARD.md by the GUI is never overwritten by the export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trav-compat-'));
  writeFileSync(join(dir, 'BOARD.md'), '# Agent Board\n\n## [2026-10-11 10:00] jr -> main\nfirst\n');
  const store = new Store(':memory:'); const c = new Compat(store, dir);
  c.importInitial(); c.exportAll([]);
  appendFileSync(join(dir, 'BOARD.md'), '\n## [2026-10-11 17:32] jr -> main\nplease make the planets PDF\n');   // GUI append
  store.addPost('system', 'main', 'something Orchestra posted during the pass');
  const late = c.exportAll([]);
  assert.equal(late, 1, 'appended post imported before the rewrite');
  const board = readFileSync(join(dir, 'BOARD.md'), 'utf8');
  assert.match(board, /please make the planets PDF/); assert.match(board, /something Orchestra posted/);
  assert.equal(store.posts().filter((p) => /planets PDF/.test(p.body)).length, 1, 'imported exactly once');
});

test('takeover: old TASK lines on the board never become tasks; new ones do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trav-compat-'));
  writeFileSync(join(dir, 'BOARD.md'), '# B\n\n## [2026-10-10 09:00] main -> all\nTASK worker: an old finished task from yesterday\n');
  const store = new Store(':memory:'); const c = new Compat(store, dir);
  c.importInitial();
  assert.ok(store.get<string>('taskEpoch', ''), 'epoch set at takeover');
  assert.ok(existsSync(join(dir, 'BOARD.md')));
});
