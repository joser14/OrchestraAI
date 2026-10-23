// Context size, applied now: rebuild the team's local model copies (orch-* / trav-*) with the new num_ctx - a fast
// step, the weights are shared - and tell OpenClaw the new context window for those models. Models the team uses
// directly (not Orchestra's copies) are left alone and reported, so the user's own models are never changed.
import type { Gateway } from './gateway.ts';

const OLLAMA = 'http://127.0.0.1:11434';
async function ollama(path: string, body: unknown, timeoutMs = 120000) {
  const r = await fetch(OLLAMA + path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Ollama ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json().catch(() => ({}));
}
const ours = (name: string) => /^(orch|trav)-/.test(name);

export async function applyContext(gw: Gateway, ctx: number, log: (m: string) => void): Promise<{ changed: string[]; skipped: string[] }> {
  const jobs = await gw.jobs();
  const models = [...new Set(jobs.filter((j: any) => /-board$/.test(String(j.name || ''))).map((j: any) => String(j.payload?.model || '').replace(/^ollama\//, '')).filter(Boolean))];
  const changed: string[] = [], skipped: string[] = [];
  for (const m of models) {
    const name = m.replace(/:latest$/, '');
    if (!ours(name)) { skipped.push(name); continue; }
    // re-create from itself with the new context; full GPU stays as it was (num_gpu is kept from the old copy)
    await ollama('/api/create', { model: name, from: name, parameters: { num_ctx: ctx }, stream: false });
    changed.push(name);
  }
  // OpenClaw's view of those models' context window
  const cur: any = await gw.rpc('config.get', {});
  const list: any[] = cur.sourceConfig?.models?.providers?.ollama?.models || [];
  if (list.length) {
    const next = list.map((x) => (changed.some((n) => String(x.id || '').replace(/:latest$/, '') === n) ? { ...x, contextWindow: ctx, contextTokens: ctx } : x));
    await gw.rpc('config.patch', { raw: JSON.stringify({ models: { providers: { ollama: { models: next } } } }), replacePaths: ['models.providers.ollama.models'], baseHash: cur.hash });
  }
  // unload so the next run loads the new context
  for (const n of changed) await ollama('/api/generate', { model: n, keep_alive: 0 }, 10000).catch(() => {});
  log(`context ${Math.round(ctx / 1024)}k applied to ${changed.join(', ') || 'no Orchestra model copies'}${skipped.length ? ` (left as they are: ${skipped.join(', ')})` : ''}`);
  return { changed, skipped };
}
