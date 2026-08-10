import { useState } from "react";

/*
  記録抽出eval（Prompt A vs 強化版Prompt B）
  ─ 7/8のベースに eval-scoring.js の採点思想を組み込んだ実走版。
  ─ 正解データは JSON（eval-cases.json と同形式）で管理。画面上のテキスト欄で差し替え可能。
  ─ 採点の肝：重要フィールドを重く／見逃し(FN)を重罪／過剰(FP)も減点／重大な見逃しは別枠で警告。
*/

// ---------- 介護度 ----------
const CARE_LEVELS = [
  { label: "要支援1", num: 1 }, { label: "要支援2", num: 2 },
  { label: "要介護1", num: 3 }, { label: "要介護2", num: 4 },
  { label: "要介護3", num: 5 }, { label: "要介護4", num: 6 }, { label: "要介護5", num: 7 },
];
const careNum = (label) => CARE_LEVELS.find((c) => c.label === label)?.num ?? null;

// ---------- 採点対象フィールドの定義（重み・型・性質）----------
const FIELD_SPEC = {
  medical:     { weight: 3, type: "bool", fnPenalty: 1.0, fpPenalty: 0.5, critical: true,  label: "医療対応" },
  discrepancy: { weight: 3, type: "bool", fnPenalty: 1.0, fpPenalty: 0.6, critical: true,  label: "事前情報との食い違い" },
  result:      { weight: 3, type: "enum", critical: true,  label: "結果(定期/単発/様子見)" },
  trouble:     { weight: 2, type: "bool", fnPenalty: 1.0, fpPenalty: 0.4, critical: false, label: "トラブル" },
  care:        { weight: 2, type: "care", critical: false, label: "要介護度" },
  staff:       { weight: 2, type: "text", critical: false, label: "担当ケアマネ" },
  kyotaku:     { weight: 1, type: "text", critical: false, label: "紹介元" },
  date:        { weight: 1, type: "date", critical: false, label: "利用日" },
};

// ---------- 正解データ（eval-cases.json と同じ形。貼り付けで差し替え可能）----------
const DEFAULT_CASES_JSON = `{
  "version": "2.0",
  "name": "記録抽出eval 正解データ",
  "cases": [
    { "id": "s1", "intent": "基本：問題のない定期利用",
      "record": "6/4 あおぞら居宅介護支援の佐藤さんからのご利用。要介護3の方。穏やかに過ごされ、ご家族の協力も良好。特別な医療処置はなし。今後も定期でご利用予定。",
      "truth": {"date": "2026-06-04", "kyotaku": "あおぞら居宅介護支援", "staff": "佐藤", "care": "要介護3", "medical": false, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "s2", "intent": "基本：明確な医療対応あり（インスリン）",
      "record": "6/11 あおぞら居宅介護支援の佐藤さん紹介。要介護2。インスリン対応あり、看護師と連携済み。落ち着いており定期利用の見込み。",
      "truth": {"date": "2026-06-11", "kyotaku": "あおぞら居宅介護支援", "staff": "佐藤", "care": "要介護2", "medical": true, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "s3", "intent": "基本：ポジティブのみ。過剰にフラグを立てないか",
      "record": "6/18 あおぞら居宅介護支援さん。要介護3の方。リハビリに前向きで意欲的。医療対応は特になし。定期利用を継続。",
      "truth": {"date": "2026-06-18", "kyotaku": "あおぞら居宅介護支援", "staff": "", "care": "要介護3", "medical": false, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "s4", "intent": "重要：食い違い＋トラブル＋単発終了",
      "record": "6/5 みなと居宅介護支援の高橋さん紹介、要介護4。事前の申し送りと実際の様子がかなり違い、夜間対応が想定より重かった。現場が混乱し、今回は単発で終了。",
      "truth": {"date": "2026-06-05", "kyotaku": "みなと居宅介護支援", "staff": "高橋", "care": "要介護4", "medical": false, "result": "single", "trouble": true, "discrepancy": true} },
    { "id": "s5", "intent": "重要：実質的な食い違い（介助量が多い）を拾えるか",
      "record": "6/12 みなと居宅介護支援の高橋さん。要介護3。穏やかと聞いていたが、実際は介助量が多めだった。大きなトラブルはないが、今回は単発で終了。",
      "truth": {"date": "2026-06-12", "kyotaku": "みなと居宅介護支援", "staff": "高橋", "care": "要介護3", "medical": false, "result": "single", "trouble": false, "discrepancy": true} },
    { "id": "s6", "intent": "基本：医療対応＋スタッフ間トラブル＋様子見",
      "record": "6/13 やまびこケアプランの中村さん、要介護2。痰吸引あり看護師対応。ただし夜間ケアの進め方でスタッフ間の対立があり、現場が不安定。継続するかは未確定で様子見。",
      "truth": {"date": "2026-06-13", "kyotaku": "やまびこケアプラン", "staff": "中村", "care": "要介護2", "medical": true, "result": "watch", "trouble": true, "discrepancy": false} },
    { "id": "t1", "intent": "意地悪：『血圧が高め』に釣られて medical=true にしないか",
      "record": "6/20 そよかぜ居宅の田村さん、要介護3。事前に『血圧が高めなので注意』と聞いていた通り、当日も少し高め。特に処置は不要で、看護師の指示も特になし。全体的に落ち着いており定期利用の見込み。",
      "truth": {"date": "2026-06-20", "kyotaku": "そよかぜ居宅", "staff": "田村", "care": "要介護3", "medical": false, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "t2", "intent": "意地悪：トラブル≠食い違い。混同しないか",
      "record": "6/22 みなと居宅の山本さん、要介護4。事前情報通り穏やかな方だったが、送迎車の手配ミスで到着が大幅に遅れ、現場が一時混乱した。利用者本人の状態は問題なし。継続利用の予定。",
      "truth": {"date": "2026-06-22", "kyotaku": "みなと居宅", "staff": "山本", "care": "要介護4", "medical": false, "result": "regular", "trouble": true, "discrepancy": false} },
    { "id": "t3", "intent": "意地悪：情報が薄い。推測で埋めないか（staffも空が正解）",
      "record": "6/25 新規のケアマネさんから急ぎの相談。要介護度は確認中とのこと。まだ詳細な情報が少なく、受け入れ可否は要検討。",
      "truth": {"date": "2026-06-25", "kyotaku": "", "staff": "", "care": "", "medical": false, "result": "watch", "trouble": false, "discrepancy": false} },
    { "id": "t4", "intent": "意地悪：軽微な差は食い違いにしない（過去にFP常習）",
      "record": "6/27 あおぞら居宅の佐藤さん、要介護2。『特に問題なし』と聞いていたが、当日は少し表情が硬く、食事もいつもよりゆっくりだった。大きな異常ではない。定期利用は継続。",
      "truth": {"date": "2026-06-27", "kyotaku": "あおぞら居宅", "staff": "佐藤", "care": "要介護2", "medical": false, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "u1", "intent": "staff意地悪：表記ゆれ（「担当:」＋「CM」表記）。姓のみに正規化できるか",
      "record": "7/2 みなと居宅介護支援より紹介。担当: 高橋CM。要介護3。事前情報どおりで問題なく経過。定期利用となる見込み。",
      "truth": {"date": "2026-07-02", "kyotaku": "みなと居宅介護支援", "staff": "高橋", "care": "要介護3", "medical": false, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "u2", "intent": "staff意地悪：自施設の看護師名・利用者名に釣られないか。staffは居宅側の担当者のみ",
      "record": "7/3 やまびこケアプランの中村さんから、田中様（要介護4）のご利用。当施設の看護師・鈴木が対応し、痰吸引を実施。事前情報と相違なく、落ち着いて過ごされた。定期利用を継続。",
      "truth": {"date": "2026-07-03", "kyotaku": "やまびこケアプラン", "staff": "中村", "care": "要介護4", "medical": true, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "u3", "intent": "staff意地悪：居宅名はあるが担当者名がない。staffを推測で埋めないか",
      "record": "7/4 そよかぜ居宅からの紹介。要介護2の方。担当のケアマネは不在で、事務の方から連絡があった。特変なく経過。定期の見込み。",
      "truth": {"date": "2026-07-04", "kyotaku": "そよかぜ居宅", "staff": "", "care": "要介護2", "medical": false, "result": "regular", "trouble": false, "discrepancy": false} },
    { "id": "u4", "intent": "staff意地悪：担当者絡みのトラブル（提供表に勝手に予約）。staffとtroubleを両方拾えるか",
      "record": "7/5 あおぞら居宅の鈴木さん。要介護2。事前の電話連絡がなく、提供表に予約が入った状態で送られてきて発覚。確認の手間がかかった。利用者の状態自体は事前情報どおり。継続は未確定。",
      "truth": {"date": "2026-07-05", "kyotaku": "あおぞら居宅", "staff": "鈴木", "care": "要介護2", "medical": false, "result": "watch", "trouble": true, "discrepancy": false} }
  ]
}`;

// JSON（id/record/truth形式）を、内部で使うフラットな形に変換
function parseCases(jsonText) {
  const data = JSON.parse(jsonText);
  const list = Array.isArray(data) ? data : data.cases;
  if (!Array.isArray(list) || list.length === 0) throw new Error("cases が見つかりません");
  return list.map((c) => {
    if (!c.id || !c.record || !c.truth) throw new Error(`ケース ${c.id ?? "?"} に id / record / truth が揃っていません`);
    return { id: c.id, record: c.record, intent: c.intent ?? "", ...c.truth };
  });
}

// ---------- 2つのプロンプト ----------
const FIELDS_HINT = `date(YYYY-MM-DD), kyotaku(紹介元の居宅・ケアマネ事業所), staff(担当ケアマネの氏名), care(要支援1〜要介護5), medical(true/false), result("regular"定期/"single"単発/"watch"様子見), trouble(true/false), discrepancy(true/false), summary(1〜2文)`;

// Prompt A：最小限（判定基準なし）
const PROMPT_A = (record) =>
`次の記録文から項目を抽出し、JSONオブジェクトだけを返してください。前置き・マークダウン記号は不要。
抽出項目: ${FIELDS_HINT}

【記録文】
${record}`;

// Prompt B：詳細＋3章の思想（過剰に埋めない・慎重に読む）
const PROMPT_B = (record) =>
`あなたは介護施設の相談員として、居宅・ケアマネから来た利用者の記録を読み取ります。次の記録文から項目を抽出し、JSONオブジェクトだけを返してください（前置き・マークダウン記号は不要）。

抽出項目と判定基準:
- date: 利用日。YYYY-MM-DD。年が無ければ2026年とする。無ければ ""
- kyotaku: 紹介元の居宅・ケアマネ事業所名。無ければ ""
- staff: 紹介元の担当ケアマネの氏名。**姓のみ・敬称なし**に正規化する（例：「高橋さん」「担当:高橋」「高橋CM」「ケアマネの高橋さん」→ すべて "高橋"）。
  注意：自施設の職員（看護師・介護職員など）や利用者本人の名前は staff ではない。**紹介元の居宅側の担当者だけ**を入れる。書かれていなければ ""。
- care: 要介護度。要支援1／要支援2／要介護1〜要介護5 のいずれかに厳密一致。不明なら ""
- medical: インスリン・点滴・痰吸引・褥瘡処置など"具体的な看護処置の記載がある時だけ" true。曖昧な表現では true にしない。
- result: 継続の見込み="regular"／今回で終了="single"／未確定・様子見="watch"。判断できなければ "watch"。
- trouble: 現場の問題・対立・混乱の記載がある時だけ true。
- discrepancy: 事前に聞いていた情報と実際が食い違い、かつその差が現場的に"看過できない実質的なもの"のとき true（例：想定より介助量が多い／状態が想定より重い など）。原因が介助量・忙しさでも、実質的な負荷差なら true。
  一方、事前との差が"軽微な様子の変化"にとどまり「大きな異常ではない」と読める場合は true にしない（例：表情が少し硬い／食事が少しゆっくり 程度）。
  例：「穏やかと聞いていたが実際は介助量が多かった」→ true。「特に問題なしと聞いていたが少し表情が硬い程度、大きな異常なし」→ false。
  対比が無く単に「忙しい」「大変」だけの場合も true にしない。
- summary: 様子を1〜2文で簡潔に。

重要な方針（盛らない）:
- 根拠のない項目は空文字 "" または false にする。推測で埋めない。
- 記録文に書かれていない医療対応・トラブル・食い違いを、勝手に付け足さない。
- ただし、書かれている異変（食い違い・トラブル・医療処置）は絶対に見落とさない。

【記録文】
${record}`;

// ---------- 採点関数 ----------
function scoreBool(p, g, spec) {
  const pv = p === true, gv = g === true;
  if (pv === gv) return { score: 1, kind: gv ? "TP" : "TN" };
  if (gv && !pv) return { score: 1 - spec.fnPenalty, kind: "FN" };
  return { score: 1 - spec.fpPenalty, kind: "FP" };
}
function scoreEnum(p, g) { const hit = (p ?? "") === (g ?? ""); return { score: hit ? 1 : 0, kind: hit ? "hit" : "miss" }; }
function scoreCare(p, g) {
  const pn = careNum(p), gn = careNum(g);
  if (pn == null || gn == null) return { score: p === g ? 1 : 0, kind: "unknown" };
  const d = Math.abs(pn - gn);
  return { score: d === 0 ? 1 : d === 1 ? 0.5 : 0, kind: `dist${d}` };
}
const norm = (s) => (s ?? "").replace(/\s|　/g, "").trim();
function scoreText(p, g) { const hit = norm(p) === norm(g); return { score: hit ? 1 : 0, kind: hit ? "hit" : "miss" }; }
function scoreDate(p, g) { const hit = (p ?? "") === (g ?? ""); return { score: hit ? 1 : 0, kind: hit ? "hit" : "miss" }; }

function scoreCase(predicted, truth) {
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
    if (spec.critical && r.kind === "FN") criticalMisses.push(spec.label + "の見逃し");
    if (key === "result" && r.score === 0) criticalMisses.push("結果判定の取り違え");
  }
  return { id: truth.id, scorePct: total ? Math.round((earned / total) * 100) : 0, perField, criticalMisses };
}
function scoreEval(predictions, truths) {
  const cases = truths.map((t) => scoreCase(predictions.find((x) => x.id === t.id) ?? {}, t));
  const overall = Math.round(cases.reduce((a, c) => a + c.scorePct, 0) / (cases.length || 1));
  const fieldAgg = {};
  for (const key of Object.keys(FIELD_SPEC)) {
    const scores = cases.map((c) => c.perField[key]?.score ?? 0);
    fieldAgg[key] = { label: FIELD_SPEC[key].label, avg: Math.round((scores.reduce((a, b) => a + b, 0) / (scores.length || 1)) * 100) };
  }
  const totalCriticalMisses = cases.reduce((a, c) => a + c.criticalMisses.length, 0);
  return { overall, cases, fieldAgg, totalCriticalMisses };
}

// ---------- API呼び出し ----------
async function extract(record, promptFn) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000,
      messages: [{ role: "user", content: promptFn(record) }] }),
  });
  const data = await res.json();
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ---------- 色・スタイル ----------
const C = {
  bg: "#EEF0F3", surface: "#FFFFFF", ink: "#1B2130", muted: "#6B7280",
  line: "#DCE0E6", primary: "#2B4B8C", good: "#1E7A5A", crit: "#B45309",
  fn: "#B42318", fp: "#9A6B00", chipBg: "#F4F5F7",
};
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
const sans = "ui-sans-serif, system-ui, -apple-system, 'Hiragino Sans', sans-serif";

// n回分のeval結果から統計を作る
function statFor(runs, cases) {
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
function aggregate(aRuns, bRuns, failedRuns, n, cases) {
  return { A: statFor(aRuns, cases), B: statFor(bRuns, cases), failedRuns, n };
}

export default function EvalApp() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [resA, setResA] = useState(null);
  const [resB, setResB] = useState(null);
  const [open, setOpen] = useState({});
  const [multiStats, setMultiStats] = useState(null);

  // 正解データ（JSON）。テキスト欄で差し替えられる
  const [casesJson, setCasesJson] = useState(DEFAULT_CASES_JSON);
  const [cases, setCases] = useState(() => parseCases(DEFAULT_CASES_JSON));
  const [jsonError, setJsonError] = useState("");
  const [showJson, setShowJson] = useState(false);

  function applyJson() {
    try {
      const parsed = parseCases(casesJson);
      setCases(parsed);
      setJsonError("");
      setResA(null); setResB(null); setMultiStats(null); // 結果はリセット
    } catch (e) {
      setJsonError("JSONを読み込めません：" + (e?.message || e));
    }
  }

  async function run() {
    setRunning(true); setError(""); setResA(null); setResB(null);
    try {
      const predA = [], predB = [];
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        setProgress(`${i + 1}/${cases.length}：${c.id} を採点中…`);
        const [a, b] = await Promise.all([extractSafe(c.record, PROMPT_A), extractSafe(c.record, PROMPT_B)]);
        predA.push({ id: c.id, ...a }); predB.push({ id: c.id, ...b });
      }
      setResA(scoreEval(predA, cases)); setResB(scoreEval(predB, cases));
      setProgress("");
    } catch (e) {
      setError("実行中にエラーが出ました：" + (e?.message || e) + "（AIの返答がJSONで返らなかった可能性があります。もう一度実行してみてください）");
    } finally { setRunning(false); }
  }

  // 失敗時に最大3回までリトライ（JSON崩れ対策）
  async function extractSafe(record, promptFn) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await extract(record, promptFn); }
      catch (e) {
        if (attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); // 間を空けて再試行
      }
    }
  }

  // n回連続で走らせて、平均・最低・最高・ブレ・重大見逃しの平均を集計
  async function runMulti(n) {
    setRunning(true); setError(""); setMultiStats(null); setResA(null); setResB(null);
    const aRuns = [], bRuns = []; let failedRuns = 0;
    try {
      for (let r = 0; r < n; r++) {
        try {
          const predA = [], predB = [];
          for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            setProgress(`${r + 1}/${n}回目・${i + 1}/${cases.length}ケース…（完了 ${aRuns.length}回）`);
            const [a, b] = await Promise.all([extractSafe(c.record, PROMPT_A), extractSafe(c.record, PROMPT_B)]);
            predA.push({ id: c.id, ...a }); predB.push({ id: c.id, ...b });
          }
          const ea = scoreEval(predA, cases), eb = scoreEval(predB, cases);
          aRuns.push(ea); bRuns.push(eb);
          setResA(ea); setResB(eb);                       // 最新回の詳細を表示に流用
          setMultiStats(aggregate(aRuns, bRuns, failedRuns, n, cases)); // 途中経過も随時更新
        } catch (e) {
          failedRuns++;                                   // その回は通信エラー等で除外
        }
      }
      setMultiStats(aggregate(aRuns, bRuns, failedRuns, n, cases));
      setProgress("");
    } catch (e) {
      setError("実行中にエラー：" + (e?.message || e));
    } finally { setRunning(false); }
  }

  return (
    <div style={{ background: C.bg, minHeight: "100%", fontFamily: sans, color: C.ink, padding: "28px 20px" }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>

        {/* ヘッダー */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: mono, fontSize: 12, letterSpacing: 1, color: C.primary, marginBottom: 6 }}>RECORD-EXTRACTION EVAL</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, lineHeight: 1.25 }}>記録抽出eval：Prompt A vs 強化版B</h1>
          <p style={{ color: C.muted, marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
            各ケースの記録文を2つのプロンプトで抽出し、7フィールドを重み付きで採点。<b style={{ color: C.crit }}>点数が高くても、見逃してはいけない項目を外していれば警告</b>を出す。
          </p>
        </div>

        {/* 実行バー */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
          <button onClick={run} disabled={running}
            style={{ background: running ? C.muted : C.primary, color: "#fff", border: "none", borderRadius: 8,
              padding: "11px 20px", fontSize: 15, fontWeight: 600, cursor: running ? "default" : "pointer" }}>
            {running ? "実行中…" : "1回だけ実行"}
          </button>
          <button onClick={() => runMulti(10)} disabled={running}
            style={{ background: "transparent", color: running ? C.muted : C.primary, border: `1.5px solid ${running ? C.muted : C.primary}`,
              borderRadius: 8, padding: "10px 18px", fontSize: 15, fontWeight: 600, cursor: running ? "default" : "pointer" }}>
            10回連続で実行（ブレを見る）
          </button>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.muted }}>{progress}</span>
        </div>

        {/* 正解データ（JSON）エディタ */}
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, marginBottom: 22, overflow: "hidden" }}>
          <div onClick={() => setShowJson((v) => !v)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer" }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              正解データ（JSON）
              <span style={{ fontFamily: mono, fontSize: 12, color: C.muted, fontWeight: 400, marginLeft: 8 }}>{cases.length} ケース</span>
            </div>
            <span style={{ color: C.muted, fontSize: 13 }}>{showJson ? "閉じる" : "編集する"}</span>
          </div>
          {showJson && (
            <div style={{ borderTop: `1px solid ${C.line}`, padding: 16 }}>
              <p style={{ fontSize: 12.5, color: C.muted, margin: "0 0 10px", lineHeight: 1.6 }}>
                ケースを追加・修正するときは、ここのJSONを編集して「読み込む」を押してください（コード変更は不要）。<br />
                1件の形式：<code style={{ fontFamily: mono }}>{`{ "id", "intent", "record", "truth": { date, kyotaku, care, medical, result, trouble, discrepancy } }`}</code>
              </p>
              <textarea value={casesJson} onChange={(e) => setCasesJson(e.target.value)} spellCheck={false}
                style={{ width: "100%", height: 220, fontFamily: mono, fontSize: 12, lineHeight: 1.5,
                  border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, resize: "vertical", color: C.ink, background: "#FBFCFD" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
                <button onClick={applyJson} disabled={running}
                  style={{ background: C.primary, color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px",
                    fontSize: 14, fontWeight: 600, cursor: running ? "default" : "pointer" }}>読み込む</button>
                <button onClick={() => { setCasesJson(DEFAULT_CASES_JSON); setJsonError(""); }} disabled={running}
                  style={{ background: "transparent", color: C.muted, border: `1px solid ${C.line}`, borderRadius: 8,
                    padding: "9px 16px", fontSize: 14, cursor: running ? "default" : "pointer" }}>元に戻す</button>
                {jsonError
                  ? <span style={{ fontSize: 13, color: C.fn }}>{jsonError}</span>
                  : <span style={{ fontSize: 13, color: C.good }}>✓ {cases.length} ケース 読み込み済み</span>}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div style={{ background: "#FCEEEC", border: `1px solid ${C.fn}`, color: C.fn, borderRadius: 8, padding: "12px 14px", fontSize: 14, marginBottom: 20 }}>{error}</div>
        )}

        {/* 複数回集計 */}
        {multiStats && multiStats.B && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
              {multiStats.B.runs}回連続実行の集計
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
              1回の満点より、平均・最低・ブレの方が正直な実力。{multiStats.failedRuns > 0 ? `（通信エラーで${multiStats.failedRuns}回を除外）` : ""}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
              {[["Prompt A（最小）", multiStats.A], ["Prompt B（強化版）", multiStats.B]].map(([name, s]) => (
                s ? (
                  <div key={name} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.muted, marginBottom: 8 }}>{name}</div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontFamily: mono, fontSize: 36, fontWeight: 700 }}>{s.avg}</span>
                      <span style={{ fontFamily: mono, fontSize: 13, color: C.muted }}>平均</span>
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 13, color: C.muted, marginTop: 4 }}>
                      最低 {s.min}／最高 {s.max}
                    </div>
                    <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600,
                      color: s.cmAvg > 0 ? C.crit : C.good }}>
                      {s.cmAvg > 0 ? "⚠" : "✓"} 重大な見逃し 平均 {s.cmAvg.toFixed(1)} 件/回
                    </div>
                  </div>
                ) : <div key={name} />
              ))}
            </div>

            {/* ケース別の安定性（B） */}
            <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>ケース別の安定性（強化版B）</div>
              <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>「毎回満点」でないケース＝AIの判断が回によってブレる要注意ポイント。</div>
              {cases.map((c) => {
                const st = multiStats.B.perCase[c.id];
                if (!st) return null;
                const stable = st.perfect === st.n;
                return (
                  <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "6px 0", borderBottom: `1px dotted ${C.line}` }}>
                    <span style={{ fontFamily: mono, fontSize: 13, color: C.muted, width: 40 }}>{c.id}</span>
                    <span style={{ fontFamily: mono, fontSize: 13, flex: 1, textAlign: "right", marginRight: 16 }}>
                      平均{st.avg}（{st.min}–{st.max}）
                    </span>
                    <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, width: 96, textAlign: "right",
                      color: stable ? C.good : C.crit }}>
                      {st.perfect}/{st.n}回 満点
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 比較サマリー */}
        {resA && resB && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 22 }}>
              {[["Prompt A（最小）", resA], ["Prompt B（強化版）", resB]].map(([name, r]) => (
                <div key={name} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.muted, marginBottom: 10 }}>{name}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontFamily: mono, fontSize: 40, fontWeight: 700, color: C.ink }}>{r.overall}</span>
                    <span style={{ fontFamily: mono, fontSize: 16, color: C.muted }}>/100</span>
                  </div>
                  <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8,
                    color: r.totalCriticalMisses > 0 ? C.crit : C.good, fontSize: 13, fontWeight: 600 }}>
                    <span style={{ fontFamily: mono, fontSize: 18 }}>{r.totalCriticalMisses > 0 ? "⚠" : "✓"}</span>
                    重大な見逃し {r.totalCriticalMisses} 件
                  </div>
                </div>
              ))}
            </div>

            {/* フィールド別 */}
            <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, marginBottom: 22 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>フィールド別スコア（A → B）</div>
              {Object.keys(FIELD_SPEC).map((k) => {
                const a = resA.fieldAgg[k].avg, b = resB.fieldAgg[k].avg, w = FIELD_SPEC[k].weight;
                return (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                    <div style={{ width: 150, fontSize: 13 }}>
                      {FIELD_SPEC[k].label}
                      <span style={{ fontFamily: mono, fontSize: 11, color: C.muted, marginLeft: 6 }}>×{w}</span>
                    </div>
                    <div style={{ flex: 1, height: 8, background: C.chipBg, borderRadius: 4, position: "relative" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${b}%`, background: C.primary, borderRadius: 4 }} />
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 13, width: 92, textAlign: "right", color: C.muted }}>
                      {a} → <b style={{ color: b >= a ? C.good : C.fn }}>{b}</b>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ケース別 */}
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>ケース別（強化版Bの結果）</div>
            {resB.cases.map((c) => {
              const isOpen = open[c.id];
              return (
                <div key={c.id} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
                  <div onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontFamily: mono, fontSize: 13, color: C.muted }}>{c.id}</span>
                      <span style={{ fontFamily: mono, fontSize: 18, fontWeight: 700 }}>{c.scorePct}</span>
                      {c.criticalMisses.length > 0 && (
                        <span style={{ fontSize: 12, color: C.crit, fontWeight: 600 }}>⚠ {c.criticalMisses.join("・")}</span>
                      )}
                    </div>
                    <span style={{ color: C.muted, fontSize: 13 }}>{isOpen ? "閉じる" : "詳細"}</span>
                  </div>
                  {isOpen && (
                    <div style={{ borderTop: `1px solid ${C.line}`, padding: "12px 16px" }}>
                      <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{cases.find((x) => x.id === c.id)?.record}</div>
                      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, fontFamily: mono }}>各項目：AIの予測 / 正解</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
                        {Object.entries(c.perField).map(([k, f]) => {
                          const ok = f.score === 1;
                          const color = ok ? C.good : f.kind === "FN" ? C.fn : f.kind === "FP" ? C.fp : C.crit;
                          return (
                            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderBottom: `1px dotted ${C.line}`, padding: "3px 0" }}>
                              <span style={{ color: C.muted }}>{f.label}</span>
                              <span style={{ fontFamily: mono, color }}>
                                {String(f.predicted)}
                                <span style={{ color: C.muted }}> / {String(f.truth)}</span>
                                {!ok && f.kind && ` [${f.kind}]`}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {!resA && !running && (
          <div style={{ color: C.muted, fontSize: 14, lineHeight: 1.7, background: C.surface, border: `1px dashed ${C.line}`, borderRadius: 10, padding: 18 }}>
            「1回だけ実行」で1回分の詳細、「10回連続で実行」で平均・最低・ブレを確認できます（現在 {cases.length} ケース × 2プロンプト）。<br />
            ※ ケースを追加・修正するときは「正解データ（JSON）」を開いて編集し、「読み込む」を押してください。コードを触る必要はありません。
          </div>
        )}
      </div>
    </div>
  );
}
