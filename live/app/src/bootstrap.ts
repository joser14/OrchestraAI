// Fresh-PC bootstrap: make sure OpenClaw has the team - the three agents, their board jobs and the
// orchestra-team plugin - creating whatever is missing. Everything goes through the gateway (config.patch,
// cron.add); safe to run on every start (it only adds what is missing and never touches existing pieces).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Gateway } from './gateway.ts';
import { agentSpecs, teamRules, applyAgentSpecs } from './agents.ts';

export interface Readiness { ollama: boolean; openclaw: boolean; gateway: boolean; agents: string[]; jobs: string[]; plugin: boolean; missing: string[]; others: string[] }

export async function readiness(cfg: Config, gw: Gateway, pluginDir: string): Promise<Readiness> {
  const r: Readiness = { ollama: false, openclaw: true, gateway: false, agents: [], jobs: [], plugin: false, missing: [], others: [] };
  try { r.ollama = (await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(4000) })).ok; } catch {}
  try {
    const c: any = await gw.rpc('config.get', {}); r.gateway = true;
    const src = c.sourceConfig || {};
    r.agents = cfg.agents.filter((a) => src.agents?.entries?.[a]);
    r.others = Object.keys(src.agents?.entries || {}).filter((a) => !cfg.agents.includes(a));   // the user's own OpenClaw agents
    // an agent that exists but was never set up for the team (no model, or main cannot delegate to the workers)
    for (const a of r.agents) {
      const e = src.agents.entries[a];
      if (!e.model?.primary || e.name !== a || e.identity?.name !== a || (a === 'main' && cfg.workers.some((w) => !(e.subagents?.allowAgents || []).includes(w)))) r.missing.push(`agent-setup:${a}`);
    }
    // OpenClaw only talks to the local Ollama when its provider has a base URL and the "ollama-local" key marker
    // (a fresh OpenClaw config has neither: every agent run then fails with "No API key found for provider ollama").
    const ol = src.models?.providers?.ollama || {};
    if (!ol.baseUrl || !ol.apiKey) r.missing.push('provider:ollama');
    // OpenClaw's Tool Search (on by default) hides the agents' tools behind a search step; local models never find
    // team_brief and end the run with NO_REPLY. Orchestra's agents have short, fixed tool lists: keep them visible.
    if (src.tools?.toolSearch !== false) r.missing.push('toolsearch');
    // model aliases (MODEL worker=smart) that point at models this PC does not have
    try { const tags = new Set<string>(((await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) })).json()).models || []).map((m: any) => m.name));
      const ok = (id: string) => { const n = String(id).replace(/^ollama\//, ''); return tags.has(n) || tags.has(n.replace(/:latest$/, '')) || tags.has(n + ':latest'); };
      if (tags.size && (Object.values(cfg.aliases).some((id) => !ok(id)) || !cfg.aliases.smart || !cfg.aliases.fast)) r.missing.push('aliases'); } catch {}
    r.plugin = !!src.plugins?.entries?.['orchestra-team']?.enabled && (src.plugins?.load?.paths || []).some((p: string) => p.toLowerCase() === pluginDir.toLowerCase() || existsSync(join(p, 'openclaw.plugin.json')) && p.toLowerCase().includes('plugin'));
    r.jobs = (await gw.jobs()).map((j: any) => j.name).filter((n: string) => /-board$/.test(n)).map((n: string) => n.replace(/-board$/, ''));
  } catch { r.openclaw = r.gateway; }
  if (!r.ollama) r.missing.push('ollama');
  if (!r.gateway) r.missing.push('openclaw');
  for (const a of cfg.agents) { if (!r.agents.includes(a)) r.missing.push(`agent:${a}`); if (!r.jobs.includes(a)) r.missing.push(`job:${a}`); }
  if (!r.plugin) r.missing.push('plugin');
  return r;
}

/** Create the missing agents, jobs and plugin registration. `models` = main + worker model ids (ollama/...).
 *  `mainFrom`: when OpenClaw has no "main", the user's choice - 'new', or one of their agents to base main on. */
export async function ensureTeam(cfg: Config, gw: Gateway, pluginDir: string, models: { brain: string; worker: string }, log: (m: string) => void, opts: { mainFrom?: string } = {}) {
  const r = await readiness(cfg, gw, pluginDir);
  if (!r.gateway) throw new Error('OpenClaw gateway is not running: install OpenClaw and start it first');
  const specs = agentSpecs(cfg);
  const cur: any = await gw.rpc('config.get', {}); const src = cur.sourceConfig || {};
  const patch: any = {}; const replacePaths: string[] = [];
  for (const a of cfg.agents.filter((x) => !r.agents.includes(x))) {
    const ws = join(cfg.root, 'agents', a); mkdirSync(join(ws, 'memory'), { recursive: true });
    if (!existsSync(join(ws, 'AGENTS.md'))) writeFileSync(join(ws, 'AGENTS.md'), teamRules(cfg));
    patch.agents ??= { entries: {} };
    // main based on one of the user's agents: keep its model and settings, give it the team's name, tools and workers
    const base = a === 'main' && opts.mainFrom && opts.mainFrom !== 'new' ? src.agents?.entries?.[opts.mainFrom] : null;
    if (a === 'main' && opts.mainFrom && opts.mainFrom !== 'new' && !base) throw new Error(`OpenClaw has no agent called ${opts.mainFrom}`);
    patch.agents.entries[a] = { ...(base ? JSON.parse(JSON.stringify(base)) : {}), name: a, workspace: ws, identity: { ...(base?.identity || {}), name: a },
      model: base?.model?.primary ? base.model : { primary: a === 'main' ? models.brain : models.worker, fallbacks: [a === 'main' ? models.worker : models.brain] },
      subagents: { ...(base?.subagents || {}), allowAgents: a === 'main' ? [...new Set([...(base?.subagents?.allowAgents || []), ...cfg.workers])] : [] }, tools: { ...(base?.tools || {}), allow: specs[a].tools } };
    log(base ? `bootstrap: creating agent main from your agent ${opts.mainFrom} (its model and settings; workspace ${ws})` : `bootstrap: creating agent ${a} (workspace ${ws})`);
  }
  // Agents that already exist (e.g. the "main" OpenClaw makes during its own first-time setup) are adopted: they get
  // the team's model, tools and delegation rights, and the stock workspace is swapped for Orchestra's (team rules).
  const stockWs = (w: string) => !w || /[\\/]\.openclaw[\\/]workspace[\\/]?$/i.test(w);
  for (const a of cfg.agents.filter((x) => r.agents.includes(x))) {
    const e = src.agents?.entries?.[a] || {}; const fix: any = {};
    if (!e.model?.primary) { fix.model = { primary: a === 'main' ? models.brain : models.worker, fallbacks: [a === 'main' ? models.worker : models.brain] }; replacePaths.push(`agents.entries.${a}.model`); }
    const allow: string[] = e.tools?.allow || [];
    if (specs[a].tools.some((t: string) => !allow.includes(t))) { fix.tools = { allow: specs[a].tools }; replacePaths.push(`agents.entries.${a}.tools.allow`); }
    if (a === 'main' && cfg.workers.some((w) => !(e.subagents?.allowAgents || []).includes(w))) { fix.subagents = { allowAgents: [...new Set([...(e.subagents?.allowAgents || []), ...cfg.workers])] }; replacePaths.push(`agents.entries.${a}.subagents.allowAgents`); }
    // named exactly like its id (OpenClaw's own setup calls it "Main"; the team and its rules say "main")
    if (e.name !== a || e.identity?.name !== a) { fix.name = a; fix.identity = { ...(e.identity || {}), name: a }; }
    if (stockWs(e.workspace)) {
      const ws = join(cfg.root, 'agents', a); mkdirSync(join(ws, 'memory'), { recursive: true });
      if (!existsSync(join(ws, 'AGENTS.md'))) writeFileSync(join(ws, 'AGENTS.md'), teamRules(cfg));
      fix.workspace = ws;
    }
    if (Object.keys(fix).length) { patch.agents ??= { entries: {} }; patch.agents.entries ??= {}; patch.agents.entries[a] = fix; log(`bootstrap: adopting existing agent ${a} (${Object.keys(fix).join(', ')})`); }
  }
  // The local Ollama provider: native URL (never /v1: it breaks tool calls) and the local key marker.
  const ol = src.models?.providers?.ollama || {};
  if (!ol.baseUrl || !ol.apiKey) {
    patch.models = { providers: { ollama: { baseUrl: ol.baseUrl || 'http://127.0.0.1:11434', api: ol.api || 'ollama', apiKey: ol.apiKey || 'ollama-local', models: ol.models || [] } } };
    log('bootstrap: connecting OpenClaw to the local Ollama (base URL + local key marker)');
  }
  if (src.tools?.toolSearch !== false) {
    patch.tools = { toolSearch: false };
    log('bootstrap: turning off OpenClaw Tool Search so the agents see their team tools directly');
  }
  // OpenClaw 2026.10+: a roster of more than one agent must carry agents.ownership="explicit" (OpenClaw stamps it
  // itself when it creates a fleet; we add agents through config.patch, so we stamp it). Each board job names its
  // agentId, so every run still resolves its owner.
  const roster = new Set([...Object.keys(src.agents?.entries || {}), ...Object.keys(patch.agents?.entries || {})]);
  if (roster.size > 1 && src.agents?.ownership !== 'explicit') {
    patch.agents ??= {}; patch.agents.ownership = 'explicit';
    log('bootstrap: marking the OpenClaw agent roster as multi-agent (agents.ownership = explicit)');
  }
  if (!r.plugin) {
    const paths = [...new Set([...(src.plugins?.load?.paths || []), pluginDir])];
    patch.plugins = { load: { paths }, entries: { 'orchestra-team': { enabled: true, config: { tokenFile: join(cfg.root, 'orchestra', 'api-token') } } } }; replacePaths.push('plugins.load.paths');
    log(`bootstrap: registering the orchestra-team plugin (${pluginDir})`);
  }
  if (Object.keys(patch).length) await gw.rpc('config.patch', { raw: JSON.stringify(patch), replacePaths, baseHash: cur.hash });
  // Jobs: one board job per agent, never fired by a timer (Orchestra starts them).
  const jobs = await gw.jobs();
  for (const a of cfg.agents.filter((x) => !jobs.some((j: any) => j.name === `${x}-board`))) {
    await gw.rpc('cron.add', {
      name: `${a}-board`, agentId: a, enabled: true, schedule: { kind: 'cron', expr: '0 0 1 1 *' }, sessionTarget: 'isolated', wakeMode: 'now', delivery: { mode: 'none' },
      payload: { kind: 'agentTurn', message: specs[a].message, model: a === 'main' ? models.brain : models.worker, fallbacks: [a === 'main' ? models.worker : models.brain], toolsAllow: specs[a].tools, ...(specs[a].thinking ? { thinking: specs[a].thinking } : {}), timeoutSeconds: 480 },
    });
    log(`bootstrap: created job ${a}-board`);
  }
  return readiness(cfg, gw, pluginDir);
}

/** Make OpenClaw match the team size in Settings: create agents + jobs for new workers (on the current worker
 *  model), let main delegate to every worker, and re-apply every agent's instructions (they name the teammates).
 *  Workers beyond the team size are left in OpenClaw untouched (switched off in Orchestra, nothing deleted). */
export async function syncTeam(cfg: Config, gw: Gateway, pluginDir: string, log: (m: string) => void, opts: { mainFrom?: string } = {}) {
  const jobs = await gw.jobs();
  const worker = jobs.find((j: any) => j.name === 'worker-board')?.payload?.model || jobs.find((j: any) => /^worker\d*-board$/.test(j.name))?.payload?.model;
  const brain = jobs.find((j: any) => j.name === 'main-board')?.payload?.model || worker;
  if (!worker || !brain) throw new Error('no worker model yet: run Setup first');
  const r = await ensureTeam(cfg, gw, pluginDir, { brain, worker }, log, opts);
  const cur: any = await gw.rpc('config.get', {});
  const allow = cur.sourceConfig?.agents?.entries?.main?.subagents?.allowAgents || [];
  if (cfg.workers.some((w) => !allow.includes(w))) {
    await gw.rpc('config.patch', { raw: JSON.stringify({ agents: { entries: { main: { subagents: { allowAgents: [...new Set([...allow, ...cfg.workers])] } } } } }), replacePaths: ['agents.entries.main.subagents.allowAgents'], baseHash: cur.hash });
    log(`team: main may now delegate to ${cfg.workers.join(', ')}`);
  }
  await applyAgentSpecs(cfg, gw, log);
  return r;
}
