// Activity feed: what the agents actually did, copied from OpenClaw's transcripts into activity.log - every tool
// call (commands run, files written, searches, team messages) with its key argument, failed tool calls with their
// error, and each run's closing words. The orchestrator's own lines say who was started and why; these say what
// happened inside the run. Incremental: one mark per agent, only newer transcript events are read.
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Store } from './store.ts';

const transcriptDb = (agent: string) => join(homedir(), '.openclaw', 'agents', agent, 'agent', 'openclaw-agent.sqlite');
const clip = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const stamp = (ms: number) => { const d = new Date(ms); const p = (x: number) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

/** One readable line for a tool call: the tool and the argument that says what it did. */
export function describeCall(name: string, args: any): string {
  const a = args || {};
  switch (name) {
    case 'exec': return `ran: ${clip(a.command, 220)}`;
    case 'write': return `wrote: ${a.path || a.file_path || '?'}${typeof a.content === 'string' ? ` (${a.content.length} chars)` : ''}`;
    case 'edit': case 'apply_patch': return `edited: ${a.path || a.file_path || clip(a.patch, 80)}`;
    case 'read': return `read: ${a.path || a.file_path || '?'}`;
    case 'web_search': return `searched the web: ${clip(a.query, 160)}`;
    case 'web_fetch': return `fetched: ${clip(a.url, 160)}`;
    case 'memory_search': return `searched memory: ${clip(a.query, 120)}`;
    case 'team_post': case 'team_say': return `-> ${a.to || 'all'}: ${clip(a.message, 200)}`;
    case 'team_assign': return `assigned ${a.worker || '?'}${a.model ? ` (${a.model})` : ''}: ${clip(a.job, 200)}`;
    case 'team_done': return `done ${a.task || ''}: ${clip(a.note, 160)}`;
    case 'team_pdf': return `made a PDF from ${a.file || '?'}`;
    case 'team_sleep': return `rests ${a.minutes ?? '?'} min`;
    case 'team_cancel': return `cancelled ${a.task || '?'}`;
    case 'team_brief': return 'read its brief';
    default: return `${name}${Object.keys(a).length ? ': ' + clip(JSON.stringify(a), 160) : ''}`;
  }
}

/** Append new agent actions to activity.log. Safe to call every pass. */
export function feedActivity(store: Store, agents: string[], logDir: string) {
  const lines: [number, string][] = [];
  for (const agent of agents) {
    const file = transcriptDb(agent); if (!existsSync(file)) continue;
    const markKey = `feedMark:${agent}`; let mark = store.get<number>(markKey, 0);
    if (!mark) { store.set(markKey, Date.now()); continue; }   // first run: start from now, not from all history
    let db: DatabaseSync; try { db = new DatabaseSync(file, { readOnly: true }); } catch { continue; }
    try {
      for (const r of db.prepare('SELECT event_json, event_zstd, created_at FROM transcript_events WHERE created_at > ? ORDER BY created_at, seq LIMIT 2000').all(mark) as any[]) {
        mark = Math.max(mark, r.created_at);
        let e: any; try { e = JSON.parse(r.event_json ?? zstdDecompressSync(r.event_zstd).toString('utf8')); } catch { continue; }
        const m = e?.type === 'message' ? e.message : null; if (!m) continue;
        const at = Date.parse(e.timestamp) || r.created_at;
        if (m.role === 'assistant') {
          for (const c of [].concat(m.content || []) as any[]) {
            if (c?.type === 'toolCall' && c.name !== 'team_brief') lines.push([at, `[${agent}] ${describeCall(c.name, c.arguments)}`]);
            if (c?.type === 'text' && m.stopReason === 'stop' && c.text?.trim() && !/^(NO_REPLY|HEARTBEAT_OK)\b/.test(c.text.trim())) lines.push([at, `[${agent}] said: ${clip(c.text, 200)}`]);
          }
          if (m.stopReason === 'error' || m.errorMessage) lines.push([at, `[${agent}] model error: ${clip(m.errorMessage || 'the model call failed', 200)}`]);
        } else if (m.role === 'toolResult' && m.isError) {
          const t = [].concat(m.content || []).map((c: any) => c?.text || '').join(' ');
          lines.push([at, `[${agent}] ${m.toolName || 'tool'} failed: ${clip(t.replace(/^\{?\s*"status":\s*"error",?/, ''), 220)}`]);
        }
      }
    } finally { db.close(); }
    store.set(markKey, mark);
  }
  if (lines.length) appendFileSync(join(logDir, 'activity.log'), lines.sort((a, b) => a[0] - b[0]).map(([t, l]) => `[${stamp(t)}] ${l}`).join('\n') + '\n');
}
