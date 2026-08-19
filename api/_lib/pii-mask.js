// 記録文から個人を特定しうる語を伏せる／戻す。
//
// ── なぜ必要か ──
// 介護記録には利用者名・担当ケアマネ名・自施設職員名が生で入る。
// 外部APIに送れない施設では、そのままクラウドLLMに投げられない。
// ここで伏せてから送り、返ってきた結果を戻す。
//
// ── これで十分ではない、という前提 ──
// 氏名を伏せても、要介護度・医療処置・夜間の様子といった**要配慮個人情報は本文に残る**。
// 施設と時期が分かれば個人が特定されうる。これは「送る情報を減らす」措置であって、
// 「個人情報を送っていない」と言い切れるものではない。
// 外に一切出せない場合の答えはローカルLLM（ollama.js）側。
//
// ── 伏せ方の考え方 ──
// 抽出対象かどうかで扱いが変わる。
//   staff / kyotaku … 抽出して返す必要がある → プレースホルダに置換し、あとで戻す
//   利用者名 / 自施設職員名 … 抽出対象ではない → 置換したまま戻さない
//
// 置換しても文の構造は残るので、「当施設の看護師・[人物3]」のような文脈から
// 「これは紹介元の担当ではない」という判断はモデル側で従来どおりできる。

// 事業所名の手がかり。長い語から先に当てる（「居宅介護支援事業所」が「居宅」に食われないように）。
const ORG_SUFFIX = [
  "居宅介護支援事業所",
  "居宅介護支援",
  "ケアプランセンター",
  "ケアプラン",
  "居宅",
];
const ORG_PREFIX = ["株式会社", "有限会社", "社会福祉法人", "医療法人", "合同会社"];

// 人名の手がかり。敬称・肩書きは名前の一部ではないので置換対象に含めない
// （「高橋CM」→「[人物1]CM」とし、CMを外す判断はモデルに残す）。
const PERSON_SUFFIX = ["さん", "様", "氏", "ケアマネ", "CM"];

// 敬称が付かない書き方もある。「当施設の看護師・鈴木が対応し」のように
// 肩書きの直後に区切り記号を挟んで名前だけ書く形は現場の記録でよく出る。
// 「〜の」は区切りに入れない。「看護師の指示」のような名前でない語まで拾ってしまうため。
const PERSON_TITLE = [
  "看護師", "准看護師", "介護福祉士", "介護職員", "生活相談員", "相談員",
  "機能訓練指導員", "管理者", "主任", "ケアマネジャー", "ケアマネージャー", "ケアマネ", "担当",
];

// 人を指すが名前ではない語。敬称の直前に来ても伏せない
// （「新規のケアマネさん」の「ケアマネ」を人名と誤認して伏せていた）。
const NOT_A_NAME = new Set([
  ...PERSON_TITLE,
  "利用者", "本人", "ご本人", "家族", "ご家族", "職員", "スタッフ",
  "事務", "新規", "施設", "事業所", "先方", "医師",
]);

const KANJI = "\\u4e00-\\u9fff\\u3005";
const KATAKANA = "\\u30a1-\\u30f6\\u30fc";

/**
 * 辞書を作る。実運用では過去の記録から集めた kyotaku / staff を渡す。
 * 表記ゆれを正規形に寄せるため、`別名 → 正規形` の対応も持てる。
 *
 * @param {{people?: Array<string|[string,string]>, orgs?: Array<string|[string,string]>}} src
 */
export function buildDictionary(src = {}) {
  const norm = (list) => {
    const m = new Map();
    for (const e of list ?? []) {
      const [surface, canonical] = Array.isArray(e) ? e : [e, e];
      m.set(surface, canonical);
    }
    // 長い表記から先に当てる。「あおぞら居宅介護支援」が「あおぞら居宅」に食われないように。
    return [...m.entries()].sort((a, b) => b[0].length - a[0].length);
  };
  return { people: norm(src.people), orgs: norm(src.orgs) };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 記録文を伏せる。
 *
 * @param {string} text
 * @param {ReturnType<typeof buildDictionary>} [dict] 既知の名前。正規形での復元に使う
 * @returns {{ masked: string, mapping: Record<string,string>, stats: object }}
 *   mapping は プレースホルダ → 復元する文字列。
 */
export function maskRecord(text, dict = buildDictionary()) {
  const mapping = {};
  const seen = new Map(); // 同じ名前は同じプレースホルダに寄せる
  let orgN = 0, personN = 0;
  const stats = { orgsByDict: 0, orgsByPattern: 0, peopleByDict: 0, peopleByPattern: 0 };

  let out = text;

  const put = (kind, surface, canonical) => {
    const key = kind + ":" + surface;
    if (seen.has(key)) return seen.get(key);
    const ph = kind === "org" ? `[事業所${++orgN}]` : `[人物${++personN}]`;
    seen.set(key, ph);
    mapping[ph] = canonical;
    return ph;
  };

  // 1. 辞書に載っているものを先に伏せる。正規形が分かるのはこちらだけ。
  for (const [surface, canonical] of dict.orgs) {
    if (!out.includes(surface)) continue;
    out = out.split(surface).join(put("org", surface, canonical));
    stats.orgsByDict++;
  }
  for (const [surface, canonical] of dict.people) {
    if (!out.includes(surface)) continue;
    out = out.split(surface).join(put("person", surface, canonical));
    stats.peopleByDict++;
  }

  // 2. 辞書に無いものをパターンで拾う。
  //    正規形は分からないので、書かれていた文字列をそのまま復元する。
  // 空白の扱いに注意。`\s*` を選択部分の外に出すと直前の空白まで飲み込み、
  // 復元した kyotaku の先頭に空白が残る（「 あおぞら居宅介護支援」）。必ず法人格の内側に置く。
  // 「株式会社さくらケア 居宅介護支援事業所」のように本体と種別の間が空くこともあるので、そこは1文字だけ許す。
  const orgRe = new RegExp(
    `(?:(?:${ORG_PREFIX.map(escapeRe).join("|")})[\\s・]*)?` +
      `[${KANJI}${KATAKANA}\\u3041-\\u3096A-Za-z0-9]{2,12}[\\s]?` +
      `(?:${ORG_SUFFIX.map(escapeRe).join("|")})`,
    "g"
  );
  out = out.replace(orgRe, (m) => (m.startsWith("[") ? m : put("org", m, m)));

  // 肩書き＋区切り＋名前（「看護師・鈴木」）。敬称が無いので先に拾う。
  // 自施設の職員名は抽出対象ではないが、外に出さないという点では同じ扱いにする。
  const titledRe = new RegExp(
    `(${PERSON_TITLE.map(escapeRe).join("|")})([・:：\\s]\\s*)([${KANJI}${KATAKANA}]{1,5})`,
    "g"
  );
  out = out.replace(titledRe, (m, title, sep, name) =>
    NOT_A_NAME.has(name) ? m : title + sep + put("person", name, name)
  );

  // 敬称の直前を人名とみなす。姓のみ／姓名の両方を想定して1〜5文字。
  const personRe = new RegExp(
    `([${KANJI}${KATAKANA}]{1,5})(?=(?:${PERSON_SUFFIX.map(escapeRe).join("|")}))`,
    "g"
  );
  out = out.replace(personRe, (m) => (NOT_A_NAME.has(m) ? m : put("person", m, m)));

  stats.orgsByPattern = orgN - stats.orgsByDict;
  stats.peopleByPattern = personN - stats.peopleByDict;

  return { masked: out, mapping, stats };
}

/**
 * 抽出結果のプレースホルダを元に戻す。
 *
 * 角括弧は無くても拾う。モデルは `[事業所1]` を `事業所1` と書いて返すことがあり
 * （「敬称や肩書きは外す」「そのまま写す」の指示に引きずられて記号を落とす）、
 * 角括弧を必須にすると復元が全滅する。実測で staff・kyotaku が0点になった。
 */
const PLACEHOLDER_RE = /\[?(事業所|人物)(\d+)\]?/g;

export function restoreFields(fields, mapping) {
  const out = { ...fields };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string" || !v) continue;
    out[k] = v.replace(PLACEHOLDER_RE, (m, kind, n) => mapping[`[${kind}${n}]`] ?? m);
  }
  return out;
}

/**
 * 伏せ漏れの検査。マスク後の本文に、隠すべき語がまだ残っていないかを見る。
 * 正解が分かっている評価データに対して使う。API課金は発生しない。
 */
export function findLeaks(maskedText, secrets) {
  return secrets.filter((s) => s && s.length > 0 && maskedText.includes(s));
}
