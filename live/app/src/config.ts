// Paths and tunables: the data folder layout, the team, timings and model aliases.
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

export type McpAccess = 'workers' | 'all' | 'none';
export interface Config {
  root: string; boardDir: string; outbox: string; workDir: string; inboxDir: string; logDir: string; dbFile: string;
  agents: string[]; workers: string[];
  maxTempC: number; agentCooldownMin: number; mainGapMin: number; busyRestMin: number; idleRestMin: number;
  helperMaxMin: number; runawayMin: number; maxPerHour: number; maxAttempts: number;
  aliases: Record<string, string>; toolGroups: Record<string, string>;
  /** MCP servers saved in OpenClaw and which agents may use their tools (Settings; kept in the store). */
  mcp: Record<string, McpAccess>;
  /** Tools page: extra OpenClaw tool groups per agent, and the user's own command tools (kept in the store). */
  extraTools: Record<string, string[]>;
  customTools: CustomTool[];
}
export interface CustomTool { name: string; about: string; command: string; agents: boolean }

/** Data folder: ORCHESTRA_ROOT (the launcher and the desktop app set it), else a per-user ~/Orchestra folder. */
export function defaultRoot(): string {
  if (process.env.ORCHESTRA_ROOT) return process.env.ORCHESTRA_ROOT;
  return join(homedir(), 'Orchestra');
}

export function loadConfig(root = defaultRoot()): Config {
  for (const d of ['board/outbox', 'work', 'inbox', 'logs', 'models', 'orchestra']) mkdirSync(join(root, d), { recursive: true });
  const aliasesFile = join(root, 'models', 'aliases.json');
  // The file is the truth once it exists (Setup and Fix keep it to models this PC has); these are the names Setup
  // gives its tested copies, a starting point for a folder that never had one.
  let aliases: Record<string, string> = {
    smart: 'ollama/orch-smart:latest', fast: 'ollama/orch-fast:latest',
    vision: 'ollama/orch-vision:latest', tiny: 'ollama/orch-tiny:latest',
  };
  if (existsSync(aliasesFile)) { try { aliases = JSON.parse(readFileSync(aliasesFile, 'utf8').replace(/^\uFEFF/, '')); } catch {} }
  return {
    root, boardDir: join(root, 'board'), outbox: join(root, 'board', 'outbox'), workDir: join(root, 'work'),
    inboxDir: join(root, 'inbox'), logDir: join(root, 'logs'), dbFile: join(root, 'orchestra', 'orchestra.db'),
    agents: ['main', 'worker', 'worker2'], workers: ['worker', 'worker2'],
    // cooldown: a worker's next task waits this long after its last start (3 min made a second job wait ~1.5 min)
    maxTempC: 86, agentCooldownMin: 0.5, mainGapMin: 1, busyRestMin: 3, idleRestMin: 15,
    helperMaxMin: 10, runawayMin: 11, maxPerHour: 40, maxAttempts: 3,
    aliases, mcp: {}, extraTools: {}, customTools: [],
    // no `process`: without it exec runs synchronously (small models mis-polled background jobs and looped)
    toolGroups: {
      files: 'read,write,edit,apply_patch', memory: 'memory_search,memory_get', web: 'web_search,web_fetch', shell: 'exec', browser: 'browser',
      // orchestra-team plugin: the board, tasks, talk and PDFs as native tools (always included)
      team: 'team_brief,team_post,team_done,team_say,team_read,team_pdf,team_image',
    },
  };
}
