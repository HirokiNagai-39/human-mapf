# オンラインランキングのセットアップ (Google Apps Script)

Human MAPF のランキングは、Google スプレッドシートを DB にした Google Apps Script (GAS) のウェブアプリで動きます。
無料・サーバー不要で、Google アカウントがあれば 5 分で用意できます。
送られてきた解はサーバー側で検証 (合法な移動・全員ゴール・衝突なし) してからスコアを計算するので、数値の改ざんはできません。

## 手順

1. [Google スプレッドシート](https://sheets.new) を新規作成し、名前を付ける (例: `Human MAPF leaderboard`)
2. メニュー **拡張機能 → Apps Script** を開く
3. エディタの `コード.gs` の中身をすべて消し、**`dist/leaderboard.gs`** (このリポジトリで `node build.js` を実行すると生成される、ソルバー込みの 1 ファイル) の内容を貼り付けて保存
4. 右上 **デプロイ → 新しいデプロイ** → 種類の選択で **ウェブアプリ** を選び、
   - 説明: 任意
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
   でデプロイ。初回はアクセス権の承認画面が出るので許可する
5. 表示された **ウェブアプリの URL** (`https://script.google.com/macros/s/.../exec`) をコピーし、
   `src/config.js` の `leaderboardUrl` に貼り付ける
6. `node build.js` → `git commit` → `git push` で公開ページに反映

動作確認: ウェブアプリ URL をブラウザで開くと `{"ok":true,"service":"human-mapf-leaderboard",...}` が返れば OK。

## 注意

- コードを変更したら、Apps Script 側で **デプロイ → デプロイを管理 → 編集 → バージョン: 新バージョン** で再デプロイしないと反映されません (URL は変わりません)
- スコアはシート `scores` に 1 行ずつ追記されます (ts, stage, name, makespan, moves, paths)。荒らしの行はシートで直接削除できます
- 同じ名前で複数回登録した場合、各部門 (makespan / 総移動距離) でその名前の自己ベストだけがランキングに載ります
- GAS の無料枠 (1 日あたりの実行時間など) は個人ゲームの規模なら十分です

## API

| リクエスト | 応答 |
|---|---|
| `GET ?stage=empty:10` | `{ ok, makespan: [entry…], moves: [entry…], players }` (各部門の上位 20) |
| `GET ?all=1` | `{ ok, best: { "empty:10": { makespan: entry, moves: entry, players }, … } }` |
| `POST` (JSON `{ stage, name, paths }`) | `{ ok, score, makespan: { rank, total, improved, best, entries }, moves: {…} }` |

`entry = { name, makespan, moves, ts }`。`paths` は各エージェントの移動列 (`U/D/L/R/W`) の配列です。
