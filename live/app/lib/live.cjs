// Live team view: what each agent / helper is doing right now, read (read-only) from OpenClaw's
// per-agent transcript databases. Used by the board GUI (/api/live); also runnable: node live.js [minutes]
const { DatabaseSync } = require('node:sqlite');
const zlib = require('zlib'), fs = require('fs'), os = require('os'), path = require('path');

// main + every worker that has an OpenClaw agent folder (the team can have 1-8 workers)
const AGENTS = (() => { try { const d = require('path').join(require('os').homedir(), '.openclaw', 'agents'); return ['main', ...require('fs').readdirSync(d).filter((n) => /^worker[2-8]?$/.test(n)).sort((a, b) => (a.length - b.length) || a.localeCompare(b))]; } catch { return ['main', 'worker', 'worker2']; } })();
const dbPath = (a) => path.join(os.homedir(), '.openclaw', 'agents', a, 'agent', 'openclaw-agent.sqlite');
const INTERNAL = /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g;

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}
// Text limits: compact for the live cards; x40 for the Agent details page (getLive(..., { full: true })).
let SCALE = 1, TL_MAX = 40;
function short(v, n) { n *= SCALE; const s = (typeof v === 'string' ? v : JSON.stringify(v)) || ''; return s.length > n ? s.slice(0, n) + '…' : s; }
function event(r) {
  try {
    if (r.event_json) return JSON.parse(r.event_json);
    if (r.event_zstd) return JSON.parse(zlib.zstdDecompressSync(r.event_zstd).toString('utf8'));
  } catch {}
  return null;
}
function openTask(agent) {
  try {
    const tasks = JSON.parse(fs.readFileSync(path.join(process.env.ORCHESTRA_ROOT || path.join(require('os').homedir(), 'Orchestra'), 'board', 'tasks.json'), 'utf8').replace(/^\uFEFF/, ''));
    const t = [].concat(tasks).filter((x) => x && x.assignee === agent && x.status === 'open').sort((a, b) => String(a.created).localeCompare(String(b.created)))[0];
    return t ? `${t.id}: ${t.text}` : '';
  } catch { return ''; }
}

function sessionCard(db, agent, w) {
  const rows = db.prepare('SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq').all(w.session_id);
  const msgs = rows.map(event).filter((e) => e && e.type === 'message' && e.message).map((e) => ({ ...e.message, ts: e.timestamp }));
  const key = w.session_key;
  const kind = key.includes(':subagent:') ? 'helper' : key.includes(':cron:') ? 'board run' : 'chat';
  let task = '';
  const firstUser = msgs.find((m) => m.role === 'user');
  if (kind === 'board run') task = agent === 'main' ? 'Orchestrator pass: read the brief, answer jr, plan and assign work' : (openTask(agent) || 'Board run: check for open tasks');
  else if (firstUser) task = textOf(firstUser.content).replace(INTERNAL, '').trim();
  const steps = []; const byId = {};
  const timeline = [];   // verbose view: what it thinks / says, each action and its result, in order
  let report = '';
  for (const m of msgs) {
    if (m.role === 'assistant') {
      for (const c of [].concat(m.content || [])) {
        if (!c) continue;
        if (c.type === 'thinking' && String(c.thinking || c.text || '').trim()) timeline.push({ kind: 'think', text: short(String(c.thinking || c.text).trim(), 1200), ts: m.ts });
        else if (c.type === 'text' && String(c.text || '').trim()) timeline.push({ kind: 'say', text: short(String(c.text).replace(INTERNAL, '').trim(), 1500), ts: m.ts });
        else if (c.type === 'toolCall') {
          const s = { tool: c.name, args: short(c.arguments, 160), state: 'pending' }; steps.push(s); byId[c.id] = s;
          const ev = { kind: 'tool', tool: c.name, args: short(c.arguments, 400), state: 'pending', ts: m.ts }; timeline.push(ev); s.ev = ev;
        }
      }
      const t = textOf(m.content).trim(); if (t) report = t;
    } else if (m.role === 'toolResult') {
      const s = byId[m.toolCallId];
      if (s) {
        s.state = m.isError ? 'error' : 'ok'; if (m.isError) s.error = short(textOf(m.content), 160);
        if (s.ev) { s.ev.state = s.state; s.ev.result = short(textOf(m.content).trim(), 600); }
      }
    }
  }
  for (const s of steps) delete s.ev;
  if (!msgs.length) return null;   // empty window (e.g. a retry shell) - nothing to show
  const last = msgs[msgs.length - 1];
  const recent = Date.now() - (w.touched || 0) < 10 * 60000;
  const live = w.status === 'running' || (!w.ended_at && !w.status && recent);
  let phase = w.status || 'done';
  if (live) {
    const pending = steps.filter((s) => s.state === 'pending');
    phase = pending.length ? `running ${pending[pending.length - 1].tool}…` : last && last.role === 'assistant' && textOf(last.content).trim() ? 'writing its report…' : 'thinking…';
  }
  return {
    agent, kind, key, label: w.display_name || '', model: (w.model || '').replace(/:latest$/, ''), live, phase,
    startedAt: w.started_at || w.created_at, endedAt: w.ended_at || null, task: short(task, 600), steps: steps.slice(SCALE > 1 ? -200 : -12), report: short(report, 1500),
    timeline: timeline.slice(-(TL_MAX || 40)),
  };
}

function getLive(minutes = 30, opts = {}) {
  SCALE = opts.full ? 40 : 1; TL_MAX = opts.timeline || 40;   // opts.timeline: events kept per run (the Logs page wants them all)
  const since = Date.now() - minutes * 60000;
  const cards = [];
  for (const agent of opts.agents || AGENTS) {   // opts.agents: only these (one agent's log)
    let db;
    try { db = new DatabaseSync(dbPath(agent), { readOnly: true }); } catch { continue; }
    try {
      const wins = db.prepare(`SELECT session_id, session_key, status, started_at, ended_at, created_at, model, display_name,
        coalesce(transcript_updated_at, updated_at) AS touched FROM session_windows WHERE coalesce(transcript_updated_at, updated_at) >= ? ORDER BY coalesce(transcript_updated_at, updated_at) DESC LIMIT ${opts.limit || (opts.full ? 30 : 6)}`).all(since);
      for (const w of wins) {
        // Runs started through the gateway API (Orchestra) are windows of the job's parent key (agent:x:cron:<job>);
        // runs started by the CLI had their own :run: keys. Each window is one run either way: empty ones are skipped.
        if (/:board$/.test(w.session_key)) continue;        // the OpenClaw "Board feed" mirror, not work
        try { const c = sessionCard(db, agent, w); if (c) cards.push(c); } catch {}
      }
    } finally { db.close(); }
  }
  cards.sort((a, b) => (b.live - a.live) || (b.startedAt - a.startedAt));
  SCALE = 1; TL_MAX = 40;
  return { at: new Date().toISOString(), cards: cards.slice(0, opts.limit || (opts.full ? 120 : 8)) };
}

/** One agent's runs as plain log lines, oldest first (the Logs page): a header per run, then every thought, message,
 *  tool call with its result, and how the run ended. */
function runLines(cards) {
  const t = (ts) => { const d = new Date(typeof ts === 'number' || /^\d+$/.test(String(ts)) ? Number(ts) : ts); return isNaN(d) ? '--:--:--' : d.toTimeString().slice(0, 8); };
  const day = (ts) => { const d = new Date(Number(ts) || ts); return isNaN(d) ? '' : d.toLocaleDateString('en-CA'); };   // local YYYY-MM-DD, like the times
  const one = (s) => String(s || '').replace(/\s*\n\s*/g, ' ⏎ ').trim();
  const out = [];
  for (const c of [...cards].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    out.push('', `== ${day(c.startedAt)} ${t(c.startedAt)} · ${c.kind}${c.model ? ` · ${c.model}` : ''}${c.live ? ' · RUNNING' : ''}`);
    if (c.task) out.push(`   task: ${one(c.task)}`);
    for (const e of c.timeline || []) {
      if (e.kind === 'think') out.push(`[${t(e.ts)}] thinks: ${one(e.text)}`);
      else if (e.kind === 'say') out.push(`[${t(e.ts)}] says: ${one(e.text)}`);
      else if (e.kind === 'tool') {
        out.push(`[${t(e.ts)}] tool ${e.tool} ${one(e.args)}`);
        if (e.state === 'pending') out.push('           … waiting for the result');
        else out.push(`           ${e.state === 'error' ? '✗ ERROR' : '→'} ${one(e.result) || (e.state === 'error' ? 'failed' : 'ok')}`);
      }
    }
    const secs = c.endedAt && c.startedAt ? Math.round((c.endedAt - c.startedAt) / 1000) : 0;
    out.push(c.live ? `   … ${c.phase}` : `== ended: ${c.phase}${secs ? ` after ${secs}s` : ''}`);
  }
  return out.slice(out[0] === '' ? 1 : 0);
}
function agentLog(agent, days = 7) {
  return runLines(getLive(days * 1440, { full: true, agents: [agent], timeline: 5000, limit: 60 }).cards.filter((c) => c.agent === agent));
}

module.exports = { getLive, agentLog, runLines };
if (require.main === module) process.stdout.write(JSON.stringify(getLive(Number(process.argv[2]) || 30), null, 1));
