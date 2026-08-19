#!/usr/bin/env node
// 記録抽出evalの実走スクリプト（CLI / CI用）。
//
// 本番API（api/extract.js）と同じプロンプト・同じモデル設定を import して測る。
// HTTP層（レート制限）は通さない。evalが検証すべきは「プロンプト＋モデル」であって、
// 公開エンドポイントの防波堤ではないため。デプロイ経路の疎通は別途スモークテストで見る。
//
// 使い方:
//   node --env-file=.env scripts/eval-extract.js                 # 既定モデル・既定プロンプトで10回
//   node --env-file=.env scripts/eval-extract.js --runs=3        # 3回
//   node --env-file=.env scripts/eval-extract.js --model=claude-sonnet-5
//   node --env-file=.env scripts/eval-extract.js --prompt=scripts/prompt-variants/baseline-v1.js
//   node --env-file=.env scripts/eval-extract.js --runs=10 --dry-run   # 金額の見積もりだけ（APIは呼ばない）
//
// 実行前に「今回の見積もり」と「これまでの累計」を必ず表示する。
// クレジットは本番アプリと共有しているため、使い切ると公開中のアプリが止まる（2026-08-19 に発生）。
//
//   （--env-file は Node 20.6 以降。使えない場合は環境変数を直接渡す）
//   ANTHROPIC_API_KEY=sk-... node scripts/eval-extract.js
//
// --prompt に渡すモジュールは buildPrompt(text, { year }) を export すること。
// 省略時は本番と同じ api/_lib/extract-prompt.js を使う。
//
// 終了コード: 完走率が90%未満なら 1（CLAUDE.md の運用ルール「完走率90%未満の結果は
// 信用しない」に従い、CIで黙って通さない）。

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import { callLLM, isLocal } from "../api/_lib/llm.js";
import { MODEL, buildPrompt } from "../api/_lib/extract-prompt.js";
import { parseCases, scoreEval, statFor, FIELD_SPEC } from "./eval-scoring.js";
import { appendRun, loadHistory, printPreflight, summarize, costUSD, yen } from "./eval-usage.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// API利用量の記録先。端末ごとの記録なのでコミットしない（.gitignore 済み）。
// CI は毎回まっさらな環境で走るため、累計はローカルでの手動実行だけを追う。
const USAGE_LOG = join(HERE, "..", ".eval-usage.jsonl");

// 正解データ（eval-cases.json）の date は 2026年で固定されている。
// 年を実行時の年にすると来年から全ケースの date が外れるため、evalでは年を固定する。
// 本番は buildPrompt の既定値（実行時の年）を使う。
const EVAL_YEAR = 2026;

// CLAUDE.md: 完走できない10回より、完走できる5回のほうが正直。
const MIN_COMPLETION_RATE = 0.9;

const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const RUNS = Number(argOf("runs", "10"));
const MODEL_ID = argOf("model", MODEL);
const PROMPT_PATH = argOf("prompt", null); // null なら本番と同じプロンプト
// 特定ケースだけ多数回まわして安定性を確かめたいとき用（例: --cases=v10 --runs=30）。
// 「10回で8/10」がブレなのか実力なのかは、10回では分からないため。
const CASE_FILTER = argOf("cases", null);
// APIを叩かずに見積もりだけ出して終わる。大きく回す前に金額を確かめるため。
const DRY_RUN = process.argv.slice(2).includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 進捗表示は端末のときだけ出す。CI のログでは \r が展開されて
// 1行ごとに残り、結果が埋もれるため。
const isTTY = Boolean(process.stdout.isTTY);
const progress = (s) => { if (isTTY) process.stdout.write(s); };

// --prompt が指定されていればそのモジュールの buildPrompt を使う。
// 比較したいのはプロンプトの中身なので、差し替えはここ1箇所に閉じる。
async function resolveBuildPrompt() {
  if (!PROMPT_PATH) return { fn: buildPrompt, label: "api/_lib/extract-prompt.js（本番と同一）" };
  const mod = await import(pathToFileURL(resolve(PROMPT_PATH)).href);
  if (typeof mod.buildPrompt !== "function") {
    throw new Error(`${PROMPT_PATH} が buildPrompt を export していません`);
  }
  return { fn: mod.buildPrompt, label: PROMPT_PATH };
}

// APIが返した実トークン数の累計。再試行した分も足す（実際に払う額はそちらのため）。
const usage = { input: 0, output: 0, calls: 0 };
const recordUsage = (u) => {
  usage.input += u.input_tokens ?? 0;
  usage.output += u.output_tokens ?? 0;
  usage.calls += 1;
};

// 1ケース分の抽出。JSON崩れ・一時的な通信エラーは最大3回まで再試行する。
async function extractSafe(record, makePrompt) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await callLLM(makePrompt(record, { year: EVAL_YEAR }), MODEL_ID, recordUsage);
      return JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch (e) {
      lastError = e;
      if (attempt < 3) await sleep(800 * (attempt + 1));
    }
  }
  throw lastError;
}

function pct(n) { return String(n).padStart(3, " "); }

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY が設定されていません。");
    console.error("  node --env-file=.env.local scripts/eval-extract.js");
    process.exit(2);
  }

  let cases = parseCases(readFileSync(join(HERE, "..", "eval-cases.json"), "utf8"));
  if (CASE_FILTER) {
    const wanted = CASE_FILTER.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = wanted.filter((id) => !cases.some((c) => c.id === id));
    if (missing.length) throw new Error(`ケースが見つかりません: ${missing.join(", ")}`);
    cases = cases.filter((c) => wanted.includes(c.id));
  }
  const { fn: makePrompt, label: promptLabel } = await resolveBuildPrompt();

  console.log(`モデル     : ${MODEL_ID}`);
  console.log(`プロンプト : ${promptLabel}`);
  console.log(`ケース     : ${cases.length}件 / 実行 ${RUNS}回（計 ${cases.length * RUNS} リクエスト）`);
  console.log("");

  // 実行前に「今回いくらか」と「これまでいくら使ったか」を必ず出す。
  // 2026-08-19、累積を見ていなかったせいでクレジットが尽き、本番アプリが停止したため。
  const history = loadHistory(USAGE_LOG);
  printPreflight(history, MODEL_ID, cases.length * RUNS);
  console.log("");

  if (DRY_RUN) {
    console.log("--dry-run のため、ここで終了します（APIは呼んでいません）。");
    return;
  }

  const runsPreds = []; // 実行ごとの予測。採点は最後にまとめて行う（開発用/未知で複数回集計するため）
  const latencies = []; // 1リクエストあたりの所要ms（再試行が入った分も込み＝実際にかかった時間）
  let failedRuns = 0;
  const startedAt = Date.now();

  for (let r = 0; r < RUNS; r++) {
    const runStarted = Date.now();
    try {
      const preds = [];
      for (const c of cases) {
        progress(`\r  ${r + 1}/${RUNS}回目  ${preds.length + 1}/${cases.length}ケース…   `);
        const t0 = Date.now();
        const out = await extractSafe(c.record, makePrompt);
        latencies.push(Date.now() - t0);
        preds.push({ id: c.id, ...out });
      }
      runsPreds.push(preds);
      // 端末なら上の \r 表示で進捗が見えるが、CIやバックグラウンド実行では
      // 完了まで何も出ない。ローカルLLMだと1周に30分かかることもあり、
      // 生きているのか分からなくなるため、1周ごとに1行だけ残す。
      // 1件ごとに出すとログが荒れるので、粒度は「周」に留める。
      if (!isTTY) {
        console.log(`  ${r + 1}/${RUNS}回目 完了（${cases.length}件・${((Date.now() - runStarted) / 1000 / 60).toFixed(1)}分）`);
      }
    } catch (e) {
      failedRuns++;
      console.error(`\n  ${r + 1}回目は失敗のため除外: ${e.message}`);
    }
  }
  progress("\r" + " ".repeat(50) + "\r");

  if (runsPreds.length === 0) {
    console.error("全ての実行が失敗しました。APIキー・ネットワーク・モデル名を確認してください。");
    process.exit(1);
  }

  // 開発用（プロンプトのチューニングに使ったケース）と未知（heldOut）を分けて集計する。
  // 全体スコアは「作り込んだケース込み」の数字なので、汎化性能を語るときは未知の方を見ること。
  const devCases = cases.filter((c) => !c.heldOut);
  const heldCases = cases.filter((c) => c.heldOut);

  const runs = runsPreds.map((p) => scoreEval(p, cases));
  const stat = statFor(runs, cases);
  const statDev = devCases.length ? statFor(runsPreds.map((p) => scoreEval(p, devCases)), devCases) : null;
  const statHeld = heldCases.length ? statFor(runsPreds.map((p) => scoreEval(p, heldCases)), heldCases) : null;
  const completionRate = runs.length / RUNS;

  // ---- 総合 ----
  console.log("─".repeat(52));
  console.log(`総合スコア   平均 ${stat.avg}  （最低 ${stat.min} / 最高 ${stat.max}）`);
  if (statHeld && statDev) {
    // 全体スコアは作り込んだケースを含むので高く出る。汎化性能は「未知」の行を見ること。
    console.log(`  ├ 開発用   平均 ${statDev.avg}  （${devCases.length}件・プロンプト作成に使用）`);
    console.log(`  └ 未知     平均 ${statHeld.avg}  （${heldCases.length}件・作成後に追加）← 汎化性能`);
  }
  console.log(`重大な見逃し 平均 ${stat.cmAvg.toFixed(1)} 件/回  ${stat.cmAvg > 0 ? "⚠" : "✓"}`);
  console.log(`完走率       ${runs.length}/${RUNS} (${Math.round(completionRate * 100)}%)`);

  // 速度。1記録あたりの応答時間なので、現場で「1件入力してどれだけ待つか」に相当する。
  if (latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(
      `応答時間     平均 ${(avg / 1000).toFixed(2)}秒 / 中央 ${(p50 / 1000).toFixed(2)}秒 / p95 ${(p95 / 1000).toFixed(2)}秒` +
      `  （${latencies.length}件）`
    );
    console.log(`実行時間     ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)}分`);
  }
  if (usage.calls) {
    console.log(
      `トークン     1件あたり 入力 ${Math.round(usage.input / usage.calls)} / 出力 ${Math.round(usage.output / usage.calls)}` +
      `　（今回 入力 ${usage.input.toLocaleString()} / 出力 ${usage.output.toLocaleString()} ・ ${usage.calls}回）`
    );

    // 完走率で落ちる場合でも、使った分は必ず記録する。金は既に出ているため。
    const usd = costUSD(MODEL_ID, usage.input, usage.output);
    appendRun(USAGE_LOG, {
      at: new Date().toISOString(),
      model: MODEL_ID,
      prompt: promptLabel,
      cases: cases.length,
      runs: RUNS,
      requests: usage.calls,
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(usd == null ? {} : { usd }),
    });

    const after = summarize(loadHistory(USAGE_LOG));
    console.log(
      `今回のコスト ${usd == null ? "単価不明" : `約 $${usd.toFixed(2)}（約${yen(usd)}円）`}` +
      `　／　累計 ${after.requests.toLocaleString()} リクエスト・約 $${after.usd.toFixed(2)}（約${yen(after.usd).toLocaleString()}円）`
    );
  }
  console.log("─".repeat(52));

  // ---- フィールド別（全実行の平均）----
  console.log("\nフィールド別スコア（重み順）");
  for (const key of Object.keys(FIELD_SPEC)) {
    const avg = Math.round(runs.reduce((a, run) => a + run.fieldAgg[key].avg, 0) / runs.length);
    const bar = "█".repeat(Math.round(avg / 5)).padEnd(20, "░");
    console.log(`  ${FIELD_SPEC[key].label.padEnd(22, "　")} ×${FIELD_SPEC[key].weight}  ${bar} ${pct(avg)}`);
  }

  // ---- ケース別の安定性 ----
  console.log("\nケース別の安定性（毎回満点でないケース＝判断がブレる要注意ポイント）");
  let heldHeaderPrinted = false;
  for (const c of cases) {
    if (c.heldOut && !heldHeaderPrinted) {
      console.log("  ── ここから未知ケース（プロンプト作成後に追加。汎化性能を見る） ──");
      heldHeaderPrinted = true;
    }
    const s = stat.perCase[c.id];
    const stable = s.perfect === s.n;
    console.log(
      `  ${c.id.padEnd(4)} 平均${pct(s.avg)} (${pct(s.min)}–${pct(s.max)})  ` +
      `${String(s.perfect).padStart(2)}/${s.n}回満点 ${stable ? "✓" : "⚠"}  ${c.intent}`
    );
  }

  // ---- 完走率のゲート ----
  if (completionRate < MIN_COMPLETION_RATE) {
    console.error(
      `\n⚠ 完走率が ${Math.round(MIN_COMPLETION_RATE * 100)}% を下回っています。` +
      `\n  欠けたデータの平均は実力ではありません。この結果は採用しないでください。`
    );
    process.exit(1);
  }
  console.log("");
}

main().catch((e) => {
  console.error("\n実行エラー:", e.message);
  process.exit(1);
});
