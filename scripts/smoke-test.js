#!/usr/bin/env node
// デプロイ経路のスモークテスト。
//
// eval（scripts/eval-extract.js）が測るのは「プロンプト＋モデル」で、HTTP層は通らない。
// こちらは逆に、実際の /api/extract を叩いて**経路が生きているか**を確認する。
//   - エンドポイントが応答するか
//   - 入力検証・レート制限を抜けて処理されるか
//   - 返ってきたJSONがアプリの期待する形になっているか
//
// レート制限は 20回 / 10分 / IP なので、ケース数は既定3件に絞っている。
// 精度の測定が目的ではない。精度は eval-extract.js で測ること。
//
// 使い方:
//   node scripts/smoke-test.js --url=http://localhost:3000
//   node scripts/smoke-test.js --url=https://example.vercel.app --cases=s1,u1,t4
//
// Deployment Protection が有効な Preview を叩く場合は、バイパストークンを環境変数で渡す:
//   VERCEL_AUTOMATION_BYPASS_SECRET=xxxx node scripts/smoke-test.js --url=https://...
//   （トークンは Vercel の Settings → Deployment Protection で発行できる）
//
// シェル経由の curl は環境によって日本語が壊れることがあるため、記録文の送信には
// Node の fetch を使っている。テスト手法の文字化けを不具合と誤認しないための措置。
//
// 終了コード: 1件でも失敗したら 1。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseCases, scoreCase } from "./eval-scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE_URL = argOf("url", null);
// 既定の3件は、今回の修正で直った項目を1つずつ踏むように選んである。
//   s1 … date（年の補完。修正前は全滅していた）
//   u1 … staff（「高橋CM」→「高橋」の正規化）
//   t4 … discrepancy（軽微な変化を食い違いにしない。過去にFP常習）
const CASE_IDS = argOf("cases", "s1,u1,t4").split(",").map((s) => s.trim()).filter(Boolean);

if (!BASE_URL) {
  console.error("--url を指定してください。例: --url=http://localhost:3000");
  process.exit(2);
}

const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";

async function callApi(text) {
  const headers = { "Content-Type": "application/json" };
  if (BYPASS) headers["x-vercel-protection-bypass"] = BYPASS;
  const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/api/extract`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  // api/extract.js は { text: "<モデルの生出力>" } を返す。アプリ側と同じ手順で開く。
  const outer = JSON.parse(body);
  if (typeof outer.text !== "string") throw new Error(`想定外の応答形: ${body.slice(0, 200)}`);
  return JSON.parse(outer.text.replace(/```json|```/g, "").trim());
}

async function main() {
  const all = parseCases(readFileSync(join(HERE, "..", "eval-cases.json"), "utf8"));
  const targets = CASE_IDS.map((id) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`ケース ${id} が eval-cases.json にありません`);
    return c;
  });

  console.log(`対象URL : ${BASE_URL}`);
  console.log(`ケース  : ${targets.map((c) => c.id).join(", ")}（${targets.length}件）`);
  console.log("");

  let failed = 0;
  for (const c of targets) {
    const t0 = Date.now();
    try {
      const predicted = await callApi(c.record);
      const r = scoreCase(predicted, c);
      const ms = Date.now() - t0;
      const ok = r.scorePct === 100 && r.criticalMisses.length === 0;
      if (!ok) failed++;
      console.log(`${ok ? "✓" : "✗"} ${c.id}  ${r.scorePct}点  ${(ms / 1000).toFixed(2)}秒  ${c.intent}`);
      if (!ok) {
        for (const [key, f] of Object.entries(r.perField)) {
          if (f.score !== 1) console.log(`      ${f.label}: 予測=${JSON.stringify(f.predicted)} / 正解=${JSON.stringify(f.truth)}`);
        }
        if (r.criticalMisses.length) console.log(`      ⚠ ${r.criticalMisses.join("・")}`);
      }
    } catch (e) {
      failed++;
      console.log(`✗ ${c.id}  ${e.message}`);
    }
  }

  console.log("");
  if (failed) {
    console.error(`${failed}/${targets.length} 件が失敗しました。デプロイ経路に問題があります。`);
    process.exit(1);
  }
  console.log(`${targets.length}/${targets.length} 件成功。デプロイ経路は正常です。`);
}

main().catch((e) => {
  console.error("実行エラー:", e.message);
  process.exit(1);
});
