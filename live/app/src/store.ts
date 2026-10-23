// SQLite store (node:sqlite, built into Node 24): board posts, tasks, agent talk, small key/value state.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Post, Task, TaskStatus } from './rules.ts';
import { minuteOf } from './rules.ts';

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, at INTEGER NOT NULL,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL, cmd INTEGER NOT NULL DEFAULT 0, source TEXT);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, assignee TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, by_who TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_archive (batch TEXT NOT NULL, id TEXT NOT NULL, assignee TEXT, text TEXT, status TEXT,
        attempts INTEGER, by_who TEXT, created TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS talk (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, sender TEXT NOT NULL,
        recipient TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  // ---- key/value state ----
  get<T>(k: string, dflt: T): T { const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any; return r ? JSON.parse(r.v) : dflt; }
  set(k: string, v: unknown) { this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)); }

  // ---- board ----
  addPost(sender: string, recipient: string, body: string, opts: { now?: Date; cmd?: boolean; source?: string } = {}): Post {
    const now = opts.now ?? new Date();
    const r = this.db.prepare('INSERT INTO posts (ts, at, sender, recipient, body, cmd, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(minuteOf(now), now.getTime(), sender, recipient, body, opts.cmd ? 1 : 0, opts.source ?? null);
    return { id: Number(r.lastInsertRowid), ts: minuteOf(now), from: sender, to: recipient, body, cmd: !!opts.cmd };
  }
  posts(opts: { sinceId?: number; limit?: number } = {}): Post[] {
    const rows = opts.limit
      ? this.db.prepare('SELECT * FROM (SELECT * FROM posts WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(opts.sinceId ?? 0, opts.limit)
      : this.db.prepare('SELECT * FROM posts WHERE id > ? ORDER BY id').all(opts.sinceId ?? 0);
    return (rows as any[]).map((r) => ({ id: r.id, ts: r.ts, from: r.sender, to: r.recipient, body: r.body, cmd: !!r.cmd, at: r.at }) as Post);
  }
  lastPostId(): number { return Number((this.db.prepare('SELECT max(id) m FROM posts').get() as any).m ?? 0); }

  // ---- tasks ----
  tasks(): Task[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY CAST(substr(id, 2) AS INTEGER)').all() as any[])
      .map((r) => ({ id: r.id, assignee: r.assignee, text: r.text, status: r.status as TaskStatus, attempts: r.attempts, by: r.by_who, created: r.created, updated: r.updated }));
  }
  saveTasks(tasks: Task[]) {
    const up = this.db.prepare(`INSERT INTO tasks (id, assignee, text, status, attempts, by_who, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, updated = excluded.updated`);
    this.db.exec('BEGIN');
    try { for (const t of tasks) up.run(t.id, t.assignee, t.text, t.status, t.attempts, t.by, t.created, t.updated); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  /** Tasks finished since local midnight, archived ones included (an archive restarts numbering, not the day's count). */
  doneToday(): number {
    const d = new Date(); d.setHours(0, 0, 0, 0); const since = d.toISOString();
    const q = (t: string) => Number((this.db.prepare(`SELECT count(*) c FROM ${t} WHERE status = 'done' AND updated >= ?`).get(since) as any).c);
    return q('tasks') + q('task_archive');
  }
  /** Move every task to the archive (never deleted) and start numbering again at T1. */
  archiveTasks(batch: string): number {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO task_archive SELECT ?, id, assignee, text, status, attempts, by_who, created, updated FROM tasks').run(batch);
      const n = Number((this.db.prepare('SELECT count(*) c FROM tasks').get() as any).c);
      this.db.exec('DELETE FROM tasks; COMMIT');
      return n;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---- agent talk (say / read) ----
  say(sender: string, recipient: string, text: string) { this.db.prepare('INSERT INTO talk (at, sender, recipient, text) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), sender, recipient, text); }
  readTalk(me: string): { at: string; from: string; to: string; text: string }[] {
    const cursor = this.get<number>(`talk-cursor:${me}`, 0);
    const rows = this.db.prepare('SELECT * FROM talk WHERE id > ? ORDER BY id').all(cursor) as any[];
    if (rows.length) this.set(`talk-cursor:${me}`, rows[rows.length - 1].id);
    return rows.filter((r) => r.sender !== me && (r.recipient === me || r.recipient === 'all')).map((r) => ({ at: r.at, from: r.sender, to: r.recipient, text: r.text }));
  }
  close() { this.db.close(); }
}
