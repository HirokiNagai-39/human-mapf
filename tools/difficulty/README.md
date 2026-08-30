# difficulty の計測手順

各ステージの difficulty (AtCoder 風の数値・色) は, プレイヤーの成績ではなくソルバーの計測値だけから
事前値 `d0` を決める (`src/difficulty.js`). プレイヤーの成績によるフィードバックはサーバー側
(`server/rating.gs`) が `d0` を事前値として行う. **一度公開した `d0` は再計算しない** (`tools/precompute.js`
と同じ方針. 変えると過去の performance がずれる). 新しいステージを追加したときだけ, そのステージを計測して追記する.

## 必要なもの

- LaCAM3 のビルド済みバイナリ (`LACAM3` 環境変数で場所を指定. 既定 `~/Desktop/lacam3/build/main`)
- Node 22 以上. 計測は 12 コアのマシンで 1 時間程度 (LaCAM3 60 秒 × 3 seed × 46 ステージ + LNS2 60 秒 × 8 seed)

## 手順

```sh
cd tools/difficulty
export DIFF_TMP=/tmp/human-mapf-difficulty        # 作業ファイル置き場 (省略時は tools/difficulty/lacam_tmp)
node measure_all.js                               # LaCAM3 単一スレッド 60 秒 × seed 0/1/2 → measure_all.json (一次集計)
node parse_measure.js                             # 生ログを読み直して 60 秒時点に揃える → measure_all.json (こちらを使う)
node probe_initial.js                             # LNS2 が初めて衝突 0 に到達するまでの時間 (seed 8 本) → probe_initial.json
node probe_narrow.js                              # 幅 1 通路を逆向きに共有するペア数 → probe_narrow.json
# tutorial:2 だけは下界が緩いので厳密解で補正する: {"optMakespan":7,"optMoves":12} を tutorial_opt.json に置く
mkdir -p ../../backups/difficulty-$(date +%Y%m%d) && cp *.json ../../backups/difficulty-$(date +%Y%m%d)/
cd ../.. && node tools/difficulty.js backups/difficulty-$(date +%Y%m%d)   # 未計算のステージだけ src/difficulty.js に追記
node tools/difficulty.js --check                                          # 既存エントリと式の整合を確認
node build.js
```

新しいマップだけ計測したいときは, 各スクリプトの `M.MAP_DEFS` のループを対象マップに絞る
(`probe_initial.js` の `ONLY` のように). `measure_all.json` などは既存のものとマージしてから
`tools/difficulty.js` に渡す (既存ステージの行は無視されるので, 混ざっていても問題ない).

## 注意

- LaCAM3 は `--no-multi-thread` だと時間制限 (60 秒) を大きく超えて走る (最大 280 秒). 比較は
  1 秒刻みの checkpoints から 60 秒時点に揃えて行う (`parse_measure.js`). マルチスレッドは実行のたびに
  結果が変わるので使わない.
- LNS2 の初期解到達は「1 秒以内に解けるか, 局所解に嵌って永久に解けないか」の二択で, 時間を延ばしても
  結果は変わらない (300 秒でも同じ成功率だった). 8 seed の対数平均で「嵌る確率」の指標として使う.
- 式と重みは `tools/difficulty.js` の先頭に書いてある. 重みの決め方 (アンカーへのフィット) は
  `backups/difficulty-20260830/fit_difficulty7.js` に残してある.
