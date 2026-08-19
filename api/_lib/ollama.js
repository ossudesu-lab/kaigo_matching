// ローカルLLM（Ollama）呼び出し。
//
// ── なぜ必要か ──
// 介護記録は個人情報の塊で、氏名を伏せても要介護度・医療処置・夜間の状態といった
// 要配慮個人情報が本文に残る。施設によっては「外部APIに送らない」が前提条件になる。
// そのときの答えが、施設内で完結するローカルLLM。
//
// クラウド版（anthropic.js）と同じ形で呼べるようにしてある。
// 呼び分けは llm.js が担当し、extract.js と eval は llm.js だけを見る。

// 既定は同一マシン。別ホストで動かす場合は OLLAMA_HOST で差し替える。
const HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// クラウド版と揃える。抽出JSONも連絡文も短いので 1024 で足りる。
const MAX_TOKENS = 1024;

// ローカルモデルはクラウドより桁違いに遅い。初回はモデルのロードも入る。
// 短いタイムアウトで切ると「遅いだけ」を「失敗」と誤認するため、長めに取る。
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 300000);

/**
 * プロンプトを1つ投げてテキストを受け取る。
 *
 * format:"json" を指定している。小さいモデルは前置きや ```json を付けがちで、
 * それだけで失敗扱いになってしまう。JSONを強制するのは実運用として妥当な設定で、
 * クラウドとの比較でも「その道具を普通に使った状態」を測るべきと判断した。
 * ただし条件が完全に同一ではない点は、比較を語るときに明示すること。
 *
 * @param {string} prompt
 * @param {string} model   "qwen2.5:7b" のような Ollama のモデル名
 * @param {(u:{input_tokens:number,output_tokens:number})=>void} [onUsage]
 */
export async function callOllama(prompt, model, onUsage) {
  const res = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      format: "json",
      options: { num_predict: MAX_TOKENS },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ollama ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();

  // Ollama はトークン数を prompt_eval_count / eval_count で返す。
  // 課金は無いが、クラウドとの比較や入力サイズの把握に使うので同じ形で通す。
  if (onUsage) {
    onUsage({
      input_tokens: data.prompt_eval_count ?? 0,
      output_tokens: data.eval_count ?? 0,
    });
  }

  const text = data?.message?.content;
  if (typeof text !== "string") {
    throw new Error(`ollama: 想定外の応答形式: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return text.trim();
}
