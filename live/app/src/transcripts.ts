// Read-only access to OpenClaw's per-agent transcript databases (for the relay, helper mirror and live view).
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const agentDb = (agent: string) => join(homedir(), '.openclaw', 'agents', agent, 'agent', 'openclaw-agent.sqlite');

/** Last non-empty assistant message of a session ('' when none). */
export function lastAssistantText(agent: string, sessionId: string): string {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(agentDb(agent), { readOnly: true });
    const row = db.prepare("SELECT text FROM session_transcript_fts WHERE session_id = ? AND role = 'assistant' AND length(trim(text)) > 0 ORDER BY CAST(timestamp AS INTEGER) DESC, rowid DESC LIMIT 1").get(sessionId) as any;
    return row ? String(row.text) : '';
  } catch { return ''; } finally { db?.close(); }
}

export function decodeEvent(r: { event_json?: string | null; event_zstd?: Uint8Array | null }): any {
  try { if (r.event_json) return JSON.parse(r.event_json); if (r.event_zstd) return JSON.parse(zstdDecompressSync(r.event_zstd).toString('utf8')); } catch {}
  return null;
}
