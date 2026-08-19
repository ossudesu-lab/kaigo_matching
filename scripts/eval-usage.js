// evalのAPI利用量を記録・集計する。
//
// ── なぜ作ったか ──
// 2026-08-19、evalを繰り返した結果 Anthropic のクレジットが尽き、**公開中の本番アプリが停止した**。
// クレジットは組織単位なので、evalで使い切ると本番のAI機能も落ちる。
//
// 事故当時、1回あたりのコストは毎回表示していた。見えていなかったのは**累積**。
// 「1回100円」を1日に何十回も回していることに、誰も気づかなかった。
// そのため、実行前に「今回の見積もり」と「これまでの累計」を必ず目に入れる。

import { appendFileSync, readFileSync, existsSync } from "node:fs";

// 1トークンあたりの単価（100万トークンあたりUSD・2026-08 時点）。
// **単価は変わる。** 金額が実態と合わないと感じたら公式の料金表を確認すること。
// 表に無いモデルはコストを出さず、トークン数だけ表示する（誤った金額を出すより良い）。
const PRICE = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-5": { in: 5, out: 25 },
};

// 円換算は目安。正確な請求額ではない。
const USD_JPY = 150;

/** ローカル実行（Ollama）は課金が発生しない。「単価不明」とは区別する。 */
export function isFree(model) {
  return typeof model === "string" && model.startsWith("ollama:");
}

export function priceOf(model) {
  return PRICE[model] ?? null;
}

export function costUSD(model, inputTokens, outputTokens) {
  if (isFree(model)) return 0; // 施設内で動くので費用は電気代だけ
  const p = priceOf(model);
  if (!p) return null;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

export function yen(usd) {
  return Math.round(usd * USD_JPY);
}

/** 1行1JSON（JSONL）で追記する。壊れた行があっても他の行は読めるため。 */
export function appendRun(logPath, record) {
  appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}

/** ログを読む。壊れた行は黙って捨てる（記録の欠けで実行を止めない）。 */
export function loadHistory(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function summarize(history) {
  const t = { runs: history.length, requests: 0, input: 0, output: 0, usd: 0, unpriced: 0 };
  for (const r of history) {
    t.requests += r.requests ?? 0;
    t.input += r.inputTokens ?? 0;
    t.output += r.outputTokens ?? 0;
    if (typeof r.usd === "number") t.usd += r.usd; else t.unpriced++;
  }
  return t;
}

/**
 * 実行前の見積もり。
 * 同じモデルの過去実績から1リクエストあたりのトークン数を取り、今回の件数に掛ける。
 * 履歴が無ければ金額は出さない（当てずっぽうの数字を出すより、無いと言う方がよい）。
 */
export function estimate(history, model, requests) {
  const past = history.filter((r) => r.model === model && (r.requests ?? 0) > 0);
  if (past.length === 0) return { requests, usd: null, basedOn: 0 };
  const totalReq = past.reduce((a, r) => a + r.requests, 0);
  const inPer = past.reduce((a, r) => a + (r.inputTokens ?? 0), 0) / totalReq;
  const outPer = past.reduce((a, r) => a + (r.outputTokens ?? 0), 0) / totalReq;
  return { requests, usd: costUSD(model, inPer * requests, outPer * requests), basedOn: totalReq };
}

/** 実行前に必ず表示するブロック。今回の見積もりと、これまでの累計を並べる。 */
export function printPreflight(history, model, requests) {
  const est = estimate(history, model, requests);
  const tot = summarize(history);

  const estText = isFree(model)
    ? "**ローカル実行のため課金なし**"
    : est.usd == null
      ? "（このモデルの実績が無いため金額は不明）"
      : `約 $${est.usd.toFixed(2)}（約${yen(est.usd)}円）／ 過去${est.basedOn}リクエストの実績から算出`;
  console.log(`今回の見積もり : ${requests} リクエスト・${estText}`);

  if (tot.runs === 0) {
    console.log("これまでの累計 : 記録なし（今回が最初）");
  } else {
    const totText = tot.unpriced > 0 ? `（うち${tot.unpriced}回は単価不明のため未計上）` : "";
    console.log(
      `これまでの累計 : ${tot.runs}回・${tot.requests.toLocaleString()} リクエスト・` +
      `約 $${tot.usd.toFixed(2)}（約${yen(tot.usd).toLocaleString()}円）${totText}`
    );
  }
  console.log("※ クレジットは本番アプリと共有。使い切ると公開中のアプリも止まる");
}
