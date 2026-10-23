// orchestra-team: the team's commands as native agent tools (replaces typing `powershell ... ctl.ps1 ...` lines).
// Each tool calls the Orchestra service's local API. The calling agent comes from the runtime tool context
// (toolContext.agentId), never from the model, so an agent cannot post or assign as someone else.
import { Type, type TSchema } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type Cfg = { apiUrl?: string; tokenFile?: string };

/** Same data root as the service: ORCHESTRA_ROOT, else ~/Orchestra (Setup also writes the exact tokenFile into the plugin config). */
function defaultTokenFile() {
  const root = process.env.ORCHESTRA_ROOT || join(homedir(), "Orchestra");
  return join(root, "orchestra", "api-token");
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((ok, bad) => {
  const t = setTimeout(ok, ms); signal?.addEventListener("abort", () => { clearTimeout(t); bad(signal.reason); }, { once: true });
});

/** POST to the Orchestra API. Connection failures (the service restarting, ~5 s) are retried for up to ~20 s so a
 *  restart never surfaces to the model as a broken tool; API refusals (4xx) are returned at once as the reason. */
async function call(cfg: Cfg, agent: string | undefined, cmd: string, body: unknown, signal?: AbortSignal) {
  const url = (cfg.apiUrl ?? "http://127.0.0.1:8790") + "/team/" + cmd;
  let last: unknown;
  for (const wait of [0, 1000, 2000, 4000, 6000, 8000]) {
    if (wait) await sleep(wait, signal);
    let r: Response;
    try {
      const token = readFileSync(cfg.tokenFile ?? defaultTokenFile(), "utf8").trim();
      r = await fetch(url, {
        method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
        headers: { "Content-Type": "application/json", "x-orchestra-token": token },
        body: JSON.stringify({ ...(body as object), agent }),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      // the service answered too slowly: retrying would only repeat the wait (seen: 6 x 60 s on one call)
      if ((e as Error)?.name === "TimeoutError") throw new Error("The Orchestra service took too long to answer. Do not retry this call: do the next thing, or end your turn with one short line.");
      last = e; continue;   // not reachable yet: retry
    }
    if (r.status === 502 || r.status === 503) { last = new Error(`Orchestra API busy (HTTP ${r.status})`); continue; }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(String(j.error ?? r.statusText));   // tools throw on failure; the model sees the reason
    return j;
  }
  throw new Error(`The Orchestra service is not answering (${(last as Error)?.message ?? "unknown"}). Do not work around it: end your turn with one short line; you will be started again when it is back.`);
}

/** Build one factory tool: static metadata for the manifest + a runtime tool bound to the calling agent. */
function teamTool<P extends TSchema>(name: string, label: string, description: string, parameters: P, cmd = name.replace(/^team_/, "")) {
  return {
    name, label, description, parameters,
    factory: ({ config, toolContext }: { config: Cfg; toolContext: { agentId?: string } }) => ({
      name, label, description, parameters,
      async execute(_id: string, params: unknown, signal?: AbortSignal) {
        const j = await call(config, toolContext.agentId, cmd, params ?? {}, signal);
        const text = typeof j.text === "string" ? j.text : JSON.stringify(j, null, 1);
        return { content: [{ type: "text" as const, text }], details: j };
      },
    }),
  };
}

export default defineToolPlugin({
  id: "orchestra-team",
  name: "Orchestra Team",
  description: "Team board, tasks, talk and PDFs for the Orchestra brain + worker team.",
  configSchema: Type.Object({
    apiUrl: Type.Optional(Type.String({ description: "Orchestra API, default http://127.0.0.1:8790" })),
    tokenFile: Type.Optional(Type.String({ description: "File holding the Orchestra API token" })),
  }),
  tools: (tool) => [
    tool(teamTool("team_brief", "Team brief",
      "Start every run with this. Shows your open tasks and the new posts for you (main also sees the GPU, workers and all tasks).",
      Type.Object({}))),
    tool(teamTool("team_post", "Post to the board",
      "Post ONE message to the team board. to = jr, main, worker, worker2 or all. Never repeat an earlier post.",
      Type.Object({ to: Type.String({ description: "jr, main, worker, worker2 or all" }), message: Type.String() }))),
    tool(teamTool("team_done", "Finish a task",
      "Mark your task finished, e.g. task T3, with a one-line note of what you produced (file paths). It closes once every file the task names exists.",
      Type.Object({ task: Type.String({ description: "Task id like T3" }), note: Type.Optional(Type.String()) }))),
    tool(teamTool("team_assign", "Assign a job (main)",
      "main only: give one real job from jr's request to a worker you choose, in your own words, naming the file to write. Choose the model too: smart for jobs that need real thinking (analysis, writing, research, code), fast for routine jobs, vision for jobs with images. Your agenda lists the free workers and the models.",
      Type.Object({ worker: Type.String({ description: "which worker, e.g. worker or worker2" }), job: Type.String({ description: "the job, naming the file to write" }), model: Type.Optional(Type.String({ description: "smart, fast, vision ... (default: smart for thinking jobs, fast otherwise)" })), tools: Type.Optional(Type.String({ description: "e.g. web,shell (optional)" })) }))),
    tool(teamTool("team_cancel", "Cancel a task (main)", "main only: cancel a task that is no longer needed, e.g. T4.",
      Type.Object({ task: Type.String() }))),
    tool(teamTool("team_sleep", "Rest until next pass (main)",
      "main only: end your pass and rest N minutes (0-60): 0-1 while workers are busy, 5-15 when quiet, 30-60 when idle. A post from jr wakes you early.",
      Type.Object({ minutes: Type.Number() }))),
    tool(teamTool("team_say", "Talk to an agent now",
      "Send a quick message to main, a worker or all right now (arrives in seconds; it is also posted on the board). Use team_read to get the answer.",
      Type.Object({ to: Type.String(), message: Type.String() }))),
    tool(teamTool("team_read", "Read messages", "Workers only: read messages sent to you. wait = seconds to wait for a reply (0-45).",
      Type.Object({ wait: Type.Optional(Type.Number()) }))),
    tool(teamTool("team_pdf", "Make a PDF",
      "Turn a Markdown file in the work folder into a formatted PDF (the deliverable for jr). Give the file name, e.g. report.md.",
      Type.Object({ file: Type.String(), title: Type.Optional(Type.String()) }))),
  ],
});
