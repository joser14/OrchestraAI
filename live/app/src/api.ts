// Team API: what agents call through the orchestra-team OpenClaw plugin (native tools instead of shell lines),
// and what a `team` CLI can call. Bound to 127.0.0.1 and protected by a random token stored next to the database.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Orchestrator } from './orchestrator.ts';
import { isPlaceholderTask, workPaths } from './rules.ts';
import { getSettings } from './settings.ts';
import { brief, commitHandled, recentDone, linkTask } from './brief.ts';
import { makeImage } from './imagegen.ts';
import { allModels } from './catalog.ts';
const isImageTag = (tag: string) => !!allModels().find((m) => m.tag === tag)?.roles.includes('image');
export { brief };

/** Word-overlap similarity (Jaccard on content words) to catch the same job assigned twice in other words. */
export function similar(a: string, b: string): number {
  const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'and', 'with', 'from', 'one', 'each', 'make', 'generate', 'create', 'write', 'list', 'file', 'markdown', 'pdf', 'saved', 'as', 'then', 'it', 'into', 'c', 'agent', 'work']);
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
  const A = words(a), B = words(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
const run = promisify(execFile);

export const API_PORT = 8790;

export function apiToken(dbFile: string): string {
  const f = join(dirname(dbFile), 'api-token');
  if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, randomBytes(24).toString('hex')); }
  return readFileSync(f, 'utf8').trim();
}


const workFile = (o: Orchestrator, f: string) => (isAbsolute(f) ? f : join(o.cfg.workDir, f));

export function startApi(o: Orchestrator, onPost: () => void) {
  const token = apiToken(o.cfg.dbFile);
  // After team_sleep the brain's pass is over: small models kept calling tools (one run looped 39 calls after
  // sleeping). Changing things is refused until the next pass; reading (brief, read) still works.
  const currentMainRun = () => o.store.get<Record<string, string>>('lastRun', {}).main || '';
  const guardSlept = (agent: string) => {
    if (agent === 'main' && currentMainRun() && o.store.get('mainSleptRun', '') === currentMainRun())
      throw new Error('Your pass is over (you called team_sleep). Do not call any more tools: reply with one short line and stop.');
  };
  const recentCalls = new Map<string, number>();
  const handlers: Record<string, (b: any, agent: string) => Promise<unknown> | unknown> = {
    brief: (_b, agent) => ({ text: brief(o, agent) }),
    post: (b, agent) => {
      const to = String(b.to || 'all').replace(/[^\w-]/g, '') || 'all', msg = String(b.message || '').trim();
      if (!msg) throw new Error('message is empty');
      o.store.addPost(agent, to, msg.replace(/^## /gm, '### '), { source: 'team_post' }); onPost();
      return { ok: true, note: 'posted' };
    },
    done: (b, agent) => {
      const id = String(b.task || '').toUpperCase(); if (!/^T\d+$/.test(id)) throw new Error('task must look like T3');
      o.store.addPost(agent, 'main', `DONE ${id}${b.note ? `\n${String(b.note).trim()}` : ''}`, { source: 'team_done' }); onPost();
      return { ok: true, note: `DONE ${id} posted; it closes when every file the task names exists` };
    },
    assign: (b, agent) => {
      if (agent !== 'main') throw new Error('only main assigns work');
      const w = String(b.worker || ''); const job = String(b.job || '').trim();
      if (!o.cfg.workers.includes(w)) throw new Error(`worker must be one of: ${o.cfg.workers.join(', ')}`);
      const on = getSettings(o.store).workers;
      if (!on.includes(w)) throw new Error(`${w} is turned off in Settings: use ${on.join(' or ')}.`);
      // The brain chooses the model; the harness checks it is a real one and fills in a sensible default if omitted.
      let model = String(b.model || '').toLowerCase().trim();
      if (model && !o.cfg.aliases[model]) throw new Error(`unknown model "${model}": choose one of ${Object.keys(o.cfg.aliases).sort().join(', ')} (smart = best thinking, fast = quick, vision = images)`);
      if (!model) model = /\b(analy|compar|research|explain|plan|strateg|report|review|write|essay|summar|code|script|design|evaluat|recommend)/i.test(String(b.job)) && o.cfg.aliases.smart ? 'smart' : o.cfg.aliases.fast ? 'fast' : '';
      if (isPlaceholderTask(job)) throw new Error('that looks like example text, not a real task: write the actual job from jr\'s request, with the file to write');
      // Guardrails for small models (seen: one request assigned six times, jobs without a file to check).
      if (!workPaths(job, o.cfg.workDir).length)
        throw new Error(`name the file the worker must write, e.g. "... saved as ${join(o.cfg.workDir, 'planets.md')}" (add "then make it a PDF with team_pdf" for a PDF). Then call team_assign again.`);
      const open = o.store.tasks().filter((t) => t.status === 'open' || (t.status as string) === 'review');   // in review = still in progress
      // Same wording is only a repeat when it also writes the same files (seen: "delete the .tmp files in junk3"
      // refused as a repeat of the finished junk2 job; the folder and the confirmation file were different).
      const mine = workPaths(job, o.cfg.workDir).map((p) => p.toLowerCase());
      const sameFiles = (t: { text: string }) => { const theirs = new Set(workPaths(t.text, o.cfg.workDir).map((p) => p.toLowerCase())); return mine.every((p) => theirs.has(p)); };
      const repeat = (t: { text: string }) => similar(t.text, job) >= 0.6 && sameFiles(t);
      const dup = open.find(repeat);
      if (dup) throw new Error(`already assigned as ${dup.id} to ${dup.assignee}: "${dup.text}". It is in progress: do nothing more about it this pass. Call team_sleep and stop.`);
      // Finished work is not redone (seen: after an archive the brain re-assigned a job finished hours before),
      // unless jr asked for it again after it was done.
      const did = recentDone(o).find(repeat);
      if (did) {
        const askedAgain = o.store.posts({ limit: 200 }).some((p) => p.from === 'jr' && Date.parse(p.ts.replace(' ', 'T')) > Date.parse(did.updated) && similar(p.body, job) >= 0.25);
        if (!askedAgain) throw new Error(`this was already done as ${did.id} (${did.assignee}, finished ${new Date(did.updated).toLocaleString()}): "${did.text}". Do not redo it. If jr wants it, tell jr where the file is (team_post). Otherwise do the next item or call team_sleep.`);
      }
      if (open.filter((t) => t.assignee === w).length >= 2) throw new Error(`${w} already has 2 open tasks: give it to another free worker (${o.cfg.workers.filter((x) => x !== w && getSettings(o.store).workers.includes(x)).join(', ') || 'none'}), or call team_sleep and stop.`);
      // Create the task right now (not on the next pass): two quick calls would otherwise both pass the
      // duplicate check (seen: the same job went to both workers). The post below is for the board's record;
      // the orchestrator dedupes it against this task.
      const tasks = o.store.tasks(); const now = new Date().toISOString();
      const id = 'T' + (1 + Math.max(0, ...tasks.map((t) => Number(t.id.replace(/\D/g, '')) || 0)));
      tasks.push({ id, assignee: w, text: job, status: 'open', attempts: 0, by: 'main', created: now, updated: now });
      o.store.saveTasks(tasks); o.log(`task ${id} for ${w}: ${job}`);
      linkTask(o, id, now);   // request ledger: which jr request this job serves
      const lines = [];
      if (model) lines.push(`MODEL ${w}=${model}`);
      if (b.tools) lines.push(`TOOLS ${w}=${String(b.tools).toLowerCase()}`);
      lines.push(`TASK ${w}: ${job}`);
      o.store.addPost('main', w, lines.join('\n'), { cmd: true, source: 'team_assign' }); onPost();
      return { ok: true, task: id, note: `${id} assigned to ${w}; it starts within seconds and ${w} will report back. Assign the other parts of the request if any (one call each), then tell jr your plan (team_post to jr), then team_sleep.` };
    },
    cancel: (b, agent) => {
      if (agent !== 'main') throw new Error('only main cancels tasks');
      o.store.addPost('main', 'all', `CANCEL ${String(b.task).toUpperCase()}`, { cmd: true, source: 'team_cancel' }); onPost();
      return { ok: true };
    },
    sleep: async (b, agent) => {
      if (agent !== 'main') throw new Error('only main sleeps');
      // Calls made in the same turn arrive together and sleep was checked before the post beside it landed: let them land.
      await new Promise((r) => setTimeout(r, 600));
      // Sleeping marks the agenda handled, so it is refused while jr's request has had no action this pass (seen: a
      // team_assign with wrong arguments failed in OpenClaw, team_sleep in the same turn succeeded, and the request
      // was silently dropped).
      const agenda = o.store.get<{ run: string; n: number }>('mainAgenda', { run: '', n: 0 });
      if (agenda.run === currentMainRun() && agenda.n > 0 && o.store.get('mainActedRun', '') !== currentMainRun())
        throw new Error(`not yet: your agenda has ${agenda.n} item(s) and you have not acted on any this pass. Do item 1 now: team_assign with worker (e.g. "worker") and job (naming the file to write), or team_post to jr to answer. Then team_sleep.`);
      // A refused team_assign must be dealt with first: retried, or explained to jr in a post made after seeing the
      // refusal (seen: assign refused, "assigned" posted to jr and sleep, all in the same turn - nothing ran).
      const fail = o.store.get<{ run: string; at: number; msg: string } | null>('mainAssignFail', null);
      const act = o.store.get<{ run: string; at: number } | null>('mainActAt', null);
      if (fail && fail.run === currentMainRun() && !(act && act.run === fail.run && act.at > fail.at + 1000))
        throw new Error(`not yet: your team_assign was refused (${fail.msg.slice(0, 200)}). Fix the job and call team_assign again, or tell jr in one line why it cannot be done (team_post). Then team_sleep.`);
      const m = Math.max(0, Math.min(60, Number(b.minutes) || 0));
      writeFileSync(join(o.cfg.logDir, 'main-sleep-until.txt'), new Date(Date.now() + m * 60000).toISOString());
      o.store.set('mainSleptRun', currentMainRun());   // further changes this pass are refused (see `guardSlept`)
      commitHandled(o);   // everything this pass's agenda showed is now handled
      return { ok: true, note: `Your pass is over (next one in about ${m} min, sooner if jr posts or a worker reports). Stop now: reply with one short line and do not call any more tools.` };
    },
    say: (b, agent) => {
      const to = String(b.to || 'all').replace(/[^\w-]/g, '') || 'all', msg = String(b.message || '').trim(); if (!msg) throw new Error('message is empty');
      o.store.say(agent, to, msg);
      o.store.addPost(agent, to, msg.replace(/^## /gm, '### '), { source: 'team_say' }); onPost();   // every conversation is on the board
      return { ok: true };
    },
    read: async (b, agent) => {
      // main never waits: its runs are short passes, and a reply wakes it anyway (seen: a 120 s read held main for
      // 6 min while jr's next post sat unanswered). The cap stays under the plugin's 60 s call timeout.
      if (agent === 'main') { const m = o.store.readTalk(agent); return m.length ? { messages: m } : { messages: [], note: 'No messages. Do not wait for replies: finish your agenda, then team_sleep. Replies wake you.' }; }
      const until = Date.now() + Math.min(45, Math.max(0, Number(b.wait) || 0)) * 1000;
      for (;;) { const m = o.store.readTalk(agent); if (m.length || Date.now() >= until) return { messages: m }; await new Promise((r) => setTimeout(r, 2000)); }
    },
    pdf: async (b) => {
      const src = workFile(o, String(b.file || ''));
      if (/\.pdf$/i.test(src)) throw new Error('give the Markdown source (e.g. planets.md), not the PDF: team_pdf turns the .md into the .pdf next to it');
      if (!existsSync(src)) throw new Error(`not found: ${src}. Write the Markdown file first (write tool), then call team_pdf with its name. If a worker is making it, wait for that task instead.`);
      const { stdout } = await run(process.execPath, [join(import.meta.dirname, '..', 'lib', 'md2pdf.cjs'), src, ...(b.title ? ['--title', String(b.title)] : [])], { timeout: 120000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });   // inside the desktop app execPath is electron.exe: run it as plain Node
      return { ok: true, note: stdout.trim() };
    },
    // pictures from a prompt (imagegen.ts); a slow one keeps drawing and lands at the same path
    image: async (b) => {
      const r = await makeImage({ store: o.store, workDir: o.cfg.workDir, log: (m) => o.log(m), isImage: isImageTag },
        String(b.prompt || ''), b.file ? String(b.file) : undefined, { width: Number(b.width) || undefined, height: Number(b.height) || undefined });
      return r.done ? { ok: true, text: `Saved the picture as ${r.file}` }
        : { ok: true, text: `Still drawing: it will be saved as ${r.file} in a minute or two. Do not call team_image again for it; do your other steps, then team_done once the file exists.` };
    },
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers['x-orchestra-token'] !== token) return send(401, { error: 'bad token' });
      const m = /^\/team\/([a-z]+)$/.exec(req.url || ''); const h = m && handlers[m[1]];
      if (req.method !== 'POST' || !h) return send(404, { error: 'unknown command' });
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) throw new Error('too large'); }
      const body = raw ? JSON.parse(raw) : {};
      const agent = String(body.agent || '');
      if (!o.cfg.agents.includes(agent)) return send(400, { error: `agent must be one of: ${o.cfg.agents.join(', ')}` });
      try {
        if (['post', 'assign', 'cancel', 'say', 'pdf', 'image', 'sleep'].includes(m![1])) guardSlept(agent);
        // Loop detector: the exact same call twice in one run is refused (small models loop on refused or
        // already-answered calls). Keyed by agent + current run + command + arguments.
        const runId = o.store.get<Record<string, string>>('lastRun', {})[agent] || '';
        // Only a call that SUCCEEDED counts as "already made": a refused call may be retried once its cause is fixed
        // (seen: sleep refused until a bad assign was redone, then the retried sleep was blocked as a repeat). Loops
        // of refused calls are still stopped by the 3-strikes rule below.
        let doneKey = '';
        if (m![1] !== 'read') {
          const { agent: _a, ...args } = body; const key = `${agent}|${runId}|${m![1]}|${JSON.stringify(args)}`;
          const seen = recentCalls.get(key) ?? 0; doneKey = key;
          if (recentCalls.size > 2000) recentCalls.clear();
          if (m![1] === 'brief') recentCalls.set(key, seen + 1);   // a repeated brief is answered with a nudge below
          // A repeated brief is answered, not refused: an error makes small models retry it (seen: 20 retries in one
          // run). The answer is a one-line nudge to act on what they already have.
          if (m![1] === 'brief' && seen >= 1) return send(200, { text: agent === 'main'
            ? 'You already have this pass\'s agenda (your first team_brief result above). Do not call team_brief again. Act on item 1 of NEEDS YOU now with a tool call (team_assign for a new request, team_post to answer), then the next item, then team_sleep.'
            : 'You already have your brief (your first team_brief result above). Do not call team_brief again. Work on YOUR TASK now, then team_done.' });
          if (seen >= 1) throw new Error(`you already made exactly this ${m![1]} call in this run. Repeating it changes nothing: do the next thing on your list, or finish with one short line.`);
        }
        const out = await h(body, agent);
        if (doneKey && m![1] !== 'brief') recentCalls.set(doneKey, (recentCalls.get(doneKey) ?? 0) + 1);
        if (agent === 'main' && ['post', 'assign', 'cancel', 'say'].includes(m![1])) {
          o.store.set('mainActedRun', currentMainRun());
          o.store.set('mainActAt', { run: currentMainRun(), at: Date.now() });
          if (m![1] === 'assign') o.store.set('mainAssignFail', null);
          // jr's posts count as answered only up to what main had seen when it acted (its brief), not every post
          // older than main's reply (seen: a report on the last job "answered" jr's follow-up sent seconds before it).
          const seen = o.store.get<{ post: number } | null>('mainBriefSeen', null)?.post ?? 0;
          if (seen > o.store.get<number>('mainAnsweredUpTo', 0)) o.store.set('mainAnsweredUpTo', seen);
        }
        return send(200, out);
      }
      catch (e: any) {
        // Strikes: 3 refused calls in one main pass end the pass (seen: 59 retries of one refused team_assign).
        let msg = String(e?.message || e);
        // (a refusal because the job is already in progress or done needs no follow-up: it does not block team_sleep)
        if (agent === 'main' && m![1] === 'assign' && !/^(already assigned|this was already done|you already made)/.test(msg)) o.store.set('mainAssignFail', { run: currentMainRun(), at: Date.now(), msg });
        if (agent === 'main' && currentMainRun() && !['brief', 'read'].includes(m![1])) {
          const k = o.store.get<{ run: string; n: number }>('mainStrikes', { run: '', n: 0 });
          const n = k.run === currentMainRun() ? k.n + 1 : 1;
          o.store.set('mainStrikes', { run: currentMainRun(), n });
          if (n >= 3 && o.store.get('mainSleptRun', '') !== currentMainRun()) {
            o.store.set('mainSleptRun', currentMainRun()); o.log(`main: pass ended after ${n} refused calls (last: ${msg.slice(0, 120)})`);
            // the agenda stays unhandled (no commitHandled): try again in a minute instead of after the full rest
            writeFileSync(join(o.cfg.logDir, 'main-sleep-until.txt'), new Date(Date.now() + 60000).toISOString());
            msg += ' -- That was the 3rd refused call this pass, so your pass is over: reply with one short line and stop.';
          }
        }
        return send(400, { error: msg });
      }
    } catch (e: any) { send(400, { error: String(e?.message || e) }); }
  });
  server.listen(API_PORT, '127.0.0.1');
  return server;
}
