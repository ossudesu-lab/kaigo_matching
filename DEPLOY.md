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

### Vercel の Sensitive 変数は読み出せない

`ANTHROPIC_API_KEY` は **Sensitive 種別**で登録されている（Preview / Production）。
**`vercel env pull` してもダミー値しか降りてこない**（実際に叩くと 401 になる）。
書き込み後は誰も読めないという仕様どおりの動作なので、Vercelから取り出す方法は無い。

そのため **eval をローカルで回すには、別途 `.env` にキーを1行書く必要がある**:

```
ANTHROPIC_API_KEY=sk-ant-...
```

`.gitignore` が `.env*` を除外しているのでコミットされない。
本番用とは別のキーを作っておくと、Anthropic Console の Usage で **eval分のコストを
本番と分けて確認できる**。万一漏れたときも、そのキーだけ無効化すれば本番は動き続ける。

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

### PowerShell で `vercel` が動かないとき

実行ポリシーにより `vercel.ps1` の読み込みが止まることがある（`UnauthorizedAccess`）。
**セキュリティ設定を変えなくても回避できる。** Git Bash から実行するか、`.cmd` を直接呼ぶ:

```
vercel.cmd env pull .env.local
```

npm製のCLI全般（`vercel` / `vite` など）で同じ手が使える。

## デプロイ

```
vercel               # プレビュー環境にデプロイ、URLが出る
vercel --prod        # 本番デプロイ
```

初回は対話で「フレームワーク: Vite」を自動検出。ビルドコマンド `npm run build`、
出力 `dist`、`/api` は自動でサーバー関数になる（vercel.json 不要）。

**デプロイ後、Vercel のダッシュボード → Settings → Environment Variables で
`ANTHROPIC_API_KEY` を必ず設定する**（設定後に再デプロイ）。

### Git連携（2026-08 接続）

Vercelプロジェクトに GitHub リポジトリ `ossudesu-lab/kaigo_matching` を接続済み。

- ブランチを push → **Preview が自動作成される**
- `main` にマージ → **本番へ自動デプロイ**
- **`vercel --prod` の手動実行は不要**

接続前は手動デプロイのみで、「マージしたのに本番に反映されていない」という
取り違えが実際に起きた。その状態に戻さないこと。

#### GitHub App のアクセス範囲

Vercel の GitHub App は **Only select repositories** で `kaigo_matching` のみに
許可している。同一アカウントに private リポジトリ（`zenn-content`）があるため、
All repositories は選んでいない。

別のリポジトリを Vercel で動かすときは、GitHub → Settings → Applications →
Vercel → Configure から**追加が必要**。追加を忘れると「push してもデプロイ
されない」という形で現れるので、その症状が出たらまずここを見る。

#### 手動デプロイが必要なとき

連携が切れている場合や、ローカルの作業ツリーをそのまま上げたい場合のみ:

```
git checkout main && git pull origin main && vercel --prod
```

ブランチのまま `vercel --prod` すると「本番で動いているコード ≠ `main`」になり、
後から何が動いているか分からなくなるので避けること。

### URL

- **公開URL: `https://kaigomatching.vercel.app`**
- デプロイごとの個別URL（`kaigomatching-xxxxx-ossudesu-lab1.vercel.app`）は
  Vercel Auth で保護されており、外部からは 401 になる。動作確認は公開URLに対して行う。
- Preview を外部から叩く必要がある場合は、Settings → Deployment Protection →
  Protection Bypass for Automation でトークンを発行し、
  `VERCEL_AUTOMATION_BYPASS_SECRET` としてスモークテストに渡す。

### デプロイ後の確認

```
node scripts/smoke-test.js --url=https://kaigomatching.vercel.app
```

実際の `/api/extract` を3ケースだけ叩き、経路（入力検証・レート制限・応答形）が
生きているかを確認する（レート制限 20回/10分 に収まる件数）。
**これは精度の測定ではない。** 精度は `scripts/eval-extract.js` で測ること。

## モデルを変えるとき（コスト調整）

- **抽出は Haiku で確定（2026-08 に実測）。** 以前は「構造化タスクだから十分そう」という
  未検証の仮定だったが、14ケース×10回で測って裏づけた:

  | | Haiku 4.5 | Sonnet 5 |
  | --- | --- | --- |
  | 総合スコア | 100（100–100） | 100（99–100） |
  | 全10回満点のケース | **14/14** | 11/14 |
  | 応答時間（中央） | **1.45秒** | 3.54秒 |
  | 1,000件あたり | **$1.74** | $6.53 |

  精度同等・約2.4倍速・約3.7倍安のため Haiku を継続。再測定はこれで行う:

  ```
  node --env-file=.env scripts/eval-extract.js --runs=10 --model=claude-haiku-4-5
  ```
- 連絡文を Haiku に落とすかは、**必ず手元の連絡文evalをHaikuで回してから**判断する
  （複数回・完走率90%以上・criticalMiss確認。CLAUDE.md の eval 運用ルール参照）。
- 切替は Vercel の環境変数 `MODEL_DRAFT` / `MODEL_EXTRACT` を変えるだけ。コード変更不要。

## ローカルLLM（Ollama）で動かす

記録を外部APIに出せない事業所向けの経路。モデル名に `ollama:` を付けると
Anthropic ではなくローカルの Ollama を呼ぶ（`api/_lib/llm.js` が振り分ける）。

```bash
ollama pull qwen2.5:7b
MODEL_EXTRACT=ollama:qwen2.5:7b
```

| 環境変数 | 既定 | 内容 |
| --- | --- | --- |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama の接続先 |

- Vercel の関数からは localhost の Ollama に届かないので、**この経路は事業所内に
  自前で立てる場合のみ**。公開中の `kaigomatching.vercel.app` では使えない。
- evalも同じ切替で測れる（課金は発生しない）:

  ```bash
  node --env-file=.env scripts/eval-extract.js --model=ollama:qwen2.5:7b --runs=3
  ```

- **既定にはしない。** 35ケース×3回で総合96点まで届いたが、重大な見逃しが9件/回残る
  （Haiku は0件）。1件あたり約42秒かかる点も含め、実測は README のモデル比較を参照。
- 7B級はプロンプトの書き方で結果が変わる。ローカル向けの調整版を
  `scripts/prompt-variants/local-7b.js` に置いてある（`--prompt=` で指定）。

## セキュリティ上の注意

- レート制限（`api/_lib/ratelimit.js`）はインメモリのベストエフォート。
  Vercel は関数インスタンスごとにメモリが別なので、厳密ではない。
  本気で守るなら Vercel KV / Upstash Redis に置き換える。
- `max_tokens` はサーバー側で 1024 に固定。クライアントからは変更不可。
- 入力長もサーバー側で制限済み（記録文4000字、各項目に上限）。
