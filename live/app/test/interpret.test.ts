// Interpret step (interpret.ts): routing, the prompt it builds, validation of the model's JSON, and the agenda text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsInterpret, conversationBefore, buildPrompt, parseInterpretation, agendaHint, folderSnapshot, verifyFiles, dependsOnContext } from '../src/interpret.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('folder snapshot lists only the work sub-folders the conversation names, as they are now', () => {
  const w = mkdtempSync(join(tmpdir(), 'orch-'));
  mkdirSync(join(w, 'junk5')); writeFileSync(join(w, 'junk5', 'b.tmp'), 'x'); writeFileSync(join(w, 'junk5', 'keep.txt'), 'x');
  mkdirSync(join(w, 'junk50')); mkdirSync(join(w, 'other'));
  const s = folderSnapshot(['delete a.tmp from the junk5 folder', 'the other tmp file too'], w);
  assert.match(s, /junk5 now contains: b\.tmp, keep\.txt/);
  assert.doesNotMatch(s, /junk50/);
  assert.match(s, /other now contains: \(empty\)/);   // "the other ..." names the folder "other": listed, harmless
});
import type { Post, Task } from '../src/rules.ts';

const P = (id: number, from: string, to: string, body: string, ts = '2026-10-14 17:30', cmd = false): Post => ({ id, from, to, body, ts, cmd });
const T4: Task = { id: 'T4', assignee: 'worker', text: 'Delete the .tmp files in junk4, keep keep.txt, confirm in E:\\w\\delete-junk4-confirm.md', status: 'done', attempts: 1, by: 'main', created: '', updated: '' };
const W = ['worker', 'worker2'];

test('verifyFiles catches a "deleted" claim that is not true, and a deleted file that should have been kept', () => {
  const w = mkdtempSync(join(tmpdir(), 'orch-'));
  mkdirSync(join(w, 'junk4')); writeFileSync(join(w, 'junk4', 'a.tmp'), 'x'); writeFileSync(join(w, 'junk4', 'keep.txt'), 'x');
  const bad = verifyFiles(`Delete the .tmp files in the 'junk4' folder but keep keep.txt, confirm in ${join(w, 'c.md')}`, w);
  assert.equal(bad.problems.length, 1); assert.match(bad.problems[0], /a\.tmp still in .*junk4/);
  const named = verifyFiles('Delete a.tmp from the junk4 folder', w);
  assert.match(named.problems[0], /a\.tmp still exists/);
  mkdirSync(join(w, 'junk9')); writeFileSync(join(w, 'junk9', 'b.tmp'), 'x');
  const gone = verifyFiles('Delete b.tmp from junk9 but keep keep.txt', w);
  assert.ok(gone.problems.some((p) => /keep\.txt is gone/.test(p)));
  const ok = verifyFiles('Write a poem to poem.md', w);
  assert.deepEqual(ok, { problems: [], checked: 0 });
});

test('verifyFiles checks moves, renames, new folders and real PDFs', () => {
  const w = mkdtempSync(join(tmpdir(), 'orch-'));
  writeFileSync(join(w, 'a.txt'), 'x'); mkdirSync(join(w, 'archive'));
  assert.equal(verifyFiles('Move a.txt to archive', w).problems.length, 2);   // still there, and not in archive
  writeFileSync(join(w, 'archive', 'a.txt'), 'x'); rmSync(join(w, 'a.txt'));
  assert.deepEqual(verifyFiles('Move a.txt to archive', w).problems, []);
  writeFileSync(join(w, 'old.md'), 'x');
  assert.match(verifyFiles('Rename old.md to new.md', w).problems.join(), /old\.md is still where it was.*new\.md does not exist/);
  assert.match(verifyFiles('Create a folder called reports', w).problems[0], /reports was not created/);
  mkdirSync(join(w, 'reports')); assert.deepEqual(verifyFiles('Create a folder called reports', w).problems, []);
  writeFileSync(join(w, 'r.pdf'), 'not a pdf');
  assert.match(verifyFiles(`Write the report to ${join(w, 'r.md')} then make it a PDF with team_pdf`, w).problems[0], /r\.pdf is not a valid PDF/);
  writeFileSync(join(w, 'r.pdf'), '%PDF-1.7\n' + 'x'.repeat(2000));
  assert.deepEqual(verifyFiles(`Write the report to ${join(w, 'r.md')} then make it a PDF with team_pdf`, w).problems, []);
});

test('a standalone first message is not rewritten (no extra call)', () => {
  const posts = [P(1, 'jr', 'main', 'make me a PDF about octopuses')];
  assert.equal(needsInterpret(posts, posts[0], W), false);
});

test('a follow-up within 30 min is rewritten, with jr, main and DONE posts as context but not commands', () => {
  const posts = [
    P(1, 'jr', 'main', 'delete the .tmp files in junk4, keep keep.txt', '2026-10-14 17:20'),
    P(2, 'main', 'worker', 'TASK worker: ...', '2026-10-14 17:20', true),
    P(3, 'worker', 'main', 'Starting T4', '2026-10-14 17:21'),
    P(4, 'worker', 'main', 'DONE T4\ndeleted the .tmp files', '2026-10-14 17:22'),
    P(5, 'main', 'jr', 'Done: the .tmp files are deleted.', '2026-10-14 17:23'),
    P(6, 'jr', 'main', 'you missed one', '2026-10-14 17:25'),
  ];
  assert.equal(needsInterpret(posts, posts[5], W), true);
  assert.deepEqual(conversationBefore(posts, posts[5], W).map((p) => p.id), [1, 4, 5]);
});

test('only messages that lean on the conversation are rewritten', () => {
  for (const m of ['you missed one', 'the other one is still there', 'clean it up what are you doing', 'you didnt do it', 'do the same for junk4', 'why did that fail'])
    assert.equal(dependsOnContext(m), true, m);
  for (const m of ['Write a two-line haiku about GPUs to gpu-haiku2.md in the work folder.', 'Research the best budget 4K monitors under $400 and give me a PDF comparison table.',
    'Write three one-line tips for a tidy desk to desk-tips.md in the work folder.', 'Research the five best note-taking apps for students in 2026 and make it a one-page PDF with a comparison table.'])
    assert.equal(dependsOnContext(m), false, m);
});

test('a clear request after a conversation goes straight to the brain', () => {
  const posts = [P(1, 'jr', 'main', 'delete junk4', '2026-10-14 17:20'), P(2, 'jr', 'main', 'Write a two-line haiku about GPUs to gpu-haiku2.md in the work folder.', '2026-10-14 17:25')];
  assert.equal(needsInterpret(posts, posts[1], W), false);
});

test('conversation older than 30 min does not count', () => {
  const posts = [P(1, 'jr', 'main', 'delete junk4', '2026-10-14 16:00'), P(2, 'jr', 'main', 'you missed one', '2026-10-14 17:00')];
  assert.equal(needsInterpret(posts, posts[1], W), false);
});

test('the prompt carries tasks, the conversation and the latest message verbatim', () => {
  const posts = [P(1, 'jr', 'main', 'delete the .tmp files in junk4'), P(2, 'jr', 'main', 'a.tmp is still there')];
  const s = buildPrompt(posts[1], [posts[0]], [T4], 'E:\\w');
  assert.match(s, /T4 \[done\] for worker/);
  assert.match(s, /jr: delete the \.tmp files in junk4/);
  assert.match(s, /jr's LATEST message: a\.tmp is still there/);
});

test('valid JSON is accepted; unknown task ids and enum values are cleaned up', () => {
  const i = parseInterpretation(JSON.stringify({ kind: 'correction', means: 'Delete a.tmp from junk4; keep keep.txt.', refers_to: 't4', confidence: 'high', ask: '' }), [T4]);
  assert.deepEqual({ kind: i!.kind, ref: i!.refersTo, conf: i!.confidence }, { kind: 'correction', ref: 'T4', conf: 'high' });
  const j = parseInterpretation(JSON.stringify({ kind: 'weird', means: 'Do X', refers_to: 'T99', confidence: 'sure', ask: '' }), [T4]);
  assert.deepEqual({ kind: j!.kind, ref: j!.refersTo, conf: j!.confidence }, { kind: 'new_request', ref: '', conf: 'medium' });
});

test('broken or empty output is rejected (the agenda stays as it was)', () => {
  assert.equal(parseInterpretation('not json', [T4]), null);
  assert.equal(parseInterpretation(JSON.stringify({ kind: 'new_request', means: '' }), [T4]), null);
  assert.ok(parseInterpretation('```json\n{"kind":"question","means":"What is the team doing?","refers_to":"","confidence":"high","ask":""}\n```', [T4]));
});

test('agenda: a correction names the task and forbids a check-only job; low confidence suggests asking jr', () => {
  const fix = agendaHint({ kind: 'correction', means: 'Delete a.tmp from junk4.', refersTo: 'T4', confidence: 'high', ask: '' }, T4);
  assert.match(fix, /^jr most likely means: "Delete a\.tmp from junk4\."/);
  assert.match(fix, /This is about T4/);
  assert.match(fix, /Do not assign a job that only checks/);
  const unsure = agendaHint({ kind: 'unclear', means: 'jr wants something cleaned', refersTo: '', confidence: 'low', ask: 'Which folder should be cleaned?' });
  assert.match(unsure, /Ask jr instead of guessing: "Which folder should be cleaned\?"/);
});
