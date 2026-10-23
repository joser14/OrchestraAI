// OpenClaw gateway client, in-process through OpenClaw's public SDK (plugin-sdk/gateway-runtime).
// Measured 15-60 ms per call vs 3-20 s for spawning the `openclaw` CLI (the cause of slow passes and hangs).
// At most 2 calls in flight; every call has a timeout; consecutive failures mark the gateway unhealthy.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

type CallFn = (method: string, opts: Record<string, unknown>, params?: unknown) => Promise<any>;

export function openclawRoot(): string {
  const cands = [process.env.OPENCLAW_ROOT, process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw'),
    '/usr/local/lib/node_modules/openclaw', '/opt/homebrew/lib/node_modules/openclaw'].filter(Boolean) as string[];
  const hit = cands.find((p) => existsSync(join(p, 'dist', 'plugin-sdk', 'gateway-runtime.js')));
  if (!hit) throw new Error('OpenClaw not found (set OPENCLAW_ROOT)');
  return hit;
}

export class Gateway {
  private call: CallFn | null = null;
  private inFlight = 0;
  private queue: (() => void)[] = [];
  failures = 0;
  lastOkAt = 0;
  maxInFlight: number;
  timeoutMs: number;
  constructor(maxInFlight = 2, timeoutMs = 30000) { this.maxInFlight = maxInFlight; this.timeoutMs = timeoutMs; }

  private async sdk(): Promise<CallFn> {
    if (!this.call) {
      const mod = await import(pathToFileURL(join(openclawRoot(), 'dist', 'plugin-sdk', 'gateway-runtime.js')).href);
      this.call = mod.callGatewayFromCli as CallFn;
    }
    return this.call;
  }
  private async slot() {
    if (this.inFlight < this.maxInFlight) { this.inFlight++; return; }
    await new Promise<void>((r) => this.queue.push(r)); this.inFlight++;
  }
  private release() { this.inFlight--; this.queue.shift()?.(); }

  /** One RPC. Throws on error or timeout. */
  async rpc<T = any>(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const call = await this.sdk();
    await this.slot();
    try {
      const r = await Promise.race([
        call(method, { json: true, timeout: String(timeoutMs) }, params),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} timed out after ${timeoutMs} ms`)), timeoutMs + 2000)),
      ]);
      this.failures = 0; this.lastOkAt = Date.now();
      return r as T;
    } catch (e) { this.failures++; throw e; }
    finally { this.release(); }
  }
  get healthy() { return this.failures < 2; }

  // ---- typed helpers used by the orchestrator ----
  async jobs(): Promise<any[]> { const r = await this.rpc('cron.list', {}); return r.jobs || r.items || (Array.isArray(r) ? r : []); }
  runJob(id: string) { return this.rpc('cron.run', { id }); }
  updateJob(id: string, patch: Record<string, unknown>) { return this.rpc('cron.update', { id, patch }); }
  /** Recent run history across jobs (entries carry jobId, not the job name). */
  async runs(limit = 50): Promise<any[]> { const r = await this.rpc('cron.runs', { limit }); return r.entries || r.runs || []; }
  /** Sessions of every agent (sessions.list covers all agents; filter by updatedAt for recency). */
  async sessions(): Promise<any[]> { const r = await this.rpc('sessions.list', {}); return r.sessions || r.items || []; }
  describe(key: string) { return this.rpc('sessions.describe', { key }); }
  patchSession(key: string, patch: Record<string, unknown>) { return this.rpc('sessions.patch', { key, ...patch }); }
  inject(sessionKey: string, message: string, label?: string) { return this.rpc('chat.inject', { sessionKey, message, label }); }
}
