// Phase 2: build the model lineup for this PC.
// Fit rule (design doc): weights + KV cache for the context + ~0.5 GB overhead <= 90% of the VRAM available to
// models (total VRAM minus what other programs hold). No usable GPU -> CPU lineup with a warning.
import type { Hardware } from './hardware.ts';
import { allModels, kindOf, type CatalogModel, type Kind } from './catalog.ts';

export interface Fit { model: CatalogModel; needGB: number; fits: boolean }
export interface Lineup {
  capacityGB: number; ctx: number; cpuOnly: boolean; warnings: string[];
  brain: Fit | null; worker: Fit | null; vision: Fit | null; chores: Fit | null; parallelWorkers: number;
  fits: Fit[];
  budgetGB: number; light: boolean;   // Light mode: the brain's model does every job (see applyLight)
}

export type LightSetting = 'auto' | 'on' | 'off';
/** Light mode decision. Auto: on when the brain's and the worker's models are different and cannot both sit in the
 *  model memory at once. Then Ollama swaps them in and out for every hand-off (seconds each, minutes on a laptop),
 *  or spills layers to the CPU; one model that stays loaded is faster, even if it is the bigger one. */
export function lightWanted(setting: LightSetting, brain: { tag: string; needGB: number } | null, worker: { tag: string; needGB: number } | null, budgetGB: number): { on: boolean; why: string } {
  if (setting === 'on') return { on: true, why: 'switched on' };
  if (setting === 'off') return { on: false, why: 'switched off' };
  if (!brain || !worker) return { on: false, why: 'model sizes unknown' };
  if (brain.tag === worker.tag) return { on: false, why: 'the composer and workers already share one model' };
  const need = +(brain.needGB + worker.needGB).toFixed(1);
  return need > budgetGB ? { on: true, why: `both models need ${need} GB, ${budgetGB.toFixed(1)} GB is available` }
    : { on: false, why: `both models fit (${need} of ${budgetGB.toFixed(1)} GB)` };
}
/** Light mode on a lineup: the worker role takes the brain's model (vision and chores are left for the jobs that need them). */
export function applyLight(l: Lineup, setting: LightSetting) {
  const d = lightWanted(setting, l.brain && { tag: l.brain.model.tag, needGB: l.brain.needGB }, l.worker && { tag: l.worker.model.tag, needGB: l.worker.needGB }, l.budgetGB);
  l.light = d.on && !!l.brain;
  if (l.light && l.worker?.model.tag !== l.brain!.model.tag) {
    l.warnings.push(`Light mode: ${l.brain!.model.alias} does every job (${d.why}), so it stays loaded and nothing swaps`);
    l.worker = l.brain; l.parallelWorkers = 1;
  }
  return l;
}

export const needGB = (m: CatalogModel, ctx: number) => +(m.sizeGB + (m.kvKB * 1024 * ctx) / 2 ** 30 + 0.5).toFixed(2);

/** VRAM the models may use: total minus what other programs hold right now (display, browsers, ...). */
/** Several cards of the same vendor (e.g. 2x RTX 5090) are one pool: Ollama splits a model's layers across them.
 *  Unified-memory GPUs (DGX Spark, Apple) are counted once - their memory is the system RAM. */
export function modelCapacityGB(hw: Hardware, ollamaLoadedGB: number): number {
  const g = hw.bestGpu; if (!g) return 0;
  const same = g.unified ? [] : hw.gpus.filter((x) => x.vendor === g.vendor && !x.unified && x.vramGB >= 2);
  const pool = same.length >= 2 ? same : [g];
  const total = pool.reduce((s, x) => s + x.vramGB, 0), free = pool.reduce((s, x) => s + x.freeGB, 0);
  const usedByOthers = Math.max(0, (total - free) - ollamaLoadedGB);
  return +Math.max(0, total - usedByOthers).toFixed(2);
}
/** Largest worker model (billions of parameters) for a budget: 4B on ordinary GPUs, bigger on 40 GB+ rigs. */
export const workerMaxParams = (budgetGB: number) => (budgetGB >= 80 ? 32 : budgetGB >= 40 ? 14 : 4);

/** Smaller contexts tried when no model can be the brain at the chosen one (small PCs). Below 16k the brief and the
 *  tool list leave little room, so 8k is the last resort. */
export const SMALL_CTX = [16384, 12288, 8192];

/** The lineup for this PC. It works on any machine that can run a model at all: when nothing fits as the brain it
 *  tries smaller contexts, then the GPU plus part of the RAM (layers split to the CPU: slower), and says so. */
export function selectLineup(hw: Hardware, opts: { ollamaLoadedGB?: number; ctx?: number; failed?: Set<string>; available?: Set<string>; kinds?: Kind[]; custom?: CatalogModel[]; light?: LightSetting } = {}): Lineup {
  const want = opts.ctx ?? 24576;
  const cap = modelCapacityGB(hw, opts.ollamaLoadedGB ?? 0);
  const cpuOnly = cap < 2.5;   // a 4 GB card still runs the small models whole (faster than the CPU)
  const ram = Math.min(hw.ramGB * 0.5, 16);   // CPU: half the RAM, capped
  const gpu = { gb: cpuOnly ? ram : cap * 0.9, split: false };
  const split = { gb: cap * 0.9 + Math.min(hw.ramGB * 0.35, 16), split: true };   // part of the model in RAM
  const done = (l: Lineup, ctx: number, b: { split: boolean }) => {
    if (b.split) l.warnings.push(`No model fits in the graphics card's ${cap} GB: part of ${l.brain!.model.alias} runs from system memory (slower)`);
    if (ctx < want) l.warnings.push(`Context lowered to ${Math.round(ctx / 1024)}k (from ${Math.round(want / 1024)}k) so a ${l.brain!.model.params >= 4 ? 'capable ' : ''}model fits on this PC`);
    return applyLight(l, opts.light ?? 'auto');
  };
  const at = (ctx: number, b: { gb: number }) => buildLineup(hw, opts, cap, cpuOnly, ctx, b.gb);
  // 1. the chosen context; a 4B+ brain there is used as is (big cards never trade context for a bigger model)
  const first = at(want, gpu);
  if (first.brain && first.brain.model.params >= 4) return done(first, want, gpu);
  // 2. only a very small brain (or none): 16k / 12k are a small price for a 4B brain, which plans far better
  const roomy = SMALL_CTX.filter((c) => c < want && c >= 12288);
  for (const c of roomy) { const l = at(c, gpu); if (l.brain && l.brain.model.params >= 4) return done(l, c, gpu); }
  if (first.brain) return done(first, want, gpu);
  // 3. nothing at all: smaller contexts on the GPU, then the GPU plus part of the RAM, 8k last
  const last = SMALL_CTX.filter((c) => c < want && c < 12288);
  const tries: [number, { gb: number; split: boolean }][] = [
    ...roomy.map((c) => [c, gpu] as [number, typeof gpu]),
    ...(cpuOnly ? [] : [want, ...roomy].map((c) => [c, split] as [number, typeof gpu])),
    ...last.flatMap((c) => (cpuOnly ? [gpu] : [gpu, split]).map((b) => [c, b] as [number, typeof gpu])),
  ];
  for (const [ctx, b] of tries) { const l = at(ctx, b); if (l.brain) return done(l, ctx, b); }
  const l = buildLineup(hw, opts, cap, cpuOnly, want, gpu.gb);
  l.warnings.push(`No model can run on this PC: the smallest needs about 2 GB of free memory (${cpuOnly ? `${ram.toFixed(1)} GB of RAM` : `${cap} GB of graphics memory`} available)`);
  return l;
}

function buildLineup(hw: Hardware, opts: { failed?: Set<string>; available?: Set<string>; kinds?: Kind[]; custom?: CatalogModel[] }, cap: number, cpuOnly: boolean, ctx: number, budget: number): Lineup {
  const warnings: string[] = [];
  if (cpuOnly) warnings.push(hw.bestGpu ? `GPU has only ${cap} GB for models: running on the CPU (slow)` : 'No usable GPU found: running on the CPU (slow)');
  const kinds = new Set(opts.kinds ?? ['abliterated']);   // Settings: which kinds of model to use (default abliterated only)
  kinds.add('custom');   // models the user added themselves are always eligible (no checkbox for them)
  const usable = allModels(opts.custom).filter((m) => kinds.has(kindOf(m)) && m.roles.length && m.tested !== 'fail' && !opts.failed?.has(m.tag) && (!opts.available || opts.available.has(m.tag) || !m.verify));
  const fits = usable.map((m) => ({ model: m, needGB: needGB(m, ctx), fits: needGB(m, ctx) <= budget }));
  // Prefer the catalog score (quality within the role; proven models above untested peers), then size, then lighter.
  const best = (role: string, pred: (f: Fit) => boolean = () => true) =>
    fits.filter((f) => f.fits && f.model.roles.includes(role as any) && pred(f)).sort((a, b) => b.model.score - a.model.score || b.model.params - a.model.params || a.needGB - b.needGB)[0] ?? null;

  // Brain: the strongest model that fits whole (8B+ preferred; small models get unreliable at tool use).
  let brain = best('brain', (f) => !cpuOnly || f.model.params <= 4);
  if (brain && brain.model.params < 4) warnings.push(`Brain is a very small ${brain.model.params}B model: fine for simple jobs (write, summarize, rename); plans with many steps may go wrong`);
  else if (brain && brain.model.params < 8) warnings.push(`Brain is ${brain.model.params}B: reliability is lower than with an 8B model`);
  // Workers: the best mid-size model (4B class), smaller than the brain when the brain is small.
  // (big rigs - 40 GB+ like a DGX Spark or two 24-32 GB cards - get bigger workers; see workerMaxParams)
  const wmax = cpuOnly ? 4 : workerMaxParams(budget);
  const worker = best('worker', (f) => f.model.params <= wmax && (!brain || f.model.params <= brain.model.params) && (f.model.params <= 4 || !brain || brain.needGB + f.needGB <= budget));   // a big worker must fit beside the brain
  const vision = best('vision', (f) => f.model.params <= wmax);
  const chores = fits.filter((f) => f.fits && f.model.roles.includes('chores') && f.model.params >= 1).sort((a, b) => a.needGB - b.needGB)[0] ?? null;
  // Two workers at once when brain + two workers all fit together.
  const parallelWorkers = brain && worker && !cpuOnly && brain.needGB + 2 * worker.needGB <= budget ? 2 : 1;
  return { capacityGB: cap, ctx, cpuOnly, warnings, brain, worker, vision, chores, parallelWorkers, fits, budgetGB: +budget.toFixed(2), light: false };
}

/** How many workers can run at the same time. Research (Ollama/llama.cpp): parallel requests share ONE copy of a
 *  model's weights; each extra slot only adds KV cache, which Ollama reserves up front for every loaded model
 *  (OLLAMA_NUM_PARALLEL x context). So parallel workers must share one worker model, and the brain's cache grows
 *  with the slot count too. Over budget, Ollama silently moves layers to the CPU - slower, not an error. */
export function parallelPlan(budgetGB: number, worker: CatalogModel, brain: CatalogModel | null, ctx: number, maxWorkers = 8) {
  const kv = (m: CatalogModel) => (m.kvKB * 1024 * ctx) / 2 ** 30;
  const need = (n: number) => +(worker.sizeGB + n * kv(worker) + (brain && brain.tag !== worker.tag ? brain.sizeGB + n * kv(brain) : 0) + 0.6).toFixed(2);
  let n = 0; while (n < maxWorkers && need(n + 1) <= budgetGB) n++;
  return { max: n, needFor: (k: number) => need(k), perSlotGB: +(kv(worker) + (brain && brain.tag !== worker.tag ? kv(brain) : 0)).toFixed(2) };
}
