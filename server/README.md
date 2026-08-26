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

## バックアップ (投稿データを手元に保存する)

スプレッドシートが消えたり荒らされたりしても戻せるように、`scores` シートの全行 (paths 込み) を
`node tools/backup.js` でダウンロードできます。ダンプ API はトークンを設定したときだけ有効になります。

1. Apps Script エディタ左の **歯車 (プロジェクトの設定) → スクリプト プロパティ → プロパティを追加** で
   `BACKUP_TOKEN` = 適当な長いランダム文字列 (例: `openssl rand -hex 24` の出力) を保存
2. **デプロイ → デプロイを管理 → 編集 → バージョン: 新バージョン** で再デプロイ (URL は変わりません)
3. 手元で実行:

   ```sh
   HUMAN_MAPF_BACKUP_TOKEN=<設定したトークン> node tools/backup.js
   ```

   `backups/scores-YYYYMMDD-HHMMSS.json` / `.csv` と、上書き更新される `scores-latest.json` / `.csv` が作られます
   (`backups/` は `.gitignore` 済み。別の場所に置きたいときは `--out <dir>`)。

- **トークンは公開リポジトリに書かないこと** (スクリプトプロパティに置くのはそのため)。漏れたら値を変えて再デプロイすれば無効化できます
- ダンプ API は読み取り専用です。トークンが漏れても書き換えはできませんが、プレイヤー名と経路が読めます
- **復旧の手順**: 新しいスプレッドシート + Apps Script を用意し、`scores` シートに `backups/scores-*.csv` を
  そのまま貼り付ける (1 行目がヘッダー `ts,stage,name,makespan,moves,paths`)。ts は数値、paths はカンマ区切りの文字列 1 セルです
- 自動化するなら `cron` などで上のコマンドを定期実行する、または Google ドライブ側でスプレッドシートを
  定期コピーする (Apps Script の時間主導トリガー + `DriveApp`) 方法もあります

## API

| リクエスト | 応答 |
|---|---|
| `GET ?stage=empty:10` | `{ ok, makespan: [entry…], moves: [entry…], players }` (各部門の上位 20) |
| `GET ?all=1` | `{ ok, best: { "empty:10": { makespan: entry, moves: entry, players }, … } }` |
| `GET ?dump=1&token=…&from=0&limit=500` | `{ ok, total, from, count, next, rows: [{ ts, stage, name, makespan, moves, paths }] }` (バックアップ用。`BACKUP_TOKEN` 必須) |
| `POST` (JSON `{ stage, name, paths }`) | `{ ok, score, makespan: { rank, total, improved, best, entries }, moves: {…} }` |

`entry = { name, makespan, moves, ts }`。`paths` は各エージェントの移動列 (`U/D/L/R/W`) の配列です。
