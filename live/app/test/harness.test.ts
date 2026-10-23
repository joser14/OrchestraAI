// Harness v2: work-folder paths on any PC, team size, and the brain's agenda (handled watermark, finished-work
// memory) against a real Store in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workPaths, parseCommands } from '../src/rules.ts';
import { workerNames, applyTeamSize, clampWorkers, isWorker } from '../src/team.ts';
import { Store } from '../src/store.ts';
import { brief, commitHandled, needsMain } from '../src/brief.ts';

test('workPaths: legacy C:\\Agent\\work, this PC\'s folder with / or \\, trailing punctuation', () => {
  assert.deepEqual(workPaths('saved as C:\\Agent\\work\\planets.md, then a PDF.', 'C:\\Agent\\work'), ['C:\\Agent\\work\\planets.md']);
  assert.deepEqual(workPaths('save to /home/a/Orchestra/work/notes/x.md.', '/home/a/Orchestra/work'), ['/home/a/Orchestra/work/notes/x.md']);
  assert.deepEqual(workPaths('save as C:\\Agent\\work\\x.md', 'C:\\Users\\b\\Orchestra\\work'), ['C:\\Users\\b\\Orchestra\\work\\x.md']);
  assert.deepEqual(workPaths('save as C:/Users/b/Orchestra/work/y.csv', 'C:\\Users\\b\\Orchestra\\work'), ['C:\\Users\\b\\Orchestra\\work\\y.csv']);
  assert.deepEqual(workPaths('no file named here', 'C:\\Agent\\work'), []);
});

test('team size: 1-8 workers, names, in-place update, commands for worker5', () => {
  assert.deepEqual(workerNames(3), ['worker', 'worker2', 'worker3']);
  assert.equal(clampWorkers(0), 1); assert.equal(clampWorkers(99), 8);
  const cfg: any = { workers: ['worker', 'worker2'], agents: ['main', 'worker', 'worker2'] }; const ref = cfg.workers;
  applyTeamSize(cfg, 4); assert.equal(cfg.workers, ref); assert.deepEqual(cfg.agents, ['main', 'worker', 'worker2', 'worker3', 'worker4']);
  assert.ok(isWorker('worker8') && !isWorker('worker9') && !isWorker('main'));
  assert.deepEqual(parseCommands('TASK worker5: write C:\\Agent\\work\\a.md').tasks, [{ assignee: 'worker5', text: 'write C:\\Agent\\work\\a.md' }]);
});

function fakeTeam() {
  const root = mkdtempSync(join(tmpdir(), 'trav-')); mkdirSync(join(root, 'logs')); mkdirSync(join(root, 'work'));
  const store = new Store(join(root, 't.db'));
  const o: any = {
    store, cfg: { workDir: join(root, 'work'), logDir: join(root, 'logs'), workers: ['worker', 'worker2'], agents: ['main', 'worker', 'worker2'], aliases: { fast: 'x' }, maxTempC: 86, maxAttempts: 3 },
    jobs: {}, running: () => false, runMins: () => 0,
  };
  return { o, store, root };
}

test('agenda: a jr request is new until a pass ends with team_sleep; finished work is listed as done', () => {
  const { o, store, root } = fakeTeam();
  store.addPost('jr', 'main', 'Make a PDF about the planets');
  let b = brief(o, 'main');
  assert.match(b, /NEW REQUEST from jr/); assert.match(b, /planets/);
  // main crashed before team_sleep: the request is still on the agenda
  b = brief(o, 'main'); assert.match(b, /NEW REQUEST from jr/);
  commitHandled(o);   // team_sleep
  b = brief(o, 'main'); assert.doesNotMatch(b, /NEW REQUEST/); assert.match(b, /Nothing needs you/);
  assert.match(b, /EARLIER REQUESTS \(already handled\)/);
  // a finished task shows under FINISHED LATELY and as something to report
  const now = new Date().toISOString(); writeFileSync(join(root, 'work', 'p.md'), '# p');
  store.saveTasks([{ id: 'T1', assignee: 'worker', text: `planets saved as ${join(root, 'work', 'p.md')}`, status: 'done', attempts: 1, by: 'main', created: now, updated: new Date(Date.now() + 1000).toISOString() }]);
  b = brief(o, 'main'); assert.match(b, /FINISHED T1 by worker/); assert.match(b, /FINISHED LATELY[\s\S]*T1/); assert.match(b, /p\.md/);
});

test('agenda: worker results and questions are actions; progress notes are chatter', () => {
  const { o, store } = fakeTeam();
  commitHandled(o); brief(o, 'main'); commitHandled(o);
  store.addPost('worker', 'main', 'Starting T2: will search the web and write the table');
  store.addPost('worker2', 'main', 'Which year should the report cover?');
  store.addPost('worker', 'main', 'DONE T2\nmade prices.md');
  const b = brief(o, 'main');
  assert.match(b, /QUESTION from worker2/); assert.match(b, /RESULT from worker for T2/);
  assert.match(b, /TEAM CHATTER[\s\S]*Starting T2/);
  assert.ok(needsMain({ id: 1, ts: '', from: 'worker', to: 'main', body: 'DONE T4' }));
  assert.ok(!needsMain({ id: 1, ts: '', from: 'worker', to: 'main', body: 'Starting T4: reading the page' }));
});

test('worker brief: its task, teammates, and how to report', () => {
  const { o, store } = fakeTeam(); const now = new Date().toISOString();
  store.saveTasks([
    { id: 'T1', assignee: 'worker', text: 'write C:\\Agent\\work\\a.md', status: 'open', attempts: 1, by: 'main', created: now, updated: now },
    { id: 'T2', assignee: 'worker2', text: 'write C:\\Agent\\work\\b.md', status: 'open', attempts: 0, by: 'main', created: now, updated: now },
  ]);
  const b = brief(o, 'worker');
  assert.match(b, /YOUR TASK ===\nT1:/); assert.match(b, /worker2: idle on T2/); assert.match(b, /team_done/);
});
