// 簡易レート制限（インメモリ）。
// 注意: Vercel の関数はインスタンスごとにメモリが別なので、これは
//   「1インスタンスが温まっている間のベストエフォート」。
//   個人ポートフォリオのデモとしてはこれで十分（悪意ある連打をある程度弾ける）。
//   本気で守るなら Vercel KV / Upstash Redis などの外部ストアに置き換える。

const WINDOW_MS = 10 * 60 * 1000; // 10分
const MAX_PER_IP = 20; // 同一IPあたり 20回 / 10分
const MAX_GLOBAL = 200; // インスタンス全体 200回 / 10分（APIキー保護の最終防波堤）

const perIp = new Map(); // ip -> number[]（タイムスタンプ）
let globalHits = [];

export function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  globalHits = globalHits.filter((t) => t > cutoff);
  if (globalHits.length >= MAX_GLOBAL) return { ok: false, reason: "global" };

  const arr = (perIp.get(ip) || []).filter((t) => t > cutoff);
  if (arr.length >= MAX_PER_IP) {
    perIp.set(ip, arr);
    return { ok: false, reason: "ip" };
  }

  arr.push(now);
  perIp.set(ip, arr);
  globalHits.push(now);
  return { ok: true };
}

// x-forwarded-for の先頭がクライアントIP（Vercel はここに実IPを入れる）。
export function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}
