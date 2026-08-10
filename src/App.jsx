import React, { useState, useEffect, useMemo } from "react";

const C = {
  bg: "#F5F4F0", panel: "#FFFFFF", ink: "#243027", deep: "#2E4A3C",
  green: "#3E7A5E", gold: "#B8863B", red: "#A94C42", muted: "#6B7269",
  line: "#E4E2DC", softGreen: "#EAF1EC", softGold: "#F5ECD9", softRed: "#F3E4E1",
};
const FONT = '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';

const DOW_MON = ["月", "火", "水", "木", "金", "土", "日"];
const DOW_SUN = ["日", "月", "火", "水", "木", "金", "土"];
const jsToMon = (d) => (d === 0 ? 6 : d - 1);

const CARE_LEVELS = [
  { label: "要支援1", num: 1 }, { label: "要支援2", num: 2 },
  { label: "要介護1", num: 3 }, { label: "要介護2", num: 4 },
  { label: "要介護3", num: 5 }, { label: "要介護4", num: 6 }, { label: "要介護5", num: 7 },
];
const careNum = (label) => (CARE_LEVELS.find((c) => c.label === label)?.num ?? 0);
const numToLabel = (n) => CARE_LEVELS.find((c) => c.num === Math.round(n))?.label ?? "—";

const STORAGE_KEY = "usage-records-v1";
const SENDER_KEY = "sender-settings-v1"; // 記録とは別に保存（記録を全消ししても施設情報は残す）
const NO_STAFF = "（担当者未記入）"; // 古い記録の互換用

const SAMPLE = [
  { id: "s1", date: "2026-06-04", kyotaku: "あおぞら居宅介護支援", staff: "佐藤", care: "要介護3", medical: false, result: "regular", trouble: false, discrepancy: false, memo: "穏やかな方。ご家族の協力も良好。" },
  { id: "s2", date: "2026-06-11", kyotaku: "あおぞら居宅介護支援", staff: "佐藤", care: "要介護2", medical: true, result: "regular", trouble: false, discrepancy: false, memo: "インスリン対応あり。看護師と連携済み。" },
  { id: "s3", date: "2026-06-18", kyotaku: "あおぞら居宅介護支援", staff: "鈴木", care: "要介護3", medical: false, result: "single", trouble: false, discrepancy: true, memo: "事前に聞いていた話と介助量が違った。" },
  { id: "s4", date: "2026-06-05", kyotaku: "みなと居宅介護支援", staff: "高橋", care: "要介護4", medical: false, result: "single", trouble: true, discrepancy: true, memo: "事前の申し送りと様子がかなり違った。夜間の対応が想定より重い。" },
  { id: "s5", date: "2026-06-12", kyotaku: "みなと居宅介護支援", staff: "高橋", care: "要介護3", medical: false, result: "single", trouble: false, discrepancy: true, memo: "穏やかと聞いていたが介助量が多め。" },
  { id: "s6", date: "2026-06-13", kyotaku: "みなと居宅介護支援", staff: "山本", care: "要介護2", medical: true, result: "regular", trouble: false, discrepancy: false, memo: "痰吸引あり。事前情報も正確。落ち着いている。" },
  { id: "s7", date: "2026-06-20", kyotaku: "みなと居宅介護支援", staff: "山本", care: "要介護3", medical: false, result: "regular", trouble: false, discrepancy: false, memo: "事前情報どおり。連携しやすい。" },
  { id: "s8", date: "2026-06-27", kyotaku: "やまびこケアプラン", staff: "中村", care: "要介護2", medical: true, result: "regular", trouble: false, discrepancy: false, memo: "看護師常駐日で対応。落ち着いている。" },
  { id: "s9", date: "2026-06-19", kyotaku: "あおぞら居宅介護支援", staff: "鈴木", care: "要介護2", medical: false, result: "watch", trouble: true, discrepancy: false, memo: "事前の電話連絡なし。提供表に予約が入っていて、送られてきて発覚。確認の手間がかかった。" },
];

// 記録文の抽出。プロンプト・APIキーはサーバー側（/api/extract）に置く。
// ブラウザからは記録文だけを送り、AIキーは一切露出しない。
async function extractFromText(text) {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error("extract failed: " + res.status);
  const data = await res.json();
  const raw = (data.text || "").trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// 「直近の◯曜」が実際に何月何日かを計算する（曜日だけでは誤解を生むため）
function nextDateForDow(effDow, from = new Date()) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const curMon = (d.getDay() + 6) % 7;
  let diff = (effDow - curMon + 7) % 7;
  if (diff === 0) diff = 7;
  d.setDate(d.getDate() + diff);
  return d;
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtMD = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

// 空き枠の開始日・終了日を計算する。
// 日付モード：開始日はそのまま、終了日は開始日＋泊数。
// 曜日モード：開始日は直近のその曜日、終了日はそこから泊数分。
function calcSlot(effDow, mode, dateStr, nights) {
  const start = mode === "date" && dateStr ? new Date(dateStr + "T00:00:00") : nextDateForDow(effDow);
  const n = Math.max(1, parseInt(nights, 10) || 1);
  const end = addDays(start, n);
  return { start, end, nights: n };
}
// 連絡文・画面表示に使う「◯/◯〜◯/◯」ラベル
function slotLabel(effDow, mode, dateStr, nights) {
  const { start, end } = calcSlot(effDow, mode, dateStr, nights);
  const sameMonth = start.getMonth() === end.getMonth();
  const startLabel = `${fmtMD(start)}（${DOW_MON[jsToMon(start.getDay())]}曜）`;
  const endLabel = sameMonth ? `${end.getDate()}日（${DOW_MON[jsToMon(end.getDay())]}曜）` : `${fmtMD(end)}（${DOW_MON[jsToMon(end.getDay())]}曜）`;
  return `${startLabel}〜${endLabel}`;
}

// 連絡文をAIに書かせる
// ※ 連絡文evalで見つかった問題を反映：
//    ・曜日だけだと誤解を生む → 具体的な日付を渡す
//    ・施設名/担当者名を渡さないとAIが創作する → 差出人を渡す
//    ・連絡手段（電話・FAX等）を勝手に書く → 明示的に禁止
// 連絡文の生成。日付の計算はここ（クライアント）で行い、期間文字列 when を作る。
// プロンプト本体（変更禁止の制約含む）とAPIキーはサーバー側（/api/draft）に置く。
async function generateDraftAI(name, staff, effDow, mode, dateStr, nights, needMedical, sender) {
  const when = slotLabel(effDow, mode, dateStr, nights);
  const res = await fetch("/api/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      staff: staff && staff !== NO_STAFF ? staff : "",
      when,
      needMedical: !!needMedical,
      sender: { facility: sender.facility, staff: sender.staff },
    }),
  });
  if (!res.ok) throw new Error("draft failed: " + res.status);
  const data = await res.json();
  const text = (data.text || "").trim();
  if (!text) throw new Error("empty");
  return text;
}

// 記録の集まりから成績を出す（居宅単位でも担当者単位でも使える）
function calcStats(list) {
  const s = { weekly: [0, 0, 0, 0, 0, 0, 0], count: 0, reg: 0, single: 0, trouble: 0, disc: 0, medical: 0, careSum: 0 };
  const discNotes = [];   // 事前情報とのズレが、実際どんな内容だったか
  const troubleNotes = []; // トラブルが、実際どんな内容だったか
  list.forEach((r) => {
    const d = new Date(r.date + "T00:00:00");
    if (!isNaN(d)) s.weekly[jsToMon(d.getDay())]++;
    s.count++;
    if (r.result === "regular") s.reg++;
    if (r.result === "single") s.single++;
    if (r.trouble) { s.trouble++; troubleNotes.push({ date: r.date, memo: r.memo }); }
    if (r.discrepancy) { s.disc++; discNotes.push({ date: r.date, memo: r.memo }); }
    if (r.medical) s.medical++;
    s.careSum += careNum(r.care);
  });
  const decided = s.reg + s.single;
  return {
    ...s, discNotes, troubleNotes,
    regularRate: decided ? Math.round((s.reg / decided) * 100) : null,
    trust: s.count ? 100 - Math.round((s.disc / s.count) * 100) : 100,
    troubleRate: s.count ? Math.round((s.trouble / s.count) * 100) : 0,
    avgCare: s.count ? s.careSum / s.count : 0,
  };
}

export default function App() {
  const [tab, setTab] = useState("record");
  const [records, setRecords] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [pasteText, setPasteText] = useState("");
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState("");
  const [date, setDate] = useState("");
  const [kyotaku, setKyotaku] = useState("");
  const [staff, setStaff] = useState("");
  const [care, setCare] = useState("要介護3");
  const [medical, setMedical] = useState(false);
  const [result, setResult] = useState("watch");
  const [trouble, setTrouble] = useState(false);
  const [discrepancy, setDiscrepancy] = useState(false);
  const [memo, setMemo] = useState("");

  const [mode, setMode] = useState("dow");
  const [dow, setDow] = useState(3);
  const [dateStr, setDateStr] = useState("");
  const [nights, setNights] = useState(1);
  const [needMedical, setNeedMedical] = useState(false);
  const [draftFor, setDraftFor] = useState(null);   // { kyotaku, staff }
  const [draftText, setDraftText] = useState("");
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sentTo, setSentTo] = useState([]);
  const [openStaff, setOpenStaff] = useState({});

  // 差出人設定（記録とは別保存）
  const [sender, setSender] = useState({ facility: "", staff: "" });
  const [senderOpen, setSenderOpen] = useState(false);
  const [senderSaved, setSenderSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        if (r && r.value) setRecords(JSON.parse(r.value));
      } catch (e) {}
      try {
        const s = await window.storage.get(SENDER_KEY);
        if (s && s.value) setSender(JSON.parse(s.value));
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  const saveSender = async (next) => {
    setSender(next);
    try { await window.storage.set(SENDER_KEY, JSON.stringify(next)); } catch (e) {}
    setSenderSaved(true);
    setTimeout(() => setSenderSaved(false), 1800);
  };
  const senderReady = !!(sender.facility.trim() && sender.staff.trim());

  const persist = async (next) => {
    setRecords(next);
    setSaving(true);
    try { await window.storage.set(STORAGE_KEY, JSON.stringify(next)); } catch (e) {}
    setSaving(false);
  };

  const readPaste = async () => {
    if (!pasteText.trim()) return;
    setReading(true); setReadNote("");
    try {
      const x = await extractFromText(pasteText);
      if (x.date) setDate(x.date);
      if (x.kyotaku) setKyotaku(x.kyotaku);
      if (x.staff) setStaff(x.staff);
      if (x.care && CARE_LEVELS.some((c) => c.label === x.care)) setCare(x.care);
      setMedical(!!x.medical);
      if (["regular", "single", "watch"].includes(x.result)) setResult(x.result);
      setTrouble(!!x.trouble);
      setDiscrepancy(!!x.discrepancy);
      setMemo(x.summary || pasteText.trim());
      setReadNote("AIが下の項目を埋めました。確認して、違うとこだけ直してから登録してください。");
    } catch (e) {
      setReadNote("※ うまく読み取れませんでした。もう一度試すか、下の項目を手で入れてください。");
    }
    setReading(false);
  };

  const addRecord = () => {
    if (!kyotaku.trim()) return;
    const rec = { id: "r" + Date.now(), date: date || new Date().toISOString().slice(0, 10),
      kyotaku: kyotaku.trim(), staff: staff.trim(), care, medical, result, trouble, discrepancy, memo: memo.trim() };
    persist([rec, ...records]);
    setPasteText(""); setReadNote(""); setMemo(""); setTrouble(false); setStaff("");
    setDiscrepancy(false); setMedical(false); setResult("watch");
  };
  const removeRecord = (id) => persist(records.filter((r) => r.id !== id));
  const seed = () => persist([...SAMPLE, ...records]);
  const clearAll = () => persist([]);

  // 居宅ごとの成績 ＋ その中の担当者別の内訳
  const kyotakuData = useMemo(() => {
    const by = {};
    records.forEach((r) => { (by[r.kyotaku] ||= []).push(r); });
    return Object.entries(by).map(([name, list]) => {
      const base = calcStats(list);

      // 担当者別（居宅の中でのみ集計。同姓が別居宅にいても混ざらない）
      const byStaff = {};
      list.forEach((r) => {
        const key = (r.staff && r.staff.trim()) ? r.staff.trim() : NO_STAFF;
        (byStaff[key] ||= []).push(r);
      });
      const staffs = Object.entries(byStaff).map(([sname, slist]) => {
        const st = calcStats(slist);
        const issues = [];
        if (st.trust < 60) issues.push(`事前情報とのズレが多い（${st.disc}/${st.count}件）`);
        if (st.troubleRate >= 30) issues.push(`トラブルが多い（${st.trouble}/${st.count}件）`);
        return {
          name: sname, ...st, issues,
          unknown: sname === NO_STAFF,
          thin: st.count < 3,                        // 少数事例は断定しない
          good: !st.thin && st.trust >= 80 && st.troubleRate <= 12 && (st.regularRate ?? 0) >= 65,
          caution: !st.thin && issues.length > 0,
        };
      }).sort((a, b) => {
        if (a.unknown !== b.unknown) return a.unknown ? 1 : -1; // 未記入は末尾
        return b.count - a.count;
      });

      return { name, ...base, staffs };
    });
  }, [records]);

  const effDow = useMemo(() => {
    if (mode === "date" && dateStr) {
      const d = new Date(dateStr + "T00:00:00");
      if (!isNaN(d)) return jsToMon(d.getDay());
    }
    return dow;
  }, [mode, dateStr, dow]);

  const ranked = useMemo(() => {
    const list = kyotakuData;
    if (list.length === 0) return [];
    const maxWeekly = Math.max(...list.map((k) => k.weekly[effDow]), 1);
    return list.map((k) => {
      const weekdayFit = Math.round((k.weekly[effDow] / maxWeekly) * 100);
      const lowTrouble = 100 - k.troubleRate;
      const rr = k.regularRate ?? 50;
      let score = rr * 0.35 + k.trust * 0.25 + weekdayFit * 0.25 + lowTrouble * 0.15;
      let blocked = false;
      if (needMedical) { if (k.medical === 0) blocked = true; else if (k.medical < 3) score *= 0.6; }
      const smallSample = k.count < 5;
      const reasons = [];
      if (k.weekly[effDow] >= 3) reasons.push(`${DOW_MON[effDow]}曜の紹介が多め（${k.weekly[effDow]}件）`);
      else if (k.weekly[effDow] === 0) reasons.push(`${DOW_MON[effDow]}曜の実績はゼロ（未知数）`);
      else reasons.push(`${DOW_MON[effDow]}曜の実績は${k.weekly[effDow]}件`);
      if (k.regularRate !== null && k.regularRate >= 65) reasons.push(`定期につながりやすい（${k.regularRate}%）`);
      else if (k.regularRate !== null && k.regularRate < 50) reasons.push(`定期化は低め（${k.regularRate}%）`);
      const flags = [];
      if (k.trust < 60) flags.push(`⚠ 事前情報とのズレが多い（信用${k.trust}）。事前確認は念入りに`);
      if (k.troubleRate >= 30) flags.push(`⚠ トラブル率が高め（${k.troubleRate}%）`);
      if (needMedical && blocked) flags.push(`✕ 医療処置の対応実績なし。この枠は難しい`);
      else if (needMedical && k.medical < 3) flags.push(`△ 医療処置の実績が薄い（${k.medical}件）`);
      if (smallSample) flags.push(`ℹ データ少なめ（全${k.count}件）。順位は参考程度`);

      // 担当者の中で、声をかけるならこの人／避けたいこの人
      const best = k.staffs.find((s) => !s.unknown && s.good);
      const worst = k.staffs.find((s) => !s.unknown && s.caution);

      return { ...k, weekdayFit, lowTrouble, score: Math.round(score), blocked, smallSample, reasons, flags, best, worst,
        good: k.trust >= 80 && (k.regularRate ?? 0) >= 65 && k.troubleRate <= 12 };
    }).sort((a, b) => {
      if (a.blocked && !b.blocked) return 1;
      if (!a.blocked && b.blocked) return -1;
      return b.score - a.score;
    });
  }, [kyotakuData, effDow, needMedical]);

  const openDraft = async (kname, sname) => {
    setDraftFor({ kyotaku: kname, staff: sname || "" });
    setConfirming(false); setDraftText(""); setDraftNote(""); setDraftLoading(true);
    try {
      const t = await generateDraftAI(kname, sname, effDow, mode, dateStr, nights, needMedical, sender);
      setDraftText(t); setDraftNote("AIが下書きしました。自由に直せます。");
    } catch (e) {
      const when = slotLabel(effDow, mode, dateStr, nights);
      setDraftText(`${kname} ${sname && sname !== NO_STAFF ? sname + " 様" : "御中"}\n\nいつもお世話になっております。\n${when}に空きが出ましたので、ご案内いたします。\nご相談いただけましたら幸いです。よろしくお願いいたします。\n\n${sender.facility}　${sender.staff}`);
      setDraftNote("※ AIに繋がらなかったので、簡易テンプレで下書きしました。");
    }
    setDraftLoading(false);
  };
  const closeDraft = () => { setDraftFor(null); setConfirming(false); };
  const sentKey = (k, s) => `${k}／${s || "御中"}`;
  const doSend = () => {
    setSentTo((x) => [...x, sentKey(draftFor.kyotaku, draftFor.staff)]);
    setDraftFor(null); setConfirming(false);
  };

  const summarySorted = useMemo(() => [...kyotakuData].sort((a, b) => b.count - a.count), [kyotakuData]);

  if (!loaded) {
    return <div style={{ background: C.bg, minHeight: "100vh", fontFamily: FONT, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted }}>読み込み中…</div>;
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: FONT, color: C.ink }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "24px 18px 48px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 2, color: C.gold, fontWeight: 700 }}>介護 空床マッチング</div>
            <h1 style={{ fontSize: 24, fontWeight: 800, margin: "4px 0 14px", color: C.deep }}>記録が、そのまま声かけにつながる</h1>
          </div>
          <button onClick={() => setSenderOpen((v) => !v)}
            style={{ marginTop: 4, padding: "7px 12px", borderRadius: 9, border: `1px solid ${senderReady ? C.line : C.gold}`,
              background: senderReady ? C.panel : C.softGold, color: senderReady ? C.muted : C.deep,
              fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT, flexShrink: 0 }}>
            {senderReady ? "差出人設定" : "差出人を設定 ⚠"}
          </button>
        </div>

        {/* 差出人設定 */}
        {(senderOpen || !senderReady) && (
          <div style={{ background: C.panel, border: `1px solid ${senderReady ? C.line : C.gold}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.deep, marginBottom: 4 }}>差出人（自施設）の設定</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
              連絡文の差出人に使います。<b>設定しないとAIが施設名・担当者名を勝手に創作します</b>ので、必ず入れてください。
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>施設名</div>
                <input type="text" value={sender.facility} placeholder="例）〇〇苑"
                  onChange={(e) => setSender((s) => ({ ...s, facility: e.target.value }))}
                  style={{ ...inp, minWidth: 200 }} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>担当者名</div>
                <input type="text" value={sender.staff} placeholder="例）田中"
                  onChange={(e) => setSender((s) => ({ ...s, staff: e.target.value }))}
                  style={{ ...inp, minWidth: 140 }} />
              </div>
              <button onClick={() => saveSender(sender)} disabled={!senderReady}
                style={{ padding: "9px 18px", borderRadius: 9, border: "none",
                  background: senderReady ? C.deep : C.line, color: "#fff", fontWeight: 700, fontSize: 13,
                  cursor: senderReady ? "pointer" : "default", fontFamily: FONT }}>保存</button>
              {senderSaved && <span style={{ fontSize: 12, color: C.green, fontWeight: 700 }}>✓ 保存しました</span>}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
          {[["record", "① 記録をためる"], ["match", "② 空きを埋める"]].map(([t, l]) => (
            <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "12px 0", borderRadius: 11,
              border: `1px solid ${tab === t ? C.deep : C.line}`, background: tab === t ? C.deep : C.panel,
              color: tab === t ? "#fff" : C.muted, fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: FONT }}>{l}</button>
          ))}
        </div>

        {tab === "record" ? (
          <>
            <Section title="記録を入れる">
              <div style={{ background: C.softGreen, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.deep, marginBottom: 8 }}>記録の文章を貼って、AIに読み取ってもらう</div>
                <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={4}
                  placeholder="例）6/20 みなと居宅の高橋さんの紹介、要介護4の方。事前は穏やかと聞いていたが夜間の不穏が強く対応が重かった。インスリンあり。定期は様子見。"
                  style={{ ...inp, width: "100%", boxSizing: "border-box", resize: "vertical", lineHeight: 1.6, background: "#fff" }} />
                <button onClick={readPaste} disabled={!pasteText.trim() || reading}
                  style={{ marginTop: 8, padding: "9px 18px", borderRadius: 9, border: "none",
                    background: !pasteText.trim() || reading ? C.line : C.green, color: "#fff", fontWeight: 700, fontSize: 13,
                    cursor: !pasteText.trim() || reading ? "default" : "pointer", fontFamily: FONT }}>
                  {reading ? "AIが読み取り中…" : "AIに読み取ってもらう"}
                </button>
                {readNote && <div style={{ fontSize: 12, color: readNote.startsWith("※") ? C.red : C.deep, marginTop: 8, lineHeight: 1.6 }}>{readNote}</div>}
              </div>

              <Row label="利用日"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inp} /><span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>空なら今日</span></Row>
              <Row label="紹介元の居宅"><input type="text" value={kyotaku} onChange={(e) => setKyotaku(e.target.value)} placeholder="例）あおぞら居宅介護支援" style={{ ...inp, minWidth: 240 }} /></Row>
              <Row label="担当ケアマネ">
                <input type="text" value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="例）佐藤（姓だけでOK）" style={{ ...inp, minWidth: 200 }} />
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>空でも登録できます（居宅の成績にだけ反映されます）</div>
              </Row>
              <Row label="要介護度"><select value={care} onChange={(e) => setCare(e.target.value)} style={inp}>{CARE_LEVELS.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}</select></Row>
              <Row label="医療処置"><Toggle on={medical} set={setMedical} onLabel="あり（看護師対応が必要）" offLabel="なし" /></Row>
              <Row label="結果"><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{[["regular", "定期になった"], ["single", "単発で終わった"], ["watch", "まだ様子見"]].map(([v, l]) => <Chip key={v} on={result === v} onClick={() => setResult(v)}>{l}</Chip>)}</div></Row>
              <Row label="トラブル"><Toggle on={trouble} set={setTrouble} onLabel="あった" offLabel="なし" /></Row>
              <Row label="事前情報とのズレ"><Toggle on={discrepancy} set={setDiscrepancy} onLabel="聞いてた話と違った" offLabel="ズレなし" /></Row>
              <Row label="メモ"><textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} placeholder="現場の様子。貼り付けから読み取ると要約が入ります。" style={{ ...inp, width: "100%", boxSizing: "border-box", resize: "vertical", lineHeight: 1.6 }} /></Row>
              <button onClick={addRecord} disabled={!kyotaku.trim()} style={{ marginTop: 6, padding: "11px 22px", borderRadius: 10, border: "none", background: kyotaku.trim() ? C.deep : C.line, color: "#fff", fontWeight: 800, fontSize: 14, cursor: kyotaku.trim() ? "pointer" : "default", fontFamily: FONT }}>この記録を入れる</button>
              {saving && <span style={{ marginLeft: 10, fontSize: 12, color: C.green }}>保存中…</span>}
            </Section>

            <Section title="居宅の成績（自動計算）">
              {summarySorted.length === 0 ? <Empty onSeed={seed} /> : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {summarySorted.map((s) => {
                    const isOpen = openStaff[s.name];
                    return (
                      <div key={s.name} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 15, fontWeight: 800 }}>{s.name}</span>
                          <span style={{ fontSize: 12, color: C.muted }}>紹介 {s.count}件{s.count < 5 && "（参考程度）"}</span>
                        </div>
                        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10 }}>
                          <Stat label="定期になる率" value={s.regularRate === null ? "—" : s.regularRate + "%"} tone={s.regularRate >= 60 ? "good" : "normal"} />
                          <Stat label="信用（ズレの少なさ）" value={s.trust} tone={s.trust < 60 ? "bad" : "good"} />
                          <Stat label="トラブル率" value={s.troubleRate + "%"} tone={s.troubleRate >= 30 ? "bad" : "normal"} />
                          <Stat label="平均介護度" value={s.avgCare ? s.avgCare.toFixed(1) + `（${numToLabel(s.avgCare)}）` : "—"} />
                          <Stat label="医療処置" value={s.medical + "件"} />
                        </div>
                        <Incidents disc={s.discNotes} trouble={s.troubleNotes} />

                        {/* 担当者別の内訳 */}
                        <button onClick={() => setOpenStaff((o) => ({ ...o, [s.name]: !o[s.name] }))}
                          style={{ marginTop: 12, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.line}`,
                            background: C.panel, color: C.deep, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>
                          {isOpen ? "担当者別を閉じる" : `担当者別を見る（${s.staffs.filter((x) => !x.unknown).length}人）`}
                        </button>
                        {isOpen && (
                          <div style={{ marginTop: 10, borderTop: `1px dashed ${C.line}`, paddingTop: 10 }}>
                            <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.6 }}>
                              同じ居宅でも担当者によって傾向は違います。件数が少ないうちは断定せず、参考程度に。
                            </div>
                            {s.staffs.map((st) => (
                              <div key={st.name} style={{ padding: "8px 0", borderBottom: `1px dotted ${C.line}` }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 13.5, fontWeight: 700, color: st.unknown ? C.muted : C.ink }}>
                                    {st.unknown ? st.name : st.name + " さん"}
                                  </span>
                                  {st.good && <Badge color={C.green} bg={C.softGreen}>優良</Badge>}
                                  {st.caution && <Badge color={C.red} bg={C.softRed}>要注意</Badge>}
                                  {st.thin && !st.unknown && <Badge color={C.muted} bg="#EFEEEA">データ少（{st.count}件）</Badge>}
                                  <span style={{ fontSize: 11.5, color: C.muted, marginLeft: "auto" }}>{st.count}件</span>
                                </div>
                                {!st.unknown && (
                                  <>
                                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
                                      <MiniStat label="定期" value={st.regularRate === null ? "—" : st.regularRate + "%"} />
                                      <MiniStat label="信用" value={st.trust} bad={st.trust < 60} />
                                      <MiniStat label="トラブル" value={st.troubleRate + "%"} bad={st.troubleRate >= 30} />
                                      <MiniStat label="医療" value={st.medical + "件"} />
                                    </div>
                                    <Incidents disc={st.discNotes} trouble={st.troubleNotes} />
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            {records.length > 0 && (
              <Section title="ためた記録">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {records.map((r) => {
                    const d = new Date(r.date + "T00:00:00");
                    const dw = isNaN(d) ? "" : `(${DOW_SUN[d.getDay()]})`;
                    return (
                      <div key={r.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>
                            {r.date}{dw}　{r.kyotaku}
                            {r.staff && <span style={{ color: C.deep }}>／{r.staff} さん</span>}
                          </div>
                          <div style={{ fontSize: 12, color: C.muted, marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <span>{r.care}</span>
                            {r.medical && <span style={{ color: C.green }}>医療処置あり</span>}
                            <span>{r.result === "regular" ? "定期" : r.result === "single" ? "単発" : "様子見"}</span>
                            {r.trouble && <span style={{ color: C.red }}>トラブルあり</span>}
                            {r.discrepancy && <span style={{ color: C.red }}>事前とズレ</span>}
                          </div>
                          {r.memo && <div style={{ fontSize: 12, color: C.ink, marginTop: 4, lineHeight: 1.6 }}>{r.memo}</div>}
                        </div>
                        <button onClick={() => removeRecord(r.id)} style={{ border: "none", background: "transparent", color: C.muted, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>削除</button>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button onClick={seed} style={ghost}>サンプルを足す</button>
                  <button onClick={clearAll} style={{ ...ghost, color: C.red, borderColor: C.softRed }}>全部消す</button>
                </div>
              </Section>
            )}
          </>
        ) : (
          <>
            {kyotakuData.length === 0 ? (
              <Section title="空きを埋める">
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.7 }}>
                    まだ記録がないので、おすすめを出せません。<br />先に「① 記録をためる」で記録を入れてください。
                  </div>
                  <button onClick={() => { seed(); }} style={{ padding: "9px 18px", borderRadius: 9, border: `1px solid ${C.deep}`, background: C.panel, color: C.deep, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>サンプルを入れて試す</button>
                </div>
              </Section>
            ) : (
              <>
                <p style={{ fontSize: 13, color: C.muted, margin: "14px 0", lineHeight: 1.7 }}>
                  埋めたい枠を選ぶと、<b>①で貯めた記録</b>から「声をかける優先順位」を出します。順位は<b>居宅単位</b>ですが、
                  中に<b>担当ケアマネ別の内訳</b>も出るので、誰に連絡するかまで決められます。
                </p>
                <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    {[["dow", "曜日で狙う"], ["date", "日付で狙う"]].map(([m, l]) => (
                      <button key={m} onClick={() => setMode(m)} style={{ flex: 1, padding: "9px 0", borderRadius: 9, border: `1px solid ${mode === m ? C.deep : C.line}`, background: mode === m ? C.deep : C.panel, color: mode === m ? "#fff" : C.muted, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: FONT }}>{l}</button>
                    ))}
                  </div>
                  {mode === "dow" ? (
                    <div>
                      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>埋めたい曜日（開始日）</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {DOW_MON.map((d, i) => (
                          <button key={i} onClick={() => setDow(i)} style={{ width: 44, height: 44, borderRadius: 10, border: `1px solid ${dow === i ? C.gold : C.line}`, background: dow === i ? C.softGold : C.panel, color: dow === i ? C.deep : C.muted, fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: FONT }}>{d}</button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>埋めたい日付（開始日）</div>
                      <input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} style={inp} />
                    </div>
                  )}
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>泊数</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button onClick={() => setNights((n) => Math.max(1, n - 1))}
                        style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.deep, fontWeight: 800, fontSize: 16, cursor: "pointer", fontFamily: FONT }}>−</button>
                      <span style={{ fontSize: 16, fontWeight: 800, color: C.deep, minWidth: 60, textAlign: "center" }}>{nights} 泊</span>
                      <button onClick={() => setNights((n) => Math.min(30, n + 1))}
                        style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.deep, fontWeight: 800, fontSize: 16, cursor: "pointer", fontFamily: FONT }}>＋</button>
                    </div>
                  </div>
                  <div style={{ marginTop: 12, fontSize: 13, color: C.green, fontWeight: 700 }}>
                    {mode === "date" && !dateStr
                      ? <span style={{ color: C.muted, fontWeight: 400 }}>開始日を選んでください</span>
                      : `→ ${slotLabel(effDow, mode, dateStr, nights)} でご案内します`}
                  </div>
                  <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 10 }}>
                    <button onClick={() => setNeedMedical((v) => !v)} style={{ width: 46, height: 26, borderRadius: 13, border: "none", background: needMedical ? C.green : C.line, position: "relative", cursor: "pointer" }}>
                      <span style={{ position: "absolute", top: 3, left: needMedical ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
                    </button>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>医療処置が必要な枠</div>
                      <div style={{ fontSize: 12, color: C.muted }}>ONにすると、処置対応の実績がない居宅は候補から外れます</div>
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {ranked.map((k, idx) => {
                    const rank = k.blocked ? "—" : idx + 1;
                    const isOpen = draftFor?.kyotaku === k.name;
                    return (
                      <div key={k.name} style={{ background: C.panel, border: `1px solid ${isOpen ? C.gold : (k.good ? C.green : C.line)}`, borderRadius: 14, padding: 16, opacity: k.blocked ? 0.55 : 1 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                          <div style={{ minWidth: 40, height: 40, borderRadius: 10, background: idx === 0 && !k.blocked ? C.gold : C.softGreen, color: idx === 0 && !k.blocked ? "#fff" : C.deep, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18 }}>{rank}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 16, fontWeight: 800 }}>{k.name}</span>
                              {k.good && <Badge color={C.green} bg={C.softGreen}>優良</Badge>}
                              {k.trust < 60 && <Badge color={C.red} bg={C.softRed}>要注意</Badge>}
                              {k.smallSample && <Badge color={C.muted} bg="#EFEEEA">データ少</Badge>}
                            </div>
                            <div style={{ fontSize: 13, color: C.ink, marginTop: 6, lineHeight: 1.7 }}>{k.reasons.join(" ／ ")}</div>
                            {k.flags.length > 0 && (
                              <div style={{ marginTop: 6 }}>
                                {k.flags.map((f, i) => <div key={i} style={{ fontSize: 12, color: (f.startsWith("✕") || f.startsWith("⚠")) ? C.red : C.muted, lineHeight: 1.6 }}>{f}</div>)}
                              </div>
                            )}

                            {/* 担当者の目安 */}
                            {(k.best || k.worst) && (
                              <div style={{ marginTop: 8, background: C.softGold, borderRadius: 8, padding: "8px 10px" }}>
                                {k.best && <div style={{ fontSize: 12, color: C.deep, lineHeight: 1.6 }}>◎ 連絡するなら <b>{k.best.name} さん</b>（信用{k.best.trust}／トラブル{k.best.troubleRate}%）</div>}
                                {k.worst && (
                                  <div style={{ fontSize: 12, color: C.red, lineHeight: 1.6 }}>
                                    ⚠ <b>{k.worst.name} さん</b>は{k.worst.issues.join("・")}
                                  </div>
                                )}
                                {k.worst && <Incidents disc={k.worst.discNotes} trouble={k.worst.troubleNotes} />}
                              </div>
                            )}

                            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                              <Bar label={`${DOW_MON[effDow]}曜の実績`} v={k.weekdayFit} color={C.deep} />
                              <Bar label="定期につながる率" v={k.regularRate ?? 0} color={C.green} />
                              <Bar label="信用（ズレの少なさ）" v={k.trust} color={C.gold} />
                              <Bar label="トラブルの少なさ" v={k.lowTrouble} color={C.muted} />
                            </div>

                            {/* 誰に連絡するか選ぶ */}
                            {!k.blocked && !isOpen && (
                              <div style={{ marginTop: 12 }}>
                                {!senderReady ? (
                                  <div style={{ fontSize: 12, color: C.red, background: C.softRed, borderRadius: 8, padding: "8px 10px", lineHeight: 1.6 }}>
                                    ⚠ 連絡文を作るには、先に上の「差出人を設定」から施設名・担当者名を入れてください。
                                  </div>
                                ) : (
                                  <>
                                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>連絡文を作る宛先を選ぶ</div>
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                      <button onClick={() => openDraft(k.name, "")} disabled={sentTo.includes(sentKey(k.name, ""))}
                                        style={draftBtn(sentTo.includes(sentKey(k.name, "")))}>
                                        {sentTo.includes(sentKey(k.name, "")) ? "送信済み ✓" : "居宅あて（御中）"}
                                      </button>
                                      {k.staffs.filter((s) => !s.unknown).map((s) => {
                                        const sent = sentTo.includes(sentKey(k.name, s.name));
                                        return (
                                          <button key={s.name} onClick={() => openDraft(k.name, s.name)} disabled={sent}
                                            style={draftBtn(sent, s.caution ? C.red : s.good ? C.green : C.deep)}>
                                            {sent ? `${s.name} さん ✓` : `${s.name} さん`}{s.good && " ◎"}{s.caution && " ⚠"}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                          {!k.blocked && (
                            <div style={{ textAlign: "center", minWidth: 54 }}>
                              <div style={{ fontSize: 28, fontWeight: 800, color: C.deep, lineHeight: 1 }}>{k.score}</div>
                              <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>おすすめ度</div>
                            </div>
                          )}
                        </div>

                        {isOpen && (
                          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px dashed ${C.line}` }}>
                            <div style={{ fontSize: 12, color: C.deep, fontWeight: 700, marginBottom: 6 }}>
                              宛先：{k.name} {draftFor.staff ? `／ ${draftFor.staff} さん` : "（御中）"}
                            </div>
                            {draftLoading ? (
                              <div style={{ padding: "18px 0", fontSize: 13, color: C.green, fontWeight: 700 }}>AIが下書きを書いています…</div>
                            ) : (
                              <>
                                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{draftNote}</div>
                                <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={7} style={{ width: "100%", boxSizing: "border-box", padding: 12, borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 13, lineHeight: 1.7, fontFamily: FONT, color: C.ink, resize: "vertical" }} />
                                <div style={{ marginTop: 6, textAlign: "right" }}>
                                  <button onClick={() => openDraft(draftFor.kyotaku, draftFor.staff)} style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.muted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT }}>書き直してもらう</button>
                                </div>
                                {!confirming ? (
                                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                                    <button onClick={() => setConfirming(true)} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: C.deep, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>送信する</button>
                                    <button onClick={closeDraft} style={{ padding: "9px 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel, color: C.muted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>やめる</button>
                                  </div>
                                ) : (
                                  <div style={{ marginTop: 8, background: C.softGold, border: `1px solid ${C.line}`, borderRadius: 9, padding: 12 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>ほんまにこの内容で送る？</div>
                                    <div style={{ display: "flex", gap: 8 }}>
                                      <button onClick={doSend} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: C.green, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>はい、送信</button>
                                      <button onClick={() => setConfirming(false)} style={{ padding: "9px 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel, color: C.muted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>戻る</button>
                                    </div>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p style={{ fontSize: 12, color: C.muted, marginTop: 20, lineHeight: 1.7 }}>
                  ※ 数字はすべて①で入れた記録から計算しています。担当者別は件数が少ないうちは参考程度に。送信は実際には飛びません（デモ）。
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const inp = { padding: "9px 11px", borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 14, fontFamily: FONT, color: C.ink };
const ghost = { padding: "8px 14px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel, color: C.muted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: FONT };
const draftBtn = (sent, color = C.deep) => ({
  padding: "8px 13px", borderRadius: 9, border: `1px solid ${sent ? C.line : color}`,
  background: sent ? "#EFEEEA" : C.panel, color: sent ? C.muted : color,
  fontWeight: 700, fontSize: 12.5, cursor: sent ? "default" : "pointer", fontFamily: FONT,
});

function Section({ title, children }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, margin: "18px 0" }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: C.deep, marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
      <div style={{ width: 120, fontSize: 13, color: C.muted, paddingTop: 8, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, minWidth: 200 }}>{children}</div>
    </div>
  );
}
function Toggle({ on, set, onLabel, offLabel }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button onClick={() => set(!on)} style={{ width: 46, height: 26, borderRadius: 13, border: "none", background: on ? C.green : C.line, position: "relative", cursor: "pointer" }}>
        <span style={{ position: "absolute", top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
      </button>
      <span style={{ fontSize: 13, color: on ? C.deep : C.muted }}>{on ? onLabel : offLabel}</span>
    </div>
  );
}
function Chip({ on, onClick, children }) {
  return <button onClick={onClick} style={{ padding: "8px 14px", borderRadius: 20, border: `1px solid ${on ? C.deep : C.line}`, background: on ? C.deep : C.panel, color: on ? "#fff" : C.muted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>{children}</button>;
}
function Stat({ label, value, tone }) {
  const color = tone === "good" ? C.green : tone === "bad" ? C.red : C.deep;
  return (
    <div>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}
function MiniStat({ label, value, bad }) {
  return (
    <div style={{ fontSize: 11.5, color: C.muted }}>
      {label} <b style={{ fontSize: 13, color: bad ? C.red : C.deep, marginLeft: 2 }}>{value}</b>
    </div>
  );
}
function Incidents({ disc = [], trouble = [] }) {
  if (disc.length === 0 && trouble.length === 0) return null;
  const short = (m) => (!m ? "（メモなし）" : m.length > 46 ? m.slice(0, 46) + "…" : m);
  const md = (d) => (d ? d.slice(5).replace("-", "/") : "");
  return (
    <div style={{ marginTop: 8, background: "#FBFBF9", border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 5 }}>何があったか（記録のメモから）</div>
      {disc.map((n, i) => (
        <div key={"d" + i} style={{ fontSize: 11.5, lineHeight: 1.6, color: C.ink, marginBottom: 3 }}>
          <span style={{ color: C.red, fontWeight: 700 }}>ズレ</span>
          <span style={{ color: C.muted, margin: "0 5px" }}>{md(n.date)}</span>
          {short(n.memo)}
        </div>
      ))}
      {trouble.map((n, i) => (
        <div key={"t" + i} style={{ fontSize: 11.5, lineHeight: 1.6, color: C.ink, marginBottom: 3 }}>
          <span style={{ color: C.gold, fontWeight: 700 }}>トラブル</span>
          <span style={{ color: C.muted, margin: "0 5px" }}>{md(n.date)}</span>
          {short(n.memo)}
        </div>
      ))}
    </div>
  );
}

function Badge({ children, color, bg }) {
  return <span style={{ fontSize: 11, fontWeight: 800, color, background: bg, padding: "2px 8px", borderRadius: 6 }}>{children}</span>;
}
function Bar({ label, v, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 11, color: "#6B7269", width: 130, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 7, background: "#EFEEEA", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(0, Math.min(100, v))}%`, height: "100%", background: color, borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 11, color: "#6B7269", width: 30, textAlign: "right" }}>{v}</span>
    </div>
  );
}
function Empty({ onSeed }) {
  return (
    <div style={{ textAlign: "center", padding: "20px 0" }}>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>まだ記録がありません。上から入れるか、サンプルで試せます。</div>
      <button onClick={onSeed} style={{ padding: "9px 18px", borderRadius: 9, border: `1px solid ${C.deep}`, background: C.panel, color: C.deep, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT }}>サンプルを8件入れてみる</button>
    </div>
  );
}
