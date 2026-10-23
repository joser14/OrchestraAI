// The team's pass loop, inside one long-lived process: a few 20-60 ms gateway calls per pass, no CLI processes.
import { existsSync, readFileSync, statSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { Gateway } from './gateway.ts';
import { Compat, atomicWrite } from './compat.ts';
import { ingestOutbox } from './outbox.ts';
import { applyPosts, autoDone, shouldRenumber, parseCommands, minuteOf, COMMANDERS, normalise, expectedFiles, type Task, type Post, type Stat } from './rules.ts';
import { lastAssistantText } from './transcripts.ts';
import { KeepAwake } from './health.ts';
import { getSettings } from './settings.ts';
import { lightStatus } from './light.ts';
import { catalogOf } from './capacity.ts';
import { agentCost } from './usage.ts';
import { snapshotWork } from './outputs.ts';
import { readLearned, writeLearned, applyChanges, askModel, learnPrompt } from './learn.ts';
import { isSimpleRequest, judgeSimple, fastTaskText } from './fastpath.ts';
import { verifyFiles, needsInterpret, conversationBefore, folderSnapshot, buildPrompt, parseInterpretation, callModel, type Interpretation } from './interpret.ts';
const run = promisify(execFile);

export class Orchestrator {
  cfg: Config; store: Store; gw: Gateway; compat: Compat; awake = new KeepAwake();
  busyPass = false; lastSlowCheck = 0; dryRun: boolean;
  jobs: Record<string, any> = {};
  private idleSince = 0; private vramFreed = false;

  /** Give the GPU back when the team is done: 2 min with nothing running and no open task -> unload every model
   *  Ollama holds (OLLAMA_KEEP_ALIVE would otherwise keep a 12 GB model resident for half an hour). The next
   *  run reloads its model in seconds. */
  async freeVramWhenIdle(busy: boolean) {
    if (busy) { this.idleSince = 0; this.vramFreed = false; return; }
    if (!this.idleSince) this.idleSince = Date.now();
    if (this.vramFreed || Date.now() - this.idleSince < 2 * 60000) return;
    this.vramFreed = true;
    try {
      const ps: any = await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5000) })).json();
      const loaded = (ps.models || []) as any[]; if (!loaded.length) return;
      for (const m of loaded) await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(15000) }).catch(() => {});
      this.log(`team idle: unloaded ${loaded.map((m) => m.name.replace(/:latest$/, '')).join(', ')} - ${(loaded.reduce((s, m) => s + (m.size_vram || 0), 0) / 2 ** 30).toFixed(1)} GB of VRAM freed`);
    } catch {}
  }

  constructor(cfg: Config, store: Store, gw: Gateway, opts: { dryRun?: boolean } = {}) {
    this.cfg = cfg; this.store = store; this.gw = gw; this.dryRun = !!opts.dryRun;
    this.compat = new Compat(store, cfg.boardDir);
  }

  log(msg: string) {
    const ts = new Date(); const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())} ${p(ts.getHours())}:${p(ts.getMinutes())}:${p(ts.getSeconds())}`;
    mkdirSync(this.cfg.logDir, { recursive: true });
    appendFileSync(join(this.cfg.logDir, 'dispatch.log'), `[${stamp}] ${msg}\n`);
    appendFileSync(join(this.cfg.logDir, 'activity.log'), `[${stamp}] [orchestra] ${msg}\n`);
  }
  stat: Stat = (p) => { try { const s = statSync(p); return { exists: s.isFile(), size: s.size, mtimeMs: s.mtimeMs }; } catch { return { exists: false, size: 0, mtimeMs: 0 }; } };
  post(from: string, to: string, body: string) { return this.store.addPost(from, to, body, { source: 'orchestra' }); }
  running(a: string) { return !!this.jobs[a]?.state?.runningAtMs; }
  runMins(a: string) { const t = this.jobs[a]?.state?.runningAtMs; return t ? (Date.now() - t) / 60000 : 0; }
  get paused() { return existsSync(join(this.cfg.root, '.stopped')); }

  /** One pass. Safe to call often: re-entrant calls are dropped. */
  async pass(): Promise<void> {
    // A call during a pass is not dropped but runs right after it (a post from the user landing mid-pass used to wait for
    // the next 30 s tick).
    if (this.busyPass) { this.passAgain = true; return; }
    this.busyPass = true;
    try { await this.passInner(); if (this.lastPassError) { this.log('pass: working again (gateway answering)'); this.lastPassError = ''; } }
    catch (e: any) {
      // the same error every pass (gateway restarting) is logged once, not every 10 s
      const msg = String(e?.message || e).slice(0, 300), kind = msg.replace(/\d+/g, '#');
      if (kind !== this.lastPassError) this.log(`pass error: ${msg}`);
      this.lastPassError = kind;
    }
    finally { this.busyPass = false; }
    if (this.passAgain) { this.passAgain = false; setTimeout(() => this.pass(), 500); }
  }
  private passAgain = false;
  private lastPassError = '';

  private async passInner() {
    const now = new Date();
    if (this.paused) { this.awake.set(false); return; }

    // ---- 1. board: posts appended to BOARD.md by others, then the agents' outbox ----
    const ext = this.compat.importExternal();
    for (const r of ingestOutbox(this.store, this.cfg.outbox, now)) this.log(r.posted ? `outbox: posted ${r.from} -> ${r.to} from ${r.file}` : `outbox: skipped ${r.reason} post from ${r.from} (${r.file})`);
    if (ext) this.log(`board: imported ${ext} post(s) written to BOARD.md directly`);
    const posts = this.store.posts({ limit: 300 });

    // ---- 2. gateway state for this pass ----
    if (!this.dryRun) {
      const list = await this.gw.jobs();
      this.jobs = {};
      for (const j of list) if (/-board$/.test(j.name)) this.jobs[j.name.replace(/-board$/, '')] = j;
    }

    // ---- 3. tasks ----
    let tasks = this.store.tasks();
    const seen = new Set(this.store.get<string[]>('doneRejections', []));
    const fx = applyPosts(posts, tasks, { now, epoch: this.store.get<string>('taskEpoch', '') || undefined, workDir: this.cfg.workDir, stat: this.stat, seenRejections: seen });
    this.store.set('doneRejections', [...seen].slice(-300));
    for (const t of fx.created) this.log(`task ${t.id} for ${t.assignee}: ${t.text}`);
    for (const t of fx.cancelled) this.log(`task ${t.id} cancelled`);
    for (const t of fx.done) this.log(`task ${t.id} done`);
    for (const r of fx.rejected) {
      this.post('system', r.to, `DONE ${r.task.id} not accepted: ${r.missing.join(', ')} is missing or empty. Create it with the write tool, then post DONE ${r.task.id} again.`);
      this.log(`task ${r.task.id}: DONE from ${r.to} rejected, missing/empty: ${r.missing.join(', ')}`);
    }
    // Check finished work against the folders as they are (interpret.ts verifyFiles). A failed check reopens the
    // task once with the exact problem for the worker, instead of waiting for the brain to notice it. A reopened
    // task is not auto-closed by its files existing (its confirmation file is already there): only by a new DONE.
    const reopened = new Set(this.store.get<string[]>('verifyReopened', []));
    const autoClosed = autoDone(tasks.filter((t) => !reopened.has(`${t.id}|${t.created}`)), this.cfg.workDir, this.stat, now);
    for (const t of autoClosed) this.log(`task ${t.id} done (auto: all its files exist)`);
    for (const t of [...fx.done, ...autoClosed]) {
      const key = `${t.id}|${t.created}`;
      const v = reopened.has(key) ? { problems: [] as string[] } : verifyFiles(t.text, this.cfg.workDir);
      if (!v.problems.length) {
        this.taskCost(t, now);
        // review gate (Settings, off by default): passed the check, now waits for the user's Approve / Request changes
        if (t.by === 'fastpath' && !getSettings(this.store).review) { this.reportFast(t, posts); continue; }
        if (getSettings(this.store).review && t.by !== 'automation') {
          t.status = 'review' as any; t.updated = now.toISOString();
          this.post('system', 'user', `${t.id} is ready for your review (${t.assignee}): ${t.text.slice(0, 160)}${t.text.length > 160 ? '…' : ''}\nApprove it or request changes on the Tasks page.`);
          this.log(`task ${t.id}: passed the check, waiting for the user's review`);
        }
        continue;
      }
      reopened.add(key); t.status = 'open'; t.updated = now.toISOString();
      this.post('system', t.assignee, `${t.id} is not done yet - Orchestra checked the files: ${v.problems.join('; ')}. Fix exactly this (PowerShell on Windows: e.g. Remove-Item 'folder\\*.tmp'), list the folder to confirm, then team_done ${t.id} again.`);
      this.log(`task ${t.id}: check failed after DONE (${v.problems.join('; ').slice(0, 160)}) - reopened for ${t.assignee}`);
    }
    this.store.set('verifyReopened', [...reopened].slice(-200));
    this.store.saveTasks(tasks);
    for (const w of new Set(fx.cancelled.map((t) => t.assignee))) {
      if (this.running(w) && !tasks.some((t) => t.assignee === w && t.status === 'open')) { await this.stopAgent(w); this.log(`stopped ${w}: its task was cancelled`); }
    }
    if (shouldRenumber(tasks, now)) {
      const n = this.store.archiveTasks(now.toISOString());
      this.store.set('taskEpoch', minuteOf(now)); tasks = [];
      this.log(`tasks: archived ${n} finished task(s); numbering restarts at T1`);
    }

    // ---- 4. model / tool picks from main or the user ----
    if (!this.dryRun) await this.applyPicks(posts, now);
    if (!this.dryRun) await this.applyLight().catch((e) => this.log(`light mode: ${String(e.message).slice(0, 140)}`));

    // ---- 5. slower checks every ~110 s: relay, overflow, archived sessions, helpers ----
    if (!this.dryRun && Date.now() - this.lastSlowCheck >= 110000) { this.lastSlowCheck = Date.now(); await this.slowChecks(posts, now); }

    // ---- 6. automations ----
    this.automations(tasks, now);
    this.store.saveTasks(tasks);

    // ---- 7. who runs now ----
    if (!this.dryRun) await this.schedule(posts, tasks, now);

    // ---- 8. outputs ----
    const busy = this.cfg.agents.some((a) => this.running(a)) || tasks.some((t) => t.status === 'open');
    this.awake.set(busy);
    if (!busy && !this.dryRun) this.learnWhenIdle(posts).catch(() => {});   // learned memory (learn.ts), never during work
    if (!this.dryRun) await this.freeVramWhenIdle(busy);
    const late = this.compat.exportAll(this.store.tasks());
    if (late) { this.log(`board: imported ${late} post(s) that arrived during the pass`); setTimeout(() => this.pass(), 1000); }
  }

  // ---------------------------------------------------------------------------------------------
  /** Stop an agent's active work. sessions.abort cancels the run and keeps the session: archiving instead would
   * disable the job (runs started over the API live in the job's own session, agent:x:cron:<job>). */
  async stopAgent(a: string) {
    for (const s of await this.gw.sessions()) {
      const key = String(s.key || '');
      if (!key.startsWith(`agent:${a}:`) || key.endsWith(':board') || !(s.hasActiveRun || s.status === 'running')) continue;
      try { await this.gw.rpc('sessions.abort', { key }); this.log(`aborted active work in ${key}`); } catch (e: any) { this.log(`could not abort ${key}: ${e.message.slice(0, 120)}`); }
    }
  }

  private async applyPicks(posts: Post[], now: Date) {
    const models: Record<string, string> = {}, tools: Record<string, string[]> = {};
    for (const p of posts) {
      if (!COMMANDERS.has(p.from)) continue;
      const c = parseCommands(p.body);
      for (const m of c.models) if (this.cfg.aliases[m.alias]) models[m.agent] = m.alias;
      for (const t of c.tools) tools[t.agent] = [...new Set(['files', 'memory', 'team', ...t.groups.filter((g) => this.cfg.toolGroups[g])])];
    }
    const state = this.store.get<{ models: Record<string, string>; tools: Record<string, string>; fail: Record<string, number> }>('picks', { models: {}, tools: {}, fail: {} });
    const backoff = (k: string) => state.fail[k] && now.getTime() - state.fail[k] < 5 * 60000;
    const light = Object.keys(models).length ? (await lightStatus(this).catch(() => null))?.active : false;
    for (const [a, alias] of Object.entries(models)) {
      const j = this.jobs[a]; if (!j || state.models[a] === alias || backoff(`m:${a}`)) continue;
      // Light mode keeps workers on the composer's model (applyLight); only "vision" can still switch, for images
      if (light && a !== 'main' && alias !== 'vision') { state.models[a] = alias; continue; }
      try { await this.gw.updateJob(j.id, { payload: { kind: j.payload.kind, model: this.cfg.aliases[alias] } }); state.models[a] = alias; this.log(`model for ${a} set to ${alias} (${this.cfg.aliases[alias]})`); }
      catch (e: any) { state.fail[`m:${a}`] = now.getTime(); this.log(`could not set model for ${a} to ${alias} (retry in 5 min): ${e.message.slice(0, 120)}`); }
    }
    for (const [a, groups] of Object.entries(tools)) {
      const j = this.jobs[a]; const want = groups.join(','); if (!j || state.tools[a] === want || backoff(`t:${a}`)) continue;
      const allow = groups.flatMap((g) => this.cfg.toolGroups[g].split(','));
      try { await this.gw.updateJob(j.id, { payload: { kind: j.payload.kind, toolsAllow: allow } }); state.tools[a] = want; this.log(`tools for ${a} set to ${want}`); }
      catch (e: any) { state.fail[`t:${a}`] = now.getTime(); this.log(`could not set tools for ${a} (retry in 5 min): ${e.message.slice(0, 120)}`); }
    }
    this.store.set('picks', state);
  }

  /** Light mode (light.ts): while on, every worker job runs on the composer's model; the model a worker had before is
   *  kept and put back when Light mode goes off. Only between runs (a job is never changed under a running agent).
   *  Exception: a worker main switched to "vision" keeps it when the composer's model cannot see images. */
  private async applyLight() {
    const st = await lightStatus(this), main = String(this.jobs.main?.payload?.model || ''); if (!main) return;
    const saved = this.store.get<Record<string, string>>('lightSaved', {}), picks = this.store.get<any>('picks', { models: {} });
    const mainSees = !!catalogOf(this, main)?.vision;
    let changed = false;
    for (const w of this.cfg.workers) {
      const j = this.jobs[w]; if (!j || this.running(w)) continue;
      const cur = String(j.payload?.model || '');
      let want = '';
      if (st.active) {
        want = picks.models?.[w] === 'vision' && !mainSees && this.cfg.aliases.vision ? this.cfg.aliases.vision : main;
        if (cur !== want && !(w in saved)) { saved[w] = cur; changed = true; }
      } else if (w in saved) { want = saved[w]; delete saved[w]; changed = true; }
      if (!want || cur === want) continue;
      await this.gw.updateJob(j.id, { payload: { kind: j.payload.kind, model: want } }); j.payload.model = want;
      this.log(st.active ? `light mode: ${w} now uses the composer's model (${want.replace(/^ollama\/|:latest$/g, '')}): ${st.why}`
        : `light mode off: ${w} back on ${want.replace(/^ollama\/|:latest$/g, '')}`);
    }
    if (changed) this.store.set('lightSaved', saved);
  }

  private async slowChecks(posts: Post[], now: Date) {
    const relayed = new Set(this.store.get<string[]>('relayed', []));
    const agentOfJob: Record<string, string> = {};
    for (const [a, j] of Object.entries(this.jobs)) agentOfJob[j.id] = a;
    const runs = await this.gw.runs(50);
    this.store.set('recentRuns', runs.filter((r) => agentOfJob[r.jobId] && r.action === 'finished').slice(0, 20).map((r) => ({ ...r, agent: agentOfJob[r.jobId], summary: String(r.summary || '').slice(0, 300) })));

    // Relay: an agent finished a run with an answer but never posted it.
    for (const r of runs) {
      const agent = agentOfJob[r.jobId]; if (!agent || r.action !== 'finished' || relayed.has(r.runId)) continue;
      const endAt = r.ts, startAt = r.runAtMs || r.ts;
      if (now.getTime() - endAt > 2 * 3600000) { relayed.add(r.runId); continue; }
      if (now.getTime() - endAt < 3 * 60000) continue;
      relayed.add(r.runId);
      const text = String(r.summary || '').trim();
      if (!text || /^(NO_REPLY|HEARTBEAT_OK)\b/.test(text) || r.status !== 'ok') continue;
      const answered = posts.some((p) => p.from === agent && !p.cmd && (p as any).at >= startAt - 60000 && (p as any).at <= endAt + 180000);
      const probe = normalise(text).slice(0, 60);
      const poster = agent === 'main' ? 'main-relay' : agent;
      if (answered || posts.some((p) => (p.from === agent || p.from === poster) && normalise(p.body).includes(probe))) continue;
      let to = 'main';
      if (agent === 'main') { const lastUser = posts.map((p) => p.from).lastIndexOf('user'), lastMain = posts.map((p) => p.from).lastIndexOf('main'); to = lastUser > lastMain ? 'user' : 'all'; }
      // "Pass complete. Sleeping for 20 minutes." after every idle pass only buried real messages on the Board
      if (to !== 'user' && text.length < 200 && !/\bT\d+\b|[\\/]\w/.test(text)
        && /\b(rest(ing)?|sleep(ing)?|pass (is )?(over|complete|done)|next (pass|run)|nothing (new|to do)|no (new |open )?(work|tasks|messages))\b/i.test(text)) continue;
      this.post(poster, to, `${text}\n\n_(relayed: ${agent} answered in its run but did not post)_`);
      this.log(`relayed ${agent}'s answer to the board (to ${to})`);
    }
    // Overflow breaker and archived job sessions.
    for (const r of runs) {
      const agent = agentOfJob[r.jobId]; if (!agent) continue;
      if (/Context overflow/i.test(String(r.error)) && !relayed.has(`ovf:${r.runId}`) && agent !== 'main') {
        relayed.add(`ovf:${r.runId}`);
        this.post('system', 'main', `${agent} ran out of context. Split its current task into smaller TASKs, or tell it to read pages in chunks and keep notes in a file.`);
      }
      if (/is archived/i.test(String(r.error)) && !relayed.has(`arch:${r.runId}`)) { relayed.add(`arch:${r.runId}`); await this.restoreJobSessions(); }
    }

    // Helpers: reaper (running > 10 min) and mirror (finished helper's answer to the board).
    const sessions = await this.gw.sessions();
    const subSeen = this.store.get<Record<string, number>>('subSeen', {}); const seenNow: Record<string, number> = {};
    const helpers = sessions.filter((s) => String(s.key).includes(':subagent:'));
    for (const s of helpers.filter((x) => x.hasActiveRun || x.status === 'running')) {
      const first = subSeen[s.key] ?? now.getTime(); seenNow[s.key] = first;
      if (now.getTime() - first > this.cfg.helperMaxMin * 60000) {
        try { await this.gw.rpc('sessions.abort', { key: s.key }); } catch {}   // abort, keep the chat viewable
        const a = String(s.key).split(':')[1];
        this.post('system', 'main', `A helper session of ${a} ran over ${this.cfg.helperMaxMin} minutes and was stopped. Give helpers smaller, self-contained jobs.`);
        this.log(`helper reaper: stopped ${s.key}`); delete seenNow[s.key];
      }
    }
    this.store.set('subSeen', seenNow);
    for (const s of helpers) {
      const k = `helper:${s.key}`;
      if (relayed.has(k) || s.hasActiveRun || s.status === 'running') continue;
      if (now.getTime() - Number(s.updatedAt || 0) > 2 * 3600000) { relayed.add(k); continue; }
      relayed.add(k);
      const a = String(s.key).split(':')[1];
      let text = lastAssistantText(a, s.sessionId).trim(); if (text.length > 3000) text = text.slice(0, 3000) + ' ...(cut)';
      this.post(`${a}-helper`, 'main', `Helper '${s.label || 'unnamed'}' (${s.model || ''}) finished:\n${text || `(no answer text; status ${s.status})`}`);
      this.log(`helper mirror: posted result of ${s.key}`);
    }
    this.store.set('relayed', [...relayed].slice(-400));
  }

  async restoreJobSessions() {
    for (const [a, j] of Object.entries(this.jobs)) {
      const key = `agent:${a}:cron:${j.id}`;
      try {
        const d: any = await this.gw.describe(key); const s = d.session || d;
        if (!s?.archived) continue;
        await this.gw.patchSession(key, { archived: false, expectedSessionId: s.sessionId });
        if (!j.enabled) await this.gw.updateJob(j.id, { enabled: true });
        this.log(`restored archived job session ${key}`);
      } catch (e: any) { this.log(`could not restore ${key}: ${e.message.slice(0, 120)}`); }
    }
  }

  private automations(tasks: Task[], now: Date) {
    const file = join(this.cfg.boardDir, 'AUTOMATIONS.md'); if (!existsSync(file)) return;
    const fired = this.store.get<Record<string, string>>('autoFired', {});
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(daily\s+(\d{1,2}):(\d{2})|every\s+(\d+)\s*(m|h))\s+(main|worker[2-8]?)\s*:\s*(.{5,400})$/.exec(line); if (!m) continue;
      const key = line.trim(), agent = m[6], what = m[7].trim();
      const last = fired[key] ? new Date(fired[key]) : new Date(0);
      let due: boolean;
      if (m[2]) { const at = new Date(now); at.setHours(+m[2], +m[3], 0, 0); due = now >= at && now.getTime() < at.getTime() + 2 * 3600000 && last < at; }
      else due = now.getTime() - last.getTime() >= Math.max(30, +m[4] * (m[5] === 'h' ? 60 : 1)) * 60000;
      if (!due) continue;
      fired[key] = now.toISOString();
      if (agent === 'main') { this.post('system', 'main', `Automation: ${what}`); this.store.set('wakeMain', true); }
      else {
        const id = 'T' + (1 + Math.max(0, ...tasks.map((t) => +t.id.replace(/\D/g, '') || 0)));
        tasks.push({ id, assignee: agent, text: `${what} (automation)`, status: 'open', attempts: 0, by: 'automation', created: now.toISOString(), updated: now.toISOString() });
      }
      this.log(`automation fired: ${key}`);
    }
    this.store.set('autoFired', fired);
  }

  private async gpuTemp(): Promise<number> {
    try { const { stdout } = await run('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], { windowsHide: true }); return parseInt(stdout) || 0; } catch { return 0; }
  }

  /** Fast path (fastpath.ts): hand a simple request straight to the least-busy enabled worker as a task. Returns true
   *  when it did (the composer then stays asleep for this post). */
  private async fastPath(msg: Post, tasks: Task[], now: Date): Promise<boolean> {
    const s = getSettings(this.store); if (s.fastPath === false) return false;
    // each post is judged once: while main is busy the user's post stays "new" for many passes (no repeat model calls or logs)
    if (this.store.get<number>('fastChecked', 0) >= msg.id) return false;
    this.store.set('fastChecked', msg.id);
    if (tasks.some((t) => t.by === 'fastpath' && (t.status === 'open' || (t.status as string) === 'review'))) return false;   // one at a time
    let d = isSimpleRequest(msg.body);
    // borderline: one short model call decides (still far quicker than waking the composer)
    const model = String(this.jobs.main?.payload?.model || '');
    if (d.unsure && model.startsWith('ollama/')) d = await judgeSimple(model.replace(/^ollama\//, ''), msg.body);
    if (!d.ok) { this.log(`fast path: no (${d.why}) - the composer plans it`); return false; }
    const on = s.workers.filter((w) => this.cfg.workers.includes(w)); if (!on.length) return false;
    const load = (w: string) => tasks.filter((t) => t.assignee === w && t.status === 'open').length + (this.running(w) ? 1 : 0);
    const w = [...on].sort((a, b) => load(a) - load(b))[0];
    if (load(w) > 0) { this.log('fast path: no free worker - the composer plans it'); return false; }
    const id = 'T' + (1 + Math.max(0, ...tasks.map((t) => Number(t.id.replace(/\D/g, '')) || 0)));
    const text = fastTaskText(msg.body, this.cfg.workDir);
    tasks.push({ id, assignee: w, text, status: 'open', attempts: 0, by: 'fastpath', created: now.toISOString(), updated: now.toISOString() });
    this.store.saveTasks(tasks);
    this.store.set('fastFor', { ...this.store.get<Record<string, number>>('fastFor', {}), [id + '|' + now.toISOString()]: msg.id });
    this.post('main-fast', 'user', `Quick job - ${w} is on it directly (${id}). I'll post the result here.`);
    this.store.addPost('main', w, `TASK ${w}: ${text}`, { cmd: true, source: 'fastpath' });   // the board's record (cmd: the task already exists, like team_assign)
    this.log(`fast path: ${id} for ${w} (${d.why}): ${text.slice(0, 140)}`);
    return true;
  }
  /** A fast-path task passed its check: tell the user the result directly (what the worker said, and the files). */
  private reportFast(t: Task, posts: Post[]) {
    // only this task's posts: ids restart after an archive, so an older "DONE T3" can still be on the board
    const since = minuteOf(t.created), mine = [...posts].reverse().filter((p) => p.from === t.assignee && p.ts >= since && new RegExp(`\\b${t.id}\\b`).test(p.body));
    // the worker's own words, unless they only repeat the file name (the Files line says that)
    const done = mine.find((p) => !/^\s*(DONE\s+T\d+\s*:?\s*)?(Created|Wrote|Saved)?\s*\S+\.\w+\s*$/i.test(p.body) && !/^\s*Starting\b/i.test(p.body));
    const note = done ? done.body.replace(/^\s*DONE\s+T\d+\s*:?\s*/i, '').trim() : '';
    const files = expectedFiles(t.text, this.cfg.workDir).filter((f) => this.stat(f).exists);
    const cost = this.store.get<Record<string, any>>('taskCosts', {})[`${t.id}|${t.created}`];
    this.post('main-fast', 'user', `Done (${t.id}, ${t.assignee}${cost ? `, ${cost.secs} s` : ''}): ${note.slice(0, 400) || 'finished.'}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`);
  }

  /** Learned memory: once the user's latest request has been answered and the team is idle (at most every 5 min), one model
   *  call turns the recent conversation into ADD / UPDATE / DELETE changes to memory/learned.md (Settings: Learn). */
  private learning = false;
  private async learnWhenIdle(posts: Post[]) {
    if (this.learning || getSettings(this.store).learn === false) return;
    if (Date.now() - this.store.get<number>('learnAt', 0) < 5 * 60000) return;
    const lastUser = [...posts].reverse().find((p) => p.from === 'user'); if (!lastUser) return;
    if (lastUser.id <= this.store.get<number>('learnedUpTo', 0)) return;
    if (!posts.some((p) => p.id > lastUser.id && /^main(-relay|-chat|-fast)?$/.test(p.from) && p.to === 'user')) return;   // not answered yet
    const model = String(this.jobs.main?.payload?.model || ''); if (!model.startsWith('ollama/')) return;
    this.learning = true; this.store.set('learnAt', Date.now());
    try {
      const since = this.store.get<number>('learnedUpTo', 0);
      const convo = posts.filter((p) => p.id > since && !p.cmd && (p.from === 'user' || (/^main/.test(p.from) && p.to === 'user') || (this.cfg.workers.includes(p.from) && /^\s*DONE\s+T\d+/i.test(p.body)) || (p.from === 'system' && /not done yet|failed \d+ times/i.test(p.body)))).slice(-20);
      if (!convo.length) { this.store.set('learnedUpTo', lastUser.id); return; }
      const items = readLearned(this.cfg);
      const changes = await askModel(model.replace(/^ollama\//, ''), learnPrompt(convo, items));
      const r = applyChanges(items, changes, new Date().toISOString().slice(0, 10));
      if (r.added || r.updated || r.deleted) { writeLearned(this.cfg, r.items); this.log(`learned: ${r.added} new, ${r.updated} updated, ${r.deleted} removed (memory/learned.md, ${r.items.length} entries)`); }
      this.store.set('learnedUpTo', lastUser.id);
    } catch (e: any) { this.log(`learned: skipped (${String(e?.message || e).slice(0, 120)})`); }
    finally { this.learning = false; }
  }

  /** Interpret the user's newest post once (Settings: "Interpret requests"); any failure just leaves the agenda as it was. */
  private async interpretUser(posts: Post[], tasks: Task[]) {
    if (!getSettings(this.store).interpret) return;
    const msg = [...posts].reverse().find((p) => p.from === 'user'); if (!msg) return;
    const done = this.store.get<Record<string, Interpretation>>('interpretations', {});
    if (done[msg.id] || !needsInterpret(posts, msg, this.cfg.workers)) return;
    const model = String(this.jobs.main?.payload?.model || '');
    if (!model.startsWith('ollama/')) return;   // a cloud brain resolves follow-ups itself
    const t0 = Date.now();
    try {
      const convo = conversationBefore(posts, msg, this.cfg.workers);
      const snapshot = folderSnapshot([...convo.map((p) => p.body), ...tasks.slice(-6).map((t) => t.text), msg.body], this.cfg.workDir);
      const prompt = buildPrompt(msg, convo, tasks, this.cfg.workDir, snapshot);
      const i = parseInterpretation(await callModel(model.replace(/^ollama\//, ''), prompt), tasks);
      if (!i) { this.log('interpret: the model gave no usable answer; agenda unchanged'); return; }
      i.ms = Date.now() - t0; if (snapshot) i.snapshot = snapshot;
      done[msg.id] = i;
      const keep = Object.keys(done).map(Number).sort((a, b) => b - a).slice(0, 50);
      this.store.set('interpretations', Object.fromEntries(keep.map((k) => [k, done[k]])));
      this.log(`interpret (${(i.ms / 1000).toFixed(0)} s, ${i.kind}, ${i.confidence}${i.refersTo ? `, about ${i.refersTo}` : ''}): "${msg.body.slice(0, 60)}" -> ${i.means}`);
    } catch (e: any) { this.log(`interpret: skipped (${String(e?.message || e).slice(0, 120)})`); }
  }

  /** A finished task's cost: wall time from its first start, and the worker's runs, model calls and tokens in that
   *  window (Tasks page). Kept in the store under "id|created" (the tasks table has fixed columns). */
  private taskCost(t: Task, now: Date) {
    const key = `${t.id}|${t.created}`;
    const from = this.store.get<Record<string, number>>('taskStarts', {})[key] || Date.parse(t.created);
    if (!from) return;
    const c = agentCost(t.assignee, from, now.getTime());
    const costs = this.store.get<Record<string, any>>('taskCosts', {});
    costs[key] = { secs: Math.round((now.getTime() - from) / 1000), ...c, at: now.toISOString() };
    this.store.set('taskCosts', Object.fromEntries(Object.entries(costs).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 500)));
    this.log(`task ${t.id} cost: ${Math.round((now.getTime() - from) / 1000)} s, ${c.runs} run(s), ${c.tokIn} tokens read, ${c.tokOut} written`);
  }

  private async start(a: string, why: string) {
    const j = this.jobs[a]; if (!j) return;
    await this.gw.runJob(j.id);
    const lastRun = this.store.get<Record<string, string>>('lastRun', {}); lastRun[a] = new Date().toISOString(); this.store.set('lastRun', lastRun);
    this.store.set('history', [...this.store.get<string[]>('history', []), new Date().toISOString()].slice(-100));
    this.log(`starting ${a} (${why})`);
  }

  private async schedule(posts: Post[], tasks: Task[], now: Date) {
    // Runaways: OpenClaw stops a run at its limit (Settings > OpenClaw, default 8 min), so anything still running
    // 3 min past it is stuck.
    const runaway = getSettings(this.store).runMinutes + 3;
    for (const a of this.cfg.agents) {
      if (this.running(a) && this.runMins(a) > runaway) {
        await this.stopAgent(a); this.log(`runaway: stopped ${a} after ${Math.round(this.runMins(a))} min`);
        if (a !== 'main') this.post('system', 'main', `${a} was stuck for over ${runaway} minutes and was stopped. Check its task and give it a smaller one or another model.`);
      }
    }
    const temp = await this.gpuTemp();
    if (temp >= this.cfg.maxTempC) {
      const last = this.store.get<number>('lastHotLog', 0);
      if (now.getTime() - last > 600000) { this.log(`GPU at ${temp} C - holding new runs until it cools below ${this.cfg.maxTempC} C`); this.store.set('lastHotLog', now.getTime()); }
      return;
    }
    const history = this.store.get<string[]>('history', []).filter((h) => now.getTime() - Date.parse(h) < 3600000);
    if (history.length >= this.cfg.maxPerHour) return;

    // main: continuous passes; picks its own rest with team_sleep; a post from the user wakes it early.
    const lastRun = this.store.get<Record<string, string>>('lastRun', {});
    const lastMainStart = lastRun.main ? Date.parse(lastRun.main) : 0;
    const froms = posts.map((p) => p.from);
    const lastUser = froms.lastIndexOf('user');
    const userKey = lastUser >= 0 ? `${posts[lastUser].id}` : '';
    // Retry: main ran after the user's newest post (it was in that pass's brief) but the post is still unhandled - the
    // run ended without acting (seen: thinking runs that wrote the tool call into the thinking text). Wake it again,
    // twice at most per post, instead of leaving the user waiting for the full rest.
    if (lastUser >= 0 && !this.running('main') && lastMainStart && (now.getTime() - lastMainStart) > 45000) {
      const p = posts[lastUser], handledUpTo = Math.max(this.store.get<{ post: number } | null>('mainHandled', null)?.post ?? 0, this.store.get<number>('mainAnsweredUpTo', 0));
      const r = this.store.get<{ id: number; n: number }>('userRetry', { id: 0, n: 0 });
      if (p.id <= this.store.get<number>('postsAtMainStart', 0) && p.id > handledUpTo && (r.id !== p.id || r.n < 2)) {
        const n = r.id === p.id ? r.n + 1 : 1; this.store.set('userRetry', { id: p.id, n });
        this.store.set('wakeMain', true); this.log(`main ended its pass without acting on the user's message - running it again (retry ${n} of 2)`);
      }
    }
    const wakeFlag = join(this.cfg.logDir, 'wake-main.flag');
    if (existsSync(wakeFlag)) { this.store.set('wakeMain', true); try { unlinkSync(wakeFlag); } catch {} }
    // Any user post main has not been started for yet (not "newer than main's last post": main's report on earlier
    // work can land seconds after the user's follow-up and hid it).
    let userNew = (!!userKey && userKey !== this.store.get('lastUserTriggered', '')) || this.store.get('wakeMain', false);
    // Fast path: a simple one-step request goes straight to a free worker; the composer is not woken for it.
    if (userNew && !this.store.get('wakeMain', false) && lastUser >= 0 && await this.fastPath(posts[lastUser], tasks, now)) { this.store.set('lastUserTriggered', userKey); userNew = false; }
    // A worker reported to main (finished a task, or asked something) after main's last pass started: main reviews
    // it now instead of at the end of its rest, so results reach the user minutes sooner. (Fast-path results are reported
    // by Orchestra itself, so they do not wake main.)
    const sinceStart = this.store.get<number>('postsAtMainStart', 0);
    const fastIds = new Set(tasks.filter((t) => t.by === 'fastpath').map((t) => t.id));
    const report = [...posts].reverse().find((p) => p.id > sinceStart && this.cfg.workers.includes(p.from) && (p.to === 'main' || p.to === 'all') && !p.cmd
      && !fastIds.has((/T\d+/.exec(p.body) || [''])[0]));
    const reportNew = !!report && String(report.id) !== this.store.get('lastReportTriggered', '');
    let sleepUntil = 0;
    const sf = join(this.cfg.logDir, 'main-sleep-until.txt');
    if (existsSync(sf) && statSync(sf).mtimeMs >= lastMainStart) sleepUntil = Date.parse(readFileSync(sf, 'utf8').trim()) || 0;
    else if (lastMainStart) {
      const quiet = this.store.lastPostId() <= this.store.get<number>('postsAtMainStart', 0) && !tasks.some((t) => t.status === 'open');
      sleepUntil = lastMainStart + (quiet ? this.cfg.idleRestMin : this.cfg.busyRestMin) * 60000;
    }
    const sinceMain = lastMainStart ? (now.getTime() - lastMainStart) / 60000 : 999;
    // the user never waits for the gap: it only spaces out main's own passes and worker reports.
    if (!this.running('main') && (userNew || sinceMain >= this.cfg.mainGapMin) && (userNew || reportNew || now.getTime() >= sleepUntil)) {
      if (userNew) { this.store.set('wakeMain', false); try { unlinkSync(sf); } catch {} }
      if (userKey) this.store.set('lastUserTriggered', userKey);   // whatever woke main, its brief shows the user's newest post
      if (reportNew) this.store.set('lastReportTriggered', String(report!.id));
      if (userNew) await this.interpretUser(posts, tasks);   // "the user most likely means: ..." for the agenda (interpret.ts)
      this.store.set('postsAtMainStart', this.store.lastPostId());
      await this.start('main', userNew ? 'new post from the user' : reportNew ? `${report!.from} reported` : 'next pass');
    }

    // workers: only with an open task; up to `parallel` at once (Settings), oldest task first across workers.
    const settings = getSettings(this.store);
    const enabled = settings.workers.filter((w) => this.cfg.workers.includes(w));   // Settings: workers on/off
    let free = Math.max(1, settings.parallel) - this.cfg.workers.filter((w) => this.running(w)).length;
    const oldest = (w: string) => tasks.filter((x) => x.assignee === w && x.status === 'open').map((x) => x.created).sort()[0] || '~';
    if (free > 0) {
      for (const w of [...enabled].sort((a, b) => oldest(a).localeCompare(oldest(b)))) {
        if (free <= 0) break;
        if (this.running(w)) continue;
        // Parallel workers share one model (one copy of the weights; each run only adds its KV cache). A worker set
        // to a different model waits until the running ones finish, instead of loading a second model into VRAM.
        const busyModels = this.cfg.workers.filter((x) => this.running(x)).map((x) => this.jobs[x]?.payload?.model);
        if (busyModels.length && !busyModels.includes(this.jobs[w]?.payload?.model)) continue;
        const t = tasks.filter((x) => x.assignee === w && x.status === 'open').sort((a, b) => a.created.localeCompare(b.created))[0];
        if (!t) continue;
        const last = lastRun[w] ? (now.getTime() - Date.parse(lastRun[w])) / 60000 : 999;
        if (last < this.cfg.agentCooldownMin) continue;
        if (t.attempts >= this.cfg.maxAttempts) {
          t.status = 'stuck'; t.updated = now.toISOString();
          this.post('system', 'main', `Task ${t.id} for ${w} failed ${this.cfg.maxAttempts} times: ${t.text}\nRethink it: split it into smaller tasks, give it another model, or CANCEL ${t.id}.`);
          this.log(`task ${t.id} marked stuck after ${this.cfg.maxAttempts} tries`); continue;
        }
        t.attempts++; t.updated = now.toISOString();
        this.store.saveTasks(tasks);
        await snapshotWork(this.cfg.workDir, `before ${t.id} (${w}, try ${t.attempts})`);   // checkpoint: what the run deletes can be restored
        await this.start(w, `task ${t.id}, try ${t.attempts}`);
        // first start of this task: the cost of the task is counted from here (see taskCost)
        const starts = this.store.get<Record<string, number>>('taskStarts', {}); const sk = `${t.id}|${t.created}`;
        if (!starts[sk]) { starts[sk] = Date.now(); const keep = Object.entries(starts).sort((a, b) => b[1] - a[1]).slice(0, 300); this.store.set('taskStarts', Object.fromEntries(keep)); }
        free--;
      }
    }
    this.store.saveTasks(tasks);
  }
}

export { atomicWrite };
