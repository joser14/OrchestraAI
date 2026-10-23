// Compatibility with the C:\Agent file layout while Orchestra takes over (phases 1-2):
// SQLite is the source of truth; BOARD.md / tasks.json / TASKS.md are written from it every pass so the
// current dashboard, `ctl brief` and the agents' prompts keep working. Posts that others append straight to
// BOARD.md (the GUI's post box, an agent) are imported; a board an agent overwrote is simply rewritten.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';
import type { Post, Task } from './rules.ts';
import { normalise, isCommandOnly, minuteOf } from './rules.ts';
const minuteNow = () => minuteOf(new Date());

const POST_RE = /^## \[(.+?)\] (\S+) -> (\S+)\s*$/;
export function parseBoardMd(text: string): { header: string; posts: Omit<Post, 'id'>[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const posts: Omit<Post, 'id'>[] = []; const header: string[] = []; let cur: Omit<Post, 'id'> | null = null;
  for (const l of lines) {
    const m = POST_RE.exec(l);
    if (m) { cur = { ts: m[1], from: m[2], to: m[3], body: '' }; posts.push(cur); }
    else if (cur) cur.body += l + '\n'; else header.push(l);
  }
  for (const p of posts) p.body = p.body.trim();
  return { header: header.join('\n'), posts };
}
const key = (p: { ts: string; from: string; to: string; body: string }) => `${p.ts}|${p.from}|${p.to}|${normalise(p.body)}`;
const tsToDate = (ts: string) => { const d = new Date(ts.replace(' ', 'T')); return isNaN(+d) ? new Date() : d; };

export class Compat {
  store: Store; boardFile: string; tasksFile: string; tasksMd: string;
  constructor(store: Store, boardDir: string) {
    this.store = store; this.boardFile = join(boardDir, 'BOARD.md'); this.tasksFile = join(boardDir, 'tasks.json'); this.tasksMd = join(boardDir, 'TASKS.md');
  }

  /** First start: take over the existing board and task list. */
  importInitial(): { posts: number; tasks: number } {
    let posts = 0, tasks = 0;
    if (!this.store.lastPostId() && existsSync(this.boardFile)) {
      for (const p of parseBoardMd(readFileSync(this.boardFile, 'utf8')).posts) { this.store.addPost(p.from, p.to, p.body, { now: tsToDate(p.ts), cmd: isCommandOnly(p.body), source: 'import' }); posts++; }
    }
    if (!this.store.tasks().length && existsSync(this.tasksFile)) {
      try {
        const arr = [].concat(JSON.parse(readFileSync(this.tasksFile, 'utf8').replace(/^\uFEFF/, ''))).filter(Boolean) as Task[];
        this.store.saveTasks(arr); tasks = arr.length;
      } catch {}
    }
    this.store.set('exportedKeys', this.store.posts({ limit: 200 }).map(key));
    // Posts already on the board were handled by the old dispatcher: only posts after the takeover create tasks
    // (else every old TASK line - finished, cancelled or archived - would come back as a new task).
    if (posts) this.store.set('taskEpoch', minuteNow());
    return { posts, tasks };
  }

  /** Import posts appended to BOARD.md by others since our last export. Returns how many. */
  importExternal(): number {
    if (!existsSync(this.boardFile)) return 0;
    const known = new Set([...this.store.get<string[]>('exportedKeys', []), ...this.store.posts({ limit: 300 }).map(key)]);
    let n = 0;
    for (const p of parseBoardMd(readFileSync(this.boardFile, 'utf8')).posts) {
      if (known.has(key(p))) continue;
      this.store.addPost(p.from, p.to, p.body, { now: tsToDate(p.ts), cmd: isCommandOnly(p.body), source: 'BOARD.md' }); known.add(key(p)); n++;
    }
    return n;
  }

  /** Write BOARD.md (newest 60 posts), tasks.json and TASKS.md from the store (atomic replace). */
  exportAll(tasks: Task[]): number {
    // Others (the GUI's post box) append to BOARD.md at any moment: import what arrived during this pass right
    // before rewriting, and rewrite only when something changed, so an appended post is never overwritten.
    const late = this.importExternal();
    const cur = existsSync(this.boardFile) ? readFileSync(this.boardFile, 'utf8') : '';
    const header = cur ? parseBoardMd(cur).header.trim() : '# Agent Board';
    const posts = this.store.posts({ limit: 60 });
    const text = (header || '# Agent Board') + '\n\n' + posts.map((p) => `## [${p.ts}] ${p.from} -> ${p.to}\n${p.body}`).join('\n\n') + '\n';
    if (text !== cur.replace(/^﻿/, '')) {
      if (this.importExternal() === 0) atomicWrite(this.boardFile, text);   // still nothing new: safe to rewrite
    }
    this.store.set('exportedKeys', posts.map(key));
    atomicWrite(this.tasksFile, JSON.stringify(tasks, null, 2));
    const rows = tasks.map((t) => `| ${t.id} | ${t.assignee} | ${t.status} | ${t.attempts} | ${t.text.replace(/\|/g, '/')} |`);
    atomicWrite(this.tasksMd, ['# Tasks', '', 'Managed by Orchestra: main creates tasks with `TASK worker: ...`, workers close them with `DONE T<n>`, main or the user can `CANCEL T<n>`.', '',
      '| ID | For | Status | Tries | Task |', '|---|---|---|---|---|', ...rows].join('\n') + '\n');
    return late;
  }
}

export function atomicWrite(file: string, text: string) { const tmp = file + '.tmp'; writeFileSync(tmp, text); renameSync(tmp, file); }
