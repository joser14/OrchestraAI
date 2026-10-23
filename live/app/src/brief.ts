// The briefs agents read at the start of every run (team_brief). Small models do what the text in front of them
// says, so the brief is not a dump of posts: for main it is an AGENDA - a numbered list of exactly what needs a
// decision now, each with the action expected - followed by what is in flight and what is already finished (so
// it is not redone). For a worker it is its task, what teammates are doing, and how to report.
//
// "Handled" is a watermark, not "since main's last post": brief() records the newest post main has seen; the
// watermark only moves when main ends its pass cleanly (team_sleep). An archive, a restart or a crashed run can
// therefore never resurrect old requests, and a request is never lost because a run died half way.
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Orchestrator } from './orchestrator.ts';
import type { Post, Task } from './rules.ts';
import { workPaths, expectedFiles } from './rules.ts';
import { getSettings } from './settings.ts';
import { agendaHint, folderSnapshot, verifyFiles, type Interpretation } from './interpret.ts';
import { teamMemory } from './memory.ts';

export interface Watermark { post: number; at: string }
const NONE: Watermark = { post: 0, at: '1970-01-01T00:00:00.000Z' };

/** Posts main has handled up to (moves on team_sleep). First use: everything up to main's last own post. */
export function handled(o: Orchestrator, posts: Post[]): Watermark {
  const w = o.store.get<Watermark | null>('mainHandled', null); if (w) return w;
  const idx = posts.map((p) => p.from).lastIndexOf('main');
  return idx >= 0 ? { post: posts[idx].id, at: new Date().toISOString() } : NONE;
}
/** Called by team_sleep: everything main saw in this pass's brief is now handled. */
export function commitHandled(o: Orchestrator) {
  const seen = o.store.get<Watermark | null>('mainBriefSeen', null); if (seen) o.store.set('mainHandled', seen);
}

/** Finished tasks of the last `days` (live table + archive), newest first. */
export function recentDone(o: Orchestrator, days = 7): Task[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const live = o.store.tasks().filter((t) => t.status === 'done' && t.updated >= since);
  const arch = (o.store.db.prepare(`SELECT id, assignee, text, status, attempts, by_who AS "by", created, updated FROM task_archive WHERE status = 'done' AND updated >= ?`).all(since) as any[]) as Task[];
  const seen = new Set<string>(); const out: Task[] = [];
  for (const t of [...live, ...arch].sort((a, b) => b.updated.localeCompare(a.updated))) { const k = t.text; if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}

// ---- request ledger (after Magentic-One's task/progress ledgers): every job main assigns is linked to the jr
// request it serves, so the agenda can show each request's progress and spot one that has stalled.
export interface ReqLink { post: number; task: string; created: string }
export function linkTask(o: Orchestrator, task: string, created: string) {
  const seen = o.store.get<Watermark | null>('mainBriefSeen', null)?.post ?? o.store.lastPostId();
  const req = o.store.posts({ limit: 300 }).filter((p) => p.from === 'jr' && p.id <= seen).pop();
  if (!req) return;
  o.store.set('reqLinks', [...o.store.get<ReqLink[]>('reqLinks', []), { post: req.id, task, created }].slice(-300));
}
interface ReqView { post: Post; tasks: Task[]; state: 'working' | 'complete' | 'reported' | 'stalled' }
export function requestLedger(o: Orchestrator, posts: Post[], hours = 48): ReqView[] {
  const links = o.store.get<ReqLink[]>('reqLinks', []); if (!links.length) return [];
  const all = [...o.store.tasks(), ...((o.store.db.prepare(`SELECT id, assignee, text, status, attempts, by_who AS "by", created, updated FROM task_archive WHERE created >= ?`).all(new Date(Date.now() - hours * 3600000).toISOString()) as any[]) as Task[])];
  const out: ReqView[] = [];
  for (const p of posts.filter((p) => p.from === 'jr' && Date.now() - Date.parse(p.ts.replace(' ', 'T')) < hours * 3600000)) {
    const tasks = links.filter((l) => l.post === p.id).map((l) => all.find((t) => t.id === l.task && t.created === l.created)).filter(Boolean) as Task[];
    if (!tasks.length) continue;
    const open = tasks.filter((t) => t.status === 'open' || t.status === 'stuck');
    const lastDone = tasks.map((t) => t.updated).sort().pop() || '';
    const reported = posts.some((q) => q.from === 'main' && q.to === 'jr' && Date.parse(q.ts.replace(' ', 'T')) >= Date.parse(lastDone) - 60000);
    const quietMin = (Date.now() - Math.max(...tasks.map((t) => Date.parse(t.updated)))) / 60000;
    const state = open.length ? (!open.some((t) => o.running(t.assignee)) && quietMin > 30 ? 'stalled' : 'working') : reported ? 'reported' : 'complete';
    out.push({ post: p, tasks, state });
  }
  return out;
}

const clock = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const one = (s: string, n = 300) => { s = s.replace(/_\(relayed:[^)]*\)_/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const filesOf = (o: Orchestrator, t: Task) => expectedFiles(t.text, o.cfg.workDir).map((p) => basename(p) + (existsSync(p) ? '' : ' (missing)'));
/** The start of a task's text deliverable, put straight into the agenda: the brain judges the work from its brief
 *  (seen: a small model reached for the memory tool instead of read and could not open the file). */
function preview(o: Orchestrator, t: Task, n = 1500): string {
  const f = expectedFiles(t.text, o.cfg.workDir).find((p) => /\.(md|txt|csv|html?|json)$/i.test(p) && existsSync(p)); if (!f) return '';
  try {
    const s = readFileSync(f, 'utf8').trim();
    return `\n   content of ${basename(f)} (${s.length} characters):\n` + s.slice(0, n).split('\n').map((l) => '   | ' + l).join('\n') + (s.length > n ? '\n   | …' : '');
  } catch { return ''; }
}
/** Orchestra's own check of a finished job against the folders as they are now (interpret.ts verifyFiles), plus
 *  the current listing, so the brain judges the real state instead of the worker's claim. */
function checked(o: Orchestrator, t: Task): string {
  const v = verifyFiles(t.text, o.cfg.workDir);
  const snap = folderSnapshot([t.text], o.cfg.workDir);
  let s = snap ? `\n   folders right now: ${snap.replace(/\n/g, '; ')}` : '';
  if (v.problems.length) s += `\n   CHECK FAILED - the job is NOT done: ${v.problems.join('; ')}.\n   -> Do not tell jr it is done. team_assign a fix that names exactly what is left (the worker must use PowerShell, e.g. Remove-Item 'folder\\*.tmp', and list the folder after).`;
  else if (v.checked) s += '\n   Orchestra checked the files: the folder matches the job.';
  return s;
}
const pdfOf = (o: Orchestrator, t: Task) => expectedFiles(t.text, o.cfg.workDir).find((p) => /\.pdf$/i.test(p) && existsSync(p));
const isQuestion = (b: string) => /\?\s*$|\?\s*\n|\b(blocked|cannot|can't|could not|couldn't|unable|failed|need (help|you|input)|which one)\b/i.test(b);

/** Is this worker post something main must act on (a result, a question, a problem) - not just a progress note? */
export const needsMain = (p: Post) => /^\s*DONE\s+T\d+/i.test(p.body) || isQuestion(p.body);

export function brief(o: Orchestrator, who: string): string {
  return who === 'main' ? mainAgenda(o) : workerBrief(o, who);
}

function mainAgenda(o: Orchestrator): string {
  const tasks = o.store.tasks(), posts = o.store.posts({ limit: 400 });
  const w = handled(o, posts);
  // A previous pass saw newer posts than the watermark but never finished (no team_sleep): it stalled or only
  // described a plan in text. Say so plainly - small models repeat that failure unless told.
  const prevSeen = o.store.get<Watermark | null>('mainBriefSeen', null);
  const unfinished = !!prevSeen && prevSeen.post > w.post;
  o.store.set('mainBriefSeen', { post: o.store.lastPostId(), at: new Date().toISOString() } satisfies Watermark);
  const S = getSettings(o.store);
  const L: string[] = [];
  // ---- status ----
  const st = (() => { try { return JSON.parse(readFileSync(join(o.cfg.logDir, 'status.json'), 'utf8')); } catch { return null; } })();
  L.push(`=== TEAM NOW (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}) ===`);
  if (st?.gpu) L.push(`GPU ${st.gpu.util}% busy, ${(st.gpu.used / 1024).toFixed(1)}/${(st.gpu.total / 1024).toFixed(0)} GB, ${st.gpu.temp} C${st.gpu.temp >= o.cfg.maxTempC ? '  <- HOT: no new jobs now' : ''}`);
  const on = S.workers.filter((x) => o.cfg.workers.includes(x));
  for (const x of o.cfg.workers) {
    const open = tasks.filter((t) => t.assignee === x && t.status === 'open');
    const state = !on.includes(x) ? 'OFF (do not assign)' : o.running(x) ? `WORKING ${Math.round(o.runMins(x))} min on ${open[0]?.id ?? 'a task'}` : open.length ? `queued: ${open.map((t) => t.id).join(', ')}` : 'free';
    L.push(`${x}: ${state} · model ${(o.jobs[x]?.payload?.model || 'default').replace(/^ollama\/|:latest$/g, '')}`);
  }
  L.push(`Up to ${S.parallel} worker(s) run at once. Models you can give a job: ${Object.keys(o.cfg.aliases).sort().join(', ')}`);
  const tm = teamMemory(o.cfg);   // jr's standing notes (Memory page): always in front of the brain
  if (tm) L.push('', "=== TEAM MEMORY (jr's standing notes - follow them) ===", tm);

  // ---- agenda ----
  const items: string[] = [];
  const after = posts.filter((p) => p.id > w.post);
  // read before mainBriefSeen moves below; chat replies (main-chat) answer whatever came before them
  const answeredUpTo = o.store.get<number>('mainAnsweredUpTo', 0);
  const answeredAfter = (id: number) => id <= answeredUpTo || posts.some((p) => p.id > id && p.from === 'main-chat' && p.to === 'jr');
  // jr's follow-ups ("you didn't do it", "clean it up what are you doing") only make sense with the conversation
  // before them (seen: the brain assigned "understand the request 'you didnt do it'" as a job).
  const convo = (id: number) => {
    const t0 = Date.parse(posts.find((p) => p.id === id)!.ts.replace(' ', 'T'));
    const prev = posts.filter((p) => p.id < id && (p.from === 'jr' || (p.from === 'main' && p.to === 'jr') || o.cfg.workers.includes(p.from) && /^\s*DONE\s+T\d+/i.test(p.body))
      && t0 - Date.parse(p.ts.replace(' ', 'T')) < 30 * 60000).slice(-6);
    return prev.length ? `\n   Conversation just before it (read it: this may be a follow-up to it, not a new topic):\n${prev.map((p) => `   | ${p.from}: ${one(p.body, 220)}`).join('\n')}` : '';
  };
  const jrNew = after.filter((p) => p.from === 'jr' && !answeredAfter(p.id));
  // The interpret step's reading of jr's newest message (interpret.ts), shown first in NEEDS YOU and in its item.
  const meant = o.store.get<Record<string, Interpretation>>('interpretations', {});
  const newest = jrNew[jrNew.length - 1];
  const hint = newest && meant[newest.id] ? agendaHint(meant[newest.id], tasks.find((t) => t.id === meant[newest.id].refersTo)) : '';
  for (const p of after) {
    if (p.from === 'jr' && !answeredAfter(p.id) && p !== jrNew[jrNew.length - 1]) continue;   // several posts in a row: one item, the newest, with the rest as its conversation
    if (p.from === 'jr' && !answeredAfter(p.id))
      items.push(`NEW REQUEST from jr (${p.ts}): "${one(p.body, 600)}"${convo(p.id)}${hint ? `\n   ${hint}` : ''}\n   -> Work out what jr wants from the conversation. If earlier work failed, say why in one line and assign a fix. Main cannot touch files itself: deleting, moving or cleaning files is a job for a worker (shell tool).\n   -> Split it into jobs: one team_assign per job, each naming the file to write, on free workers. Thinking-heavy job (analysis, writing, comparing, planning): one worker with model smart. Routine: model fast.\n   -> Then tell jr your plan in two or three lines (team_post to jr).`);
    else if (o.cfg.workers.includes(p.from) && /^\s*DONE\s+(T\d+)/i.test(p.body)) {
      const id = /DONE\s+(T\d+)/i.exec(p.body)![1].toUpperCase(); const t = tasks.find((x) => x.id === id);
      const files = t ? filesOf(o, t) : [];
      const pdf = t && pdfOf(o, t);
      items.push(`RESULT from ${p.from} for ${id} (${p.ts}): "${one(p.body.replace(/^\s*DONE\s+T\d+\s*/i, ''), 300)}"${files.length ? `\n   files: ${files.join(', ')}` : ''}${t ? preview(o, t) + checked(o, t) : ''}\n   -> Judge it against jr's request and the folders as they are now, not the worker's claim. Good: tell jr the result in two lines${pdf ? ` and give the PDF path ${pdf}` : ''} (team_post to jr). Wrong or incomplete: team_assign a fix that says exactly what to change.`);
    } else if (o.cfg.workers.includes(p.from) && isQuestion(p.body))
      items.push(`QUESTION from ${p.from} (${p.ts}): "${one(p.body, 400)}"\n   -> Decide and answer ${p.from} with team_post (to: ${p.from}).`);
    else if (p.from === 'system' && /failed \d+ times|stuck|was stopped/i.test(p.body))
      items.push(`PROBLEM (${p.ts}): ${one(p.body, 300)}\n   -> Give a smaller job or another model with team_assign, or team_cancel it.`);
    else if (p.from === 'system' && /^Automation:/i.test(p.body))
      items.push(`SCHEDULED JOB (${p.ts}): ${one(p.body.replace(/^Automation:\s*/i, ''), 300)}\n   -> Do it like a request from jr.`);
  }
  // finished without a DONE post (closed because its files appeared) and not reported to jr yet
  for (const t of tasks.filter((t) => t.status === 'done' && t.updated > w.at)) {
    if (items.some((i) => i.includes(` for ${t.id} `))) continue;
    if (posts.some((p) => p.from === 'main' && p.to === 'jr' && p.body.includes(t.id) && Date.parse(p.ts.replace(' ', 'T')) >= Date.parse(t.updated) - 60000)) continue;
    const pdf = pdfOf(o, t);
    items.push(`FINISHED ${t.id} by ${t.assignee}: ${one(t.text, 200)}${filesOf(o, t).length ? `\n   files: ${filesOf(o, t).join(', ')}` : ''}${preview(o, t)}${checked(o, t)}\n   -> Judge it against jr's request and the folders as they are now. Good: tell jr the result in two lines${pdf ? ` and give the PDF path ${pdf}` : ''} (team_post to jr). Wrong: team_assign a fix.`);
  }
  const ledger = requestLedger(o, posts);
  for (const r of ledger.filter((r) => r.state === 'stalled'))
    items.push(`STALLED request from jr (${r.post.ts}): "${one(r.post.body, 160)}" - no progress for 30+ minutes on ${r.tasks.filter((t) => t.status !== 'done').map((t) => `${t.id} (${t.status})`).join(', ')}\n   -> Re-plan: smaller jobs, another worker or model, or tell jr what is blocking.`);
  for (const t of tasks.filter((t) => t.status === 'stuck' && !items.some((i) => i.includes(t.id))))
    items.push(`STUCK ${t.id} (${t.assignee}, ${t.attempts} tries): ${one(t.text, 200)}\n   -> Assign a smaller version (another model?) or team_cancel ${t.id}.`);

  o.store.set('mainAgenda', { run: o.store.get<Record<string, string>>('lastRun', {}).main || '', n: items.length });   // team_sleep checks it
  L.push('', '=== NEEDS YOU (do these in order) ===');
  if (hint) L.push(hint.split('\n')[0]);
  if (unfinished && items.length) L.push('NOTE: your last pass ended without acting on this list. Do not describe a plan in text: call team_assign / team_post now.');
  if (items.length) items.forEach((it, i) => L.push(`${i + 1}. ${it}`));
  else {
    const busy = o.cfg.workers.some((x) => o.running(x)) || tasks.some((t) => t.status === 'open');
    L.push(`Nothing needs you right now.${busy ? ' Workers are busy: call team_sleep with minutes 2, then stop.' : ' Call team_sleep with minutes 20, then stop.'}`);
  }
  L.push('Finish every pass with team_sleep (it marks all of the above as handled).');

  // ---- context ----
  const live = ledger.filter((r) => r.state !== 'reported');
  if (live.length) L.push('', "=== JR'S REQUESTS (progress) ===", ...live.map((r) => `  ${r.post.ts} "${one(r.post.body, 120)}": ${r.tasks.map((t) => `${t.id} ${t.status}`).join(', ')} -> ${r.state === 'complete' ? 'ALL DONE: report it to jr' : r.state}`));
  const inflight = tasks.filter((t) => t.status === 'open');
  L.push('', '=== IN PROGRESS (already assigned: never assign these again) ===', ...(inflight.length ? inflight.map((t) => `  ${t.id} ${t.assignee}${o.running(t.assignee) ? ' (working now)' : ''}: ${one(t.text, 220)}`) : ['  none']));
  const done = recentDone(o).slice(0, 6);
  L.push('', '=== FINISHED LATELY (do not redo; if jr asks again, point to the file) ===', ...(done.length ? done.map((t) => `  ${t.id} ${clock(t.updated)} ${t.assignee}: ${one(t.text, 160)}${filesOf(o, t).length ? ` -> ${filesOf(o, t).join(', ')}` : ''}`) : ['  none']));
  const fyi = after.filter((p) => o.cfg.workers.includes(p.from) && !needsMain(p)).slice(-4);
  if (fyi.length) L.push('', '=== TEAM CHATTER (for your information) ===', ...fyi.map((p) => `  ${p.from} -> ${p.to} ${p.ts}: ${one(p.body, 200)}`));
  const before = posts.filter((p) => p.id <= w.post && p.from === 'jr').slice(-2);
  if (before.length) L.push('', '=== EARLIER REQUESTS (already handled) ===', ...before.map((p) => `  jr ${p.ts}: ${one(p.body, 160)}`));
  return L.join('\n');
}

function workerBrief(o: Orchestrator, who: string): string {
  const tasks = o.store.tasks(), posts = o.store.posts({ limit: 300 });
  const L: string[] = [];
  const mine = tasks.filter((t) => t.assignee === who && t.status === 'open').sort((a, b) => a.created.localeCompare(b.created));
  L.push('=== YOUR TASK ===');
  if (mine.length) {
    const t = mine[0];
    L.push(`${t.id}: ${t.text}`, `(try ${Math.max(1, t.attempts)} of ${o.cfg.maxAttempts}${mine.length > 1 ? `; after it: ${mine.slice(1).map((x) => x.id).join(', ')}` : ''})`);
    const files = expectedFiles(t.text, o.cfg.workDir); if (files.length) L.push(`It is finished when these exist: ${files.join(', ')}`);
  } else L.push('No open task for you. Unless a message below asks you something, stop now.');
  L.push('', '=== TEAM ===');
  for (const x of o.cfg.workers.filter((x) => x !== who)) {
    const t = tasks.find((k) => k.assignee === x && k.status === 'open');
    L.push(`${x}: ${o.running(x) ? 'working' : 'idle'}${t ? ` on ${t.id}: ${one(t.text, 140)}` : ''}`);
  }
  const done = recentDone(o, 2).slice(0, 5);
  if (done.length) L.push('Files the team made recently (reuse them, do not redo): ' + done.flatMap((t) => filesOf(o, t)).filter((f) => !/missing/.test(f)).slice(0, 8).join(', '));
  const lastOwn = posts.map((p) => p.from).lastIndexOf(who);
  const msgs = posts.slice(lastOwn + 1).filter((p) => p.from !== who && (p.to === who || p.to === 'all') && !p.cmd).slice(-5);
  L.push('', '=== MESSAGES FOR YOU ===', ...(msgs.length ? msgs.map((p) => `--- ${p.from} at ${p.ts}\n${one(p.body, 800)}`) : ['none']));
  const tm = teamMemory(o.cfg);
  if (tm) L.push('', "=== TEAM MEMORY (jr's standing notes - follow them) ===", tm);
  L.push('', '=== HOW TO WORK ===',
    '1. team_post to main: "Starting <id>: <your plan in one line>".',
    '2. Do the work for real. Need a teammate? team_say to them, then team_read with wait 60.',
    '3. Stuck or unsure? team_post to main with your question, then stop.',
    '4. Done: team_done with the task id and a note naming every file you made.');
  return L.join('\n');
}
