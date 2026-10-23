// Team skills: playbooks jr writes for the team, in the Agent Skills format (skills/<name>/SKILL.md with a
// name + description frontmatter). Progressive disclosure, as the standard recommends: the briefs list only each
// skill's name, one-line description and file path; an agent reads the full instructions with its read tool when a
// job calls for that skill. Small models stay focused: a few lines in the brief instead of every playbook.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';

export interface TeamSkill { name: string; description: string; body: string; path: string; mtime: number }
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const dir = (cfg: Config) => join(cfg.root, 'skills');

/** "Weekly report format" -> "weekly-report-format" (the directory name must match the skill's name). */
export const slug = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function parse(text: string): { name: string; description: string; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return { name: '', description: '', body: text.trim() };
  const field = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(m[1])?.[1] || '').trim().replace(/^["']|["']$/g, '');
  return { name: field('name'), description: field('description'), body: m[2].trim() };
}

export function listSkills(cfg: Config): TeamSkill[] {
  let names: string[] = []; try { names = readdirSync(dir(cfg)).filter((n) => SLUG.test(n)); } catch { return []; }
  const out: TeamSkill[] = [];
  for (const n of names.sort()) {
    const p = join(dir(cfg), n, 'SKILL.md'); if (!existsSync(p)) continue;
    try { const f = parse(readFileSync(p, 'utf8')); out.push({ name: f.name || n, description: f.description, body: f.body, path: p, mtime: statSync(p).mtimeMs }); } catch {}
  }
  return out;
}

export function saveSkill(cfg: Config, s: { name: string; description: string; body: string; old?: string }): { ok: true; msg: string; name: string } {
  const name = slug(s.name); if (!SLUG.test(name)) throw new Error('give the skill a name (letters, digits, dashes)');
  const description = String(s.description || '').replace(/\s+/g, ' ').trim();
  if (description.length < 10) throw new Error('write a one-line description: what it is for and when to use it (agents choose by it)');
  if (description.length > 1024) throw new Error('keep the description under 1024 characters (put details in the instructions)');
  const body = String(s.body || '').trim(); if (!body) throw new Error('write the instructions');
  if (body.split('\n').length > 500) throw new Error('keep the instructions under 500 lines');
  if (s.old && slug(s.old) !== name && SLUG.test(slug(s.old))) rmSync(join(dir(cfg), slug(s.old)), { recursive: true, force: true });   // renamed
  mkdirSync(join(dir(cfg), name), { recursive: true });
  writeFileSync(join(dir(cfg), name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return { ok: true, msg: `Saved skill ${name}.`, name };
}

export function removeSkill(cfg: Config, name: string): { ok: true; msg: string } {
  const n = slug(name); if (!SLUG.test(n) || !existsSync(join(dir(cfg), n))) throw new Error('no such skill');
  rmSync(join(dir(cfg), n), { recursive: true, force: true });
  return { ok: true, msg: `Removed skill ${n}.` };
}

/** The brief lines: name, description and where the instructions are (read them only when a job needs the skill). */
export function skillsForBrief(cfg: Config): string {
  const s = listSkills(cfg); if (!s.length) return '';
  return ['=== TEAM SKILLS (playbooks from jr: when a job matches one, read its file first and follow it) ===',
    ...s.slice(0, 30).map((k) => `- ${k.name}: ${k.description} -> read ${k.path}`)].join('\n');
}
