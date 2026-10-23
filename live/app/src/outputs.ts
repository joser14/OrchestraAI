// Things written for others each pass: logs\status.json (ctl status/brief + dashboard), GPU history (Metrics),
// the OpenClaw "Board feed" chats (chat.inject: transcript only, no model run), and hourly housekeeping.
import { appendFileSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Orchestrator } from './orchestrator.ts';
import { atomicWrite } from './compat.ts';
import { workPaths } from './rules.ts';
import { gpuMemMB } from './hardware.ts';
const run = promisify(execFile);

async function gpu() {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], { windowsHide: true });
    const f = stdout.split('\n')[0].split(',').map((s) => s.trim());
    const m = gpuMemMB(f[0], f[1]);   // DGX Spark / GB10: "[N/A]" memory -> unified RAM
    return { used: m.used, total: m.total, util: parseInt(f[2]) || 0, temp: parseInt(f[3]) || 0 };
  } catch { return { used: 0, total: 0, util: 0, temp: 0 }; }
}

export async function writeStatus(o: Orchestrator) {
  const g = await gpu();
  let models: any[] = [];
  try { const ps: any = await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5000) })).json(); models = (ps.models || []).map((m: any) => ({ name: m.name, vramGB: +(m.size_vram / 2 ** 30).toFixed(1), sizeGB: +(m.size / 2 ** 30).toFixed(1) })); } catch {}
  const jobs: Record<string, any> = {}, helpers: Record<string, number> = {};
  const subSeen = o.store.get<Record<string, number>>('subSeen', {});
  for (const a of o.cfg.agents) {
    const j = o.jobs[a];
    jobs[a] = { status: o.running(a) ? 'running' : (j?.state?.lastRunStatus ?? j?.lastRunStatus ?? ''), model: j?.payload?.model ?? '', runningAtMs: j?.state?.runningAtMs ?? null };
    helpers[a] = Object.keys(subSeen).filter((k) => k.startsWith(`agent:${a}:`)).length;
  }
  const at = new Date().toISOString();
  atomicWrite(join(o.cfg.logDir, 'status.json'), JSON.stringify({ at, gpu: g, models, jobs, helpers, by: 'orchestra' }, null, 1));
  const gh = join(o.cfg.logDir, 'gpu-history.jsonl');
  appendFileSync(gh, JSON.stringify({ at, ...g, running: o.cfg.agents.filter((a) => o.running(a)).length }) + '\n');
  if (statSync(gh).size > 600 * 1024) writeFileSync(gh, readFileSync(gh, 'utf8').trim().split('\n').slice(-4320).join('\n') + '\n');
}

/** Copy new board posts into each involved agent's pinned "Board feed" chat in OpenClaw. */
let mirroring = false;
export async function mirrorToOpenClaw(o: Orchestrator) {
  if (mirroring) return; mirroring = true;
  try {
    const AG = o.cfg.agents; const feed = (a: string) => `agent:${a}:board`;
    let cursor = o.store.get<number>('mirrorCursor', -1);
    if (cursor < 0) { o.store.set('mirrorCursor', o.store.lastPostId()); return; }   // first run: start with what comes next
    const ready = new Set(o.store.get<string[]>('mirrorReady', []));
    for (const p of o.store.posts({ sinceId: cursor }).slice(0, 15)) {
      const who = new Set(['main']); if (p.to === 'all') AG.forEach((a) => who.add(a));
      for (const x of [p.from, p.to].map((s) => s.replace(/-(helper|relay|chat)$/, ''))) if (AG.includes(x)) who.add(x);
      for (const a of who) {
        if (!ready.has(a)) {
          try { await o.gw.rpc('sessions.create', { key: feed(a), agentId: a, label: `📋 Board feed (${a})`, category: 'Team' }); } catch {}
          try { await o.gw.patchSession(feed(a), { pinned: true }); } catch {}
          ready.add(a);
        }
        try { await o.gw.inject(feed(a), `📋 ${p.from} → ${p.to} · ${p.ts}\n\n${p.body.slice(0, 4000)}`, `board ${p.from} → ${p.to}`); } catch {}
      }
      cursor = p.id; o.store.set('mirrorCursor', cursor);
    }
    o.store.set('mirrorReady', [...ready]);
  } finally { mirroring = false; }
}

/** Hourly: tidy the work folder by rule, purge old outbox/done files, commit work history to git. */
export async function housekeeping(o: Orchestrator, now = new Date()) {
  const work = o.cfg.workDir, trash = join(work, '.trash'); mkdirSync(trash, { recursive: true });
  const protectedNames = new Set(o.store.tasks().filter((t) => t.status === 'open' || t.status === 'stuck').flatMap((t) => workPaths(t.text, work)).map((p) => basename(p).toLowerCase()));
  const moved: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 4) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (protectedNames.has(e.name.toLowerCase())) continue;
      const s = statSync(p); const ageH = (now.getTime() - s.mtimeMs) / 3600000;
      let why = '';
      if (s.size === 0 && ageH >= 1) why = 'empty';
      else if (/\.(md|txt)$/i.test(e.name) && ageH >= 24) { const pdf = p.replace(/\.(md|txt)$/i, '.pdf'); if (existsSync(pdf) && statSync(pdf).mtimeMs >= s.mtimeMs) why = 'turned into PDF'; }
      if (!why && ageH >= 72 && (/\.(tmp|bak|partial)$/i.test(e.name) || /scratch|temp|draft/i.test(e.name))) why = 'scratch';
      if (why) { renameSync(p, join(trash, `${now.toISOString().replace(/\D/g, '').slice(0, 14)}-${p.slice(work.length + 1).replace(/[\\/]/g, '_')}`)); moved.push(`${e.name} (${why})`); }
    }
  };
  try { walk(work); } catch {}
  if (moved.length) o.log(`work tidy: moved ${moved.length} file(s) to work\\.trash: ${moved.join('; ')}`);
  const purge = (dir: string, days: number) => { try { for (const f of readdirSync(dir)) { const p = join(dir, f); try { if (now.getTime() - statSync(p).mtimeMs > days * 864e5) unlinkSync(p); } catch {} } } catch {} };
  purge(join(o.cfg.outbox, 'done'), 7); purge(trash, 7);
  try {
    if (!existsSync(join(work, '.git'))) { await run('git', ['-C', work, 'init', '-q']); await run('git', ['-C', work, 'config', 'user.name', 'agents']); await run('git', ['-C', work, 'config', 'user.email', 'agents@localhost']); }
    const { stdout } = await run('git', ['-C', work, 'status', '--porcelain']);
    if (stdout.trim()) { await run('git', ['-C', work, 'add', '-A']); await run('git', ['-C', work, 'commit', '-q', '-m', `auto ${now.toISOString().slice(0, 16)}`]); }
  } catch {}
}
