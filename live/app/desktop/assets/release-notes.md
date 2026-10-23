Your own AI team, running privately on your computer. You ask for something; a composer plans it, workers do the
jobs, and the results land in your work folder as files, PDFs and pictures. Everything runs locally: nothing leaves
your machine.

## Download

| Your computer | File |
|---|---|
| Windows 10 / 11 | `Orchestra-Setup-x.y.z.exe` |
| Mac with Apple silicon (M1 and later) | `Orchestra-x.y.z-arm64.dmg` |
| Mac with an Intel chip | `Orchestra-x.y.z.dmg` |
| Linux | `Orchestra-x.y.z.AppImage` |

On first start Orchestra checks what it needs (Node.js, Ollama, OpenClaw), offers to install anything missing,
scans your hardware and downloads AI models that fit it. Windows and Linux copies update themselves; on a Mac,
download new versions here.

**First-run warnings:** the installers are not code-signed yet. Windows may say "Windows protected your PC": click
*More info*, then *Run anyway*. macOS may say the app is from an unidentified developer: right-click the app, then
*Open*.

## What it does

- **A team, sized to your PC.** Big graphics cards get big models; laptops and PCs without a graphics card get small
  ones, with one model for every job so nothing swaps in and out of memory (Light mode). Needs about 4 GB of free
  memory; 8 GB or more works much better.
- **Ask in plain words.** Simple jobs ("write…", "summarize…", "translate…", "draw…") go straight to a worker; bigger
  ones are planned by the composer, split into tasks and checked before they count as done.
- **Files, PDFs and pictures** in your work folder, with a history you can restore from.
- **Memory and playbooks**: notes every agent reads, facts it learns from your conversations, and step-by-step
  playbooks for jobs you want done the same way every time.
- **Dashboard**: live view of what each agent is doing, tasks, metrics, storage used, models, tools and settings.

## Requirements

- Windows 10 or 11, macOS, or Linux
- About 4 GB of free memory at minimum (8 GB+ recommended); a graphics card helps but is not required
- 3-20 GB of disk space for the models
- An internet connection for the first setup; after that it works offline
