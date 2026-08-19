#!/usr/bin/env node
// PIIマスキングの伏せ漏れを測る。API課金は発生しない。
//
// eval-cases.json には正解の staff / kyotaku が入っている。
// マスク後の本文にその文字列がまだ残っていれば「漏れ」と判定できる。
// 「隠せているつもり」で終わらせないための計測。
//
// 2つの条件で測る:
//   辞書あり … 過去の記録から名前を集めてある状態（常連の居宅・担当者）
//   辞書なし … 初めての居宅・担当者が来たとき（パターン検出だけが頼り）
//
// 後者が実運用の弱点になる。そこを数字で出す。
//
// 使い方:
//   node scripts/pii-leak-check.js
//   node scripts/pii-leak-check.js --show=3   # マスク結果を3件表示する

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseCases } from "./eval-scoring.js";
import { buildDictionary, maskRecord, findLeaks } from "../api/_lib/pii-mask.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (n, d) => {
  const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};
const SHOW = Number(argOf("show", "0"));

const cases = parseCases(readFileSync(join(HERE, "..", "eval-cases.json"), "utf8"));

// 過去の記録から集めた辞書を模す。実運用では保存済みレコードの staff / kyotaku を使う。
const fullDict = buildDictionary({
  people: [...new Set(cases.map((c) => c.staff).filter(Boolean))],
  orgs: [...new Set(cases.map((c) => c.kyotaku).filter(Boolean))],
});
const emptyDict = buildDictionary();

function run(label, dict) {
  let leakedCases = 0;
  const leakedItems = [];
  for (const c of cases) {
    const { masked } = maskRecord(c.record, dict);
    // 本文に出てくる固有名詞が、マスク後も残っていないか。
    // 抽出対象（staff / kyotaku）だけでなく、piiNames（利用者名・自施設職員名）も見る。
    // 抽出対象しか見ていなかったとき、u2 の「当施設の看護師・鈴木」を見落とした。
    const leaks = findLeaks(masked, [c.staff, c.kyotaku, ...c.piiNames]);
    if (leaks.length) {
      leakedCases++;
      leakedItems.push({ id: c.id, leaks });
    }
  }
  const rate = Math.round((leakedCases / cases.length) * 100);
  console.log(`${label.padEnd(10)} 漏れ ${String(leakedCases).padStart(2)}/${cases.length}ケース（${rate}%）`);
  for (const x of leakedItems) console.log(`   ⚠ ${x.id}: ${x.leaks.join(" / ")}`);
  return { leakedCases, rate };
}

console.log(`ケース数: ${cases.length}`);
console.log(`辞書の中身: 人物 ${fullDict.people.length}件 / 事業所 ${fullDict.orgs.length}件`);
console.log("");

console.log("── 伏せ漏れ ──");
const withDict = run("辞書あり", fullDict);
console.log("");
const noDict = run("辞書なし", emptyDict);

console.log("");
console.log("辞書ありは「常連の居宅・担当者」、辞書なしは「初めての相手」に相当する。");
console.log("辞書なしの数字が、未知の相手に対する実力。");

// ── 復元できるか ──
// 伏せられても、戻したときに正解と一致しなければ意味がない。
// モデルが正しいプレースホルダを選べたと仮定して、復元先が正解と一致するかだけを見る。
// （モデルの当たり外れはここでは測らない。マスキング機構だけを切り出して測るため）
function restoreCheck(label, dict) {
  let ok = 0;
  const broken = [];
  for (const c of cases) {
    const { mapping } = maskRecord(c.record, dict);
    const targets = Object.values(mapping);
    const bad = [];
    for (const [field, truth] of [["staff", c.staff], ["kyotaku", c.kyotaku]]) {
      if (!truth) continue; // 正解が空の項目は復元の対象外
      if (!targets.includes(truth)) bad.push(`${field}: 正解「${truth}」に戻せる先が無い`);
    }
    if (bad.length) broken.push({ id: c.id, bad });
    else ok++;
  }
  console.log(`${label.padEnd(10)} 復元一致 ${String(ok).padStart(2)}/${cases.length}ケース`);
  for (const x of broken) console.log(`   ⚠ ${x.id}: ${x.bad.join(" / ")}`);
}

console.log("");
console.log("── 復元の一致 ──");
restoreCheck("辞書あり", fullDict);
console.log("");
restoreCheck("辞書なし", emptyDict);

if (SHOW > 0) {
  console.log("");
  console.log("── マスク結果の例（辞書なし）──");
  for (const c of cases.slice(0, SHOW)) {
    const { masked, mapping } = maskRecord(c.record, emptyDict);
    console.log(`\n[${c.id}]`);
    console.log(`  元  : ${c.record}`);
    console.log(`  伏せ: ${masked}`);
    console.log(`  対応: ${JSON.stringify(mapping)}`);
  }
}

// 辞書なしで漏れがあるのは想定内なので、終了コードでは落とさない。
// 数字を見るための道具であって、合否を出す道具ではない。
