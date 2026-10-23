// Interpret step: before the brain plans, one narrow call to the local model rewrites jr's newest message as one
// clear, standalone instruction ("jr most likely means: ..."), shown at the top of the brain's agenda. A small model
// resolves "you missed one" far better as a single focused question than inside the long planning prompt (seen: told
// "a.tmp is still there", the brain assigned "check if a.tmp exists" and called it done).
//
// Practices it follows (conversational query rewriting / clarification research):
// - route first: only messages with recent conversation are rewritten; a standalone request costs nothing extra
// - resolve references ("it", "that one", "the same") to the exact thing named earlier; keep paths, file names and
//   task ids verbatim; never invent requirements
// - do not guess: an unresolvable message comes back as "unclear" with one clarifying question for jr
// - constrained output: Ollama structured output (JSON schema), temperature 0, then validated here; any failure or
//   timeout falls back to the plain agenda, so the step can only add information, never block a request
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Post, Task } from './rules.ts';
import { expectedFiles } from './rules.ts';

/** Ground truth for the rewrite: what is in each work-folder sub-folder the conversation names right now (seen:
 *  "the other tmp file too" came back "unclear" because the model could not see junk5 still held b.tmp). */
export function folderSnapshot(texts: string[], workDir: string, maxFiles = 20): string {
  let dirs: string[] = []; try { dirs = readdirSync(workDir).filter((d) => !d.startsWith('.') && statSync(join(workDir, d)).isDirectory()); } catch { return ''; }
  const all = texts.join('\n').toLowerCase();
  const named = dirs.filter((d) => new RegExp(`(^|[^\\w-])${d.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(all)).slice(0, 5);
  return named.map((d) => {
    let files: string[] = []; try { files = readdirSync(join(workDir, d)); } catch {}
    return `${join(workDir, d)} now contains: ${files.length ? files.slice(0, maxFiles).join(', ') + (files.length > maxFiles ? ` (+${files.length - maxFiles} more)` : '') : '(empty)'}`;
  }).join('\n');
}

export type Kind = 'new_request' | 'follow_up' | 'correction' | 'question' | 'chit_chat' | 'unclear';
export interface Interpretation { kind: Kind; means: string; refersTo: string; confidence: 'high' | 'medium' | 'low'; ask: string; ms?: number; snapshot?: string }

const KINDS: Kind[] = ['new_request', 'follow_up', 'correction', 'question', 'chit_chat', 'unclear'];
const WINDOW_MS = 30 * 60000;
const at = (p: Post) => Date.parse(p.ts.replace(' ', 'T'));
const clip = (s: string, n: number) => { s = s.replace(/_\(relayed:[^)]*\)_/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** The posts that give jr's message its meaning: jr, main's answers to jr and workers' results, last 30 min. */
export function conversationBefore(posts: Post[], msg: Post, workers: string[], max = 8): Post[] {
  const t0 = at(msg);
  return posts.filter((p) => p.id < msg.id && t0 - at(p) < WINDOW_MS && !p.cmd
    && (p.from === 'jr' || ((p.from === 'main' || p.from === 'main-relay') && p.to === 'jr') || (workers.includes(p.from) && /^\s*DONE\s+T\d+/i.test(p.body))))
    .slice(-max);
}

/** Check a finished job against the folders as they are now, for what can be checked without a model:
 *  "delete/remove a.tmp" -> gone, "delete the .tmp files" -> none left, "keep keep.txt" -> still there, in each
 *  work sub-folder the job names (or the work folder itself). The brain sees the result in its agenda (seen: the
 *  worker's command matched nothing, it reported "deleted", and the brain passed that on to jr). */
export function verifyFiles(text: string, workDir: string): { problems: string[]; checked: number } {
  const snap = folderSnapshot([text], workDir, 1000);
  const dirs = snap ? snap.split('\n').map((l) => l.replace(/ now contains:.*$/, '')) : [workDir];
  const list = (d: string) => { try { return readdirSync(d); } catch { return null; } };
  const problems: string[] = []; let checked = 0;
  const low = text.toLowerCase();
  const ext = [...low.matchAll(/(?:delete|remove|clean(?: up)?|get rid of)\b[^.]{0,40}?\*?\.([a-z0-9]{1,6}) files/g)].map((m) => m[1]);
  const named = [...low.matchAll(/(?:delete|remove|get rid of)\s+(?:the\s+)?(?:file\s+)?['"`]?([\w-]+\.[a-z0-9]{1,6})\b/g)].map((m) => m[1]);
  const keep = [...low.matchAll(/\bkeep(?:ing)?\s+(?:the\s+)?(?:file\s+)?['"`]?([\w-]+\.[a-z0-9]{1,6})\b/g)].map((m) => m[1]);
  for (const d of dirs) {
    const files = list(d); if (!files) continue;
    const lc = files.map((f) => f.toLowerCase());
    for (const e of ext) { checked++; const left = files.filter((f) => f.toLowerCase().endsWith('.' + e)); if (left.length) problems.push(`${left.join(', ')} still in ${d} (the job said to delete the .${e} files)`); }
    for (const n of named) { checked++; if (lc.includes(n)) problems.push(`${n} still exists in ${d} (the job said to delete it)`); }
    for (const k of keep) { checked++; if (!lc.includes(k)) problems.push(`${k} is gone from ${d} (the job said to keep it)`); }
  }
  // move / rename: the old name is gone, the new one is there (a folder target means <folder>/<file>)
  const exists = (p: string) => { try { statSync(p); return true; } catch { return false; } };
  const inDirs = (name: string) => [workDir, ...dirs].some((d) => exists(join(d, name)));
  for (const m of text.matchAll(/\b(?:move|rename)\s+(?:the\s+)?(?:file\s+)?['"`]?([\w.-]+\.[a-z0-9]{1,6})['"`]?\s+(?:to|into|as)\s+(?:the\s+)?(?:folder\s+)?['"`]?([\w.-]+)['"`]?/gi)) {
    const [, from, to] = m; checked++;
    // the old copy, looked for everywhere but the target folder (where the moved file now rightly is)
    const sources = [workDir, ...dirs].filter((d) => basename(d).toLowerCase() !== to.toLowerCase());
    if (to.toLowerCase() !== from.toLowerCase() && sources.some((d) => exists(join(d, from)))) problems.push(`${from} is still where it was (the job said to move or rename it)`);
    const target = /\.[a-z0-9]{1,6}$/i.test(to) ? inDirs(to) : [workDir, ...dirs].some((d) => exists(join(d, to, from)));
    if (!target) problems.push(`${/\.[a-z0-9]{1,6}$/i.test(to) ? to : `${to}/${from}`} does not exist (the job said to move or rename ${from} there)`);
  }
  // create a folder: it exists
  for (const m of text.matchAll(/\b(?:create|make)\s+(?:a\s+)?(?:new\s+)?(?:folder|directory)\s+(?:called\s+|named\s+)?['"`]?([\w.-]+)['"`]?/gi)) {
    checked++; if (![workDir, ...dirs].some((d) => { try { return statSync(join(d, m[1])).isDirectory(); } catch { return false; } })) problems.push(`the folder ${m[1]} was not created`);
  }
  // PDFs the job names: a real PDF, not an empty or broken file
  for (const p of expectedFiles(text, workDir).filter((f) => /\.pdf$/i.test(f) && exists(f))) {
    checked++;
    try { const fd = openSync(p, 'r'); const b = Buffer.alloc(5); readSync(fd, b, 0, 5, 0); closeSync(fd); if (b.toString('latin1') !== '%PDF-' || statSync(p).size < 1024) problems.push(`${basename(p)} is not a valid PDF (empty or broken): make it again with team_pdf`); }
    catch { problems.push(`${basename(p)} could not be read`); }
  }
  return { problems, checked };
}

/** Route: rewrite only when there is conversation to resolve against. */
export function needsInterpret(posts: Post[], msg: Post, workers: string[]): boolean {
  return conversationBefore(posts, msg, workers).length > 0 && dependsOnContext(msg.body);
}

// Words that only make sense with the conversation before them: references, follow-ups, complaints.
const DEPENDENT = /\b(it|its|that|this|those|these|them|they|one|ones|other|others|same|again|still|also|too|instead|either|rest|more|less|missed|didn'?t|did not|doesn'?t|not done|wrong|failed|fix|redo|undo|retry|why|stuck|what about|how about|what are you doing|as well|like before|last time|previous|earlier|above)\b/i;
/** A message needs the conversation to be understood: short (fewer than 10 words) or with a word like "it", "the
 *  other", "again", "missed". A long, self-contained request ("Write a haiku about GPUs to haiku.md") goes straight
 *  to the brain - the rewrite only cost time there (seen: 11 s added to a clear request). */
export function dependsOnContext(body: string): boolean {
  const text = String(body || '').trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  return words < 10 || DEPENDENT.test(text);
}

export const SYSTEM = `You read a short chat between jr (the boss) and an AI team, and rewrite jr's LATEST message as ONE clear,
standalone instruction the team can act on without seeing the chat.
Rules:
- Use the conversation and the task list only to work out what jr's latest message refers to. Replace words like
  "it", "that", "the same", "one", "there" with the exact thing named earlier (folder, file, task id).
- Copy paths, file names, folder names and task ids exactly as they appear.
- If jr says earlier work is wrong, missing or not done, say plainly what must be fixed or redone, and name the task.
- Do not add requirements jr did not ask for. Do not explain. Do not answer jr.
- If the latest message already stands on its own, repeat its meaning in clear words.
- If you cannot tell what jr means, set kind "unclear", confidence "low", and write one short question for jr in "ask".
kind: new_request (a new job), follow_up (more about the last job), correction (earlier work is wrong or incomplete),
question (jr asks about the team or a result), chit_chat (greeting/thanks), unclear.`;

export const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS },
    means: { type: 'string', description: 'one clear standalone instruction' },
    refers_to: { type: 'string', description: 'task id like T4 that the message is about, or empty' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    ask: { type: 'string', description: 'one clarifying question for jr when unclear, else empty' },
  },
  required: ['kind', 'means', 'refers_to', 'confidence', 'ask'],
};

/** The user turn: the conversation, the recent tasks (with each worker's note), and jr's latest message. */
export function buildPrompt(msg: Post, convo: Post[], tasks: Task[], workDir: string, snapshot = ''): string {
  const lines = convo.map((p) => `${p.from}: ${clip(p.body, 400)}`);
  const recent = tasks.slice(-6).map((t) => `${t.id} [${t.status}] for ${t.assignee}: ${clip(t.text, 220)}`);
  return [`Work folder: ${workDir}`, '', 'Recent tasks:', ...(recent.length ? recent : ['none']),
    ...(snapshot ? ['', 'Folders mentioned, as they are right now (trust this over what anyone claimed):', snapshot] : []), '', 'Conversation (oldest first):', ...lines, '',
    `jr's LATEST message: ${clip(msg.body, 600)}`, '', 'Answer with the JSON object only.'].join('\n');
}

/** Validate the model's JSON; null when it is unusable (the agenda then shows jr's message as it is). */
export function parseInterpretation(raw: string, tasks: Pick<Task, 'id'>[]): Interpretation | null {
  let j: any; try { j = JSON.parse(String(raw).trim().replace(/^```(?:json)?|```$/g, '')); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const means = clip(String(j.means || ''), 500);
  if (means.length < 3) return null;
  const kind: Kind = KINDS.includes(j.kind) ? j.kind : 'new_request';
  const confidence = ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'medium';
  const ref = String(j.refers_to || '').toUpperCase().trim();
  return { kind, means, confidence, refersTo: /^T\d+$/.test(ref) && tasks.some((t) => t.id === ref) ? ref : '', ask: clip(String(j.ask || ''), 200) };
}

/** One call to Ollama with thinking on and the JSON schema; throws on HTTP errors or timeout. */
export async function callModel(model: string, prompt: string, timeoutMs = 60000, think: boolean | string = true): Promise<string> {
  const r = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, stream: false, think, format: SCHEMA, options: { temperature: 0 },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j: any = await r.json();
  return String(j?.message?.content || '');
}

/** The agenda lines for an interpretation (first line goes at the top of NEEDS YOU). */
export function agendaHint(i: Interpretation, task?: Task): string {
  let s = `jr most likely means: "${i.means}"`;
  if ((i.kind === 'correction' || i.kind === 'follow_up') && task)
    s += `\n   This is about ${task.id} (${clip(task.text, 160)}). jr says it is not right yet: assign the fix itself (redo it properly, naming what to change). Do not assign a job that only checks.`;
  else if (i.kind === 'question') s += '\n   jr asked a question: answer it with team_post to jr if the brief has the answer; otherwise assign a worker to find out.';
  else if (i.kind === 'chit_chat') s += '\n   No job needed: reply to jr in one short line (team_post).';
  if (i.snapshot) s += `\n   Right now: ${i.snapshot.replace(/\n/g, '; ')}. Use these exact names; never invent a folder or file.`;
  if (i.kind === 'unclear' || i.confidence === 'low') s += `\n   Not sure? Ask jr instead of guessing${i.ask ? `: "${i.ask}"` : ''} (team_post to jr).`;
  return s;
}
