// Orchestra service entry point (phase 1: replaces the board dispatcher + watchdog scheduled tasks).
//   node src/main.ts            run the service
//   node src/main.ts --once     one pass, then exit (diagnostics)
import '../lib/hide-windows.cjs';   // first: every process this service starts is windowless (Windows)
import { watch, existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Gateway, openclawRoot } from './gateway.ts';
import { Orchestrator } from './orchestrator.ts';
import { writeStatus, mirrorToOpenClaw, housekeeping } from './outputs.ts';
import { startApi } from './api.ts';
import { startWeb } from './web.ts';
import { Setup } from './setup.ts';
import { Library } from './library.ts';
import { UsageIndex } from './usage.ts';
import { applyAgentSpecs, AGENT_SPEC_VERSION } from './agents.ts';
import { syncTeam } from './bootstrap.ts';
import { applyTeamSize } from './team.ts';
import { getSettings, applyAgentOptions, pauseSkillReviews } from './settings.ts';
import { trackWorkFiles } from './fileevents.ts';
import { feedActivity } from './activityfeed.ts';
import { startOllamaProxy } from './ollamaproxy.ts';
import { killOrphanRunners, gatewayAnswers, ollamaAnswers, restartGateway, startOllama } from './health.ts';

// One service per PC: the logon task and the desktop app may both try to start it.
const portInUse = (port: number) => new Promise<boolean>((ok) => { const s = connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); });
if (!process.argv.includes('--dry') && !process.argv.includes('--once') && await portInUse(8790)) {
  console.log('Another Orchestra service is already running on this PC; exiting.');
  process.exit(0);
}

const cfg = loadConfig();
process.env.ORCHESTRA_ROOT = cfg.root;   // lib/*.cjs and child processes (gateway restart) use the same data folder
mkdirSync(join(cfg.root, 'orchestra'), { recursive: true });
const store = new Store(cfg.dbFile);
applyTeamSize(cfg, getSettings(store).workerCount);   // main + 1-8 workers (Settings)
cfg.mcp = store.get('mcpAccess', {});   // MCP servers from Settings and which agents get their tools
cfg.extraTools = store.get('extraTools', {}); cfg.customTools = store.get('customTools', []);   // Tools page
const gw = new Gateway(2, 30000);
const dry = process.argv.includes('--dry');   // rehearsal on a copied folder: never touches the agents
const o = new Orchestrator(cfg, store, gw, { dryRun: dry });
const usage = new UsageIndex(store, cfg.agents, cfg.logDir);   // hourly metrics rollups (all-time history)

const first = o.compat.importInitial();
if (first.posts || first.tasks) o.log(`took over the board: imported ${first.posts} post(s) and ${first.tasks} task(s)`);
o.log(`Orchestra service started (pid ${process.pid})`);
// New instructions, or a team size whose agents do not exist yet: bring OpenClaw in line (creates what is missing).
// Retried from the health check until it succeeds (the gateway may still be starting when the service starts).
let syncing = false;
async function ensureTeamInSync() {
  const teamKey = `${AGENT_SPEC_VERSION}:${cfg.workers.join(',')}`;
  if (dry || syncing || store.get('agentSpecVersion', '') === teamKey) return;
  if (!(await gatewayAnswers())) return;
  syncing = true;
  try {
    await syncTeam(cfg, gw, join(import.meta.dirname, '..', 'plugin'), (m) => o.log(m));
    await applyAgentOptions(store, gw, (m) => o.log(m));   // Settings > OpenClaw: thinking, light context, run limit
    store.set('agentSpecVersion', teamKey); o.log(`team in sync (${teamKey})`);
  }
  catch (e: any) {
    o.log(`could not sync the team (${e.message.split('\n')[0]}); applying instructions to the existing agents, will retry`);
    try { await applyAgentSpecs(cfg, gw, (m) => o.log(m)); } catch {}
  } finally { syncing = false; }
}
if (!dry) startOllamaProxy((m) => o.log(m));   // tool-call rescue for thinking runs (OpenClaw uses it while thinking is on)
await ensureTeamInSync();

let lastTick = 0;
async function tick() {
  lastTick = Date.now();
  await o.pass();
  try { trackWorkFiles(store, cfg.workDir, (m) => o.log(m)); } catch {}   // added/removed files for the Flow page
  try { feedActivity(store, cfg.agents, cfg.logDir); } catch {}   // what the agents did inside their runs -> activity.log
  try { await writeStatus(o); } catch {}
  if (!dry) mirrorToOpenClaw(o).catch(() => {});
}

// Health every 2 min: orphaned runners, Ollama, and the gateway (hung = port open but not answering twice).
let gwBad = 0, lastGwRestart = 0;
async function health() {
  if (existsSync(join(cfg.root, '.stopped'))) return;
  try { await killOrphanRunners((m) => o.log(m)); } catch {}
  if (!(await ollamaAnswers())) { o.log('Ollama not answering -> starting it'); startOllama(); }
  if (await gatewayAnswers()) gwBad = 0;
  else if (++gwBad >= 2 && Date.now() - lastGwRestart > 4 * 60000) {
    o.log('gateway not answering twice -> restarting it'); lastGwRestart = Date.now(); gwBad = 0;
    try { await restartGateway(join(openclawRoot(), 'openclaw.mjs')); } catch (e: any) { o.log(`gateway restart failed: ${e.message}`); }
  } else if (gwBad === 1) o.log('gateway not answering - will restart if still down next check');
  await ensureTeamInSync();
}

if (process.argv.includes('--once')) {
  await tick(); if (!dry) await health();
  console.log('one pass done; see logs\\dispatch.log');
  process.exit(0);
}

// Event triggers: a new outbox file or a BOARD.md edit runs a pass within ~3 s (instead of waiting a minute).
let debounce: NodeJS.Timeout | null = null;
const soon = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { debounce = null; tick(); }, 3000); };
for (const p of [cfg.outbox, cfg.boardDir]) { try { watch(p, (_e, f) => { if (!f || /\.(md|txt)$/i.test(String(f)) && !/^(BOARD|TASKS)\.md|\.tmp$/i.test(String(f))) soon(); }); } catch {} }

if (!dry) startApi(o, soon);   // team API for the orchestra-team plugin's tools
if (!dry) startWeb(o, { soon, webDir: join(import.meta.dirname, '..', 'web'), setup: new Setup(store, gw, cfg, join(import.meta.dirname, '..', 'plugin')), library: new Library(o), usage });   // the dashboard (replaces board-gui\server.js)
await tick();
// Every 30 s, or every 10 s while an agent runs: the next step (main reviewing a report, a queued post) starts
// soon after a run ends instead of up to 30 s later.
setInterval(() => { if (Date.now() - lastTick >= 29000 || cfg.agents.some((a) => o.running(a))) tick(); }, 10000);
setInterval(health, 120000); health();
// Hourly, and once 2 min after start: a service restarted more often than hourly never reached the timer, so the
// work folder's history stopped being saved (seen: no snapshot for a week).
const chores = () => { housekeeping(o).catch(() => {}); if (!dry) pauseSkillReviews(store, gw, (m) => o.log(m)).catch(() => {}); };
setTimeout(chores, 120000);
setInterval(chores, 3600000);
setInterval(() => { try { usage.update(true); } catch (e: any) { o.log(`usage index: ${e.message}`); } }, 300000);
try { usage.update(true); } catch (e: any) { o.log(`usage index: ${e.message}`); }
process.on('SIGINT', () => { o.awake.set(false); store.close(); process.exit(0); });
process.on('SIGTERM', () => { o.awake.set(false); store.close(); process.exit(0); });
