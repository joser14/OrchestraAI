// Dashboard server (phase 3): serves the dashboard and its API from the Orchestra process itself, replacing
// board-gui\server.js. Same endpoints and page, but every answer comes from Orchestra's database, its in-memory
// gateway state and OpenClaw's transcript files: no `openclaw` CLI processes (they piled up and hung the gateway),
// and posts go straight into the database (no more appending to BOARD.md and racing the export).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, statfsSync, createReadStream, createWriteStream, mkdirSync, unlinkSync, appendFileSync, openSync, readSync, closeSync } from 'node:fs';
import os, { homedir } from 'node:os';
import { liveGen } from './ollamaproxy.ts';
import { listMemory, readMemory, saveMemory } from './memory.ts';
import { listSkills, saveSkill, removeSkill } from './teamskills.ts';
import { restoreWork } from './outputs.ts';
import { join, resolve, basename, extname, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Orchestrator } from './orchestrator.ts';
import { openclawRoot } from './gateway.ts';
import { gatewayAnswers } from './health.ts';
import type { Setup } from './setup.ts';
import { libraryView, type Library } from './library.ts';
import type { UsageIndex } from './usage.ts';
import { minuteOf } from './rules.ts';
import { applyTeamSize, MAX_WORKERS } from './team.ts';
import { syncTeam } from './bootstrap.ts';
import { reconcileAliases } from './setup.ts';
import { AGENT_SPEC_VERSION, applyAgentSpecs, agentSpecs } from './agents.ts';
import type { McpAccess } from './config.ts';
import { teamPlan, setOllamaParallel } from './capacity.ts';
import { getSettings, saveSettings, readAutonomy, pendingApprovals, resolveApproval, startWithPc, readAgentOptions, applyAgentOptions, setSkillWorkshop } from './settings.ts';
import { gpuMemMB } from './hardware.ts';
import { lightStatus } from './light.ts';
const run = promisify(execFile);
const require = createRequire(import.meta.url);
// Same checks as the desktop app's startup check: core installs, services to start, agent tools.
const prereqs = require('../lib/prereqs.cjs');
const fixing: Record<string, { running: boolean; log: string[]; error?: string }> = {};

export const WEB_PORT = 8787;
const MODEL_GUIDE: Record<string, string> = { smart: '8B · best reasoning (the brain)', fast: '4B · default worker', vision: '4B · sees images', tiny: '1.7B · quick chores',
  mini: '2B · sees images', granite: '3B · general', llama: '3B · general', micro: '0.8B · sees images', lfm: '1.2B · tool-focused', vl: '2B · sees images', hermes: '3B · function calls' };

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin' };
const ASSET_TYPES: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
/** The last `maxBytes` of a file as lines (reads only the end, so big logs stay cheap); first partial line dropped. */
function tailLines(file: string, n: number, maxBytes = 512 * 1024): string[] {
  try {
    const size = statSync(file).size, start = Math.max(0, size - maxBytes), len = size - start;
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').replace(/\r/g, '').split('\n');
    if (start > 0) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.slice(-n);
  } catch { return []; }
}
/** Newest non-empty file in a folder whose name matches. */
function newestLog(dir: string, re: RegExp): string {
  try {
    return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)).map((f) => ({ f, s: statSync(f) }))
      .filter((x) => x.s.size > 0).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)[0]?.f || '';
  } catch { return ''; }
}

function tail(file: string, n: number) { try { return readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; } }
function listDir(dir: string, limit = 30) {
  try { return readdirSync(dir).map((n) => { const s = statSync(join(dir, n)); return { name: n, size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() }; }).sort((a, b) => b.mtime - a.mtime).slice(0, limit); } catch { return []; }
}
/** Plain words for OpenClaw's tool groups (config.ts toolGroups). */
const TOOL_ABOUT: Record<string, string> = {
  files: 'read, write and edit files', memory: 'save and recall notes between runs', web: 'search the web and fetch pages',
  shell: 'run commands (PowerShell on Windows)', browser: "drive OpenClaw's own browser: click, fill forms, screenshots", team: 'the board, tasks, messages and PDFs',
};
function listWork(work: string, limit = 25) {
  const out: { path: string; size: number; mtime: number }[] = [];
  const walk = (d: string, depth: number) => { if (depth > 3) return; let es: any[] = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (e.name.startsWith('.')) continue; const f = join(d, e.name); if (e.isDirectory()) walk(f, depth + 1); else { try { const s = statSync(f); out.push({ path: f.slice(work.length + 1), size: s.size, mtime: s.mtimeMs }); } catch {} } } };
  walk(work, 0); return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export function startWeb(o: Orchestrator, opts: { soon: () => void; webDir: string; setup: Setup; library: Library; usage: UsageIndex }) {
  const cfg = o.cfg, ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
  const liveJs = join(import.meta.dirname, '..', 'lib', 'live.cjs'), metricsJs = join(import.meta.dirname, '..', 'lib', 'metrics.cjs');
  const fresh = (p: string) => { delete require.cache[require.resolve(p)]; return require(p); };
  const post = (to: string, text: string) => { o.store.addPost('jr', to.replace(/[^\w-]/g, '') || 'all', text.replace(/^## /gm, '### ').trim(), { source: 'dashboard' }); opts.soon(); };
  const act = (m: string) => appendFileSync(join(cfg.logDir, 'activity.log'), `[${minuteOf(new Date())}:00] [dashboard] ${m}\n`);

  async function gpu() {
    try { const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { windowsHide: true });
      const f = stdout.split('\n')[0].split(',').map((s) => s.trim()); const m = gpuMemMB(f[0], f[1]);   // GB10: unified RAM
      return { used: m.used, total: m.total, util: parseFloat(f[2]) || 0, temp: parseFloat(f[3]) || 0, watts: Math.round(parseFloat(f[4]) || 0) }; } catch { return null; }
  }
  // ---- health check: runs by itself every 30 min (and from the System page). It restarts services that stopped
  // and logs anything still failing; heavier repairs (team setup, installs) stay on the Setup page's Fix buttons.
  const HEALTH_EVERY_MS = 30 * 60000, SERVICE_STARTED = Date.now();
  let healthRunning: Promise<any> | null = null;
  async function runHealth(why: 'auto' | 'manual'): Promise<any> {
    if (healthRunning) return healthRunning;
    healthRunning = (async () => {
      const items: { status: 'PASS' | 'WARN' | 'FAIL'; item: string; detail: string }[] = [];
      const add = (status: 'PASS' | 'WARN' | 'FAIL', item: string, detail: string) => items.push({ status, item, detail });
      const repaired: string[] = [];
      // services: restart what stopped (the same thing the Setup page's Start buttons do)
      try {
        const pre = await prereqs.check();
        const down = pre.filter((i: any) => i.group === 'services' && !i.ok);
        if (down.length && !existsSync(join(cfg.root, '.stopped'))) {
          const failed = await prereqs.startServices(pre, (m: string) => o.log(`health: ${m}`));
          for (const d of down) if (!failed.some((f: any) => f.id === d.id)) repaired.push(d.name);
        }
        for (const i of pre.filter((x: any) => x.group !== 'tools')) add(i.ok || repaired.includes(i.name) ? 'PASS' : 'FAIL', i.name, repaired.includes(i.name) ? 'was stopped: restarted' : i.detail);
        const tools = pre.filter((x: any) => x.group === 'tools' && !x.ok);
        add(tools.length ? 'WARN' : 'PASS', 'agent tools', tools.length ? `missing: ${tools.map((t: any) => t.name).join(', ')} (Setup page: Fix)` : 'all installed');
      } catch (e: any) { add('WARN', 'requirements', `could not check: ${e.message}`); }
      const ps = await ollamaPs();
      add(ps ? 'PASS' : 'FAIL', 'Ollama answering', ps ? `${ps.length} model(s) loaded` : 'not answering');
      // the connection only recovers on a successful call: after a (re)start, try a few before judging it
      for (let i = 0; i < 6 && !o.gw.healthy; i++) { try { await o.gw.jobs(); } catch {} if (!o.gw.healthy) await new Promise((r) => setTimeout(r, 3000)); }
      if (!o.gw.healthy) { try { await o.gw.jobs(); } catch {} }
      add(o.gw.healthy ? 'PASS' : 'FAIL', 'gateway connection', o.gw.healthy ? 'Orchestra is connected' : 'Orchestra is not connected to the gateway');
      try {
        const r: any = await opts.setup.ready();
        const miss = (r?.missing || []) as string[];
        add(miss.length ? 'FAIL' : 'PASS', 'team in OpenClaw', miss.length ? `needs repair: ${miss.slice(0, 6).join(', ')} (Setup page: Fix)` : 'agents, jobs, plugin and models ready');
      } catch (e: any) { add('WARN', 'team in OpenClaw', `could not check: ${e.message}`); }
      const stuck = o.store.tasks().filter((t) => t.status === 'stuck');
      add(stuck.length ? 'WARN' : 'PASS', 'tasks', stuck.length ? `stuck: ${stuck.map((t) => t.id).join(', ')} (the composer re-plans them)` : `${o.store.tasks().filter((t) => t.status === 'open').length} open, none stuck`);
      try { const s = statfsSync(cfg.root); const gb = s.bavail * s.bsize / 2 ** 30; add(gb < 5 ? 'FAIL' : gb < 20 ? 'WARN' : 'PASS', 'free disk', `${gb.toFixed(0)} GB free where the data lives`); } catch {}
      const g = await gpu(); if (g) add(g.temp >= cfg.maxTempC ? 'WARN' : 'PASS', 'GPU', `${g.temp} °C · ${(g.used / 1024).toFixed(1)}/${(g.total / 1024).toFixed(0)} GB`);
      add(existsSync(join(cfg.root, '.stopped')) ? 'WARN' : 'PASS', 'paused', existsSync(join(cfg.root, '.stopped')) ? 'agents paused (Resume at the top)' : 'running');
      const result = { ranAt: new Date().toISOString(), why, everyMin: HEALTH_EVERY_MS / 60000, repaired, items };
      o.store.set('healthLast', result);
      const bad = items.filter((i) => i.status === 'FAIL');
      o.log(`health check (${why}): ${items.length - bad.length}/${items.length} ok${repaired.length ? `, restarted ${repaired.join(', ')}` : ''}${bad.length ? `; failing: ${bad.map((b) => b.item).join(', ')}` : ''}`);
      return result;
    })().finally(() => { healthRunning = null; });
    return healthRunning;
  }
  setTimeout(() => runHealth('auto').catch(() => {}), 90000);   // first one shortly after start, then every 30 min
  setInterval(() => runHealth('auto').catch(() => {}), HEALTH_EVERY_MS);

  /** Saved request templates; three starters until the user changes the list. */
  const RECIPE_STARTERS = [
    { name: 'Research & compare', template: 'Research {topic} and give me a PDF comparing the top {count} options in one table (price, pros, cons, best for), with sources.' },
    { name: 'Summarize a file', template: 'Read {file} in the inbox and write a one-page PDF summary: the key points, numbers and anything I need to act on.' },
    { name: 'Weekly plan', template: 'Make me a PDF plan for {goal} this week: daily steps with time estimates, and what to check at the end of the week.' },
  ];
  const recipes = () => o.store.get<{ name: string; template: string }[] | null>('recipes', null) ?? RECIPE_STARTERS;
  // telemetry state: CPU counters, energy and peak temperature since the service started
  const tel = { cpu: null as { idle: number; all: number } | null, at: 0, wh: 0, tempMax: 0,
    last: null as { at: number; g: any; cpuPct: number } | null,
    hist: [] as { at: number; tps: number; gpu: number; cpu: number; w: number; temp: number }[] };
  /** One sample every 3 s: GPU (nvidia-smi), CPU busy % since the last sample, energy and peak temperature, and a
   *  15-minute history (300 points) for the Dashboard charts. */
  async function sampleTelemetry() {
    const g = await gpu(), now = Date.now();
    const tot = os.cpus().reduce((a, c) => { const t = c.times; return { idle: a.idle + t.idle, all: a.all + t.idle + t.user + t.sys + t.irq + t.nice }; }, { idle: 0, all: 0 });
    const cpuPct = tel.cpu ? Math.max(0, Math.min(100, Math.round(100 * (1 - (tot.idle - tel.cpu.idle) / Math.max(1, tot.all - tel.cpu.all))))) : 0; tel.cpu = tot;
    if (g && tel.at) tel.wh += (g.watts || 0) * ((now - tel.at) / 3600000); tel.at = now;
    if (g) tel.tempMax = Math.max(tel.tempMax, g.temp || 0);
    tel.last = { at: now, g, cpuPct };
    tel.hist.push({ at: now, tps: liveGen().nowTps, gpu: g?.util || 0, cpu: cpuPct, w: g?.watts || 0, temp: g?.temp || 0 });
    if (tel.hist.length > 300) tel.hist.shift();
  }
  setInterval(() => { sampleTelemetry().catch(() => {}); }, 3000);
  // storage (Metrics > Storage): the PC's drives, and the size of what Orchestra keeps
  const store = { at: 0, busy: null as Promise<void> | null, parts: [] as { name: string; about: string; path: string; bytes: number; drive: string }[] };
  const driveOf = (p: string) => (process.platform === 'win32' ? resolve(p).slice(0, 2).toUpperCase() : '/');
  function drives() {
    const roots = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((r) => existsSync(r)) : ['/', homedir()];
    const seen = new Set<string>(), out: { drive: string; totalGB: number; usedGB: number; freeGB: number }[] = [];
    for (const r of roots) {
      try { const s = statfsSync(r); const GB = 2 ** 30, total = s.blocks * s.bsize / GB; if (!total) continue;
        const key = `${s.blocks}:${s.bfree}`; if (seen.has(key)) continue; seen.add(key);   // the same filesystem twice (Linux / and home)
        out.push({ drive: r.replace(/\\$/, ''), totalGB: +total.toFixed(1), freeGB: +(s.bavail * s.bsize / GB).toFixed(1), usedGB: +((s.blocks - s.bfree) * s.bsize / GB).toFixed(1) }); } catch {}
    }
    return out;
  }
  /** Bytes under a folder (walked without blocking the service; capped at 200k entries). */
  async function folderBytes(dir: string): Promise<number> {
    const { readdir, stat } = await import('node:fs/promises');
    let total = 0, n = 0; const stack = [dir];
    while (stack.length && n < 200000) {
      const d = stack.pop()!; let es: any[] = []; try { es = await readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of es) { n++; const f = join(d, e.name); if (e.isDirectory()) stack.push(f); else if (e.isFile()) { try { total += (await stat(f)).size; } catch {} } }
    }
    return total;
  }
  async function measureStorage() {
    const modelsDir = process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models');
    const known = [
      { name: 'AI models', about: 'Ollama model files (the biggest part: remove unused ones on the Models page)', path: modelsDir },
      { name: 'Work files', about: 'what the team made for you', path: cfg.workDir },
      { name: 'Inbox', about: 'files you gave the team', path: join(cfg.root, 'inbox') },
      { name: 'Logs', about: 'service and agent logs (trimmed automatically)', path: cfg.logDir },
      { name: 'Backups', about: 'saved copies of work and settings', path: join(cfg.root, 'backups') },
      { name: 'OpenClaw', about: "the agent engine's sessions, transcripts and settings", path: process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw') },
    ].filter((p, i, a) => p.path && existsSync(p.path) && a.findIndex((x) => resolve(x.path) === resolve(p.path)) === i);
    const parts = [];
    for (const p of known) parts.push({ ...p, bytes: await folderBytes(p.path), drive: driveOf(p.path) });
    // everything else in Orchestra's data folder (its database, memory, skills, tools)
    const inRoot = parts.filter((p) => resolve(p.path).toLowerCase().startsWith(resolve(cfg.root).toLowerCase())).reduce((a, p) => a + p.bytes, 0);
    parts.push({ name: 'Orchestra data', about: 'its database, memory, skills and tools', path: cfg.root, bytes: Math.max(0, await folderBytes(cfg.root) - inRoot), drive: driveOf(cfg.root) });
    store.parts = parts.sort((a, b) => b.bytes - a.bytes); store.at = Date.now();
  }
  let tagsCache = { at: 0, count: 0, sizes: {} as Record<string, number> };
  async function ollamaTags() {
    if (Date.now() - tagsCache.at < 60000) return tagsCache;
    try { const j: any = await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) })).json(); tagsCache = { at: Date.now(), count: (j.models || []).length, sizes: Object.fromEntries((j.models || []).map((m: any) => [m.name, m.size || 0])) }; } catch {}
    return tagsCache;
  }
  async function ollamaPs() { try { return ((await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(4000) })).json()) as any).models || []; } catch { return null; } }

  function agentsView() {
    const tasks = o.store.tasks(); const paused = existsSync(join(cfg.root, '.stopped'));
    let sleepUntil = ''; try { sleepUntil = readFileSync(join(cfg.logDir, 'main-sleep-until.txt'), 'utf8').trim(); } catch {}
    const runs = o.store.get<any[]>('recentRuns', []);
    return { agents: cfg.agents.map((a) => {
      const j = o.jobs[a] || {}; const running = o.running(a); const mins = Math.round(o.runMins(a));
      let state = running ? `running ${mins} min` : 'idle';
      if (running && mins > 9) state = `STUCK? running ${mins} min`;
      if (!running && a === 'main' && sleepUntil && new Date(sleepUntil) > new Date()) state = `resting until ${new Date(sleepUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (paused) state = 'paused';
      const task = tasks.filter((t) => t.assignee === a && (t.status === 'open' || t.status === 'stuck')).sort((x, y) => x.created.localeCompare(y.created))[0];
      const lr = runs.find((r) => r.agent === a);
      return { agent: a, state, running, model: String(j.payload?.model || '').replace(/^ollama\//, '').replace(/:latest$/, ''),
        task: task ? { id: task.id, text: task.text, status: task.status, attempts: task.attempts } : null,
        openTasks: tasks.filter((t) => t.assignee === a && t.status === 'open').length, step: '', stepAt: '', tools: [], toolCount: 0,
        lastRun: lr ? { at: new Date(lr.runAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), status: lr.status, secs: Math.round((lr.durationMs || 0) / 1000), tokIn: 0, tokOut: 0, text: String(lr.error || lr.summary || '').replace(/\s+/g, ' ').slice(0, 220) } : null };
    }) };
  }

  // Every log the Logs page can show. `mem` = kept in memory by this process (setup and Fix runs).
  type LogSource = { id: string; name: string; about: string; file?: string; mem?: () => string[]; group?: string };
  const logSources = (): LogSource[] => {
    const L = (f: string) => join(cfg.logDir, f), ocLogs = join(homedir(), '.openclaw', 'logs'), olDir = join(process.env.LOCALAPPDATA || '', 'Ollama');
    return [
      { id: 'activity', name: 'Activity', about: 'everything Orchestra does: runs, tasks, decisions, health', file: L('activity.log') },
      { id: 'dispatch', name: 'Dispatcher', about: 'each pass: who was started, posts relayed, tasks closed', file: L('dispatch.log') },
      { id: 'setup', name: 'Setup and fixes', about: 'model setup and the Fix buttons on the Setup page (this session)', mem: () => [
        ...opts.setup.progress().log,
        ...Object.entries(fixing).flatMap(([k, f]) => [`== Fix: ${k}${f.running ? ' (running)' : f.error ? ` (failed: ${f.error})` : ' (done)'}`, ...f.log]),
      ] },
      { id: 'gateway', name: 'OpenClaw gateway', about: 'the gateway the agents run in', file: newestLog(ocLogs, /\.log$/i) || join(ocLogs, 'orchestra-gateway.log') },
      { id: 'ollama', name: 'Ollama server', about: 'model loading, GPU memory, requests', file: newestLog(olDir, /^server(-\d+)?\.log$/i) || join(olDir, 'server.log') },
      { id: 'ollama-app', name: 'Ollama app', about: 'the Ollama tray app', file: newestLog(olDir, /^app(-\d+)?\.log$/i) || join(olDir, 'app.log') },
      { id: 'watchdog', name: 'Watchdog', about: 'the old PowerShell watchdog (before Orchestra)', file: L('watchdog.log') },
      { id: 'health', name: 'Health checks', about: 'the old PowerShell health check', file: L('health.log') },
      { id: 'backup', name: 'Backups', about: 'nightly backups', file: L('backup.log') },
      // One log per agent: every run of the last 7 days with its thoughts, messages, tool calls and results.
      ...cfg.agents.map((a): LogSource => ({ id: 'agent:' + a, group: 'agents', name: a === 'main' ? 'Composer' : `Worker ${a === 'worker' ? 1 : a.replace('worker', '')}`,
        about: `${a}: every run of the last 7 days, step by step`, mem: () => { try { return fresh(liveJs).agentLog(a, 7); } catch (e: any) { return [`could not read ${a}'s runs: ${e.message}`]; } } })),
    ];
  };

  const fitView = (f: any) => f && { alias: f.model.alias, tag: f.model.tag, params: f.model.params, needGB: f.needGB, vision: !!f.model.vision, note: f.model.note || '' };
  const getRoutes: Record<string, (q: URLSearchParams) => Promise<any> | any> = {
    '/api/setup/plan': async () => {
      const p = await opts.setup.plan();
      return { hardware: p.hardware, installed: p.installed, failed: p.failed,
        lineup: { capacityGB: p.lineup.capacityGB, ctx: p.lineup.ctx, cpuOnly: p.lineup.cpuOnly, warnings: p.lineup.warnings, parallelWorkers: p.lineup.parallelWorkers,
          brain: fitView(p.lineup.brain), worker: fitView(p.lineup.worker), vision: fitView(p.lineup.vision), chores: fitView(p.lineup.chores) },
        results: o.store.get('modelResults', []) };
    },
    '/api/setup/progress': () => opts.setup.progress(),
    '/api/setup/ready': async () => ({ ...((await opts.setup.ready()) ?? {}), prereqs: prereqs.plain(await prereqs.check()), fixing }),
    '/api/team': () => teamPlan(o),
    '/api/settings': async () => {
      const s = getSettings(o.store); let autonomy: string = s.autonomy;
      try { autonomy = await readAutonomy(o.gw); } catch {}
      let openclaw: Record<string, any> = {}; try { openclaw = await readAgentOptions(o.gw); } catch {}   // what OpenClaw really has per agent
      return { ...s, autonomy, startWithPc: await startWithPc(), openclaw };
    },
    '/api/library': () => libraryView(o),
    '/api/library/progress': () => opts.library.progress() ?? {},
    '/api/approvals': async () => { try { return { items: await pendingApprovals(o.gw) }; } catch (e: any) { return { items: [], error: e.message }; } },
    '/api/board': () => ({ posts: o.store.posts({ limit: 120 }).map((p) => ({ ts: p.ts, from: p.from, to: p.to, body: p.body })), mtime: o.store.lastPostId() }),
    '/api/status': async () => {
      const ps = await ollamaPs(); const g = await gpu();
      return { ollama: ps ? { up: true, models: ps.map((m: any) => ({ name: m.name, vram: m.size_vram, size: m.size, until: m.expires_at })) } : { up: false },
        gpu: g, gateway: { ok: o.gw.healthy, text: o.gw.healthy ? 'Gateway connected (in-process client)' : 'Gateway not answering' },
        cron: Object.values(o.jobs),
        // self-healing actions (health.ts logs them to activity.log): orphaned runners, Ollama / gateway restarts
        watchdog: tailLines(join(cfg.logDir, 'activity.log'), 4000).filter((l) => /\] \[(orchestra|traveler)\] /.test(l) && /orphaned model runner|not answering|-> restarting|-> starting it|gateway restart failed/i.test(l)).slice(-8).join('\n'),
        dispatch: tail(join(cfg.logDir, 'dispatch.log'), 8) };
    },
    '/api/work': () => ({ dir: cfg.workDir, files: listWork(cfg.workDir), events: o.store.get<any[]>('fileEvents', []).slice(0, 12) }),
    // Flow page: tokens the team read (input, under You) and wrote (output) today and in the last hour, from the
    // usage index (usage.ts rolls up every model call in OpenClaw's transcripts).
    '/api/flowstats': () => {
      try { opts.usage.update(); } catch {}
      const sum = (since: number) => o.store.db.prepare('SELECT coalesce(sum(input),0) input, coalesce(sum(output),0) output, coalesce(sum(calls),0) calls, coalesce(sum(tools),0) tools, coalesce(sum(runs),0) runs FROM usage_hourly WHERE hour >= ?').get(since) as any;
      const day = new Date(); day.setHours(0, 0, 0, 0);
      return { today: sum(day.getTime()), hour: sum(Math.floor((Date.now() - 3600000) / 3600000) * 3600000) };
    },
    '/api/inbox': () => ({ dir: cfg.inboxDir, files: listDir(cfg.inboxDir) }),
    '/api/running': async () => {
      const g = await gpu(); const ps = (await ollamaPs()) || [];
      const os = await import('node:os'); let diskFreeGB = 0; try { const s = (await import('node:fs')).statfsSync(cfg.root); diskFreeGB = +(s.bavail * s.bsize / 2 ** 30).toFixed(1); } catch {}
      return { gateway: o.gw.healthy, processes: [], cpu: Math.round(os.loadavg()[0] * 10) / 10, ramFreeGB: +(os.freemem() / 2 ** 30).toFixed(1), diskFreeGB, gpu: g,
        models: ps.map((m: any) => ({ name: String(m.name).replace(/:latest$/, ''), sizeGB: +(m.size / 2 ** 30).toFixed(1), gpuGB: +(m.size_vram / 2 ** 30).toFixed(1), gpuPct: m.size ? Math.round(100 * m.size_vram / m.size) : 0, ctx: m.context_length, unloadsIn: +((Date.parse(m.expires_at) - Date.now()) / 60000).toFixed(1) })) };
    },
    '/api/agents': () => agentsView(),
    '/api/chat': async () => {
      // Live chat with main through the gateway (its own session; main has its full tool set there).
      const n = o.store.get<number>('chatWindow', 1), sessionKey = chatKey(n);
      try {
        const h: any = await o.gw.rpc('chat.history', { sessionKey, limit: 80 });
        const text = (c: any) => (typeof c === 'string' ? c : (c || []).filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n')).trim();
        const messages = (h.messages || []).filter((m: any) => (m.role === 'user' || m.role === 'assistant') && text(m.content))
          .map((m: any) => ({ who: m.role === 'user' ? 'jr' : 'main', text: m.role === 'user' ? stripContext(text(m.content)) : text(m.content), at: m.timestamp || m.at || '' }));
        const fill = h.sessionInfo?.contextTokens && h.sessionInfo?.totalTokens ? h.sessionInfo.totalTokens / h.sessionInfo.contextTokens : 0;
        return { messages, busy: !!h.sessionInfo?.hasActiveRun, window: n, fill };
      } catch { return { messages: [], busy: false, window: n, fill: 0 }; }
    },
    '/api/tasks': () => {
      let clearedAt = ''; try { clearedAt = readFileSync(join(cfg.boardDir, 'tasks-cleared.txt'), 'utf8').trim(); } catch {}
      let tasks = o.store.tasks(); if (clearedAt) tasks = tasks.filter((t) => t.status === 'open' || t.status === 'stuck' || new Date(t.created) > new Date(clearedAt));
      const costs = o.store.get<Record<string, any>>('taskCosts', {});   // time / runs / tokens of finished tasks
      return { tasks: tasks.map((t) => (costs[`${t.id}|${t.created}`] ? { ...t, cost: costs[`${t.id}|${t.created}`] } : t)), paused: existsSync(join(cfg.root, '.stopped')), doneToday: o.store.doneToday() };
    },
    '/api/automations': () => ({ lines: (existsSync(join(cfg.boardDir, 'AUTOMATIONS.md')) ? readFileSync(join(cfg.boardDir, 'AUTOMATIONS.md'), 'utf8') : '').split(/\r?\n/).filter((l) => /^\s*(daily|every)\s/.test(l)) }),
    '/api/history': async () => { try { const { stdout } = await run('git', ['-C', cfg.workDir, 'log', '--pretty=format:%h|%ad|%s', '--date=format:%m-%d %H:%M', '-n', '12', '--name-only'], { windowsHide: true });
      const commits: any[] = []; let cur: any = null; for (const l of stdout.split('\n')) { const m = /^([0-9a-f]{7,})\|(.+?)\|(.*)$/.exec(l); if (m) { cur = { hash: m[1], when: m[2], msg: m[3], files: [] }; commits.push(cur); } else if (cur && l.trim()) cur.files.push(l.trim()); } return { commits }; } catch { return { commits: [] }; } },
    // Desktop notifications (desktop/main.cjs polls this): the composer's replies to jr after post id `since`.
    // Tools page > Schedules: every OpenClaw scheduled job (Orchestra's own board jobs are listed but protected)
    '/api/schedules': async () => {
      const every = (ms: number) => (ms % 86400000 === 0 ? `every ${ms / 86400000} day${ms === 86400000 ? '' : 's'}` : ms % 3600000 === 0 ? `every ${ms / 3600000} h` : `every ${Math.round(ms / 60000)} min`);
      const jobs = await o.gw.jobs();
      return { jobs: jobs.map((j: any) => {
        const s = j.schedule || {}, st = j.state || {};
        const board = /-board$/.test(String(j.name || ''));
        return { id: j.id, name: j.name, agent: j.agentId || '', enabled: j.enabled !== false, protected: board,
          when: board ? 'started by Orchestra when there is work' : s.kind === 'every' ? every(Number(s.everyMs) || 0) : s.kind === 'cron' ? `cron ${s.expr}` : s.kind || '',
          last: st.lastStatus || st.lastRunStatus || '', lastAt: st.lastRunAtMs || 0, nextAt: board ? 0 : st.nextRunAtMs || 0, errors: st.consecutiveErrors || 0, lastError: String(st.lastError || '').slice(0, 200) };
      }).sort((a: any, b: any) => Number(a.protected) - Number(b.protected) || String(a.name).localeCompare(String(b.name))) };
    },
    '/api/version': () => { let version = ''; try { version = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version || ''; } catch {} return { version }; },
    // Recipes (after goose): saved requests with {blanks}; the page fills them and posts the result to main
    '/api/recipes': () => ({ recipes: recipes() }),
    // Skills page > Team skills: jr's SKILL.md playbooks (teamskills.ts)
    '/api/teamskills': () => ({ skills: listSkills(cfg).map(({ name, description, body, mtime }) => ({ name, description, body, mtime })) }),
    // Memory page: the team's memory files (memory.ts keeps it to that fixed set)
    '/api/memory': () => ({ files: listMemory(cfg) }),
    '/api/memory/file': (q) => readMemory(cfg, String(q.get('id') || '')),
    '/api/replies': (q) => {
      const since = Number(q.get('since')) || 0, last = o.store.lastPostId();
      const replies = since ? o.store.posts({ limit: 60 }).filter((p) => p.id > since && p.to === 'jr' && /^main(-relay|-chat|-fast)?$/.test(p.from))
        .map((p) => ({ id: p.id, from: p.from, text: p.body.replace(/_\(relayed:[^)]*\)_/g, '').replace(/\s+/g, ' ').trim().slice(0, 220) })) : [];
      return { notify: getSettings(o.store).notify !== false, last, replies };
    },
    // Dashboard telemetry, polled every 2 s: live generation speed (proxy), GPU / CPU / power / temperature, what
    // fills VRAM, the loaded model, storage, and the team in numbers.
    '/api/telemetry': async (q) => {
      // GPU, CPU, power and temperature come from the background sampler (every 3 s, see sampleTelemetry)
      if (!tel.last || Date.now() - tel.last.at > 4500) await sampleTelemetry();
      const { g, cpuPct } = tel.last!;
      const [ps, tags] = await Promise.all([ollamaPs(), ollamaTags()]);
      const now = Date.now(), cpus = os.cpus();
      const GB = 2 ** 30;
      const loaded = (ps || []).map((m: any) => {
        const fileGB = (tags.sizes[m.name] || 0) / GB, vramGB = (m.size_vram || 0) / GB;
        return { name: String(m.name).replace(/:latest$/, ''), sizeGB: +((m.size || 0) / GB).toFixed(1), vramGB: +vramGB.toFixed(1), weightsGB: +Math.min(fileGB || vramGB, vramGB).toFixed(1),
          kvGB: +Math.max(0, vramGB - (fileGB || vramGB)).toFixed(1), ctx: m.context_length || 0, family: m.details?.family || '', params: m.details?.parameter_size || '', quant: m.details?.quantization_level || '',
          unloadsInMin: m.expires_at ? +((Date.parse(m.expires_at) - now) / 60000).toFixed(1) : null };
      });
      const disk = (p: string) => { try { const s = statfsSync(p); return { freeGB: +(s.bavail * s.bsize / GB).toFixed(0), totalGB: +(s.blocks * s.bsize / GB).toFixed(0) }; } catch { return null; } };
      const modelsDir = process.env.OLLAMA_MODELS || join(os.homedir(), '.ollama', 'models');
      const tasks = o.store.tasks(), today = new Date().toDateString();
      return {
        gen: liveGen(),
        gpu: g ? { ...g, usedGB: +(g.used / 1024).toFixed(1), totalGB: +(g.total / 1024).toFixed(1) } : null,
        cpu: { pct: cpuPct, cores: cpus.length, ghz: +((cpus[0]?.speed || 0) / 1000).toFixed(1), model: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim() },
        ram: { totalGB: +(os.totalmem() / GB).toFixed(1), freeGB: +(os.freemem() / GB).toFixed(1) },
        power: { watts: g?.watts || 0, whSession: +tel.wh.toFixed(2), jPerToken: g?.watts && liveGen().nowTps ? +((g.watts) / liveGen().nowTps).toFixed(1) : null },
        temp: { now: g?.temp || 0, maxSession: tel.tempMax, limit: cfg.maxTempC },
        models: { loaded, installed: tags.count },
        storage: { data: disk(cfg.root), models: disk(existsSync(modelsDir) ? modelsDir : cfg.root), sameDrive: resolve(cfg.root).slice(0, 2).toLowerCase() === resolve(modelsDir).slice(0, 2).toLowerCase() },
        team: { working: cfg.agents.filter((a) => o.running(a)), agents: cfg.agents.length, open: tasks.filter((t) => t.status === 'open').length, stuck: tasks.filter((t) => t.status === 'stuck').length,
          doneToday: o.store.doneToday() },
        at: now,
        ...(q.get('hist') ? { hist: tel.hist } : {}),   // the last 15 min, so a freshly opened page has full charts
      };
    },
    // Settings > Light mode: on or off right now, and why (light.ts)
    '/api/light': (q) => lightStatus(o, !!q.get('fresh')),
    // Metrics > Storage: every drive (used / free) and what Orchestra itself takes: the models, its data folders and
    // OpenClaw's state. Folder sizes are walked in the background and cached for 5 min (?fresh=1 re-measures).
    '/api/storage': async (q) => {
      if (q.get('fresh') || !store.at || Date.now() - store.at > 5 * 60000) { if (!store.busy) store.busy = measureStorage().finally(() => { store.busy = null; }); await store.busy; }
      return { drives: drives(), parts: store.parts, at: store.at };
    },
    // Tools page: OpenClaw's tool groups and which agent has each (from the agents' jobs), MCP servers with their
    // tools (from the last test), OpenClaw skills (?skills=1, slower) and the user's own command tools.
    '/api/tools/catalog': async (q) => {
      let jobs: any[] = []; try { jobs = await o.gw.jobs(); } catch {}
      const allow = (a: string) => new Set<string>(jobs.find((j) => j.name === `${a}-board`)?.payload?.toolsAllow || []);
      const specs = agentSpecs({ ...cfg, extraTools: {} } as any);   // the built-in tools, to tell base from extra
      const groups = Object.entries(cfg.toolGroups).map(([name, list]) => {
        const tools = list.split(',');
        return { name, about: TOOL_ABOUT[name] || '', tools, agents: cfg.agents.map((a) => ({ agent: a, on: tools.every((t) => allow(a).has(t)), builtIn: tools.every((t) => specs[a]?.tools.includes(t)) })) };
      });
      let servers: Record<string, any> = {}; try { servers = ((await o.gw.rpc('config.get', {})) as any).sourceConfig?.mcp?.servers || {}; } catch {}
      const seen = o.store.get<Record<string, { tools: string[]; at: string }>>('mcpTools', {});
      const mcp = Object.keys(servers).map((n) => ({ name: n, access: cfg.mcp[n] || 'workers', tools: seen[n]?.tools || null, testedAt: seen[n]?.at || '' }));
      let skills: any[] | null = null;
      if (q.get('skills')) {
        const c = o.store.get<{ at: number; list: any[] } | null>('skillsCache', null);
        if (c && Date.now() - c.at < 10 * 60000 && !q.get('fresh')) skills = c.list;
        else {
          const r = await prereqs.openclaw(['skills', 'list', '--agent', 'worker', '--json'], 90000);
          try { const j = JSON.parse(String(r.out).slice(String(r.out).indexOf('{'))); skills = (j.skills || []).map((s: any) => ({ name: s.name, emoji: s.emoji || '', about: s.description || '', ready: !!s.eligible, disabled: !!s.disabled, missing: Object.entries(s.missing || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · '), homepage: s.homepage || '' })); o.store.set('skillsCache', { at: Date.now(), list: skills }); } catch { skills = []; }
        }
      }
      return { agents: cfg.agents, groups, mcp, skills, custom: cfg.customTools };
    },
    // The stored result of the automatic check (every 30 min, see healthLoop); ?refresh=1 runs it now.
    '/api/health': async (q) => {
      const last = o.store.get<any>('healthLast', null);
      // reuse only a result from this run of the service (an old one can describe a gateway that has since restarted)
      if (!q?.get?.('refresh') && last && Date.parse(last.ranAt) > SERVICE_STARTED && Date.now() - Date.parse(last.ranAt) < HEALTH_EVERY_MS) return last;
      return runHealth('manual');
    },
    // Logs page: a fixed list of sources (never a path from the page), each tailed from its end.
    '/api/logs': () => ({ sources: logSources().map(({ id, name, about, file, mem, group }) => {
      let size = 0, mtime = 0; if (file) { try { const s = statSync(file); size = s.size; mtime = s.mtimeMs; } catch {} }
      return { id, name, about, group: group || 'system', file: file || '', size, mtime, live: !!mem || !!file && existsSync(file) };
    }) }),
    '/api/logs/tail': (q) => {
      const src = logSources().find((s) => s.id === q.get('src')); if (!src) throw new Error('unknown log');
      const n = Math.min(5000, Math.max(50, Number(q.get('n')) || 1000));
      const lines = src.mem ? src.mem().slice(-n) : src.file ? tailLines(src.file, n) : [];
      let size = 0; if (src.file) { try { size = statSync(src.file).size; } catch {} }
      return { id: src.id, file: src.file || '', size, lines };
    },
    // MCP servers (Settings): saved in OpenClaw's own mcp.servers; secrets are never sent back to the page.
    '/api/mcp': async () => {
      const c: any = await o.gw.rpc('config.get', {}).catch(() => null);
      if (!c) throw new Error('the OpenClaw gateway is not running (Setup page: Start)');
      const servers = c.sourceConfig?.mcp?.servers || {};
      return { servers: Object.entries(servers).map(([name, s]: [string, any]) => ({
        name, transport: s.transport || (s.url ? 'streamable-http' : 'stdio'), command: s.command || '', args: s.args || [], url: s.url || '',
        enabled: s.enabled !== false, envKeys: Object.keys(s.env || {}), headerKeys: Object.keys(s.headers || {}), oauth: s.auth === 'oauth',
        access: cfg.mcp[name] || 'none' })) };
    },    '/api/activity': () => ({ lines: tail(join(cfg.logDir, 'activity.log'), 40).split('\n').map((l) => { const m = /^\[(.+?) (\d\d:\d\d:\d\d)\] \[(.+?)\] (.*)$/.exec(l); return m ? { time: m[2], event: m[3], agent: '', detail: m[4] } : null; }).filter(Boolean) }),
    // Agent details page: every run of the last day, untruncated.
    '/api/details': (q) => { try { return fresh(liveJs).getLive(Math.min(7 * 1440, Math.max(10, Number(q.get('minutes')) || 1440)), { full: true }); } catch (e) { return { cards: [], error: String(e) }; } },
    '/api/live': () => {
      const live: any = (() => { try { return fresh(liveJs).getLive(30); } catch (e) { return { cards: [], error: String(e) }; } })();
      const cutoff = Date.now() - 30 * 60000;
      live.messages = o.store.posts({ limit: 60 }).filter((p: any) => p.from !== 'jr' && p.at >= cutoff).slice(-15).map((p) => ({ ts: p.ts, from: p.from, to: p.to, text: p.body.slice(0, 600) }));
      live.decisions = tail(join(cfg.logDir, 'dispatch.log'), 200).split(/\r?\n/).filter((l) => /task T\d+ (for|done|cancelled)|model for|tools for|starting (main|worker)|stopped|aborted|stuck|rejected|archived|helper mirror|relayed/.test(l)).slice(-14).reverse();
      return live;
    },
    // Metrics: ?range=1h|6h|1d|7d|30d|60d|all. Short ranges read the raw transcripts (5-10 min buckets); longer ones the
    // hourly usage index, which keeps history after OpenClaw prunes its transcripts.
    '/api/metrics': (q) => {
      const range = q.get('range') || ({ 1: '1h', 6: '6h', 24: '1d', 72: '7d' } as Record<string, string>)[q.get('hours') || ''] || '6h';
      if (range === '1h' || range === '6h') {
        const h = range === '1h' ? 1 : 6; const m = fresh(metricsJs).getMetrics(h, h === 1 ? 5 : 10);
        const idx = opts.usage.report(range);   // same buckets; work counts are exact, agent totals to the hour
        const work = new Map(idx.buckets.map((b: any) => [b.t, b]));
        return { ...idx, buckets: m.buckets.map((b: any) => ({ ...b, tasksDone: work.get(b.t)?.tasksDone || 0, posts: work.get(b.t)?.posts || 0, runs: work.get(b.t)?.runs || 0, tools: work.get(b.t)?.tools || 0, errors: work.get(b.t)?.errors || 0 })),
          speed: m.speed, gpu: m.gpu, totals: { ...idx.totals, calls: m.totals.calls, input: m.totals.input, output: m.totals.output }, scope: 'raw' };
      }
      return opts.usage.report(range);
    },
    '/api/models': async () => {
      let tags: any[] = []; try { tags = ((await (await fetch('http://127.0.0.1:11434/api/tags')).json()) as any).models || []; } catch {}
      const picks = o.store.get<any>('picks', { models: {} }); let brain = ''; try { brain = readFileSync(join(cfg.root, 'models', 'brain-model.txt'), 'utf8').trim(); } catch {}
      return { models: Object.entries(cfg.aliases).map(([alias, model]) => {
        const t = tags.find((x) => 'ollama/' + x.name === model);
        const usedBy = cfg.workers.filter((w) => (picks.models?.[w] || 'fast') === alias); if (model === brain) usedBy.unshift('main');
        return { alias, model: model.replace(/^ollama\/|:latest$/g, ''), use: MODEL_GUIDE[alias] || '', sizeGB: t ? +(t.size / 2 ** 30).toFixed(1) : null, usedBy };
      }) };
    },
  };

  async function body(req: IncomingMessage, max = 1e6): Promise<any> { let raw = ''; for await (const c of req) { raw += c; if (raw.length > max) throw new Error('too large'); } return raw ? JSON.parse(raw) : {}; }

  // One team sync at a time; clicks while one runs collapse into a single follow-up sync to the final size
  // (seen: + + - - in two seconds ran four overlapping syncs -> a config conflict and a half-made worker).
  let teamSyncing = false, teamSyncAgain = false;
  function queueTeamSync() {
    if (teamSyncing) { teamSyncAgain = true; return; }
    teamSyncing = true;
    setTimeout(async () => {
      try {
        do {
          teamSyncAgain = false;
          await syncTeam(cfg, o.gw, join(import.meta.dirname, '..', 'plugin'), (m) => o.log(m));
          await applyAgentOptions(o.store, o.gw, (m) => o.log(m));   // new workers get Settings > OpenClaw too
          o.store.set('agentSpecVersion', `${AGENT_SPEC_VERSION}:${cfg.workers.join(',')}`);
        } while (teamSyncAgain);
        o.log(`team in sync (${cfg.workers.join(', ')})`);
      } catch (e: any) { o.log(`team sync failed (${String(e.message).split('\n')[0]}); the health check retries it`); }
      finally { teamSyncing = false; }
    }, 1500);   // settle a burst of clicks first
  }
  const postRoutes: Record<string, (b: any) => Promise<any> | any> = {
    '/api/settings': async (b) => {
      const patch: any = {};
      for (const k of ['autonomy', 'workers', 'workerCount', 'parallel', 'ctx', 'notify', 'modelKinds', 'thinking', 'lightContext', 'runMinutes', 'interpret', 'learn', 'review', 'kvCache', 'fastPath', 'light']) if (b[k] !== undefined) patch[k] = b[k];
      const before = cfg.workers.length;
      const s = await saveSettings(o.store, o.gw, patch, (m) => o.log(m));
      let note = '';
      if (s.workerCount !== before) {
        // Team size changed: resize in place, then create agents/jobs for new workers in the background.
        applyTeamSize(cfg, s.workerCount); o.log(`team size: ${s.workerCount} worker(s) (${cfg.workers.join(', ')})`);
        queueTeamSync();
        note = s.workerCount > before ? `Adding ${s.workerCount - before} worker(s): their agents are being created in OpenClaw.` : 'Extra workers are switched off (nothing deleted).';
      }
      const start = b.startWithPc !== undefined ? await startWithPc(!!b.startWithPc) : await startWithPc();
      return { ok: true, settings: { ...s, startWithPc: start }, note };
    },
    '/api/team/ollama-parallel': (b) => setOllamaParallel(o, Number(b.n)),
    '/api/library/install': async (b) => { await opts.library.install(String(b.alias)); return { ok: true, msg: 'installing' }; },
    '/api/library/role': (b) => opts.library.assign(String(b.role), String(b.alias)),
    '/api/library/custom': (b) => opts.library.addCustom(String(b.tag || '')),
    '/api/library/custom/remove': (b) => opts.library.removeCustom(String(b.alias)),
    '/api/approvals/resolve': async (b) => {
      const d = String(b.decision); if (!['allow-once', 'allow-always', 'deny'].includes(d)) throw new Error('decision must be allow-once, allow-always or deny');
      await resolveApproval(o.gw, String(b.id), d as any); o.log(`shell approval ${b.id}: ${d} (dashboard)`); return { ok: true };
    },
    // Fix one item from the Setup page's requirements list (install, start, or 'team' = agents + jobs + plugin), or
    // 'all' = every missing item in order. Runs in the background; the page re-checks and shows progress.
    '/api/setup/fix': async (b) => {
      const id = String(b.id || ''), mainFrom = b.mainFrom ? String(b.mainFrom) : undefined;
      if (fixing[id]?.running || fixing.all?.running) return { ok: true, msg: 'Already working on it' };
      // No "main" in OpenClaw but the user has agents of their own: ask (new, or base it on one of theirs) - never guess.
      if (id === 'team' || id === 'all') {
        const r0: any = await opts.setup.ready();
        if (r0?.missing?.includes('agent:main') && r0.others?.length && !mainFrom) return { ok: false, needMain: true, others: r0.others, msg: 'OpenClaw has no "main" agent: create a new one, or use one of yours?' };
      }
      const f = fixing[id] = { running: true, log: [] as string[] };
      const log = (l: string) => { f.log.push(String(l).slice(0, 300)); if (f.log.length > 200) f.log.shift(); };
      // The team lives in OpenClaw: needs the gateway, then setup (model lineup download + test + agents/jobs/plugin).
      const team = async () => {
        await prereqs.startGateway(log);
        const teamMissing = (r: any) => (r?.missing || []).filter((m: string) => /^(agent|job|plugin|provider|toolsearch|aliases)/.test(m));
        let r: any = await opts.setup.ready();
        if (!teamMissing(r).length) { log('team already complete'); return; }
        opts.setup.mainFrom = mainFrom;
        // Models already chosen (a board job exists): repair the agents, jobs and plugin directly, no model setup.
        if (r.jobs?.length) {
          log(`repairing the team in OpenClaw (${teamMissing(r).join(', ')})`);
          try { await syncTeam(cfg, o.gw, join(import.meta.dirname, '..', 'plugin'), log, { mainFrom }); await applyAgentOptions(o.store, o.gw, log); } catch (e: any) { log(`repair: ${e.message}`); }
          try { const js = await o.gw.jobs(); const jm = (n: string) => js.find((j: any) => j.name === n)?.payload?.model; await reconcileAliases(cfg, { brain: jm('main-board'), worker: jm('worker-board') }, log); } catch (e: any) { log(`aliases: ${e.message}`); }
          r = await opts.setup.ready();
          if (!teamMissing(r).length) { log('team repaired'); return; }
        }
        log('running setup: model lineup, tool test, then the agents, their jobs and the team tools plugin');
        await opts.setup.run(); const p = opts.setup.progress(); if (p.error) throw new Error(p.error);
        const left = teamMissing(await opts.setup.ready()); if (left.length) throw new Error(`still missing after setup: ${left.join(', ')}`);
      };
      let job: () => Promise<void>, label: string;
      if (id === 'team') { job = team; label = 'Creating the team (runs setup)'; }
      else if (id === 'all') {
        label = 'Fixing everything that is missing';
        job = async () => {
          const errs: string[] = [];
          for (const it of (await prereqs.check()).filter((i: any) => !i.ok)) {
            log(`== ${it.name}`);
            try { await it.fix(log); } catch (e: any) { errs.push(`${it.name}: ${e.message}`); log(`!! ${e.message}`); }
          }
          try { log('== Team'); await team(); } catch (e: any) { errs.push(`Team: ${e.message}`); log(`!! ${e.message}`); }
          if (errs.length) throw new Error(errs.join('; '));
        };
      } else {
        const it = (await prereqs.check()).find((i: any) => i.id === id);
        if (!it) { delete fixing[id]; throw new Error('unknown item'); }
        if (it.ok) { delete fixing[id]; return { ok: true, msg: `${it.name} is already ${it.action === 'start' ? 'running' : 'installed'}` }; }
        job = () => it.fix(log); label = `${it.action === 'start' ? 'Starting' : 'Installing'} ${it.name}`;
      }
      job().then(() => { f.running = false; o.log(`setup: ${label} - done (dashboard)`); })
        .catch((e: any) => { f.running = false; f.error = String(e?.message || e); o.log(`setup: ${label} - failed: ${f.error}`); });
      return { ok: true, msg: `${label}…` };
    },
    '/api/mcp/save': async (b) => {
      const name = String(b.name || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{1,40}$/.test(name)) throw new Error('name: lowercase letters, digits and _ only (it prefixes the tool names, e.g. github__list_issues)');
      const transport = String(b.transport || 'stdio');
      if (!['stdio', 'sse', 'streamable-http'].includes(transport)) throw new Error('transport must be stdio, sse or streamable-http');
      const access = (['workers', 'all', 'none'].includes(String(b.access)) ? String(b.access) : 'workers') as McpAccess;
      const cur: any = await o.gw.rpc('config.get', {}); const old = cur.sourceConfig?.mcp?.servers?.[name] || {};
      // KEY=VALUE (env) or "Name: value" (headers) lines; a blank value keeps the saved one (secrets are not shown again)
      const pairs = (text: unknown, sep: RegExp, prev: Record<string, any> = {}) => {
        const out: Record<string, string> = {};
        for (const line of String(text || '').split(/\r?\n/)) { const m = sep.exec(line.trim()); if (!m) continue; const k = m[1].trim(), v = m[2].trim(); if (k) out[k] = v || String(prev[k] ?? ''); }
        return out;
      };
      const def: any = { enabled: b.enabled !== false, transport };
      if (transport === 'stdio') {
        const command = String(b.command || '').trim(); if (!command) throw new Error('enter the command that starts the server (e.g. npx, uvx, node)');
        def.command = command;
        def.args = [...String(b.args || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
        const env = pairs(b.env, /^([^=]+)=(.*)$/, old.env); if (Object.keys(env).length) def.env = env;
        if (b.cwd) def.cwd = String(b.cwd);
      } else {
        const url = String(b.url || '').trim(); if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('enter the server URL (https://...)');
        def.url = url;
        const headers = pairs(b.headers, /^([^:]+):(.*)$/, old.headers); if (Object.keys(headers).length) def.headers = headers;
        if (old.auth) { def.auth = old.auth; if (old.oauth) def.oauth = old.oauth; }
      }
      // OpenClaw only replaces an array (args) when its exact path is named; a merge would keep old args
      const arrays = ['args'].filter((k) => Array.isArray(old[k]) || Array.isArray(def[k])).map((k) => `mcp.servers.${name}.${k}`);
      await o.gw.rpc('config.patch', { raw: JSON.stringify({ mcp: { servers: { [name]: def } } }), replacePaths: [`mcp.servers.${name}`, ...arrays], baseHash: cur.hash });
      cfg.mcp[name] = access; o.store.set('mcpAccess', cfg.mcp);
      let note = '';
      try { await applyAgentSpecs(cfg, o.gw, (m) => o.log(m)); } catch (e: any) { note = ` (agent tool lists not updated yet: ${e.message.slice(0, 120)})`; }
      o.log(`mcp: saved server ${name} (${transport}, tools for ${access})`);
      // list its tools right away (Tools page shows them in the server's own row), without making the save wait
      postRoutes['/api/mcp/test']({ name }).then((t: any) => o.log(`mcp: ${name} ${t.ok ? `connected, ${(t.tools || []).length} tool(s)` : `did not connect: ${String(t.msg).slice(0, 160)}`}`)).catch(() => {});
      return { ok: true, msg: `Saved ${name}. ${access === 'none' ? 'No agent uses it yet.' : access === 'all' ? 'The composer and the workers can use its tools.' : 'The workers can use its tools.'} Its tools are being listed (Tools page).${note}` };
    },
    '/api/mcp/remove': async (b) => {
      const name = String(b.name || ''); const cur: any = await o.gw.rpc('config.get', {});
      if (!cur.sourceConfig?.mcp?.servers?.[name]) throw new Error(`no MCP server called ${name}`);
      // a merge patch deletes a key only when it is set to null
      const arrays = Object.keys(cur.sourceConfig.mcp.servers[name]).filter((k) => Array.isArray(cur.sourceConfig.mcp.servers[name][k])).map((k) => `mcp.servers.${name}.${k}`);
      await o.gw.rpc('config.patch', { raw: JSON.stringify({ mcp: { servers: { [name]: null } } }), replacePaths: [`mcp.servers.${name}`, ...arrays], baseHash: cur.hash });
      const after: any = await o.gw.rpc('config.get', {});
      if (after.sourceConfig?.mcp?.servers?.[name]) throw new Error(`OpenClaw kept ${name}; remove it in the OpenClaw Control UI (MCP page)`);
      delete cfg.mcp[name]; o.store.set('mcpAccess', cfg.mcp);
      try { await applyAgentSpecs(cfg, o.gw, (m) => o.log(m)); } catch {}
      o.log(`mcp: removed server ${name}`);
      return { ok: true, msg: `Removed ${name}.` };
    },
    // Live check through OpenClaw itself (it starts / connects to the server and lists its tools).
    '/api/mcp/test': async (b) => {
      const name = String(b.name || ''); if (!/^[a-z0-9_]{1,40}$/.test(name)) throw new Error('unknown server');
      const r = await prereqs.openclaw(['mcp', 'probe', name, '--json'], 90000);
      let j: any = null; try { j = JSON.parse(String(r.out).slice(String(r.out).indexOf('{'))); } catch {}
      if (!j) return { ok: false, msg: `Test failed: ${String(r.out).trim().split('\n').pop()?.slice(0, 200) || 'no answer'}` };
      if (j.ok === false) return { ok: false, msg: `Test failed: ${j.error?.message || 'error'}` };
      const s = j.servers?.[name]; const diag = (j.diagnostics || []).map((d: any) => d.message || String(d)).join('; ');
      if (!s || r.code !== 0 && !s.tools) return { ok: false, msg: `Did not connect${diag ? `: ${diag.slice(0, 300)}` : ''}` };
      const tools = (j.tools || []).slice(0, 200).map((t: any) => (typeof t === 'string' ? t : t?.name || String(t)));
      o.store.set('mcpTools', { ...o.store.get<Record<string, any>>('mcpTools', {}), [name]: { tools, at: new Date().toISOString() } });   // Tools page shows them
      return { ok: true, msg: `Connected: ${s.tools} tool(s)${s.resources ? ', resources' : ''}${s.prompts ? ', prompts' : ''}.${diag ? ` Notes: ${diag.slice(0, 200)}` : ''}`, tools: tools.slice(0, 50) };
    },
    '/api/schedules/toggle': async (b) => {
      const j = (await o.gw.jobs()).find((x: any) => x.id === String(b.id || '')); if (!j) throw new Error('no such job');
      if (/-board$/.test(String(j.name || ''))) throw new Error(`${j.name} is how Orchestra starts ${j.agentId}: switching it off would stop that agent`);
      // system-owned: OpenClaw refuses to edit these jobs; they follow its skill workshop setting (all agents at once)
      if (/^skill-collection-review-/.test(String(j.name || ''))) {
        await setSkillWorkshop(o.gw, !!b.enabled, (m) => o.log(m)); act(`skill review jobs ${b.enabled ? 'on' : 'off'}`);
        return { ok: true, msg: `Skill review jobs ${b.enabled ? 'switched on' : 'switched off'} for every agent (OpenClaw runs them from one setting).` };
      }
      await o.gw.updateJob(j.id, { enabled: !!b.enabled }); act(`schedule ${j.name} ${b.enabled ? 'on' : 'off'}`);
      return { ok: true, msg: `${j.name} ${b.enabled ? 'switched on' : 'switched off'}.` };
    },
    '/api/schedules/run': async (b) => {
      const j = (await o.gw.jobs()).find((x: any) => x.id === String(b.id || '')); if (!j) throw new Error('no such job');
      if (/-board$/.test(String(j.name || ''))) throw new Error('Orchestra starts its own agents: use Wake composer, or post a request');
      await o.gw.runJob(j.id); act(`schedule ${j.name}: run now`);
      return { ok: true, msg: `${j.name} started.` };
    },
    // Review gate: jr approves a finished task (it becomes done and main reports it) or sends it back with a comment
    '/api/tasks/review': (b) => {
      const tasks = o.store.tasks(); const t = tasks.find((x) => x.id === String(b.id || '')); if (!t) throw new Error('no such task');
      if ((t.status as string) !== 'review') throw new Error(`${t.id} is not waiting for review`);
      const now = new Date().toISOString();
      if (b.approve) { t.status = 'done'; t.updated = now; o.store.saveTasks(tasks); act(`review: approved ${t.id}`); o.log(`task ${t.id}: approved by jr`); opts.soon(); return { ok: true, msg: `${t.id} approved.` }; }
      const comment = String(b.comment || '').trim(); if (comment.length < 3) throw new Error('say what to change');
      t.status = 'open'; t.updated = now; o.store.saveTasks(tasks);
      o.store.addPost('jr', t.assignee, `Changes needed on ${t.id}: ${comment}\nFix exactly this, then team_done ${t.id} again.`, { source: 'review' });
      act(`review: changes requested on ${t.id}`); o.log(`task ${t.id}: jr requested changes - back to ${t.assignee}`); opts.soon();
      return { ok: true, msg: `${t.id} sent back to ${t.assignee}.` };
    },
    '/api/recipes/save': (b) => {
      const name = String(b.name || '').trim().slice(0, 60), template = String(b.template || '').trim().slice(0, 2000);
      if (!name || template.length < 10) throw new Error('give the recipe a name and the request text (use {blanks} for what changes each time)');
      o.store.set('recipes', [...recipes().filter((r) => r.name !== name && r.name !== b.old), { name, template }]);
      return { ok: true, msg: `Saved recipe ${name}.` };
    },
    '/api/recipes/remove': (b) => { o.store.set('recipes', recipes().filter((r) => r.name !== String(b.name || ''))); return { ok: true, msg: `Removed recipe ${b.name}.` }; },
    '/api/recipes/run': (b) => {
      const r = recipes().find((x) => x.name === String(b.name || '')); if (!r) throw new Error('no such recipe');
      const values = (b.values || {}) as Record<string, string>; const missing: string[] = [];
      const text = r.template.replace(/\{([\w ]{1,30})\}/g, (_m, k) => { const v = String(values[k] ?? '').trim(); if (!v) missing.push(k); return v; });
      if (missing.length) throw new Error(`fill in: ${missing.join(', ')}`);
      post('main', text); act(`recipe "${r.name}" sent to main`);
      return { ok: true, msg: `Sent to the composer: ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}` };
    },
    '/api/work/restore': async (b) => { const msg = await restoreWork(cfg.workDir, String(b.path || '')); act(`work folder: ${msg}`); return { ok: true, msg }; },
    '/api/teamskills/save': (b) => { const r = saveSkill(cfg, { name: String(b.name || ''), description: String(b.description || ''), body: String(b.body || ''), old: b.old ? String(b.old) : undefined }); act(`skill saved: ${r.name}`); return r; },
    '/api/teamskills/remove': (b) => { const r = removeSkill(cfg, String(b.name || '')); act(`skill removed: ${b.name}`); return r; },
    '/api/memory/save': (b) => { const r = saveMemory(cfg, String(b.id || ''), String(b.text ?? '')); act(`memory: saved ${b.id}`); return r; },
    // Tools page > Agent tools: switch an OpenClaw tool group on or off for one agent (built-in ones stay on).
    '/api/tools/agent': async (b) => {
      const agent = String(b.agent || ''), group = String(b.group || ''), on = !!b.on;
      if (!cfg.agents.includes(agent)) throw new Error('unknown agent'); if (!cfg.toolGroups[group]) throw new Error('unknown tool group');
      const base = agentSpecs({ ...cfg, extraTools: {} } as any)[agent]?.tools || [];
      if (!on && cfg.toolGroups[group].split(',').every((t) => base.includes(t))) throw new Error(`${group} is built into ${agent}'s role and stays on`);
      if (agent === 'main' && on && ['shell', 'files', 'web', 'browser'].includes(group)) throw new Error('main plans and delegates; give this to a worker instead (main with its own hands stops delegating)');
      const cur = new Set(cfg.extraTools[agent] || []); if (on) cur.add(group); else cur.delete(group);
      cfg.extraTools = { ...cfg.extraTools, [agent]: [...cur] }; o.store.set('extraTools', cfg.extraTools);
      await applyAgentSpecs(cfg, o.gw, (m) => o.log(m));
      o.log(`tools: ${group} ${on ? 'on' : 'off'} for ${agent}`);
      return { ok: true, msg: `${group} ${on ? 'given to' : 'taken from'} ${agent}.` };
    },
    // Tools page > your own tools: a named command. {input} is passed through an environment variable, never pasted
    // into the command line, so what you type cannot change the command.
    '/api/tools/custom/save': async (b) => {
      const name = String(b.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40), about = String(b.about || '').trim().slice(0, 200), command = String(b.command || '').trim().slice(0, 2000);
      if (!name || !command) throw new Error('give the tool a name and a command');
      cfg.customTools = [...cfg.customTools.filter((t) => t.name !== name), { name, about: about || name, command, agents: !!b.agents }];
      o.store.set('customTools', cfg.customTools);
      if (cfg.customTools.some((t) => t.agents) || b.agents !== undefined) { try { await applyAgentSpecs(cfg, o.gw, (m) => o.log(m)); } catch {} }
      o.log(`tools: saved your tool "${name}"${b.agents ? ' (workers can use it)' : ''}`);
      return { ok: true, msg: `Saved ${name}.` };
    },
    '/api/tools/custom/remove': async (b) => {
      const name = String(b.name || ''); const had = cfg.customTools.find((t) => t.name === name); if (!had) throw new Error('no such tool');
      cfg.customTools = cfg.customTools.filter((t) => t.name !== name); o.store.set('customTools', cfg.customTools);
      if (had.agents) { try { await applyAgentSpecs(cfg, o.gw, (m) => o.log(m)); } catch {} }
      return { ok: true, msg: `Removed ${name}.` };
    },
    '/api/tools/custom/run': async (b) => {
      const t = cfg.customTools.find((x) => x.name === String(b.name || '')); if (!t) throw new Error('no such tool');
      const win = process.platform === 'win32';
      const cmd = t.command.replace(/\{input\}/g, win ? '$env:ORCH_INPUT' : '"$ORCH_INPUT"');
      const [exe, args] = win ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd]] : ['/bin/sh', ['-c', cmd]];
      const t0 = Date.now();
      try {
        const { stdout, stderr } = await run(exe, args as string[], { cwd: cfg.workDir, timeout: 120000, maxBuffer: 8 << 20, env: { ...process.env, ORCH_INPUT: String(b.input ?? '') }, windowsHide: true });
        act(`ran your tool ${t.name}`);
        return { ok: true, output: (String(stdout) + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(0, 30000) || '(no output)', ms: Date.now() - t0 };
      } catch (e: any) { return { ok: false, output: `${String(e.stdout || '')}${e.stderr ? `\n[stderr]\n${e.stderr}` : ''}\n[exit ${e.code ?? '?'}] ${e.killed ? 'timed out after 2 min' : ''}`.trim().slice(0, 30000), ms: Date.now() - t0 }; }
    },    '/api/setup/run': () => { if (opts.setup.running) return { ok: true, msg: 'setup is already running' }; opts.setup.run().catch(() => {}); return { ok: true, msg: 'setup started' }; },
    '/api/post': (b) => {
      const text = String(b.text || '').trim(); if (!text) throw new Error('empty');
      // A post while paused means jr wants an answer: resume instead of leaving it unanswered (Pause survives restarts).
      const stopped = join(cfg.root, '.stopped'), wasPaused = existsSync(stopped);
      if (wasPaused) { try { unlinkSync(stopped); } catch {} act('team resumed by a post'); }
      post(String(b.to || 'all'), text); act(`jr posted to ${b.to || 'all'}`);
      return { ok: true, msg: wasPaused ? 'The team was paused, so it has been resumed to answer you.' : '' };
    },
    '/api/link': (b) => {
      const t = String(b.url || '').trim(); if (!/^(https?:\/\/\S+|[a-zA-Z]:\\.+)$/.test(t)) throw new Error('enter an http(s) link or a full Windows path like C:\\folder\\file');
      post(String(b.to || 'all'), (/^https?:/.test(t) ? `Please fetch this link: ${t}\nIf it is a file, download it into ${cfg.inboxDir}; if it is a page, read it.` : `Please look at this file or folder on my computer: ${t}`) + (b.note ? '\n' + String(b.note).slice(0, 2000) : ''));
      return { ok: true };
    },
    '/api/control': async (b) => {
      const a = String(b.action || '');
      if (a === 'wake') { writeFileSync(join(cfg.logDir, 'wake-main.flag'), new Date().toISOString()); try { unlinkSync(join(cfg.logDir, 'main-sleep-until.txt')); } catch {} opts.soon(); return { ok: true, msg: 'main starts within seconds' }; }
      if (a === 'pause') { writeFileSync(join(cfg.root, '.stopped'), new Date().toISOString()); await unloadModels(); return { ok: true, msg: 'Paused. No new agent runs; GPU freed.' }; }
      if (a === 'resume') { try { unlinkSync(join(cfg.root, '.stopped')); } catch {} opts.soon(); return { ok: true, msg: 'Resumed. main starts within seconds.' }; }
      if (a === 'unload') { await unloadModels(); return { ok: true, msg: 'Models unloaded (they reload when an agent runs).' }; }
      throw new Error('unknown action');
    },
    '/api/automation': (b) => {
      const line = String(b.line || '').trim();
      if (!/^(daily\s+\d{1,2}:\d{2}|every\s+\d+\s*[mh])\s+(main|worker[2-8]?)\s*:\s*.{5,400}$/.test(line)) throw new Error('Format: "daily 09:00 main: ..." or "every 6h worker: ..."');
      appendFileSync(join(cfg.boardDir, 'AUTOMATIONS.md'), `\n${line}\n`); return { ok: true };
    },
    '/api/run': async (b) => { const a = String(b.agent || ''); const j = o.jobs[a]; if (!j) throw new Error('unknown agent'); await o.gw.runJob(j.id); o.log(`manual run ${a} (dashboard)`); return { ok: true }; },
    '/api/model': (b) => {
      const w = String(b.agent || ''), alias = String(b.alias || '').toLowerCase();
      if (!cfg.workers.includes(w) || !cfg.aliases[alias]) throw new Error('pick a worker and a listed model');
      post(w, `MODEL ${w}=${alias}`); return { ok: true, msg: `${w} will use ${alias} from its next run.` };
    },
    '/api/tasks/clear': async (b) => {
      const live = o.store.tasks().filter((t) => t.status === 'open' || t.status === 'stuck');
      if (live.length) post('all', 'Clearing the task list. Stop working on these:\n' + live.map((t) => `CANCEL ${t.id}`).join('\n'));
      writeFileSync(join(cfg.boardDir, 'tasks-cleared.txt'), new Date().toISOString());
      if (b.stopWorkers) for (const w of cfg.workers) await o.stopAgent(w);
      return { ok: true, msg: `Cleared. ${live.length} open task(s) cancelled.` };
    },
    '/api/tool': async (b) => {
      const tool = String(b.tool || ''), arg = String(b.arg || '').trim();
      const inRoots = (p: string) => [cfg.workDir, cfg.inboxDir].some((d) => p.toLowerCase().startsWith(d.toLowerCase() + '\\')) && !/[<>"|?*]/.test(p.slice(2)) && !/\.\.|\\\.(git|trash)\\/i.test(p);
      if (tool === 'pdf' && inRoots(arg) && /\.(md|markdown|txt|html?)$/i.test(arg)) {
        // plain Node even inside the desktop app (execPath is electron.exe there)
        const { stdout } = await run(process.execPath, [join(import.meta.dirname, '..', 'lib', 'md2pdf.cjs'), arg], { timeout: 120000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        return { ok: true, output: stdout.trim() };
      }
      if (tool === 'download' && /^https?:\/\/[^\s"]+$/i.test(arg)) {
        const r = await fetch(arg, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
        const name = basename(new URL(arg).pathname) || `download-${Date.now()}`; const dest = join(cfg.inboxDir, name.replace(/[<>:"/\\|?*]/g, '_'));
        writeFileSync(dest, Buffer.from(await r.arrayBuffer())); return { ok: true, output: `downloaded ${Math.round(statSync(dest).size / 1024)} KB to ${dest}` };
      }
      if (tool === 'screenshot' && /^https?:\/\/[^\s"]+$/i.test(arg)) {
        const edge = require(join(import.meta.dirname, '..', 'lib', 'browser.cjs')).findBrowser();
        if (!edge) throw new Error('no Chromium-based browser found (install Microsoft Edge, Google Chrome or Chromium)');
        const out = join(cfg.workDir, `shot-${Date.now()}.png`), prof = join(cfg.root, 'orchestra', `shot-${Date.now()}`);
        await run(edge, ['--headless', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${prof}`, '--window-size=1440,1000', '--virtual-time-budget=8000', `--screenshot=${out}`, arg], { timeout: 90000 }).catch(() => {});
        return existsSync(out) ? { ok: true, output: `screenshot saved: ${out}` } : { ok: false, output: 'screenshot failed' };
      }
      if (tool === 'pdftext' && inRoots(arg) && /\.pdf$/i.test(arg)) {
        const py = "import sys; from pypdf import PdfReader; r = PdfReader(sys.argv[1]); print(f'[{len(r.pages)} pages]'); [print(f'--- page {i+1}', p.extract_text() or '(no text)', sep='\\n') for i, p in enumerate(r.pages[:20])]";
        const { stdout } = await run('uv', ['run', '--quiet', '--with', 'pypdf', 'python', '-c', py, arg], { timeout: 180000, maxBuffer: 8 << 20 }); return { ok: true, output: stdout.slice(0, 30000) };
      }
      throw new Error('unknown tool or bad argument');
    },
    '/api/chat': async (b) => {
      const text = String(b.text || '').trim(); if (!text) throw new Error('empty');
      const sessionKey = await ensureChat(o.store.get<number>('chatWindow', 1));
      await o.gw.rpc('chat.send', { sessionKey, message: chatContext() + text, idempotencyKey: randomUUID() });
      act(`chat to main: ${text.slice(0, 80)}`);
      return { ok: true };
    },
    '/api/chat/rotate': async () => {
      const n = o.store.get<number>('chatWindow', 1) + 1; await ensureChat(n); o.store.set('chatWindow', n);
      return { ok: true, window: n };
    },
    '/api/dashboard': async () => {
      // The signed-in link (browserUrl carries a one-time bootstrap token); the bare URL asks for a login.
      if (!(await gatewayAnswers(18789, 3000))) { try { await prereqs.startGateway(() => {}); } catch (e: any) { return { ok: false, error: `the OpenClaw gateway is not running (${e.message})` }; } }
      const r = await prereqs.openclaw(['dashboard', '--no-open', '--json'], 60000);
      try { const j = JSON.parse(String(r.out).slice(String(r.out).indexOf('{'))); if (j.browserUrl || j.url) return { ok: true, url: j.browserUrl || j.url }; } catch {}
      return { ok: false, error: `OpenClaw did not give a dashboard link (${String(r.out).trim().split('\n').pop()?.slice(0, 200) || 'no output'})` };
    },
  };

  // Chat runs in its own session, blind to the board: asked "what did the team just do?" the brain searched its
  // memory and found nothing. Each message carries a short, current team status; the chat view strips it.
  const CTX_OPEN = '[team status - context for you, not from jr]', CTX_CLOSE = '[/team status]';
  function chatContext() {
    const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const posts = o.store.posts({ limit: 40 }).filter((p) => !p.cmd).slice(-10).map((p) => `${p.ts} ${p.from} -> ${p.to}: ${clip(p.body, 200)}`);
    const tasks = o.store.tasks().slice(-8).map((t) => `${t.id} ${t.status} (${t.assignee}): ${clip(t.text, 160)}`);
    return `${CTX_OPEN}\nLatest board posts:\n${posts.join('\n') || 'none'}\nTasks:\n${tasks.join('\n') || 'none'}\nWork folder: ${cfg.workDir}\n${CTX_CLOSE}\n`;
  }
  const stripContext = (s: string) => { const i = s.indexOf(CTX_CLOSE); return s.startsWith(CTX_OPEN) && i >= 0 ? s.slice(i + CTX_CLOSE.length).trim() : s; };
  function chatKey(n: number) { return n === 1 ? 'agent:main:jr-chat' : `agent:main:jr-chat-${n}`; }
  async function ensureChat(n: number) {
    const key = chatKey(n);
    try { await o.gw.rpc('sessions.create', { key, agentId: 'main', label: `💬 Chat with jr${n > 1 ? ` #${n}` : ''}`, category: 'Team' }); } catch {}
    return key;
  }
  async function unloadModels() { for (const m of (await ollamaPs()) || []) { try { await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }) }); } catch {} } }

  // ---- live stream: agents + live cards + task counts + GPU, every 2 s while at least one page listens ----
  const streamClients = new Set<ServerResponse>(); let lastSnapshot = ''; let streamTimer: NodeJS.Timeout | null = null; let streaming = false;
  async function snapshot() {
    const pick = async (p: string) => { try { return await getRoutes[p](new URLSearchParams()); } catch { return null; } };
    const [agents, live, tasks, running] = await Promise.all([pick('/api/agents'), pick('/api/live'), pick('/api/tasks'), pick('/api/running')]);
    const t = (tasks?.tasks || []) as any[];
    return { agents: agents?.agents || [], cards: live?.cards || [], messages: live?.messages || [], decisions: (live?.decisions || []).slice(0, 12),
      tasks: t.filter((x) => ['open', 'stuck'].includes(x.status)).map((x) => ({ id: x.id, text: x.text, assignee: x.assignee, status: x.status })),
      doneToday: tasks?.doneToday ?? 0,
      paused: !!tasks?.paused, gpu: running?.gpu || null, gateway: !!running?.gateway };
  }
  function ensureStreamTimer() {
    if (streamTimer) return;
    const tick = async () => {
      if (!streamClients.size) { if (streamTimer) clearInterval(streamTimer); streamTimer = null; return; }
      if (streaming) return; streaming = true;
      try {
        const s = await snapshot(); const json = JSON.stringify(s);
        const frame = json === lastSnapshot ? ': keep-alive\n\n' : `event: snapshot\ndata: ${json}\n\n`;
        lastSnapshot = json; for (const c of streamClients) c.write(frame);
      } catch {} finally { streaming = false; }
    };
    streamTimer = setInterval(tick, 2000); tick();
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, b: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(b)); };
    try {
      // DNS-rebinding guard: a web page can point its own domain at 127.0.0.1 and then read this dashboard as
      // "same origin". Only requests addressed to the dashboard itself are answered.
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${WEB_PORT}` && host !== `localhost:${WEB_PORT}`) return send(421, { error: 'wrong host' });
      const url = new URL(req.url || '/', ORIGIN);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // page assets carry their file time, so an update is always loaded (a cached old flow.js showed old pictures)
        const page = readFileSync(join(opts.webDir, 'index.html'), 'utf8').replace(/(["'])\/assets\/([\w.-]+\.(?:js|css))\1/g, (m, q, n) => {
          try { return `${q}/assets/${n}?v=${Math.round(statSync(join(opts.webDir, 'assets', n)).mtimeMs)}${q}`; } catch { return m; }
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); return res.end(page);
      }
      // Static page assets (web/assets/*.css|js|svg|png|woff2): flat names only, no paths.
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const name = url.pathname.slice(8); const type = ASSET_TYPES[extname(name).toLowerCase()];
        const full = join(opts.webDir, 'assets', name);
        if (!/^[\w.-]+$/.test(name) || !type || !existsSync(full)) return send(404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(readFileSync(full));
      }
      // Live push (Server-Sent Events): one shared snapshot for every open page, sent only when it changes.
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n'); streamClients.add(res);
        if (lastSnapshot) res.write(`event: snapshot\ndata: ${lastSnapshot}\n\n`);
        req.on('close', () => streamClients.delete(res));
        ensureStreamTimer(); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const root = url.searchParams.get('root') === 'inbox' ? cfg.inboxDir : cfg.workDir; const full = resolve(root, url.searchParams.get('p') || '');
        // inside the folder on every OS (Windows "\", macOS/Linux "/"), never into .git / .trash
        const inside = relative(root, full);
        if (!inside || inside.startsWith('..') || isAbsolute(inside) || /(^|[\\/])\.(git|trash)([\\/]|$)/i.test(inside)) return send(403, { error: 'outside work/inbox' });
        if (!existsSync(full) || !statSync(full).isFile()) return send(404, { error: 'not found' });
        const types: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
        const type = types[extname(full).toLowerCase()];
        res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename="${basename(full).replace(/[^\w.\- ]/g, '_')}"` });
        return createReadStream(full).pipe(res);
      }
      if (req.method === 'GET' && getRoutes[url.pathname]) return send(200, await getRoutes[url.pathname](url.searchParams));
      if (req.method === 'POST') {
        // CSRF guard: only the dashboard's own origin may change anything.
        const origin = String(req.headers.origin || ''); if (origin && origin !== ORIGIN && origin !== `http://localhost:${WEB_PORT}`) return send(403, { error: 'bad origin' });
        if (url.pathname === '/api/upload') {
          mkdirSync(cfg.inboxDir, { recursive: true });
          let name = basename(decodeURIComponent(String(req.headers['x-filename'] || 'upload'))).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) || 'upload';
          for (let n = 1; existsSync(join(cfg.inboxDir, name)); n++) name = name.replace(/( \(\d+\))?(\.[^.]*)?$/, ` (${n})$2`);
          const dest = join(cfg.inboxDir, name); let size = 0;
          await new Promise<void>((ok, bad) => { const out = createWriteStream(dest); req.on('data', (c) => { size += c.length; if (size > 500 * 2 ** 20) { req.destroy(); out.destroy(); bad(new Error('file too large (max 500 MB)')); } }); req.pipe(out); out.on('finish', ok); out.on('error', bad); });
          post(String(req.headers['x-to'] || 'all'), `I uploaded a file for you: ${dest} (${Math.round(size / 1024)} KB).` + (req.headers['x-note'] ? '\n' + decodeURIComponent(String(req.headers['x-note'])).slice(0, 2000) : ''));
          return send(200, { ok: true, path: dest });
        }
        const h = postRoutes[url.pathname]; if (!h) return send(404, { error: 'not found' });
        return send(200, await h(await body(req)));
      }
      send(404, { error: 'not found' });
    } catch (e: any) { send(400, { error: String(e?.message || e) }); }
  });
  server.listen(WEB_PORT, '127.0.0.1');
  return server;
}
