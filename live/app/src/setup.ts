// Phase 2: first-run setup. Scan -> lineup -> download -> tool test -> speed test -> register in OpenClaw.
// Everything goes through Ollama's HTTP API and the gateway client; progress is kept in the store for the
// Setup page. A model that fails the tool test is recorded and never offered again.
import type { Store } from './store.ts';
import type { Gateway } from './gateway.ts';
import { scanHardware, type Hardware } from './hardware.ts';
import { selectLineup, applyLight, type Lineup, type Fit } from './select.ts';
import { allModels, tagExists, type CatalogModel } from './catalog.ts';
import { getSettings, applyAgentOptions } from './settings.ts';
import { readiness, ensureTeam } from './bootstrap.ts';
import type { Config } from './config.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OLLAMA = 'http://127.0.0.1:11434';
export interface ModelResult { tag: string; local: string; tool: 'pass' | 'fail'; genTps?: number; promptTps?: number; at: string; error?: string }
export interface SetupProgress { phase: string; step: string; pct: number; done: boolean; error?: string; log: string[]; results: ModelResult[]; lineup?: any }

// Local copies are "orch-<alias>"; models made before the rename are "trav-<alias>" and are still recognised.
const localName = (m: CatalogModel) => `orch-${m.alias}`;
async function ollama(path: string, body?: unknown, timeoutMs = 600000): Promise<any> {
  const r = await fetch(OLLAMA + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export async function installedTags(): Promise<Set<string>> { try { return new Set(((await ollama('/api/tags', undefined, 10000)).models || []).map((m: any) => m.name)); } catch { return new Set(); } }
export async function loadedGB(): Promise<number> { try { return ((await ollama('/api/ps', undefined, 10000)).models || []).reduce((s: number, m: any) => s + m.size_vram, 0) / 2 ** 30; } catch { return 0; } }

/** Download a model, reporting progress (0-1). */
export async function pull(tag: string, onPct: (p: number) => void): Promise<void> {
  const r = await fetch(OLLAMA + '/api/pull', { method: 'POST', body: JSON.stringify({ model: tag, stream: true }) });
  if (!r.ok || !r.body) throw new Error(`pull ${tag}: HTTP ${r.status}`);
  let buf = '';
  for await (const chunk of r.body as any) {
    buf += Buffer.from(chunk).toString('utf8'); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      const j = JSON.parse(line); if (j.error) throw new Error(j.error);
      if (j.total && j.completed) onPct(j.completed / j.total);
    }
  }
}

/** Tuned local copy (context, full GPU for the brain), then a forced tool call (2 tries) and a speed test. */
export async function testModel(m: CatalogModel, ctx: number, fullGpu: boolean): Promise<ModelResult> {
  const local = localName(m), at = new Date().toISOString();
  await ollama('/api/create', { model: local, from: m.tag, parameters: { num_ctx: ctx, ...(fullGpu ? { num_gpu: 99 } : {}) }, stream: false });
  const tool = { type: 'function', function: { name: 'get_weather', description: 'Get the current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };
  let ok = false, error: string | undefined;
  for (let t = 0; t < 2 && !ok; t++) {
    try {
      const r = await ollama('/api/chat', { model: local, stream: false, think: false, tools: [tool], messages: [{ role: 'user', content: 'What is the weather in Denver right now? Use the tool.' }] }, 300000);
      ok = (r.message?.tool_calls || []).some((c: any) => c.function?.name === 'get_weather');
    } catch (e: any) { error = e.message; }
  }
  if (!ok) return { tag: m.tag, local, tool: 'fail', at, error };
  const g = await ollama('/api/generate', { model: local, stream: false, think: false, prompt: 'Write two sentences about the sea.\n'.repeat(40), options: { num_predict: 64 } }, 300000);
  await ollama('/api/generate', { model: local, keep_alive: 0 }).catch(() => {});
  return { tag: m.tag, local, tool: 'pass', at,
    genTps: g.eval_count && g.eval_duration ? +(g.eval_count / (g.eval_duration / 1e9)).toFixed(1) : undefined,
    promptTps: g.prompt_eval_count && g.prompt_eval_duration ? +(g.prompt_eval_count / (g.prompt_eval_duration / 1e9)).toFixed(0) : undefined };
}

/** Add the tested models to OpenClaw (provider models + aliases), keeping what is already there. */
export async function registerModels(gw: Gateway, results: ModelResult[], ctx: number) {
  const cur: any = await gw.rpc('config.get', {});
  const cfg = cur.sourceConfig || cur.parsed || {};   // the authored file (not the resolved runtime view)
  const have = new Set(((cfg.models?.providers?.ollama?.models) || []).map((m: any) => m.id));
  const add = results.filter((r) => r.tool === 'pass' && !have.has(`${r.local}:latest`)).map((r) => {
    const m = allModels().find((c) => c.tag === r.tag) ?? { params: 7, vision: false } as any;
    return { id: `${r.local}:latest`, name: `${r.local}:latest`, reasoning: m.params >= 8, input: m.vision ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: ctx, contextTokens: ctx, maxTokens: 4096,
      compat: { supportsTools: true, supportsUsageInStreaming: true, supportsJsonSchemaResponseFormat: true } };
  });
  if (!add.length) return 0;
  const models = [...((cfg.models?.providers?.ollama?.models) || []), ...add];
  await gw.rpc('config.patch', { raw: JSON.stringify({ models: { providers: { ollama: { models } } } }), replacePaths: ['models.providers.ollama.models'], baseHash: cur.hash });
  return add.length;
}

const isInstalled = (inst: Set<string>, tag: string) => inst.has(tag) || inst.has(tag + ':latest');

/** "ollama/name:latest" is a model Ollama has on this PC. */
export const aliasInstalled = (inst: Set<string>, id: string) => { const n = String(id).replace(/^ollama\//, ''); return inst.has(n) || inst.has(n.replace(/:latest$/, '')) || inst.has(n + ':latest'); };

/** Model aliases the composer picks from (MODEL worker=smart): keep only models Ollama has, and make sure "smart"
 *  (best thinking) and "fast" (workers' default) exist - the team's own models when nothing better is set.
 *  Aliases pointing at models from another PC sent workers to a model that does not exist. */
export async function reconcileAliases(cfg: Config, models: { brain?: string; worker?: string }, log: (m: string) => void = () => {}) {
  const inst = await installedTags(); if (!inst.size) return false;   // Ollama not answering: change nothing
  const next: Record<string, string> = {};
  for (const [a, id] of Object.entries(cfg.aliases)) if (aliasInstalled(inst, id)) next[a] = id;
  if (!next.smart && models.brain && aliasInstalled(inst, models.brain)) next.smart = models.brain;
  if (!next.fast && models.worker && aliasInstalled(inst, models.worker)) next.fast = models.worker;
  const dropped = Object.keys(cfg.aliases).filter((a) => !(a in next)), added = Object.keys(next).filter((a) => cfg.aliases[a] !== next[a]);
  if (!dropped.length && !added.length) return false;
  cfg.aliases = next;
  writeFileSync(join(cfg.root, 'models', 'aliases.json'), JSON.stringify(next, null, 2));
  log(`model aliases: ${added.length ? `set ${added.map((a) => `${a}=${next[a].replace(/^ollama\/|:latest$/g, '')}`).join(', ')}` : ''}${added.length && dropped.length ? '; ' : ''}${dropped.length ? `removed ${dropped.join(', ')} (model not on this PC)` : ''}`);
  return true;
}

/** Use what is already downloaded: a role whose pick is missing takes the best installed model that fits and can do
 *  that role (the brain's model may double as the worker). Brain and worker are only downloaded when nothing installed
 *  can do them; vision and chores are optional, so they are left empty rather than downloaded. */
export function preferInstalled(lineup: Lineup, inst: Set<string>, say: (m: string) => void = () => {}) {
  const have = lineup.fits.filter((f) => f.fits && isInstalled(inst, f.model.tag));
  const rank = (a: Fit, b: Fit) => b.model.score - a.model.score || b.model.params - a.model.params || a.needGB - b.needGB;
  const swap = (role: 'brain' | 'worker' | 'vision' | 'chores', optional: boolean) => {
    const cur = lineup[role]; if (cur && isInstalled(inst, cur.model.tag)) return;
    const alt = have.filter((f) => f.model.roles.includes(role) || (role === 'worker' && f.model.roles.includes('brain'))).sort(rank)[0];
    if (alt) { if (cur) say(`${role}: using ${alt.model.tag} (already downloaded) instead of downloading ${cur.model.tag}`); lineup[role] = alt; }
    else if (optional && cur) { say(`${role}: skipped (optional; nothing suitable downloaded, so ${cur.model.tag} is not fetched)`); lineup[role] = null; }
  };
  swap('brain', false); swap('worker', false); swap('vision', true); swap('chores', true);
  // a worker bigger than the brain makes no sense: the brain's model does both
  if (lineup.brain && lineup.worker && lineup.worker.model.params > lineup.brain.model.params && isInstalled(inst, lineup.brain.model.tag)) lineup.worker = lineup.brain;
}

export class Setup {
  store: Store; gw: Gateway; running = false; cfg?: Config; pluginDir: string;
  /** When OpenClaw has no "main": 'new', or the id of the user's agent to base it on (asked on the Setup page). */
  mainFrom?: string;
  constructor(store: Store, gw: Gateway, cfg?: Config, pluginDir = '') {
    this.store = store; this.gw = gw; this.cfg = cfg; this.pluginDir = pluginDir;
    // a run cut off by a restart would otherwise show "Downloading..." forever
    const p = this.progress(); if (!p.done && p.phase !== 'idle') this.save({ ...p, done: true, error: 'interrupted: Orchestra restarted during setup' });
  }
  ready() { return this.cfg ? readiness(this.cfg, this.gw, this.pluginDir) : null; }
  progress(): SetupProgress { return this.store.get<SetupProgress>('setupProgress', { phase: 'idle', step: '', pct: 0, done: false, log: [], results: [] }); }
  private save(p: SetupProgress) { this.store.set('setupProgress', p); }

  /** What setup would do on this PC (no downloads). */
  async plan(ctx = getSettings(this.store).ctx): Promise<{ hardware: Hardware; lineup: Lineup; installed: string[]; failed: string[] }> {
    const hardware = await scanHardware();
    const failed = new Set(this.store.get<ModelResult[]>('modelResults', []).filter((r) => r.tool === 'fail').map((r) => r.tag));
    const available = new Set<string>();
    const s = getSettings(this.store); const custom = this.store.get<CatalogModel[]>('customModels', []);
    for (const m of allModels(custom)) if (!m.verify || await tagExists(m.tag)) available.add(m.tag);
    const lineup = selectLineup(hardware, { ollamaLoadedGB: await loadedGB(), ctx, failed, available, kinds: s.modelKinds, custom, light: s.light });
    const inst = await installedTags();
    preferInstalled(lineup, inst);   // what Run setup will actually use: downloaded models first
    applyLight(lineup, s.light);     // ...which may have picked a different worker
    return { hardware, lineup, installed: allModels(custom).filter((m) => inst.has(m.tag) || inst.has(m.tag + ':latest')).map((m) => m.tag), failed: [...failed] };
  }

  /** Download + test + register the lineup. Runs in the background; poll progress(). */
  async run(ctx = getSettings(this.store).ctx) {
    if (this.running) return; this.running = true;
    const p: SetupProgress = { phase: 'scan', step: 'Scanning the PC', pct: 0, done: false, log: [], results: [] };
    const say = (m: string) => { p.log.push(`${new Date().toLocaleTimeString()} ${m}`); p.step = m; this.save(p); };
    try {
      const { lineup } = await this.plan(ctx);
      p.lineup = { brain: lineup.brain?.model.alias, worker: lineup.worker?.model.alias, vision: lineup.vision?.model.alias, chores: lineup.chores?.model.alias, warnings: lineup.warnings, parallelWorkers: lineup.parallelWorkers };
      const inst = await installedTags();
      preferInstalled(lineup, inst, say); applyLight(lineup, getSettings(this.store).light);
      p.lineup = { brain: lineup.brain?.model.alias, worker: lineup.worker?.model.alias, vision: lineup.vision?.model.alias, chores: lineup.chores?.model.alias, warnings: lineup.warnings, parallelWorkers: lineup.parallelWorkers };
      const picks = [...new Map([lineup.brain, lineup.worker, lineup.vision, lineup.chores].filter(Boolean).map((f) => [f!.model.tag, f!.model])).values()];
      for (const [i, m] of picks.entries()) {
        p.phase = 'download';
        if (!inst.has(m.tag) && !inst.has(m.tag + ':latest')) {
          say(`Downloading ${m.alias} (${m.sizeGB} GB)`);
          await pull(m.tag, (x) => { p.pct = Math.round(((i + x) / picks.length) * 70); this.save(p); });
        } else say(`${m.alias} already downloaded`);
      }
      const results: ModelResult[] = [];
      for (const [i, m] of picks.entries()) {
        p.phase = 'test'; say(`Testing ${m.alias}: tool call and speed`);
        const r = await testModel(m, ctx, m === lineup.brain?.model);
        results.push(r); p.results = results; p.pct = 70 + Math.round(((i + 1) / picks.length) * 25); this.save(p);
        say(r.tool === 'pass' ? `${m.alias}: passed (${r.genTps ?? '?'} tok/s)` : `${m.alias}: FAILED the tool test - not used`);
      }
      const all = this.store.get<ModelResult[]>('modelResults', []).filter((x) => !results.some((r) => r.tag === x.tag));
      this.store.set('modelResults', [...all, ...results]);
      p.phase = 'register'; say('Registering models with OpenClaw');
      const n = await registerModels(this.gw, results, ctx);
      say(`Registered ${n} new model(s).`);
      if (this.cfg) {
        // Fresh PC: create the agents, their jobs and the plugin registration if any are missing.
        const pass = (alias?: string) => { const r = results.find((x) => x.tag === picks.find((m) => m.alias === alias)?.tag && x.tool === 'pass'); return r ? `ollama/${r.local}:latest` : ''; };
        const brain = pass(lineup.brain?.model.alias) || pass(lineup.worker?.model.alias), worker = pass(lineup.worker?.model.alias) || brain;
        if (brain) { p.phase = 'team'; say('Checking the team in OpenClaw'); const r = await ensureTeam(this.cfg, this.gw, this.pluginDir, { brain, worker }, say, { mainFrom: this.mainFrom }); await reconcileAliases(this.cfg, { brain, worker }, say); try { await applyAgentOptions(this.store, this.gw, say); } catch {} say(r.missing.length ? `Still missing: ${r.missing.join(', ')}` : 'Team ready: 3 agents, 3 jobs, team tools.'); }
        else say('No model passed the tool test: the team cannot be created on this PC.');
      }
      say('Setup complete.');
      p.phase = 'done'; p.pct = 100; p.done = true; this.save(p);
    } catch (e: any) { p.error = String(e?.message || e); p.done = true; say(`Setup stopped: ${p.error}`); }
    finally { this.running = false; }
  }
}
