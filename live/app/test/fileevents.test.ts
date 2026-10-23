// Flow page > Output > Changes: added and removed files in the work folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffFiles, listAll } from '../src/fileevents.ts';

test('diffFiles reports removed and added files', () => {
  const ev = diffFiles(['a.pdf', 'junk/a.tmp', 'junk/keep.txt'], ['a.pdf', 'junk/keep.txt', 'b.md'], 5);
  assert.deepEqual(ev, [{ at: 5, kind: 'removed', path: 'junk/a.tmp' }, { at: 5, kind: 'added', path: 'b.md' }]);
});

test('listAll walks sub-folders with forward slashes and skips dot-folders', () => {
  const w = mkdtempSync(join(tmpdir(), 'orch-'));
  mkdirSync(join(w, 'junk')); mkdirSync(join(w, '.git')); writeFileSync(join(w, 'junk', 'a.tmp'), 'x'); writeFileSync(join(w, '.git', 'HEAD'), 'x'); writeFileSync(join(w, 'r.pdf'), 'x');
  assert.deepEqual(listAll(w).sort(), ['junk/a.tmp', 'r.pdf']);
  rmSync(join(w, 'junk', 'a.tmp'));
  assert.deepEqual(listAll(w), ['r.pdf']);
});
