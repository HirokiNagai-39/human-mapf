/*
 * game.js — Human MAPF: 人力マルチエージェント経路計画パズル
 */
(function () {
  'use strict';
  const L = window.LNS2, M = window.MAPS, LB = window.LB, GIF = window.GIF;
  const $ = id => document.getElementById(id);

  // ============================================================ i18n
  const I18N = {
    ja: {
      'subtitle': '人力マルチエージェント経路計画',
      'tagline': '全員をぶつけずにゴールへ導く経路を、あなたの手で。makespan と総移動距離で MAPF ソルバー (LNS2) に挑もう。',
      'home.tutorialLink': '▼ 遊び方・衝突ルールを見る',
      'home.stages': 'ステージ選択',
      'home.howto': '遊び方',
      'sound.on': '🔊 効果音 ON', 'sound.off': '🔇 効果音 OFF',
      'btn.home': '← ホーム', 'btn.help': '? 遊び方', 'btn.close': '閉じる',
      'btn.judge': '▶ 採点 (Enter)', 'btn.stop': '■ 停止 (Esc)',
      'label.speed': '再生速度', 'unit.speed': '{0} step/s',
      'card.score': 'スコア', 'card.edit': '編集', 'card.agents': 'エージェント',
      'score.makespan': 'makespan (最大到達時刻)', 'score.moves': '総移動距離 (待機除く)', 'score.collisions': '衝突', 'score.done': 'ゴール到達',
      'btn.undo': '↶ Undo', 'btn.redo': '↷ Redo', 'btn.clearAgent': '選択の経路を消去', 'btn.clearAll': '全消去', 'btn.ref': '参考解を重ねて表示', 'btn.playRef': '▶ 参考解 (LNS2) を再生',
      'status.playRef': '参考解 (LNS2) を再生中… makespan {0} / 総移動距離 {1}',
      'agents.unit': '{0} 台', 'agent.remain': '残り{0}',
      'stage.title': '{0} — {1} 台', 'status.stage': 'ステージ: {0} / {1} 台', 'status.genFail': 'ステージ生成に失敗: {0}',
      'ref.running': '参考解 (LNS2) 計算中… <span class="mono">{0} iter</span>',
      'ref.ok': '参考解 (LNS2): makespan <b class="mono">{0}</b> / 総移動距離 <b class="mono">{1}</b>',
      'ref.fail': '参考解 (LNS2): 見つかりませんでした',
      'lb': '下界: makespan <span class="mono">{0}</span> / 総移動距離 <span class="mono">{1}</span>',
      'best': 'ベスト: makespan <b class="mono">{0}</b> / 総移動距離 <b class="mono">{1}</b> {2}', 'best.none': 'ベスト: —',
      'judge.notDone': '不正解: ゴールに到達していないエージェントがあります ({0})',
      'judge.hasCol': '衝突があります ({0} 件, 最初は t={1}) — 再生します…',
      'judge.running': '採点中…',
      'judge.colFail': '不正解: t={0} で衝突 (× 印). 経路を修正してください.',
      'judge.ok': '正解! makespan {0} / 総移動距離 {1}', 'judge.refPart': ' (参考解 {0} / {1})', 'judge.lbPart': ' [下界 {0} / {1}]', 'judge.newBest': ' — ベスト更新!',
      'result.makespan': 'makespan', 'result.moves': '総移動距離', 'result.refLb': '(参考 {0}, 下界 {1})', 'result.newBest': '★ ベスト更新',
      'result.gold': '両指標で参考解以上!', 'result.silver': 'あと一歩: もう一方の指標も参考解以下にしてみよう', 'result.bronze': '衝突なしで到達. 参考解を目指して改善しよう',
      'confirm.clearAll': '全エージェントの経路を消去しますか?',
      'card.share': 'ランキング / 共有', 'btn.ranking': '🏆 ランキング', 'btn.gif': '🎞 GIF を保存', 'btn.tweet': '𝕏 にポスト',
      'lb.title': '🏆 ランキング — {0} / {1} 台', 'lb.makespan': 'makespan 部門', 'lb.moves': '総移動距離部門',
      'lb.rank': '順位', 'lb.name': '名前', 'lb.loading': '読み込み中…', 'lb.error': 'ランキングを取得できませんでした ({0})',
      'lb.empty': 'まだ登録がありません。最初の 1 人になろう!', 'lb.players': '{0} 人が登録',
      'lb.notConfigured': 'オンラインランキングは未設定です (server/README.md を参照)',
      'lb.namePh': 'あなたの名前 (16 文字まで)', 'lb.submit': 'ランキングに登録', 'lb.submitting': '登録中…',
      'lb.result': 'makespan 部門 <b>{0} 位</b> / {1} 人 · 総移動距離部門 <b>{2} 位</b> / {3} 人', 'lb.notImproved': '(自己ベスト更新なし: 既存の記録で順位を表示)',
      'lb.submitFail': '登録できませんでした: {0}', 'lb.needName': '名前を入力してください',
      'champ.line': '1 位 — makespan: {0} ({1}) · 総移動距離: {2} ({3}) · {4} 人', 'champ.none': 'まだ登録がありません',
      'gif.notSolved': 'GIF にするには、全員ゴール・衝突なしの状態にしてください', 'gif.progress': 'GIF 作成中… {0}%', 'gif.done': 'GIF を保存しました: {0} ({1} MB)', 'gif.fail': 'GIF の作成に失敗: {0}',
      'tweet.text': 'Human MAPF「{0} {1}台」クリア! makespan {2}{3} / 総移動距離 {4}{5} #HumanMAPF', 'tweet.rank': ' ({0}位/{1}人)',
      'tweet.note': '𝕏 の投稿画面には、保存した GIF をドラッグ&ドロップで添付してください (自動添付はできません)',
      'map.tutorial': 'チュートリアル', 'map.empty': 'Empty 16×16', 'map.random': 'Random 16×16', 'map.room': 'Room 4×4', 'map.maze': 'Maze 6×6', 'map.warehouse': 'Warehouse',
      'desc.tutorial': '障害物 2 つ。対角の 2 台が入れ替わる練習', 'desc.empty': '空のマップ', 'desc.random': '約 10% が障害物', 'desc.room': '4×4 の部屋 ×16, 幅 1〜2 の通路でつながる', 'desc.maze': '幅 2 の通路の 6×6 迷路', 'desc.warehouse': '幅 1 × 長さ 5 の棚が 4 行 3 列, 通路幅 2',
      // tutorial
      't1.h': '1. 目的',
      't1.p': '丸 (エージェント) を、同じ番号・同じ色の四角 (ゴール) まで動かす<b>経路</b>を全員分作ります。時刻 t=0 から始まり、各時刻に全員が同時に 1 手ずつ動きます。全員が衝突なくゴールに着けば正解。<b>makespan</b> (全員がゴールに着く時刻) と <b>総移動距離</b> (待機を除く移動回数の合計) が小さいほど高評価です。',
      't2.h': '2. 1 手の動き', 't2.move': '上下左右に 1 マス移動', 't2.wait': 'その場で待機 (経路上に ● が付く)', 't2.p': '斜め移動はできません。黒いマスは障害物です。',
      't3.h': '3. 衝突ルール (重要)', 't3.p1': '次の 2 つは<b>衝突</b>で、盤面に赤い <b>×</b> と時刻が表示され、採点は不正解になります。',
      't3.v0': '頂点衝突: 同じ時刻に同じマスへ', 't3.v1': '✗ 2 台が同じマス', 't3.e0': '辺衝突: 隣り合う 2 台が入れ替わる', 't3.e1': '✗ すれ違い (同じ辺を逆向き)',
      't3.p2': '一方、これは<b>衝突ではありません</b>:', 't3.f0': '前の車が出ると同時に、そのマスへ入る', 't3.f1': '○ 追従 OK (列になって進める)',
      't3.p3': '幅 1 の通路で向かい合ったら、片方が<b>待機</b>や<b>脇道</b>で譲ります:', 't3.y0': 't=0: 2 は待機', 't3.y1': 't=1: 1 が脇へ', 't3.y2': 't=2: 2 が通る', 't3.y3': 't=3: 1 は待機して譲る',
      't4.h': '4. ゴールに着いたエージェントは動かない', 't4.p': '経路が終わったエージェントは、その後ずっとゴールに<b>留まり続けます</b>。そのマスを後から通ろうとすると頂点衝突です。先に着く人の場所を避けるか、順番を入れ替えましょう。',
      't4.ng': '✗ ゴールに居座る 1 に突っ込む', 't4.ok': '○ 迂回する (または 2 を先に通す)', 't4.lbl': '到着済みは動かない',
      't5.h': '5. スコア', 't5.fig': '移動 → 待機 → 移動 → 移動: 到着 t=4, 移動距離 3',
      't5.p': '<b>makespan</b> = 一番遅いエージェントの到着時刻。<b>総移動距離</b> = 全員の「移動」の回数 (待機は数えない)。ステージを開くと LNS2 ソルバーが<b>参考解</b>を計算します。両方の指標で参考解以下なら <b>GOLD</b>、片方なら <b>SILVER</b>、衝突なしで全員到達なら <b>BRONZE</b>。<b>下界</b> (他の全員を無視した最短距離) にどこまで迫れるかも挑戦してみてください。',
      't6.h': '6. 操作',
      't6.drag': '<b>ドラッグ</b>', 't6.dragD': 'エージェントの先端 (丸) をドラッグすると、通ったマスが経路になります。途中で離してもそこまでの経路は残ります。同じドラッグ中に 1 つ前のマスへ戻ると取り消し。',
      't6.click': '<b>クリック</b>', 't6.clickD': '先端をクリックすると、その場で 1 時刻<b>待機</b>を追加。',
      't6.rclick': '<b>右クリック</b>', 't6.rclickD': '先端を右クリックで最後の 1 手を削除。',
      't6.keys': '<kbd>↑↓←→</kbd> / <kbd>WASD</kbd>', 't6.keysD': '選択中のエージェントを 1 マス動かす。<kbd>Space</kbd> / <kbd>Q</kbd> で待機。',
      't6.bs': '<kbd>Backspace</kbd> / <kbd>Delete</kbd>', 't6.bsD': '最後の 1 手を削除 / 選択中の経路を全消去。',
      't6.tab': '<kbd>Tab</kbd> / <kbd>1</kbd>〜<kbd>9</kbd>', 't6.tabD': 'エージェントの切り替え。ゴールや経路をクリックしても選択できます。',
      't6.undo': '<kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd>', 't6.undoD': 'Undo / Redo。',
      't6.enter': '<kbd>Enter</kbd> / <kbd>Esc</kbd>', 't6.enterD': '採点 (アニメーション再生) / 再生停止。',
      't6.p': '「参考解を重ねて表示」で LNS2 の解を点線で見られ、「参考解を再生」でその動きをアニメーションで確認できます。行き詰まったときのヒントにどうぞ。',
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
      'score.makespan': 'makespan (last arrival)', 'score.moves': 'total distance (moves only)', 'score.collisions': 'collisions', 'score.done': 'at goal',
      'btn.undo': '↶ Undo', 'btn.redo': '↷ Redo', 'btn.clearAgent': 'Clear selected path', 'btn.clearAll': 'Clear all', 'btn.ref': 'Overlay reference solution', 'btn.playRef': '▶ Play reference (LNS2)',
      'status.playRef': 'Playing reference (LNS2)… makespan {0} / distance {1}',
      'agents.unit': '{0} agents', 'agent.remain': '{0} left',
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
      'result.makespan': 'makespan', 'result.moves': 'total distance', 'result.refLb': '(ref {0}, LB {1})', 'result.newBest': '★ New best',
      'result.gold': 'Matched or beat the reference on both metrics!', 'result.silver': 'Almost: beat the reference on the other metric too', 'result.bronze': 'All agents arrived without collisions. Now aim for the reference',
      'confirm.clearAll': 'Clear the paths of all agents?',
      'card.share': 'Ranking / Share', 'btn.ranking': '🏆 Ranking', 'btn.gif': '🎞 Save GIF', 'btn.tweet': 'Post on 𝕏',
      'lb.title': '🏆 Ranking — {0} / {1} agents', 'lb.makespan': 'Makespan', 'lb.moves': 'Total distance',
      'lb.rank': '#', 'lb.name': 'Name', 'lb.loading': 'Loading…', 'lb.error': 'Could not load the ranking ({0})',
      'lb.empty': 'No entries yet. Be the first!', 'lb.players': '{0} players',
      'lb.notConfigured': 'Online ranking is not configured (see server/README.md)',
      'lb.namePh': 'Your name (up to 16 chars)', 'lb.submit': 'Submit to ranking', 'lb.submitting': 'Submitting…',
      'lb.result': 'Makespan: <b>#{0}</b> of {1} · Total distance: <b>#{2}</b> of {3}', 'lb.notImproved': '(not a personal best: rank of your existing record)',
      'lb.submitFail': 'Submission failed: {0}', 'lb.needName': 'Please enter your name',
      'champ.line': '#1 — makespan: {0} ({1}) · distance: {2} ({3}) · {4} players', 'champ.none': 'No entries yet',
      'gif.notSolved': 'To export a GIF, all agents must be at their goal with no collisions', 'gif.progress': 'Encoding GIF… {0}%', 'gif.done': 'GIF saved: {0} ({1} MB)', 'gif.fail': 'GIF export failed: {0}',
      'tweet.text': 'I solved Human MAPF "{0}, {1} agents": makespan {2}{3} / distance {4}{5} #HumanMAPF', 'tweet.rank': ' (#{0}/{1})',
      'tweet.note': 'Attach the saved GIF to the 𝕏 post by drag & drop (it cannot be attached automatically)',
      'map.tutorial': 'Tutorial', 'map.empty': 'Empty 16×16', 'map.random': 'Random 16×16', 'map.room': 'Room 4×4', 'map.maze': 'Maze 6×6', 'map.warehouse': 'Warehouse',
      'desc.tutorial': '2 obstacles. Two agents swap diagonally', 'desc.empty': 'Empty map', 'desc.random': 'About 10% obstacles', 'desc.room': '16 rooms of 4×4 joined by 1–2 wide doors', 'desc.maze': '6×6 maze with 2-wide corridors', 'desc.warehouse': '1×5 shelves in 4 rows × 3 columns, 2-wide aisles',
      't1.h': '1. Goal',
      't1.p': 'Build a <b>path</b> for every agent (circle) to the goal (square) with the same number and color. Time starts at t=0 and all agents move one step simultaneously at every time step. You succeed when everyone reaches their goal without collisions. Lower <b>makespan</b> (the time when everyone has arrived) and lower <b>total distance</b> (number of moves, waits excluded) score higher.',
      't2.h': '2. One step', 't2.move': 'Move 1 cell up/down/left/right', 't2.wait': 'Wait in place (shown as ● on the path)', 't2.p': 'No diagonal moves. Black cells are obstacles.',
      't3.h': '3. Collision rules (important)', 't3.p1': 'The following two are <b>collisions</b>: a red <b>×</b> with the time appears on the board and the submission is rejected.',
      't3.v0': 'Vertex collision: same cell at the same time', 't3.v1': '✗ two agents in one cell', 't3.e0': 'Edge collision: adjacent agents swap', 't3.e1': '✗ passing through each other',
      't3.p2': 'These, however, are <b>not</b> collisions:', 't3.f0': 'Enter a cell exactly as the agent ahead leaves it', 't3.f1': '○ following is OK (agents can move in a line)',
      't3.p3': 'When two agents face each other in a 1-wide corridor, one has to yield by <b>waiting</b> or stepping into a <b>side cell</b>:', 't3.y0': 't=0: 2 waits', 't3.y1': 't=1: 1 steps aside', 't3.y2': 't=2: 2 passes', 't3.y3': 't=3: 1 waits to let 2 pass',
      't4.h': '4. Agents stay at their goal', 't4.p': 'Once an agent\'s path ends, it <b>stays at its goal forever</b>. Passing through that cell later is a vertex collision. Route around agents that arrive earlier, or change the order.',
      't4.ng': '✗ running into 1 sitting on its goal', 't4.ok': '○ detour (or let 2 pass first)', 't4.lbl': 'arrived = never moves',
      't5.h': '5. Score', 't5.fig': 'move → wait → move → move: arrives at t=4, distance 3',
      't5.p': '<b>makespan</b> = arrival time of the slowest agent. <b>Total distance</b> = number of moves of all agents (waits do not count). When a stage opens, the LNS2 solver computes a <b>reference solution</b>. <b>GOLD</b> if you match or beat it on both metrics, <b>SILVER</b> on one, <b>BRONZE</b> for any collision-free solution. See how close you can get to the <b>lower bound</b> (shortest paths ignoring all other agents).',
      't6.h': '6. Controls',
      't6.drag': '<b>Drag</b>', 't6.dragD': 'Drag the tip (circle) of an agent; the cells you pass become its path. Releasing midway keeps the path so far. Moving back onto the previous cell during the same drag undoes that step.',
      't6.click': '<b>Click</b>', 't6.clickD': 'Click the tip to add one <b>wait</b> step.',
      't6.rclick': '<b>Right click</b>', 't6.rclickD': 'Right-click the tip to remove the last step.',
      't6.keys': '<kbd>↑↓←→</kbd> / <kbd>WASD</kbd>', 't6.keysD': 'Move the selected agent one cell. <kbd>Space</kbd> / <kbd>Q</kbd> to wait.',
      't6.bs': '<kbd>Backspace</kbd> / <kbd>Delete</kbd>', 't6.bsD': 'Remove the last step / clear the selected agent\'s path.',
      't6.tab': '<kbd>Tab</kbd> / <kbd>1</kbd>–<kbd>9</kbd>', 't6.tabD': 'Switch agents. Clicking a goal or a path also selects that agent.',
      't6.undo': '<kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd>', 't6.undoD': 'Undo / Redo.',
      't6.enter': '<kbd>Enter</kbd> / <kbd>Esc</kbd>', 't6.enterD': 'Submit (plays the animation) / stop playback.',
      't6.p': '"Overlay reference solution" shows the LNS2 paths as dotted lines, and "Play reference" animates them — a hint when you are stuck.',
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
    ref: null, refState: 'none', solver: null, refPaths: null, showRef: false, lb: null,
    mode: 'edit', anim: null, speed: 3,
    collisions: null, metrics: null, best: null,
    cell: 32, ox: 0, oy: 0,
    lanes: null, // Map(edgeKey -> [agent ids])
    lastResult: null, gifBusy: false, champs: null, champsAt: 0,
  };

  const canvas = $('board'); let ctx = canvas.getContext('2d');

  function agentColor(i, alpha) { const h = (i * 137.508) % 360; return `hsla(${h}, 70%, 50%, ${alpha == null ? 1 : alpha})`; }
  function cellXY(c) { return [c % S.map.w, Math.floor(c / S.map.w)]; }
  function cellCenter(c) { const [x, y] = cellXY(c); return [S.ox + (x + 0.5) * S.cell, S.oy + (y + 0.5) * S.cell]; }
  function head(i) { return S.paths[i][S.paths[i].length - 1]; }
  function isAdj(a, b) { const d = Math.abs(a - b); return (d === 1 && Math.floor(a / S.map.w) === Math.floor(b / S.map.w)) || d === S.map.w; }
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
    S.sel = N > 0 ? 0 : -1; S.drag = null;
    S.undo = []; S.redo = [];
    S.mode = 'edit'; S.anim = null; S.showRef = false; $('btn-ref').classList.remove('on');
    S.ref = null; S.refPaths = null;
    S.best = readBest(mapId, N);
    S.lastResult = null;
    startReference();
    updateChampInfo();
    layout(); recompute(); renderAll();
    setStatus(t('status.stage', mapName(mapId), N));
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
    if (S.showRef && S.refPaths) add(S.refPaths);
    S.lanes = lanes;
  }
  function recompute() {
    S.collisions = L.findCollisions(S.paths, S.G.V, true);
    S.metrics = L.metrics(S.paths);
    computeLanes();
    updatePanel();
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
      ctx.fillText(sub, x, y - r - S.cell * 0.18);
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
      drawGoals();
      if (S.showRef && S.refPaths) for (let i = 0; i < S.N; ++i) drawPath(S.refPaths[i], i, 0.35, 2, true);
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
      if (S.hover >= 0 && S.drag) {
        const [x, y] = cellXY(S.hover);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.strokeRect(S.ox + x * cs + 1, S.oy + y * cs + 1, cs - 2, cs - 2);
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
    $('btn-ref').disabled = !S.refPaths;
    $('btn-play-ref').disabled = !S.refPaths || S.mode !== 'edit';
  }

  function rankBadge(r) { return r ? `<span class="badge ${r}">${r.toUpperCase()}</span>` : ''; }

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
      li.className = (i === S.sel ? 'sel ' : '') + (isDone ? 'done ' : '') + (S.collisions && S.collisions.conf[i] ? 'conf' : '');
      li.innerHTML = `<span class="dot" style="background:${agentColor(i)}"></span><span class="nm">${i + 1}</span><span class="mono">t=${tt}</span><span class="mono">${t('agent.remain', d < 0 ? '∞' : d)}</span>${isDone ? '<span class="ok">✓</span>' : ''}`;
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
    $('btn-judge').disabled = true; $('btn-stop').disabled = false; $('btn-play-ref').disabled = true;
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

  // 参考解 (LNS2) の再生. 採点には影響しない
  function playReference() {
    if (S.mode !== 'edit' || !S.refPaths) return;
    Sound.ensure();
    if (S.drag) endDrag(false);
    S.mode = 'play';
    S.anim = { t: 0, last: performance.now(), failT: null, end: S.ref.makespan, arrived: new Set(), paths: S.refPaths, isRef: true, makespan: S.ref.makespan };
    $('btn-judge').disabled = true; $('btn-stop').disabled = false; $('btn-play-ref').disabled = true;
    setStatus(t('status.playRef', S.ref.makespan, S.ref.moves));
    requestAnimationFrame(animTick);
  }

  function finishAnim() {
    const a = S.anim;
    if (a.isRef) { setTimeout(() => { if (S.mode === 'play') stopAnim(); }, 600); return; }
    if (a.failT != null) {
      Sound.error(); draw();
      setStatus(t('judge.colFail', a.failT), 'bad');
      setTimeout(() => { if (S.mode === 'play') stopAnim(); }, 1500);
      return;
    }
    const m = S.metrics; let rank = 'bronze';
    if (S.ref) {
      const okM = m.makespan <= S.ref.makespan, okD = m.moves <= S.ref.moves;
      rank = okM && okD ? 'gold' : (okM || okD) ? 'silver' : 'bronze';
    }
    if (rank === 'gold') Sound.gold(); else Sound.fanfare();
    let msg = t('judge.ok', m.makespan, m.moves);
    if (S.ref) msg += t('judge.refPart', S.ref.makespan, S.ref.moves);
    if (S.lb) msg += t('judge.lbPart', S.lb.makespan, S.lb.moves);
    const prev = S.best;
    const better = !prev || m.makespan < prev.makespan || (m.makespan === prev.makespan && m.moves < prev.moves);
    if (better) {
      S.best = { makespan: m.makespan, moves: m.moves, rank };
      try { localStorage.setItem(bestKey(S.mapId, S.N), JSON.stringify(S.best)); } catch (e) { }
      msg += t('judge.newBest');
    }
    setStatus(msg, 'good');
    S.lastResult = { makespan: m.makespan, moves: m.moves, rank, paths: S.paths.map(p => encodePath(L.trimPath(p))), rankMakespan: null, rankMoves: null };
    showResult(rank, m, better);
    setTimeout(() => { if (S.mode === 'play') stopAnim(); }, 800);
  }

  function stopAnim() {
    const wasRef = S.anim && S.anim.isRef;
    S.mode = 'edit'; S.anim = null;
    $('btn-judge').disabled = false; $('btn-stop').disabled = true; $('anim-t').textContent = '';
    if (wasRef) setStatus(t('status.stage', mapName(S.mapId), S.N));
    renderAll();
  }

  function showResult(rank, m, better) {
    const box = $('result'); box.className = 'result show ' + rank;
    const refLb = (rv, lv) => S.ref ? ` <span class="sub">${t('result.refLb', rv, lv)}</span>` : '';
    const lbForm = LB.configured()
      ? `<div class="lb-form"><input id="lb-name" maxlength="16" placeholder="${t('lb.namePh')}" value="${escapeHtml(playerName())}"><button id="lb-submit" class="primary">${t('lb.submit')}</button></div><div id="lb-msg" class="lb-msg"></div>`
      : `<div class="lb-msg">${t('lb.notConfigured')}</div>`;
    box.innerHTML = `<div class="rank">${rank.toUpperCase()}</div>
      <div>${t('result.makespan')} <b class="mono">${m.makespan}</b>${refLb(S.ref && S.ref.makespan, S.lb && S.lb.makespan)}</div>
      <div>${t('result.moves')} <b class="mono">${m.moves}</b>${refLb(S.ref && S.ref.moves, S.lb && S.lb.moves)}</div>
      ${better ? `<div class="sub">${t('result.newBest')}</div>` : ''}
      <div class="sub">${t('result.' + rank)}</div>
      ${lbForm}
      <div class="row"><button id="res-gif">${t('btn.gif')}</button><button id="res-tweet">${t('btn.tweet')}</button><button id="res-ranking">${t('btn.ranking')}</button></div>
      <div class="note">${t('tweet.note')}</div>
      <button id="result-close">${t('btn.close')}</button>`;
    $('result-close').onclick = () => { box.className = 'result'; };
    $('res-gif').onclick = () => exportGif();
    $('res-tweet').onclick = () => tweet();
    $('res-ranking').onclick = () => showRanking();
    if ($('lb-submit')) {
      $('lb-submit').onclick = () => submitScore();
      $('lb-name').onkeydown = ev => { if (ev.key === 'Enter') submitScore(); ev.stopPropagation(); };
      setTimeout(() => { if (!playerName()) $('lb-name').focus(); }, 50);
    }
  }

  // ============================================================ ranking
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function playerName() { try { return localStorage.getItem('human_mapf_name') || ''; } catch (e) { return ''; } }
  function stageKey() { return `${S.mapId}:${S.N}`; }
  function encodePath(p) {
    let out = '';
    for (let k = 1; k < p.length; ++k) { const d = p[k] - p[k - 1]; out += d === 0 ? 'W' : d === 1 ? 'R' : d === -1 ? 'L' : d === S.map.w ? 'D' : 'U'; }
    return out;
  }

  async function submitScore() {
    const r = S.lastResult; if (!r || !LB.configured()) return;
    const input = $('lb-name'), msg = $('lb-msg'), btn = $('lb-submit');
    const name = LB.sanitizeName(input.value);
    if (!name) { msg.className = 'lb-msg err'; msg.textContent = t('lb.needName'); input.focus(); return; }
    try { localStorage.setItem('human_mapf_name', name); } catch (e) { }
    btn.disabled = true; input.disabled = true; msg.className = 'lb-msg'; msg.textContent = t('lb.submitting');
    try {
      const res = await LB.submit(stageKey(), name, r.paths);
      r.name = name;
      r.rankMakespan = { rank: res.makespan.rank, total: res.makespan.total };
      r.rankMoves = { rank: res.moves.rank, total: res.moves.total };
      msg.innerHTML = t('lb.result', res.makespan.rank, res.makespan.total, res.moves.rank, res.moves.total)
        + ((res.makespan.improved || res.moves.improved) ? '' : ` <span class="sub">${t('lb.notImproved')}</span>`);
      S.champs = null; updateChampInfo(); updatePanel();
      Sound.goal();
    } catch (e) {
      msg.className = 'lb-msg err'; msg.textContent = t('lb.submitFail', e.message || e);
      btn.disabled = false; input.disabled = false;
    }
  }

  function rankTable(entries, cmpKey) {
    if (!entries.length) return `<div class="sub">${t('lb.empty')}</div>`;
    const me = playerName();
    return `<table class="lb"><tr><th>${t('lb.rank')}</th><th>${t('lb.name')}</th><th>makespan</th><th>${LANG === 'ja' ? '距離' : 'dist'}</th></tr>` +
      entries.map((e, i) => `<tr class="${e.name === me ? 'me' : ''}"><td>${i + 1}</td><td>${escapeHtml(e.name)}</td><td class="mono">${e.makespan}</td><td class="mono">${e.moves}</td></tr>`).join('') + '</table>';
  }

  async function showRanking() {
    const ov = $('ranking'), body = $('ranking-body');
    $('ranking-title').textContent = t('lb.title', mapName(S.mapId), S.N);
    ov.classList.add('show');
    if (!LB.configured()) { body.innerHTML = `<div class="lb-msg">${t('lb.notConfigured')}</div>`; return; }
    body.innerHTML = `<div class="lb-msg">${t('lb.loading')}</div>`;
    try {
      const b = await LB.top(stageKey());
      body.innerHTML = `<div class="sub">${t('lb.players', Math.max(b.makespan.length, b.moves.length))}</div>
        <div class="lb-cols"><div class="lb-col"><h3>${t('lb.makespan')}</h3>${rankTable(b.makespan)}</div><div class="lb-col"><h3>${t('lb.moves')}</h3>${rankTable(b.moves)}</div></div>`;
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
    el.innerHTML = b && b.makespan ? t('champ.line', escapeHtml(b.makespan.name), b.makespan.makespan, escapeHtml(b.moves.name), b.moves.moves, b.players) : t('champ.none');
  }
  async function decorateHomeChamps() {
    const c = await fetchChamps(); if (!c) return;
    document.querySelectorAll('#stage-cards .chip[data-stage]').forEach(ch => {
      const b = c[ch.getAttribute('data-stage')];
      if (b && b.makespan && !ch.querySelector('.crown')) {
        const sp = document.createElement('span'); sp.className = 'crown';
        sp.textContent = `👑 ${b.makespan.name}`; sp.title = t('champ.line', b.makespan.name, b.makespan.makespan, b.moves.name, b.moves.moves, b.players);
        ch.appendChild(sp);
      }
    });
  }

  // ============================================================ share: tweet / GIF
  function tweet() {
    const r = S.lastResult; if (!r) return;
    const rk = x => x && x.rank ? t('tweet.rank', x.rank, x.total) : '';
    const text = t('tweet.text', mapName(S.mapId), S.N, r.makespan, rk(r.rankMakespan), r.moves, rk(r.rankMoves));
    const url = location.href.split('#')[0].split('?')[0];
    window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url), '_blank', 'noopener');
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
      const saved = { ctx, cell: S.cell, mode: S.mode, anim: S.anim };
      ctx = c2; S.cell = cs; S.mode = 'play'; S.anim = { t: tt, paths, isRef: false, failT: null, makespan };
      try { draw(); } finally { ctx = saved.ctx; S.cell = saved.cell; S.mode = saved.mode; S.anim = saved.anim; }
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
</table><p>${t('t6.p')}</p></div>`;
  }

  // ============================================================ screens
  function buildHome() {
    const wrap = $('stage-cards'); wrap.innerHTML = '';
    for (const d of M.MAP_DEFS) {
      const m = M.getMap(d.id);
      const card = document.createElement('div'); card.className = 'stage-card';
      const pv = document.createElement('canvas');
      const px = Math.max(3, Math.floor(96 / Math.max(m.w, m.h)));
      pv.width = m.w * px; pv.height = m.h * px;
      const c = pv.getContext('2d');
      c.fillStyle = '#f4f1ea'; c.fillRect(0, 0, pv.width, pv.height);
      c.fillStyle = '#3b3a37';
      for (let y = 0; y < m.h; ++y) for (let x = 0; x < m.w; ++x) if (!m.free[y * m.w + x]) c.fillRect(x * px, y * px, px, px);
      card.appendChild(pv);
      const info = document.createElement('div'); info.className = 'info';
      info.innerHTML = `<div class="name">${mapName(d.id)}</div><div class="desc">${m.w}×${m.h} — ${t('desc.' + d.id)}</div>`;
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
  $('btn-ref').addEventListener('click', () => { S.showRef = !S.showRef; $('btn-ref').classList.toggle('on', S.showRef); computeLanes(); draw(); });
  $('btn-play-ref').addEventListener('click', playReference);
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
  $('btn-help').addEventListener('click', () => { $('help').classList.toggle('show'); });
  $('help-close').addEventListener('click', () => { $('help').classList.remove('show'); });
  window.addEventListener('resize', () => { if (S.map && $('game').classList.contains('show')) { layout(); draw(); } });

  // ============================================================ start
  $('speed').value = S.speed;
  applyLang();
  showHome();
  window.MAPF_GAME = { showGame, showHome, toggleLang, playReference, exportGif, submitScore, showRanking, tweet, state: S };
})();
