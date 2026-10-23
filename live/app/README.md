# Orchestra (developer notes)

A local AI team for any PC: a **composer** (agent `main`) that plans and assigns, and **workers** (`worker`,
`worker2`, up to `worker8`) that do the jobs, running on [OpenClaw](https://docs.openclaw.ai) agents and
[Ollama](https://ollama.com) models (abliterated, standard or your own) sized to the machine. The person using it is
`user` on the board. One Node.js/TypeScript service with a desktop app (Electron).

## What is where

| Path | What |
|---|---|
| `src/main.ts` | Service entry: timers, file watchers, health loop, API + dashboard servers |
| `src/orchestrator.ts` | The pass loop: outbox, tasks, picks, relay, helpers, scheduling, runaway stop |
| `src/brief.ts`, `interpret.ts`, `fastpath.ts` | The composer's agenda, the reading of the user's newest message, simple asks sent straight to a worker |
| `src/rules.ts` | Pure team rules (TASK / DONE / CANCEL / MODEL / TOOLS, DONE verification, auto-done, renumbering) |
| `src/store.ts` | SQLite store (posts, tasks, archive, agent talk, state) |
| `src/compat.ts` | Readable copies of the board in the data folder (`BOARD.md`, `tasks.json`, `TASKS.md`) |
| `src/gateway.ts` | In-process OpenClaw gateway client (public SDK; 15-60 ms per call) |
| `src/health.ts` | Orphaned model runners, hung gateway restart, Ollama start, keep-awake |
| `src/api.ts` | Team API on 127.0.0.1:8790 (token) used by the agents' native tools |
| `src/web.ts` | Dashboard + its API on 127.0.0.1:8787 |
| `src/agents.ts`, `team.ts` | Agent instructions, tool allow-lists, workspace rules (applied on version change); team size |
| `src/hardware.ts`, `catalog.ts`, `select.ts`, `light.ts`, `setup.ts` | Hardware scan, model catalog, lineup selection (Light mode on small PCs), first-run setup |
| `src/memory.ts`, `learn.ts`, `teamskills.ts` | Standing notes, learned memory, SKILL.md playbooks |
| `src/imagegen.ts` | Pictures from a prompt (`team_image`) |
| `web/index.html`, `web/assets/` | The dashboard: Flow, Dashboard, Chat, Tasks, Files, Memory, Board, Agent details, Metrics, Sessions, Tools, Skills, Settings, Models, Setup, System, Logs |
| `lib/prereqs.cjs` | What the PC needs (Node.js, Ollama, OpenClaw, its setup and gateway, agent tools): checked at launch and on the Setup page, installed or started |
| `lib/` (other) | md2pdf, live view, metrics, browser helpers |
| `plugin/` | `orchestra-team` OpenClaw plugin: `team_brief`, `team_post`, `team_done`, `team_assign`, `team_cancel`, `team_sleep`, `team_say`, `team_read`, `team_pdf`, `team_image` |
| `desktop/` | Electron shell (window, tray, keep-awake, service host, startup check, auto-update) + installer config |
| `test/` | `node --test` suites (rules, selection, compat, interpret, fast path, API guardrails, activity feed) |

## Run, test, package

```bash
node --no-warnings src/main.ts            # service (the desktop app or the "Orchestra" logon task runs it)
node --no-warnings src/main.ts --once --dry   # one rehearsal pass on ORCHESTRA_ROOT, no agents touched
node --no-warnings --test test/*.test.ts  # tests
cd desktop && npx electron .              # desktop app (reuses a running service)
cd desktop && npx electron-builder --win nsis --config electron-builder.yml   # installer -> dist/
cd plugin && npm run plugin:validate      # plugin manifest + types
```

Data folder: `ORCHESTRA_ROOT`, else `~/Orchestra`. The launcher `Orchestra.cmd` (repository root) sets it to
`live\data`; `Orchestra.cmd build` rebuilds the installer into `installer\`. It holds the board, work and inbox
files, logs, backups, memory, skills, the agents' workspaces, the model aliases and the API token, and is never in
version control.

## Guardrails for small models (enforced in code, not prompts)

- `team_assign` refuses duplicates of an open task, more than 2 open tasks per worker, placeholder/example text,
  and jobs that do not name the file to write (so DONE can be verified).
- `team_pdf` explains what to do when given a PDF or a missing file; `team_sleep` tells the composer its pass is over.
- Tasks close on `DONE` only when every named file exists; they also close automatically when the files appear.
- Agents never get the `process` tool (it caused a polling loop); stopping a run uses `sessions.abort`, never
  archiving (archiving a job's session disables the job).

## Platforms

Windows, macOS and Linux installers are built by the release workflow (see the main [README](../../README.md)).
The startup check installs anything missing with winget on Windows and Homebrew on macOS; on Linux it shows the
command to run (apt / dnf need sudo).
Installers are unsigned unless signing secrets are set.
