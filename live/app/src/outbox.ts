// Outbox ingestion (compatible with today's agent prompts): an agent posts by creating one file in the outbox,
// first line "to: <recipient>"; the author comes from a "from:" line or the file-name prefix.
import { readdirSync, readFileSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { Store } from './store.ts';
import { demoteHeadings, splitLiteralNewlines, normalise, isCommandOnly } from './rules.ts';

export interface Ingested { file: string; posted: boolean; from: string; to: string; reason?: string }

export function ingestOutbox(store: Store, dir: string, now = new Date()): Ingested[] {
  mkdirSync(join(dir, 'done'), { recursive: true });
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && ['.md', '.txt'].includes(extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, path: join(dir, e.name), mtime: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  const out: Ingested[] = [];
  for (const f of files) {
    if (now.getTime() - f.mtime < 5000) continue;   // still being written
    const raw = readFileSync(f.path, 'utf8').replace(/^﻿/, '').trim();
    let from = (/^(worker[2-8]?|main)\b/.exec(basename(f.name)) || [])[1] ?? 'agent';
    let to = 'all';
    const lines = raw.split(/\r?\n/);
    while (lines.length) {
      const m = /^\s*(to|from)\s*:\s*(\S+)/i.exec(lines[0]);
      if (!m) break;
      if (m[1].toLowerCase() === 'to') to = m[2]; else from = m[2];
      lines.shift();
    }
    const msg = splitLiteralNewlines(demoteHeadings(lines.join('\n')).trim());
    to = to.replace(/[^\w-]/g, '') || 'all';
    let posted = false, reason: string | undefined;
    // Small models re-create the same post: drop one identical to this agent's last 5 posts.
    const recent = store.posts({ limit: 200 }).filter((p) => p.from === from).slice(-5).map((p) => normalise(p.body));
    if (!msg) reason = 'empty';
    else if (recent.includes(normalise(msg))) reason = 'duplicate';
    else { store.addPost(from, to, msg, { now, cmd: isCommandOnly(msg), source: f.name }); posted = true; }
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    renameSync(f.path, join(dir, 'done', `${stamp}-${f.name}`));
    out.push({ file: f.name, posted, from, to, reason });
  }
  return out;
}
