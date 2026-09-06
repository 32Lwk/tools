# tools.yutok.dev

汎用 Web ツールの公開サイトです（実験用ツールを含みます）。

- **公開 URL:** https://tools.yutok.dev/
- **Pages 設定:** Custom domain `tools.yutok.dev`（branch `main` / root）
- **転送 API:** `/transfer*` は Cloudflare Worker（R2 / Drive / P2P）。手順は [docs/transfer-ops.md](./docs/transfer-ops.md)、設計は [docs/transfer-plan.md](./docs/transfer-plan.md)

## 収録ツール

| パス | 内容 | 開発リポジトリ |
|------|------|----------------|
| [`/transfer/`](./transfer/) | 端末間ファイル転送（一時 R2 / Drive / P2P） | 本リポジトリ `workers/transfer` |
| [`/laue/`](./laue/) | X-ray Laue simulator（円筒 IP / Cylindrical） | [32Lwk/xray-laue-backscattering-simulator](https://github.com/32Lwk/xray-laue-backscattering-simulator) |
| [`/kek-mca/`](./kek-mca/) | KEK MCA 生データ（.mca / .csv、raw のみ） | — |
| [`/kek-mca/3D/`](./kek-mca/3D/) | He-3 検出器 PHITS 4dtrack 3D 可視化 | — |
| [`/equiv-concrete/`](./equiv-concrete/) | コンクリート組成→λ、KEK土壌→等価コンクリート厚 | — |
| [`/tunnel-ceiling-d200/`](./tunnel-ceiling-d200/) | トンネル天井深さ 200 cm：床中央 vs 壁際中性子スペクトル | [web-phits](https://github.com/32Lwk/web-phits) |
| [`/barcode/`](./barcode/) | JANバーコード生成 | — |

## `laue/` の更新

ローカル fork を `tools/xray-laue-backscattering-simulator/` に置いている場合:

```powershell
$env:PYTHONUTF8=1
pwsh -File tools/sync_laue_to_tools_site.ps1
```

`.bmp` など大きな試料画像はコピーしません。

## DNS（Cloudflare）

転送 Worker を同一オリジンで動かす場合は **Proxied（橙雲）** にします。

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `tools` | `32lwk.github.io` | **Proxied**（`/transfer*` → Worker、他は Pages） |

詳細は [docs/transfer-ops.md](./docs/transfer-ops.md)。
