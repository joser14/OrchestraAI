// Tool-call rescue between OpenClaw and Ollama. With thinking on, Qwen3 sometimes opens its <think> block, writes
// the tool call inside it (<tool_call>{"name": ..., "arguments": ...}</tool_call>) and stops without closing it.
// Ollama's parser then files everything as thinking, OpenClaw sees no tool call, and the run ends with nothing done
// (seen on 2026-10-14: the composer "ran" for 18 s and dropped jr's request). This proxy passes every request through
// untouched and, only when a /api/chat reply ends with no tool calls but holds complete <tool_call> blocks in its
// thinking or text, adds them as real tool calls before the final chunk. Any model with this habit is covered;
// a reply that already has tool calls is never changed.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';

export const PROXY_PORT = 11444;
export const UPSTREAM = { host: '127.0.0.1', port: 11434 };

export interface ToolCall { function: { name: string; arguments: Record<string, unknown> } }

/** Complete <tool_call>{json}</tool_call> blocks in a text, as Ollama tool calls (bad JSON is skipped). */
export function rescueToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of String(text || '').matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    let j: any; try { j = JSON.parse(m[1]); } catch { continue; }
    const name = typeof j?.name === 'string' ? j.name : typeof j?.function?.name === 'string' ? j.function.name : '';
    let args = j?.arguments ?? j?.function?.arguments ?? j?.parameters ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (name && args && typeof args === 'object' && !Array.isArray(args)) out.push({ function: { name, arguments: args } });
  }
  return out;
}

/** Rewrite one finished, non-streamed /api/chat reply (returns it unchanged when nothing needs rescuing). */
export function patchReply(reply: any): { reply: any; rescued: number } {
  const m = reply?.message; if (!m || (m.tool_calls && m.tool_calls.length)) return { reply, rescued: 0 };
  const calls = rescueToolCalls(`${m.thinking || ''}\n${m.content || ''}`);
  if (!calls.length) return { reply, rescued: 0 };
  return { reply: { ...reply, message: { ...m, tool_calls: calls } }, rescued: calls.length };
}

// ---- live generation stats (Dashboard): measured on the replies passing through, from Ollama's own counts ----
interface LastGen { model: string; tps: number; promptTps: number; outTokens: number; promptTokens: number; at: number }
const gen = { active: 0, ticks: [] as number[], last: null as LastGen | null, session: { replies: 0, outTokens: 0, minTps: 0, maxTps: 0, sumTps: 0 } };
const tick = () => { const t = Date.now(); gen.ticks.push(t); while (gen.ticks.length && t - gen.ticks[0] > 4000) gen.ticks.shift(); };
function finished(j: any) {
  const evalN = Number(j.eval_count) || 0, evalNs = Number(j.eval_duration) || 0, pN = Number(j.prompt_eval_count) || 0, pNs = Number(j.prompt_eval_duration) || 0;
  if (!evalN || !evalNs) return;
  // prompt speed only from a real read: with Ollama's prompt cache a reply re-reads a few tokens in ~1 ms (126,000 tok/s)
  const tps = evalN / (evalNs / 1e9), promptTps = pN >= 64 && pNs >= 5e7 ? pN / (pNs / 1e9) : gen.last?.promptTps || 0;
  gen.last = { model: String(j.model || ''), tps: +tps.toFixed(1), promptTps: +promptTps.toFixed(0), outTokens: evalN, promptTokens: pN, at: Date.now() };
  const s = gen.session; s.replies++; s.outTokens += evalN; s.sumTps += tps; s.minTps = s.minTps ? Math.min(s.minTps, tps) : tps; s.maxTps = Math.max(s.maxTps, tps);
}
/** Now: replies streaming, tokens per second over the last 2 s; the last finished reply; this session's spread. */
export function liveGen() {
  const now = Date.now(), recent = gen.ticks.filter((t) => now - t <= 2000).length;
  const s = gen.session;
  return { active: gen.active, nowTps: +(recent / 2).toFixed(1), last: gen.last,
    session: { replies: s.replies, outTokens: s.outTokens, minTps: +s.minTps.toFixed(1), maxTps: +s.maxTps.toFixed(1), avgTps: s.replies ? +(s.sumTps / s.replies).toFixed(1) : 0 } };
}

export function startOllamaProxy(log: (m: string) => void = () => {}, port = PROXY_PORT) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard, like the dashboard: answer only requests addressed to this machine by IP or localhost
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host || ''))) { res.writeHead(421); res.end(); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const isChat = req.method === 'POST' && (req.url || '').split('?')[0] === '/api/chat';
      let streamed = true; if (isChat) { try { streamed = JSON.parse(body.toString('utf8')).stream !== false; } catch {} }
      const up = request({ ...UPSTREAM, method: req.method, path: req.url, headers: { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}`, 'content-length': String(body.length) } }, (ur) => {
        if (!isChat || (ur.statusCode || 500) >= 400) { res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res); return; }
        const headers = { ...ur.headers }; delete headers['content-length'];
        res.writeHead(ur.statusCode || 200, headers);
        if (!streamed) {   // one JSON object
          const parts: Buffer[] = []; ur.on('data', (c) => parts.push(c));
          ur.on('end', () => {
            try { const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); finished(parsed); const { reply, rescued } = patchReply(parsed); if (rescued) log(`ollama proxy: rescued ${rescued} tool call(s) written inside thinking`); res.end(JSON.stringify(reply)); }
            catch { res.end(Buffer.concat(parts)); }
          });
          return;
        }
        // NDJSON stream: pass each line through as it comes; hold only the final (done) line to add rescued calls
        let buf = '', text = '', sawCalls = false;
        gen.active++; let counted = true; const done = () => { if (counted) { counted = false; gen.active--; } };
        res.on('close', done);
        const line = (l: string) => {
          if (!l.trim()) return;
          let j: any = null; try { j = JSON.parse(l); } catch { res.write(l + '\n'); return; }
          const m = j.message || {};
          if (m.tool_calls?.length) sawCalls = true;
          if (m.thinking || m.content) tick();   // about one token per streamed chunk: the live speed
          text += (m.thinking || '') + (m.content || '');
          if (j.done) { finished(j); done(); }
          if (j.done && !sawCalls) {
            const calls = rescueToolCalls(text);
            if (calls.length) {
              res.write(JSON.stringify({ model: j.model, created_at: j.created_at, message: { role: 'assistant', content: '', tool_calls: calls }, done: false }) + '\n');
              log(`ollama proxy: rescued ${calls.length} tool call(s) written inside thinking (${calls.map((c) => c.function.name).join(', ')})`);
            }
          }
          res.write(l + '\n');
        };
        ur.on('data', (c) => { buf += c.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
        ur.on('end', () => { line(buf); res.end(); });
      });
      up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Ollama is not answering (${e.message})` })); });
      // OpenClaw aborted (its connection closed before the reply ended): stop the generation too. Not req 'close':
      // that fires as soon as the request body has been read.
      res.on('close', () => { if (!res.writableFinished) up.destroy(); });
      up.end(body);
    });
  });
  server.on('error', (e: any) => log(`ollama proxy: ${e.code === 'EADDRINUSE' ? `port ${port} is taken` : e.message}`));
  server.listen(port, '127.0.0.1');
  return server;
}
