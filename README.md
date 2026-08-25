# tools.yutok.dev

物理・実験向け Web ツールの GitHub Pages サイトです。

- **公開 URL:** https://tools.yutok.dev/
- **Pages 設定:** Custom domain `tools.yutok.dev`（branch `main` / root）

## 収録ツール

| パス | 内容 | 開発リポジトリ |
|------|------|----------------|
| [`/laue/`](./laue/) | X-ray Laue simulator（円筒 IP / Cylindrical） | [32Lwk/xray-laue-backscattering-simulator](https://github.com/32Lwk/xray-laue-backscattering-simulator) |
| [`/kek-mca/`](./kek-mca/) | KEK MCA 生データ（.mca / .csv、raw のみ） | — |
| [`/kek-mca/3D/`](./kek-mca/3D/) | He-3 検出器 PHITS 4dtrack 3D 可視化 | — |
| [`/equiv-concrete/`](./equiv-concrete/) | コンクリート組成→λ、KEK土壌→等価コンクリート厚 | — |
| [`/tunnel-ceiling-d200/`](./tunnel-ceiling-d200/) | トンネル天井深さ 200 cm：床中央 vs 壁際中性子スペクトル | [web-phits](https://github.com/32Lwk/web-phits) |

## `laue/` の更新

ローカル fork を `tools/xray-laue-backscattering-simulator/` に置いている場合:

```powershell
$env:PYTHONUTF8=1
pwsh -File tools/sync_laue_to_tools_site.ps1
```

`.bmp` など大きな試料画像はコピーしません。

## DNS（Cloudflare）

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `tools` | `32lwk.github.io` | DNS only 推奨 |
