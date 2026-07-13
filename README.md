# tools.yutok.dev

物理・実験向け Web ツールの GitHub Pages サイトです。

- **公開 URL:** https://tools.yutok.dev/
- **Pages 設定:** Custom domain `tools.yutok.dev`（branch `main` / root）

## 収録ツール

| パス | 内容 | 開発リポジトリ |
|------|------|----------------|
| [`/laue/`](./laue/) | X-ray Laue simulator（円筒 IP / Cylindrical） | [32Lwk/xray-laue-backscattering-simulator](https://github.com/32Lwk/xray-laue-backscattering-simulator) |

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
