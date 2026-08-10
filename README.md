# kaigo_matching — 短期入所 空床マッチング支援アプリ

**アプリ: https://kaigomatching.vercel.app**

短期入所（ショートステイ）施設向けに、空床が出たときに「どこの誰に声をかけるか」を助けるアプリ。

利用記録（誰をどの居宅介護支援事業所から受け入れて、事前情報とのズレやトラブルがあったか）を貯めておくと、
居宅介護支援事業所（ケアマネ）ごとの傾向が自動集計され、優先順位付けと連絡文の下書きが得られる。

## できること

- 利用記録の入力（フォーム、または記録文からのAI抽出）
- 居宅・担当者別の集計（信用スコア＝事前情報とのズレの少なさ／トラブル率）
- 空き枠に対して、誰に声をかけるべきかの優先順位表示
- 連絡文（下書き）のAI生成

送信機能はデモで、実際にはメール等を送信しない。

## 技術構成

フロント（Vite + React）と、Anthropic API キーを扱うサーバー関数（`/api`）の2層構成。
APIキーはサーバー側の環境変数にのみ置き、ブラウザには一切出さない。

```
index.html               エントリHTML
vite.config.js           ビルド設定
src/
  main.jsx                起動（storage シムを先に読む）
  storage.js               window.storage 互換シム（無ければ localStorage を裏に置く）
  App.jsx                  本体アプリ（単一ファイルのReactコンポーネント。AI呼び出しは /api を叩くだけ）
api/
  extract.js               記録の抽出（デフォルト Haiku）
  draft.js                 連絡文の生成（デフォルト Sonnet）
  _lib/
    anthropic.js            Anthropic 呼び出し共通（APIキー・モデル・max_tokens を固定）
    ratelimit.js             簡易レート制限（インメモリのベストエフォート）
eval-app.jsx              記録抽出のeval
eval-cases.json           抽出evalの正解データ
draft-eval.jsx            連絡文eval（LLM-as-judge）
```

## セットアップ

```console
npm i
```

`.env.example` を `.env` にコピーし、`ANTHROPIC_API_KEY` を設定する（`.env` は gitignore 済み）。

## ローカル起動

`npm run dev`（Vite単体）は `/api` を動かせない。フロントとAPIを一緒に動かすには Vercel CLI を使う。

```console
npm install -g vercel
vercel login
vercel dev
```

`http://localhost:3000` でフロント＋APIが動く。

## デプロイ

Vercel を利用（フロント: Vite ビルド → `dist`、`/api` はサーバー関数として自動デプロイ）。
手順・環境変数・モデル切替・セキュリティ上の注意は [DEPLOY.md](DEPLOY.md) を参照。

## データの保存先

利用記録は `window.storage` の `usage-records-v1` に、差出人設定は `sender-settings-v1` に保存される
（ブラウザの localStorage/sessionStorage は直接使わない設計）。

## セキュリティ上の注意（やったこと・やらなかったこと）

個人ポートフォリオのデモとして公開する前提での対策。詳細は [DEPLOY.md](DEPLOY.md) を参照。

やったこと:

- APIキーをサーバー側に隠す（ブラウザに渡さない）
- 出力トークン上限（`max_tokens=1024`）をサーバーで固定、クライアントから指定不可に
- 入力サイズの上限をサーバーで検証（記録文は4000文字まで）
- レート制限（IPごと20回/10分、全体200回/10分。インメモリ・ベストエフォート）
- Anthropicのクレジット残高を少額に固定、自動リロードは無効
- `.gitignore` に `.env` があることを確認してから公開

やらなかったこと（理由つき）:

- レート制限の共有ストア化（Redis等） — 残高上限が最後の壁になるため、個人デモの規模では割に合わないと判断
- 認証 — デモとして誰でも触れる状態にしている
- WAFやbot対策の導入
- 本番相当の監視・アラート

制限を知らずに素通りしたのか、知ったうえで選ばなかったのかを外から区別できるように、ここに明記している。

## eval

- `eval-app.jsx` + `eval-cases.json`: 記録文からの抽出精度を検証
- `draft-eval.jsx`: 連絡文生成をLLM-as-judgeで検証（禁止事項の混入がないかなど）

運用ルール（複数回実行して平均を見る、完走率90%未満は信用しない、など）は
[CLAUDE.md](CLAUDE.md) の「eval の運用ルール」を参照。

## ドメイン知識・開発ルール

介護ドメインの判断基準（信用スコアの考え方、連絡文プロンプトの制約など）は [CLAUDE.md](CLAUDE.md) にまとまっている。
