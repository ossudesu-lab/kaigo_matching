# デプロイ手順（Vercel）

このアプリは **フロント（Vite + React）** と **サーバー関数（`/api`）** の2層構成。
Anthropic の API キーはサーバー関数の環境変数だけに置き、ブラウザには一切出さない。

## 構成

```
index.html               エントリHTML
vite.config.js           ビルド設定
src/
  main.jsx               起動（storage シムを先に読む）
  storage.js             window.storage 互換シム（無ければ localStorage を裏に置く）
  App.jsx                本体アプリ（AI呼び出しは /api を叩くだけ）
api/
  extract.js             記録の抽出（デフォルト Haiku）
  draft.js               連絡文の生成（デフォルト Sonnet）
  _lib/
    anthropic.js         Anthropic 呼び出し共通（APIキー・モデル・max_tokens をここで固定）
    ratelimit.js         簡易レート制限（IP単位・全体上限）
```

- `kaigo-app.jsx`（プロジェクト直下の旧ファイル）は `src/App.jsx` に移して改修済み。
  今後は `src/App.jsx` が本体。旧 `kaigo-app.jsx` は残してあるので、確認後に消してよい。

## 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ○ | Anthropic の APIキー。**Vercel の環境変数に入れる。コードにもGitにも入れない** |
| `MODEL_EXTRACT` | — | 抽出のモデル。未設定なら `claude-haiku-4-5` |
| `MODEL_DRAFT` | — | 連絡文のモデル。未設定なら `claude-sonnet-4-6` |

## ローカル確認

`npm run dev`（Vite単体）は `/api` を動かせない。フロントとAPIを一緒に動かすには Vercel CLI を使う:

```
npm install -g vercel        # 初回のみ
vercel login                 # 初回のみ（ブラウザ認証）
vercel env add ANTHROPIC_API_KEY   # ローカル用に .env を作る場合は下記でも可
vercel dev                   # http://localhost:3000 でフロント+API が動く
```

または `.env` に `ANTHROPIC_API_KEY=...` を書いて `vercel dev`。
（`.env` は `.gitignore` 済みなのでコミットされない）

## デプロイ

```
vercel               # プレビュー環境にデプロイ、URLが出る
vercel --prod        # 本番デプロイ
```

初回は対話で「フレームワーク: Vite」を自動検出。ビルドコマンド `npm run build`、
出力 `dist`、`/api` は自動でサーバー関数になる（vercel.json 不要）。

**デプロイ後、Vercel のダッシュボード → Settings → Environment Variables で
`ANTHROPIC_API_KEY` を必ず設定する**（設定後に再デプロイ）。

## モデルを変えるとき（コスト調整）

- 抽出は Haiku で十分そう（構造化タスク）。
- 連絡文を Haiku に落とすかは、**必ず手元の連絡文evalをHaikuで回してから**判断する
  （複数回・完走率90%以上・criticalMiss確認。CLAUDE.md の eval 運用ルール参照）。
- 切替は Vercel の環境変数 `MODEL_DRAFT` / `MODEL_EXTRACT` を変えるだけ。コード変更不要。

## セキュリティ上の注意

- レート制限（`api/_lib/ratelimit.js`）はインメモリのベストエフォート。
  Vercel は関数インスタンスごとにメモリが別なので、厳密ではない。
  本気で守るなら Vercel KV / Upstash Redis に置き換える。
- `max_tokens` はサーバー側で 1024 に固定。クライアントからは変更不可。
- 入力長もサーバー側で制限済み（記録文4000字、各項目に上限）。
