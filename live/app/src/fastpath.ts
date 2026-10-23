// Fast path: a simple, one-step request from the user skips the composer's planning and goes straight to a free worker;
// Orchestra reports the result to the user itself. On a home PC most asks are like this ("write a haiku", "summarize this
// file"), and the planning pass only added a minute. Anything with steps, research, comparing, or that leans on the
// conversation still goes through the composer, which plans, splits and checks.
import { join } from 'node:path';
import { workPaths } from './rules.ts';
import { refersBack } from './interpret.ts';
import { imageName } from './imagegen.ts';

// ("list" is left out: as a noun, "the shopping list", it made unclear asks look clear)
const ACTION = /\b(write|make|create|draft|compose|draw|paint|illustrate|summari[sz]e|translate|convert|turn|format|rename|move|copy|delete|remove|download|generate|outline|rewrite|proofread|shorten|expand)\b/gi;
// signs of a job with several steps, or one the composer should plan
const MULTI = /\b(then|after that|afterwards|and also|as well as|followed by|step \d|steps|for each|every (?:day|week)|compare|comparison|versus|vs\.?|research|analy[sz]e|investigate|look into|find out|plan|strategy|report on|review all|several|multiple|each of)\b/i;

/** yes = clearly one simple job; no = clearly for the composer; unsure = ask the model (one short call, no tools). */
export interface FastPathDecision { ok: boolean; unsure?: boolean; why: string }

/** Is this request simple enough for one worker, without the composer? Clear cases are decided here, instantly. */
export function isSimpleRequest(text: string): FastPathDecision {
  const t = String(text || '').trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words < 3) return { ok: false, why: 'too short to act on alone' };
  if (words > 60) return { ok: false, why: 'long request: the composer plans it' };
  if (refersBack(t)) return { ok: false, why: 'leans on the conversation' };
  if (MULTI.test(t)) return { ok: false, why: 'several steps or research: the composer plans it' };
  if (/^\s*(\d+[.)]|[-*•])\s/m.test(t)) return { ok: false, why: 'a list of jobs' };
  if (/\?\s*$/.test(t) && !/^(can|could|would|will|please)\b/i.test(t)) return { ok: false, why: 'a question' };
  const actions = new Set([...t.matchAll(ACTION)].map((m) => m[1].toLowerCase()));
  if (actions.size > 2) return { ok: false, why: 'several different actions' };
  // borderline: no clear action word, two actions, or a longer request - let the model judge
  if (!actions.size || actions.size === 2 || words > 35) return { ok: false, unsure: true, why: 'borderline' };
  return { ok: true, why: 'one simple job' };
}

const JUDGE = `Decide if a request to an AI team is ONE simple job a single worker can finish in one go (write, summarize,
translate, convert, rename, a short list), or needs planning (several steps, research, comparing options, a question
about the team, or depends on earlier messages). Answer {"simple": true|false, "reason": "a few words"}.`;
/** The model's call on a borderline request (5-10 s, no tools). Any problem counts as "not simple": the composer plans it. */
export async function judgeSimple(model: string, text: string, timeoutMs = 30000): Promise<FastPathDecision> {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0, num_predict: 60 },
        format: { type: 'object', properties: { simple: { type: 'boolean' }, reason: { type: 'string' } }, required: ['simple'] },
        messages: [{ role: 'system', content: JUDGE }, { role: 'user', content: String(text).slice(0, 1200) }] }),
    });
    const j: any = await r.json(); const o = JSON.parse(String(j?.message?.content || '{}'));
    return { ok: o.simple === true, why: `model: ${String(o.reason || (o.simple ? 'simple' : 'needs planning')).slice(0, 80)}` };
  } catch { return { ok: false, why: 'model check failed' }; }
}

/** The worker's job: the user's words, plus a file to write when the user named none (so the result can be checked). */
export function fastTaskText(text: string, workDir: string): string {
  let job = String(text || '').trim().replace(/\s+/g, ' ');
  // a picture: team_image draws it into a .png (not a Markdown file)
  if (/\b(draw|paint|illustrate|picture|image|drawing|illustration|logo|wallpaper|icon)\b/i.test(job) && !/\.(md|txt|pdf|csv)\b/i.test(job)) {
    const named = /([\w][\w.-]*\.(?:png|jpe?g|webp))\b/i.exec(job)?.[1];
    return named && !/[\\/]/.test(named) ? job.replace(named, join(workDir, named)) + ' Use team_image.'
      : named ? job + ' Use team_image.' : `${job} Use team_image and save it as ${join(workDir, imageName(job))}`;
  }
  // a bare file name ("to autumn-haiku.md") means that file in the work folder: spell out the full path
  const bare = /(?:^|[\s"'`(])([\w][\w.-]*\.(?:md|txt|csv|json|html|py|js|pdf))(?=$|[\s"'`),.;:!?])/i.exec(job);
  if (!workPaths(job, workDir).length && bare && !/[\\/]/.test(bare[1])) job = job.replace(bare[1], join(workDir, bare[1].replace(/\.pdf$/i, '.md')));
  if (!workPaths(job, workDir).length) {
    const slug = job.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|with|about|please|write|make|create|me|some|that|this)$/.test(w)).slice(0, 4).join('-') || 'result';
    job += ` Save the result as ${join(workDir, `${slug}.md`)}`;
  }
  if (/\bpdf\b/i.test(job) && !/team_pdf/i.test(job)) job += ' then make it a PDF with team_pdf';
  return job;
}
