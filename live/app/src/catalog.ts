// Abliterated model catalog (exact Ollama tags, as recommended: no floating "latest").
// sizeGB = weights in GiB from the registry manifest (binary GiB, as VRAM is measured; Ollama shows decimal GB).
// kvKB   = KV-cache bytes per token at q8, in KB: 2 (K,V) x layers x kv_heads x head_dim x 1 byte
//          (measured on 2026-10-11 for Qwen3 4B/8B: ~74 KB/token; others from their architecture).
// score  = preference within its roles (higher wins when several fit; proven models rank above untested peers).
// tested = tool-call test result on 2026-10-11; untested models are tested by Setup before they are used.
// moe    = mixture of experts: only a few billion parameters active per token, so fast even when large.
export type Role = 'brain' | 'worker' | 'vision' | 'chores' | 'coder';
/** abliterated = refusals removed (huihui_ai builds) · standard = the official release · custom = added by the user */
export type Kind = 'abliterated' | 'standard' | 'custom';
export interface CatalogModel {
  alias: string; tag: string; family: string; params: number; sizeGB: number; kvKB: number; score: number; vision?: boolean; moe?: boolean;
  roles: Role[]; note?: string; tested?: 'pass' | 'fail'; verify?: boolean; kind?: Kind;
}

const M = (alias: string, tag: string, family: string, params: number, sizeGB: number, kvKB: number, score: number, roles: Role[], extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ alias, tag: `huihui_ai/${tag}`, family, params, sizeGB, kvKB, score, roles, kind: 'abliterated', ...extra });
/** Official (non-abliterated) release from the Ollama library. Sizes from the registry, 2026-10-11. */
const S = (alias: string, tag: string, family: string, params: number, sizeGB: number, kvKB: number, score: number, roles: Role[], extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ alias, tag, family, params, sizeGB, kvKB, score, roles, kind: 'standard', ...extra });

export const kindOf = (m: CatalogModel): Kind => m.kind ?? 'abliterated';

/** Standard models: same families, unmodified. Ranked a little above their abliterated twins (no weight edits). */
export const STANDARD: CatalogModel[] = [
  S('std-qwen3-32b', 'qwen3:32b', 'Qwen3', 32, 18.8, 131, 101, ['brain']),
  S('std-qwen35-27b', 'qwen3.5:27b', 'Qwen3.5', 27, 16.3, 96, 99, ['brain', 'vision'], { vision: true }),
  S('std-mistral24', 'mistral-small3.2:24b', 'Mistral Small 3.2', 24, 14.1, 80, 93, ['brain', 'worker', 'vision'], { vision: true }),
  S('std-magistral', 'magistral:24b', 'Magistral', 24, 13.3, 80, 89, ['brain'], { note: 'reasoning' }),
  S('std-qwen3-30b', 'qwen3:30b-a3b', 'Qwen3 MoE', 30, 17.3, 48, 91, ['brain', 'worker'], { moe: true, note: 'MoE: 3B active, fast' }),
  S('std-gptoss20', 'gpt-oss:20b', 'gpt-oss', 20, 12.8, 25, 82, ['brain', 'worker'], { moe: true, note: "OpenAI's open-weight model" }),
  S('std-gptoss120', 'gpt-oss:120b', 'gpt-oss', 120, 60.9, 36, 104, ['brain'], { moe: true, note: "OpenAI's open-weight model, 64 GB+" }),
  S('std-coder30', 'qwen3-coder:30b', 'Qwen3 Coder MoE', 30, 17.3, 48, 89, ['coder'], { moe: true }),
  S('std-devstral', 'devstral:24b', 'Devstral', 24, 13.3, 80, 85, ['coder', 'worker']),
  S('std-qwen3-14b', 'qwen3:14b', 'Qwen3', 14, 8.6, 82, 81, ['brain', 'worker']),
  S('std-phi4', 'phi4:14b', 'Phi-4', 14, 8.4, 100, 61, ['worker'], { note: 'no tool template in Ollama: likely fails the test' }),
  S('std-gemma4-12b', 'gemma4:12b', 'Gemma 4', 12, 7.0, 40, 71, ['vision', 'worker'], { vision: true }),
  S('std-gemma3-12b', 'gemma3:12b', 'Gemma 3', 12, 7.6, 40, 40, ['vision'], { vision: true, note: 'no tool calling' }),
  S('std-qwen35-9b', 'qwen3.5:9b', 'Qwen3.5', 9, 6.1, 64, 69, ['brain', 'worker', 'vision'], { vision: true }),
  S('std-qwen3-8b', 'qwen3:8b', 'Qwen3', 8, 4.9, 74, 66, ['brain', 'worker']),
  S('std-vl8', 'qwen3-vl:8b', 'Qwen3-VL', 8, 5.7, 74, 65, ['vision', 'worker'], { vision: true }),
  S('std-ministral8', 'ministral-3:8b', 'Ministral 3', 8, 5.6, 64, 60, ['worker', 'brain']),
  S('std-llama31-8b', 'llama3.1:8b', 'Llama 3.1', 8, 4.6, 128, 56, ['worker', 'brain']),
  S('std-granite33-8b', 'granite3.3:8b', 'Granite 3.3', 8, 4.6, 80, 52, ['worker', 'brain']),
  S('std-coder7', 'qwen2.5-coder:7b', 'Qwen2.5 Coder', 7, 4.4, 56, 50, ['coder']),
  S('std-gemma4-e4b', 'gemma4:e4b', 'Gemma 4', 4, 6.0, 40, 47, ['vision'], { vision: true }),
  S('std-qwen35-4b', 'qwen3.5:4b', 'Qwen3.5', 4, 3.1, 74, 59, ['vision', 'worker'], { vision: true }),
  S('std-vl4', 'qwen3-vl:4b', 'Qwen3-VL', 4, 3.1, 74, 57, ['vision', 'worker'], { vision: true }),
  S('std-qwen3-4b', 'qwen3:4b', 'Qwen3', 4, 2.3, 74, 61, ['worker', 'brain']),
  S('std-phi4mini', 'phi4-mini:3.8b', 'Phi-4 mini', 3.8, 2.3, 96, 45, ['worker', 'chores']),
  S('std-gemma3-4b', 'gemma3:4b', 'Gemma 3', 4, 3.1, 40, 30, ['vision'], { vision: true, note: 'no tool calling' }),
  S('std-granite4-3b', 'granite4:3b', 'Granite 4', 3, 2.0, 80, 47, ['worker', 'chores']),
  S('std-llama32-3b', 'llama3.2:3b', 'Llama 3.2', 3, 1.9, 112, 41, ['chores']),
  S('std-qwen3-1.7b', 'qwen3:1.7b', 'Qwen3', 1.7, 1.3, 57, 41, ['chores', 'worker']),
  S('std-llama32-1b', 'llama3.2:1b', 'Llama 3.2', 1, 1.2, 16, 31, ['chores']),
  S('std-r1-8b', 'deepseek-r1:8b', 'DeepSeek-R1', 8, 4.9, 74, 0, [], { note: 'reasoning only: no tool calling' }),
  // ---- added 2026-10-14 (sizes from the registry manifests; all untested until Setup tool-tests them) ----
  S('std-qwen38-27b', 'qwen3.8:27b', 'Qwen3.8', 27, 16.5, 96, 104, ['brain', 'vision'], { vision: true, note: 'newest Qwen, the most pulled tools model; 24 GB cards' }),
  S('std-qwen36-27b', 'qwen3.6:27b', 'Qwen3.6', 27, 16.5, 96, 100, ['brain', 'vision'], { vision: true, note: '24 GB cards' }),
  S('std-qwen36-35b', 'qwen3.6:35b', 'Qwen3.6 MoE', 35, 21.1, 48, 98, ['brain', 'worker', 'vision'], { vision: true, moe: true, note: 'MoE: 3B active, fast; 32 GB cards' }),
  S('std-ornith-35b', 'ornith:35b', 'Ornith MoE', 35, 19.7, 48, 95, ['brain', 'worker'], { moe: true, note: 'agent-tuned Qwen3.5 MoE' }),
  S('std-glm47-flash', 'glm-4.7-flash', 'GLM-4.7 Flash', 30, 17.7, 50, 94, ['brain', 'worker'], { moe: true, note: 'MoE, strong at tool use' }),
  S('std-muse-glimmer', 'muse-glimmer:30b', 'Muse Glimmer', 28, 16.9, 80, 90, ['brain', 'vision'], { vision: true }),
  S('std-gemma4-31b', 'gemma4:31b', 'Gemma 4', 31, 18.5, 64, 92, ['brain', 'vision'], { vision: true }),
  S('std-gemma4-26b', 'gemma4:26b', 'Gemma 4', 25, 17.0, 60, 90, ['brain', 'vision'], { vision: true }),
  S('std-nemotron3', 'nemotron3:33b', 'Nemotron 3', 33, 25.7, 40, 93, ['brain'], { note: 'NVIDIA omni model; 32 GB cards' }),
  S('std-nemotron35-lightning', 'nemotron-3.5-lightning:30b', 'Nemotron 3.5 MoE', 33, 23.7, 24, 91, ['brain', 'worker'], { moe: true, note: 'NVIDIA hybrid MoE, fast' }),
  S('std-laguna-xs', 'laguna-xs-2.1', 'Laguna XS 2.1', 33, 18.9, 60, 88, ['brain', 'coder'], { note: 'agentic coding' }),
  S('std-granite41-30b', 'granite4.1:30b', 'Granite 4.1', 29, 16.3, 100, 84, ['brain', 'worker']),
  S('std-coder-next', 'qwen3-coder-next', 'Qwen3 Coder Next MoE', 80, 48.2, 30, 96, ['coder'], { moe: true, note: '64 GB+' }),
  S('std-mistral-medium35', 'mistral-medium-3.5:128b', 'Mistral Medium 3.5', 128, 74.7, 120, 106, ['brain', 'vision'], { vision: true, note: 'workstation: 96 GB+' }),
  S('std-nimble-9b', 'nimble:9b', 'Nimble', 9, 8.9, 64, 67, ['brain', 'worker'], { note: 'decision model (Q8)' }),
  S('std-ornith-9b', 'ornith:9b', 'Ornith', 9, 5.2, 64, 68, ['brain', 'worker'], { note: 'agent-tuned Qwen3.5' }),
  S('std-granite41-8b', 'granite4.1:8b', 'Granite 4.1', 9, 5.0, 80, 58, ['worker', 'brain']),
  S('std-lfm25-8b', 'lfm2.5:8b', 'LFM 2.5 MoE', 8.5, 4.8, 32, 57, ['worker'], { moe: true, note: 'very fast' }),
  S('std-tev1-4b', 'tev1:4b', 'Tev1', 4.3, 4.3, 74, 56, ['worker', 'chores'], { note: 'decision model (Q8)' }),
  S('std-granite41-3b', 'granite4.1:3b', 'Granite 4.1', 3.4, 2.0, 80, 48, ['worker', 'chores']),
];

export const CATALOG: CatalogModel[] = [
  // ---- large brains (12 GB+ cards) ----
  M('big', 'qwen3-abliterated:32b', 'Qwen3', 32, 19, 131, 100, ['brain'], { verify: true, note: '48 GB cards, or 24 GB with a smaller context' }),
  M('qwen35-27b', 'qwen3.5-abliterated:27b', 'Qwen3.5', 27, 16.2, 96, 98, ['brain'], { note: '24 GB cards' }),
  M('mistral24', 'mistral-small-abliterated:24b', 'Mistral Small', 24, 13.3, 80, 92, ['brain', 'worker'], { note: '16-24 GB cards' }),
  M('qwen3-30b', 'qwen3-abliterated:30b-a3b', 'Qwen3 MoE', 30, 17.3, 48, 90, ['brain', 'worker'], { moe: true, note: 'MoE: 3B active, fast' }),
  M('gptoss20', 'gpt-oss-abliterated:20b', 'gpt-oss', 20, 12.8, 25, 78, ['brain', 'worker'], { moe: true, note: 'MoE, reasoning' }),
  M('devstral', 'devstral-abliterated:24b', 'Devstral', 24, 13.3, 80, 84, ['coder', 'worker'], { note: 'coding agent' }),
  M('coder30', 'qwen3-coder-abliterated:30b', 'Qwen3 Coder MoE', 30, 17.3, 48, 88, ['coder'], { moe: true, note: 'coding, MoE: fast' }),
  M('large', 'qwen3-abliterated:14b', 'Qwen3', 14, 8.6, 82, 80, ['brain', 'worker'], { verify: true, note: '12-16 GB cards' }),
  M('qwen25-14b', 'qwen2.5-abliterate:14b', 'Qwen2.5', 14, 8.4, 96, 72, ['brain', 'worker']),
  M('phi4', 'phi4-abliterated:14b', 'Phi-4', 14, 8.4, 100, 60, ['worker'], { note: 'strong reasoning; tool use unproven' }),
  M('gemma4-12b', 'gemma-4-abliterated:12b', 'Gemma 4', 12, 7.0, 40, 70, ['vision', 'worker'], { vision: true }),
  // ---- 8B class (8 GB cards) ----
  M('smart', 'qwen3-abliterated:8b', 'Qwen3', 8, 4.7, 74, 65, ['brain', 'worker'], { tested: 'pass', note: 'measured: 100% GPU on 8 GB at 24k, 47-73 tok/s' }),
  M('qwen35-9b', 'qwen3.5-abliterated:9b', 'Qwen3.5', 9, 6.1, 64, 68, ['brain', 'worker']),
  M('vl8', 'qwen3-vl-abliterated:8b', 'Qwen3-VL', 8, 5.7, 74, 64, ['vision', 'worker'], { vision: true }),
  M('qwen25-7b', 'qwen2.5-abliterate:7b', 'Qwen2.5', 7, 4.4, 28, 55, ['worker', 'brain']),
  M('granite8', 'granite3.2-abliterated:8b', 'Granite 3.2', 8, 4.6, 80, 50, ['worker', 'brain']),
  M('gemma4-e4b', 'gemma-4-abliterated:e4b', 'Gemma 4', 4, 8.9, 40, 45, ['vision'], { vision: true, note: 'large download for its size' }),
  // ---- worker class (4B) ----
  M('fast', 'qwen3-abliterated:4b-instruct-2507-q4_K_M', 'Qwen3', 4, 2.3, 74, 60, ['worker', 'brain'], { tested: 'pass' }),
  M('vision', 'qwen3.5-abliterated:4b', 'Qwen3.5', 4, 3.1, 74, 58, ['vision', 'worker'], { vision: true, tested: 'pass' }),
  M('vl4', 'qwen3-vl-abliterated:4b', 'Qwen3-VL', 4, 3.1, 74, 56, ['vision', 'worker'], { vision: true }),
  M('think4', 'qwen3-abliterated:4b', 'Qwen3', 4, 2.3, 74, 50, ['worker'], { note: 'thinking variant: slower, more careful' }),
  M('gemma4-e2b', 'gemma-4-abliterated:e2b', 'Gemma 4', 2, 6.7, 30, 35, ['vision'], { vision: true, note: 'large download for its size' }),
  // ---- small (chores) ----
  M('hermes', 'Hermes-3-Llama-3.2-abliterated:3b', 'Hermes 3', 3, 1.9, 112, 48, ['worker', 'chores'], { tested: 'pass', note: 'tuned for function calls' }),
  M('granite', 'granite4.1-abliterated:3b', 'Granite 4.1', 3, 2.0, 80, 46, ['worker', 'chores'], { tested: 'pass' }),
  M('qwen25-3b', 'qwen2.5-abliterate:3b', 'Qwen2.5', 3, 1.8, 18, 44, ['chores', 'worker']),
  M('llama', 'llama3.2-abliterate:3b', 'Llama 3.2', 3, 2.1, 112, 40, ['chores'], { tested: 'pass' }),
  M('mini', 'qwen3.5-abliterated:2b', 'Qwen3.5', 2, 1.8, 57, 42, ['vision', 'chores'], { vision: true, tested: 'pass' }),
  M('vl', 'qwen3-vl-abliterated:2b', 'Qwen3-VL', 2, 1.8, 57, 41, ['vision', 'chores'], { vision: true, tested: 'pass' }),
  M('granite-vision', 'granite3.2-vision-abliterated:2b', 'Granite 3.2 Vision', 2, 2.3, 40, 38, ['vision', 'chores'], { vision: true, note: 'documents and charts' }),
  M('granite2', 'granite3.2-abliterated:2b', 'Granite 3.2', 2, 1.4, 40, 36, ['chores']),
  M('tiny', 'qwen3-abliterated:1.7b', 'Qwen3', 1.7, 1.0, 57, 40, ['chores', 'worker'], { tested: 'pass' }),
  M('qwen25-1.5b', 'qwen2.5-abliterate:1.5b', 'Qwen2.5', 1.5, 0.9, 14, 34, ['chores']),
  M('moe15', 'huihui-moe-abliterated:1.5b', 'Huihui MoE', 1.5, 0.9, 28, 33, ['chores'], { moe: true }),
  M('lfm', 'lfm2.5-abliterated:1.2b', 'LFM 2.5', 1.2, 0.7, 32, 38, ['chores'], { tested: 'pass', note: 'very fast (340 tok/s here)' }),
  M('llama1b', 'llama3.2-abliterate:1b', 'Llama 3.2', 1, 0.9, 16, 30, ['chores']),
  M('micro', 'qwen3.5-abliterated:0.8b', 'Qwen3.5', 0.8, 1.0, 28, 30, ['chores'], { vision: true, tested: 'pass' }),
  // ---- added 2026-10-14: newer huihui_ai builds (sizes from the registry manifests; tool-tested by Setup) ----
  M('qwen38-27b', 'Qwen3.8-abliterated:27b', 'Qwen3.8', 27, 16.5, 96, 103, ['brain', 'vision'], { vision: true, note: 'newest Qwen; 24 GB cards' }),
  M('qwen36-27b', 'Qwen3.6-abliterated:27b', 'Qwen3.6', 28, 16.2, 96, 99, ['brain'], { note: '24 GB cards' }),
  M('qwen36-35b', 'Qwen3.6-abliterated:35b', 'Qwen3.6 MoE', 36, 22.3, 48, 97, ['brain', 'worker'], { moe: true, note: 'MoE: 3B active, fast; 32 GB cards' }),
  M('qwen36-35b-claude', 'Qwen3.6-abliterated:35b-Claude-4.6', 'Qwen3.6 MoE', 36, 22.3, 48, 96, ['brain'], { moe: true, note: 'Claude-distilled reasoning' }),
  M('qwen35-35b', 'qwen3.5-abliterated:35b', 'Qwen3.5 MoE', 36, 22.2, 48, 93, ['brain', 'worker'], { moe: true }),
  M('qwen35-122b', 'qwen3.5-abliterated:122b', 'Qwen3.5 MoE', 125, 75.8, 60, 105, ['brain'], { moe: true, note: 'workstation: 96 GB+' }),
  M('gemma4-48b', 'gemma-4-abliterated:48b', 'Gemma 4', 49, 30.9, 80, 99, ['brain', 'vision'], { vision: true, note: '48 GB cards' }),
  M('gemma4-31b', 'gemma-4-abliterated:31b', 'Gemma 4', 31, 18.5, 64, 91, ['brain', 'vision'], { vision: true }),
  M('gemma4-26b', 'gemma-4-abliterated:26b', 'Gemma 4', 26, 16.8, 60, 89, ['brain', 'vision'], { vision: true }),
  M('glm47-flash', 'glm-4.7-flash-abliterated', 'GLM-4.7 Flash', 30, 17.5, 50, 93, ['brain', 'worker'], { moe: true, note: 'MoE, strong at tool use' }),
  M('vl30', 'qwen3-vl-abliterated:30b', 'Qwen3-VL MoE', 31, 18.2, 48, 86, ['vision', 'worker'], { vision: true, moe: true }),
  M('vl32', 'qwen3-vl-abliterated:32b', 'Qwen3-VL', 33, 19.5, 131, 85, ['vision'], { vision: true }),
  M('granite41-30b', 'granite4.1-abliterated:30b', 'Granite 4.1', 29, 16.3, 100, 83, ['brain', 'worker']),
  M('tongyi-30b', 'tongyi-deepresearch-abliterated:30b', 'Tongyi DeepResearch MoE', 30, 17.3, 48, 87, ['brain'], { moe: true, note: 'deep web research' }),
  M('miro-30b', 'mirothinker1-abliterated:30b', 'MiroThinker MoE', 30, 17.3, 48, 86, ['brain', 'worker'], { moe: true, note: 'research agent' }),
  M('qwen3-next', 'qwen3-next-abliterated:80b', 'Qwen3 Next MoE', 80, 45.1, 30, 102, ['brain'], { moe: true, note: '64 GB+' }),
  M('coder-next', 'qwen3-coder-next-abliterated', 'Qwen3 Coder Next MoE', 80, 48.2, 30, 95, ['coder'], { moe: true, note: '64 GB+' }),
  M('gptoss120', 'gpt-oss-abliterated:120b', 'gpt-oss', 117, 81.8, 36, 101, ['brain'], { moe: true, note: 'workstation: 96 GB+' }),
  // 8B and smaller: scored below the proven 'smart' / 'fast' until Setup has tested them on this PC
  M('huihui4-8b', 'huihui-4:8b', 'Huihui 4 (Gemma 4)', 8.7, 6.2, 40, 62, ['worker', 'vision'], { vision: true }),
  M('granite41-8b', 'granite4.1-abliterated:8b', 'Granite 4.1', 9, 5.0, 80, 57, ['worker', 'brain']),
  M('miro-8b', 'mirothinker1-abliterated:8b', 'MiroThinker', 8, 4.7, 74, 58, ['worker', 'brain'], { note: 'research agent' }),
  M('dolphin3-8b', 'dolphin3-abliterated:8b', 'Dolphin 3 (Llama)', 8, 4.6, 128, 52, ['worker']),
  M('qwen35-4b-claude', 'qwen3.5-abliterated:4b-Claude', 'Qwen3.5', 4.7, 3.2, 74, 57, ['worker'], { note: 'Claude-distilled reasoning' }),
  M('jan-nano', 'jan-nano-abliterated:4b', 'Jan Nano', 4, 2.3, 74, 55, ['worker'], { note: 'research agent' }),
  // ---- recorded failures / not for agents (never offered) ----
  M('coder', 'qwen2.5-coder-abliterate:7b', 'Qwen2.5 Coder', 7, 4.4, 56, 0, [], { tested: 'fail' }),
  M('coder3', 'qwen2.5-coder-abliterate:3b', 'Qwen2.5 Coder', 3, 1.8, 36, 0, [], { tested: 'fail' }),
  M('phi', 'phi4-mini-abliterated', 'Phi-4 mini', 3.8, 2.3, 96, 0, [], { tested: 'fail' }),
  M('nano', 'qwen3-abliterated:0.6b', 'Qwen3', 0.6, 0.4, 28, 0, [], { tested: 'fail' }),
  M('orchestrator', 'orchestrator-abliterated:8b', 'Orchestrator', 8, 4.7, 74, 0, [], { tested: 'fail', note: 'passes one call but loops in real runs' }),
  M('r1-8b', 'deepseek-r1-abliterated:8b', 'DeepSeek-R1', 8, 4.7, 74, 0, [], { tested: 'fail', note: 'no tool calling' }),
];

/** Every model the app knows: abliterated + standard + the user's own (custom) additions. */
export const allModels = (custom: CatalogModel[] = []): CatalogModel[] => [...CATALOG, ...STANDARD, ...custom];

/** Registry path of a tag: "qwen3:8b" -> library/qwen3, "huihui_ai/x:1b" -> huihui_ai/x. */
function registryPath(tag: string) { const [name, ver = 'latest'] = tag.split(':'); return { repo: name.includes('/') ? name : `library/${name}`, ver }; }

/** Size of a tag from its registry manifest (GiB), or null when it does not exist / cannot be checked. */
export async function tagInfo(tag: string): Promise<{ sizeGB: number; vision: boolean } | null> {
  if (/^hf\.co\//i.test(tag)) return null;   // Hugging Face GGUFs: no Ollama manifest to read
  const { repo, ver } = registryPath(tag);
  try {
    const r = await fetch(`https://registry.ollama.ai/v2/${repo}/manifests/${ver}`, { headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const m: any = await r.json(); const layers: any[] = m.layers || [];
    return { sizeGB: +(layers.filter((l) => /model|projector/.test(l.mediaType)).reduce((s, l) => s + l.size, 0) / 2 ** 30).toFixed(1), vision: layers.some((l) => /projector/.test(l.mediaType)) };
  } catch { return null; }
}

/** Build a catalog entry for any open model the user names (e.g. "mistral-nemo:12b", "someone/model:7b"). */
export async function customModel(tag: string): Promise<CatalogModel> {
  tag = tag.trim();
  if (!/^[\w.\-/:]+$/.test(tag)) throw new Error('enter an Ollama model name like mistral-nemo:12b or user/model:tag');
  const info = await tagInfo(tag);
  if (!info && !/^hf\.co\//i.test(tag)) throw new Error(`${tag} was not found in the Ollama registry`);
  const sizeGB = info?.sizeGB ?? 5;
  const params = +(/[:\-](\d+(?:\.\d+)?)b\b/i.exec(tag)?.[1] ?? (sizeGB / 0.62).toFixed(1));   // q4: ~0.62 GiB per billion parameters
  const roles: Role[] = params >= 7 ? ['brain', 'worker'] : params >= 3 ? ['worker', 'chores'] : ['chores'];
  if (info?.vision) roles.push('vision');
  return { alias: 'custom-' + tag.replace(/[^\w.]+/g, '-').toLowerCase(), tag, family: tag.split(/[:/]/).slice(-2, -1)[0] || tag, params, sizeGB,
    kvKB: Math.round(20 + params * 7), score: 20, roles, vision: !!info?.vision, kind: 'custom', note: 'added by you; tested before use' };
}

/** Does the registry have this tag? (catalog entries marked `verify` are proposals until confirmed) */
export async function tagExists(tag: string): Promise<boolean> {
  const { repo, ver } = registryPath(tag);
  try {
    const r = await fetch(`https://registry.ollama.ai/v2/${repo}/manifests/${ver}`, { method: 'HEAD', headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(15000) });
    return r.ok;
  } catch { return false; }
}
