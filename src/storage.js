// window.storage 互換シム。
// - artifact 環境では window.storage が既に存在するので、それをそのまま使う。
// - 通常のブラウザ（Vercel デプロイ時）では window.storage が無いので、
//   localStorage を裏に置いた同じ形の API を用意する。
// これにより本体アプリ（App.jsx）は window.storage.get/set をそのまま呼べて、
// artifact でもデプロイ版でも無改変で動く。
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {
        /* 容量超過などは黙って無視 */
      }
    },
    async delete(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* noop */
      }
    },
  };
}
