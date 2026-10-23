// Work-folder changes as events (Flow page > Output): files the team added and removed, so a deletion shows up as
// clearly as a new PDF. Each orchestrator tick compares the folder with the previous listing.
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Store } from './store.ts';

export interface FileEvent { at: number; kind: 'added' | 'removed'; path: string }

/** Every file under the work folder (3 levels, dot-folders such as .git and .trash skipped), relative paths. */
export function listAll(work: string, max = 5000): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || out.length >= max) return; let es: any[] = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { if (e.name.startsWith('.')) continue; const f = join(d, e.name); if (e.isDirectory()) walk(f, depth + 1); else out.push(f.slice(work.length + 1).split(sep).join('/')); }
  };
  walk(work, 0); return out;
}

/** What changed between two listings. */
export function diffFiles(before: string[], after: string[], at: number): FileEvent[] {
  const a = new Set(after), b = new Set(before);
  return [...before.filter((p) => !a.has(p)).map((path) => ({ at, kind: 'removed' as const, path })), ...after.filter((p) => !b.has(p)).map((path) => ({ at, kind: 'added' as const, path }))];
}

/** Compare with the last listing and keep the newest 60 events. The first run only records the baseline. */
export function trackWorkFiles(store: Store, work: string, log: (m: string) => void = () => {}) {
  const now = listAll(work); const prev = store.get<string[] | null>('workListing', null);
  store.set('workListing', now);
  if (!prev) return;
  const ev = diffFiles(prev, now, Date.now()); if (!ev.length) return;
  store.set('fileEvents', [...ev, ...store.get<FileEvent[]>('fileEvents', [])].slice(0, 60));
  const gone = ev.filter((e) => e.kind === 'removed');
  if (gone.length) log(`work folder: removed ${gone.slice(0, 6).map((e) => e.path).join(', ')}${gone.length > 6 ? ` (+${gone.length - 6} more)` : ''}`);
}
