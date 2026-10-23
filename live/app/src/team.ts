// Team size: main plus 1-8 workers named worker, worker2 ... worker8. The worker list lives in cfg.workers /
// cfg.agents and is changed IN PLACE (every module holds references to those arrays).
import type { Config } from './config.ts';

export const MAX_WORKERS = 8;
export const workerName = (i: number) => (i === 1 ? 'worker' : `worker${i}`);
export const workerNames = (n: number) => Array.from({ length: clampWorkers(n) }, (_, i) => workerName(i + 1));
export const clampWorkers = (n: unknown) => { const v = Number(n); return Number.isFinite(v) && n !== null && n !== '' ? Math.max(1, Math.min(MAX_WORKERS, Math.round(v))) : 2; };
/** Regex source matching any worker name (longest first so "worker2" is not read as "worker"). */
export const WORKER_RE = 'worker[2-8]?';
export const isWorker = (s: string) => new RegExp(`^${WORKER_RE}$`).test(s);
export const isAgent = (s: string) => s === 'main' || isWorker(s);

export function applyTeamSize(cfg: Config, n: number) {
  const ws = workerNames(n);
  cfg.workers.splice(0, cfg.workers.length, ...ws);
  cfg.agents.splice(0, cfg.agents.length, 'main', ...ws);
  return ws;
}
