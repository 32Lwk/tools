# 転送機能の運用手順（Phase 1 + Phase 2）

Cloudflare 上で `tools.yutok.dev/transfer*` と `/share*` を Worker に振り、R2 一時転送と Google Drive 保管を有効化する手順です。

## 前提

- Cloudflare アカウント（ドメイン `yutok.dev` 管理）
- リポジトリ: `32Lwk/tools`（ローカル: `D:\Programing\tools-web`）
- Worker ソース: [`workers/transfer/`](../workers/transfer/)

## なぜ動かないか（よくある原因）

1. **Worker 未デプロイ** — `/share/api/*` が GitHub Pages の 404 になる
2. **DNS が灰雲（DNS only）** — Worker Routes は橙雲（Proxied）必須
3. **KV / R2 未作成または ID 未記入** — multipart / メタデータが失敗する
4. **認証未設定** — 本番は **UPLOAD_GATE（共有パスワード）** / Cloudflare Access / Google OAuth のいずれか必須。未設定だと upload API は 503
5. **`/transfer*` が Access 保護のまま** — 外部が Cloudflare ログインに飛ばされる。公開入口は `/share/`（Access 外）。`/transfer` も使わせるなら Access アプリを削除または Bypass

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

`wrangler.jsonc` の `routes` により `tools.yutok.dev/transfer*` と `/share*` が Worker に入ります。

## 3. アップロード認証

誰でも無制限にアップロードできないよう、本番は **fail-closed** です。

| 方式 | 用途 | 制限 |
|------|------|------|
| **共有パスワード（UPLOAD_GATE）** | 外部への一時公開（推奨） | 1ファイル **500 MiB** / セッション合計 **1 GiB** + 全体 10 GiB |
| Cloudflare Access / Google | 所有者（自分） | 全体 10 GiB のみ |
| Google OAuth | Drive 保管にも必須 | — |

公開 UI: **`https://tools.yutok.dev/share/`**（パスワード入力フォームあり）。

### A. 共有パスワード（UPLOAD_GATE・外部公開の主経路）

```bash
cd workers/transfer
npx wrangler secret put UPLOAD_GATE
```

UI でパスワード入力 → HttpOnly セッション Cookie（12 時間）。Drive タブはゲート認証では無効。

### B. Cloudflare Access（任意・所有者用）

**2026-09-22:** `tools.yutok.dev/transfer*` 向け Self-hosted アプリは削除済み。公開は共有パスワード（UPLOAD_GATE）が主経路です。`/transfer/` と `/share/` は Access なしで到達します。

所有者用に Access を再導入する場合のみ:

1. Zero Trust → Access → Applications で Self-hosted を追加
2. Worker secrets:

```bash
npx wrangler secret put ACCESS_AUD
npx wrangler secret put TEAM_DOMAIN
# 任意: UPLOAD_ALLOW_EMAILS=you@example.com
```

外部公開と両立させるなら `/transfer*` を保護せず、別パスのみ Access にする。

### C. Google OAuth（Drive + 所有者セッション）

1. Google Cloud Console で Drive API 有効化
2. OAuth クライアント（ウェブ）:
   - リダイレクト URI: `https://tools.yutok.dev/share/api/auth/google/callback`
3. secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REDIRECT_URI
npx wrangler secret put TOKEN_ENC_KEY
```

ローカル開発のみ `.dev.vars` で `DEV_OPEN_UPLOAD=1`（コミットしない）。

## 4. アップロード完了メール（**無料**・Gmail API）

完了時に詳細（ファイル名・サイズ・slug・DL URL・R2 key / Drive ID・IP・UA 等）を `yuto.k051028@gmail.com` へ通知します。

### なぜ Workers Paid ($5) は不要か

| 方式 | 料金 | iCloud `@yutok.dev` との関係 |
|------|------|------------------------------|
| Cloudflare Email Sending（任意宛先） | Workers Paid **$5/月** 必要 | apex MX を CF に寄せる必要 → **iCloud と衝突** |
| 確認済み宛先のみ CF 送信 | Free | 送信元に CF Email Routing が必要。apex は iCloud MX のため不可 |
| **Gmail API（採用）** | **Free** | **iCloud の MX・送受信はそのまま**。通知は Gmail から送る |

iCloud カスタムドメインの SMTP を Worker から直接流用はできません。受信の iCloud はそのまま、通知だけ Gmail API にします。

### セットアップ（一度だけ）

**採用:** 家計簿（`kakeibo-app-494112` / kakeibo.yutok.dev）の OAuth + `~/.gmail-mcp` の refresh token。  
既存スコープに `gmail.modify` があるため、**追加のブラウザ同意は不要**（ゲート upload でも Google ログイン不要）。

Worker secrets（済ならスキップ）:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` … kakeibo と同じ
- `NOTIFY_GMAIL_REFRESH_TOKEN` … gmail-mcp の refresh token
- `NOTIFY_GMAIL` / `NOTIFY_TO` … `yuto.k051028@gmail.com`

Drive ログインも同じ Client を使う場合、GCP OAuth クライアントにリダイレクト URI を追加:

`https://tools.yutok.dev/share/api/auth/google/callback`

メール失敗はログのみ（アップロード成功は維持）。Cloudflare Email Sending の $5 課金は不要。

## 5. Worker をデプロイ

```bash
cd workers/transfer
npx wrangler deploy
```

## 6. 動作確認

1. `https://tools.yutok.dev/share/api/auth/methods` が JSON（`access` / `google` / `gate`）であること
2. 未認証で `https://tools.yutok.dev/share/` が開き、共有パスワード入力できること
3. ゲートログイン後、小ファイル upload → `yuto.k051028@gmail.com` に通知
4. 501 MiB 相当・セッション合計 1 GiB 超が拒否されること
5. `/share/d/{slug}` でファイル用パスワード DL

### Drive

1. Google でログイン → 「Drive 保管」タブ
2. ゲート認証のままでは Drive 不可（Google ログインへ誘導）

## 7. コスト目安

- R2 無料枠: 10 GB-month / Class A・B の無料枠内想定
- ゲート: 500 MiB / ファイル、1 GiB / セッション
- Drive: ユーザーの Google ストレージ

## 8. 次フェーズ

- Phase 3: P2P（WebRTC / QR・超音波）
