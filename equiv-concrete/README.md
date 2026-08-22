# 等価コンクリート換算

ブラウザだけで動く計算ツールです。公開 URL: https://tools.yutok.dev/equiv-concrete/

## できること

1. **コンクリート組成 → 平均自由行程 λ**  
   教材混合則 `Λ_i = 37·A^0.3`、`1/Λ = Σ w_i/Λ_i`、`λ = Λ/ρ`
2. **土厚・コンクリート厚 → 等価コンクリート厚**  
   筑波台地向け土壌プロファイル（深さ方向に ρ・Λ を層積算）

## 土壌プロファイル

| ID | 内容 | 根拠 |
|----|------|------|
| `tsukuba`（既定） | ローム 3.5 m → 常総 2.0 m → 下総 | 筑波台地の自然地盤。組成傾向は [J-Stage 地質調査所月報 52(8)](https://www.jstage.jst.go.jp/article/bullgsj/52/8/52_347/_pdf/-char/ja) |
| `asahi` | 舗装・埋土が厚い造成地 | [KuniJiban](https://www.kunijiban.pwri.go.jp/viewer/) つくば市旭 B1 相当 |
| `textbook` | ローム ≤4 m / 以深は常総 | 夏の学校教材の単純モデル |

## ファイル

- `index.html` — UI
- `app.js` — 計算ロジック
