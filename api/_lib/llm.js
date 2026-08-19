// LLM呼び出しの入口。クラウド（Anthropic）とローカル（Ollama）を呼び分ける。
//
// 呼び分けはモデル名だけで決まる:
//   "ollama:qwen2.5:7b" → ローカル（Ollama）
//   それ以外            → クラウド（Anthropic）
//
// 環境変数 MODEL_EXTRACT / MODEL_DRAFT を変えるだけで切り替わる。コード変更は不要。
// 未設定なら従来どおりクラウドなので、既存の動作は変わらない。
//
// ── この形にした理由 ──
// 介護記録を外部APIに送れない施設では、同じアプリを施設内のローカルLLMで
// 動かせる必要がある。「測るためだけにローカル対応した」のではなく、
// 本番の実行経路として切り替えられることに意味がある。

import { callAnthropic } from "./anthropic.js";
import { callOllama } from "./ollama.js";

const OLLAMA_PREFIX = "ollama:";

/** そのモデルがローカル実行かどうか。 */
export function isLocal(model) {
  return typeof model === "string" && model.startsWith(OLLAMA_PREFIX);
}

/** 表示用。"ollama:qwen2.5:7b" → "qwen2.5:7b" */
export function bareModelName(model) {
  return isLocal(model) ? model.slice(OLLAMA_PREFIX.length) : model;
}

/**
 * プロンプトを1つ投げてテキストを受け取る。
 * 引数と戻り値は呼び先によらず同じ形。
 *
 * @param {string} prompt
 * @param {string} model
 * @param {(u:{input_tokens:number,output_tokens:number})=>void} [onUsage]
 */
export async function callLLM(prompt, model, onUsage) {
  return isLocal(model)
    ? callOllama(prompt, bareModelName(model), onUsage)
    : callAnthropic(prompt, model, onUsage);
}
