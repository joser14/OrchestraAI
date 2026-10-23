// Learned memory: durable facts the team picks up from conversations, kept in memory/learned.md (plain Markdown,
// edited on the Memory page). Design taken from the leading open-source memory systems:
//   - mem0: extract facts from jr's and the team's messages (ignore small talk), then decide per fact against what is
//     stored: ADD, UPDATE (same topic, better wording), DELETE (contradicted), NONE (already known)
//   - Agent Zero: separate kinds - preference (how jr likes things), fact (about jr / the setup), solution (what worked,
//     or what failed and the fix, for a kind of task)
//   - CrewAI: recall ranked by 0.5 x relevance + 0.3 x recency (30-day half-life) + 0.2 x importance
//   - pipeline-managed, run while the team is idle: small local models handle one narrow call far better than
//     managing their own memory mid-task
// One line per entry:  - [kind|importance|YYYY-MM-DD] text
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Post } from './rules.ts';

export type LearnKind = 'preference' | 'fact' | 'solution';
export interface Learned { id: number; kind: LearnKind; importance: number; date: string; text: string }
const KINDS: LearnKind[] = ['preference', 'fact', 'solution'];
export const MAX_ENTRIES = 60;
export const learnedFile = (cfg: Config) => join(cfg.root, 'memory', 'learned.md');
const HEADER = '# Learned\n\nWhat the team picked up from your conversations (Orchestra keeps this list; edit or delete any line).\nFormat: - [kind|importance 0-1|date] text   (kinds: preference, fact, solution)\n\n';

export function parseLearned(text: string): Learned[] {
  const out: Learned[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*-\s*\[(preference|fact|solution)\|([01](?:\.\d+)?)\|(\d{4}-\d{2}-\d{2})\]\s*(.+?)\s*$/i.exec(line);
    if (m) out.push({ id: out.length + 1, kind: m[1].toLowerCase() as LearnKind, importance: Math.max(0, Math.min(1, Number(m[2]))), date: m[3], text: m[4] });
  }
  return out;
}
export const formatLearned = (items: Learned[]) => HEADER + items.map((i) => `- [${i.kind}|${i.importance.toFixed(1)}|${i.date}] ${i.text.replace(/\s+/g, ' ').trim()}`).join('\n') + (items.length ? '\n' : '');
export function readLearned(cfg: Config): Learned[] { try { return parseLearned(readFileSync(learnedFile(cfg), 'utf8')); } catch { return []; } }
export function writeLearned(cfg: Config, items: Learned[]) { mkdirSync(join(cfg.root, 'memory'), { recursive: true }); writeFileSync(learnedFile(cfg), formatLearned(items)); }

const words = (s: string) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const STOP = new Set('the and for with that this from into your you are was were will have has had not but all any can our out its use using when what which then than them they their there about would should could also just only more most some such very each over under file files folder work'.split(' '));
export function similarity(a: string, b: string): number {
  const A = words(a), B = words(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface Change { event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'; id?: number; kind?: string; text?: string; importance?: number }
/** Apply the model's decisions to the stored list (validated: unknown ids, near-duplicate ADDs and bad kinds are
 *  ignored), then keep the best MAX_ENTRIES by importance and recency. Returns the new list and what changed. */
export function applyChanges(items: Learned[], changes: Change[], today: string): { items: Learned[]; added: number; updated: number; deleted: number } {
  let list = items.map((i) => ({ ...i })); let added = 0, updated = 0, deleted = 0;
  const byId = (id?: number) => list.find((i) => i.id === Number(id));
  for (const c of changes || []) {
    const text = String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const kind = (KINDS.includes(c.kind as LearnKind) ? c.kind : 'fact') as LearnKind;
    const importance = Math.max(0, Math.min(1, Number.isFinite(Number(c.importance)) ? Number(c.importance) : .5));
    if (c.event === 'ADD' && text.length >= 8) {
      const twin = list.find((i) => similarity(i.text, text) >= .8);
      if (twin) continue;   // already known (mem0's NONE), even if the model said ADD
      list.push({ id: 0, kind, importance, date: today, text }); added++;
    } else if (c.event === 'UPDATE' && byId(c.id) && text.length >= 8) {
      const it = byId(c.id)!; it.text = text; it.kind = kind; it.importance = Math.max(it.importance, importance); it.date = today; updated++;
    } else if (c.event === 'DELETE' && byId(c.id)) { list = list.filter((i) => i.id !== Number(c.id)); deleted++; }
  }
  const age = (d: string) => Math.max(0, (Date.parse(today) - Date.parse(d)) / 86400000);
  list = list.map((i) => ({ ...i, _s: i.importance * .6 + Math.pow(.5, age(i.date) / 30) * .4 } as any)).sort((a: any, b: any) => b._s - a._s).slice(0, MAX_ENTRIES)
    .map(({ _s, ...i }: any, n: number) => ({ ...i, id: n + 1 }));
  return { items: list, added, updated, deleted };
}

/** CrewAI-style recall: 0.5 x relevance to the task + 0.3 x recency (30-day half-life) + 0.2 x importance. */
export function recall(items: Learned[], query: string, kinds: LearnKind[], limit: number, now = new Date()): Learned[] {
  const age = (d: string) => Math.max(0, (now.getTime() - Date.parse(d)) / 86400000);
  return items.filter((i) => kinds.includes(i.kind))
    .map((i) => ({ i, s: .5 * (query ? similarity(i.text, query) : .5) + .3 * Math.pow(.5, age(i.date) / 30) + .2 * i.importance }))
    .sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.i);
}

export const LEARN_SYSTEM = `You keep the long-term memory of an AI team that works for jr. You get a recent conversation between jr and the
team, and the memory as it is (numbered). Decide what to change so the team does better next time.
Remember only what stays true beyond this one job:
- preference: how jr likes things done (formats, length, style, tools, naming, what jr dislikes)
- fact: lasting facts about jr, jr's projects or this PC's setup
- solution: for a KIND of task, what worked, or what failed and the fix (e.g. "On this PC the shell is PowerShell: delete with Remove-Item 'dir\\*.tmp'")
Ignore greetings, thanks, one-off task contents, and anything already in memory.
For each fact: ADD (new), UPDATE id (same topic, better or newer wording), DELETE id (the conversation shows it is wrong),
or nothing. Write each memory as one short, plain sentence. importance: 0.9 for explicit instructions from jr, 0.6 for
clear patterns, 0.3 for weak hints. Return {"changes": []} when nothing is worth keeping.`;

export const LEARN_SCHEMA = {
  type: 'object',
  properties: { changes: { type: 'array', items: { type: 'object', properties: {
    event: { type: 'string', enum: ['ADD', 'UPDATE', 'DELETE'] }, id: { type: 'integer' }, kind: { type: 'string', enum: KINDS },
    text: { type: 'string' }, importance: { type: 'number' } }, required: ['event'] } } },
  required: ['changes'],
};

export function learnPrompt(convo: Post[], items: Learned[]): string {
  const clip = (s: string, n: number) => { s = s.replace(/_\(relayed:[^)]*\)_/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  return ['Memory now:', ...(items.length ? items.map((i) => `${i.id}. [${i.kind}] ${i.text}`) : ['(empty)']), '',
    'Recent conversation (oldest first):', ...convo.map((p) => `${p.from}: ${clip(p.body, 500)}`), '', 'Answer with the JSON object only.'].join('\n');
}

/** One call to the local model with the JSON schema; returns the parsed changes (empty on any problem). */
export async function askModel(model: string, prompt: string, timeoutMs = 90000): Promise<Change[]> {
  const r = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, stream: false, think: false, format: LEARN_SCHEMA, options: { temperature: 0 },
      messages: [{ role: 'system', content: LEARN_SYSTEM }, { role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j: any = await r.json();
  try { const out = JSON.parse(String(j?.message?.content || '{}')); return Array.isArray(out.changes) ? out.changes : []; } catch { return []; }
}

/** For the briefs: what the composer should keep in mind, and the solutions closest to a worker's task. */
export function learnedForBrief(cfg: Config, task = ''): string {
  const items = readLearned(cfg); if (!items.length) return '';
  const prefs = recall(items, task, ['preference', 'fact'], 10);
  const sols = task ? recall(items, task, ['solution'], 3).filter((s) => similarity(s.text, task) > .05) : recall(items, '', ['solution'], 4);
  const L = [...prefs.map((i) => `- ${i.text}`), ...sols.map((i) => `- (worked before) ${i.text}`)];
  return L.length ? ['=== LEARNED (from past conversations - use it) ===', ...L].join('\n') : '';
}

export { existsSync };
