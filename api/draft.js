// 連絡文の生成エンドポイント。
// クライアントからは構造化データ（宛先・期間・差出人など）だけを受け取り、
// プロンプト本体はここで組み立てる。プロンプトの各条件は「連絡文evalで実際に
// 問題が出たため追加されたもの」で、消したり緩めたりしないこと（CLAUDE.md参照）。
//
// モデルは環境変数 MODEL_DRAFT で切替可能（デフォルト Sonnet）。
// 否定制約が多く崩れやすいタスクなので、Haiku に落とすなら必ず連絡文evalを
// 通してから（複数回・完走率90%以上・criticalMiss確認）。

import { callLLM } from "./_lib/llm.js";
import { checkRateLimit, getClientIp } from "./_lib/ratelimit.js";

const MODEL = process.env.MODEL_DRAFT || "claude-sonnet-4-6";

function buildPrompt({ name, staff, when, needMedical, sender }) {
  return `あなたは短期入所（ショートステイ）施設の相談員です。居宅介護支援事業所（ケアマネ）宛に、空き枠のご案内をする短い業務連絡文を書いてください。

【宛先の居宅】${name}
${staff ? `【宛先の担当者】${staff} 様` : ""}
【差出人】${sender.facility}　${sender.staff}
【埋めたい枠（期間）】${when}
${needMedical ? "【今回の条件】医療処置が必要な方の受け入れ枠です（看護師対応可）。" : ""}

条件:
- 日本語のビジネス文書。丁寧だが、とにかく簡潔に。
- 宛名から結びまで含めて 3〜4文程度。短くていい。
- 担当者名が指定されている場合は、その方を宛名にする。指定がなければ「御中」。
- 空き枠は必ず開始日〜終了日の期間（${when}）で書く。開始日だけを書いたり、曜日だけの表現にしたりしない。
- 年（西暦）は書かなくてよい。
- 差出人は上記の【差出人】をそのまま使う。施設名・担当者名を創作しない。
- 「短期入所」「ショートステイ」という語は書かない（相手は承知しているため不要）。
- 連絡手段（電話・FAX・メール等）は書かない。「ご連絡ください」までは可。
- 指定されていない情報（居室タイプ・施設の特長など）を推測で書き足さない。
- 前置きや持ち上げ、余計な装飾はしない。用件（空きが出たのでご案内）だけを伝える。
- 誇張しない。実績や数字への言及も不要。
- 本文のみを返す。説明・囲みの記号は不要。`;
}

const s = (v) => (typeof v === "string" ? v.trim() : "");

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
    const body = req.body || {};
    const name = s(body.name);
    const staff = s(body.staff);
    const when = s(body.when);
    const needMedical = !!body.needMedical;
    const sender = {
      facility: s(body.sender && body.sender.facility),
      staff: s(body.sender && body.sender.staff),
    };

    if (!name || !when) {
      res.status(400).json({ error: "宛先または期間が指定されていません。" });
      return;
    }
    // 差出人未設定だとAIが施設名・人名を創作する危険があるためサーバー側でもブロック。
    if (!sender.facility) {
      res.status(400).json({ error: "差出人（施設情報）が設定されていません。" });
      return;
    }
    // 入力長の上限（コスト・悪用対策）
    if (name.length > 100 || staff.length > 50 || when.length > 100 ||
        sender.facility.length > 100 || sender.staff.length > 50) {
      res.status(400).json({ error: "入力が長すぎます。" });
      return;
    }

    const out = await callLLM(buildPrompt({ name, staff, when, needMedical, sender }), MODEL);
    if (!out) {
      res.status(502).json({ error: "連絡文の生成に失敗しました。" });
      return;
    }
    res.status(200).json({ text: out });
  } catch (e) {
    console.error("draft error:", e);
    res.status(502).json({ error: "連絡文の生成に失敗しました。" });
  }
}
