# Orchestra

A local AI team for any PC: a **brain** (`main`) that plans and assigns, and **workers** that do the tasks, running
on [OpenClaw](https://docs.openclaw.ai) agents and abliterated [Ollama](https://ollama.com) models sized to the
machine. One Node.js/TypeScript service with a desktop app (Electron).

Design doc: "Orchestra – Design" (claude.ai artifact). Built on 2026-10-11 to replace the PowerShell scripts in
`C:\Agent\scripts` (dispatcher, watchdog, ctl, board GUI server).

## What is where

| Path | What |
|---|---|
| `src/main.ts` | Service entry: timers, file watchers, health loop, API + dashboard servers |
| `src/orchestrator.ts` | The pass loop: outbox, tasks, picks, relay, helpers, scheduling, runaway stop (port of `dispatcher.ps1`) |
| `src/rules.ts` | Pure team rules (TASK / DONE / CANCEL / MODEL / TOOLS, DONE verification, auto-done, renumbering) |
| `src/store.ts` | SQLite store (posts, tasks, archive, agent talk, state) |
| `src/compat.ts` | Keeps `BOARD.md` / `tasks.json` / `TASKS.md` in sync for older tools |
| `src/gateway.ts` | In-process OpenClaw gateway client (public SDK; 15-60 ms per call) |
| `src/health.ts` | Orphaned model runners, hung gateway restart, Ollama start, keep-awake |
| `src/api.ts` | Team API on 127.0.0.1:8790 (token) used by the agents' native tools |
| `src/web.ts` | Dashboard + its API on 127.0.0.1:8787 |
| `src/agents.ts` | Agent instructions, tool allow-lists and workspace rules (applied on version change) |
| `src/hardware.ts`, `catalog.ts`, `select.ts`, `setup.ts` | Hardware scan, model catalog, lineup selection, first-run setup |
| `web/index.html` | The dashboard (Dashboard, Live, Metrics, Board, Tasks, Files, Tools, Setup, System) |
| `lib/` | md2pdf, live view, metrics helpers |
| `plugin/` | `orchestra-team` OpenClaw plugin: `team_brief`, `team_post`, `team_done`, `team_assign`, `team_cancel`, `team_sleep`, `team_say`, `team_read`, `team_pdf` |
| `desktop/` | Electron shell (window, tray, keep-awake, service host) + installer config |
| `test/` | `node --test` suites (rules, selection, compat, API guardrails) |

## Run, test, package

```bash
node --no-warnings src/main.ts            # service (on this PC it runs as the "Orchestra" logon task)
node --no-warnings src/main.ts --once --dry   # one rehearsal pass on ORCHESTRA_ROOT, no agents touched
node --no-warnings --test test/*.test.ts  # tests
cd desktop && npx electron .              # desktop app (reuses a running service)
cd desktop && npx electron-builder --win nsis --config electron-builder.yml   # installer -> dist/
cd plugin && npm run plugin:validate      # plugin manifest + types
```

Data folder: `ORCHESTRA_ROOT`, else `C:\Agent` when it exists, else `~/Orchestra`. `E:\Orchestra\Orchestra.cmd` sets it to `live\data`;
`Orchestra.cmd build` rebuilds the installer into `installer\`.

## Guardrails for small models (enforced in code, not prompts)

- `team_assign` refuses duplicates of an open task, more than 2 open tasks per worker, placeholder/example text,
  and jobs that do not name the file to write (so DONE can be verified).
- `team_pdf` explains what to do when given a PDF or a missing file; `team_sleep` tells the brain its pass is over.
- Tasks close on `DONE` only when every named file exists; they also close automatically when the files appear.
- Agents never get the `process` tool (it caused a polling loop); stopping a run uses `sessions.abort`, never
  archiving (archiving a job's session disables the job).

## Status (2026-10-11)

- Phase 1 core service: live on this PC (dispatcher + watchdog tasks disabled), gate passed (109/109).
- Phase 2 hardware + models: scan, catalog, selection, setup wizard; gate passed (picks today's lineup; 4/4 models tested).
- Phase 3 app + dashboard: dashboard served by the service, Setup page, team tools plugin, Electron shell.
- Phase 4 installers: Windows NSIS build; code signing needs a certificate; macOS/Linux targets configured, untested.

Open: Settings page (team size, autonomy), first-run install of Ollama/OpenClaw on a fresh PC, plugin
dependency install on other PCs, chat window wired to main's chat session, clean-install test on a second PC.
