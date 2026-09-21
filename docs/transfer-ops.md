# 転送機能の運用手順（Phase 1 + Phase 2）

Cloudflare 上で `tools.yutok.dev/transfer*` を Worker に振り、R2 一時転送と Google Drive 保管を有効化する手順です。

## 前提

- Cloudflare アカウント（ドメイン `yutok.dev` 管理）
- リポジトリ: `32Lwk/tools`
- Worker ソース: [`workers/transfer/`](../workers/transfer/)

## なぜ動かないか（よくある原因）

1. **Worker 未デプロイ** — `/transfer/api/*` が GitHub Pages の 404 になる
2. **DNS が灰雲（DNS only）** — Worker Routes は橙雲（Proxied）必須。公開 DNS が `185.199.x.x`（GitHub）のままなら未 Proxied
3. **KV / R2 未作成または ID 未記入** — multipart / メタデータが失敗する
4. **認証未設定** — 本番は Cloudflare Access または Google OAuth 必須。未設定だと upload API は 503

## 1. R2 / KV を作成

```bash
cd workers/transfer
npx wrangler login
npx wrangler r2 bucket create tools-transfer
npx wrangler r2 bucket create tools-transfer-preview
npx wrangler kv namespace create TOOLS_TRANSFER_META
npx wrangler kv namespace create TOOLS_TRANSFER_META --preview
```

出力された KV ID を [`wrangler.jsonc`](../workers/transfer/wrangler.jsonc) の `kv_namespaces` に記入する。

## 2. DNS を橙雲（Proxied）に

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `tools` | `32lwk.github.io` | **Proxied**（橙雲） |

Cloudflare Dashboard → DNS → `tools` レコードの Proxy status を Proxied にする。

`wrangler.jsonc` の `routes` により `tools.yutok.dev/transfer*` が Worker に入り、それ以外はオリジン（GitHub Pages）へフォールバックします。

## 3. アップロード認証（必須）

誰でもアップロードできないよう、本番は **fail-closed** です。UI は **Cloudflare Zero Trust** と **Google** のボタンのみ（ゲートパスワード入力は廃止）。

どちらか一方、または両方を設定できます。Drive 保管を使う場合は Google OAuth が必須です。

### A. Cloudflare Access（Zero Trust・推奨）

1. Zero Trust → Access → Applications → Add Self-hosted
2. Domain: `tools.yutok.dev`
3. **保護:** `/transfer*`（アップロード bootstrap）。公開 UI / DL / OAuth は `/share*`（Access 外）
4. Policy: 自分のアカウントのみ Allow
5. Identity providers: **Google**（または GitHub / One-time PIN）を追加可能
6. Worker secrets（`ACCESS_AUD` は複数アプリならカンマ区切り）:

```bash
cd workers/transfer
npx wrangler secret put ACCESS_AUD
npx wrangler secret put TEAM_DOMAIN
# 例: https://<team>.cloudflareaccess.com
# 任意: UPLOAD_ALLOW_EMAILS=you@example.com
```

アップロード画面は **`https://tools.yutok.dev/share/`**。Zero Trust ボタンは `/transfer/` で JWT を発行したあと `/share/` へ戻ります。
Worker は `Cf-Access-Jwt-Assertion` / `CF_Authorization` を検証します。

### B. Google OAuth（アップロード session + Drive）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成
2. API とサービス → ライブラリ → **Google Drive API** を有効化  
   （Drive Labels / Gmail は本機能では不要。他用途なら別途可）
3. OAuth 同意画面:
   - ユーザータイプ: 外部（またはテスト）
   - テストユーザーに自分の Google アカウントを追加（公開前は必須）
   - スコープ:
     - `openid` / `email` / `profile`
     - `https://www.googleapis.com/auth/drive.file`
4. 認証情報 → OAuth クライアント ID（**ウェブアプリケーション**）
   - 承認済みの JavaScript 生成元: `https://tools.yutok.dev`
   - 承認済みのリダイレクト URI（**一字一句この値**）:
     `https://tools.yutok.dev/share/api/auth/google/callback`
5. リポジトリ直下の `.env` に値を書き、Worker へ投入:

```bash
cd workers/transfer
# .env から投入する例（PowerShell）:
# Get-Content ../../.env | ForEach-Object { ... }  # または下記を個別に
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REDIRECT_URI
# 32 バイト鍵（例: openssl rand -base64 32）。短いパスフレーズも SHA-256 で受け付けるが非推奨:
npx wrangler secret put TOKEN_ENC_KEY
```

6. Access は `/transfer*`（アップロード）のみ保護し、公開入口は `/share*` を使う（Worker Routes で分離）。
   旧パスを残す場合のみ Bypass: `/transfer/d/*`, `/transfer/api/dl/*`, `/transfer/api/auth/google/*`

よくある Access 症状:

| 症状 | 原因 |
|------|------|
| `/transfer/d/...` が Cloudflare Access ログインになる | 想定どおり。公開 URL は `/share/d/...` |
| Google が `redirect_uri_mismatch` | Cloud Console に `/share/api/auth/google/callback` が無い |
| サイト直下 `/` は開けるが `/transfer` だけログイン | Self-hosted アプリが `tools.yutok.dev/transfer*` を保護（アップロード用） |

Google ログイン成功で HttpOnly upload session Cookie（12 時間）が付き、refresh token は KV に AES-GCM 暗号化保存されます。

よくある Google 側エラー:

| 症状 | 原因 |
|------|------|
| `redirect_uri_mismatch` | Cloud Console のリダイレクト URI が上記と不一致 |
| `access_denied` / アプリ未確認 | 同意画面がテストモードで、テストユーザー未追加 |
| `invalid_client` | Client ID/Secret が Worker secret に未投入、または誤り |
| ボタンを押すと Access ログインへ飛ぶ | Google パスが Access Bypass されていない |

### C. ゲートパスワード（非推奨・緊急用 API のみ）

UI からは削除済みです。緊急時のみ:

```bash
npx wrangler secret put UPLOAD_GATE
# POST /transfer/api/auth/login { "password": "..." }
```

ローカル開発のみ `.dev.vars` で `DEV_OPEN_UPLOAD=1`（コミットしない）。

## 4. Worker をデプロイ

```bash
cd workers/transfer
npx wrangler deploy
```

リポジトリルートの [`.assetsignore`](../.assetsignore) で大容量ファイルをアセット走査から除外しています。

## 5. R2 CORS（将来用）

現状の R2 multipart は Worker 経由（32 MiB パート）です。Drive はブラウザから Google へ直接 resumable upload します。将来 R2 を presigned 直 PUT にする場合はバケット CORS を設定します。

## 6. 動作確認

### 共通

1. `https://tools.yutok.dev/share/api/auth/methods` が JSON（`access` / `google`）であること
2. `https://tools.yutok.dev/transfer/api/status` が未認証なら 401 であること（Pages の HTML 404 / POST の 405 ではない）
3. ブラウザの開発者ツール → Network で `Server: cloudflare` と `cf-ray` があること

### R2

1. Zero Trust または Google でログイン後、小ファイルをアップロード
2. `/share/d/{slug}` を別ブラウザ（未ログイン）で開き、ファイル用パスワードで DL / プレビュー
3. 合計が 10 GiB を超えると 409 になること（本数制限はない）

### Drive

1. Google でログイン（Drive スコープ同意）
2. 「Drive 保管」タブ → フォルダ割当（既定 `tools-transfer`）
3. 小ファイルをアップロード → 共有リンクでパスワード DL
4. リンク期限切れ後も Drive 上の本体は残ること（サイト側メタのみ削除）

DNS を橙雲にした直後に API が HTML/405 になる場合は、OS の DNS キャッシュを消す（Windows: `ipconfig /flushdns`）か、別ブラウザ／シークレットウィンドウで再試行してください。

## 7. コスト目安（ほぼ無料）

- R2 無料枠: 10 GB-month / Class A 100 万 / Class B 1000 万 / egress $0
- 同時保管は合計 10 GiB まで（無料枠）。本数は無制限。24 時間保管なら GB-month も枠内
- Drive: ユーザーの Google ストレージを消費（サイト課金なし）
- UI のコスト確認は R2 アップロード前に必須。Drive は同意チェックのみ

## 8. 次フェーズ

- Phase 3: P2P（WebRTC / QR・超音波）
