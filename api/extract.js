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

import { callLLM } from "./_lib/llm.js";
import { checkRateLimit, getClientIp } from "./_lib/ratelimit.js";
import { MODEL, buildPrompt } from "./_lib/extract-prompt.js";
import { maskRecord, restoreFields } from "./_lib/pii-mask.js";

const MAX_TEXT = 4000; // 記録文の上限（コスト・悪用対策）

// PIIマスキング（MASK_PII=1 で有効）。
//
// 守る境界は「第三者であるAnthropicに氏名を渡さない」ところ。
// このVercel関数までは自社システム内なので、伏せるのはここでよい。
// ブラウザから一歩も出したくない場合の答えはローカルLLM（MODEL=ollama:...）側。
//
// 辞書は渡していない。この関数はステートレスで辞書を持てず、
// クライアントから辞書を送れば結局氏名を送ることになるため。
// パターン検出のみで、35ケースに対し伏せ漏れ0%・復元一致34/35（scripts/pii-leak-check.js）。
//
// 既定は無効。精度への影響を実測してから切り替える（DEPLOY.md の運用ルール）。
const MASK_PII = process.env.MASK_PII === "1";

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

    const { masked, mapping } = MASK_PII
      ? maskRecord(text)
      : { masked: text, mapping: null };

    const out = await callLLM(buildPrompt(masked), MODEL);

    if (!mapping) {
      res.status(200).json({ text: out });
      return;
    }

    // 仮IDを元に戻す。返答がJSONとして読めない場合は復元できないので、
    // そのまま返してクライアント側のパース失敗に任せる（仮IDが画面に出るが、氏名は漏れない）。
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      res.status(200).json({ text: out });
      return;
    }
    res.status(200).json({ text: JSON.stringify(restoreFields(parsed, mapping)) });
  } catch (e) {
    console.error("extract error:", e);
    res.status(502).json({ error: "読み取りに失敗しました。" });
  }
}
