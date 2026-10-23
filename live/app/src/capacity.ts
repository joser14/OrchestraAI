// Team capacity: how many workers this PC can run at the same time, and Ollama's parallel-slot setting.
// Ollama serves concurrent requests to one model from one copy of its weights; each slot reserves its own KV
// cache (OLLAMA_NUM_PARALLEL x context) for every loaded model, fixed when the model loads. So the plan assumes
// the parallel workers share the worker model, and counts the brain's cache per slot as well.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { Orchestrator } from './orchestrator.ts';
import { allModels, type CatalogModel } from './catalog.ts';
import { parallelPlan, modelCapacityGB } from './select.ts';
import { scanHardware, type Hardware } from './hardware.ts';
import { loadedGB, type ModelResult } from './setup.ts';
import { getSettings } from './settings.ts';
import { startOllama } from './health.ts';
import { MAX_WORKERS } from './team.ts';
const run = promisify(execFile);

let hwCache: { at: number; hw: Hardware | null } = { at: 0, hw: null };
export async function hardware() { if (!hwCache.hw || Date.now() - hwCache.at > 120000) hwCache = { at: Date.now(), hw: await scanHardware() }; return hwCache.hw!; }

/** The catalog model behind a job's model id (e.g. ollama/orch-fast:latest). */
export function catalogOf(o: Orchestrator, modelId: string): CatalogModel | null {
  const local = String(modelId || '').replace(/^ollama\//, '').replace(/:latest$/, '');
  const custom = o.store.get<CatalogModel[]>('customModels', []);
  const r = o.store.get<ModelResult[]>('modelResults', []).find((x) => x.local === local);
  return allModels(custom).find((m) => m.tag === r?.tag || `orch-${m.alias}` === local) ?? null;
}

/** Current OLLAMA_NUM_PARALLEL for the user (Windows: HKCU\Environment), null when unset (Ollama picks). */
export async function ollamaParallel(): Promise<number | null> {
  if (platform() !== 'win32') return Number(process.env.OLLAMA_NUM_PARALLEL) || null;
  try { const { stdout } = await run('reg.exe', ['query', 'HKCU\\Environment', '/v', 'OLLAMA_NUM_PARALLEL'], { windowsHide: true }); return Number(/REG_\w+\s+(\d+)/.exec(stdout)?.[1]) || null; }
  catch { return null; }
}

export async function teamPlan(o: Orchestrator) {
  const s = getSettings(o.store); const hw = await hardware();
  const cap = modelCapacityGB(hw, await loadedGB()); const budget = cap < 4 ? Math.min(hw.ramGB * 0.5, 16) : cap * 0.9;
  const worker = catalogOf(o, o.jobs.worker?.payload?.model || ''), brain = catalogOf(o, o.jobs.main?.payload?.model || '');
  const plan = worker ? parallelPlan(budget, worker, brain, s.ctx, MAX_WORKERS) : null;
  return {
    workers: o.cfg.workers, enabled: s.workers, workerCount: s.workerCount, parallel: s.parallel, maxWorkers: MAX_WORKERS,
    capacityGB: +cap.toFixed(2), budgetGB: +budget.toFixed(2), ctx: s.ctx,
    workerModel: worker?.alias ?? null, brainModel: brain?.alias ?? null,
    recommended: plan ? Math.max(1, plan.max) : 1, perSlotGB: plan?.perSlotGB ?? null,
    needFor: plan ? Object.fromEntries(Array.from({ length: MAX_WORKERS }, (_, i) => [i + 1, plan.needFor(i + 1)])) : {},
    ollamaParallel: await ollamaParallel(),
    running: o.cfg.workers.filter((w) => o.running(w)),
  };
}

/** Set OLLAMA_NUM_PARALLEL for the user and restart Ollama so it takes effect. Only while no agent is running. */
export async function setOllamaParallel(o: Orchestrator, n: number) {
  n = Math.max(1, Math.min(MAX_WORKERS, Math.round(n)));
  if (o.cfg.agents.some((a) => o.running(a))) throw new Error('an agent is running: try again when the team is idle (restarting Ollama would cut it off)');
  if (platform() !== 'win32') throw new Error(`set OLLAMA_NUM_PARALLEL=${n} in the environment of your Ollama service and restart it`);
  await run('setx.exe', ['OLLAMA_NUM_PARALLEL', String(n)], { windowsHide: true });
  for (const exe of ['ollama app.exe', 'ollama.exe']) { try { await run('taskkill.exe', ['/IM', exe, '/F'], { windowsHide: true }); } catch {} }
  process.env.OLLAMA_NUM_PARALLEL = String(n);   // the Ollama we start inherits it right away
  await new Promise((r) => setTimeout(r, 1500)); startOllama();
  o.log(`Ollama parallel slots set to ${n} (Ollama restarted)`);
  return { ok: true, msg: `Ollama now serves ${n} request(s) at once per model. Models reload on their next use.` };
}
