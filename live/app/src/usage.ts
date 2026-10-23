// Usage index: hourly rollups of everything the Metrics page charts, kept in Orchestra's own database so history
// survives OpenClaw pruning its transcripts and the GPU log being trimmed. Incremental: each update reads only
// transcript events and GPU samples newer than the last one it saw, so "all time" stays cheap at any age.
//   usage_hourly : model calls, tokens, effective seconds, tool calls, tool errors, runs   per hour x agent x model
//   gpu_hourly   : GPU samples (busy %, VRAM, temperature)                                   per hour
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Store } from './store.ts';

const HOUR = 3600000;
const transcriptDb = (agent: string) => join(homedir(), '.openclaw', 'agents', agent, 'agent', 'openclaw-agent.sqlite');

export interface Range { key: string; label: string; ms: number | null; bucketMs: number }
/** The ranges the Metrics page offers; null = all time. Buckets keep every chart at ~24-90 points. */
export const RANGES: Range[] = [
  { key: '1h', label: '1 hour', ms: HOUR, bucketMs: 5 * 60000 },
  { key: '6h', label: '6 hours', ms: 6 * HOUR, bucketMs: 10 * 60000 },
  { key: '1d', label: '1 day', ms: 24 * HOUR, bucketMs: HOUR },
  { key: '7d', label: '7 days', ms: 7 * 24 * HOUR, bucketMs: 6 * HOUR },
  { key: '30d', label: '30 days', ms: 30 * 24 * HOUR, bucketMs: 24 * HOUR },
  { key: '60d', label: '60 days', ms: 60 * 24 * HOUR, bucketMs: 24 * HOUR },
  { key: 'all', label: 'All time', ms: null, bucketMs: 24 * HOUR },
];

/** Model calls, tokens and runs one agent spent between two times (a task's cost), read from its transcripts. */
export function agentCost(agent: string, fromMs: number, toMs: number): { calls: number; tokIn: number; tokOut: number; runs: number } {
  const out = { calls: 0, tokIn: 0, tokOut: 0, runs: 0 };
  const file = transcriptDb(agent); if (!existsSync(file)) return out;
  let db: DatabaseSync; try { db = new DatabaseSync(file, { readOnly: true }); } catch { return out; }
  try {
    for (const r of db.prepare('SELECT seq, event_json, event_zstd FROM transcript_events WHERE created_at BETWEEN ? AND ? LIMIT 20000').all(fromMs, toMs) as any[]) {
      if (r.seq === 0) out.runs++;
      let e: any; try { e = JSON.parse(r.event_json ?? zstdDecompressSync(r.event_zstd).toString('utf8')); } catch { continue; }
      const m = e?.type === 'message' ? e.message : null;
      if (m?.role === 'assistant' && m.usage) { out.calls++; out.tokIn += (m.usage.input || 0) + (m.usage.cacheRead || 0); out.tokOut += m.usage.output || 0; }
    }
  } catch {} finally { db.close(); }
  return out;
}

export class UsageIndex {
  store: Store; agents: string[]; logDir: string; busy = false; lastRun = 0;
  private prevTs = new Map<string, number>();   // session -> last event time (effective-speed seconds)
  constructor(store: Store, agents: string[], logDir: string) {
    this.store = store; this.agents = agents; this.logDir = logDir;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_hourly (hour INTEGER NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, secs REAL NOT NULL DEFAULT 0,
        tools INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour, agent, model));
      CREATE TABLE IF NOT EXISTS gpu_hourly (hour INTEGER PRIMARY KEY, samples INTEGER NOT NULL, util REAL NOT NULL, used REAL NOT NULL,
        total REAL NOT NULL, temp_max REAL NOT NULL, temp_sum REAL NOT NULL);`);
  }

  /** Read new transcript events and GPU samples into the rollups. Safe to call often (throttled to 30 s). */
  update(force = false) {
    if (this.busy || (!force && Date.now() - this.lastRun < 30000)) return;
    this.busy = true; this.lastRun = Date.now();
    try { for (const a of this.agents) this.indexAgent(a); this.indexGpu(); }
    finally { this.busy = false; }
  }

  private indexAgent(agent: string) {
    const file = transcriptDb(agent); if (!existsSync(file)) return;
    const markKey = `usageMark:${agent}`; const mark = this.store.get<number>(markKey, 0);
    let db: DatabaseSync; try { db = new DatabaseSync(file, { readOnly: true }); } catch { return; }
    const acc = new Map<string, { hour: number; model: string; calls: number; input: number; output: number; secs: number; tools: number; errors: number; runs: number }>();
    const bump = (ts: number, model: string) => {
      const hour = Math.floor(ts / HOUR) * HOUR, k = `${hour}|${model}`;
      let r = acc.get(k); if (!r) acc.set(k, r = { hour, model, calls: 0, input: 0, output: 0, secs: 0, tools: 0, errors: 0, runs: 0 }); return r;
    };
    let maxSeen = mark; const lastModel = new Map<string, string>();
    try {
      const stmt = db.prepare('SELECT session_id, seq, event_json, event_zstd, created_at FROM transcript_events WHERE created_at > ? ORDER BY created_at, session_id, seq LIMIT 50000');
      for (const r of stmt.all(mark) as any[]) {
        maxSeen = Math.max(maxSeen, r.created_at);
        let e: any; try { e = JSON.parse(r.event_json ?? zstdDecompressSync(r.event_zstd).toString('utf8')); } catch { continue; }
        const ts = Date.parse(e?.timestamp) || r.created_at;
        if (r.seq === 0) bump(ts, lastModel.get(r.session_id) || '?').runs++;
        const m = e?.type === 'message' ? e.message : null;
        if (m?.role === 'assistant' && m.model !== 'gateway-injected') {
          const model = String(m.model || '?').replace(/:latest$/, ''); lastModel.set(r.session_id, model);
          const b = bump(ts, model);
          const u = m.usage; if (u) { b.calls++; b.input += (u.input || 0) + (u.cacheRead || 0); b.output += u.output || 0; }
          const prev = this.prevTs.get(r.session_id); const dt = prev ? (ts - prev) / 1000 : 0;
          if (u && dt > 0.3 && dt < 600) b.secs += dt;
          for (const c of [].concat(m.content || []) as any[]) if (c?.type === 'toolCall') b.tools++;
        } else if (m?.role === 'toolResult' && m.isError) bump(ts, lastModel.get(r.session_id) || '?').errors++;
        if (ts) this.prevTs.set(r.session_id, ts);
      }
    } finally { db.close(); }
    if (this.prevTs.size > 5000) this.prevTs.clear();
    const up = this.store.db.prepare(`INSERT INTO usage_hourly (hour, agent, model, calls, input, output, secs, tools, errors, runs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, agent, model) DO UPDATE SET calls = calls + excluded.calls, input = input + excluded.input, output = output + excluded.output,
      secs = secs + excluded.secs, tools = tools + excluded.tools, errors = errors + excluded.errors, runs = runs + excluded.runs`);
    this.store.db.exec('BEGIN');
    try { for (const r of acc.values()) up.run(r.hour, agent, r.model, r.calls, r.input, r.output, r.secs, r.tools, r.errors, r.runs); this.store.set(markKey, maxSeen); this.store.db.exec('COMMIT'); }
    catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }

  private indexGpu() {
    const f = join(this.logDir, 'gpu-history.jsonl'); if (!existsSync(f)) return;
    const mark = this.store.get<number>('usageMark:gpu', 0); let maxSeen = mark;
    const acc = new Map<number, { n: number; util: number; used: number; total: number; tmax: number; tsum: number }>();
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue; let s: any; try { s = JSON.parse(line); } catch { continue; }
      const t = Date.parse(s.at); if (!(t > mark)) continue; maxSeen = Math.max(maxSeen, t);
      const hour = Math.floor(t / HOUR) * HOUR; let a = acc.get(hour); if (!a) acc.set(hour, a = { n: 0, util: 0, used: 0, total: 0, tmax: 0, tsum: 0 });
      a.n++; a.util += +s.util || 0; a.used += +s.used || 0; a.total = +s.total || a.total; a.tmax = Math.max(a.tmax, +s.temp || 0); a.tsum += +s.temp || 0;
    }
    const up = this.store.db.prepare(`INSERT INTO gpu_hourly (hour, samples, util, used, total, temp_max, temp_sum) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET samples = samples + excluded.samples, util = util + excluded.util, used = used + excluded.used,
      total = excluded.total, temp_max = max(temp_max, excluded.temp_max), temp_sum = temp_sum + excluded.temp_sum`);
    this.store.db.exec('BEGIN');
    try { for (const [h, a] of acc) up.run(h, a.n, a.util, a.used, a.total, a.tmax, a.tsum); this.store.set('usageMark:gpu', maxSeen); this.store.db.exec('COMMIT'); }
    catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }

  /** Everything the Metrics page needs for one range. Sub-hour ranges fall back to the raw transcripts. */
  report(rangeKey: string) {
    this.update();
    const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[2];
    const now = Date.now(); const db = this.store.db;
    const first = Number((db.prepare('SELECT min(hour) h FROM usage_hourly').get() as any)?.h) || now - 24 * HOUR;
    const since = range.ms ? now - range.ms : first;
    const bucketMs = range.ms ? range.bucketMs : (now - first > 120 * 24 * HOUR ? 7 * 24 * HOUR : 24 * HOUR);
    const start = Math.floor(since / bucketMs) * bucketMs; const nb = Math.max(1, Math.ceil((now - start) / bucketMs));
    const zero = () => Object.fromEntries(this.agents.map((a) => [a, 0])) as Record<string, number>;
    const buckets = Array.from({ length: nb }, (_, i) => ({ t: start + i * bucketMs, out: zero(), inp: zero(), calls: 0, tools: 0, errors: 0, runs: 0 }));
    const rows = db.prepare('SELECT * FROM usage_hourly WHERE hour >= ? ORDER BY hour').all(Math.floor(since / HOUR) * HOUR) as any[];
    const models: Record<string, any> = {}; const agents: Record<string, any> = {};
    const totals = { calls: 0, input: 0, output: 0, tools: 0, errors: 0, runs: 0, secs: 0 };
    for (const r of rows) {
      const b = buckets[Math.min(nb - 1, Math.max(0, Math.floor((r.hour - start) / bucketMs)))];
      if (b.out[r.agent] !== undefined) { b.out[r.agent] += r.output; b.inp[r.agent] += r.input; }
      b.calls += r.calls; b.tools += r.tools; b.errors += r.errors; b.runs += r.runs;
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
      const m = models[r.model] ??= { model: r.model, calls: 0, input: 0, output: 0, secs: 0, tools: 0, errors: 0 };
      m.calls += r.calls; m.input += r.input; m.output += r.output; m.secs += r.secs; m.tools += r.tools; m.errors += r.errors;
      const a = agents[r.agent] ??= { agent: r.agent, calls: 0, input: 0, output: 0, secs: 0, tools: 0, errors: 0, runs: 0 };
      a.calls += r.calls; a.input += r.input; a.output += r.output; a.secs += r.secs; a.tools += r.tools; a.errors += r.errors; a.runs += r.runs;
    }
    const speed = Object.values(models).filter((m: any) => m.model !== '?' && m.calls).map((m: any) => ({ ...m, tps: m.secs ? +(m.output / m.secs).toFixed(1) : null })).sort((a: any, b: any) => b.calls - a.calls);
    // GPU: hourly averages (sub-hour ranges use the raw samples)
    let gpu: any[] = [];
    if (range.ms && range.ms <= 6 * HOUR) {
      try { gpu = readFileSync(join(this.logDir, 'gpu-history.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && Date.parse(x.at) >= since); } catch {}
    } else {
      gpu = (db.prepare('SELECT * FROM gpu_hourly WHERE hour >= ? ORDER BY hour').all(Math.floor(since / HOUR) * HOUR) as any[])
        .map((g) => ({ at: new Date(g.hour).toISOString(), util: Math.round(g.util / g.samples), used: Math.round(g.used / g.samples), total: g.total, temp: Math.round(g.temp_sum / g.samples), tempMax: g.temp_max }));
    }
    // Work done: tasks finished, posts written, per bucket (tasks live in tasks + task_archive)
    const done = db.prepare(`SELECT updated FROM tasks WHERE status = 'done' AND updated >= ? UNION ALL SELECT updated FROM task_archive WHERE status = 'done' AND updated >= ?`).all(new Date(since).toISOString(), new Date(since).toISOString()) as any[];
    const tasksDone = new Array(nb).fill(0); for (const d of done) { const i = Math.floor((Date.parse(d.updated) - start) / bucketMs); if (i >= 0 && i < nb) tasksDone[i]++; }
    const posts = db.prepare('SELECT at FROM posts WHERE at >= ?').all(since) as any[];
    const postsPer = new Array(nb).fill(0); for (const p of posts) { const i = Math.floor((p.at - start) / bucketMs); if (i >= 0 && i < nb) postsPer[i]++; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayRow = db.prepare('SELECT sum(input) i, sum(output) o FROM usage_hourly WHERE hour >= ?').get(Math.floor(today.getTime() / HOUR) * HOUR) as any;
    return {
      at: new Date(now).toISOString(), range: range.key, label: range.label, since, bucketMs, firstData: first, ranges: RANGES.map((r) => ({ key: r.key, label: r.label })),
      buckets: buckets.map((b, i) => ({ ...b, tasksDone: tasksDone[i], posts: postsPer[i] })),
      totals: { ...totals, tasksDone: done.length, posts: posts.length, todayIn: todayRow?.i || 0, todayOut: todayRow?.o || 0, tps: totals.secs ? +(totals.output / totals.secs).toFixed(1) : null },
      agents: Object.values(agents), speed, gpu,
      // old field names the Metrics page used
      hours: range.ms ? range.ms / HOUR : Math.round((now - first) / HOUR), bucketMin: bucketMs / 60000,
    };
  }
}
