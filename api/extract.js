// 記録文の抽出エンドポイント。
// クライアントからは記録文（text）だけを受け取り、プロンプトはここで組み立てる。
// モデルは環境変数 MODEL_EXTRACT で切替可能（デフォルト Haiku）。
// 抽出は構造化タスクなので Haiku で十分にこなせる（コストが Sonnet の約1/3）。

import { callAnthropic } from "./_lib/anthropic.js";
import { checkRateLimit, getClientIp } from "./_lib/ratelimit.js";

const MODEL = process.env.MODEL_EXTRACT || "claude-haiku-4-5";
const MAX_TEXT = 4000; // 記録文の上限（コスト・悪用対策）

function buildPrompt(text) {
  return `あなたは介護施設の利用記録を読み取るアシスタントです。次の記録文から項目を抽出し、JSONだけを返してください。

【記録文】
${text}

抽出項目（不明なものは空文字 "" または false）:
- date: 利用日。YYYY-MM-DD形式。無ければ ""
- kyotaku: 紹介元の居宅・ケアマネ事業所名。無ければ ""
- staff: 紹介元の担当ケアマネの氏名（姓のみで可）。書かれていなければ ""
- care: 要介護度。次のどれかに厳密一致（要支援1／要支援2／要介護1／要介護2／要介護3／要介護4／要介護5）。不明なら ""
- medical: インスリン・点滴・痰吸引・褥瘡処置など看護師対応が要る処置があれば true
- result: "regular"（定期確定）／"single"（単発終了）／"watch"（未確定・様子見）。判断できなければ "watch"
- trouble: 現場で問題やトラブルがあれば true
- discrepancy: 事前の申し送り・情報と実際の様子が食い違っていたら true
- summary: 様子を1〜2文で簡潔にまとめた文

必ずJSONオブジェクトのみを返す。前置き・説明・マークダウン記号は一切つけない。`;
}

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
