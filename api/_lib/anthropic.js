// Anthropic API 呼び出しの共通処理。
// APIキーはサーバーの環境変数 ANTHROPIC_API_KEY からのみ読む（クライアントには一切出さない）。
// モデルと max_tokens はサーバー側で固定する。クライアントからは指定できない。

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// max_tokens の上限。連絡文も抽出JSONも短いので 1024 で十分。
// クライアントがどう投げても、ここで頭打ちにしてコスト暴発を防ぐ。
const MAX_TOKENS = 1024;

// プロンプトを1つ投げてテキストを受け取る。
// model は各エンドポイントが環境変数から決める（例: 抽出=Haiku、連絡文=Sonnet）。
//
// onUsage は任意。渡すと API が返したトークン数（{ input_tokens, output_tokens }）を
// そのまま受け取れる。evalでコストを実測するためのフックで、本番は渡さない＝挙動は変わらない。
export async function callAnthropic(prompt, model, onUsage) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  if (onUsage && data.usage) onUsage(data.usage);
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
