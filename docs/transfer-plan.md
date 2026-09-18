# tools.yutok.dev 汎用化 + 端末間転送 実装計画

## 確定した要件

| 項目 | 決定 |
|------|------|
| サイト目的 | 汎用 Web ツール置き場（既存物理ツールは残す） |
| 一時転送 | R2、合計最大 10GB（無料枠）・並列無制限・保管 1 日、パスワード必須 |
| Drive | モード切替「一時（R2）」/「Drive 保管」 |
| アップロード認証 | Cloudflare Access（Zero Trust）および / または Google OAuth。ゲートパスワード UI は廃止（緊急 API のみ） |
| ダウンロード | リンクを知っていれば誰でも可。ただしパスワード必須 |
| URL | `tools.yutok.dev` 内完結（橙雲 + `/transfer*` → Worker） |
| 同時保管 | R2 は合計 10GB（無料枠）まで本数無制限。Drive は本数制限なし（ユーザー容量依存） |
| 予算 | ほぼ無料枠内。アップロード前にコスト確認 UI |
| P2P | ネットワーク WebRTC（大容量）+ オフライン（カメラ QR / 超音波、小容量）。Bluetooth なし |
| 置き場所 | 本リポジトリに `transfer/` と `workers/transfer/` |
| Google Drive | 個人アカウント OAuth。Drive 保管モードあり |

## アーキテクチャ

```mermaid
flowchart TB
  subgraph dns [Cloudflare DNS orange cloud]
    Domain["tools.yutok.dev"]
  end

  Domain -->|"/" static tools"| Pages["GitHub Pages origin"]
  Domain -->|"/transfer*"| Worker["Workers transfer"]

  subgraph access [Cloudflare Access]
    UploadGate["Upload UI and mutate APIs"]
  end

  UploadGate --> Worker
  Worker --> R2["R2 bucket"]
  Worker --> KV["KV metadata"]
  Worker --> DriveAPI["Google Drive API"]
  Worker --> DO["Durable Object signaling"]

  BrowserUp["Uploader browser"] -->|presigned multipart| R2
  BrowserUp -->|OAuth token refresh via Worker| DriveAPI
  BrowserDl["Downloader browser"] -->|password then stream| Worker
  BrowserA["Device A"] <-->|WebRTC media/data| BrowserB["Device B"]
  BrowserA snr DO
  BrowserB snr DO
```

### ホスティング方針（固定）

- GitHub Pages は現状維持（既存ツール・workflow はそのまま）
- Cloudflare で `tools` を **Proxied（橙雲）**
- Worker Routes: `tools.yutok.dev/transfer*` → transfer Worker
- それ以外は GitHub Pages へ（Cloudflare の origin / DNS-only から Proxied + カスタムオリジン、または Pages を origin にした Reverse Proxy 設定）
- DNS は README 記載の CNAME を橙雲に変更する手順をドキュメント化

### データパス（大容量必須）

- **15GB 本体は Worker を経由しない**
- R2: ブラウザ → multipart **presigned URL** で直接 PUT
- Drive: ブラウザ → Drive resumable upload（Worker は access token 発行とメタデータのみ）
- ダウンロード（R2）: Worker がパスワード検証後、R2 からストリーム、または短命署名 URL
- ダウンロード（Drive）: Worker がパスワード検証後、Drive API でストリーム（共有リンク直出しにしない）

## 機能設計

### 1. サイト文言の汎用化

- [`index.html`](../index.html): リード文を汎用化。`/transfer/` への導線を追加
- [`README.md`](../README.md): 目的・DNS（橙雲）・転送機能の概要を更新
- 既存ツール一覧は変更せず残す

### 2. 転送 UI（`transfer/`）

トップにモードタブ:

1. **一時（R2）**
2. **Drive 保管**
3. **P2P（ネットワーク）** — WebRTC
4. **P2P（オフライン）** — QR / 超音波

#### 一時（R2）フロー

1. Access 通過後、スラッグ（フォルダ名風、例 `backup-laptop`）・パスワード・ファイル選択
2. コスト確認パネル表示 → 「このコストで続行」チェック必須
3. 合計容量チェック（既存 R2 オブジェクト合計 + 新規 ≤ 10 GiB）
4. multipart アップロード → DL URL 表示: `https://tools.yutok.dev/transfer/d/{slug}`
5. 24h 後に lifecycle / cron で削除

#### Drive 保管フロー

1. Access 通過後、初回のみ Google OAuth（refresh token を Worker Secrets / 暗号化 KV に保存）
2. 転送用フォルダを選択または作成（「割り当て」）
3. スラッグ・パスワード・ファイル（または Drive 内既存ファイル選択）
4. Drive へアップロード or メタデータ登録
5. 同じ形式の DL URL。パスワード後に Worker が Drive からストリーム
6. Drive 側はユーザー管理の長期保管。サイト側メタデータの有効期限は設定可能（既定 1 日でリンク無効化。ファイル本体は Drive に残す）

#### コスト確認 UI（ほぼ無料）

表示内容:

- ファイルサイズ
- R2 換算: `GB × (1/30) GB-month`、無料枠 10 GB-month との比較
- Class A 概算（multipart パート数）
- 無料枠超過警告
- 「このコストで続行」必須

予算方針: **ほぼ無料**。合計 10 GiB まで並列保管可（無料枠）。警告は「異常に細かい multipart」などを検知したら出す。

#### ダウンロードページ

- `transfer/d/{slug}` — パスワード入力 → 検証成功でダウンロード開始
- スラッグはユーザー指定（`[a-z0-9-]{3,64}`）。衝突時は拒否

### 3. Worker API（`workers/transfer/`）

| メソッド | パス | Access | 内容 |
|----------|------|--------|------|
| GET | `/transfer/api/auth/methods` | 不要 | Access / Google の利用可否 |
| GET | `/transfer/api/auth/google/start` | 不要 | Google OAuth 開始 |
| GET | `/transfer/api/auth/google/callback` | 不要 | OAuth callback・session Cookie |
| GET | `/transfer/api/auth/me` | Cookie/JWT | 認証状態 |
| POST | `/transfer/api/r2/init` | 要 | スラッグ確保・multipart 開始・コスト試算レスポンス |
| POST | `/transfer/api/r2/complete` | 要 | multipart 完了・メタデータ確定 |
| DELETE | `/transfer/api/r2/abort` | 要 | 中断 |
| GET | `/transfer/api/status` | 要 | 使用容量・アクティブ一覧（合計 ≤ 10 GiB） |
| GET | `/transfer/api/drive/status` | 要 | Drive 接続・フォルダ |
| POST | `/transfer/api/drive/folder` | 要 | フォルダ作成/割当 |
| POST | `/transfer/api/drive/init` | 要 | access token + メタ確保 |
| POST | `/transfer/api/drive/complete` | 要 | driveFileId 確定 |
| POST | `/transfer/api/dl/{slug}/auth` | 不要 | パスワード検証・短命 DL トークン |
| GET | `/transfer/api/dl/{slug}/file` | 不要 | トークン付きストリーム（R2 / Drive） |
| WS/HTTP | `/transfer/api/signal/*` | 双方 | WebRTC シグナリング（DO） |
| 画面 | `/transfer/*` | アップロード系のみ Access 可 | 静的 UI。DL ページは Access 外 |

メタデータ（KV）: `slug`, `backend(r2|drive)`, `passwordHash`, `size`, `expiresAt`, `r2Key` または `driveFileId`/`driveFolderId`/`ownerEmail`, `originalName`

パスワード: `scrypt` または Web Crypto PBKDF2（Worker 内）。平文保存禁止。

Cron: 期限切れメタデータ削除 + R2 オブジェクト削除。

### 4. Cloudflare Access

- Application: `tools.yutok.dev/transfer` のうち **アップロード UI と mutate API**
- Bypass: `/transfer/d/*`, `/transfer/api/dl/*`, `/transfer/api/auth/methods`, `/transfer/api/auth/google/*`
- IdP: Google / GitHub / One-time email など（ダッシュボードで設定）
- アプリ側でも JWT 検証。加えて Google OAuth session でも upload 可

### 5. P2P

#### ネットワーク（WebRTC）

- 同一 `/transfer` の「P2P」タブ
- 紐付け: QR（セッション URL / コード表示を相手がカメラで読む）または短いコード
- シグナリング: Durable Object
- 大容量は DataChannel（チャンク）。TURN は Cloudflare Calls / 自前は初期は STUN のみ→必要なら後で TURN
- Access: 送信開始側のみ保護し、受信側はコード入力で参加可能にする（個人用途の利便性）

#### オフライン（QR + 超音波）

- 対象: 数 KB〜最大でも数百 KB 程度（テキスト・小さい鍵・短いファイル）
- 超音波: [ggwave](https://github.com/ggerganov/ggwave) WASM
- カメラ: QR 連続 / 単発でペイロード分割送信
- 15GB は対象外。UI で明示

### 6. リポジトリ構成

```
transfer/
  index.html          # モード切替 UI
  d/index.html        # ダウンロード（slug は query または Worker がパス解決）
  app.js / styles
  lib/cost.js         # R2 料金試算
  lib/r2-upload.js
  lib/drive.js
  lib/webrtc.js
  lib/offline-modem.js
workers/transfer/
  src/index.ts
  src/r2.ts
  src/drive.ts
  src/auth-password.ts
  src/signal-do.ts
  wrangler.toml
docs/transfer-plan.md # 本計画
docs/transfer-ops.md  # DNS・Access・Secrets 手順（実装時に作成）
```

### 7. シークレット・設定（実装時にユーザー作業）

- R2 bucket 作成・binding
- KV namespace
- `UPLOAD` 用は Access 側
- Google OAuth client ID/secret、refresh token 保存
- Wrangler デプロイ用 API トークン
- Cloudflare 橙雲 + Route 設定（ダッシュボード手順を `transfer-ops.md` に記載）

コードだけでは DNS / Access / OAuth コンソール作業は完了しない。リポジトリには設定テンプレートと手順を置く。

## 実装フェーズ

### Phase 1 — 土台（サイト + R2 一時転送）

1. 文言変更（`index.html`, `README.md`）
2. Worker スケルトン + R2 multipart init/complete + KV メタデータ
3. `transfer/` UI（R2・コスト確認・必須パスワード・スラッグ）
4. DL ページ（パスワード → ストリーム）
5. 合計 10 GiB 容量ガード + 24h 削除 cron
6. `docs/transfer-ops.md`（橙雲・Route・Access 手順）

### Phase 2 — Drive 保管モード（実装済み）

1. OAuth フロー（個人アカウント）— `/transfer/api/auth/google/*`
2. フォルダ割り当て — `/transfer/api/drive/folder`
3. resumable upload + パスワード付き DL プロキシ
4. UI モード切替（`transfer/` の Drive タブ）
5. アップロード認証 UI は Cloudflare Access + Google（ゲートパスワード UI は廃止）

### Phase 3 — P2P

1. WebRTC + DO シグナリング + QR ペアリング
2. オフライン QR / ggwave 超音波（小容量）

### Phase 4 — 仕上げ

1. Access ポリシー最終調整（upload のみ）
2. エラー・容量・期限の UX
3. 手動検証チェックリスト

## コスト見積（個人・ほぼ無料）

| 要素 | 目安 |
|------|------|
| R2 合計 ≤ 10 GiB × 1 日 | ≤ ≈ 0.33 GB-month ≪ 10 GB-month 無料枠 |
| R2 egress | $0 |
| Workers リクエスト | 個人利用なら無料枠内想定 |
| Drive | ユーザーの Google ストレージを消費（サイト課金なし） |
| Durable Objects | P2P シグナリングのみ。軽微 |

コスト UI は公式の Standard 料金（storage $0.015/GB-month、Class A/B）と無料枠を定数として表示する。

## 非スコープ

- Bluetooth
- サイト全体の Cloudflare Pages 移行
- 他人向けマルチテナント
- Drive の「リンクを知っている人は誰でも」を Google 側共有設定に任せる方式（必ずサイトのパスワードゲート経由）

## 検証方針

- 小ファイル（数 MB）で R2 往復・期限・合計容量超過（409）を確認
- パスワード誤り拒否
- コスト確認なしでは upload 開始できないこと
- Drive モードはテスト用小ファイルで OAuth〜DL
- P2P は同一 LAN の 2 ブラウザで WebRTC、オフラインは短いテキストの QR/超音波

大容量 15GB の実転送は環境・課金の都合で手動確認チェックリストに含め、CI では小ファイルのみとする。
