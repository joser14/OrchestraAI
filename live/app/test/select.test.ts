// Phase 2 gate: on this laptop (RTX 3080 Laptop, 8 GB) the selector must pick today's lineup; other machines
// get sensible lineups per the design table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectLineup, needGB, lightWanted } from '../src/select.ts';
import { CATALOG } from '../src/catalog.ts';
import type { Hardware, Gpu } from '../src/hardware.ts';

const hw = (gpu: Partial<Gpu> | null, ramGB = 32): Hardware => ({
  os: 'test', arch: 'x64', cpu: 'test', cores: 8, ramGB, freeRamGB: ramGB / 2, diskFreeGB: 500, scannedAt: '',
  gpus: gpu ? [gpu as Gpu] : [], bestGpu: gpu ? ({ vendor: 'nvidia', name: 'test', source: 'test', ...gpu } as Gpu) : null, ollama: { installed: true },
});
const avail = new Set(CATALOG.map((m) => m.tag));   // pretend the registry has every tag

test('8 GB laptop: Light mode (auto) - the 8B brain does every job, so nothing swaps', () => {
  // 6.5 GB in use of which 6.3 GB are Ollama's own loaded models -> 7.8 GB capacity: 8B + 4B do not fit together
  const l = selectLineup(hw({ vramGB: 8, freeGB: 1.5 }), { ollamaLoadedGB: 6.3, available: avail });
  assert.equal(l.light, true);
  assert.equal(l.brain?.model.alias, 'smart'); assert.equal(l.worker?.model.alias, 'smart');
  assert.equal(l.parallelWorkers, 1); assert.equal(l.cpuOnly, false);
  assert.ok(l.brain!.needGB <= 7.2, `8B at 24k needs ${l.brain!.needGB} GB`);
  assert.ok(l.warnings.some((w) => /Light mode/.test(w)));
});
test('8 GB laptop with Light mode off: brain 8B, workers 4B fast (the old two-model lineup)', () => {
  const l = selectLineup(hw({ vramGB: 8, freeGB: 1.5 }), { ollamaLoadedGB: 6.3, available: avail, light: 'off' });
  assert.equal(l.light, false); assert.equal(l.brain?.model.alias, 'smart'); assert.equal(l.worker?.model.alias, 'fast');
});
test('Light mode on auto: a 24 GB card with a 27B brain gets it too (a 4B worker does not fit beside it)', () => {
  const l = selectLineup(hw({ vramGB: 24, freeGB: 23.5 }), { available: avail });
  assert.equal(l.light, true); assert.equal(l.worker?.model.tag, l.brain?.model.tag);
});
test('48 GB: Light mode stays off on auto (both models fit), and "on" forces one model', () => {
  const auto = selectLineup(hw({ vramGB: 48, freeGB: 47 }), { available: avail });
  assert.equal(auto.light, false); assert.notEqual(auto.worker?.model.tag, auto.brain?.model.tag);
  const on = selectLineup(hw({ vramGB: 48, freeGB: 47 }), { available: avail, light: 'on' });
  assert.equal(on.light, true); assert.equal(on.worker?.model.tag, on.brain?.model.tag);
});
test('lightWanted: auto turns on only when two different models do not fit together', () => {
  const b = { tag: 'b', needGB: 6 }, w = { tag: 'w', needGB: 3 };
  assert.equal(lightWanted('auto', b, w, 8).on, true);
  assert.equal(lightWanted('auto', b, w, 10).on, false);
  assert.equal(lightWanted('auto', b, { ...w, tag: 'b' }, 8).on, false);   // already one model
  assert.equal(lightWanted('off', b, w, 4).on, false); assert.equal(lightWanted('on', b, w, 40).on, true);
});
test('16 GB card: 14B brain', () => {
  const l = selectLineup(hw({ vramGB: 16, freeGB: 15.5 }), { available: avail });
  assert.equal(l.brain?.model.alias, 'large');
});
test('24 GB card: Qwen3.8 27B brain (newest; 32B does not fit at 24k)', () => {
  const l = selectLineup(hw({ vramGB: 24, freeGB: 23.5 }), { available: avail });
  assert.equal(l.brain?.model.alias, 'qwen38-27b');
});
test('24 GB card without the 2026-10 additions: Qwen3.5 27B brain', () => {
  const l = selectLineup(hw({ vramGB: 24, freeGB: 23.5 }), { available: avail, failed: new Set(['huihui_ai/Qwen3.8-abliterated:27b', 'huihui_ai/Qwen3.6-abliterated:27b']) });
  assert.equal(l.brain?.model.alias, 'qwen35-27b');
});
test('24 GB card where the big models failed their tests: 14B brain + two workers at once', () => {
  const l = selectLineup(hw({ vramGB: 24, freeGB: 23.5 }), { available: avail, failed: new Set(CATALOG.filter((m) => m.params > 14).map((m) => m.tag)) });
  assert.equal(l.brain?.model.alias, 'large'); assert.equal(l.parallelWorkers, 2);
});
test('48 GB card: the newest model that fits wins (Qwen3.8 27B over the older Qwen3 32B); 32B when it is unavailable', () => {
  const l = selectLineup(hw({ vramGB: 48, freeGB: 47 }), { available: avail });
  assert.equal(l.brain?.model.alias, 'qwen38-27b');
  const old = selectLineup(hw({ vramGB: 48, freeGB: 47 }), { available: avail, failed: new Set(CATALOG.filter((m) => m.score > 100 && m.alias !== 'big').map((m) => m.tag)) });
  assert.equal(old.brain?.model.alias, 'big');
});
test('6 GB card: brain falls back to 4B with a warning', () => {
  const l = selectLineup(hw({ vramGB: 6, freeGB: 5.6 }), { available: avail });
  assert.equal(l.brain?.model.params, 4); assert.ok(l.warnings.some((w) => /reliability/.test(w)));
});
test('no GPU: CPU lineup, small brain, warning', () => {
  const l = selectLineup(hw(null, 16), { available: avail });
  assert.ok(l.cpuOnly); assert.ok(l.brain && l.brain.model.params <= 4); assert.ok(l.warnings.length);
});
// ---- works for anyone: weak PCs always get a team, with the trade-off said plainly ----
test('8 GB RAM laptop, no GPU: a 4B team on the CPU at a 16k context (24k does not fit)', () => {
  const l = selectLineup(hw(null, 8), { available: avail });
  assert.ok(l.brain, 'a brain is found'); assert.ok(l.cpuOnly);
  assert.equal(l.ctx, 16384); assert.ok(l.warnings.some((w) => /Context lowered to 16k/.test(w)));
  assert.equal(l.worker?.model.tag, l.brain!.model.tag, 'Light mode: one model');
});
test('4 GB RAM, no GPU: the smallest model leads at an 8k context, with a plain warning', () => {
  const l = selectLineup(hw(null, 4), { available: avail });
  assert.ok(l.brain, 'a brain is found'); assert.ok(l.brain!.model.params < 4);
  assert.equal(l.ctx, 8192); assert.ok(l.warnings.some((w) => /very small/.test(w)));
});
test('4 GB graphics card: a small brain on the GPU (no CPU fallback needed)', () => {
  const l = selectLineup(hw({ vramGB: 4, freeGB: 3.8 }), { available: avail });
  assert.ok(l.brain); assert.equal(l.cpuOnly, false);
  assert.ok(!l.warnings.some((w) => /system memory/.test(w)), l.warnings.join(' | '));
});
test('2 GB RAM: nothing can run, and the lineup says why instead of failing silently', () => {
  const l = selectLineup(hw(null, 2), { available: avail });
  assert.equal(l.brain, null); assert.ok(l.warnings.some((w) => /No model can run/.test(w)));
});
test('light models: standard-only PCs get a light brain too', () => {
  const l = selectLineup(hw(null, 6), { available: avail, kinds: ['standard'] });
  assert.ok(l.brain && l.brain.model.kind === 'standard', `brain ${l.brain?.model.tag}`);
});
test('recorded tool-test failures are never offered; unverified tags are skipped until confirmed', () => {
  const l = selectLineup(hw({ vramGB: 16, freeGB: 16 }), { available: new Set(['huihui_ai/qwen3-abliterated:8b']) });
  assert.notEqual(l.brain?.model.alias, 'large', '14B not confirmed in the registry');
  assert.ok(!l.fits.some((f) => ['coder', 'phi', 'nano', 'orchestrator'].includes(f.model.alias)));
  assert.equal(needGB(CATALOG.find((m) => m.alias === 'fast')!, 24576) > 4, true);
});

test('model kinds: only standard ticked -> an all-standard lineup; both ticked -> proven brain kept on 8 GB', async () => {
  const { kindOf } = await import('../src/catalog.ts');
  const std = selectLineup(hw({ vramGB: 8, freeGB: 1.5 }), { ollamaLoadedGB: 6.3, available: avail, kinds: ['standard'] });
  for (const f of [std.brain, std.worker, std.vision, std.chores]) if (f) assert.equal(kindOf(f.model), 'standard', f.model.alias);
  const both = selectLineup(hw({ vramGB: 8, freeGB: 1.5 }), { ollamaLoadedGB: 6.3, available: avail, kinds: ['abliterated', 'standard'] });
  assert.equal(both.brain?.model.alias, 'smart');
});

test('custom open model: parameters read from the tag, roles by size', async () => {
  const { customModel } = await import('../src/catalog.ts');
  await assert.rejects(customModel('bad name!'), /Ollama model name/);
  const m = await customModel('hf.co/someone/some-model-7b-GGUF:Q4_K_M');   // no registry check for hf.co
  assert.equal(m.kind, 'custom'); assert.ok(m.roles.includes('worker'));
});

test('setup uses downloaded models first: nothing is fetched when a 14B brain is already there (this PC, 16 GB)', async () => {
  const { preferInstalled } = await import('../src/setup.ts');
  const l = selectLineup(hw({ vramGB: 16, freeGB: 15.5 }), { available: avail, kinds: ['abliterated', 'standard'] });
  const inst = new Set(['qwen3:14b', 'huihui_ai/qwen3-abliterated:14b']);
  const said: string[] = []; preferInstalled(l, inst, (m) => said.push(m));
  const tags = [l.brain, l.worker, l.vision, l.chores].filter(Boolean).map((f) => f!.model.tag);
  assert.ok(tags.every((t) => inst.has(t)), `would download: ${tags.filter((t) => !inst.has(t)).join(', ')}`);
  assert.ok(l.brain && l.worker, 'brain and worker are filled from what is installed');
  assert.equal(l.vision, null); assert.equal(l.chores, null);
});
test('setup still downloads brain and worker when nothing suitable is installed', async () => {
  const { preferInstalled } = await import('../src/setup.ts');
  const l = selectLineup(hw({ vramGB: 16, freeGB: 15.5 }), { available: avail });
  const before = l.brain!.model.tag; preferInstalled(l, new Set());
  assert.equal(l.brain!.model.tag, before); assert.ok(l.worker);
});

// ---- specialty rigs: Blackwell, DGX Spark (GB10 unified memory), multi-GPU ----
import { parseNvidia, gpuWarnings } from '../src/hardware.ts';
import { modelCapacityGB, workerMaxParams } from '../src/select.ts';

test('DGX Spark: nvidia-smi memory "[N/A]" / "Not Supported" becomes unified memory from system RAM', () => {
  const [g] = parseNvidia('NVIDIA GB10, [N/A], [N/A], 12.1, 580.95.05\n', 128, 120);
  assert.equal(g.unified, true); assert.equal(g.vramGB, 108.8); assert.equal(g.computeCap, '12.1');
  const [h] = parseNvidia('NVIDIA GB10, Not Supported, Not Supported, 12.1, 580.95.05', 128, 120);
  assert.equal(h.unified, true);
});

test('DGX Spark: a big brain and workers bigger than 4B', () => {
  const [g] = parseNvidia('NVIDIA GB10, [N/A], [N/A], 12.1, 580.95.05', 128, 120);
  const L = selectLineup({ ...hw(g, 128), arch: 'arm64' }, { available: avail, kinds: ['abliterated', 'standard'] });
  assert.equal(L.cpuOnly, false);
  assert.ok(L.brain!.model.params >= 30, `brain ${L.brain!.model.tag}`);
  assert.ok(L.worker!.model.params > 4, `worker ${L.worker!.model.tag}`);
});

test('two RTX 5090s are one 64 GB pool; a Blackwell card on an old driver is flagged', () => {
  const gpus = parseNvidia('NVIDIA GeForce RTX 5090, 32607, 600, 12.0, 576.02\nNVIDIA GeForce RTX 5090, 32607, 400, 12.0, 576.02', 64, 50);
  const H: Hardware = { ...hw(gpus[0], 64), gpus };
  assert.ok(modelCapacityGB(H, 0) > 60);
  assert.deepEqual(gpuWarnings(gpus), []);
  assert.match(gpuWarnings(parseNvidia('NVIDIA GeForce RTX 5080, 16303, 500, 12.0, 566.36', 32, 20))[0], /driver is 566\.36/);
});

test('worker size scales with the budget', () => {
  assert.equal(workerMaxParams(7), 4); assert.equal(workerMaxParams(45), 14); assert.equal(workerMaxParams(100), 32);
});
