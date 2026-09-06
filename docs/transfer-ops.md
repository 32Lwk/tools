# 転送機能の運用手順（Phase 1）

Cloudflare 上で `tools.yutok.dev/transfer*` を Worker に振り、R2 一時転送を有効化する手順です。

## 前提

- Cloudflare アカウント（ドメイン `yutok.dev` 管理）
- リポジトリ: `32Lwk/tools`
- Worker ソース: [`workers/transfer/`](../workers/transfer/)

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
| CNAME | `tools` | `32lwk.github.io` | **Proxied** |

`wrangler.jsonc` の `routes` により `tools.yutok.dev/transfer*` が Worker に入り、それ以外はオリジン（GitHub Pages）へフォールバックする想定です。  
橙雲にした直後は SSL / オリジン到達を確認してください。

## 3. Worker をデプロイ

```bash
cd workers/transfer
# 開発中はアップロード Access をスキップ
# wrangler.jsonc vars.DEV_OPEN_UPLOAD = "1"
npx wrangler deploy
```

本番では `DEV_OPEN_UPLOAD` を削除（または `"0"`）し、Access を必須にします。

任意で JWT の audience を Worker にも渡す場合:

```bash
npx wrangler secret put ACCESS_AUD
```

## 4. Cloudflare Access（Zero Trust）

アップロード UI / 変更系 API のみ保護します。

1. Zero Trust → Access → Applications → Add Self-hosted
2. Application domain: `tools.yutok.dev`
3. Path で保護する例:
   - `/transfer`（アップロード UI）
   - `/transfer/` 
   - `/transfer/api/status`
   - `/transfer/api/r2/*`
4. ** Bypass / 保護しない**（ダウンロード用）:
   - `/transfer/d/*`
   - `/transfer/api/dl/*`
5. Identity providers: **GitHub** および **One-time PIN（メール）**
6. Policy: 自分のアカウントのみ Allow

## 5. R2 CORS（ブラウザ直 PUT ではないが将来用）

現状の multipart は Worker 経由（32 MiB パート）です。将来 presigned 直 PUT にする場合はバケット CORS を設定します。

## 6. 動作確認

1. Access ログイン後に `https://tools.yutok.dev/transfer/` を開く
2. スラッグ・パスワード・小ファイルを選び、コスト確認にチェック
3. アップロード完了後の `/transfer/d/{slug}` を別ブラウザ（未ログイン）で開き、パスワードで DL
4. 同時に 2 本目を上げると 409 になること
5. 24 時間後（または cron）で削除されること

## 7. コスト目安（ほぼ無料）

- R2 無料枠: 10 GB-month / Class A 100 万 / Class B 1000 万 / egress $0
- 15 GiB × 1 日 ≈ 0.5 GB-month → 保管料は無料枠内
- UI のコスト確認はアップロード前に必須

## 8. 次フェーズ

- Phase 2: Google Drive 保管モード
- Phase 3: P2P（WebRTC / QR・超音波）
