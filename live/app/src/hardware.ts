// Measure the PC: GPU vendor/model/VRAM (nvidia-smi, rocm-smi, Apple unified memory, Windows WMI
// fallback), RAM, CPU, free disk, and whether Ollama is installed and can use the GPU.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { statfsSync } from 'node:fs';
const run = promisify(execFile);
const GB = 2 ** 30;

/** unified: the GPU shares system RAM (Apple silicon, NVIDIA GB10 / DGX Spark, Jetson), so its "VRAM" is RAM.
 *  computeCap / driver: NVIDIA only (Blackwell = 10.x datacenter / 12.x GeForce & RTX PRO, needs driver 570+). */
export interface Gpu { vendor: 'nvidia' | 'amd' | 'apple' | 'intel' | 'other'; name: string; vramGB: number; freeGB: number; source: string; unified?: boolean; computeCap?: string; driver?: string }
export interface Hardware {
  os: string; arch: string; cpu: string; cores: number; ramGB: number; freeRamGB: number; diskFreeGB: number;
  gpus: Gpu[]; bestGpu: Gpu | null; warnings?: string[]; ollama: { installed: boolean; version?: string; gpuLibs?: string[] }; scannedAt: string;
}

async function tryRun(cmd: string, args: string[]): Promise<string> { try { return (await run(cmd, args, { windowsHide: true, timeout: 15000 })).stdout; } catch { return ''; } }

export async function nvidiaGpus(): Promise<Gpu[]> {
  let out = await tryRun('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,compute_cap,driver_version', '--format=csv,noheader,nounits']);
  if (!out.trim()) out = await tryRun('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits']);   // old drivers: no compute_cap field
  return parseNvidia(out, os.totalmem() / GB, os.freemem() / GB);
}

/** Parse nvidia-smi CSV. A GPU without its own memory (GB10 / DGX Spark, Jetson Thor: "[N/A]" or "Not Supported")
 *  shares system RAM: it gets 85% of RAM, the rest stays with the OS and the CPU side. */
export function parseNvidia(out: string, ramGB: number, freeRamGB: number): Gpu[] {
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [name, total, used, cap, driver] = l.split(',').map((s) => s.trim());
    const t = Number(total), u = Number(used);
    const extra = { ...(cap && /^\d+\.\d+$/.test(cap) ? { computeCap: cap } : {}), ...(driver && /^\d/.test(driver) ? { driver } : {}) };
    if (!Number.isFinite(t) || t <= 0) return { vendor: 'nvidia', name, vramGB: +(ramGB * 0.85).toFixed(1), freeGB: +(freeRamGB * 0.85).toFixed(1), source: 'unified memory', unified: true, ...extra } as Gpu;
    return { vendor: 'nvidia', name, vramGB: +(t / 1024).toFixed(1), freeGB: +((t - (Number.isFinite(u) ? u : 0)) / 1024).toFixed(1), source: 'nvidia-smi', ...extra } as Gpu;
  });
}

/** GPU memory in MB for the live gauges. Unified-memory GPUs (GB10 / DGX Spark) report "[N/A]": use system RAM. */
export function gpuMemMB(used: string, total: string): { used: number; total: number } {
  const t = parseFloat(total), u = parseFloat(used);
  if (Number.isFinite(t) && t > 0) return { used: Number.isFinite(u) ? u : 0, total: t };
  const MB = 2 ** 20; return { used: Math.round((os.totalmem() - os.freemem()) / MB), total: Math.round(os.totalmem() / MB) };
}

/** Problems worth telling the user about before they wait on a slow or failing run. */
export function gpuWarnings(gpus: Gpu[]): string[] {
  const w: string[] = [];
  for (const g of gpus) {
    const major = g.computeCap ? Number(g.computeCap.split('.')[0]) : 0;
    if (major >= 10 && g.driver && Number(g.driver.split('.')[0]) < 570) w.push(`${g.name} is a Blackwell GPU but the NVIDIA driver is ${g.driver}: update to 570 or newer, or models will run on the CPU`);
  }
  return w;
}
async function amdGpus(): Promise<Gpu[]> {
  const out = await tryRun('rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json']);
  if (!out) return [];
  try {
    return Object.values(JSON.parse(out) as Record<string, any>).filter((c: any) => c['VRAM Total Memory (B)']).map((c: any) => {
      const total = +c['VRAM Total Memory (B)'] / GB, used = +c['VRAM Total Used Memory (B)'] / GB;
      return { vendor: 'amd', name: c['Card series'] || c['Card SKU'] || 'AMD GPU', vramGB: +total.toFixed(1), freeGB: +(total - used).toFixed(1), source: 'rocm-smi' } as Gpu;
    });
  } catch { return []; }
}
function appleGpu(): Gpu[] {
  if (os.platform() !== 'darwin' || os.arch() !== 'arm64') return [];
  // Apple silicon shares RAM with the GPU; macOS lets the GPU wire about 75% of it by default.
  const total = os.totalmem() / GB;
  return [{ vendor: 'apple', name: os.cpus()[0]?.model || 'Apple silicon', vramGB: +(total * 0.75).toFixed(1), freeGB: +(os.freemem() / GB * 0.75).toFixed(1), source: 'unified memory' }];
}
async function wmiGpus(): Promise<Gpu[]> {
  if (os.platform() !== 'win32') return [];
  // AdapterRAM is a 32-bit field (caps at 4 GB); the registry's qwMemorySize has the real size.
  // reg.exe (built into Windows), one display-adapter key per GPU: DriverDesc + qwMemorySize (REG_QWORD, hex).
  const out = await tryRun('reg.exe', ['query', 'HKLM\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}', '/s']);
  const gpus: Gpu[] = [];
  for (const block of out.split(/\r?\n(?=HKEY_)/)) {
    const name = /DriverDesc\s+REG_SZ\s+(.+)/.exec(block)?.[1]?.trim();
    const mem = /HardwareInformation\.qwMemorySize\s+REG_QWORD\s+0x([0-9a-f]+)/i.exec(block)?.[1];
    if (!name || !mem) continue;
    const gb = parseInt(mem, 16) / GB;
    const vendor = /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'other';
    gpus.push({ vendor, name, vramGB: +gb.toFixed(1), freeGB: +gb.toFixed(1), source: 'registry' } as Gpu);
  }
  return gpus;
}

export async function scanHardware(): Promise<Hardware> {
  let gpus = [...await nvidiaGpus(), ...await amdGpus(), ...appleGpu()];
  if (!gpus.length) gpus = await wmiGpus();
  // Integrated GPUs share system RAM and are not useful for models: rank dedicated cards first.
  const usable = gpus.filter((g) => g.vendor !== 'intel' && g.vramGB >= 2);
  const bestGpu = usable.sort((a, b) => b.vramGB - a.vramGB)[0] ?? null;
  let diskFreeGB = 0; try { const s = statfsSync(os.homedir()); diskFreeGB = +(s.bavail * s.bsize / GB).toFixed(0); } catch {}
  let ollama: Hardware['ollama'] = { installed: false };
  try { const v: any = await (await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(5000) })).json(); ollama = { installed: true, version: v.version }; }
  catch { const v = await tryRun('ollama', ['--version']); if (v) ollama = { installed: true, version: v.trim().split(/\s+/).pop() }; }
  return {
    os: `${os.type()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model?.trim() ?? '', cores: os.cpus().length,
    ramGB: +(os.totalmem() / GB).toFixed(1), freeRamGB: +(os.freemem() / GB).toFixed(1), diskFreeGB, gpus, bestGpu, warnings: gpuWarnings(gpus), ollama, scannedAt: new Date().toISOString(),
  };
}

if (import.meta.main) console.log(JSON.stringify(await scanHardware(), null, 1));
