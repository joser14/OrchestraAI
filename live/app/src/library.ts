// Model library: browse every abliterated model in the catalog, install + test any of them, and choose which
// one fills each role (brain / worker / vision / chores). Roles map to the aliases the team already uses:
//   brain -> main's job model · worker -> alias "fast" (workers' default) · vision -> "vision" · chores -> "tiny"
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Orchestrator } from './orchestrator.ts';
import { allModels, kindOf, customModel, type CatalogModel } from './catalog.ts';
import { needGB, modelCapacityGB } from './select.ts';
import { scanHardware, type Hardware } from './hardware.ts';
import { pull, testModel, registerModels, installedTags, loadedGB, type ModelResult } from './setup.ts';
import { testImageModel } from './imagegen.ts';
import { getSettings } from './settings.ts';

export const ROLE_ALIAS: Record<string, string> = { worker: 'fast', vision: 'vision', chores: 'tiny' };
export interface LibProgress { alias: string; phase: string; pct: number; msg: string; done: boolean; error?: string }

let hwCache: { at: number; hw: Hardware | null } = { at: 0, hw: null };
async function hardware() { if (!hwCache.hw || Date.now() - hwCache.at > 120000) hwCache = { at: Date.now(), hw: await scanHardware() }; return hwCache.hw!; }

export async function libraryView(o: Orchestrator) {
  const ctx = getSettings(o.store).ctx;
  const hw = await hardware(); const cap = modelCapacityGB(hw, await loadedGB()); const budget = cap < 4 ? Math.min(hw.ramGB * 0.5, 16) : cap * 0.9;
  const inst = await installedTags(); const results = o.store.get<ModelResult[]>('modelResults', []);
  let brain = ''; try { brain = readFileSync(join(o.cfg.root, 'models', 'brain-model.txt'), 'utf8').trim(); } catch {}
  const isModel = (target: string, names: string[]) => names.some((n) => target === `ollama/${n}:latest`);
  const imageModel = o.store.get<string>('imageModel', '');
  const roleOf = (names: string[], tag = '') => [
    ...(isModel(brain, names) ? ['brain'] : []),
    ...(tag && tag === imageModel ? ['image'] : []),
    ...Object.entries(ROLE_ALIAS).filter(([, a]) => isModel(o.cfg.aliases[a] || '', names)).map(([r]) => r),
  ];
  return {
    capacityGB: cap, budgetGB: +budget.toFixed(2), ctx,
    models: allModels(o.store.get<CatalogModel[]>('customModels', [])).map((m) => {
      const r = results.find((x) => x.tag === m.tag);
      const names = [...new Set([r?.local || `orch-${m.alias}`, `orch-${m.alias}`])];
      const status = m.tested === 'fail' && !r ? 'failed' : r ? (r.tool === 'pass' ? 'tested' : 'failed') : inst.has(m.tag) || inst.has(m.tag + ':latest') ? 'downloaded' : 'not downloaded';
      const need = needGB(m, ctx);
      return { alias: m.alias, tag: m.tag, family: m.family, params: m.params, sizeGB: m.sizeGB, needGB: need, fits: need <= budget,
        vision: !!m.vision, moe: !!m.moe, roles: m.roles, kind: kindOf(m), score: m.score, note: m.note || '', status,
        genTps: r?.genTps ?? null, usedFor: roleOf(names, m.tag) };
    }),
  };
}

export class Library {
  o: Orchestrator; busy = false;
  constructor(o: Orchestrator) { this.o = o; }
  progress(): LibProgress | null { return this.o.store.get<LibProgress | null>('libProgress', null); }
  private set(p: LibProgress) { this.o.store.set('libProgress', p); }

  /** Download (if needed) + tool test + speed test + register in OpenClaw. Background; poll progress(). */
  async install(alias: string) {
    const m = allModels(this.o.store.get<CatalogModel[]>('customModels', [])).find((x) => x.alias === alias); if (!m) throw new Error('unknown model');
    if (this.busy) throw new Error('another model is installing; wait for it');
    this.busy = true;
    const p: LibProgress = { alias, phase: 'download', pct: 0, msg: `Downloading ${alias} (${m.sizeGB} GB)`, done: false }; this.set(p);
    (async () => {
      try {
        const inst = await installedTags();
        if (!inst.has(m.tag) && !inst.has(m.tag + ':latest')) await pull(m.tag, (x) => { p.pct = Math.round(x * 80); this.set(p); });
        const ctx = getSettings(this.o.store).ctx, image = m.roles.includes('image');
        p.phase = 'test'; p.pct = 85; p.msg = image ? `Testing ${alias}: drawing a small test picture` : `Testing ${alias}: tool call and speed`; this.set(p);
        const r = image ? await testImageModel(m) : await testModel(m, ctx, false);
        const all = this.o.store.get<ModelResult[]>('modelResults', []).filter((x) => x.tag !== m.tag); this.o.store.set('modelResults', [...all, r]);
        if (r.tool === 'pass' && image) {
          if (!this.o.store.get<string>('imageModel', '')) this.o.store.set('imageModel', m.tag);   // the first one is used right away
          p.msg = `${alias} drew its test picture and is ready: the team can make images now`;
        } else if (r.tool === 'pass') { await registerModels(this.o.gw, [r], ctx); p.msg = `${alias} passed (${r.genTps ?? '?'} tok/s) and is ready to use`; }
        else p.msg = image ? `${alias} could not draw: ${r.error}` : `${alias} failed the tool-call test: it cannot drive tools reliably, so it is not offered`;
        p.phase = 'done'; p.pct = 100; p.done = true; this.set(p);
        this.o.log(`model library: ${p.msg}`);
      } catch (e: any) { p.error = String(e?.message || e); p.done = true; p.msg = `Stopped: ${p.error}`; this.set(p); }
      finally { this.busy = false; }
    })();
  }

  /** Add any open model by its Ollama name (checked against the registry; tested before it can be used). */
  async addCustom(tag: string) {
    const m = await customModel(tag);
    const list = this.o.store.get<CatalogModel[]>('customModels', []).filter((x) => x.tag !== m.tag);
    if (allModels().some((x) => x.tag === m.tag)) throw new Error(`${m.tag} is already in the library`);
    this.o.store.set('customModels', [...list, m]);
    this.o.log(`model library: added ${m.tag} (${m.sizeGB} GB, ~${m.params}B)`);
    return { ok: true, model: m, msg: `${m.tag} added (${m.sizeGB} GB). Install & test it to use it.` };
  }
  removeCustom(alias: string) {
    this.o.store.set('customModels', this.o.store.get<CatalogModel[]>('customModels', []).filter((x) => x.alias !== alias));
    return { ok: true };
  }

  /** Make a tested model fill a role; the agents switch on their next run. */
  async assign(role: string, alias: string) {
    const m = allModels(this.o.store.get<CatalogModel[]>('customModels', [])).find((x) => x.alias === alias); if (!m) throw new Error('unknown model');
    const r = this.o.store.get<ModelResult[]>('modelResults', []).find((x) => x.tag === m.tag);
    if (!r || r.tool !== 'pass') throw new Error(`${alias} has not passed the tool-call test yet: install and test it first`);
    if (role === 'vision' && !m.vision) throw new Error(`${alias} cannot see images`);
    if (role === 'image' || m.roles.includes('image')) {
      if (!m.roles.includes('image')) throw new Error(`${alias} cannot make images`);
      if (role !== 'image') throw new Error(`${alias} makes images: it cannot be an agent`);
      this.o.store.set('imageModel', m.tag); this.o.log(`model library: ${alias} now makes the team's images`);
      return { ok: true, msg: `${alias} now makes the team's images.` };
    }
    const model = `ollama/${r.local}:latest`;
    if (role === 'brain') {
      const j = this.o.jobs.main; if (!j) throw new Error('main job not found');
      await this.o.gw.updateJob(j.id, { payload: { kind: j.payload.kind, model } });
      writeFileSync(join(this.o.cfg.root, 'models', 'brain-model.txt'), model);
    } else {
      const a = ROLE_ALIAS[role]; if (!a) throw new Error('role must be brain, worker, vision or chores');
      this.o.cfg.aliases[a] = model;
      const f = join(this.o.cfg.root, 'models', 'aliases.json');
      const cur = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')) : {};
      writeFileSync(f, JSON.stringify({ ...cur, [a]: model }, null, 2));
      // Workers currently on that alias switch now (the pick state alone would not re-apply an unchanged alias).
      const picks = this.o.store.get<any>('picks', { models: {}, tools: {}, fail: {} });
      for (const w of this.o.cfg.workers) {
        if ((picks.models?.[w] || 'fast') !== a || !this.o.jobs[w]) continue;
        await this.o.gw.updateJob(this.o.jobs[w].id, { payload: { kind: this.o.jobs[w].payload.kind, model } });
      }
    }
    this.o.log(`model library: ${alias} is now the ${role} model (${model})`);
    return { ok: true, msg: `${alias} is now the ${role} model; agents use it from their next run.` };
  }
}
