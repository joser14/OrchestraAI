// Pure team rules: TASK / DONE / CANCEL / MODEL / TOOLS lines and the checks on finished tasks.
// No I/O here: the orchestrator feeds posts/tasks in and applies what comes back.

export type Agent = string;   // 'main' or a worker: worker, worker2 ... worker8 (see team.ts)
const isWorkerName = (s: string) => /^worker[2-8]?$/.test(s);
export type TaskStatus = 'open' | 'stuck' | 'done' | 'cancelled';
export interface Post { id: number; ts: string; from: string; to: string; body: string; cmd?: boolean }
export interface Task {
  id: string; assignee: string; text: string; status: TaskStatus; attempts: number;
  by: string; created: string; updated: string;
}

/** Who may create, cancel and pick models: the brain, its chat window, and the user. */
export const COMMANDERS = new Set(['main', 'main-chat', 'user']);

/** "## " in an agent's text would start a fake post; demote it. */
export const demoteHeadings = (s: string) => s.replace(/^## /gm, '### ');

/** Small models write a literal \n between command lines ("...md\nTASK worker2: ..."). Split only before a
 * command word: Windows paths like D:\work\notes also contain \n. */
export const splitLiteralNewlines = (s: string) => s.replace(/\\n(?=\s*(TASK|MODEL|TOOLS|CANCEL|DONE)\b)/g, '\n');

/** Text copied from instructions / examples instead of a real job. */
export function isPlaceholderTask(text: string): boolean {
  return text.length < 15 ||
    /<[^>]+>|what (the worker|to do|it should do)|^(the )?task( text)?$|^\.\.\.$|^JOB$/i.test(text);
}

/** A post that only carries command lines is not an answer to the user (used by the relay). */
export const isCommandOnly = (body: string) =>
  !body.split(/\r?\n/).some((l) => l.trim() && !/^\W*(TASK|MODEL|TOOLS|CANCEL)\b/i.test(l));

export interface ParsedCommands {
  tasks: { assignee: string; text: string }[];
  cancels: string[];
  dones: string[];
  models: { agent: string; alias: string }[];
  tools: { agent: string; groups: string[] }[];
}
export function parseCommands(body: string): ParsedCommands {
  const out: ParsedCommands = { tasks: [], cancels: [], dones: [], models: [], tools: [] };
  for (const m of body.matchAll(/^\W*TASK\s+(worker[2-8]?)\s*[:=-]\s*(.{5,500})$/gim)) out.tasks.push({ assignee: m[1].toLowerCase(), text: m[2].trim() });
  for (const m of body.matchAll(/\bCANCEL\s+(T\d+)\b/gi)) out.cancels.push(m[1].toUpperCase());
  for (const m of body.matchAll(/\bDONE\s+(T\d+)\b/gi)) out.dones.push(m[1].toUpperCase());
  for (const m of body.matchAll(/^\W*MODEL\s+(worker[2-8]?|main)\s*[=:]\s*([a-z][a-z0-9]*)\b/gim)) out.models.push({ agent: m[1].toLowerCase(), alias: m[2].toLowerCase() });
  for (const m of body.matchAll(/^\W*TOOLS\s+(worker[2-8]?)\s*[=:]\s*([a-z ,]+)$/gim)) out.tools.push({ agent: m[1].toLowerCase(), groups: m[2].toLowerCase().split(/[ ,]+/).filter(Boolean) });
  return out;
}

/** Files under the work folder that a task text names (with an extension). */
export function workPaths(text: string, workDir: string): string[] {
  const out = new Set<string>();
  // Paths into this PC's work folder (any data root, written with / or \).
  const norm = (s: string) => s.replace(/\//g, '\\').toLowerCase();
  const roots = [norm(workDir).replace(/\\+$/, '')];
  const sep = workDir.includes('/') && !workDir.includes('\\') ? '/' : '\\';
  for (const raw of text.split(/[\s"'`,;()<>|*?]+/)) {
    const tok = raw.replace(/[.:]+$/, ''); const n = norm(tok);
    const root = roots.find((r) => n.startsWith(r + '\\')); if (!root) continue;
    const rel = tok.slice(root.length + 1).replace(/[\\/]/g, sep);
    if (/\.\w{1,5}$/.test(rel)) out.add(workDir.replace(/[\\/]+$/, '') + sep + rel);
  }
  return [...out];
}

/** Everything a task must produce before it counts as done: the files it names, plus the .pdf of a named .md
 *  when the task asks for a PDF ("... then make it a PDF with team_pdf" names only the .md). */
export function expectedFiles(text: string, workDir: string): string[] {
  const files = workPaths(text, workDir);
  if (/\bpdf\b|team_pdf/i.test(text)) for (const f of [...files]) if (/\.md$/i.test(f)) { const pdf = f.replace(/\.md$/i, '.pdf'); if (!files.some((x) => x.toLowerCase() === pdf.toLowerCase())) files.push(pdf); }
  return files;
}

export const minuteOf = (iso: string | Date) => {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export interface FileInfo { exists: boolean; size: number; mtimeMs: number }
export type Stat = (path: string) => FileInfo;

export interface RuleEffects {
  created: Task[]; cancelled: Task[]; done: Task[];
  rejected: { task: Task; to: string; missing: string[] }[];
  ignoredPlaceholders: string[];
}

/**
 * Apply every post's commands to the task list (idempotent: posts are re-read every pass).
 * - TASK lines from commanders create tasks (deduped by assignee+text; placeholders ignored; not from before the epoch)
 * - CANCEL only from commanders, and only for a task created no later than the post
 * - DONE closes a task only if every work file it names exists and is non-empty; workers get told what is missing
 */
export function applyPosts(posts: Post[], tasks: Task[], opts: {
  now: Date; epoch?: string; workDir: string; stat: Stat; seenRejections: Set<string>;
}): RuleEffects {
  const fx: RuleEffects = { created: [], cancelled: [], done: [], rejected: [], ignoredPlaceholders: [] };
  const byId = (id: string) => tasks.find((t) => t.id === id);
  const nextId = () => 'T' + (1 + Math.max(0, ...tasks.map((t) => Number(t.id.replace(/\D/g, '')) || 0)));
  const nowIso = opts.now.toISOString();
  for (const p of posts) {
    const c = parseCommands(p.body);
    if (COMMANDERS.has(p.from)) {
      if (!(opts.epoch && p.ts < opts.epoch)) {
        for (const t of c.tasks) {
          if (tasks.some((x) => x.assignee === t.assignee && x.text === t.text)) continue;
          if (isPlaceholderTask(t.text)) { fx.ignoredPlaceholders.push(t.text); continue; }
          const task: Task = { id: nextId(), assignee: t.assignee, text: t.text, status: 'open', attempts: 0, by: p.from, created: nowIso, updated: nowIso };
          tasks.push(task); fx.created.push(task);
        }
      }
      for (const id of c.cancels) {
        const t = byId(id);
        if (t && t.status !== 'done' && t.status !== 'cancelled' && p.ts >= minuteOf(t.created)) { t.status = 'cancelled'; t.updated = nowIso; fx.cancelled.push(t); }
      }
    }
    for (const id of c.dones) {
      const t = byId(id);
      if (!t || (t.status !== 'open' && t.status !== 'stuck')) continue;
      if (p.ts < minuteOf(t.created)) continue;   // an older post about a previous task with the same id
      const missing = expectedFiles(t.text, opts.workDir).filter((f) => { const s = opts.stat(f); return !s.exists || s.size === 0; });
      if (missing.length && isWorkerName(p.from)) {
        const key = `donechk:${t.id}:${p.from}:${p.body.trim().length}`;
        if (!opts.seenRejections.has(key)) { opts.seenRejections.add(key); fx.rejected.push({ task: t, to: p.from, missing }); }
        continue;
      }
      t.status = 'done'; t.updated = nowIso; fx.done.push(t);
    }
  }
  return fx;
}

/** Workers often do the work but forget "DONE": close a started task once all its named files exist, are
 * non-empty and were written after the task was created. */
/** Smallest believable size of a finished file: a PDF with any text, a note with a few lines; other types anything. */
export const minBytes = (f: string) => (/\.pdf$/i.test(f) ? 1000 : /\.(md|txt|csv|html?|json)$/i.test(f) ? 40 : 1);

export function autoDone(tasks: Task[], workDir: string, stat: Stat, now: Date): Task[] {
  const closed: Task[] = [];
  for (const t of tasks) {
    if ((t.status !== 'open' && t.status !== 'stuck') || t.attempts < 1) continue;
    const files = expectedFiles(t.text, workDir);
    if (!files.length) continue;
    const created = Date.parse(t.created);
    // Verified in code, not by the model: each file must be new since the task began and more than an empty stub.
    if (files.every((f) => { const s = stat(f); return s.exists && s.size >= minBytes(f) && s.mtimeMs >= created; })) {
      t.status = 'done'; t.updated = now.toISOString(); closed.push(t);
    }
  }
  return closed;
}

/** All finished and idle for an hour -> archive and restart numbering at T1. */
export const shouldRenumber = (tasks: Task[], now: Date) =>
  tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'cancelled') &&
  tasks.every((t) => now.getTime() - Date.parse(t.updated) >= 60 * 60000);

/** Board guard: posts missing from the board compared to the last snapshot = an agent overwrote it. */
export function guardBoard(snapshotPosts: string[], currentPosts: string[]) {
  const missing = snapshotPosts.filter((p) => !currentPosts.includes(p));
  const added = currentPosts.filter((p) => !snapshotPosts.includes(p));
  return { overwritten: missing.length > 0, restored: [...snapshotPosts, ...added], missing: missing.length, added: added.length };
}

/** Normalised text for duplicate-post detection (an agent re-sending the same message). */
export const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
