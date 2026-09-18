# 転送機能の運用手順（Phase 1）

Cloudflare 上で `tools.yutok.dev/transfer*` を Worker に振り、R2 一時転送を有効化する手順です。

## 前提

- Cloudflare アカウント（ドメイン `yutok.dev` 管理）
- リポジトリ: `32Lwk/tools`
- Worker ソース: [`workers/transfer/`](../workers/transfer/)

## なぜ動かないか（よくある原因）

1. **Worker 未デプロイ** — `/transfer/api/*` が GitHub Pages の 404 になる
2. **DNS が灰雲（DNS only）** — Worker Routes は橙雲（Proxied）必須。公開 DNS が `185.199.x.x`（GitHub）のままなら未 Proxied
3. **KV / R2 未作成または ID 未記入** — multipart / メタデータが失敗する
4. **認証未設定** — 本番は `UPLOAD_GATE`（または Cloudflare Access）必須。未設定だと upload API は 503

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

誰でもアップロードできないよう、本番は **fail-closed** です。

### A. ゲートパスワード（推奨・即時）

```bash
cd workers/transfer
npx wrangler secret put UPLOAD_GATE
# 強いパスワードを入力
```

`/transfer/` の「ゲートパスワード」で認証すると HttpOnly Cookie が付き、12 時間有効です。

### B. Cloudflare Access（任意・追加）

1. Zero Trust → Access → Applications → Add Self-hosted
2. Domain: `tools.yutok.dev`、Path でアップロード系のみ保護
3. **保護する例:** `/transfer`, `/transfer/`, `/transfer/api/auth/*`, `/transfer/api/status`, `/transfer/api/r2/*`
4. **Bypass:** `/transfer/d/*`, `/transfer/api/dl/*`
5. Policy: 自分のアカウントのみ Allow
6. Worker secrets:

```bash
npx wrangler secret put ACCESS_AUD
npx wrangler secret put TEAM_DOMAIN
# 例: https://<team>.cloudflareaccess.com
# 任意: UPLOAD_ALLOW_EMAILS=you@example.com
```

ローカル開発のみ `.dev.vars` で `DEV_OPEN_UPLOAD=1`（コミットしない）。

## 4. Worker をデプロイ

```bash
cd workers/transfer
npx wrangler deploy
```

リポジトリルートの [`.assetsignore`](../.assetsignore) で大容量ファイルをアセット走査から除外しています。

## 5. R2 CORS（将来用）

現状の multipart は Worker 経由（32 MiB パート）です。将来 presigned 直 PUT にする場合はバケット CORS を設定します。

## 6. 動作確認

1. `https://tools.yutok.dev/transfer/api/status` が JSON（未認証なら 401）であること（Pages の HTML 404 ではない）
2. ゲートパスワードで認証後、小ファイルをアップロード
3. `/transfer/d/{slug}` を別ブラウザで開き、ファイル用パスワードで DL
4. 未認証・別ブラウザではアップロード UI がゲートのままであること
5. 同時に 2 本目を上げると 409 になること

## 7. コスト目安（ほぼ無料）

- R2 無料枠: 10 GB-month / Class A 100 万 / Class B 1000 万 / egress $0
- 15 GiB × 1 日 ≈ 0.5 GB-month → 保管料は無料枠内
- UI のコスト確認はアップロード前に必須

## 8. 次フェーズ

- Phase 2: Google Drive 保管モード
- Phase 3: P2P（WebRTC / QR・超音波）
