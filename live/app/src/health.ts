// Self-healing, ported from watchdog.ps1 / dispatcher.ps1 and made cross-platform:
//  - orphaned model runners (llama-server left behind when Ollama dies; they held 6 GB with nothing loaded)
//  - hung gateway (port open but not answering; agents silently stopped for 10+ min) -> restart
//  - Ollama not answering -> start it
//  - keep the PC awake while the team has work (a child process holding the OS sleep blocker)
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { listProcessesNative, setAwake } from './win32.ts';
import { createRequire } from 'node:module';
const run = promisify(execFile);
const isWin = platform() === 'win32';
const prereqs = createRequire(import.meta.url)('../lib/prereqs.cjs');

export interface Proc { pid: number; ppid: number; name: string; started?: string; memMB?: number }

export async function listProcesses(): Promise<Proc[]> {
  if (isWin) return listProcessesNative();   // Toolhelp snapshot via FFI: 17 ms, no PowerShell
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,rss=,comm=']);
  return stdout.trim().split('\n').map((l) => { const [pid, ppid, rss, ...c] = l.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, memMB: Math.round(+rss / 1024), name: c.join(' ').split('/').pop()! }; });
}

/** Model runners whose parent is not a live Ollama process. */
export function findOrphanRunners(procs: Proc[]): Proc[] {
  const ollama = new Set(procs.filter((p) => /^ollama/i.test(p.name)).map((p) => p.pid));
  return procs.filter((p) => /^(llama-server|ollama_llama_server)(\.exe)?$/i.test(p.name) && !ollama.has(p.ppid));
}

export async function killOrphanRunners(log: (m: string) => void): Promise<number> {
  const orphans = findOrphanRunners(await listProcesses());
  for (const p of orphans) { try { process.kill(p.pid, 'SIGKILL'); log(`killed orphaned model runner ${p.pid} (${p.memMB} MB) - it was holding VRAM`); } catch {} }
  return orphans.length;
}

/** HTTP probe: the gateway answers on its port when healthy. */
export async function gatewayAnswers(port = 18789, timeoutMs = 15000): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) }); return r.status < 500; } catch { return false; }
}
export async function ollamaAnswers(timeoutMs = 10000): Promise<boolean> {
  try { return (await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(timeoutMs) })).ok; } catch { return false; }
}

/** Restart the gateway: kill whatever owns the port, then start it the way OpenClaw installed it. */
export async function restartGateway(openclawMjs: string, port = 18789): Promise<void> {
  if (isWin) {
    try {
      const { stdout } = await run('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
      const line = stdout.split('\n').find((l) => l.includes(`127.0.0.1:${port}`) && /LISTENING/.test(l));
      const pid = line && +line.trim().split(/\s+/).pop()!;
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {}
  }
  // Windows: the shared starter (system Node, not process.execPath - inside the desktop app that is electron.exe;
  // OpenClaw's service if installed, else the gateway run directly)
  if (isWin) { await prereqs.startGateway(() => {}); return; }
  const child = spawn(process.execPath, [openclawMjs, 'gateway', 'start'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.unref();
}

export function startOllama(): void {
  const exe = isWin ? `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama app.exe` : 'ollama';
  const child = spawn(exe, isWin ? [] : ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
}

/** Holds the OS "don't sleep" request while the team is busy; released when idle (power settings untouched). */
export class KeepAwake {
  private child: ChildProcess | null = null;
  private winOn = false;
  set(busy: boolean) {
    if (process.env.ORCHESTRA_KEEPAWAKE === 'electron') return;   // the desktop app holds Electron's powerSaveBlocker instead
    if (isWin) { if (busy !== this.winOn) { setAwake(busy); this.winOn = busy; } return; }   // SetThreadExecutionState via FFI
    if (busy && !this.child) {
      if (platform() === 'darwin') this.child = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
      else this.child = spawn('systemd-inhibit', ['--what=sleep', '--why=Orchestra agents working', 'sleep', 'infinity'], { stdio: 'ignore' });
      this.child.on('error', () => { this.child = null; });
      this.child.on('exit', () => { this.child = null; });
    } else if (!busy && this.child) { this.child.kill(); this.child = null; }
  }
  get active() { return this.winOn || !!this.child; }
}
