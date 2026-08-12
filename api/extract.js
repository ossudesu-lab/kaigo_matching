// 記録文の抽出エンドポイント。
// クライアントからは記録文（text）だけを受け取る。
//
// プロンプトとモデルの定義は _lib/extract-prompt.js に置き、evalと共有している。
// このファイルの責務はHTTP層だけ（メソッド検証・レート制限・入力長制限）。
// ここでプロンプトを書かないこと。本番とevalがずれる原因になる。
//
// モデル選定: デフォルトは Haiku。ただし「抽出は構造化タスクだから Haiku で十分」は
// 未検証の仮定なので、scripts/eval-extract.js で実測してから判断すること
// （DEPLOY.md の「モデルを変えるとき」の運用ルールに従う）。

import { callAnthropic } from "./_lib/anthropic.js";
import { checkRateLimit, getClientIp } from "./_lib/ratelimit.js";
import { MODEL, buildPrompt } from "./_lib/extract-prompt.js";

const MAX_TEXT = 4000; // 記録文の上限（コスト・悪用対策）

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const rl = checkRateLimit(getClientIp(req));
  if (!rl.ok) {
    res.status(429).json({ error: "アクセスが集中しています。少し待ってからお試しください。" });
    return;
  }

  try {
    const { text } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (text.length > MAX_TEXT) {
      res.status(400).json({ error: "記録文が長すぎます。" });
      return;
    }

    const out = await callAnthropic(buildPrompt(text), MODEL);
    res.status(200).json({ text: out });
  } catch (e) {
    console.error("extract error:", e);
    res.status(502).json({ error: "読み取りに失敗しました。" });
  }
}
