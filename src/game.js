/*
 * game.js — Human MAPF: 人力マルチエージェント経路計画パズル
 */
(function () {
  'use strict';
  const L = window.LNS2, M = window.MAPS, GIF = window.GIF;
  const LB = window.LB || { configured: () => false, sanitizeName: s => String(s || '').trim().slice(0, 16) };
  const $ = id => document.getElementById(id);

  // ============================================================ i18n
  const I18N = {
    ja: {
      'subtitle': '人力マルチエージェント経路計画',
      'tagline': '全員をぶつけずにゴールへ導く経路を、あなたの手で。makespan と total distance で MAPF ソルバー (LNS2) に挑もう。',
      'home.tutorialLink': '▼ 遊び方・衝突ルールを見る',
      'home.stages': 'ステージ選択',
      'home.howto': '遊び方',
      'sound.on': '🔊 効果音 ON', 'sound.off': '🔇 効果音 OFF',
      'btn.home': '← ホーム', 'btn.help': '? 遊び方', 'btn.close': '閉じる',
      'btn.judge': '▶ 採点 (Enter)', 'btn.stop': '■ 停止 (Esc)',
      'label.speed': '再生速度', 'unit.speed': '{0} step/s',
      'card.score': 'スコア', 'card.edit': '編集', 'card.agents': 'エージェント',
      'btn.save': '💾 経路を保存', 'btn.load': '📂 経路を読み込み',
      'save.done': '保存しました: {0}',
      'save.empty': 'まだ経路がありません',
      'save.loaded': '{0} 体の経路を読み込みました (makespan {1} / total distance {2})',
      'save.badFile': '読み込めませんでした: {0}',
      'save.notJson': 'ファイルの形式が違います',
      'save.otherStage': 'このファイルは別のステージ ({0}) のものです。今は {1} を開いています',
      'save.badN': 'エージェント数が合いません (ファイル {0} 体 / このステージ {1} 体)',
      'save.badMove': '{0} 体目の経路に、この盤面では通れない手があります',
      'save.mismatch': 'このファイルの開始位置が現在のステージと一致しません',
      'score.makespan': 'makespan (最大到達時刻)', 'score.moves': 'total distance (待機除く移動回数)', 'score.collisions': '衝突', 'score.done': 'ゴール到達',
      'btn.undo': '↶ Undo', 'btn.redo': '↷ Redo', 'btn.clearAgent': '選択の経路を消去', 'btn.clearAll': '全消去',
      'agents.unit': '{0} agents', 'agent.remain': '残り{0}',
      'agent.tip': 'エージェント {0}\n現在地 ({1}, {2}) → ゴール ({3}, {4})\n移動 {5} 手 / 最短 {6} 手{7}',
      'agent.tipOpt': '\n最短でゴールに到達', 'agent.tipOnTrack': '\n最短で移動中', 'agent.tipOver': '\n最短より {0} 手多い',
      'agent.optimal': '最短', 'agent.dist': '移動 {0} 手 / 最短 {1} 手',
      'card.agentsHint': '座標は (x, y)。<b>x は下方向 (行)、y は右方向 (列)</b>。左上が (0, 0)',
      'card.agentsLegend': '右端は<b>移動手数 / 最短手数</b>。盤面で選択中のマスの色は <b class="lg opt">緑=最短で移動中</b> · <b class="lg over">橙=遠回り</b> · <b class="lg">灰=未着手</b>',
      'stage.title': '{0} — {1} agents', 'status.stage': 'ステージ: {0} / {1} agents', 'status.genFail': 'ステージ生成に失敗: {0}',
      'ref.running': '参考解 (LNS2) 計算中… <span class="mono">{0} iter</span>',
      'ref.ok': '参考解 (LNS2): makespan <b class="mono">{0}</b> / total distance <b class="mono">{1}</b>',
      'ref.fail': '参考解 (LNS2): 見つかりませんでした',
      'lb': '下界: makespan <span class="mono">{0}</span> / total distance <span class="mono">{1}</span>',
      'best': 'ベスト: makespan <b class="mono">{0}</b> / total distance <b class="mono">{1}</b> {2}', 'best.none': 'ベスト: —',
      'judge.notDone': '不正解: ゴールに到達していないエージェントがあります ({0})',
      'judge.hasCol': '衝突があります ({0} 件, 最初は t={1}) — 再生します…',
      'judge.running': '採点中…',
      'judge.colFail': '不正解: t={0} で衝突 (× 印). 経路を修正してください.',
      'judge.ok': '正解! makespan {0} / total distance {1}', 'judge.refPart': ' (参考解 {0} / {1})', 'judge.lbPart': ' [下界 {0} / {1}]', 'judge.newBest': ' — ベスト更新!',
      'result.makespan': 'makespan', 'result.moves': 'total distance', 'result.refLb': '(参考 {0} の {2}%, 下界 {1})', 'result.newBest': '★ ベスト更新',
      'result.diamond': '両指標で参考解 (LNS2) と同等以上! 最高ランク', 'result.platinum': '両指標で参考解の 110% 以内. あと少しで DIAMOND',
      'result.gold': '両指標で参考解の 120% 以内', 'result.silver': '両指標で参考解の 130% 以内', 'result.bronze': '両指標で参考解の 150% 以内',
      'result.clear': '衝突なしで全員到達. 両指標を参考解の 150% 以内にすると BRONZE',
      'result.ranks': 'DIAMOND ≤100% · PLATINUM ≤110% · GOLD ≤120% · SILVER ≤130% · BRONZE ≤150% (参考解比, 両指標)',
      'confirm.clearAll': '全エージェントの経路を消去しますか?',
      'card.share': 'ランキング / 共有', 'btn.ranking': '🏆 ランキング', 'btn.gif': '🎞 GIF を保存', 'btn.tweet': '𝕏 にポスト',
      'lb.title': '🏆 ランキング — {0} / {1} agents', 'lb.makespan': '⏱️ makespan 部門', 'lb.moves': '👣 total distance 部門', 'lb.total': '👑 総合部門',
      'lb.totalNote': 'makespan × total distance の積が小さいほど上位',
      'lb.rank': '順位', 'lb.name': '名前', 'lb.loading': '読み込み中…', 'lb.error': 'ランキングを取得できませんでした ({0})',
      'lb.empty': 'まだ登録がありません。最初の 1 人になろう!', 'lb.players': '{0} 人が登録',
      'lb.notConfigured': 'オンラインランキングは未設定です (server/README.md を参照)',
      'lb.namePh': 'あなたの名前 (16 文字まで)', 'lb.submit': 'ランキングに登録', 'lb.submitting': '登録中…',
      'lb.result': '👑 総合 <b>{4} 位</b> / {5} 人 · ⏱️ makespan <b>{0} 位</b> / {1} 人 · 👣 total distance <b>{2} 位</b> / {3} 人', 'lb.notImproved': '(自己ベスト更新なし: 既存の記録で順位を表示)',
      'lb.submitFail': '登録できませんでした: {0}', 'lb.needName': '名前を入力してください',
      'champ.line': '1 位 — 👑 総合: {5} ({6}) · ⏱️ makespan: {0} ({1}) · 👣 total distance: {2} ({3}) · {4} 人', 'champ.none': 'まだ登録がありません',
      'champ.chipMs': 'makespan 部門 1 位: {0} (makespan {1})', 'champ.chipMv': 'total distance 部門 1 位: {0} (total distance {1})', 'champ.chipBoth': '両部門 1 位: {0} (makespan {1} / total distance {2})',
      'champ.chipTotal': '総合部門 1 位: {0} (makespan {1} × total distance {2} = {3})',
      'champ.chipAll': '全部門 1 位: {0}',
      'gif.notSolved': 'GIF にするには、全員ゴール・衝突なしの状態にしてください', 'gif.progress': 'GIF 作成中… {0}%', 'gif.done': 'GIF を保存しました: {0} ({1} MB)', 'gif.fail': 'GIF の作成に失敗: {0}',
      'tweet.text': 'Human MAPF「{0} {1} agents」{6}クリア! makespan {2}{3} / total distance {4}{5} #HumanMAPF', 'tweet.rank': ' ({0}位/{1}人)',
      'tweet.note': '𝕏 の投稿画面には、保存した GIF をドラッグ&ドロップで添付してください (自動添付はできません)',
      'map.tutorial': 'チュートリアル', 'map.empty': 'Empty', 'map.random': 'Random', 'map.room': 'Room', 'map.maze': 'Maze', 'map.warehouse': 'Warehouse',
      'map.warehouse_hard': 'warehouse-hard', 'map.hourglass': 'hourglass', 'map.bremen': 'Bremen',
      // アカウント
      'auth.login': 'ログイン', 'auth.register': '新規登録', 'auth.logout': 'ログアウト',
      'auth.titleLogin': 'ログイン', 'auth.titleRegister': '新規登録',
      'auth.name': 'プレイヤー名 (16 文字まで)', 'auth.password': 'パスワード (8 文字以上)',
      'auth.goLogin': 'ログイン', 'auth.goRegister': 'この名前で登録',
      'auth.notLoggedIn': '未ログイン',
      'auth.hintChecking': '確認中…',
      'auth.hintFree': 'この名前は使えます',
      'auth.hintTaken': 'この名前は登録済みです。あなたのものならログインしてください',
      'auth.hintLegacy': 'この名前ではすでに {0} 件の記録があります。あなたなら、ここで登録すると過去の記録をそのまま引き継げます',
      'auth.hintShortPw': 'パスワードは 8 文字以上にしてください',
      'auth.okLogin': 'ようこそ、{0} さん',
      'auth.okRegister': '登録しました。ようこそ、{0} さん',
      'auth.okClaim': '登録しました。過去の記録 {0} 件を引き継ぎました',
      'auth.errNoUser': 'その名前は登録されていません。新規登録してください',
      'auth.errLegacy': 'その名前はまだ登録されていません。「新規登録」から登録すると、過去の記録 {0} 件を引き継げます',
      'auth.errPassword': 'パスワードが違います (あと {0} 回)',
      'auth.errLocked': '失敗が続いたため一時的にロックされています。{0} 秒後にやり直してください',
      'auth.errTaken': 'その名前は登録済みです',
      'auth.errShortPw': 'パスワードは 8 文字以上にしてください',
      'auth.errName': '名前を入力してください',
      'auth.errFail': '失敗しました: {0}',
      'auth.errTimeout': '応答がありませんでした。登録自体は完了している場合があるので、「ログイン」から入れるか試してください',
      'auth.working': '通信中…',
      'auth.note': 'パスワードは<b>再発行できません</b>ので、忘れないようにしてください。ログイン状態はこのブラウザに保存されます。',
      'auth.needLogin': 'ランキングに登録するにはログインしてください',
      'auth.loginToSubmit': 'ログインして登録',
      'auth.sessionExpired': 'ログインし直してください',
      'wip.restored': '解きかけの経路を復元しました (やり直すには「全消去」)',
      // ホームのお知らせ
      'notice.date': '2026-08-26',
      'notice.title': 'ランキングの登録にログインが必要になりました',
      'notice.lead': 'なりすまし (他の人の名前での登録) を防ぐためです。これまで遊んでくださっていた方は、<b>これまでと同じ名前で登録すると、過去の記録をそのまま引き継げます</b>。',
      'notice.stepsH': '登録の手順',
      'notice.step1': '画面右上の <b>新規登録</b> を押す',
      'notice.step2': 'これまで使っていた名前と、新しいパスワード (8 文字以上) を入力する',
      'notice.step3': '<b>この名前で登録</b> を押す — 過去の記録は自動で引き継がれます',
      'notice.n1': '<b>{0} までは、登録しなくてもこれまでどおり投稿できます。</b>それ以降はログインが必要です',
      'notice.n2': '名前は<b>先着順</b>です。こんなに多くの方に遊んでいただけると思っておらず、過去の記録とご本人を紐付ける材料がないため、やむを得ずこの形にしました。申し訳ありません',
      'notice.n3': '万一 名前を他の人に取られてしまった場合はご連絡ください。登録し直せるように対応します',
      'notice.n4': 'パスワードは再発行できません。忘れないようにしてください',
      'notice.n5': '解きかけの経路がブラウザに自動保存されるようになりました。うっかりリロードしても続きから解けます',
      'notice.deadline': '8 月 27 日 23:59',
      'notice.loggedIn': '{0} としてログイン中です。このままランキングに登録できます。',
      'notice.close': '閉じる',
      'notice.reopen': 'お知らせ',
      'desc.tutorial': '障害物 2 つ。対角の 2 エージェントが入れ替わる練習', 'desc.empty': '空のマップ', 'desc.random': '約 10% が障害物', 'desc.room': '4×4 の部屋 ×16, 幅 1〜2 の通路でつながる', 'desc.maze': '幅 2 の通路の 6×6 迷路', 'desc.warehouse': '幅 1 × 長さ 5 の棚が 4 行 3 列, 通路幅 2',
      'desc.warehouse_hard': '棚が 6 行 4 列, 通路幅 1。すれ違えない',
      'desc.hourglass': '砂時計。中央は幅 1 の通路 1 マスだけ',
      'desc.bremen': 'ブレーメン旧市街',
      // tutorial
      't1.h': '1. 目的',
      't1.p': '丸 (エージェント) を、同じ番号・同じ色の四角 (ゴール) まで動かす<b>経路</b>を全員分作ります。時刻 t=0 から始まり、各時刻に全員が同時に 1 手ずつ動きます。全員が衝突なくゴールに着けば正解。<b>makespan</b> (全員がゴールに着く時刻) と <b>total distance</b> (総移動距離: 待機を除く移動回数の合計) が小さいほど高評価です。',
      't2.h': '2. 1 手の動き', 't2.move': '上下左右に 1 マス移動', 't2.wait': 'その場で待機 (経路上に ● が付く)', 't2.p': '斜め移動はできません。黒いマスは障害物です。来た道をすぐ戻る動き (A→B→A) は自由にできます (ドラッグで 1 つ前のマスに戻ると「取り消し」になるので、戻る移動を入れたいときは矢印キーを使うか、いったん離してからドラッグしてください)。',
      't3.h': '3. 衝突ルール (重要)', 't3.p1': '次の 2 つは<b>衝突</b>で、盤面に赤い <b>×</b> と時刻が表示され、採点は不正解になります。',
      't3.v0': '頂点衝突: 同じ時刻に同じマスへ', 't3.v1': '✗ 2 エージェントが同じマス', 't3.e0': '辺衝突 (逆走禁止): 隣り合う 2 エージェントが同じ辺を逆向きに同時に通る', 't3.e1': '✗ すれ違い・入れ替わりは不可',
      't3.p2': '一方、これは<b>衝突ではありません</b>:', 't3.f0': '前のエージェントが出ると同時に、そのマスへ入る', 't3.f1': '○ 追従 OK (列になって進める)',
      't3.p3': '幅 1 の通路で向かい合ったら、片方が<b>待機</b>や<b>脇道</b>で譲ります:', 't3.y0': 't=0: 2 は待機', 't3.y1': 't=1: 1 が脇へ', 't3.y2': 't=2: 2 が通る', 't3.y3': 't=3: 1 は待機して譲る',
      't4.h': '4. 経路が終わったエージェントはそのマスに留まる', 't4.p': '各エージェントは経路の最後の時刻以降、最後のマス (ゴール) に<b>留まり続けます</b>。そのマスを後から通ろうとすると頂点衝突です。ゴールに着いた後にさらに動くことはできます (通り道を空けるなど。最終的にゴールに戻っていれば OK)。まだ経路が続いているエージェントのゴールを通り抜けるのも OK です。',
      't4.ng': '✗ 経路が終わって留まっている 1 に突っ込む', 't4.ok': '○ 迂回する (または 2 を先に通す / 1 が一度どく)', 't4.lbl': '経路終了後は留まる',
      't5.h': '5. スコア', 't5.fig': '移動 → 待機 → 移動 → 移動: 到着 t=4, total distance 3',
      't5.p': '<b>makespan</b> = 一番遅いエージェントの到着時刻。<b>total distance</b> = 全員の「移動」の回数 (待機は数えない)。各ステージには MAPF ソルバー LNS2 の<b>参考解</b>があり、makespan と total distance の<b>両方</b>が参考解の何 % かでランクが決まります: <b>DIAMOND</b> 100% 以下 / <b>PLATINUM</b> 110% 以下 / <b>GOLD</b> 120% 以下 / <b>SILVER</b> 130% 以下 / <b>BRONZE</b> 150% 以下。<b>下界</b> (他の全員を無視した最短距離) にどこまで迫れるかも挑戦してみてください。',
      't6.h': '6. 操作',
      't6.drag': '<b>ドラッグ</b>', 't6.dragD': 'エージェントの先端 (丸) をドラッグすると、通ったマスが経路になります。途中で離してもそこまでの経路は残ります。同じドラッグ中に 1 つ前のマスへ戻ると取り消し。',
      't6.click': '<b>クリック</b>', 't6.clickD': '先端をクリックすると、その場で 1 時刻<b>待機</b>を追加。',
      't6.rclick': '<b>右クリック</b>', 't6.rclickD': '先端を右クリックで最後の 1 手を削除。',
      't6.keys': '<kbd>↑↓←→</kbd> / <kbd>WASD</kbd>', 't6.keysD': '選択中のエージェントを 1 マス動かす。<kbd>Space</kbd> / <kbd>Q</kbd> で待機。',
      't6.bs': '<kbd>Backspace</kbd> / <kbd>Delete</kbd>', 't6.bsD': '最後の 1 手を削除 / 選択中の経路を全消去。',
      't6.tab': '<kbd>Tab</kbd> / <kbd>1</kbd>〜<kbd>9</kbd>', 't6.tabD': 'エージェントの切り替え。ゴールや経路をクリックしても選択できます。',
      't6.undo': '<kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd>', 't6.undoD': 'Undo / Redo。',
      't6.enter': '<kbd>Enter</kbd> / <kbd>Esc</kbd>', 't6.enterD': '採点 (アニメーション再生) / 再生停止。',
      'fig.t': 't → t+1', 'fig.same': '同じマス', 'fig.swap': '入れ替わり', 'fig.follow': '後ろから追従',
    },
    en: {
      'subtitle': 'Multi-Agent Path Finding, solved by hand',
      'tagline': 'Route every agent to its goal without collisions — and beat the MAPF solver (LNS2) on makespan and total distance.',
      'home.tutorialLink': '▼ How to play / collision rules',
      'home.stages': 'Select a stage',
      'home.howto': 'How to play',
      'sound.on': '🔊 Sound ON', 'sound.off': '🔇 Sound OFF',
      'btn.home': '← Home', 'btn.help': '? How to play', 'btn.close': 'Close',
      'btn.judge': '▶ Submit (Enter)', 'btn.stop': '■ Stop (Esc)',
      'label.speed': 'Playback speed', 'unit.speed': '{0} step/s',
      'card.score': 'Score', 'card.edit': 'Edit', 'card.agents': 'Agents',
      'btn.save': '💾 Save routes', 'btn.load': '📂 Load routes',
      'save.done': 'Saved: {0}',
      'save.empty': 'No routes drawn yet',
      'save.loaded': 'Loaded routes for {0} agents (makespan {1} / total distance {2})',
      'save.badFile': 'Could not load: {0}',
      'save.notJson': 'Unexpected file format',
      'save.otherStage': 'This file is for a different stage ({0}); you are on {1}',
      'save.badN': 'Agent count does not match (file {0}, stage {1})',
      'save.badMove': 'Agent {0} has a move that is not possible on this board',
      'save.mismatch': 'The start positions in this file do not match this stage',
      'score.makespan': 'makespan (last arrival)', 'score.moves': 'total distance (moves only)', 'score.collisions': 'collisions', 'score.done': 'at goal',
      'btn.undo': '↶ Undo', 'btn.redo': '↷ Redo', 'btn.clearAgent': 'Clear selected path', 'btn.clearAll': 'Clear all',
      'agents.unit': '{0} agents', 'agent.remain': '{0} left',
      'agent.tip': 'Agent {0}\nAt ({1}, {2}) → goal ({3}, {4})\n{5} moves / shortest {6}{7}',
      'agent.tipOpt': '\nReached the goal by a shortest path', 'agent.tipOnTrack': '\nStill on a shortest path', 'agent.tipOver': '\n{0} more than the shortest',
      'agent.optimal': 'min', 'agent.dist': '{0} moves / shortest {1}',
      'card.agentsHint': 'Coordinates are (x, y): <b>x goes down (row), y goes right (column)</b>. (0, 0) is the top-left',
      'card.agentsLegend': 'On the right: <b>moves / shortest</b>. The highlighted cell is <b class="lg opt">green = still shortest</b> · <b class="lg over">orange = longer</b> · <b class="lg">grey = not started</b>',
      'stage.title': '{0} — {1} agents', 'status.stage': 'Stage: {0} / {1} agents', 'status.genFail': 'Failed to generate stage: {0}',
      'ref.running': 'Computing reference (LNS2)… <span class="mono">{0} iter</span>',
      'ref.ok': 'Reference (LNS2): makespan <b class="mono">{0}</b> / distance <b class="mono">{1}</b>',
      'ref.fail': 'Reference (LNS2): not available',
      'lb': 'Lower bound: makespan <span class="mono">{0}</span> / distance <span class="mono">{1}</span>',
      'best': 'Best: makespan <b class="mono">{0}</b> / distance <b class="mono">{1}</b> {2}', 'best.none': 'Best: —',
      'judge.notDone': 'Incorrect: some agents have not reached their goal ({0})',
      'judge.hasCol': '{0} collision(s), first at t={1} — replaying…',
      'judge.running': 'Judging…',
      'judge.colFail': 'Incorrect: collision at t={0} (marked ×). Fix the paths.',
      'judge.ok': 'Correct! makespan {0} / distance {1}', 'judge.refPart': ' (reference {0} / {1})', 'judge.lbPart': ' [lower bound {0} / {1}]', 'judge.newBest': ' — new best!',
      'result.makespan': 'makespan', 'result.moves': 'total distance', 'result.refLb': '({2}% of ref {0}, LB {1})', 'result.newBest': '★ New best',
      'result.diamond': 'Matched or beat the reference (LNS2) on both metrics — top rank!', 'result.platinum': 'Within 110% of the reference on both metrics. DIAMOND is close',
      'result.gold': 'Within 120% of the reference on both metrics', 'result.silver': 'Within 130% of the reference on both metrics', 'result.bronze': 'Within 150% of the reference on both metrics',
      'result.clear': 'All agents arrived without collisions. Get both metrics within 150% of the reference for BRONZE',
      'result.ranks': 'DIAMOND ≤100% · PLATINUM ≤110% · GOLD ≤120% · SILVER ≤130% · BRONZE ≤150% (of the reference, both metrics)',
      'confirm.clearAll': 'Clear the paths of all agents?',
      'card.share': 'Ranking / Share', 'btn.ranking': '🏆 Ranking', 'btn.gif': '🎞 Save GIF', 'btn.tweet': 'Post on 𝕏',
      'lb.title': '🏆 Ranking — {0} / {1} agents', 'lb.makespan': '⏱️ Makespan', 'lb.moves': '👣 Total distance', 'lb.total': '👑 Overall',
      'lb.totalNote': 'Ranked by makespan × total distance (lower is better)',
      'lb.rank': '#', 'lb.name': 'Name', 'lb.loading': 'Loading…', 'lb.error': 'Could not load the ranking ({0})',
      'lb.empty': 'No entries yet. Be the first!', 'lb.players': '{0} players',
      'lb.notConfigured': 'Online ranking is not configured (see server/README.md)',
      'lb.namePh': 'Your name (up to 16 chars)', 'lb.submit': 'Submit to ranking', 'lb.submitting': 'Submitting…',
      'lb.result': '👑 Overall: <b>#{4}</b> of {5} · ⏱️ Makespan: <b>#{0}</b> of {1} · 👣 Distance: <b>#{2}</b> of {3}', 'lb.notImproved': '(not a personal best: rank of your existing record)',
      'lb.submitFail': 'Submission failed: {0}', 'lb.needName': 'Please enter your name',
      'champ.line': '#1 — 👑 overall: {5} ({6}) · ⏱️ makespan: {0} ({1}) · 👣 distance: {2} ({3}) · {4} players', 'champ.none': 'No entries yet',
      'champ.chipMs': 'Makespan #1: {0} (makespan {1})', 'champ.chipMv': 'Total distance #1: {0} (distance {1})', 'champ.chipBoth': '#1 in both: {0} (makespan {1} / distance {2})',
      'champ.chipTotal': 'Overall #1: {0} (makespan {1} × distance {2} = {3})',
      'champ.chipAll': '#1 in all divisions: {0}',
      'gif.notSolved': 'To export a GIF, all agents must be at their goal with no collisions', 'gif.progress': 'Encoding GIF… {0}%', 'gif.done': 'GIF saved: {0} ({1} MB)', 'gif.fail': 'GIF export failed: {0}',
      'tweet.text': 'I solved Human MAPF "{0}, {1} agents" {6}: makespan {2}{3} / distance {4}{5} #HumanMAPF', 'tweet.rank': ' (#{0}/{1})',
      'tweet.note': 'Attach the saved GIF to the 𝕏 post by drag & drop (it cannot be attached automatically)',
      'map.tutorial': 'Tutorial', 'map.empty': 'Empty', 'map.random': 'Random', 'map.room': 'Room', 'map.maze': 'Maze', 'map.warehouse': 'Warehouse',
      'map.warehouse_hard': 'warehouse-hard', 'map.hourglass': 'hourglass', 'map.bremen': 'Bremen',
      // account
      'auth.login': 'Log in', 'auth.register': 'Sign up', 'auth.logout': 'Log out',
      'auth.titleLogin': 'Log in', 'auth.titleRegister': 'Sign up',
      'auth.name': 'Player name (up to 16 chars)', 'auth.password': 'Password (8+ chars)',
      'auth.goLogin': 'Log in', 'auth.goRegister': 'Claim this name',
      'auth.notLoggedIn': 'Not logged in',
      'auth.hintChecking': 'Checking…',
      'auth.hintFree': 'This name is available',
      'auth.hintTaken': 'This name is already registered. Log in if it is yours',
      'auth.hintLegacy': 'This name already has {0} submissions. If that is you, signing up here keeps all of them',
      'auth.hintShortPw': 'Password must be at least 8 characters',
      'auth.okLogin': 'Welcome back, {0}',
      'auth.okRegister': 'Registered. Welcome, {0}',
      'auth.okClaim': 'Registered. Your {0} earlier submissions are now linked to this account',
      'auth.errNoUser': 'No such player. Please sign up first',
      'auth.errLegacy': 'That name is not registered yet. Use "Sign up" to claim it and keep its {0} earlier submissions',
      'auth.errPassword': 'Wrong password ({0} attempts left)',
      'auth.errLocked': 'Too many failed attempts. Try again in {0} seconds',
      'auth.errTaken': 'That name is already registered',
      'auth.errShortPw': 'Password must be at least 8 characters',
      'auth.errName': 'Please enter a name',
      'auth.errFail': 'Failed: {0}',
      'auth.errTimeout': 'The server did not respond in time. It may have gone through anyway — try "Log in" with the same name and password',
      'auth.working': 'Working…',
      'auth.note': 'Your password <b>cannot be reset</b>, so do not lose it. Your login is stored in this browser.',
      'auth.needLogin': 'Log in to submit to the leaderboard',
      'auth.loginToSubmit': 'Log in to submit',
      'auth.sessionExpired': 'Please log in again',
      'wip.restored': 'Restored your work in progress (use "Clear all" to start over)',
      // home notice
      'notice.date': '2026-08-26',
      'notice.title': 'Submitting to the leaderboard now requires an account',
      'notice.lead': 'This is to stop anyone from submitting under someone else\u2019s name. If you have played before, <b>signing up with the same name keeps all of your earlier records</b>.',
      'notice.stepsH': 'How to sign up',
      'notice.step1': 'Press <b>Sign up</b> at the top right',
      'notice.step2': 'Enter the name you have been using and a new password (8+ characters)',
      'notice.step3': 'Press <b>Claim this name</b> — your earlier submissions come with it',
      'notice.n1': '<b>Until {0} you can still submit without an account.</b> After that, logging in is required',
      'notice.n2': 'Names are <b>first come, first served</b>. I did not expect this many players and kept nothing that ties past records to a person, so there is no way to verify ownership. Sorry about that',
      'notice.n3': 'If someone else takes your name, please get in touch and I will free it up for you',
      'notice.n4': 'Passwords cannot be reset, so please do not lose yours',
      'notice.n5': 'Your work in progress is now saved in the browser, so reloading no longer loses it',
      'notice.deadline': '23:59 on 27 Aug (JST)',
      'notice.loggedIn': 'Logged in as {0}. You can submit to the leaderboard as you are.',
      'notice.close': 'Close',
      'notice.reopen': 'Notice',
      'desc.tutorial': '2 obstacles. Two agents swap diagonally', 'desc.empty': 'Empty map', 'desc.random': 'About 10% obstacles', 'desc.room': '16 rooms of 4×4 joined by 1–2 wide doors', 'desc.maze': '6×6 maze with 2-wide corridors', 'desc.warehouse': '1×5 shelves in 4 rows × 3 columns, 2-wide aisles',
      'desc.warehouse_hard': '6 rows × 4 columns of shelves, 1-wide aisles — no passing',
      'desc.hourglass': 'An hourglass whose neck is a single cell',
      'desc.bremen': 'Bremen old town',
      't1.h': '1. Goal',
      't1.p': 'Build a <b>path</b> for every agent (circle) to the goal (square) with the same number and color. Time starts at t=0 and all agents move one step simultaneously at every time step. You succeed when everyone reaches their goal without collisions. Lower <b>makespan</b> (the time when everyone has arrived) and lower <b>total distance</b> (number of moves, waits excluded) score higher.',
      't2.h': '2. One step', 't2.move': 'Move 1 cell up/down/left/right', 't2.wait': 'Wait in place (shown as ● on the path)', 't2.p': 'No diagonal moves. Black cells are obstacles. Turning straight back (A→B→A) is allowed (dragging back onto the previous cell undoes the step, so use the arrow keys, or release and drag again, to enter a backward move).',
      't3.h': '3. Collision rules (important)', 't3.p1': 'The following two are <b>collisions</b>: a red <b>×</b> with the time appears on the board and the submission is rejected.',
      't3.v0': 'Vertex collision: same cell at the same time', 't3.v1': '✗ two agents in one cell', 't3.e0': 'Edge collision (no head-on passing): two agents traverse the same edge in opposite directions at the same time', 't3.e1': '✗ swapping / passing through each other',
      't3.p2': 'These, however, are <b>not</b> collisions:', 't3.f0': 'Enter a cell exactly as the agent ahead leaves it', 't3.f1': '○ following is OK (agents can move in a line)',
      't3.p3': 'When two agents face each other in a 1-wide corridor, one has to yield by <b>waiting</b> or stepping into a <b>side cell</b>:', 't3.y0': 't=0: 2 waits', 't3.y1': 't=1: 1 steps aside', 't3.y2': 't=2: 2 passes', 't3.y3': 't=3: 1 waits to let 2 pass',
      't4.h': '4. After its path ends, an agent stays where it is', 't4.p': 'After the last time step of its path, each agent <b>stays at its final cell (its goal)</b>. Passing through that cell later is a vertex collision. An agent may keep moving after reaching its goal (e.g. to make way), as long as it is back on the goal at the end. Passing through the goal of an agent whose path is still going is fine too.',
      't4.ng': '✗ running into 1, whose path has ended', 't4.ok': '○ detour (or let 2 pass first / 1 steps aside)', 't4.lbl': 'stays after path ends',
      't5.h': '5. Score', 't5.fig': 'move → wait → move → move: arrives at t=4, distance 3',
      't5.p': '<b>makespan</b> = arrival time of the slowest agent. <b>Total distance</b> = number of moves of all agents (waits do not count). Every stage has a <b>reference solution</b> by the MAPF solver LNS2, and your rank depends on how <b>both</b> metrics compare to it: <b>DIAMOND</b> ≤100% / <b>PLATINUM</b> ≤110% / <b>GOLD</b> ≤120% / <b>SILVER</b> ≤130% / <b>BRONZE</b> ≤150%. See how close you can get to the <b>lower bound</b> (shortest paths ignoring all other agents).',
      't6.h': '6. Controls',
      't6.drag': '<b>Drag</b>', 't6.dragD': 'Drag the tip (circle) of an agent; the cells you pass become its path. Releasing midway keeps the path so far. Moving back onto the previous cell during the same drag undoes that step.',
      't6.click': '<b>Click</b>', 't6.clickD': 'Click the tip to add one <b>wait</b> step.',
      't6.rclick': '<b>Right click</b>', 't6.rclickD': 'Right-click the tip to remove the last step.',
      't6.keys': '<kbd>↑↓←→</kbd> / <kbd>WASD</kbd>', 't6.keysD': 'Move the selected agent one cell. <kbd>Space</kbd> / <kbd>Q</kbd> to wait.',
      't6.bs': '<kbd>Backspace</kbd> / <kbd>Delete</kbd>', 't6.bsD': 'Remove the last step / clear the selected agent\'s path.',
      't6.tab': '<kbd>Tab</kbd> / <kbd>1</kbd>–<kbd>9</kbd>', 't6.tabD': 'Switch agents. Clicking a goal or a path also selects that agent.',
      't6.undo': '<kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd>', 't6.undoD': 'Undo / Redo.',
      't6.enter': '<kbd>Enter</kbd> / <kbd>Esc</kbd>', 't6.enterD': 'Submit (plays the animation) / stop playback.',
      'fig.t': 't → t+1', 'fig.same': 'same cell', 'fig.swap': 'swap', 'fig.follow': 'following',
    },
  };
  let LANG = 'ja';
  try { LANG = localStorage.getItem('human_mapf_lang') || ((navigator.language || 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en'); } catch (e) { }
  if (LANG !== 'ja' && LANG !== 'en') LANG = 'ja';
  function t(k) {
    let s = I18N[LANG][k]; if (s == null) s = I18N.ja[k]; if (s == null) return k;
    for (let i = 1; i < arguments.length; ++i) s = s.split('{' + (i - 1) + '}').join(arguments[i]);
    return s;
  }

  // ============================================================ sound
  const Sound = {
    ctx: null, enabled: true,
    ensure() {
      if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; } }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, type, gain, when, slideTo) {
      if (!this.enabled) return; const c = this.ensure(); if (!c) return;
      const t0 = c.currentTime + (when || 0);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.15, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    },
    step() { this.tone(660, 0.05, 'square', 0.05); },
    wait() { this.tone(330, 0.07, 'triangle', 0.08); },
    undo() { this.tone(440, 0.08, 'sine', 0.08, 0, 220); },
    select() { this.tone(880, 0.04, 'sine', 0.06); },
    goal() { this.tone(880, 0.12, 'sine', 0.12, 0, 1760); },
    tick() { this.tone(1200, 0.02, 'square', 0.02); },
    error() { this.tone(140, 0.35, 'sawtooth', 0.15, 0, 90); this.tone(110, 0.35, 'square', 0.08, 0.05, 70); },
    fanfare() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.14, i * 0.12)); this.tone(1319, 0.5, 'triangle', 0.14, 0.5); },
    gold() { this.fanfare(); [1047, 1319, 1568, 2093].forEach((f, i) => this.tone(f, 0.3, 'sine', 0.1, 0.9 + i * 0.1)); },
  };

  // ============================================================ state
  const S = {
    mapId: 'tutorial', N: 2, seed: 0,
    map: null, G: null, starts: [], goals: [], paths: [], dist: [],
    sel: -1, drag: null, hover: -1,
    undo: [], redo: [],
    ref: null, refState: 'none', solver: null, refPaths: null, lb: null,
    mode: 'edit', anim: null, speed: 3,
    collisions: null, metrics: null, best: null,
    cell: 32, ox: 0, oy: 0,
    lanes: null, // Map(edgeKey -> [agent ids])
    lastResult: null, gifBusy: false, champs: null, champsAt: 0,
  };

  const canvas = $('board'); let ctx = canvas.getContext('2d');

  // エージェントごとの distance 下界の達成状況。盤面の着色と一覧の表示で共有する
  const STATUS_RGB = { opt: '47,125,50', over: '178,106,0', todo: '119,119,119' };   // 緑 / 橙 / 灰
  function agentStatus(i) {
    const h = head(i), isDone = h === S.goals[i];
    const lb = S.dist[i][S.starts[i]];      // start から goal への最短手数 = 下界
    const rest = S.dist[i][h];              // 現在地から goal までの最短手数
    const mv = L.pathMoves(S.paths[i]);     // 待機を除いた移動回数
    // ここまでの移動 + 残りの最短 が下界と等しければ、まだ最短を保っている
    const onTrack = lb >= 0 && rest >= 0 && mv + rest === lb;
    const kind = (!isDone && mv === 0) ? 'todo' : onTrack ? 'opt' : 'over';
    return { isDone, lb, rest, mv, onTrack, kind, rgb: STATUS_RGB[kind] };
  }

  function agentColor(i, alpha) { const h = (i * 137.508) % 360; return `hsla(${h}, 70%, 50%, ${alpha == null ? 1 : alpha})`; }
  function cellXY(c) { return [c % S.map.w, Math.floor(c / S.map.w)]; }
  function cellCenter(c) { const [x, y] = cellXY(c); return [S.ox + (x + 0.5) * S.cell, S.oy + (y + 0.5) * S.cell]; }
  function head(i) { return S.paths[i][S.paths[i].length - 1]; }
  function isAdj(a, b) { const d = Math.abs(a - b); return (d === 1 && Math.floor(a / S.map.w) === Math.floor(b / S.map.w)) || d === S.map.w; }
  // ---- 解きかけの経路をこのブラウザに保存する (リロードや誤操作で失われないように)
  function wipKey(mapId, N) { return `human_mapf_wip:${mapId}:${N}`; }
  let wipTimer = null;
  function saveWip() {
    if (!S.map || S.mode !== 'edit') return;
    if (wipTimer) clearTimeout(wipTimer);
    wipTimer = setTimeout(() => {
      try {
        if (!S.paths.some(p => p.length > 1)) { localStorage.removeItem(wipKey(S.mapId, S.N)); return; }
        localStorage.setItem(wipKey(S.mapId, S.N), JSON.stringify({ t: Date.now(), paths: S.paths.map(p => encodePath(p)) }));
      } catch (e) { }
    }, 400);
  }
  // 保存した経路を復元する. 少しでもおかしければ捨てて初期状態に戻す
  function loadWip(mapId, N, starts, map) {
    let d;
    try { d = JSON.parse(localStorage.getItem(wipKey(mapId, N)) || 'null'); } catch (e) { return null; }
    if (!d || !Array.isArray(d.paths) || d.paths.length !== starts.length) return null;
    const out = [];
    for (let i = 0; i < starts.length; ++i) {
      const str = String(d.paths[i]);
      if (/[^UDLRW]/.test(str)) return null;
      let c = starts[i]; const p = [c];
      for (const ch of str) {
        const x = c % map.w;
        if (ch === 'R') { if (x === map.w - 1) return null; c += 1; }
        else if (ch === 'L') { if (x === 0) return null; c -= 1; }
        else if (ch === 'D') c += map.w;
        else if (ch === 'U') c -= map.w;
        if (c < 0 || c >= map.w * map.h || !map.free[c]) return null;
        p.push(c);
      }
      out.push(p);
    }
    return out.some(p => p.length > 1) ? out : null;
  }

  function bestKey(mapId, N) { return `human_mapf_best:${mapId}:${N}`; }
  function readBest(mapId, N) { try { return JSON.parse(localStorage.getItem(bestKey(mapId, N)) || 'null'); } catch (e) { return null; } }
  function mapName(id) { return t('map.' + id); }

  // ============================================================ stage
  function loadStage(mapId, N) {
    S.mapId = mapId; S.N = N; S.seed = M.stageSeed(mapId, N);
    S.map = M.getMap(mapId);
    S.G = L.buildGraph(S.map);
    const ins = L.generateInstance(S.G, N, S.seed);
    S.starts = ins.starts; S.goals = ins.goals;
    S.dist = S.goals.map(g => L.bfsDist(S.G, g));
    S.paths = S.starts.map(s => [s]);
    const wip = loadWip(mapId, N, S.starts, S.map);
    if (wip) S.paths = wip;
    S.sel = N > 0 ? 0 : -1; S.drag = null;
    S.undo = []; S.redo = [];
    S.mode = 'edit'; S.anim = null;
    S.ref = null; S.refPaths = null;
    S.best = readBest(mapId, N);
    S.lastResult = null;
    startReference();
    updateChampInfo();
    layout(); recompute(); renderAll();
    setStatus(wip ? t('wip.restored') : t('status.stage', mapName(mapId), N));
    saveMsg('');
  }

  // 埋め込み参考解 (src/reference.js, tools/precompute.js で生成). 無ければその場で LNS2 を実行
  function decodePath(start, str, w) {
    const p = [start]; let c = start;
    for (const ch of str) { c += ch === 'R' ? 1 : ch === 'L' ? -1 : ch === 'D' ? w : ch === 'U' ? -w : 0; p.push(c); }
    return p;
  }
  function loadEmbeddedReference() {
    const R = window.REFERENCE && window.REFERENCE[`${S.mapId}:${S.N}`];
    if (!R) return false;
    // インスタンスが一致するか検証 (生成コードが変わっていたら使わない)
    if (R.starts.length !== S.N || R.starts.some((v, i) => v !== S.starts[i]) || R.goals.some((v, i) => v !== S.goals[i])) return false;
    const paths = R.paths.map((str, i) => decodePath(S.starts[i], str, S.map.w));
    if (paths.some((p, i) => p[p.length - 1] !== S.goals[i] || p.some(c => !S.map.free[c]))) return false;
    if (L.findCollisions(paths, S.G.V, false).count !== 0) return false;
    const m = L.metrics(paths);
    S.ref = { makespan: m.makespan, moves: m.moves }; S.refPaths = paths; S.refState = 'ok';
    S.lb = R.lb;
    return true;
  }

  function startReference() {
    if (loadEmbeddedReference()) { updateRefPanel(); return; }
    S.refState = 'running';
    S.solver = new L.Solver(S.G, S.starts, S.goals, S.seed);
    S.solver.begin(8000);
    S.lb = S.solver.lowerBound;
    const mine = S.solver;
    const tick = () => {
      if (S.solver !== mine) return;
      const done = mine.step(25);
      if (!done) { updateRefPanel(); requestAnimationFrame(tick); return; }
      const r = mine.result();
      S.solver = null;
      if (r.ok) { S.ref = { makespan: r.makespan, moves: r.moves }; S.refPaths = r.paths; S.refState = 'ok'; }
      else { S.ref = null; S.refState = 'fail'; }
      S.lb = r.lowerBound;
      updateRefPanel(); draw();
    };
    requestAnimationFrame(tick);
  }

  // ============================================================ edit ops
  function snapshot() { S.undo.push(S.paths.map(p => p.slice())); if (S.undo.length > 300) S.undo.shift(); S.redo = []; }
  function doUndo() { if (!S.undo.length || S.mode !== 'edit') return; S.redo.push(S.paths.map(p => p.slice())); S.paths = S.undo.pop(); Sound.undo(); recompute(); renderAll(); }
  function doRedo() { if (!S.redo.length || S.mode !== 'edit') return; S.undo.push(S.paths.map(p => p.slice())); S.paths = S.redo.pop(); Sound.step(); recompute(); renderAll(); }

  function pushStep(i, c, silent) {
    const p = S.paths[i], h = p[p.length - 1];
    if (c !== h && !isAdj(h, c)) return false;
    if (!S.map.free[c]) return false;
    p.push(c);
    if (!silent) { if (c === h) Sound.wait(); else Sound.step(); if (c === S.goals[i] && c !== h) Sound.goal(); }
    return true;
  }
  function popStep(i) { const p = S.paths[i]; if (p.length > 1) { p.pop(); return true; } return false; }
  function select(i) { if (S.sel !== i) { S.sel = i; Sound.select(); renderAll(); } }

  // ============================================================ compute
  function edgeKey(a, b) { return a < b ? a * S.G.V + b : b * S.G.V + a; }
  // 同じ辺 (無向) を使うエージェントにレーン番号を割り当て, 経路が重ならないようにずらす
  function computeLanes() {
    const lanes = new Map();
    const add = (paths) => {
      for (let i = 0; i < paths.length; ++i) {
        const p = paths[i]; const seen = new Set();
        for (let k = 1; k < p.length; ++k) {
          if (p[k] === p[k - 1]) continue;
          const key = edgeKey(p[k - 1], p[k]);
          if (seen.has(key)) continue; seen.add(key);
          let arr = lanes.get(key); if (!arr) { arr = []; lanes.set(key, arr); }
          if (!arr.includes(i)) arr.push(i);
        }
      }
    };
    add(S.paths);
    S.lanes = lanes;
  }
  function recompute() {
    S.collisions = L.findCollisions(S.paths, S.G.V, true);
    S.metrics = L.metrics(S.paths);
    computeLanes();
    updatePanel();
    saveWip();
  }

  // ============================================================ layout / draw
  function layout() {
    const wrap = $('board-wrap');
    const availW = wrap.clientWidth - 8, availH = wrap.clientHeight - 8;
    const cs = Math.max(12, Math.min(56, Math.floor(Math.min(availW / S.map.w, availH / S.map.h))));
    S.cell = cs;
    const W = cs * S.map.w, H = cs * S.map.h;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.ox = 0; S.oy = 0;
  }

  function drawBoard() {
    const { w, h, free } = S.map, cs = S.cell;
    ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, w * cs, h * cs);
    ctx.fillStyle = '#3b3a37';
    for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) if (!free[y * w + x]) ctx.fillRect(S.ox + x * cs, S.oy + y * cs, cs, cs);
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; ++x) { ctx.moveTo(S.ox + x * cs + 0.5, S.oy); ctx.lineTo(S.ox + x * cs + 0.5, S.oy + h * cs); }
    for (let y = 0; y <= h; ++y) { ctx.moveTo(S.ox, S.oy + y * cs + 0.5); ctx.lineTo(S.ox + w * cs, S.oy + y * cs + 0.5); }
    ctx.stroke();
  }

  function drawGoals() {
    const cs = S.cell;
    for (let i = 0; i < S.N; ++i) {
      const [cx, cy] = cellCenter(S.goals[i]); const r = cs * 0.36;
      ctx.lineWidth = i === S.sel ? 3 : 2; ctx.strokeStyle = agentColor(i, 0.9); ctx.fillStyle = agentColor(i, 0.12);
      ctx.beginPath(); ctx.rect(cx - r, cy - r, 2 * r, 2 * r); ctx.fill(); ctx.stroke();
      ctx.fillStyle = agentColor(i, 0.9); ctx.font = `${Math.max(8, cs * 0.34)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cx, cy + 1);
    }
  }

  // 辺 (a-b) 上でエージェント i に割り当てられた垂直方向オフセット (px)
  function laneOffset(i, a, b) {
    const arr = S.lanes && S.lanes.get(edgeKey(a, b));
    if (!arr || arr.length <= 1) return 0;
    const k = arr.indexOf(i); if (k < 0) return 0;
    const spacing = Math.min(S.cell * 0.14, (S.cell * 0.7) / arr.length);
    return (k - (arr.length - 1) / 2) * spacing;
  }

  function drawPath(path, i, alpha, width, dashed) {
    if (path.length < 2) return;
    const cs = S.cell;
    ctx.strokeStyle = agentColor(i, alpha); ctx.fillStyle = agentColor(i, alpha);
    ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    let lastOff = [0, 0];
    for (let k = 1; k < path.length; ++k) {
      const a = path[k - 1], b = path[k];
      if (a === b) {
        // 待機マーク (直前の辺のオフセット位置に)
        const [x, y] = cellCenter(a);
        ctx.beginPath(); ctx.arc(x + lastOff[0], y + lastOff[1], Math.max(2, cs * 0.09), 0, Math.PI * 2); ctx.fill();
        continue;
      }
      const off = laneOffset(i, a, b);
      const [x1, y1] = cellCenter(a), [x2, y2] = cellCenter(b);
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
      const ox = -uy * off, oy = ux * off; // 進行方向に垂直
      ctx.setLineDash(dashed ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(x1 + ox, y1 + oy); ctx.lineTo(x2 + ox, y2 + oy); ctx.stroke();
      // 進行方向の矢じり (辺の中点)
      const mx = (x1 + x2) / 2 + ox, my = (y1 + y2) / 2 + oy, ah = Math.max(3, cs * 0.14);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(mx + ux * ah * 0.6, my + uy * ah * 0.6);
      ctx.lineTo(mx - ux * ah * 0.5 - uy * ah * 0.55, my - uy * ah * 0.5 + ux * ah * 0.55);
      ctx.lineTo(mx - ux * ah * 0.5 + uy * ah * 0.55, my - uy * ah * 0.5 - ux * ah * 0.55);
      ctx.closePath(); ctx.fill();
      lastOff = [ox, oy];
    }
    ctx.setLineDash([]);
  }

  function drawAgent(x, y, i, r, label, sub) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = agentColor(i, 1); ctx.fill();
    ctx.lineWidth = i === S.sel ? 3 : 1.5; ctx.strokeStyle = i === S.sel ? '#111' : 'rgba(255,255,255,0.9)'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(8, r * 0.95)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 1);
    if (sub != null) {
      ctx.fillStyle = '#222'; ctx.font = `${Math.max(8, S.cell * 0.28)}px sans-serif`;
      const ly = y - r - S.cell * 0.18;
      ctx.fillText(sub, x, ly < S.cell * 0.2 ? y + r + S.cell * 0.22 : ly);
    }
  }

  function drawX(x, y, size, label) {
    ctx.strokeStyle = '#e02020'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size); ctx.moveTo(x + size, y - size); ctx.lineTo(x - size, y + size); ctx.stroke();
    if (label != null) {
      ctx.fillStyle = '#e02020'; ctx.font = `bold ${Math.max(8, S.cell * 0.3)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x + size + S.cell * 0.22, y - size);
    }
  }

  function drawCollisions(maxT) {
    if (!S.collisions) return;
    const seen = new Set();
    for (const col of S.collisions.list) {
      if (maxT != null && col.t > maxT) continue;
      let x, y;
      if (col.type === 'vertex') { [x, y] = cellCenter(col.cell); }
      else { const a = cellCenter(col.cell), b = cellCenter(col.cell2); x = (a[0] + b[0]) / 2; y = (a[1] + b[1]) / 2; }
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (seen.has(key)) continue; seen.add(key);
      drawX(x, y, S.cell * 0.3, 't=' + col.t);
    }
  }

  function draw() {
    if (!S.map) return;
    drawBoard();
    const cs = S.cell;
    if (S.mode === 'edit') {
      // 選択中のエージェントがいるマスとゴールのマスを、そのエージェントの色で塗る
      if (S.sel >= 0) {
        const st = agentStatus(S.sel);      // 緑 = 最短で到達 / 橙 = 遠回り / 灰 = 未到達
        const tint = (c, alpha) => {
          const [x, y] = cellXY(c);
          ctx.fillStyle = `rgba(${st.rgb},${alpha})`;
          ctx.fillRect(S.ox + x * cs, S.oy + y * cs, cs, cs);
        };
        tint(S.goals[S.sel], 0.18);
        tint(head(S.sel), 0.34);
      }
      drawGoals();
      for (let i = 0; i < S.N; ++i) if (i !== S.sel) drawPath(S.paths[i], i, 0.55, 3, false);
      if (S.sel >= 0) drawPath(S.paths[S.sel], S.sel, 0.95, 5, false);
      for (let i = 0; i < S.N; ++i) {
        if (S.paths[i].length === 1) continue;
        const [x, y] = cellCenter(S.starts[i]);
        ctx.beginPath(); ctx.arc(x, y, cs * 0.14, 0, Math.PI * 2); ctx.fillStyle = agentColor(i, 0.6); ctx.fill();
      }
      drawCollisions(null);
      const order = []; for (let i = 0; i < S.N; ++i) if (i !== S.sel) order.push(i); if (S.sel >= 0) order.push(S.sel);
      for (const i of order) {
        const [x, y] = cellCenter(head(i));
        const tt = S.paths[i].length - 1, done = head(i) === S.goals[i];
        drawAgent(x, y, i, cs * 0.36, String(i + 1), 't=' + tt + (done ? ' ✓' : ''));
      }
    } else {
      drawGoals();
      const a = S.anim, tt = a.t, t0 = Math.floor(tt), fr = tt - t0, P = a.paths;
      for (let i = 0; i < S.N; ++i) drawPath(P[i], i, 0.25, 2, a.isRef);
      if (a.failT != null && tt >= a.failT) drawCollisions(a.failT);
      for (let i = 0; i < S.N; ++i) {
        const c0 = L.posAt(P[i], t0), c1 = L.posAt(P[i], t0 + 1);
        const p0 = cellCenter(c0), p1 = cellCenter(c1);
        const ease = fr < 0.5 ? 2 * fr * fr : 1 - Math.pow(-2 * fr + 2, 2) / 2;
        drawAgent(p0[0] + (p1[0] - p0[0]) * ease, p0[1] + (p1[1] - p0[1]) * ease, i, cs * 0.36, String(i + 1), null);
      }
    }
  }
  function renderAll() { draw(); updatePanel(); }

  // ============================================================ panel
  function setStatus(msg, cls) { const e = $('status'); e.textContent = msg; e.className = 'status ' + (cls || ''); }

  function updateRefPanel() {
    const e = $('ref-info');
    if (S.refState === 'running') e.innerHTML = t('ref.running', S.solver ? S.solver._iter : 0);
    else if (S.refState === 'ok') e.innerHTML = t('ref.ok', S.ref.makespan, S.ref.moves);
    else if (S.refState === 'fail') e.innerHTML = t('ref.fail');
    else e.textContent = '';
    if (S.lb) $('lb-info').innerHTML = t('lb', S.lb.makespan, S.lb.moves);
  }

  function rankBadge(r) { return r ? `<span class="badge ${r}">${r.toUpperCase()}</span>` : ''; }

  // ランク: makespan と総移動距離の両方が参考解の何 % か (大きい方) で判定
  const RANKS = [['diamond', 1.0], ['platinum', 1.1], ['gold', 1.2], ['silver', 1.3], ['bronze', 1.5]];
  const RANK_ORDER = { diamond: 0, platinum: 1, gold: 2, silver: 3, bronze: 4, clear: 5 };
  function rankOf(m) {
    if (!S.ref) return { rank: 'clear', ratio: null, pm: null, pd: null };
    const rm = m.makespan / S.ref.makespan, rd = m.moves / S.ref.moves, worst = Math.max(rm, rd);
    let rank = 'clear';
    for (const [r, th] of RANKS) if (worst <= th + 1e-9) { rank = r; break; }
    return { rank, ratio: worst, pm: Math.round(rm * 100), pd: Math.round(rd * 100) };
  }
  // a が b (保存済みベスト) より良い記録か: ランク → 参考解比 → makespan → 総移動距離
  function betterRecord(a, b) {
    if (!b) return true;
    const ra = RANK_ORDER[a.rank] ?? 9, rb = RANK_ORDER[b.rank] ?? 9;
    if (ra !== rb) return ra < rb;
    if (a.ratio != null && b.ratio != null && Math.abs(a.ratio - b.ratio) > 1e-9) return a.ratio < b.ratio;
    return a.makespan < b.makespan || (a.makespan === b.makespan && a.moves < b.moves);
  }

  function updatePanel() {
    if (!S.metrics) return;
    const m = S.metrics;
    $('cur-makespan').textContent = m.makespan;
    $('cur-moves').textContent = m.moves;
    const nc = S.collisions ? S.collisions.count : 0;
    const col = $('cur-collisions'); col.textContent = nc; col.className = 'mono ' + (nc ? 'bad' : 'good');
    const done = S.paths.filter((p, i) => p[p.length - 1] === S.goals[i]).length;
    $('cur-done').textContent = `${done} / ${S.N}`;
    $('best-info').innerHTML = S.best ? t('best', S.best.makespan, S.best.moves, rankBadge(S.best.rank)) : t('best.none');
    const ul = $('agents'); ul.innerHTML = '';
    for (let i = 0; i < S.N; ++i) {
      const li = document.createElement('li');
      const h = head(i), tt = S.paths[i].length - 1, d = S.dist[i][h];
      const isDone = h === S.goals[i];
      const w = S.map.w;
      const hx = Math.floor(h / w), hy = h % w;                 // x は下方向 (行), y は右方向 (列)
      const g = S.goals[i], gx = Math.floor(g / w), gy = g % w;
      const st = agentStatus(i);
      const lb = st.lb, mv = st.mv;
      li.className = (i === S.sel ? 'sel ' : '') + (isDone ? 'done ' : '') + (S.collisions && S.collisions.conf[i] ? 'conf' : '');
      li.title = t('agent.tip', i + 1, hx, hy, gx, gy, mv, lb < 0 ? '∞' : lb,
        st.onTrack ? (st.isDone ? t('agent.tipOpt') : t('agent.tipOnTrack')) : t('agent.tipOver', mv + st.rest - lb));
      li.innerHTML = `<span class="dot" style="background:${agentColor(i)}"></span><span class="nm">${i + 1}</span>`
        + '<span class="ag">'
        +   `<span class="r1"><span class="co">(${hx},${hy})<i>→</i>(${gx},${gy})</span>${isDone ? '<span class="ok">✓</span>' : ''}</span>`
        +   `<span class="r2"><span class="mono">t=${tt}</span><span class="mono">${t('agent.remain', d < 0 ? '∞' : d)}</span>`
        +     `<span class="dl">${mv}/${lb < 0 ? '∞' : lb}</span></span>`
        + '</span>';
      li.onclick = () => select(i);
      ul.appendChild(li);
    }
    $('btn-undo').disabled = !S.undo.length; $('btn-redo').disabled = !S.redo.length;
    const solved = done === S.N && nc === 0 && S.N > 0;
    $('btn-gif').disabled = !solved || S.gifBusy || S.mode !== 'edit';
    $('btn-tweet').disabled = !S.lastResult;
    updateRefPanel();
  }

  // ============================================================ pointer
  function cellAt(ev) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left - S.ox) / S.cell), y = Math.floor((ev.clientY - r.top - S.oy) / S.cell);
    if (x < 0 || y < 0 || x >= S.map.w || y >= S.map.h) return -1;
    return y * S.map.w + x;
  }
  function agentHeadAt(c) {
    if (c < 0) return -1;
    if (S.sel >= 0 && head(S.sel) === c) return S.sel;
    for (let i = S.N - 1; i >= 0; --i) if (head(i) === c) return i;
    return -1;
  }
  function agentOnCell(c) {
    if (c < 0) return -1;
    for (let i = 0; i < S.N; ++i) if (S.goals[i] === c) return i;
    for (let i = 0; i < S.N; ++i) if (S.paths[i].includes(c)) return i;
    return -1;
  }

  canvas.addEventListener('pointerdown', ev => {
    if (S.mode !== 'edit' || ev.button === 2) return;
    Sound.ensure();
    const c = cellAt(ev), i = agentHeadAt(c);
    if (i >= 0) {
      select(i);
      snapshot();
      S.drag = { i, added: 0, moved: false, last: c };
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { }
    } else {
      const j = agentOnCell(c);
      if (j >= 0) select(j);
    }
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', ev => {
    if (S.mode !== 'edit') return;
    const c = cellAt(ev);
    S.hover = c;
    if (!S.drag) { canvas.style.cursor = agentHeadAt(c) >= 0 ? 'grab' : 'default'; return; }
    if (c < 0 || c === S.drag.last) return;
    const d = S.drag, i = d.i, p = S.paths[i], h = p[p.length - 1];
    if (c === h) { d.last = c; return; }
    // 同一ドラッグ内で追加した直前のマスに戻ったら取り消し
    if (d.added > 0 && p.length >= 2 && p[p.length - 2] === c) {
      popStep(i); d.added--; d.moved = true; Sound.undo(); d.last = c; recompute(); draw(); return;
    }
    let steps = null;
    if (isAdj(h, c) && S.map.free[c]) steps = [c];
    else { const bp = L.bfsPath(S.G, h, c, 8); if (bp) steps = bp.slice(1); }
    if (steps) {
      for (const s of steps) if (pushStep(i, s, true)) d.added++;
      Sound.step();
      if (head(i) === S.goals[i]) Sound.goal();
      d.moved = true; recompute();
    }
    d.last = c;
    draw();
  });

  // ドラッグ終了: 途中で離しても, そこまでに追加した経路はそのまま残る
  function endDrag(isClick) {
    if (!S.drag) return;
    const d = S.drag; S.drag = null; S.hover = -1;
    if (!d.moved && isClick) { pushStep(d.i, head(d.i)); recompute(); }   // クリック → 待機 1 手
    else if (!d.moved) S.undo.pop();                                        // 変化なし → スナップショット破棄
    renderAll();
  }
  canvas.addEventListener('pointerup', () => endDrag(true));
  canvas.addEventListener('pointercancel', () => endDrag(false));
  canvas.addEventListener('lostpointercapture', () => endDrag(false));
  canvas.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    if (S.mode !== 'edit' || S.drag) return;
    const c = cellAt(ev), i = agentHeadAt(c);
    if (i >= 0) { snapshot(); if (popStep(i)) Sound.undo(); else S.undo.pop(); recompute(); renderAll(); }
  });

  // ============================================================ keyboard
  window.addEventListener('keydown', ev => {
    if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA')) return;
    if (!$('game').classList.contains('show')) return;
    if (ev.key === 'Escape') { if (S.mode === 'play') stopAnim(); else { $('help').classList.remove('show'); $('ranking').classList.remove('show'); } return; }
    if (S.mode !== 'edit') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) doRedo(); else doUndo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); doRedo(); return; }
    if (ev.key === 'Tab') { ev.preventDefault(); if (S.N) select(((S.sel + (ev.shiftKey ? -1 : 1)) + S.N) % S.N); return; }
    if (/^[1-9]$/.test(ev.key)) { const k = +ev.key - 1; if (k < S.N) select(k); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); judge(); return; }
    if (S.sel < 0) return;
    const i = S.sel, h = head(i), w = S.map.w;
    const [hx, hy] = cellXY(h);
    let c = -1;
    if (ev.key === 'ArrowLeft' || ev.key === 'a') { if (hx > 0) c = h - 1; }
    else if (ev.key === 'ArrowRight' || ev.key === 'd') { if (hx < w - 1) c = h + 1; }
    else if (ev.key === 'ArrowUp' || ev.key === 'w') { if (hy > 0) c = h - w; }
    else if (ev.key === 'ArrowDown' || ev.key === 's') { if (hy < S.map.h - 1) c = h + w; }
    else if (ev.key === ' ' || ev.key === 'q') { c = h; }
    else if (ev.key === 'Backspace') { ev.preventDefault(); snapshot(); if (popStep(i)) Sound.undo(); else S.undo.pop(); recompute(); renderAll(); return; }
    else if (ev.key === 'Delete') { ev.preventDefault(); snapshot(); S.paths[i] = [S.starts[i]]; Sound.undo(); recompute(); renderAll(); return; }
    else return;
    ev.preventDefault();
    if (c < 0 || !S.map.free[c]) { Sound.error(); return; }
    snapshot(); pushStep(i, c); recompute(); renderAll();
  });

  // ============================================================ judge / animation
  function judge() {
    if (S.mode !== 'edit') return;
    Sound.ensure();
    if (S.drag) endDrag(false);
    recompute();
    const notDone = S.paths.map((p, i) => p[p.length - 1] === S.goals[i] ? -1 : i).filter(i => i >= 0);
    if (notDone.length) {
      Sound.error();
      setStatus(t('judge.notDone', notDone.map(i => i + 1).join(', ')), 'bad');
      select(notDone[0]);
      return;
    }
    const fail = S.collisions.count > 0;
    const failT = fail ? Math.min(...S.collisions.list.map(c => c.t)) : null;
    S.mode = 'play';
    S.anim = { t: 0, last: performance.now(), failT, end: fail ? failT : S.metrics.makespan, arrived: new Set(), paths: S.paths, isRef: false, makespan: S.metrics.makespan };
    $('btn-judge').disabled = true; $('btn-stop').disabled = false;
    setStatus(fail ? t('judge.hasCol', S.collisions.count, failT) : t('judge.running'), fail ? 'bad' : '');
    requestAnimationFrame(animTick);
  }

  function animTick(now) {
    const a = S.anim; if (!a || S.mode !== 'play') return;
    const dt = (now - a.last) / 1000; a.last = now;
    const prevT = a.t;
    a.t = Math.min(a.end, a.t + dt * S.speed);
    if (Math.floor(a.t) !== Math.floor(prevT)) Sound.tick();
    for (let i = 0; i < S.N; ++i) {
      const arriveT = L.trimPath(a.paths[i]).length - 1;
      if (!a.arrived.has(i) && a.t >= arriveT && arriveT > 0) { a.arrived.add(i); if (a.failT == null) Sound.goal(); }
    }
    $('anim-t').textContent = `t = ${a.t.toFixed(1)} / ${a.makespan}`;
    draw();
    if (a.t >= a.end) { finishAnim(); return; }
    requestAnimationFrame(animTick);
  }

  function finishAnim() {
    const a = S.anim;
    if (a.failT != null) {
      Sound.error(); draw();
      setStatus(t('judge.colFail', a.failT), 'bad');
      setTimeout(() => { if (S.mode === 'play') stopAnim(); }, 1500);
      return;
    }
    const m = S.metrics; const rk = rankOf(m), rank = rk.rank;
    if (rank === 'diamond' || rank === 'platinum') Sound.gold(); else Sound.fanfare();
    let msg = t('judge.ok', m.makespan, m.moves);
    if (S.ref) msg += t('judge.refPart', S.ref.makespan, S.ref.moves);
    if (S.lb) msg += t('judge.lbPart', S.lb.makespan, S.lb.moves);
    const prev = S.best;
    const better = betterRecord({ rank, ratio: rk.ratio, makespan: m.makespan, moves: m.moves }, prev);
    if (better) {
      S.best = { makespan: m.makespan, moves: m.moves, rank, ratio: rk.ratio };
      try { localStorage.setItem(bestKey(S.mapId, S.N), JSON.stringify(S.best)); } catch (e) { }
      msg += t('judge.newBest');
    }
    setStatus(msg, 'good');
    S.lastResult = { makespan: m.makespan, moves: m.moves, rank, paths: S.paths.map(p => encodePath(L.trimPath(p))), rankMakespan: null, rankMoves: null };
    showResult(rank, m, better, rk);
    setTimeout(() => { if (S.mode === 'play') stopAnim(); }, 800);
  }

  function stopAnim() {
    S.mode = 'edit'; S.anim = null;
    $('btn-judge').disabled = false; $('btn-stop').disabled = true; $('anim-t').textContent = '';
    renderAll();
  }

  function showResult(rank, m, better, rk) {
    const box = $('result');
    const refLb = (rv, lv, pct) => S.ref ? ` <span class="sub">${t('result.refLb', rv, lv, pct)}</span>` : '';
    const lbForm = lbFormHtml();
    box.innerHTML = `<div class="rank">${rank.toUpperCase()}</div>
      <div>${t('result.makespan')} <b class="mono">${m.makespan}</b>${refLb(S.ref && S.ref.makespan, S.lb && S.lb.makespan, rk.pm)}</div>
      <div>${t('result.moves')} <b class="mono">${m.moves}</b>${refLb(S.ref && S.ref.moves, S.lb && S.lb.moves, rk.pd)}</div>
      ${better ? `<div class="sub">${t('result.newBest')}</div>` : ''}
      <div class="sub">${t('result.' + rank)}</div>
      <div class="note">${t('result.ranks')}</div>
      ${lbForm}
      <div class="row"><button id="res-gif">${t('btn.gif')}</button><button id="res-tweet">${t('btn.tweet')}</button><button id="res-ranking">${t('btn.ranking')}</button></div>
      <div class="note">${t('tweet.note')}</div>
      <button id="result-close">${t('btn.close')}</button>`;
    box.className = 'result show ' + rank;
    $('result-close').onclick = () => { box.className = 'result'; };
    $('res-gif').onclick = () => exportGif();
    $('res-tweet').onclick = () => tweet();
    $('res-ranking').onclick = () => showRanking();
    wireResultForm();
  }

  // ログイン済みなら名前は固定表示 (騙れないので入力欄は出さない). 未ログインならログインへ誘導する
  function lbFormHtml() {
    if (!LB.configured()) return `<div class="lb-msg">${t('lb.notConfigured')}</div>`;
    if (!USER) return `<div class="lb-form"><button id="lb-login" class="primary">${t('auth.loginToSubmit')}</button></div><div id="lb-msg" class="lb-msg">${t('auth.needLogin')}</div>`;
    return `<div class="lb-form"><span class="who">${escapeHtml(USER.name)}</span><button id="lb-submit" class="primary">${t('lb.submit')}</button></div><div id="lb-msg" class="lb-msg"></div>`;
  }
  function wireResultForm() {
    if ($('lb-submit')) $('lb-submit').onclick = () => submitScore();
    if ($('lb-login')) $('lb-login').onclick = () => openAuth('login');
  }
  // ログイン状態が変わったら、開いている結果パネルのフォームを差し替える
  function refreshResultForm() {
    const holder = $('result').querySelector('.lb-form');
    if (!holder) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = lbFormHtml();
    const msg = $('result').querySelector('#lb-msg');
    holder.replaceWith(...wrap.childNodes);
    if (msg && $('result').querySelector('#lb-msg') !== msg) msg.remove();
    wireResultForm();
  }

  // ============================================================ ranking
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // ---- ログイン状態 (このブラウザに保存する). token はサーバーが発行した値
  const AUTH_KEY = 'human_mapf_auth';
  let USER = null;
  try { USER = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { USER = null; }
  if (USER && !(USER.name && USER.token)) USER = null;
  function setUser(u) {
    USER = u;
    try { u ? localStorage.setItem(AUTH_KEY, JSON.stringify(u)) : localStorage.removeItem(AUTH_KEY); } catch (e) { }
    renderAccount();
    renderNotice();
    if ($('result').classList.contains('show')) refreshResultForm();
  }
  function playerName() { return USER ? USER.name : ''; }

  // ---- ホームのお知らせ (ログイン導入の案内). 閉じたらこのブラウザでは出さない
  const NOTICE_KEY = 'human_mapf_notice_login';
  function noticeDismissed() { try { return localStorage.getItem(NOTICE_KEY) === '1'; } catch (e) { return false; } }
  function renderNotice() {
    const el = $('notice'); if (!el) return;
    if (!LB.configured() || noticeDismissed()) { el.className = 'notice'; el.innerHTML = ''; return; }
    const steps = USER
      ? `<p class="done">${t('notice.loggedIn', escapeHtml(USER.name))}</p>`
      : `<div class="steps"><b>${t('notice.stepsH')}</b><ol><li>${t('notice.step1')}</li><li>${t('notice.step2')}</li><li>${t('notice.step3')}</li></ol></div>`;
    el.innerHTML = `<h3>${t('notice.title')}<span class="date">${t('notice.date')}</span></h3>
      <p>${t('notice.lead')}</p>
      ${steps}
      <ul>
        <li>${t('notice.n1', t('notice.deadline'))}</li>
        <li>${t('notice.n2')}</li>
        <li>${t('notice.n3')}</li>
        <li>${t('notice.n4')}</li>
        <li>${t('notice.n5')}</li>
      </ul>
      <div class="row"><button class="notice-close">${t('notice.close')}</button></div>`;
    el.className = 'notice show';
    const b = el.querySelector('.notice-close');
    if (b) b.onclick = () => { try { localStorage.setItem(NOTICE_KEY, '1'); } catch (e) { } renderNotice(); renderAccount(); };
  }

  function renderAccount() {
    const html = !LB.configured() ? ''
      : USER
        ? `<span class="who">${escapeHtml(USER.name)}</span><button class="auth-out">${t('auth.logout')}</button>`
        : `<button class="auth-in">${t('auth.login')}</button><button class="auth-up">${t('auth.register')}</button>`;
    const reopen = (!LB.configured() || !noticeDismissed()) ? '' : `<button class="notice-open">${t('notice.reopen')}</button>`;
    for (const id of ['home-account', 'game-account']) {
      const el = $(id); if (!el) continue;
      el.innerHTML = (id === 'home-account' ? reopen : '') + html;
      const q = (c, fn) => { const b = el.querySelector(c); if (b) b.onclick = fn; };
      q('.auth-out', () => setUser(null));
      q('.auth-in', () => openAuth('login'));
      q('.auth-up', () => openAuth('register'));
      q('.notice-open', () => { try { localStorage.removeItem(NOTICE_KEY); } catch (e) { } renderNotice(); renderAccount(); $('notice').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    }
  }

  // ---- ログイン / 新規登録モーダル
  let AUTH_MODE = 'login', authTimer = null;
  function openAuth(mode, presetName) {
    AUTH_MODE = mode;
    $('auth').classList.add('show');
    $('auth-msg').textContent = ''; $('auth-msg').className = 'lb-msg';
    $('auth-hint').textContent = ''; $('auth-hint').className = 'auth-hint';
    if (presetName != null) $('auth-name').value = presetName;
    $('auth-pw').value = '';
    applyAuthLang();
    setTimeout(() => ($('auth-name').value ? $('auth-pw') : $('auth-name')).focus(), 50);
  }
  function closeAuth() { $('auth').classList.remove('show'); if (authTimer) clearTimeout(authTimer); }
  function applyAuthLang() {
    const reg = AUTH_MODE === 'register';
    $('auth-title').textContent = t(reg ? 'auth.titleRegister' : 'auth.titleLogin');
    $('auth-tab-login').textContent = t('auth.login');
    $('auth-tab-register').textContent = t('auth.register');
    $('auth-tab-login').className = reg ? '' : 'on';
    $('auth-tab-register').className = reg ? 'on' : '';
    $('auth-name-label').textContent = t('auth.name');
    $('auth-pw-label').textContent = t('auth.password');
    $('auth-pw').autocomplete = reg ? 'new-password' : 'current-password';
    $('auth-go').textContent = t(reg ? 'auth.goRegister' : 'auth.goLogin');
    $('auth-note').innerHTML = t('auth.note');
  }
  // 新規登録のときだけ、入力中の名前が使えるかをサーバーに問い合わせる
  function scheduleNameCheck() {
    if (authTimer) clearTimeout(authTimer);
    if (AUTH_MODE !== 'register') { $('auth-hint').textContent = ''; return; }
    const name = LB.sanitizeName($('auth-name').value);
    const hint = $('auth-hint');
    if (!name) { hint.textContent = ''; hint.className = 'auth-hint'; return; }
    hint.textContent = t('auth.hintChecking'); hint.className = 'auth-hint';
    authTimer = setTimeout(async () => {
      try {
        const r = await LB.checkName(name);
        if (LB.nameKey($('auth-name').value) !== LB.nameKey(name)) return;   // 入力が変わっていたら捨てる
        if (r.taken) { hint.textContent = t('auth.hintTaken'); hint.className = 'auth-hint err'; }
        else if (r.legacy) { hint.textContent = t('auth.hintLegacy', r.submissions); hint.className = 'auth-hint warn'; }
        else { hint.textContent = t('auth.hintFree'); hint.className = 'auth-hint'; }
      } catch (e) { hint.textContent = ''; }
    }, 400);
  }
  function authErrorText(e) {
    const d = e.detail || {}, msg = String(e.message || e);
    if (e.timeout || msg === 'timeout') return t('auth.errTimeout');
    if (msg === 'no such user') return t('auth.errNoUser');
    if (msg.indexOf('not registered') === 0) return t('auth.errLegacy', d.submissions || 0);
    if (msg === 'wrong password') return t('auth.errPassword', d.remaining == null ? 0 : d.remaining);
    if (msg === 'locked') return t('auth.errLocked', d.retryAfter || 60);
    if (msg === 'name taken') return t('auth.errTaken');
    if (msg === 'password too short') return t('auth.errShortPw');
    if (msg === 'bad name') return t('auth.errName');
    return t('auth.errFail', msg);
  }
  async function submitAuth() {
    const name = LB.sanitizeName($('auth-name').value), pw = $('auth-pw').value;
    const msg = $('auth-msg'), go = $('auth-go');
    msg.className = 'lb-msg';
    if (!name) { msg.className = 'lb-msg err'; msg.textContent = t('auth.errName'); $('auth-name').focus(); return; }
    if (AUTH_MODE === 'register' && pw.length < 8) { msg.className = 'lb-msg err'; msg.textContent = t('auth.errShortPw'); $('auth-pw').focus(); return; }
    go.disabled = true; msg.textContent = t('auth.working');
    try {
      const r = AUTH_MODE === 'register' ? await LB.register(name, pw) : await LB.login(name, pw);
      setUser({ name: r.name, token: r.token });
      msg.className = 'lb-msg';
      msg.textContent = AUTH_MODE === 'register'
        ? (r.claimed > 0 ? t('auth.okClaim', r.claimed) : t('auth.okRegister', r.name))
        : t('auth.okLogin', r.name);
      Sound.select();
      setTimeout(() => { closeAuth(); if ($('result').classList.contains('show')) refreshResultForm(); }, 900);
    } catch (e) {
      msg.className = 'lb-msg err'; msg.textContent = authErrorText(e);
      if (String(e.message).indexOf('not registered') === 0) { AUTH_MODE = 'register'; applyAuthLang(); }
    } finally { go.disabled = false; }
  }
  function stageKey() { return `${S.mapId}:${S.N}`; }
  function encodePath(p) {
    let out = '';
    for (let k = 1; k < p.length; ++k) { const d = p[k] - p[k - 1]; out += d === 0 ? 'W' : d === 1 ? 'R' : d === -1 ? 'L' : d === S.map.w ? 'D' : 'U'; }
    return out;
  }

  async function submitScore() {
    const r = S.lastResult; if (!r || !LB.configured()) return;
    if (!USER) { openAuth('login'); return; }
    const msg = $('lb-msg'), btn = $('lb-submit');
    if (!btn) return;
    btn.disabled = true; msg.className = 'lb-msg'; msg.textContent = t('lb.submitting');
    try {
      const res = await LB.submit(stageKey(), USER.name, USER.token, r.paths);
      const name = res.name || USER.name;
      r.name = name;
      r.rankMakespan = { rank: res.makespan.rank, total: res.makespan.total };
      r.rankMoves = { rank: res.moves.rank, total: res.moves.total };
      if (res.total) r.rankTotal = { rank: res.total.rank, total: res.total.total };
      msg.innerHTML = t('lb.result', res.makespan.rank, res.makespan.total, res.moves.rank, res.moves.total,
        (res.total && res.total.rank) || 0, (res.total && res.total.total) || 0)
        + ((res.makespan.improved || res.moves.improved) ? '' : ` <span class="sub">${t('lb.notImproved')}</span>`);
      S.champs = null; updateChampInfo(); updatePanel();
      Sound.goal();
    } catch (e) {
      const em = String(e.message || e);
      if (em.indexOf('bad token') === 0 || em.indexOf('login required') === 0) {
        // シート側でトークンが無効にされた / 別端末で作り直された場合
        setUser(null);   // ここでフォームが「ログインして登録」に差し替わる
        const m2 = $('lb-msg');
        if (m2) { m2.className = 'lb-msg err'; m2.textContent = t('auth.sessionExpired'); }
        openAuth('login', r.name || '');
        return;
      }
      msg.className = 'lb-msg err'; msg.textContent = t('lb.submitFail', em);
      btn.disabled = false;
    }
  }

  function rankTable(entries, showProduct) {
    if (!entries.length) return `<div class="sub">${t('lb.empty')}</div>`;
    const me = playerName();
    return `<table class="lb"><tr><th>${t('lb.rank')}</th><th>${t('lb.name')}</th><th>makespan</th><th>distance</th>${showProduct ? '<th>積</th>' : ''}</tr>` +
      entries.map((e, i) => `<tr class="${e.name === me ? 'me' : ''}"><td>${i + 1}</td><td>${escapeHtml(e.name)}</td><td class="mono">${e.makespan}</td><td class="mono">${e.moves}</td>${showProduct ? `<td class="mono b">${e.makespan * e.moves}</td>` : ''}</tr>`).join('') + '</table>';
  }

  async function showRanking() {
    const ov = $('ranking'), body = $('ranking-body');
    $('ranking-title').textContent = t('lb.title', mapName(S.mapId), S.N);
    ov.classList.add('show');
    if (!LB.configured()) { body.innerHTML = `<div class="lb-msg">${t('lb.notConfigured')}</div>`; return; }
    body.innerHTML = `<div class="lb-msg">${t('lb.loading')}</div>`;
    try {
      const b = await LB.top(stageKey());
      body.innerHTML = `<div class="sub">${t('lb.players', Math.max(b.makespan.length, b.moves.length, b.total.length))}</div>
        <div class="lb-col lb-top"><h3>${t('lb.total')}</h3><div class="lb-note">${t('lb.totalNote')}</div>${rankTable(b.total, true)}</div>
        <div class="lb-cols">
          <div class="lb-col"><h3>${t('lb.makespan')}</h3>${rankTable(b.makespan)}</div>
          <div class="lb-col"><h3>${t('lb.moves')}</h3>${rankTable(b.moves)}</div>
        </div>`;
    } catch (e) { body.innerHTML = `<div class="lb-msg err">${t('lb.error', escapeHtml(e.message || e))}</div>`; }
  }

  // 各ステージの 1 位 (ホームのチップとゲーム画面に表示). 60 秒キャッシュ
  async function fetchChamps() {
    if (!LB.configured()) return null;
    if (S.champs && Date.now() - S.champsAt < 60000) return S.champs;
    try { S.champs = await LB.all(); S.champsAt = Date.now(); } catch (e) { S.champs = null; }
    return S.champs;
  }
  async function updateChampInfo() {
    const el = $('champ-info');
    if (!LB.configured()) { el.textContent = ''; return; }
    const key = stageKey();
    const c = await fetchChamps();
    if (key !== stageKey()) return;
    const b = c && c[key];
    el.innerHTML = b && b.makespan
      ? t('champ.line', escapeHtml(b.makespan.name), b.makespan.makespan, escapeHtml(b.moves.name), b.moves.moves, b.players,
          b.total ? escapeHtml(b.total.name) : '-', b.total ? b.total.makespan * b.total.moves : '-')
      : t('champ.none');
  }
  // ステージ選択のチップに両部門の 1 位を表示 (⏱️ = makespan 部門 / 👣 = total distance 部門)
  const ICON_MS = '⏱️', ICON_MV = '👣', ICON_TOTAL = '👑';
  function crownLine(icon, name, tip, cls) {
    const sp = document.createElement('span');
    sp.className = 'crown ' + cls;
    sp.textContent = `${icon} ${name}`;
    sp.title = tip;
    return sp;
  }
  async function decorateHomeChamps() {
    const c = await fetchChamps(); if (!c) return;
    document.querySelectorAll('#stage-cards .chip[data-stage]').forEach(ch => {
      const b = c[ch.getAttribute('data-stage')];
      if (!b || !b.makespan || !b.moves || ch.querySelector('.crown')) return;
      const tot = b.total, totTip = tot ? t('champ.chipTotal', tot.name, tot.makespan, tot.moves, tot.makespan * tot.moves) : '';
      // 3 部門とも同じ人なら 1 行にまとめる
      if (tot && tot.name === b.makespan.name && tot.name === b.moves.name) {
        ch.appendChild(crownLine(ICON_TOTAL, tot.name, t('champ.chipAll', tot.name), 'all'));
        return;
      }
      if (tot) ch.appendChild(crownLine(ICON_TOTAL, tot.name, totTip, 'total'));
      if (b.makespan.name === b.moves.name) {
        ch.appendChild(crownLine(ICON_MS + ICON_MV, b.makespan.name,
          t('champ.chipBoth', b.makespan.name, b.makespan.makespan, b.moves.moves), 'both'));
        return;
      }
      ch.appendChild(crownLine(ICON_MS, b.makespan.name, t('champ.chipMs', b.makespan.name, b.makespan.makespan), 'ms'));
      ch.appendChild(crownLine(ICON_MV, b.moves.name, t('champ.chipMv', b.moves.name, b.moves.moves), 'mv'));
    });
  }

  // ============================================================ share: tweet / GIF
  function tweet() {
    const r = S.lastResult; if (!r) return;
    const rk = x => x && x.rank ? t('tweet.rank', x.rank, x.total) : '';
    const text = t('tweet.text', mapName(S.mapId), S.N, r.makespan, rk(r.rankMakespan), r.moves, rk(r.rankMoves), r.rank && r.rank !== 'clear' ? `${r.rank.toUpperCase()} ` : '');
    const url = location.href.split('#')[0].split('?')[0];
    window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url), '_blank', 'noopener');
  }

  // ---- 経路データの保存 / 読み込み
  function saveMsg(text, cls) {
    const el = $('save-msg'); if (!el) return;
    el.textContent = text; el.className = 'save-msg' + (cls ? ' ' + cls : '');
  }
  function stamp() {
    const d = new Date(), z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
  }
  function saveRoutes() {
    if (!S.map) return;
    if (!S.paths.some(p => p.length > 1)) { Sound.error(); saveMsg(t('save.empty'), 'err'); return; }
    const m = L.metrics(S.paths.map(p => L.trimPath(p)));
    const data = {
      game: 'human-mapf', version: 1,
      stage: stageKey(), map: S.mapId, agents: S.N,
      savedAt: new Date().toISOString(),
      makespan: m.makespan, moves: m.moves,
      starts: S.starts, goals: S.goals,       // 読み込むときの照合用
      paths: S.paths.map(p => encodePath(p)), // U/D/L/R/W の 1 文字 = 1 手
    };
    const name = `human-mapf_${S.mapId}-${S.N}_${stamp()}.json`;
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
    Sound.select();
    saveMsg(t('save.done', name));
  }
  // 読み込んだ経路がこの盤面で成立するか確かめてから反映する
  function applyRoutes(data) {
    if (!data || data.game !== 'human-mapf' || !Array.isArray(data.paths)) return { err: t('save.notJson') };
    if (data.stage && data.stage !== stageKey()) return { err: t('save.otherStage', data.stage, stageKey()) };
    if (data.paths.length !== S.N) return { err: t('save.badN', data.paths.length, S.N) };
    if (Array.isArray(data.starts) && String(data.starts) !== String(S.starts)) return { err: t('save.mismatch') };
    const w = S.map.w, out = [];
    for (let i = 0; i < S.N; ++i) {
      const str = String(data.paths[i]);
      if (/[^UDLRW]/.test(str)) return { err: t('save.badMove', i + 1) };
      let c = S.starts[i]; const p = [c];
      for (const ch of str) {
        const x = c % w;
        if (ch === 'R') { if (x === w - 1) return { err: t('save.badMove', i + 1) }; c += 1; }
        else if (ch === 'L') { if (x === 0) return { err: t('save.badMove', i + 1) }; c -= 1; }
        else if (ch === 'D') c += w;
        else if (ch === 'U') c -= w;
        if (c < 0 || c >= w * S.map.h || !S.map.free[c]) return { err: t('save.badMove', i + 1) };
        p.push(c);
      }
      out.push(p);
    }
    snapshot();                     // 読み込み前の状態を Undo で戻せるようにする
    S.paths = out;
    S.mode = 'edit'; S.anim = null;
    recompute(); renderAll();
    const m = L.metrics(S.paths.map(p => L.trimPath(p)));
    return { ok: true, makespan: m.makespan, moves: m.moves };
  }
  async function loadRoutesFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = applyRoutes(data);
      if (r.err) { Sound.error(); saveMsg(t('save.badFile', r.err), 'err'); return r; }
      Sound.select();
      saveMsg(t('save.loaded', S.N, r.makespan, r.moves));
      return r;
    } catch (e) {
      Sound.error(); saveMsg(t('save.badFile', t('save.notJson')), 'err');
      return { err: String(e.message || e) };
    }
  }

  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // 現在の (全員ゴール・衝突なしの) 経路を GIF アニメーションにして保存
  async function exportGif() {
    if (S.gifBusy) return null;
    const solved = S.N > 0 && S.paths.every((p, i) => p[p.length - 1] === S.goals[i]) && S.collisions && S.collisions.count === 0;
    if (!solved) { Sound.error(); setStatus(t('gif.notSolved'), 'bad'); return null; }
    S.gifBusy = true; $('btn-gif').disabled = true;
    const paths = S.paths.map(p => L.trimPath(p));
    const mt = L.metrics(paths), makespan = mt.makespan, moves = mt.moves;
    const w = S.map.w, h = S.map.h;
    const cs = Math.max(10, Math.min(28, Math.floor(420 / Math.max(w, h)))), capH = 22;
    const W = cs * w, H = cs * h + capH;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const c2 = off.getContext('2d', { willReadFrequently: true });
    const fps = 12, delay = Math.round(100 / fps), perStep = Math.max(2, Math.round(fps / S.speed));
    const name = S.lastResult && S.lastResult.name ? ` · ${S.lastResult.name}` : '';
    const caption = `Human MAPF · ${mapName(S.mapId)} · ${S.N} agents · makespan ${makespan} / moves ${moves}${name}`;
    const render = tt => {
      // 選択中のエージェントに付く黒枠は編集用の目印なので、GIF には残さない
      const saved = { ctx, cell: S.cell, mode: S.mode, anim: S.anim, sel: S.sel };
      ctx = c2; S.cell = cs; S.mode = 'play'; S.anim = { t: tt, paths, isRef: false, failT: null, makespan }; S.sel = -1;
      try { draw(); } finally { ctx = saved.ctx; S.cell = saved.cell; S.mode = saved.mode; S.anim = saved.anim; S.sel = saved.sel; }
      c2.fillStyle = '#2b2a28'; c2.fillRect(0, cs * h, W, capH);
      c2.fillStyle = '#fff'; c2.font = '11px sans-serif'; c2.textAlign = 'left'; c2.textBaseline = 'middle';
      c2.fillText(`${caption} · t=${Math.floor(tt)}/${makespan}`, 6, cs * h + capH / 2);
      return c2.getImageData(0, 0, W, H);
    };
    try {
      const q = new GIF.Quantizer();
      for (const tt of [0, makespan / 2, makespan]) q.sample(render(tt).data, 1);
      const pal = q.build();
      const enc = new GIF.Encoder(W, H, pal);
      const frames = [[0, delay * fps]];                       // 最初の 1 秒は静止
      for (let f = 1; f <= makespan * perStep; ++f) frames.push([f / perStep, delay]);
      frames[frames.length - 1][1] = Math.round(delay * fps * 1.5); // 最後は 1.5 秒静止
      let prev = null, bufA = new Uint8Array(W * H), bufB = new Uint8Array(W * H);
      for (let k = 0; k < frames.length; ++k) {
        const r = q.map(render(frames[k][0]).data, prev, bufA);
        enc.addFrame(r.frame, frames[k][1]);
        prev = r.full; bufA = bufA === r.full ? bufB : bufA; bufB = prev;
        if (k % 6 === 0) { setStatus(t('gif.progress', Math.round(100 * k / frames.length))); await new Promise(res => setTimeout(res, 0)); }
      }
      const bytes = enc.finish();
      const blob = new Blob([bytes], { type: 'image/gif' });
      const fname = `human-mapf_${S.mapId}_${S.N}_${makespan}-${moves}.gif`;
      download(blob, fname);
      setStatus(t('gif.done', fname, (bytes.length / 1048576).toFixed(1)), 'good');
      Sound.goal();
      return blob;
    } catch (e) {
      setStatus(t('gif.fail', e.message || e), 'bad'); Sound.error(); return null;
    } finally { S.gifBusy = false; updatePanel(); }
  }

  // ============================================================ tutorial illustrations (SVG)
  const TC = { a: '#e0492f', b: '#2f6fe0' };
  function fig(w, h, items, cs) {
    cs = cs || 34; const W = w * cs, H = h * cs;
    let o = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
    o += `<rect x="0" y="0" width="${W}" height="${H}" fill="#f4f1ea" stroke="#999"/>`;
    for (let x = 1; x < w; ++x) o += `<line x1="${x * cs}" y1="0" x2="${x * cs}" y2="${H}" stroke="#ccc"/>`;
    for (let y = 1; y < h; ++y) o += `<line x1="0" y1="${y * cs}" x2="${W}" y2="${y * cs}" stroke="#ccc"/>`;
    const C = (x, y) => [(x + 0.5) * cs, (y + 0.5) * cs];
    const colors = [...new Set(items.filter(i => i.t === 'arrow').map(i => i.c))];
    o += '<defs>' + colors.map(c => `<marker id="ah${c.slice(1)}" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="${c}"/></marker>`).join('') + '</defs>';
    for (const it of items) {
      if (it.t === 'obst') o += `<rect x="${it.x * cs}" y="${it.y * cs}" width="${cs}" height="${cs}" fill="#3b3a37"/>`;
      else if (it.t === 'goal') { const [cx, cy] = C(it.x, it.y); const r = cs * 0.36; o += `<rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" fill="${it.c}" fill-opacity="0.15" stroke="${it.c}" stroke-width="2"/><text x="${cx}" y="${cy + 1}" font-size="${cs * 0.4}" fill="${it.c}" text-anchor="middle" dominant-baseline="middle" font-weight="700">${it.l || ''}</text>`; }
      else if (it.t === 'agent') { const [cx, cy] = C(it.x, it.y); o += `<circle cx="${cx}" cy="${cy}" r="${cs * 0.34}" fill="${it.c}" fill-opacity="${it.ghost ? 0.3 : 1}" stroke="#fff" stroke-width="1.5"/><text x="${cx}" y="${cy + 1}" font-size="${cs * 0.4}" fill="#fff" text-anchor="middle" dominant-baseline="middle" font-weight="700">${it.l || ''}</text>`; }
      else if (it.t === 'arrow') { const [x1, y1] = C(it.x1, it.y1), [x2, y2] = C(it.x2, it.y2); const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy); const ux = dx / len, uy = dy / len; const off = it.off || 0; o += `<line x1="${x1 + ux * cs * 0.3 - uy * off}" y1="${y1 + uy * cs * 0.3 + ux * off}" x2="${x2 - ux * cs * 0.3 - uy * off}" y2="${y2 - uy * cs * 0.3 + ux * off}" stroke="${it.c}" stroke-width="3" marker-end="url(#ah${it.c.slice(1)})"/>`; }
      else if (it.t === 'x') { const [cx, cy] = it.mid ? [(C(it.x, it.y)[0] + C(it.x2, it.y2)[0]) / 2, (C(it.x, it.y)[1] + C(it.x2, it.y2)[1]) / 2] : C(it.x, it.y); const r = cs * 0.28; o += `<path d="M${cx - r},${cy - r} L${cx + r},${cy + r} M${cx + r},${cy - r} L${cx - r},${cy + r}" stroke="#e02020" stroke-width="4" stroke-linecap="round"/>`; }
      else if (it.t === 'wait') { const [cx, cy] = C(it.x, it.y); o += `<circle cx="${cx}" cy="${cy}" r="${cs * 0.46}" fill="none" stroke="${it.c}" stroke-width="2" stroke-dasharray="4 3"/>`; }
      else if (it.t === 'label') { const [cx, cy] = C(it.x, it.y); o += `<text x="${cx}" y="${cy}" font-size="${cs * 0.32}" fill="#333" text-anchor="middle" dominant-baseline="middle">${it.l}</text>`; }
    }
    return o + '</svg>';
  }
  const F = (svg, cap, cls) => `<div class="fig">${svg}<div class="cap ${cls || ''}">${cap}</div></div>`;

  function tutorialHTML() {
    const A = TC.a, B = TC.b;
    const move = fig(3, 3, [{ t: 'agent', x: 1, y: 1, c: A, l: '1' }, { t: 'arrow', x1: 1, y1: 1, x2: 0, y2: 1, c: A }, { t: 'arrow', x1: 1, y1: 1, x2: 2, y2: 1, c: A }, { t: 'arrow', x1: 1, y1: 1, x2: 1, y2: 0, c: A }, { t: 'arrow', x1: 1, y1: 1, x2: 1, y2: 2, c: A }]);
    const wait = fig(3, 3, [{ t: 'agent', x: 1, y: 1, c: A, l: '1' }, { t: 'wait', x: 1, y: 1, c: A }]);
    const vtx0 = fig(3, 2, [{ t: 'agent', x: 0, y: 0, c: A, l: '1' }, { t: 'agent', x: 2, y: 0, c: B, l: '2' }, { t: 'arrow', x1: 0, y1: 0, x2: 1, y2: 0, c: A }, { t: 'arrow', x1: 2, y1: 0, x2: 1, y2: 0, c: B }, { t: 'label', x: 1, y: 1, l: t('fig.t') }]);
    const vtx1 = fig(3, 2, [{ t: 'agent', x: 1, y: 0, c: A, l: '1', ghost: true }, { t: 'agent', x: 1, y: 0, c: B, l: '2', ghost: true }, { t: 'x', x: 1, y: 0 }, { t: 'label', x: 1, y: 1, l: t('fig.same') }]);
    const edge0 = fig(3, 2, [{ t: 'agent', x: 0, y: 0, c: A, l: '1' }, { t: 'agent', x: 1, y: 0, c: B, l: '2' }, { t: 'arrow', x1: 0, y1: 0, x2: 1, y2: 0, c: A, off: -6 }, { t: 'arrow', x1: 1, y1: 0, x2: 0, y2: 0, c: B, off: -6 }, { t: 'label', x: 1, y: 1, l: t('fig.t') }]);
    const edge1 = fig(3, 2, [{ t: 'agent', x: 1, y: 0, c: A, l: '1', ghost: true }, { t: 'agent', x: 0, y: 0, c: B, l: '2', ghost: true }, { t: 'x', x: 0, y: 0, x2: 1, y2: 0, mid: true }, { t: 'label', x: 1, y: 1, l: t('fig.swap') }]);
    const follow0 = fig(3, 2, [{ t: 'agent', x: 0, y: 0, c: B, l: '2' }, { t: 'agent', x: 1, y: 0, c: A, l: '1' }, { t: 'arrow', x1: 1, y1: 0, x2: 2, y2: 0, c: A }, { t: 'arrow', x1: 0, y1: 0, x2: 1, y2: 0, c: B }, { t: 'label', x: 1, y: 1, l: t('fig.t') }]);
    const follow1 = fig(3, 2, [{ t: 'agent', x: 1, y: 0, c: B, l: '2' }, { t: 'agent', x: 2, y: 0, c: A, l: '1' }, { t: 'label', x: 1, y: 1, l: t('fig.follow') }]);
    const yield0 = fig(3, 2, [{ t: 'agent', x: 0, y: 0, c: A, l: '1' }, { t: 'agent', x: 2, y: 0, c: B, l: '2' }, { t: 'obst', x: 0, y: 1 }, { t: 'obst', x: 2, y: 1 }, { t: 'arrow', x1: 0, y1: 0, x2: 1, y2: 0, c: A }, { t: 'wait', x: 2, y: 0, c: B }]);
    const yield1 = fig(3, 2, [{ t: 'agent', x: 1, y: 0, c: A, l: '1' }, { t: 'agent', x: 2, y: 0, c: B, l: '2' }, { t: 'obst', x: 0, y: 1 }, { t: 'obst', x: 2, y: 1 }, { t: 'arrow', x1: 1, y1: 0, x2: 1, y2: 1, c: A }, { t: 'wait', x: 2, y: 0, c: B }]);
    const yield2 = fig(3, 2, [{ t: 'agent', x: 1, y: 1, c: A, l: '1' }, { t: 'agent', x: 2, y: 0, c: B, l: '2' }, { t: 'obst', x: 0, y: 1 }, { t: 'obst', x: 2, y: 1 }, { t: 'arrow', x1: 2, y1: 0, x2: 1, y2: 0, c: B }]);
    const yield3 = fig(3, 2, [{ t: 'agent', x: 1, y: 1, c: A, l: '1' }, { t: 'agent', x: 1, y: 0, c: B, l: '2' }, { t: 'obst', x: 0, y: 1 }, { t: 'obst', x: 2, y: 1 }, { t: 'arrow', x1: 1, y1: 0, x2: 0, y2: 0, c: B }, { t: 'wait', x: 1, y: 1, c: A }]);
    const goalStay = fig(4, 2, [{ t: 'goal', x: 1, y: 0, c: A, l: '1' }, { t: 'agent', x: 1, y: 0, c: A, l: '1' }, { t: 'goal', x: 3, y: 0, c: B, l: '2' }, { t: 'agent', x: 0, y: 0, c: B, l: '2' }, { t: 'arrow', x1: 0, y1: 0, x2: 1, y2: 0, c: B }, { t: 'x', x: 1, y: 0 }, { t: 'label', x: 2, y: 1, l: t('t4.lbl') }]);
    const goalOk = fig(4, 2, [{ t: 'goal', x: 1, y: 0, c: A, l: '1' }, { t: 'agent', x: 1, y: 0, c: A, l: '1' }, { t: 'goal', x: 3, y: 0, c: B, l: '2' }, { t: 'agent', x: 0, y: 0, c: B, l: '2' }, { t: 'arrow', x1: 0, y1: 0, x2: 0, y2: 1, c: B }, { t: 'arrow', x1: 0, y1: 1, x2: 1, y2: 1, c: B }, { t: 'arrow', x1: 1, y1: 1, x2: 2, y2: 1, c: B }, { t: 'arrow', x1: 2, y1: 1, x2: 3, y2: 1, c: B }, { t: 'arrow', x1: 3, y1: 1, x2: 3, y2: 0, c: B }]);
    const score = fig(5, 2, [{ t: 'agent', x: 0, y: 0, c: A, l: '1' }, { t: 'goal', x: 3, y: 0, c: A, l: '1' }, { t: 'arrow', x1: 0, y1: 0, x2: 1, y2: 0, c: A }, { t: 'wait', x: 1, y: 0, c: A }, { t: 'arrow', x1: 1, y1: 0, x2: 2, y2: 0, c: A }, { t: 'arrow', x1: 2, y1: 0, x2: 3, y2: 0, c: A }, { t: 'label', x: 0.5, y: 1, l: 't=0' }, { t: 'label', x: 1.5, y: 1, l: '1,2' }, { t: 'label', x: 2.5, y: 1, l: '3' }, { t: 'label', x: 3.5, y: 1, l: '4' }]);
    const row = (k, d) => `<tr><td>${t(k)}</td><td>${t(d)}</td></tr>`;
    return `
<div class="tcard"><h3>${t('t1.h')}</h3><p>${t('t1.p')}</p></div>
<div class="tcard"><h3>${t('t2.h')}</h3><div class="figs">${F(move, t('t2.move'))}${F(wait, t('t2.wait'))}</div><p>${t('t2.p')}</p></div>
<div class="tcard"><h3>${t('t3.h')}</h3><p>${t('t3.p1')}</p>
<div class="figs">${F(vtx0, t('t3.v0'), 'ng')}${F(vtx1, t('t3.v1'), 'ng')}</div>
<div class="figs">${F(edge0, t('t3.e0'), 'ng')}${F(edge1, t('t3.e1'), 'ng')}</div>
<p>${t('t3.p2')}</p><div class="figs">${F(follow0, t('t3.f0'), 'ok')}${F(follow1, t('t3.f1'), 'ok')}</div>
<p>${t('t3.p3')}</p><div class="figs">${F(yield0, t('t3.y0'))}${F(yield1, t('t3.y1'))}${F(yield2, t('t3.y2'))}${F(yield3, t('t3.y3'), 'ok')}</div></div>
<div class="tcard"><h3>${t('t4.h')}</h3><p>${t('t4.p')}</p><div class="figs">${F(goalStay, t('t4.ng'), 'ng')}${F(goalOk, t('t4.ok'), 'ok')}</div></div>
<div class="tcard"><h3>${t('t5.h')}</h3><div class="figs">${F(score, t('t5.fig'))}</div><p>${t('t5.p')}</p></div>
<div class="tcard"><h3>${t('t6.h')}</h3><table>
${row('t6.drag', 't6.dragD')}${row('t6.click', 't6.clickD')}${row('t6.rclick', 't6.rclickD')}${row('t6.keys', 't6.keysD')}${row('t6.bs', 't6.bsD')}${row('t6.tab', 't6.tabD')}${row('t6.undo', 't6.undoD')}${row('t6.enter', 't6.enterD')}
</table></div>`;
  }

  // ============================================================ screens
  function buildHome() {
    const wrap = $('stage-cards'); wrap.innerHTML = '';
    for (const d of M.MAP_DEFS) {
      const m = M.getMap(d.id);
      const card = document.createElement('div'); card.className = 'stage-card';
      const pv = document.createElement('canvas');
      const px = Math.max(2, Math.floor(96 / Math.max(m.w, m.h)));   // 大きいマップでも 96px 前後に収める
      pv.width = m.w * px; pv.height = m.h * px;
      const c = pv.getContext('2d');
      c.fillStyle = '#f4f1ea'; c.fillRect(0, 0, pv.width, pv.height);
      c.fillStyle = '#3b3a37';
      for (let y = 0; y < m.h; ++y) for (let x = 0; x < m.w; ++x) if (!m.free[y * m.w + x]) c.fillRect(x * px, y * px, px, px);
      card.appendChild(pv);
      const info = document.createElement('div'); info.className = 'info';
      info.innerHTML = `<div class="name">${mapName(d.id)}</div><div class="desc">${t('desc.' + d.id)}</div>`;
      const chips = document.createElement('div'); chips.className = 'chips';
      for (const n of d.agents) {
        const b = readBest(d.id, n);
        const ch = document.createElement('button'); ch.className = 'chip' + (b ? ' ' + b.rank : '');
        ch.setAttribute('data-stage', `${d.id}:${n}`);
        ch.innerHTML = t('agents.unit', n) + (b ? `<span class="rk">${b.rank.toUpperCase()}</span><span class="sc">${b.makespan} / ${b.moves}</span>` : '');
        ch.onclick = () => { Sound.ensure(); Sound.select(); showGame(d.id, n); };
        chips.appendChild(ch);
      }
      info.appendChild(chips); card.appendChild(info); wrap.appendChild(card);
    }
    decorateHomeChamps();
  }

  function showHome() {
    if (S.mode === 'play') stopAnim();
    S.solver = null;
    buildHome();
    $('game').classList.remove('show'); $('home').classList.add('show');
    $('help').classList.remove('show'); $('ranking').classList.remove('show'); $('result').className = 'result';
  }

  function showGame(mapId, N) {
    $('home').classList.remove('show'); $('game').classList.add('show');
    $('result').className = 'result';
    $('stage-title').textContent = t('stage.title', mapName(mapId), N);
    try { loadStage(mapId, N); } catch (e) { setStatus(t('status.genFail', e.message), 'bad'); }
  }

  // ============================================================ language
  function applyLang() {
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-i18n]').forEach(e => { e.innerHTML = t(e.getAttribute('data-i18n')); });
    const other = LANG === 'ja' ? 'EN' : '日本語';
    $('btn-lang').textContent = other; $('home-lang').textContent = other;
    const snd = t(Sound.enabled ? 'sound.on' : 'sound.off');
    $('btn-sound').textContent = snd; $('home-sound').textContent = snd;
    $('speed-val').textContent = t('unit.speed', S.speed);
    const tut = tutorialHTML();
    $('tutorial-home').innerHTML = tut; $('tutorial-game').innerHTML = tut;
    buildHome();
    renderAccount();
    renderNotice();
    if ($('auth').classList.contains('show')) applyAuthLang();
    if ($('result').classList.contains('show')) refreshResultForm();
    if (S.map) {
      $('stage-title').textContent = t('stage.title', mapName(S.mapId), S.N);
      if (S.mode === 'edit') setStatus(t('status.stage', mapName(S.mapId), S.N));
      updatePanel();
    }
  }
  function toggleLang() {
    LANG = LANG === 'ja' ? 'en' : 'ja';
    try { localStorage.setItem('human_mapf_lang', LANG); } catch (e) { }
    applyLang();
  }

  // ============================================================ UI wiring
  $('btn-home').addEventListener('click', showHome);
  $('btn-judge').addEventListener('click', judge);
  $('btn-stop').addEventListener('click', stopAnim);
  $('btn-undo').addEventListener('click', doUndo);
  $('btn-redo').addEventListener('click', doRedo);
  $('btn-clear-agent').addEventListener('click', () => { if (S.sel < 0 || S.mode !== 'edit') return; snapshot(); S.paths[S.sel] = [S.starts[S.sel]]; Sound.undo(); recompute(); renderAll(); });
  $('btn-clear-all').addEventListener('click', () => { if (S.mode !== 'edit') return; if (!confirm(t('confirm.clearAll'))) return; snapshot(); S.paths = S.starts.map(s => [s]); Sound.undo(); recompute(); renderAll(); });
  $('btn-save').addEventListener('click', saveRoutes);
  $('btn-load').addEventListener('click', () => { $('load-file').value = ''; $('load-file').click(); });
  $('load-file').addEventListener('change', ev => { loadRoutesFile(ev.target.files && ev.target.files[0]); });
  $('btn-ranking').addEventListener('click', showRanking);
  $('ranking-close').addEventListener('click', () => $('ranking').classList.remove('show'));
  $('btn-gif').addEventListener('click', exportGif);
  $('btn-tweet').addEventListener('click', tweet);
  function toggleSound() {
    Sound.enabled = !Sound.enabled;
    const label = t(Sound.enabled ? 'sound.on' : 'sound.off');
    $('btn-sound').textContent = label; $('home-sound').textContent = label;
    if (Sound.enabled) { Sound.ensure(); Sound.select(); }
  }
  $('btn-sound').addEventListener('click', toggleSound);
  $('home-sound').addEventListener('click', toggleSound);
  $('btn-lang').addEventListener('click', toggleLang);
  $('home-lang').addEventListener('click', toggleLang);
  $('speed').addEventListener('input', () => { S.speed = +$('speed').value; $('speed-val').textContent = t('unit.speed', S.speed); });
  $('auth-close').addEventListener('click', closeAuth);
  $('auth-tab-login').addEventListener('click', () => { AUTH_MODE = 'login'; applyAuthLang(); scheduleNameCheck(); $('auth-msg').textContent = ''; });
  $('auth-tab-register').addEventListener('click', () => { AUTH_MODE = 'register'; applyAuthLang(); scheduleNameCheck(); $('auth-msg').textContent = ''; });
  $('auth-go').addEventListener('click', submitAuth);
  $('auth-name').addEventListener('input', scheduleNameCheck);
  for (const id of ['auth-name', 'auth-pw']) $(id).addEventListener('keydown', ev => { if (ev.key === 'Enter') submitAuth(); ev.stopPropagation(); });
  $('auth').addEventListener('click', ev => { if (ev.target === $('auth')) closeAuth(); });
  $('btn-help').addEventListener('click', () => { $('help').classList.toggle('show'); });
  $('help-close').addEventListener('click', () => { $('help').classList.remove('show'); });
  window.addEventListener('resize', () => { if (S.map && $('game').classList.contains('show')) { layout(); draw(); } });

  // ============================================================ start
  $('speed').value = S.speed;
  applyLang();
  showHome();
  window.MAPF_GAME = { showGame, showHome, toggleLang, exportGif, submitScore, showRanking, tweet, rankOf, state: S, openAuth, setUser, user: () => USER, saveRoutes, applyRoutes, loadRoutesFile, _lbFormHtml: () => lbFormHtml(), _refreshResultForm: () => refreshResultForm() };
})();
