// Team rules acceptance suite: outbox, tasks, DONE checks, cancel, renumbering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { ingestOutbox } from '../src/outbox.ts';
import { applyPosts, autoDone, shouldRenumber, guardBoard, isPlaceholderTask, parseCommands, minuteOf, workPaths, type Task, type Stat } from '../src/rules.ts';

const W = 'D:\\Team\\work';
const realStat = (files: Record<string, { size: number; mtimeMs: number }>): Stat => (p) => (files[p] ? { exists: true, ...files[p] } : { exists: false, size: 0, mtimeMs: 0 });
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'orchestra-')); return { dir, store: new Store(':memory:'), outbox: join(dir, 'outbox') }; };
function drop(outbox: string, name: string, text: string, ageSec = 30) {
  mkdirSync(outbox, { recursive: true });
  const p = join(outbox, name); writeFileSync(p, text); const t = (Date.now() - ageSec * 1000) / 1000; utimesSync(p, t, t);
}
function pass(store: Store, tasks: Task[], extra: Partial<Parameters<typeof applyPosts>[2]> = {}) {
  return applyPosts(store.posts(), tasks, { now: new Date(), workDir: W, stat: realStat({}), seenRejections: new Set(), ...extra });
}

test('outbox: post appended with author from file name and recipient from to: line', () => {
  const { store, outbox } = fresh();
  drop(outbox, 'worker-report.md', 'to: main\nfirst line\n## sneaky heading');
  ingestOutbox(store, outbox);
  const [p] = store.posts();
  assert.equal(p.from, 'worker'); assert.equal(p.to, 'main');
  assert.match(p.body, /^### sneaky heading$/m, '## demoted to ###');
  assert.equal(existsSync(join(outbox, 'worker-report.md')), false, 'moved to done');
  assert.equal(readdirSync(join(outbox, 'done')).length, 1);
});

test('outbox: duplicate post skipped, fresh file (< 5 s) left alone', () => {
  const { store, outbox } = fresh();
  drop(outbox, 'worker-a.md', 'to: main\nsame text'); ingestOutbox(store, outbox);
  drop(outbox, 'worker-b.md', 'to: main\nsame   text'); const r = ingestOutbox(store, outbox);
  assert.equal(r[0].reason, 'duplicate'); assert.equal(store.posts().length, 1);
  drop(outbox, 'worker2-fresh.md', 'to: main\nstill writing', 1);
  ingestOutbox(store, outbox);
  assert.ok(existsSync(join(outbox, 'worker2-fresh.md')));
});

test('outbox: literal \\n before a command splits it; inside a Windows path it stays', () => {
  const { store, outbox } = fresh();
  drop(outbox, 'main-multi.md', 'to: all\nTASK worker: fetch the newegg page for a laptop GPU\\nTASK worker2: compare it with ebay prices');
  drop(outbox, 'main-path.md', 'to: all\nTASK worker: save the notes to D:\\Team\\notes\\new.md please', 29);
  ingestOutbox(store, outbox);
  const tasks: Task[] = []; pass(store, tasks);
  assert.ok(tasks.some((t) => t.text === 'compare it with ebay prices'));
  assert.ok(!tasks.some((t) => /\\nTASK/.test(t.text)));
  assert.ok(tasks.some((t) => t.text.includes('D:\\Team\\notes\\new.md')));
});

test('tasks: commanders create, placeholders ignored, workers cannot create or cancel', () => {
  const { store } = fresh();
  store.addPost('main', 'all', 'TASK worker: research used laptop GPU prices into work\\gpu.md\nTASK worker2: what the worker should do\nTASK worker2: summarize work\\gpu.md into five lines');
  store.addPost('worker', 'all', 'TASK worker2: worker trying to create a task for worker2');
  const tasks: Task[] = []; const fx = pass(store, tasks);
  assert.equal(tasks.length, 2);
  assert.equal(fx.ignoredPlaceholders.length, 1, 'placeholder ignored');
  store.addPost('worker2', 'main', `CANCEL ${tasks[1].id}`); pass(store, tasks);
  assert.equal(tasks[1].status, 'open', 'worker cannot cancel');
  store.addPost('user', 'all', `CANCEL ${tasks[1].id}`); pass(store, tasks);
  assert.equal(tasks[1].status, 'cancelled', 'the user can cancel');
  const again = pass(store, tasks);
  assert.equal(again.created.length, 0, 'idempotent: re-reading posts creates nothing new');
});

test('DONE verification: rejected while the file is missing, told once, accepted when it exists', () => {
  const { store } = fresh();
  store.addPost('main', 'all', 'TASK worker: write the primes below 100 to D:\\Team\\work\\primes.txt.');
  const tasks: Task[] = []; pass(store, tasks);
  store.addPost('worker', 'main', `all good DONE ${tasks[0].id}`);
  const seen = new Set<string>();
  const fx1 = pass(store, tasks, { seenRejections: seen });
  assert.equal(tasks[0].status, 'open'); assert.equal(fx1.rejected.length, 1);
  assert.deepEqual(fx1.rejected[0].missing, [W + '\\primes.txt']);
  assert.equal(pass(store, tasks, { seenRejections: seen }).rejected.length, 0, 'notice not repeated');
  pass(store, tasks, { seenRejections: seen, stat: realStat({ [W + '\\primes.txt']: { size: 5, mtimeMs: Date.now() } }) });
  assert.equal(tasks[0].status, 'done');
});

test('auto-done: closes a started task once all its files exist and are newer than the task', () => {
  const t: Task = { id: 'T1', assignee: 'worker2', text: 'write D:\\Team\\work\\squares.md and D:\\Team\\work\\squares.pdf', status: 'open', attempts: 1, by: 'main', created: new Date(Date.now() - 60000).toISOString(), updated: '' };
  const half = realStat({ [W + '\\squares.md']: { size: 3, mtimeMs: Date.now() } });
  assert.equal(autoDone([t], W, half, new Date()).length, 0);
  const old = realStat({ [W + '\\squares.md']: { size: 3, mtimeMs: Date.now() }, [W + '\\squares.pdf']: { size: 3, mtimeMs: Date.now() - 3600000 } });
  assert.equal(autoDone([t], W, old, new Date()).length, 0, 'a file older than the task does not count');
  const stubs = realStat({ [W + '\\squares.md']: { size: 3, mtimeMs: Date.now() }, [W + '\\squares.pdf']: { size: 3, mtimeMs: Date.now() } });
  assert.equal(autoDone([t], W, stubs, new Date()).length, 0, 'near-empty stub files are not a finished task');
  const both = realStat({ [W + '\\squares.md']: { size: 400, mtimeMs: Date.now() }, [W + '\\squares.pdf']: { size: 9000, mtimeMs: Date.now() } });
  assert.equal(autoDone([t], W, both, new Date()).length, 1); assert.equal(t.status, 'done');
});

test('renumbering: archive when all finished + idle 1 h; old posts never touch new tasks', () => {
  const { store } = fresh();
  const longAgo = new Date(Date.now() - 2 * 3600000);
  store.addPost('main', 'all', 'TASK worker: an old task that was finished long ago', { now: longAgo });
  store.addPost('worker', 'main', 'DONE T1', { now: longAgo });
  const tasks: Task[] = []; pass(store, tasks, { now: longAgo });
  tasks[0].status = 'done'; tasks[0].updated = longAgo.toISOString();
  assert.ok(shouldRenumber(tasks, new Date()));
  store.saveTasks(tasks); assert.equal(store.archiveTasks('test'), 1); assert.equal(store.tasks().length, 0);
  const epoch = minuteOf(new Date(Date.now() - 1000));
  const t2: Task[] = []; const fx = pass(store, t2, { epoch });
  assert.equal(fx.created.length, 0, 'old TASK line not re-created');
  store.addPost('main', 'all', 'TASK worker: write a fresh file D:\\Team\\work\\fresh-after-reset.txt');
  pass(store, t2, { epoch });
  assert.equal(t2[0].id, 'T1'); assert.equal(t2[0].status, 'open', 'old "DONE T1" ignored');
});

test('board guard restores posts after an overwrite and keeps the new one', () => {
  const g = guardBoard(['a', 'b', 'c'], ['x']);
  assert.ok(g.overwritten); assert.deepEqual(g.restored, ['a', 'b', 'c', 'x']);
});

test('MODEL / TOOLS parsing accepts aliases with digits', () => {
  const c = parseCommands('MODEL worker=coder3\nTOOLS worker2=web, shell\nMODEL main: smart');
  assert.deepEqual(c.models, [{ agent: 'worker', alias: 'coder3' }, { agent: 'main', alias: 'smart' }]);
  assert.deepEqual(c.tools, [{ agent: 'worker2', groups: ['web', 'shell'] }]);
});

test('workPaths: only work-folder files with an extension, trailing punctuation stripped', () => {
  assert.deepEqual(workPaths('save to D:\\w\\a.md. Then D:\\w\\folder only', 'D:\\w'), ['D:\\w\\a.md']);
  assert.ok(isPlaceholderTask('JOB'));
});

test('agent talk: say/read delivers to the recipient and to all, not to the sender, once', () => {
  const { store } = fresh();
  store.say('worker', 'worker2', 'check my primes file'); store.say('main', 'all', 'everyone stop');
  assert.deepEqual(store.readTalk('worker2').map((m) => m.text), ['check my primes file', 'everyone stop']);
  assert.equal(store.readTalk('worker2').length, 0);
  assert.deepEqual(store.readTalk('worker').map((m) => m.text), ['everyone stop']);
});
