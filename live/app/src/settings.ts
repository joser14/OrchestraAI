// User settings (Settings page): autonomy, which workers are on, context size, start with the PC, notifications.
// Autonomy is applied to OpenClaw's exec approval policy over the gateway (exec.approvals.get/set):
//   full = agents run commands without asking (jr's setup) · ask = unknown commands wait for approval in the
//   dashboard · off = no shell commands at all. New installs default to "ask" (design decision, 2026-10-11).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { Store } from './store.ts';
import type { Gateway } from './gateway.ts';
import { clampWorkers, workerNames } from './team.ts';
import { PROXY_PORT } from './ollamaproxy.ts';
const run = promisify(execFile);

export type Autonomy = 'full' | 'ask' | 'off';
/** workerCount = how many workers the team has (1-8); workers = which of them are switched on;
 *  parallel = how many workers may run at the same time (each needs its model in VRAM). */
export type Thinking = 'off' | 'low' | 'medium' | 'high';
export const THINKING: Thinking[] = ['off', 'low', 'medium', 'high'];
/** OpenClaw agent options (Settings > OpenClaw): written into each agent's job (payload.thinking, .lightContext,
 *  .timeoutSeconds). thinking: per agent, "worker" also covers worker2..8 unless they have their own entry.
 *  interpret: the "jr most likely means" step before the brain plans (interpret.ts). */
export interface Settings {
  autonomy: Autonomy; workers: string[]; workerCount: number; parallel: number; ctx: number; notify: boolean; modelKinds: ('abliterated' | 'standard' | 'custom')[];
  thinking: Record<string, Thinking>; lightContext: boolean; runMinutes: number; interpret: boolean;
}
export const DEFAULTS: Settings = { autonomy: 'ask', workers: ['worker', 'worker2'], workerCount: 2, parallel: 1, ctx: 24576, notify: true, modelKinds: ['abliterated'],
  // main thinks: Qwen3 on Ollama sometimes writes its tool call inside the thinking text; the tool-call rescue proxy
  // (ollamaproxy.ts) turns those into real calls, so thinking runs no longer end with nothing done.
  thinking: { main: 'low', worker: 'off' }, lightContext: false, runMinutes: 8, interpret: true };
export const RUN_MINUTES = [4, 8, 12, 20];
export const thinkingFor = (s: Settings, agent: string): Thinking => s.thinking[agent] ?? (agent === 'main' ? s.thinking.main : s.thinking.worker) ?? 'off';
const POLICY: Record<Autonomy, { security: string; ask: string; askFallback: string }> = {
  full: { security: 'full', ask: 'off', askFallback: 'full' },
  ask: { security: 'allowlist', ask: 'on-miss', askFallback: 'deny' },
  off: { security: 'deny', ask: 'off', askFallback: 'deny' },
};

export function getSettings(store: Store): Settings { return { ...DEFAULTS, ...store.get<Partial<Settings>>('settings', {}) }; }

/** Current autonomy as OpenClaw actually has it (the policy may have been changed elsewhere). */
export async function readAutonomy(gw: Gateway): Promise<Autonomy | 'custom'> {
  const d = (await gw.rpc('exec.approvals.get', {})).file?.defaults || {};
  for (const [k, p] of Object.entries(POLICY)) if (d.security === p.security && d.ask === p.ask && (d.askFallback ?? 'deny') === p.askFallback) return k as Autonomy;
  return 'custom';
}

export async function saveSettings(store: Store, gw: Gateway, patch: Partial<Settings>, log: (m: string) => void): Promise<Settings> {
  const s = { ...getSettings(store), ...patch };
  if (!['full', 'ask', 'off'].includes(s.autonomy)) throw new Error('autonomy must be full, ask or off');
  s.workerCount = clampWorkers(s.workerCount);
  const all = workerNames(s.workerCount);
  // Growing the team switches the new workers on; shrinking drops the ones that no longer exist.
  if (patch.workerCount !== undefined && !patch.workers) s.workers = [...new Set([...s.workers, ...all.slice(getSettings(store).workerCount)])];
  s.workers = s.workers.filter((w) => all.includes(w)); if (!s.workers.length) throw new Error('keep at least one worker on');
  s.parallel = Math.max(1, Math.min(s.workerCount, Math.round(Number(s.parallel) || 1)));
  s.ctx = [16384, 24576, 32768].includes(Number(s.ctx)) ? Number(s.ctx) : 24576;
  s.modelKinds = (s.modelKinds || []).filter((k) => ['abliterated', 'standard', 'custom'].includes(k)) as any;
  if (!s.modelKinds.length) throw new Error('tick at least one kind of model');
  s.thinking = { ...getSettings(store).thinking, ...(patch.thinking || {}) };
  for (const [a, v] of Object.entries(s.thinking)) if (!THINKING.includes(v)) throw new Error(`thinking for ${a} must be one of ${THINKING.join(', ')}`);
  s.runMinutes = RUN_MINUTES.includes(Number(s.runMinutes)) ? Number(s.runMinutes) : 8;
  s.lightContext = !!s.lightContext; s.interpret = !!s.interpret;
  if (patch.autonomy) {
    const cur: any = await gw.rpc('exec.approvals.get', {});
    const file = { ...cur.file, defaults: { ...(cur.file?.defaults || {}), ...POLICY[s.autonomy] } };
    await gw.rpc('exec.approvals.set', { file, baseHash: cur.hash });
    log(`autonomy set to ${s.autonomy} (${JSON.stringify(POLICY[s.autonomy])})`);
  }
  store.set('settings', s);
  if (patch.thinking || patch.lightContext !== undefined || patch.runMinutes !== undefined) await applyAgentOptions(store, gw, log);
  return s;
}

/** Write thinking / light context / run limit into every agent's board job in OpenClaw. With thinking on anywhere,
 *  OpenClaw reaches Ollama through Orchestra's tool-call rescue proxy (ollamaproxy.ts); with it off, directly. */
export async function applyAgentOptions(store: Store, gw: Gateway, log: (m: string) => void) {
  const s = getSettings(store);
  try {
    // Always through the proxy while Orchestra runs: it rescues hidden tool calls and measures the live speed for the
    // Dashboard (Quit stops the gateway too, so OpenClaw is never left pointing at a closed proxy).
    const want = `http://127.0.0.1:${PROXY_PORT}`;
    const cur: any = await gw.rpc('config.get', {}); const ol = cur.sourceConfig?.models?.providers?.ollama;
    if (ol && ol.baseUrl !== want && /127\.0\.0\.1:(11434|11444)|localhost:(11434|11444)/.test(String(ol.baseUrl || ''))) {
      await gw.rpc('config.patch', { raw: JSON.stringify({ models: { providers: { ollama: { baseUrl: want } } } }), baseHash: cur.hash });
      log('openclaw: models now reached through Orchestra\'s proxy (tool-call rescue + live speed)');
    }
  } catch (e: any) { log(`openclaw: could not set the Ollama route: ${String(e.message).slice(0, 120)}`); }
  for (const j of await gw.jobs()) {
    // OpenClaw's weekly "skill-collection-review-<agent>" jobs fail on the team agents (they look for a
    // workshop-skills folder that does not exist and trip OpenClaw's own sandbox) and take the GPU from real work:
    // paused here, logged; they can be switched back on in OpenClaw's Control UI.
    if (/^skill-collection-review-(main|worker\d*)$/.test(String(j.name || '')) && j.enabled !== false) {
      try { await gw.updateJob(j.id, { enabled: false }); log(`openclaw: paused its "${j.name}" job (it fails on Orchestra's agents and competes for the GPU)`); } catch {}
      continue;
    }
    const m = /^(main|worker\d*)-board$/.exec(String(j.name || '')); if (!m) continue;
    const payload ={ kind: j.payload.kind, thinking: thinkingFor(s, m[1]), lightContext: s.lightContext, timeoutSeconds: s.runMinutes * 60 };
    const p = j.payload || {};
    if (p.thinking === payload.thinking && !!p.lightContext === payload.lightContext && p.timeoutSeconds === payload.timeoutSeconds) continue;
    await gw.updateJob(j.id, { payload });
    log(`openclaw: ${m[1]} thinking ${payload.thinking}, light context ${payload.lightContext ? 'on' : 'off'}, run limit ${s.runMinutes} min`);
  }
}

/** What OpenClaw actually has for each agent's job (the Settings page shows this, not the stored wish). */
export async function readAgentOptions(gw: Gateway) {
  const out: Record<string, { model: string; thinking: string; lightContext: boolean; runMinutes: number }> = {};
  for (const j of await gw.jobs()) {
    const m = /^(main|worker\d*)-board$/.exec(String(j.name || '')); if (!m) continue;
    const p = j.payload || {};
    out[m[1]] = { model: String(p.model || '').replace(/^ollama\/|:latest$/g, ''), thinking: p.thinking || 'off', lightContext: !!p.lightContext, runMinutes: Math.round((p.timeoutSeconds || 480) / 60) };
  }
  return out;
}

/** Pending shell-command approvals (autonomy "ask"), and answering them from the dashboard. */
export async function pendingApprovals(gw: Gateway) { const r: any = await gw.rpc('exec.approval.list', {}); return Array.isArray(r) ? r : r.items || r.approvals || []; }
export async function resolveApproval(gw: Gateway, id: string, decision: 'allow-once' | 'allow-always' | 'deny') { return gw.rpc('exec.approval.resolve', { id, decision }); }

/** Start the Orchestra service when you sign in (Windows: the "Orchestra" logon task). */
export async function startWithPc(enable?: boolean): Promise<boolean | null> {
  if (platform() !== 'win32') return null;
  try {
    if (enable !== undefined) await run('schtasks.exe', ['/Change', '/TN', 'Orchestra', enable ? '/ENABLE' : '/DISABLE'], { windowsHide: true });
    const { stdout } = await run('schtasks.exe', ['/Query', '/TN', 'Orchestra', '/FO', 'CSV', '/NH'], { windowsHide: true });
    return !/Disabled/i.test(stdout);
  } catch { return null; }
}
