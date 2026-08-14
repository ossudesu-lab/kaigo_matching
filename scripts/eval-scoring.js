// 記録抽出evalの採点ロジック。
//
// eval-app.jsx（Claude.ai アーティファクト版）から移設したもの。
// **ロジックは意図的に一切変更していない。** 採点基準を変えると過去の結果と
// 比較できなくなるため、移設と改善は必ず別のコミットに分けること。
//
// 採点の考え方:
//  - フィールドごとに重み付け（見逃してはいけない項目を重く）
//  - 見逃し(FN)は過剰(FP)より重い。現場で本当に困るのは「拾えなかった」ケースのため
//  - 要介護度は1段階違いに部分点0.5（完全な外れと区別する）
//  - critical 指定フィールドのFNは criticalMisses に別枠で記録し、平均点に埋もれさせない

// ---------- 介護度 ----------
export const CARE_LEVELS = [
  { label: "要支援1", num: 1 }, { label: "要支援2", num: 2 },
  { label: "要介護1", num: 3 }, { label: "要介護2", num: 4 },
  { label: "要介護3", num: 5 }, { label: "要介護4", num: 6 }, { label: "要介護5", num: 7 },
];
const careNum = (label) => CARE_LEVELS.find((c) => c.label === label)?.num ?? null;

// ---------- 採点対象フィールドの定義（重み・型・性質）----------
export const FIELD_SPEC = {
  medical:     { weight: 3, type: "bool", fnPenalty: 1.0, fpPenalty: 0.5, critical: true,  label: "医療対応" },
  discrepancy: { weight: 3, type: "bool", fnPenalty: 1.0, fpPenalty: 0.6, critical: true,  label: "事前情報との食い違い" },
  result:      { weight: 3, type: "enum", critical: true,  label: "結果(定期/単発/様子見)" },
  trouble:     { weight: 2, type: "bool", fnPenalty: 1.0, fpPenalty: 0.4, critical: false, label: "トラブル" },
  care:        { weight: 2, type: "care", critical: false, label: "要介護度" },
  staff:       { weight: 2, type: "text", critical: false, label: "担当ケアマネ" },
  kyotaku:     { weight: 1, type: "text", critical: false, label: "紹介元" },
  date:        { weight: 1, type: "date", critical: true,  label: "利用日" },
};

// weight と critical は別の軸である点に注意。
//   weight   … 総合スコアへの影響度（間違えたときの減点の重さ）
//   critical … 黙って間違えられては困るか（警告を出すか）
// date は weight 1（総合への影響は小さい）だが critical（集計の軸なので黙って
// 壊れては困る）。実際に2026-08、date が全ケース0点でも総合91点・警告0件で
// 見逃された。この2軸を分けているのはそのため。

// ---------- 正解データの読み込み ----------
// eval-cases.json の { id, intent, record, truth:{...} } を、
// 採点で使うフラットな形 { id, intent, record, date, kyotaku, ... } に変換する。
export function parseCases(jsonText) {
  const data = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
  const list = Array.isArray(data) ? data : data.cases;
  if (!Array.isArray(list) || list.length === 0) throw new Error("cases が見つかりません");
  return list.map((c) => {
    if (!c.id || !c.record || !c.truth) {
      throw new Error(`ケース ${c.id ?? "?"} に id / record / truth が揃っていません`);
    }
    return { id: c.id, record: c.record, intent: c.intent ?? "", ...c.truth };
  });
}

// ---------- フィールド単位の採点 ----------
function scoreBool(p, g, spec) {
  const pv = p === true, gv = g === true;
  if (pv === gv) return { score: 1, kind: gv ? "TP" : "TN" };
  if (gv && !pv) return { score: 1 - spec.fnPenalty, kind: "FN" };
  return { score: 1 - spec.fpPenalty, kind: "FP" };
}
function scoreEnum(p, g) {
  const hit = (p ?? "") === (g ?? "");
  return { score: hit ? 1 : 0, kind: hit ? "hit" : "miss" };
}
function scoreCare(p, g) {
  const pn = careNum(p), gn = careNum(g);
  if (pn == null || gn == null) return { score: p === g ? 1 : 0, kind: "unknown" };
  const d = Math.abs(pn - gn);
  return { score: d === 0 ? 1 : d === 1 ? 0.5 : 0, kind: `dist${d}` };
}
const norm = (s) => (s ?? "").replace(/\s|　/g, "").trim();
function scoreText(p, g) {
  const hit = norm(p) === norm(g);
  return { score: hit ? 1 : 0, kind: hit ? "hit" : "miss" };
}
function scoreDate(p, g) {
  const hit = (p ?? "") === (g ?? "");
  return { score: hit ? 1 : 0, kind: hit ? "hit" : "miss" };
}

// ---------- ケース単位・eval全体の採点 ----------
export function scoreCase(predicted, truth) {
  const perField = {}; let earned = 0, total = 0; const criticalMisses = [];
  for (const [key, spec] of Object.entries(FIELD_SPEC)) {
    let r;
    if (spec.type === "bool") r = scoreBool(predicted[key], truth[key], spec);
    else if (spec.type === "enum") r = scoreEnum(predicted[key], truth[key]);
    else if (spec.type === "care") r = scoreCare(predicted[key], truth[key]);
    else if (spec.type === "text") r = scoreText(predicted[key], truth[key]);
    else if (spec.type === "date") r = scoreDate(predicted[key], truth[key]);
    else continue;
    perField[key] = { ...r, weight: spec.weight, label: spec.label,
                      predicted: predicted[key], truth: truth[key] };
    earned += r.score * spec.weight; total += spec.weight;

    // critical 指定のフィールドが外れたら、総合点に埋もれないよう別枠で警告する。
    // 旧実装は kind === "FN" だけを見ていたが、FN は真偽値項目（scoreBool）でしか
    // 発生しない。そのため date のような項目は critical を付けても警告されず、
    // result だけが個別のif文で救われている状態だった。
    // 「critical なフィールドが0点なら警告」に一般化して、型に依存しないようにする。
    if (spec.critical) {
      if (r.kind === "FN") criticalMisses.push(spec.label + "の見逃し");
      else if (r.score === 0) criticalMisses.push(spec.label + "の取り違え");
    }
  }
  return { id: truth.id, scorePct: total ? Math.round((earned / total) * 100) : 0, perField, criticalMisses };
}

export function scoreEval(predictions, truths) {
  const cases = truths.map((t) => scoreCase(predictions.find((x) => x.id === t.id) ?? {}, t));
  const overall = Math.round(cases.reduce((a, c) => a + c.scorePct, 0) / (cases.length || 1));
  const fieldAgg = {};
  for (const key of Object.keys(FIELD_SPEC)) {
    const scores = cases.map((c) => c.perField[key]?.score ?? 0);
    fieldAgg[key] = {
      label: FIELD_SPEC[key].label,
      avg: Math.round((scores.reduce((a, b) => a + b, 0) / (scores.length || 1)) * 100),
    };
  }
  const totalCriticalMisses = cases.reduce((a, c) => a + c.criticalMisses.length, 0);
  return { overall, cases, fieldAgg, totalCriticalMisses };
}

// ---------- 複数回実行の集計 ----------
// 1回の満点は信じない。平均・最低・最高・ブレを見るための集計。
export function statFor(runs, cases) {
  if (!runs.length) return null;
  const overalls = runs.map((r) => r.overall);
  const avg = Math.round(overalls.reduce((a, b) => a + b, 0) / overalls.length);
  const min = Math.min(...overalls), max = Math.max(...overalls);
  const cmAvg = runs.reduce((a, r) => a + r.totalCriticalMisses, 0) / runs.length;
  const perCase = {};
  for (const c of cases) {
    const arr = runs.map((r) => r.cases.find((x) => x.id === c.id)?.scorePct ?? 0);
    perCase[c.id] = {
      avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
      min: Math.min(...arr), max: Math.max(...arr),
      perfect: arr.filter((v) => v === 100).length, n: arr.length,
    };
  }
  return { runs: runs.length, avg, min, max, cmAvg, perCase };
}
