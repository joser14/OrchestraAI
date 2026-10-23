// Image making: pictures from a prompt with one of Ollama's image models (FLUX.2 klein, Z-Image Turbo; catalog role
// "image"). Used by the team_image tool and the Tools page. Ollama's image generation is experimental and arrived
// on macOS first, so every failure says plainly that this Ollama cannot make images, instead of a raw error.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute, relative } from 'node:path';
import type { CatalogModel } from './catalog.ts';
import type { ModelResult } from './setup.ts';

const OLLAMA = 'http://127.0.0.1:11434';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export interface ImageOpts { width?: number; height?: number; steps?: number; timeoutMs?: number }

/** The picture as bytes. The reply carries it base64-encoded ("image", or "images"[0]); a text reply means this
 *  Ollama version or model cannot make images. */
export async function generateImage(model: string, prompt: string, o: ImageOpts = {}): Promise<Buffer> {
  const size = (n: number | undefined) => (n ? Math.max(256, Math.min(2048, Math.round(n / 64) * 64)) : undefined);
  let r: Response;
  try {
    r = await fetch(OLLAMA + '/api/generate', {
      method: 'POST', signal: AbortSignal.timeout(o.timeoutMs ?? 600000),
      body: JSON.stringify({ model, prompt: String(prompt).slice(0, 2000), stream: false, width: size(o.width), height: size(o.height), steps: o.steps }),
    });
  } catch (e: any) { throw new Error(e?.name === 'TimeoutError' ? 'the picture took too long (over 10 min): try a smaller size' : `Ollama is not answering (${e?.message})`); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(/not found/i.test(j.error || '') ? `${model} is not installed: install it on the Models page` : `${model}: ${j.error || `HTTP ${r.status}`}`);
  const raw = j.image || (Array.isArray(j.images) ? j.images[0] : '') || (/^[A-Za-z0-9+/=\s]{400,}$/.test(j.response || '') ? j.response : '');
  const buf = raw ? Buffer.from(String(raw).replace(/^data:image\/\w+;base64,/, ''), 'base64') : null;
  if (!buf || buf.length < 100) throw new Error(`${model} answered with text, not a picture: this version of Ollama cannot make images on this PC yet (it is experimental; update Ollama)`);
  return buf;
}

/** Save a picture; PNG unless the bytes say otherwise (the extension follows the content). */
export function saveImage(buf: Buffer, file: string): string {
  const out = buf.subarray(0, 4).equals(PNG) ? file.replace(/\.(jpe?g|webp)$/i, '.png') : file;
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, buf); return out;
}

/** Install check for an image model: one small, quick picture instead of the agents' tool-call test. */
export async function testImageModel(m: CatalogModel): Promise<ModelResult> {
  const at = new Date().toISOString();
  try {
    await generateImage(m.tag, 'a red apple on a white table', { width: 256, height: 256, steps: 2, timeoutMs: 300000 });
    return { tag: m.tag, local: m.tag, tool: 'pass', at };
  } catch (e: any) { return { tag: m.tag, local: m.tag, tool: 'fail', at, error: String(e?.message || e) }; }
  finally { await fetch(OLLAMA + '/api/generate', { method: 'POST', body: JSON.stringify({ model: m.tag, keep_alive: 0 }) }).catch(() => {}); }
}

/** The image model in use: the one picked on the Models page, else the first one that drew its test picture. */
export function pickImageModel(store: { get<T>(k: string, d: T): T }, isImage: (tag: string) => boolean): string {
  return store.get<string>('imageModel', '') || store.get<ModelResult[]>('modelResults', []).find((r) => r.tool === 'pass' && isImage(r.tag))?.tag || '';
}

/** Make a picture into the work folder. Waits up to waitMs (the agents' tool calls time out at 60 s); a slower
 *  picture keeps drawing in the background and lands at the same path. */
export async function makeImage(c: { store: any; workDir: string; log: (m: string) => void; isImage: (tag: string) => boolean },
  prompt: string, file: string | undefined, o: ImageOpts = {}, waitMs = 50000): Promise<{ done: boolean; file: string; model: string }> {
  if (!String(prompt || '').trim()) throw new Error('say what to draw (prompt)');
  const model = pickImageModel(c.store, c.isImage);
  if (!model) throw new Error('no image model is installed: the user can install one on the Models page (FLUX.2 klein, 5 GB, or Z-Image Turbo, 12 GB)');
  const name = String(file || '').trim() || imageName(prompt);
  const target = isAbsolute(name) ? name : join(c.workDir, name.replace(/^[\\/]+/, ''));
  if (relative(c.workDir, target).startsWith('..')) throw new Error(`save pictures inside the work folder (${c.workDir})`);
  const out = /\.(png|jpe?g|webp)$/i.test(target) ? target : target + '.png';
  const job = generateImage(model, prompt, o).then((buf) => { const f = saveImage(buf, out); c.log(`image: ${f} (${model})`); return f; });
  job.catch((e) => c.log(`image failed (${model}): ${String(e?.message || e).slice(0, 200)}`));
  const res = await Promise.race([job.then((f) => ({ done: true, file: f })), new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
  return res ? { ...res, model } : { done: false, file: out, model };
}

/** File name from the prompt: "a cat in a hat" -> cat-hat.png */
export const imageName = (prompt: string) =>
  (String(prompt).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|with|for|picture|image|photo|of|make|draw|please)$/.test(w)).slice(0, 4).join('-') || 'image') + '.png';
