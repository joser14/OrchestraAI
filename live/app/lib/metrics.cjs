// Token / speed / GPU metrics for the board GUI's Metrics page (read-only).
//  - tokens: every model call's usage from OpenClaw's per-agent transcript databases
//  - speed: output tokens / time since the previous event in that session (includes prompt processing,
//    so it is "effective" tokens per second as the agents experience it)
//  - gpu: logs\gpu-history.jsonl, one sample per pass
const { DatabaseSync } = require('node:sqlite');
const zlib = require('zlib'), fs = require('fs'), os = require('os'), path = require('path');
// main + every worker that has an OpenClaw agent folder (the team can have 1-8 workers)
const AGENTS = (() => { try { const d = require('path').join(require('os').homedir(), '.openclaw', 'agents'); return ['main', ...require('fs').readdirSync(d).filter((n) => /^worker[2-8]?$/.test(n)).sort((a, b) => (a.length - b.length) || a.localeCompare(b))]; } catch { return ['main', 'worker', 'worker2']; } })();
const dbPath = (a) => path.join(os.homedir(), '.openclaw', 'agents', a, 'agent', 'openclaw-agent.sqlite');

function getMetrics(hours = 6, bucketMin = 10) {
  const now = Date.now(), since = now - hours * 3600000, bms = bucketMin * 60000;
  const nb = Math.ceil((hours * 60) / bucketMin), start = Math.floor(since / bms) * bms;
  const buckets = Array.from({ length: nb + 1 }, (_, i) => ({ t: start + i * bms, out: Object.fromEntries(AGENTS.map((a) => [a, 0])), inp: Object.fromEntries(AGENTS.map((a) => [a, 0])), calls: 0 }));
  const models = {}; const totals = { calls: 0, input: 0, output: 0, todayIn: 0, todayOut: 0 };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const agent of AGENTS) {
    let db; try { db = new DatabaseSync(dbPath(agent), { readOnly: true }); } catch { continue; }
    try {
      const rows = db.prepare('SELECT session_id, seq, event_json, event_zstd, created_at FROM transcript_events WHERE created_at >= ? ORDER BY session_id, seq').all(since - 3600000);
      let prevSession = null, prevTs = 0;
      for (const r of rows) {
        let e = null;
        try { e = JSON.parse(r.event_json || zlib.zstdDecompressSync(r.event_zstd).toString('utf8')); } catch { continue; }
        const ts = Date.parse(e && e.timestamp) || r.created_at;
        if (r.session_id !== prevSession) { prevSession = r.session_id; prevTs = 0; }
        const m = e && e.type === 'message' && e.message;
        const u = m && m.role === 'assistant' && m.model !== 'gateway-injected' && m.usage;   // skip Board-feed notes
        if (u && ts >= since) {
          const input = (u.input || 0) + (u.cacheRead || 0), output = u.output || 0;
          const b = buckets[Math.min(nb, Math.floor((ts - start) / bms))];
          if (b) { b.out[agent] += output; b.inp[agent] += input; b.calls++; }
          totals.calls++; totals.input += input; totals.output += output;
          if (ts >= today.getTime()) { totals.todayIn += input; totals.todayOut += output; }
          const model = String(m.model || '?').replace(/:latest$/, '');
          const s = models[model] || (models[model] = { model, calls: 0, output: 0, input: 0, secs: 0 });
          s.calls++; s.output += output; s.input += input;
          const dt = prevTs ? (ts - prevTs) / 1000 : 0;
          if (dt > 0.3 && dt < 600) s.secs += dt;
        }
        if (ts) prevTs = ts;
      }
    } finally { db.close(); }
  }
  const speed = Object.values(models).map((s) => ({ ...s, tps: s.secs ? +(s.output / s.secs).toFixed(1) : null }))
    .sort((a, b) => b.calls - a.calls);
  let gpu = [];
  try {
    gpu = fs.readFileSync(path.join(process.env.ORCHESTRA_ROOT || path.join(require('os').homedir(), 'Orchestra'), 'logs', 'gpu-history.jsonl'), 'utf8').trim().split('\n').slice(-hours * 60)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && Date.parse(x.at) >= since);
  } catch {}
  return { at: new Date(now).toISOString(), hours, bucketMin, buckets, speed, totals, gpu };
}
module.exports = { getMetrics };
if (require.main === module) { const m = getMetrics(Number(process.argv[2]) || 6); console.log(JSON.stringify({ totals: m.totals, speed: m.speed, gpuSamples: m.gpu.length }, null, 1)); }
