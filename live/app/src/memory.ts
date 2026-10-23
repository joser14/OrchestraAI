// Memory page: the team's memory files in one place, read and edited from the dashboard.
//   team      memory/memory.md - jr's standing notes; every agent reads it in its brief (brief.ts teamMemory)
//   shared    memory/*.md      - other shared notes
//   per agent agents/<a>/MEMORY.md (its long-term notes), agents/<a>/USER.md (what it knows about jr),
//             agents/<a>/memory/*.md (OpenClaw's dated daily notes)
// Files are addressed by an id built from this fixed layout, never by a path from the page, so nothing outside
// these folders can be read or written.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Config } from './config.ts';

export interface MemFile { id: string; group: string; label: string; about: string; size: number; mtime: number; exists: boolean; readonly?: boolean }
/** Files Orchestra itself rewrites (team rules): shown, never saved from the page. */
const READONLY = /\/AGENTS\.md$/;
const MD = /^[\w .-]{1,80}\.md$/;
const TEAM_ABOUT = 'Your standing notes for the whole team. Every agent reads this at the start of each run: preferences, facts, rules.';

const teamFile = (cfg: Config) => join(cfg.root, 'memory', 'memory.md');

/** Resolve an id to its file, or null when the id is not one of the allowed memory files. */
export function memPath(cfg: Config, id: string): string | null {
  const m = /^(team|shared|agent):(.+)$/.exec(String(id || '')); if (!m) return null;
  if (m[1] === 'team') return m[2] === 'memory.md' ? teamFile(cfg) : null;
  if (m[1] === 'shared') return MD.test(m[2]) && !m[2].includes('..') ? join(cfg.root, 'memory', m[2]) : null;
  const [agent, ...rest] = m[2].split('/'); if (!cfg.agents.includes(agent)) return null;
  const file = rest.join('/');
  if (['MEMORY.md', 'USER.md', 'SOUL.md', 'IDENTITY.md', 'AGENTS.md'].includes(file)) return join(cfg.root, 'agents', agent, file);
  const d = /^memory\/([\w .-]{1,80}\.md)$/.exec(file); return d && !d[1].includes('..') ? join(cfg.root, 'agents', agent, 'memory', d[1]) : null;
}

const info = (p: string) => { try { const s = statSync(p); return { size: s.size, mtime: s.mtimeMs, exists: true }; } catch { return { size: 0, mtime: 0, exists: false }; } };
const mds = (dir: string) => { try { return readdirSync(dir).filter((f) => MD.test(f)); } catch { return []; } };

export function listMemory(cfg: Config): MemFile[] {
  const out: MemFile[] = [{ id: 'team:memory.md', group: 'Team', label: 'memory.md', about: TEAM_ABOUT, ...info(teamFile(cfg)) }];
  for (const f of mds(join(cfg.root, 'memory')).filter((f) => f !== 'memory.md').sort())
    out.push({ id: `shared:${f}`, group: 'Shared notes', label: f, about: 'a shared note in the memory folder', ...info(join(cfg.root, 'memory', f)) });
  for (const a of cfg.agents) {
    const ws = join(cfg.root, 'agents', a); if (!existsSync(ws)) continue;
    out.push({ id: `agent:${a}/MEMORY.md`, group: a, label: 'MEMORY.md', about: `${a}'s long-term notes`, ...info(join(ws, 'MEMORY.md')) });
    out.push({ id: `agent:${a}/USER.md`, group: a, label: 'USER.md', about: `what ${a} knows about you`, ...info(join(ws, 'USER.md')) });
    // persona: who the agent is and how it behaves (OpenClaw loads these every session)
    out.push({ id: `agent:${a}/SOUL.md`, group: a, label: 'SOUL.md', about: `${a}'s personality and values`, ...info(join(ws, 'SOUL.md')) });
    out.push({ id: `agent:${a}/IDENTITY.md`, group: a, label: 'IDENTITY.md', about: `${a}'s name, role and style`, ...info(join(ws, 'IDENTITY.md')) });
    out.push({ id: `agent:${a}/AGENTS.md`, group: a, label: 'AGENTS.md', about: 'team rules Orchestra writes on every sync (read only here)', readonly: true, ...info(join(ws, 'AGENTS.md')) });
    for (const f of mds(join(ws, 'memory')).sort().reverse().slice(0, 20))
      out.push({ id: `agent:${a}/memory/${f}`, group: a, label: `daily: ${f}`, about: `${a}'s note from ${f.replace(/\.md$/, '')}`, ...info(join(ws, 'memory', f)) });
  }
  return out;
}

export function readMemory(cfg: Config, id: string): { id: string; text: string } {
  const p = memPath(cfg, id); if (!p) throw new Error('not a memory file');
  let text = ''; try { text = readFileSync(p, 'utf8'); } catch {}
  if (!text && id === 'team:memory.md') text = '# Team memory\n\nNotes every agent reads at the start of each run.\n\n- \n';
  return { id, text: text.length > 400000 ? text.slice(0, 400000) + '\n…(cut: file too large to show)' : text };
}

export function saveMemory(cfg: Config, id: string, text: string): { ok: true; msg: string } {
  const p = memPath(cfg, id); if (!p) throw new Error('not a memory file');
  if (READONLY.test(id)) throw new Error('AGENTS.md is written by Orchestra on every sync: put your rules in the team memory.md instead');
  const body = String(text ?? ''); if (body.length > 200000) throw new Error('too long (200 KB max)');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body.replace(/\r\n/g, '\n'));
  return { ok: true, msg: `Saved ${basename(p)}.` };
}

/** The team memory for the agents' briefs (trimmed), or '' when there is none worth showing. */
export function teamMemory(cfg: Config, max = 2500): string {
  let t = ''; try { t = readFileSync(teamFile(cfg), 'utf8').trim(); } catch { return ''; }
  const body = t.replace(/^#.*$/m, '').replace(/Notes every agent reads at the start of each run\.?/i, '').replace(/^\s*-\s*$/gm, '').trim();
  if (!body) return '';
  return t.length > max ? t.slice(0, max) + '\n…(more in memory/memory.md)' : t;
}
