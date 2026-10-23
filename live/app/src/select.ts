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

export function selectLineup(hw: Hardware, opts: { ollamaLoadedGB?: number; ctx?: number; failed?: Set<string>; available?: Set<string>; kinds?: Kind[]; custom?: CatalogModel[] } = {}): Lineup {
  const ctx = opts.ctx ?? 24576, warnings: string[] = [];
  const cap = modelCapacityGB(hw, opts.ollamaLoadedGB ?? 0);
  const cpuOnly = cap < 4;
  const budget = cpuOnly ? Math.min(hw.ramGB * 0.5, 16) : cap * 0.9;   // CPU: half the RAM, capped
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
  if (brain && brain.model.params < 8) warnings.push(`Brain is ${brain.model.params}B: reliability is lower than with an 8B model`);
  // Workers: the best mid-size model (4B class), smaller than the brain when the brain is small.
  // (big rigs - 40 GB+ like a DGX Spark or two 24-32 GB cards - get bigger workers; see workerMaxParams)
  const wmax = cpuOnly ? 4 : workerMaxParams(budget);
  const worker = best('worker', (f) => f.model.params <= wmax && (!brain || f.model.params <= brain.model.params) && (f.model.params <= 4 || !brain || brain.needGB + f.needGB <= budget));   // a big worker must fit beside the brain
  const vision = best('vision', (f) => f.model.params <= wmax);
  const chores = fits.filter((f) => f.fits && f.model.roles.includes('chores') && f.model.params >= 1).sort((a, b) => a.needGB - b.needGB)[0] ?? null;
  // Two workers at once when brain + two workers all fit together.
  const parallelWorkers = brain && worker && !cpuOnly && brain.needGB + 2 * worker.needGB <= budget ? 2 : 1;
  return { capacityGB: cap, ctx, cpuOnly, warnings, brain, worker, vision, chores, parallelWorkers, fits };
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
