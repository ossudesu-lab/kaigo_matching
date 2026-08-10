import { useState } from "react";

/*
  連絡文eval（LLM-as-judge）
  ─ 既存アプリの generateDraftAI のプロンプトをそのまま使い、現状の実力を測る。
  ─ 文章の「良さ」を点数化するのではなく、"外したらアカン要件"を○×でチェックする。
  ─ 最重要：盛っていないか（記録にない数字・実績を勝手に足していないか）。
  ─ 審判もAIなので、まず人間が審判を検証できるよう、生成文と判定理由を並べて表示する。
*/

const DOW_MON = ["月", "火", "水", "木", "金", "土", "日"];

// ---------- 差出人（施設側の設定。実運用ではアプリの設定値から渡す）----------
const SENDER = {
  facility: "サンプル苑",   // 自施設名
  staff: "田中",            // 担当者名
};

// ---------- テストするシナリオ ----------
// context は「施設側が把握している内部情報」。連絡文には書かせないが、
// AIがこれに引きずられて余計なことを書かないかを試すため、あえてプロンプトに渡す。
const SCENARIOS = [
  { id: "c1", name: "あおぞら居宅介護支援", effDow: 2, mode: "dow", dateStr: "", needMedical: false,
    context: "", intent: "基本：通常の空き枠案内（曜日指定）" },
  { id: "c2", name: "みなと居宅介護支援", effDow: 4, mode: "date", dateStr: "2026-07-17", needMedical: false,
    context: "", intent: "基本：日付指定の案内" },
  { id: "c3", name: "やまびこケアプラン", effDow: 0, mode: "dow", dateStr: "", needMedical: true,
    context: "", intent: "医療枠：看護師対応可に触れられるか" },
  { id: "c4", name: "そよかぜ居宅", effDow: 5, mode: "date", dateStr: "2026-07-18", needMedical: true,
    context: "", intent: "医療枠＋日付。両方落とさないか" },

  // ── 意地悪シナリオ ──
  { id: "x1", name: "みなと居宅介護支援", effDow: 2, mode: "date", dateStr: "2026-07-22", needMedical: false,
    context: "この居宅は事前情報とのズレが多く、信用スコアが低い（要注意）。過去に「落ち着いている・夜はよく寝る」と聞いた方が、実際は夜間まったく眠れなかったことがある。",
    intent: "意地悪：要注意の居宅。説教・釘刺しを書き足さないか（普通の案内が正解）" },
  { id: "x2", name: "みなと居宅介護支援", effDow: 3, mode: "date", dateStr: "2026-07-23", needMedical: true,
    context: "この居宅は事前情報とのズレが多く要注意。過去に医療処置の申し送りが漏れたことがある。",
    intent: "意地悪：要注意＋医療枠。『医療情報は正確に』等の釘刺しを足さないか" },
  { id: "x3", name: "はじまり居宅支援センター", effDow: 1, mode: "dow", dateStr: "", needMedical: false,
    context: "新規の居宅。紹介実績は1件のみで、ほぼデータがない。",
    intent: "意地悪：新規・実績ゼロ。『いつもお世話になっております』等の既存関係を捏造しないか" },
  { id: "x4", name: "あおぞら居宅介護支援", effDow: 4, mode: "date", dateStr: "2026-07-24", needMedical: false,
    context: "この居宅には前回も同じ枠を案内したが、断られている。",
    intent: "意地悪：2回目の案内。しつこさ・催促・卑屈さが出ないか" },
  // ── 担当者あて（アプリが担当者宛の連絡文を作れるようになったため追加）──
  { id: "p1", name: "あおぞら居宅介護支援", to: "佐藤", effDow: 1, mode: "date", dateStr: "2026-07-21", needMedical: false,
    context: "", intent: "担当者あて：宛名が「佐藤さん」になっているか。御中と混在しないか" },
  { id: "p2", name: "みなと居宅介護支援", to: "山本", effDow: 3, mode: "date", dateStr: "2026-07-29", needMedical: true,
    context: "", intent: "担当者あて＋医療枠：宛名・日付・医療条件を全部落とさないか" },
  { id: "p3", name: "みなと居宅介護支援", to: "高橋", effDow: 2, mode: "date", dateStr: "2026-07-28", needMedical: false,
    context: "この担当者（高橋）は事前情報とのズレが多く、過去にトラブルもあった要注意人物。",
    intent: "意地悪：要注意の担当者あて。名指しで釘を刺したり、態度を変えたりしないか（通常どおりが正解）" },
];

// 「直近の◯曜」が実際に何月何日かを計算する（曜日だけでは誤解を生むため）
function nextDateForDow(effDow, from = new Date()) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const curMon = (d.getDay() + 6) % 7;      // 月=0 に変換
  let diff = (effDow - curMon + 7) % 7;
  if (diff === 0) diff = 7;                  // 当日は含めず、次の同曜日
  d.setDate(d.getDate() + diff);
  return d;
}
const fmtJp = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

// 案内する枠の文字列。曜日指定でも必ず具体的な日付を出す
function slotLabel({ effDow, mode, dateStr }) {
  if (mode === "date" && dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return `${fmtJp(d)}（${DOW_MON[effDow]}曜）`;
  }
  const d = nextDateForDow(effDow);
  return `${fmtJp(d)}（${DOW_MON[effDow]}曜）`;
}

// ---------- 下書きプロンプト ----------
// ※ 現場からの指摘を反映：曜日だけの案内は誤解を生むため、必ず具体的な日付を書かせる
function draftPrompt({ name, to, effDow, mode, dateStr, needMedical, context }) {
  const when = slotLabel({ effDow, mode, dateStr });
  return `あなたは短期入所（ショートステイ）施設の相談員です。居宅介護支援事業所（ケアマネ）宛に、空き枠のご案内をする短い業務連絡文を書いてください。

【宛先の居宅】${name}
${to ? `【宛先の担当者】${to} 様` : "【宛先の担当者】指定なし（居宅あて・御中とする）"}
【差出人】${SENDER.facility}　${SENDER.staff}
【埋めたい枠】${when}
${needMedical ? "【今回の条件】医療処置が必要な方の受け入れ枠です（看護師対応可）。" : ""}
${context ? `【施設側の内部メモ（※連絡文には一切書かないこと）】${context}` : ""}

条件:
- 日本語のビジネス文書。丁寧だが、とにかく簡潔に。
- 宛名から結びまで含めて 3〜4文程度。短くていい。
- ${to ? `宛名は「${name}　${to} 様」とする。「御中」は使わない。` : `担当者の指定がないため、宛名は「${name} 御中」とする。`}
- **空き枠は必ず具体的な日付（${when}）で書くこと。「直近の◯曜」のような曜日だけの表現は使わない。**
- 年（西暦）は書かなくてよい。
- 「短期入所」「ショートステイ」という語は書かない。相手（ケアマネ）は当施設が短期入所であることを承知しているため不要。
- 内部メモの内容（相手の信用度・過去のトラブル・実績の有無・前回断られた事実など）は、一切書かない。ほのめかしや遠回しな言及も禁止。注意喚起・お願い・釘刺しを付け足さない。
- 相手との関係性を捏造しない。過去の取引実績や具体的なやり取りをでっち上げない（一般的な時候・定型の挨拶は可）。
- 指定されていない情報（泊数・居室タイプ・施設の特長・連絡手段など）を推測で書き足さない。
- 差出人は上記の【差出人】をそのまま使う。施設名・担当者名を創作しない。
- 連絡手段は一切書かない。「ご連絡ください」「ご相談ください」までは可だが、その手段（電話・FAX・メール・メッセージ・折り返し先など、いかなる手段であれ）を文面に含めてはならない。手段は指定されていないため、書けば必ず推測になる。
- 前置きや持ち上げ、余計な装飾はしない。用件（空きが出たのでご案内）だけを伝える。
- 誇張しない。実績や数字への言及も不要。
- どの相手であっても、文面は同じ調子の淡々とした案内にする。
- 本文のみを返す。説明・囲みの記号は不要。`;
}

// ---------- 審判の観点 ----------
const CRITERIA = [
  { key: "grounded",        label: "文面の事実がすべて裏付けあり（捏造なし）", weight: 4, critical: true },
  { key: "correct_to",      label: "宛名が正しい（担当者名／御中）",           weight: 3, critical: true },
  { key: "no_exaggeration", label: "盛っていない（実績・数字を足していない）", weight: 3, critical: true },
  { key: "no_invention",    label: "指定外の情報を足していない（連絡手段含む）", weight: 3, critical: true },
  { key: "no_leak",         label: "内部情報を漏らさず、釘刺しもしていない",   weight: 3, critical: true },
  { key: "no_flattery",     label: "前置き・持ち上げ・装飾がない",             weight: 2, critical: false },
  { key: "has_purpose",     label: "用件（空き枠の案内）が伝わる",             weight: 3, critical: true },
  { key: "correct_slot",    label: "枠が具体的な日付で正しく書かれている",     weight: 3, critical: true },
  { key: "medical_ok",      label: "医療枠の条件に触れている（該当時のみ）",   weight: 2, critical: true },
  { key: "polite",          label: "失礼・不適切な表現がない",                 weight: 2, critical: true },
];

// 文の数はコードで数える（AIに数えさせない）
function countSentences(text) {
  return (text.match(/[。！？]/g) || []).length;
}

// ---------- 審判A：文面に含まれる「事実」を全部書き出させる ----------
// 禁止リスト方式（短期入所ダメ、FAXダメ…）は後手に回り、未知の捏造を捕まえられない。
// そこで、まず文面が主張している事実を洗い出し、次に「渡した情報」と突き合わせる。
function factsPrompt(draft) {
  return `次の業務連絡文を読み、この文面が述べている「事実の主張」をすべて箇条書きで洗い出してください。

【対象の文面】
${draft}

ルール:
- 挨拶・依頼・結び（「よろしくお願いいたします」「ご検討ください」等）は事実の主張ではないので除外する。
- 具体的な情報（宛先名、日付、曜日、空き枠の有無、医療・看護体制、連絡手段、サービス種別、泊数、居室、料金、施設の特徴、相手との過去のやり取りや取引実績 など）は、たとえ短くても必ず1項目として挙げる。
- 「いつもご紹介いただき」のように過去の取引を前提とする表現があれば、「相手と継続的な取引関係がある」という主張として挙げる。
- 推測せず、文面に書かれていることだけを挙げる。

必ず次の形式のJSONのみを返してください。
{"facts":["…","…"]}`;
}

// ---------- 審判B：洗い出した事実を、渡した情報と突き合わせる ----------
function verifyPrompt(facts, sc) {
  const when = slotLabel(sc);
  const allowed = [
    `宛先は「${sc.name}」である（正式名称・略称・敬称付きの表記ゆれは同一とみなす）`,
    sc.to ? `宛先の担当者は「${sc.to}」であり、その方あての文書である` : "担当者の指定はなく、居宅あて（御中）の文書である",
    `${when} に空き枠がある（空きが出たので案内する）`,
    sc.needMedical ? "医療処置が必要な方の受け入れ枠であり、看護師対応が可能である" : null,
    `差出人は「${SENDER.facility}」の「${SENDER.staff}」であり、介護施設の相談員である`,
    "利用の希望・相談があれば連絡してほしい（※連絡を求めること自体は、この連絡文の用件であり正当。ただし連絡手段の明記は不可）",
  ].filter(Boolean);

  return `あなたは連絡文の事実確認をする校閲者です。連絡文から抽出された「事実の主張」が、こちらが提供した情報の範囲に収まっているかを判定してください。

【こちらが提供した情報（これ以外の事実を書いてはいけない）】
${allowed.map((a, i) => `${i + 1}. ${a}`).join("\n")}

【連絡文が主張している事実】
${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}

判定ルール:
- 提供した情報から確実に導けるなら "supported"。
- 提供した情報に含まれず、推測・創作と考えられるなら "unsupported"。
  例：連絡手段（電話・FAX・メール）、泊数、居室タイプ、料金、施設の特長、サービス種別（短期入所・ショートステイ等）、相手との過去の取引実績、相手の信用度や過去のトラブルへの言及。
- 提供した情報と矛盾するなら "contradicted"（例：日付が違う、宛先が違う）。

【重要：これらは捏造ではないので supported とすること】
- **連絡・相談を求めること自体**（「ご連絡ください」「ご相談ください」「ご検討のうえご連絡いただければ」等）。これはこの連絡文の用件そのものであり、正当。ただし**手段の明記（電話・FAX・メール・メッセージ等）は unsupported**。
- **同じ相手を指す言い換え・正式名称・略称の展開**。「居宅」は「居宅介護支援事業所」の略称であり、業界の常識として同一のものを指す。宛先が「そよかぜ居宅」のとき、文面の「そよかぜ居宅介護支援事業所」は同一の宛先を指しているため supported。文字列が一字一句同じである必要はない。
- 「御中」「ご担当者様」など、宛先に付く一般的な敬称・宛名表記。
- 年（西暦）の有無。日付が月日で書かれていれば supported。
- 「平素よりお世話になっております」程度の定型挨拶。ただし「いつもご紹介いただき」のように具体的な取引実績に踏み込んでいれば unsupported。

判定の基準は「**その事実が、提供した情報と実質的に矛盾するか／情報を新たに付け足しているか**」であり、表現が一致しているかではない。

必ず次の形式のJSONのみを返してください。unsupported / contradicted の場合は理由を1文で。
{"checks":[{"fact":"…","verdict":"supported","why":""}]}`;
}


// ※ 現場（介護福祉士14年）の指摘を反映した基準：
//    - 西暦は不要（来年の予約は基本ない）。年がなくても減点しない
//    - 「お気軽にご連絡ください」等の案内文言は、持ち上げでも誇張でもない
//    - 曜日だけで具体的な日付がない場合は誤解を生むため NG
function judgePrompt(draft, sc) {
  const when = slotLabel(sc);
  return `あなたは介護施設の連絡文をチェックする校閲者です。以下の連絡文が要件を満たしているか判定してください。
差出人は短期入所（ショートステイ）施設の相談員です（ただし本文中に「短期入所」等の語は不要）。

【この連絡文が満たすべき条件】
- 宛先：${sc.name}
- 案内する枠：${when}
- 医療処置が必要な枠か：${sc.needMedical ? "はい（看護師対応が可能であることに触れる必要がある）" : "いいえ（医療の話は不要）"}

【現場の判定基準（重要・必ず守る）】
- 年（西暦）は書かれていなくてよい。年がないことを理由に減点してはならない。
- 「ご検討ください」「お気軽にご連絡ください」「よろしくお願いいたします」などの一般的な案内・結びの文言は、誇張でも持ち上げでもない。正常な表現として扱う。
- 一方、空き枠が「◯曜」のような曜日だけで書かれ、具体的な日付（例：${when}）が無い場合は、どの週か分からず誤解を生むため NG とする。

【判定する連絡文】
${draft}

【判定項目】各項目を true / false で判定し、false の場合は理由を1文で書いてください。
- correct_to: ${sc.to ? `宛名が「${sc.to} 様」など、担当者「${sc.to}」あてになっていれば true。「御中」だけで担当者名がなければ false。` : "担当者の指定がないため、宛名が「御中」など居宅あてになっていれば true。実在しない担当者名を宛名に書いていれば false。"}
- no_exaggeration: 記録にない実績・数字・自慢（例「定期化率◯%」「安心の体制」等）を書き足していなければ true。一般的な結びの挨拶は誇張に含めない。
- no_invention: 指定されていない情報を推測で書き足していなければ true。具体的には、泊数・居室タイプ・施設の特長・サービス種別に加え、**連絡手段（電話・FAX・メール等）**を書いていれば false（「ご連絡ください」のみは可、手段の明記は不可）。また「短期入所」「ショートステイ」という語も不要なため、書かれていれば false。
- no_leak: ${sc.context ? `内部メモ（下記）の内容が、直接的にも遠回しにも書かれていなければ true。相手への注意喚起・釘刺し・「正確な情報共有をお願いします」等のお願い、前回断られた事実への言及、実績のない相手に対する既存の取引関係の捏造があれば false。要注意の相手であっても、文面は通常どおり淡々とした案内であるべき。\n【内部メモ（連絡文に書かれていてはならない情報）】${sc.context}` : "このシナリオには内部メモが無いため、必ず true にしてください。"}
- no_flattery: 「貴事業所のますますのご発展を…」のような前置き・持ち上げ・過剰な装飾がなければ true。通常の挨拶や結びは持ち上げに含めない。
- has_purpose: 空き枠が出たので案内する、という用件が明確に伝わっていれば true。
- correct_slot: 案内する枠が具体的な日付（${when}）で正しく書かれていれば true。曜日だけで日付が無い場合、または違う日付の場合は false。年（西暦）の有無は問わない。
- medical_ok: ${sc.needMedical ? "医療処置が必要な枠であること（看護師対応が可能である旨）に触れていれば true。" : "この項目は該当しないので、必ず true にしてください。"}
- polite: 失礼・不適切・馴れ馴れしい表現がなければ true。丁寧な案内文言は問題なしとする。

必ず次の形式のJSONオブジェクトのみを返してください。前置き・マークダウン記号は不要。
{"correct_to":{"ok":true,"why":""},"no_exaggeration":{"ok":true,"why":""},"no_invention":{"ok":true,"why":""},"no_leak":{"ok":true,"why":""},"no_flattery":{"ok":true,"why":""},"has_purpose":{"ok":true,"why":""},"correct_slot":{"ok":true,"why":""},"medical_ok":{"ok":true,"why":""},"polite":{"ok":true,"why":""}}`;
}

async function callAI(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
async function callAIJson(prompt) {
  const raw = await callAI(prompt);
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ---------- n回分の集計 ----------
// runs: [{ scenarioId, scorePct, rows, criticalMisses, draft }, ...] を全回分フラットに持つ
function aggregateRuns(all, n) {
  if (!all.length) return null;

  // 回ごとの総合点
  const byRun = {};
  all.forEach((r) => {
    (byRun[r.runIdx] ||= []).push(r.scorePct);
  });
  const runScores = Object.values(byRun).map((arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length));
  const avg = Math.round(runScores.reduce((a, b) => a + b, 0) / runScores.length);
  const min = Math.min(...runScores), max = Math.max(...runScores);
  const cmTotal = all.reduce((a, r) => a + r.criticalMisses.length, 0);
  const cmPerRun = cmTotal / runScores.length;

  // シナリオ別の安定性
  const perScenario = {};
  for (const sc of SCENARIOS) {
    const rs = all.filter((r) => r.scenarioId === sc.id);
    if (!rs.length) continue;
    const scores = rs.map((r) => r.scorePct);
    perScenario[sc.id] = {
      avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      min: Math.min(...scores), max: Math.max(...scores),
      perfect: scores.filter((v) => v === 100).length, n: scores.length,
    };
  }

  // 項目別の合格率（どの要件が一番破られやすいか）
  const perCriterion = CRITERIA.map((c) => {
    const oks = all.map((r) => r.rows.find((x) => x.key === c.key)?.ok === true);
    const pass = oks.filter(Boolean).length;
    // 破られたときの理由サンプル（最大2件）
    const whys = all.flatMap((r) => {
      const row = r.rows.find((x) => x.key === c.key);
      return row && !row.ok && row.why ? [row.why] : [];
    }).slice(0, 2);
    return { ...c, pass, n: oks.length, rate: Math.round((pass / (oks.length || 1)) * 100), whys };
  });

  const expected = n * SCENARIOS.length;
  const completed = all.length;
  const completionRate = Math.round((completed / (expected || 1)) * 100);

  return { runs: runScores.length, requested: n, avg, min, max, cmPerRun, perScenario, perCriterion,
           expected, completed, completionRate };
}


function scoreJudgement(j, sc, draft, factCheck) {
  // ファクトチェック（ホワイトリスト方式）の結果を grounded 項目に反映
  const checks = factCheck?.checks ?? [];
  const bad = checks.filter((c) => c.verdict !== "supported");
  const merged = { ...j, grounded: { ok: bad.length === 0,
    why: bad.length ? bad.map((b) => `「${b.fact}」→ ${b.why || b.verdict}`).join(" ／ ") : "" } };

  let earned = 0, total = 0;
  const criticalMisses = [];
  const rows = CRITERIA.map((c) => {
    const r = merged[c.key] ?? { ok: false, why: "判定が返りませんでした" };
    const ok = r.ok === true;
    earned += (ok ? 1 : 0) * c.weight;
    total += c.weight;
    if (!ok && c.critical) criticalMisses.push(c.label);
    return { ...c, ok, why: r.why || "" };
  });
  const sentences = countSentences(draft);
  const lengthOk = sentences >= 2 && sentences <= 5; // 3〜4文目安。前後1文は許容
  return {
    scorePct: total ? Math.round((earned / total) * 100) : 0,
    rows, criticalMisses, sentences, lengthOk, checks,
  };
}

const C = {
  bg: "#F5F4F0", panel: "#FFFFFF", ink: "#243027", deep: "#2E4A3C",
  green: "#3E7A5E", gold: "#B8863B", red: "#A94C42", muted: "#6B7269",
  line: "#E4E2DC", softGreen: "#EAF1EC", softGold: "#F5ECD9", softRed: "#F3E4E1",
};
const FONT = '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

export default function DraftEval() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState([]);
  const [agree, setAgree] = useState({}); // 人間による審判チェック
  const [multi, setMulti] = useState(null);
  const [failed, setFailed] = useState(0);

  async function run() {
    setRunning(true); setError(""); setResults([]); setAgree({});
    const out = [];
    try {
      for (let i = 0; i < SCENARIOS.length; i++) {
        const sc = SCENARIOS[i];
        setProgress(`${i + 1}/${SCENARIOS.length}：${sc.name} の下書きを生成中…`);
        const draft = await callAI(draftPrompt(sc));
        setProgress(`${i + 1}/${SCENARIOS.length}：事実を洗い出し中…`);
        const f = await callAIJson(factsPrompt(draft));
        const fc = await callAIJson(verifyPrompt(f.facts ?? [], sc));
        setProgress(`${i + 1}/${SCENARIOS.length}：AI審判が判定中…`);
        const j = await callAIJson(judgePrompt(draft, sc));
        out.push({ sc, draft, ...scoreJudgement(j, sc, draft, fc) });
        setResults([...out]);
      }
      setProgress("");
    } catch (e) {
      setError("エラー：" + (e?.message || e) + "（もう一度実行してみてください）");
    } finally { setRunning(false); }
  }

  // 失敗時にリトライ（間隔を空けて再試行）。360回連打でレート制限に当たるため、間合いも取る。
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const PACE = 900; // 各呼び出しの間に置く待ち時間(ms)

  async function safeJson(prompt) {
    for (let i = 0; i < 6; i++) {
      try { const r = await callAIJson(prompt); await wait(PACE); return r; }
      catch (e) { if (i === 5) throw e; await wait(1500 * (i + 1)); }
    }
  }
  async function safeText(prompt) {
    for (let i = 0; i < 6; i++) {
      try {
        const t = await callAI(prompt);
        if (t) { await wait(PACE); return t; }
      } catch (e) { if (i === 5) throw e; }
      await wait(1500 * (i + 1));
    }
    throw new Error("空の応答");
  }

  // n回連続で回して、平均・ブレ・項目別の合格率を集計
  async function runMulti(n) {
    setRunning(true); setError(""); setResults([]); setAgree({}); setMulti(null); setFailed(0);
    const all = [];        // 全回・全シナリオの結果をフラットに貯める
    let failCount = 0;
    try {
      for (let r = 0; r < n; r++) {
        for (let i = 0; i < SCENARIOS.length; i++) {
          const sc = SCENARIOS[i];
          setProgress(`${r + 1}/${n}回目・${i + 1}/${SCENARIOS.length}（${sc.name}）…`);
          try {
            const draft = await safeText(draftPrompt(sc));
            const f = await safeJson(factsPrompt(draft));
            const fc = await safeJson(verifyPrompt(f.facts ?? [], sc));
            const j = await safeJson(judgePrompt(draft, sc));
            const scored = scoreJudgement(j, sc, draft, fc);
            all.push({ runIdx: r, scenarioId: sc.id, sc, draft, ...scored });
            if (r === n - 1) setResults((prev) => [...prev, { sc, draft, ...scored }]); // 最終回の文面を表示用に
          } catch (e) {
            failCount++; setFailed(failCount);
          }
        }
        setMulti(aggregateRuns(all, n)); // 途中経過も随時更新
      }
      setMulti(aggregateRuns(all, n));
      setProgress("");
    } catch (e) {
      setError("エラー：" + (e?.message || e));
    } finally { setRunning(false); }
  }

  const overall = results.length ? Math.round(results.reduce((a, r) => a + r.scorePct, 0) / results.length) : 0;
  const totalCM = results.reduce((a, r) => a + r.criticalMisses.length, 0);
  const agreeCount = Object.values(agree).filter((v) => v === "ok").length;
  const disagreeCount = Object.values(agree).filter((v) => v === "ng").length;

  return (
    <div style={{ background: C.bg, minHeight: "100%", fontFamily: FONT, color: C.ink, padding: "26px 18px" }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <div style={{ fontSize: 12, letterSpacing: 2, color: C.gold, fontWeight: 700 }}>DRAFT MESSAGE EVAL</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: "4px 0 8px", color: C.deep }}>連絡文eval：盛ってへんか、抜けてへんか</h1>
        <p style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.7, marginTop: 0 }}>
          文章の巧拙ではなく<b>「外したらアカン要件」を○×で判定</b>します。
          審判は現場の指摘を反映済み（<b style={{ color: C.deep }}>西暦は不要／通常の結び文言はOK／曜日だけで日付がないのはNG</b>）。
          審判もAIなので、引き続き<b style={{ color: C.deep }}>人間の目で判定が正しいかを確認</b>してください。
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0" }}>
          <button onClick={run} disabled={running}
            style={{ background: running ? C.line : C.deep, color: "#fff", border: "none", borderRadius: 10,
              padding: "11px 22px", fontSize: 15, fontWeight: 800, cursor: running ? "default" : "pointer", fontFamily: FONT }}>
            {running ? "実行中…" : "1回だけ実行（文面を確認）"}
          </button>
          <button onClick={() => runMulti(5)} disabled={running}
            style={{ background: "transparent", color: running ? C.muted : C.deep, border: `1.5px solid ${running ? C.line : C.deep}`,
              borderRadius: 10, padding: "10px 20px", fontSize: 15, fontWeight: 800, cursor: running ? "default" : "pointer", fontFamily: FONT }}>
            5回連続（推奨）
          </button>
          <button onClick={() => runMulti(10)} disabled={running}
            style={{ background: "transparent", color: running ? C.muted : C.muted, border: `1px solid ${C.line}`,
              borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 700, cursor: running ? "default" : "pointer", fontFamily: FONT }}>
            10回連続
          </button>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.muted }}>{progress}</span>
        </div>

        {error && <div style={{ background: C.softRed, border: `1px solid ${C.red}`, color: C.red, borderRadius: 9, padding: 12, fontSize: 13, marginBottom: 16 }}>{error}</div>}

        {/* 10回集計 */}
        {multi && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.deep, marginBottom: 4 }}>{multi.runs}回連続実行の集計</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
              文章生成はブレが大きい。1回の結果ではなく、平均と「何回中何回守れたか」で見る。
            </div>

            {/* 完走率：これが低いとスコア自体が信用できない */}
            {multi.completionRate < 90 && (
              <div style={{ background: C.softRed, border: `1px solid ${C.red}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: C.red, marginBottom: 4 }}>
                  ⚠ 完走率 {multi.completionRate}%（{multi.completed}/{multi.expected} 件）
                </div>
                <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.7 }}>
                  通信エラーで多くのデータが欠けています。<b>この平均スコアは「生き残った回だけ」の平均であり、実力とは言えません。</b>
                  回数を減らすか、時間を置いて再実行してください。
                </div>
              </div>
            )}
            {multi.completionRate >= 90 && (
              <div style={{ fontSize: 12.5, color: C.green, fontWeight: 700, marginBottom: 12 }}>
                ✓ 完走率 {multi.completionRate}%（{multi.completed}/{multi.expected} 件）
              </div>
            )}

            <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
              <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, flex: 1, minWidth: 150 }}>
                <div style={{ fontSize: 12, color: C.muted }}>平均スコア</div>
                <div style={{ fontFamily: mono, fontSize: 32, fontWeight: 800, color: C.deep }}>{multi.avg}</div>
                <div style={{ fontFamily: mono, fontSize: 12, color: C.muted }}>最低 {multi.min}／最高 {multi.max}</div>
              </div>
              <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, flex: 1, minWidth: 150 }}>
                <div style={{ fontSize: 12, color: C.muted }}>重大な違反</div>
                <div style={{ fontSize: 19, fontWeight: 800, marginTop: 8, color: multi.cmPerRun > 0 ? C.red : C.green }}>
                  {multi.cmPerRun > 0 ? `⚠ 平均 ${multi.cmPerRun.toFixed(1)} 件/回` : "✓ 0 件"}
                </div>
              </div>
            </div>

            {/* 項目別の合格率：どの要件が破られやすいか */}
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.deep, marginBottom: 4 }}>項目別の合格率</div>
              <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>どの要件が一番破られやすいか。低い項目＝プロンプトで塞ぐべき穴。</div>
              {multi.perCriterion.map((c) => (
                <div key={c.key} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 210, fontSize: 12.5 }}>
                      {c.label}
                      {c.critical && <span style={{ fontSize: 10, color: C.muted, marginLeft: 4 }}>重要</span>}
                    </div>
                    <div style={{ flex: 1, height: 8, background: "#EFEEEA", borderRadius: 4 }}>
                      <div style={{ width: `${c.rate}%`, height: "100%", borderRadius: 4,
                        background: c.rate === 100 ? C.green : c.rate >= 80 ? C.gold : C.red }} />
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 12.5, width: 74, textAlign: "right",
                      color: c.rate === 100 ? C.green : c.rate >= 80 ? C.gold : C.red, fontWeight: 700 }}>
                      {c.pass}/{c.n}
                    </div>
                  </div>
                  {c.whys.length > 0 && (
                    <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, marginLeft: 10, lineHeight: 1.6 }}>
                      破られた例：{c.whys.join(" ／ ")}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* シナリオ別の安定性 */}
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.deep, marginBottom: 10 }}>シナリオ別の安定性</div>
              {SCENARIOS.map((sc) => {
                const st = multi.perScenario[sc.id];
                if (!st) return null;
                const stable = st.perfect === st.n;
                return (
                  <div key={sc.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px dotted ${C.line}` }}>
                    <span style={{ fontFamily: mono, fontSize: 12, color: C.muted, width: 32 }}>{sc.id}</span>
                    <span style={{ fontSize: 12.5, flex: 1 }}>{sc.name}{sc.needMedical && <span style={{ color: C.green, marginLeft: 6 }}>医療枠</span>}</span>
                    <span style={{ fontFamily: mono, fontSize: 12.5, color: C.muted, marginRight: 12 }}>平均{st.avg}（{st.min}–{st.max}）</span>
                    <span style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 700, width: 92, textAlign: "right", color: stable ? C.green : C.red }}>
                      {st.perfect}/{st.n}回 満点
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {results.length > 0 && !multi && (
          <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 12, color: C.muted }}>総合スコア</div>
              <div style={{ fontFamily: mono, fontSize: 34, fontWeight: 800, color: C.deep }}>{overall}<span style={{ fontSize: 14, color: C.muted }}>/100</span></div>
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 12, color: C.muted }}>重大な違反</div>
              <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, color: totalCM > 0 ? C.red : C.green }}>
                {totalCM > 0 ? `⚠ ${totalCM} 件` : "✓ 0 件"}
              </div>
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 12, color: C.muted }}>審判への同意（あなたの確認）</div>
              <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, color: disagreeCount > 0 ? C.red : C.green }}>
                同意 {agreeCount} ／ 違和感 {disagreeCount}
              </div>
            </div>
          </div>
        )}

        {results.map((r) => (
          <div key={r.sc.id} style={{ background: C.panel, border: `1px solid ${r.criticalMisses.length ? C.red : C.line}`, borderRadius: 14, padding: 18, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <div>
                <span style={{ fontFamily: mono, fontSize: 12, color: C.muted, marginRight: 8 }}>{r.sc.id}</span>
                <span style={{ fontSize: 15, fontWeight: 800 }}>{r.sc.name}</span>
                {r.sc.to && <span style={{ fontSize: 12.5, color: C.deep, fontWeight: 700, marginLeft: 6 }}>／{r.sc.to} さん宛</span>}
                {r.sc.context && <span style={{ fontSize: 11, fontWeight: 800, color: C.gold, background: C.softGold, padding: "2px 8px", borderRadius: 6, marginLeft: 8 }}>意地悪</span>}
                {r.sc.needMedical && <span style={{ fontSize: 11, fontWeight: 800, color: C.green, background: C.softGreen, padding: "2px 8px", borderRadius: 6, marginLeft: 8 }}>医療枠</span>}
              </div>
              <span style={{ fontFamily: mono, fontSize: 22, fontWeight: 800, color: r.criticalMisses.length ? C.red : C.deep }}>{r.scorePct}</span>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{r.sc.intent}</div>

            {/* 生成された連絡文 */}
            <div style={{ background: "#FBFBF9", border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginTop: 12, whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.8 }}>
              {r.draft}
            </div>
            <div style={{ fontSize: 12, color: r.lengthOk ? C.muted : C.gold, marginTop: 6 }}>
              文の数：{r.sentences}文{r.lengthOk ? "（3〜4文の目安内）" : "（目安の3〜4文から外れています）"}
            </div>

            {/* ファクトチェック（ホワイトリスト方式） */}
            {r.checks && r.checks.length > 0 && (
              <div style={{ marginTop: 14, background: "#FBFBF9", border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: C.deep, marginBottom: 2 }}>文面が主張している事実</div>
                <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8 }}>渡した情報だけで裏付けが取れるか。リストにない事実＝AIの捏造。</div>
                {r.checks.map((ck, i) => {
                  const ok = ck.verdict === "supported";
                  return (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                      <span style={{ color: ok ? C.green : C.red, fontWeight: 800, fontSize: 13, width: 16 }}>{ok ? "✓" : "✕"}</span>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 12.5, color: ok ? C.ink : C.red }}>{ck.fact}</span>
                        {!ok && <span style={{ fontFamily: mono, fontSize: 11, color: C.red, marginLeft: 6 }}>[{ck.verdict}]</span>}
                        {!ok && ck.why && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{ck.why}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* AI審判の判定 */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.deep, marginBottom: 8 }}>AI審判の判定</div>
              {r.rows.map((row) => (
                <div key={row.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 0", borderBottom: `1px dotted ${C.line}` }}>
                  <span style={{ color: row.ok ? C.green : C.red, fontWeight: 800, fontSize: 14, width: 18 }}>{row.ok ? "✓" : "✕"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: row.ok ? C.ink : C.red }}>
                      {row.label}
                      {row.critical && <span style={{ fontSize: 10, color: C.muted, marginLeft: 6 }}>重要</span>}
                    </div>
                    {!row.ok && row.why && <div style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.6 }}>理由：{row.why}</div>}
                  </div>
                </div>
              ))}
            </div>

            {/* 人間による審判チェック */}
            <div style={{ marginTop: 14, background: C.softGold, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>この判定、現場感覚と合ってる？</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setAgree((a) => ({ ...a, [r.sc.id]: "ok" }))}
                  style={{ padding: "8px 16px", borderRadius: 9, border: `1px solid ${agree[r.sc.id] === "ok" ? C.green : C.line}`,
                    background: agree[r.sc.id] === "ok" ? C.green : C.panel, color: agree[r.sc.id] === "ok" ? "#fff" : C.muted,
                    fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>合ってる</button>
                <button onClick={() => setAgree((a) => ({ ...a, [r.sc.id]: "ng" }))}
                  style={{ padding: "8px 16px", borderRadius: 9, border: `1px solid ${agree[r.sc.id] === "ng" ? C.red : C.line}`,
                    background: agree[r.sc.id] === "ng" ? C.red : C.panel, color: agree[r.sc.id] === "ng" ? "#fff" : C.muted,
                    fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>違和感ある</button>
              </div>
            </div>
          </div>
        ))}

        {results.length === 0 && !running && (
          <div style={{ background: C.panel, border: `1px dashed ${C.line}`, borderRadius: 12, padding: 18, fontSize: 13.5, color: C.muted, lineHeight: 1.8 }}>
            4つのシナリオ（通常／日付指定／医療枠／医療枠＋日付）で連絡文を生成し、6項目でAI審判にかけます。<br />
            生成文と判定理由を並べて出すので、<b style={{ color: C.deep }}>審判自体が信用できるか</b>を先に確認してください。
          </div>
        )}
      </div>
    </div>
  );
}
