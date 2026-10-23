// Light mode for the running team: every worker uses the composer's model, so one model stays loaded and nothing
// swaps (laptops, small GPUs). Setup applies the same rule to the lineup it downloads (select.ts applyLight); this
// keeps the team that way afterwards, whatever later set a worker's model (MODEL commands, the Models page).
import type { Orchestrator } from './orchestrator.ts';
import { getSettings } from './settings.ts';
import { lightWanted, needGB, modelCapacityGB } from './select.ts';
import { catalogOf, hardware } from './capacity.ts';
import { loadedGB } from './setup.ts';

export interface LightStatus { setting: string; active: boolean; why: string; brain: string | null; worker: string | null }
let cache: { at: number; key: string; st: LightStatus } | null = null;

/** Is Light mode on right now, and why. The workers' own model is the "fast" alias (their jobs may already be on the
 *  composer's model because of Light mode). Sizes come from the catalog; cached 5 min (a hardware scan is slow). */
export async function lightStatus(o: Orchestrator, fresh = false): Promise<LightStatus> {
  const s = getSettings(o.store), brainId = String(o.jobs.main?.payload?.model || ''), workerId = String(o.cfg.aliases.fast || '');
  const key = `${s.light}|${s.ctx}|${brainId}|${workerId}`;
  if (!fresh && cache && cache.key === key && Date.now() - cache.at < 300000) return cache.st;
  const b = catalogOf(o, brainId), w = catalogOf(o, workerId);
  let budget = 0;
  if (s.light === 'auto' && b && w && b.tag !== w.tag) {
    const hw = await hardware(); const cap = modelCapacityGB(hw, await loadedGB());
    budget = cap < 4 ? Math.min(hw.ramGB * 0.5, 16) : cap * 0.9;
  }
  const d = lightWanted(s.light, b && { tag: b.tag, needGB: needGB(b, s.ctx) }, w && { tag: w.tag, needGB: needGB(w, s.ctx) }, budget);
  const st = { setting: s.light, active: d.on && !!brainId, why: d.why, brain: b?.alias ?? (brainId.replace(/^ollama\/|:latest$/g, '') || null), worker: w?.alias ?? null };
  cache = { at: Date.now(), key, st };
  return st;
}
export const forgetLight = () => { cache = null; };
