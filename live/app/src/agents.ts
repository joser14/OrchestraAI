// Agent definitions, owned by Orchestra (replaces set-schedules.ps1): the instructions and tool allow-lists of the
// main / worker / worker2 jobs. Team actions are native tools from the orchestra-team plugin, so nothing here
// asks a small model to type shell command lines.
import type { Config } from './config.ts';
import type { Gateway } from './gateway.ts';
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const AGENT_SPEC_VERSION = 11;

// v6 (harness v2): the brief is an agenda (brief.ts), so the instructions say "work the agenda", not "read posts
// and decide". Paths come from this PC's config; the worker list is whatever size the team is.
const COMMON = (cfg: Config) => `ALL TEAM TALK IS ON THE BOARD: team_post and team_say both appear there for jr to see. Be brief and useful.
DELIVER PDFs: anything meant for jr (report, summary, list, research, plan) is a PDF. Write Markdown with a # title,
## sections, bullet lists and tables to ${join(cfg.workDir, 'name.md')}, then call team_pdf with the file name and
give jr the .pdf path. Scratch notes for the team may stay .md.
Work files go in ${cfg.workDir}. Files from jr are in ${cfg.inboxDir}.
LONG WEB PAGES: web_fetch returns at most 6000 characters; if it gives a spill file, read it about 150 lines at a time.
Memory: each run starts fresh. Save what you will need next time (decisions, file locations) to memory.
Each run has a time limit of a few minutes: keep steps small and save progress to files. If a tool refuses a call, read the reason and do something else: never repeat
the same call.`;

const MAIN = (cfg: Config) => `You are main, the brain of an AI team: ${cfg.workers.join(', ')} work for you; jr is your boss.
You plan, decide and delegate. You never do the work yourself: you have no tools to write files, search the web or
make PDFs - the workers do all of that. You run in short passes. Each pass:
1. Call team_brief ONCE. Its "NEEDS YOU" list is your agenda for this pass, in order. Nothing else needs you.
2. Work through the agenda with tool calls (never just describe a plan in text - call the tools):
   - NEW REQUEST from jr: turn it into jobs with team_assign, one call per job, each naming the exact file to write,
     spread over free workers. Routine jobs: model fast. Jobs that need real thinking (analysis, writing, planning,
     comparing, code): ONE worker with model smart, the best model. Then tell jr your plan in two or three lines
     (team_post to jr). Only questions about the team itself (status, what is done) do you answer directly.
   - RESULT / FINISHED: read the file(s) it names. Good -> tell jr the result and the PDF path. Wrong -> team_assign a fix.
   - QUESTION from a worker: decide and answer it (team_post to that worker).
   - STUCK / PROBLEM: assign a smaller job or another model (model: smart is best, fast is quick), or team_cancel it.
3. Explain each decision in one line when you post it, so the team and jr can follow your thinking.
4. Never assign anything listed under IN PROGRESS or FINISHED LATELY, and never invent work jr did not ask for.
5. End EVERY pass with team_sleep: 1-2 minutes while workers are busy, 20 when there is nothing to do.
   team_sleep marks the whole agenda as handled; after it, reply with one short line and stop.
${COMMON(cfg)}`;

const WORKER = (cfg: Config, name: string) => `You are ${name}, a worker on an AI team: main is the brain, your teammates are ${cfg.workers.filter((w) => w !== name).join(', ') || 'none'}.
1. Call team_brief. It shows YOUR TASK, what your teammates are doing and messages for you.
2. No task and no question for you: stop now.
3. Post your plan in one line: team_post to main "Starting T3: ...".
4. Do the work for real: files in ${cfg.workDir}, web search, commands, whatever it needs. Reuse files the team
   already made. Need a teammate? team_say to them, then team_read with wait 30.
${process.platform === 'win32' ? `   The exec tool runs PowerShell, not cmd: use Remove-Item -Recurse -Force <path>, Get-ChildItem, Move-Item,
   Copy-Item, New-Item -ItemType Directory (never del /q, rmdir /s, dir /b). By pattern: Remove-Item 'C:\dir\*.tmp'
   (Get-ChildItem -Include matches nothing without -Recurse). "(no output)" does not prove it worked: after
   deleting, moving or creating files, run Get-ChildItem on the folder and put that listing in your note as proof.
   If a file is still there, fix it before team_done.
` : ''}5. Stuck, or the task is unclear? team_post your question to main and stop: main answers on its next pass.
6. Finished: team_done with the task id and a note naming every file you made. Then stop.
${COMMON(cfg)}`;

const mcpNote = (server: string) => `\nEXTRA TOOLS: the tools named ${server}__... come from the ${server} MCP server; use them when they fit the job.`;

export function agentSpecs(cfg: Config): Record<string, { message: string; tools: string[]; thinking?: string }> {
  const g = (names: string[]) => names.flatMap((n) => cfg.toolGroups[n].split(','));
  const specs: Record<string, { message: string; tools: string[]; thinking?: string }> = {
    // The brain plans, decides and delegates; it does no work itself (no write, shell, web or PDF tools).
    // `read` stays so it can check the files workers deliver. Thinking starts "low" (the rescue proxy catches tool
    // calls Qwen3 writes inside its thinking); after creation Settings > OpenClaw owns it.
    main: { message: MAIN(cfg), thinking: 'low', tools: ['read', ...g(['memory']), 'team_brief', 'team_post', 'team_say', 'team_assign', 'team_cancel', 'team_sleep'] },   // no team_read: main never waits for replies (they wake it)
  };
  for (const w of cfg.workers) specs[w] = { message: WORKER(cfg, w), tools: g(['files', 'memory', 'web', 'shell', 'team']) };
  // Tools page > Agent tools: extra OpenClaw tool groups switched on per agent (e.g. the browser for a worker).
  for (const [a, groups] of Object.entries(cfg.extraTools || {})) {
    if (!specs[a]) continue;
    for (const grp of groups) if (cfg.toolGroups[grp]) specs[a].tools.push(...cfg.toolGroups[grp].split(',').filter((t) => !specs[a].tools.includes(t)));
  }
  // Tools page > your own tools: commands the user saved for the workers; they run them with exec.
  const mine = (cfg.customTools || []).filter((t) => t.agents);
  if (mine.length) for (const w of cfg.workers) {
    if (!specs[w].tools.includes('exec')) continue;
    specs[w].message += `\nJR'S TOOLS (run with exec; put the input in place of {input}):\n${mine.map((t) => `- ${t.name}: ${t.about} -> ${t.command}`).join('\n')}`;
  }
  // MCP servers from Settings: OpenClaw names their tools <server>__<tool>; allow each server's tools by pattern.
  for (const [server, access] of Object.entries(cfg.mcp || {})) {
    if (access === 'none') continue;
    for (const a of access === 'all' ? Object.keys(specs) : cfg.workers) { specs[a].tools.push(`${server}__*`); specs[a].message += mcpNote(server); }
  }
  return specs;
}

/** Team rules every agent loads at the start of each session (its workspace AGENTS.md). Must agree with the job
 * instructions: an old file telling agents to run `powershell ... ctl.ps1 brief` overrode the new tools. */
export const teamRules = (cfg: Config) => `# Team rules (all agents)

Team: \`main\` (the brain), ${cfg.workers.map((w) => `\`${w}\``).join(', ')}. Human boss: \`jr\`.

- Start every run by calling the **team_brief** tool. Do not read BOARD.md and do not run ctl.ps1.
- All team communication happens on the board: **team_post** (to: jr, main, a worker or all) and **team_say** both show there.
- Workers finish a task with **team_done** (task id + files made). Questions go to main with team_post.
- main assigns work with **team_assign** (one concrete job, naming the file), cancels with **team_cancel**,
  and ends each pass with **team_sleep**.
- Deliverables for jr are PDFs: write Markdown in ${join(cfg.workDir, 'name.md')}, then call **team_pdf** with the file name.
- Work files go in ${cfg.workDir}. Files from jr are in ${cfg.inboxDir}.
- If a tool refuses a call, read the reason and do something else; never repeat the same call.
- Save important facts to memory before you finish; each run starts fresh. Keep posts short; never repeat a post.
`;

export function writeWorkspaceRules(cfg: Config, log: (m: string) => void) {
  for (const a of cfg.agents) {
    const f = join(cfg.root, 'agents', a, 'AGENTS.md');
    if (!existsSync(dirname(f))) continue;
    writeFileSync(f, teamRules(cfg));
    log(`agent ${a}: workspace team rules updated (team tools)`);
  }
  if (existsSync(join(cfg.root, 'agents'))) writeFileSync(join(cfg.root, "agents", "TEAM-AGENTS.md"), teamRules(cfg));
}

/** Write the instructions and tool lists into the agents' jobs (keeps each job's model). */
export async function applyAgentSpecs(cfg: Config, gw: Gateway, log: (m: string) => void) {
  const specs = agentSpecs(cfg);
  writeWorkspaceRules(cfg, log);
  // A run gets only tools allowed BOTH by the agent's config (agents.entries.<a>.tools.allow) and by its job:
  // keep the config list identical to the job list (it still had `process` and lacked the team tools).
  const patch: any = { agents: { entries: {} } }; const replacePaths: string[] = [];
  for (const [a, s] of Object.entries(specs)) { patch.agents.entries[a] = { tools: { allow: s.tools } }; replacePaths.push(`agents.entries.${a}.tools.allow`); }
  try {
    const cur: any = await gw.rpc('config.get', {});   // baseHash: refuse to overwrite a concurrent config change
    await gw.rpc('config.patch', { raw: JSON.stringify(patch), replacePaths, baseHash: cur.hash });
    log('agent tool allow-lists synced in the OpenClaw config');
  }
  catch (e: any) { log(`could not sync agent tool allow-lists: ${e.message.slice(0, 200)}`); throw e; }
  const jobs = await gw.jobs();
  for (const [a, s] of Object.entries(specs)) {
    const j = jobs.find((x: any) => x.name === `${a}-board`);
    if (!j) { log(`agent job ${a}-board not found`); continue; }
    // thinking / light context / run limit are Settings > OpenClaw (settings.ts applyAgentOptions), not overwritten here
    await gw.updateJob(j.id, { payload: { kind: j.payload.kind, message: s.message, toolsAllow: s.tools } });
    log(`agent ${a}: instructions v${AGENT_SPEC_VERSION} + ${s.tools.length} tools applied`);
  }
}
