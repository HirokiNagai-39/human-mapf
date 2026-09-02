/*
 * maps.js — オリジナルマップ生成
 *   tutorial        : 4x4, 障害物 2
 *   empty           : 16x16 空
 *   random          : 16x16, 約 10% 障害物, 連結 (固定)
 *   room            : 4x4 の部屋 x 16 (4行4列), 幅 1 の壁, 隣接部屋間に幅 1〜2 の通路
 *   maze            : 幅 2 の通路が幅 1 の壁で 6x6 の迷路
 *   warehouse       : 幅 1 x 長さ 5 の棚 (4 行 3 列), 通路幅 2
 *   warehouse_hard  : 幅 1 x 長さ 5 の棚 (6 行 4 列), 通路幅 1 (すれ違えない)
 *   hourglass       : 21x21 の砂時計. 中央が幅 1 の通路
 *   bremen          : ブレーメン旧市街の地図から起こした 50x50
 * 障害物・start / goal はすべて固定 (乱数 seed は定数).
 * 返り値は { w, h, free: Uint8Array } (lns2.js の map 形式)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lns2.js'));
  else root.MAPS = factory(root.LNS2);
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  function blank(w, h, v) { return { w, h, free: new Uint8Array(w * h).fill(v ? 1 : 0) }; }
  function set(m, x, y, v) { if (x >= 0 && y >= 0 && x < m.w && y < m.h) m.free[y * m.w + x] = v ? 1 : 0; }
  function isConnected(m) {
    const G = L.buildGraph(m);
    let total = 0; for (let c = 0; c < m.w * m.h; ++c) total += m.free[c];
    return L.largestComponent(G).length === total;
  }

  function tutorial() {
    const m = blank(4, 4, 1);
    set(m, 1, 1, 0); set(m, 2, 2, 0);
    return m;
  }

  function empty() { return blank(16, 16, 1); }

  function random(seed) {
    const w = 16, h = 16, target = Math.round(w * h * 0.10);
    for (let attempt = 0; attempt < 1000; ++attempt) {
      const rng = L.makeRng((seed | 0) * 1000003 + attempt);
      const m = blank(w, h, 1);
      const cells = Array.from({ length: w * h }, (_, i) => i);
      for (let i = cells.length - 1; i > 0; --i) { const j = Math.floor(rng() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
      for (let k = 0; k < target; ++k) m.free[cells[k]] = 0;
      if (isConnected(m)) return m;
    }
    throw new Error('random map generation failed');
  }

  // 4x4 部屋 x (4 行 4 列). 壁幅 1. 外壁なし → 4*4 + 3 = 19
  function room(seed) {
    const R = 4, S = 4, W = R * S + (R - 1);
    const rng = L.makeRng((seed | 0) * 7 + 12345);
    const m = blank(W, W, 1);
    // 壁
    for (let k = 1; k < R; ++k) {
      const p = k * (S + 1) - 1;
      for (let i = 0; i < W; ++i) { set(m, p, i, 0); set(m, i, p, 0); }
    }
    // 通路 (隣接部屋ごとに幅 1 または 2)
    const door = (wallPos, along, vertical) => {
      const width = rng() < 0.5 ? 1 : 2;
      const off = Math.floor(rng() * (S - width + 1));
      for (let d = 0; d < width; ++d) {
        const a = along + off + d;
        if (vertical) set(m, wallPos, a, 1); else set(m, a, wallPos, 1);
      }
    };
    for (let ry = 0; ry < R; ++ry) for (let rx = 0; rx < R; ++rx) {
      const x0 = rx * (S + 1), y0 = ry * (S + 1);
      if (rx < R - 1) door(x0 + S, y0, true);   // 右の部屋との壁
      if (ry < R - 1) door(y0 + S, x0, false);  // 下の部屋との壁
    }
    return m;
  }

  // 6x6 のセル迷路. 通路幅 2, 壁幅 1. サイズ = 6*2 + 5 = 17
  function maze(seed) {
    const C = 6, P = 2, W = C * P + (C - 1);
    const rng = L.makeRng((seed | 0) * 31 + 777);
    const m = blank(W, W, 0);
    const carveCell = (cx, cy) => { for (let dy = 0; dy < P; ++dy) for (let dx = 0; dx < P; ++dx) set(m, cx * (P + 1) + dx, cy * (P + 1) + dy, 1); };
    const carveWall = (cx, cy, nx, ny) => {
      if (nx !== cx) { const x = Math.max(cx, nx) * (P + 1) - 1; for (let d = 0; d < P; ++d) set(m, x, cy * (P + 1) + d, 1); }
      else { const y = Math.max(cy, ny) * (P + 1) - 1; for (let d = 0; d < P; ++d) set(m, cx * (P + 1) + d, y, 1); }
    };
    const seen = new Uint8Array(C * C);
    const stack = [[0, 0]]; seen[0] = 1; carveCell(0, 0);
    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const nb = [];
      if (cx > 0 && !seen[cy * C + cx - 1]) nb.push([cx - 1, cy]);
      if (cx < C - 1 && !seen[cy * C + cx + 1]) nb.push([cx + 1, cy]);
      if (cy > 0 && !seen[(cy - 1) * C + cx]) nb.push([cx, cy - 1]);
      if (cy < C - 1 && !seen[(cy + 1) * C + cx]) nb.push([cx, cy + 1]);
      if (nb.length === 0) { stack.pop(); continue; }
      const [nx, ny] = nb[Math.floor(rng() * nb.length)];
      seen[ny * C + nx] = 1; carveCell(nx, ny); carveWall(cx, cy, nx, ny);
      stack.push([nx, ny]);
    }
    // ループを少し足す (行き止まりだらけだと MAPF として単調になるため): 壁 4 枚を追加で開ける
    for (let k = 0; k < 4; ++k) {
      const cx = Math.floor(rng() * (C - 1)), cy = Math.floor(rng() * (C - 1));
      if (rng() < 0.5) carveWall(cx, cy, cx + 1, cy); else carveWall(cx, cy, cx, cy + 1);
    }
    return m;
  }

  // 棚: 幅 1 (縦) x 長さ 5 (横). rows 行 x cols 列. aisle = 通路幅
  // 既定は 4 行 3 列 x 長さ 5 (warehouse). 省略時の値を変えないこと (既存ステージが変わってしまう)
  function warehouse(aisle, rows, cols, len) {
    rows = rows || 4; cols = cols || 3; len = len || 5;
    const w = aisle * (cols + 1) + len * cols;
    const h = aisle * (rows + 1) + rows;
    const m = blank(w, h, 1);
    for (let r = 0; r < rows; ++r) for (let c = 0; c < cols; ++c) {
      const x0 = aisle + c * (len + aisle), y0 = aisle + r * (1 + aisle);
      for (let d = 0; d < len; ++d) set(m, x0 + d, y0, 0);
    }
    return m;
  }

  // 21x21 の砂時計. 中心から離れるほど広がり, 中央 (10, 10) だけが幅 1 の通路になる
  function hourglass() {
    const W = 21, C = 10;
    const m = blank(W, W, 0);
    for (let y = 0; y < W; ++y) {
      const half = Math.abs(y - C);                 // 中心からの距離がそのまま半幅
      for (let x = C - half; x <= C + half; ++x) set(m, x, y, 1);
    }
    return m;
  }

  // ブレーメン旧市街 (Marktplatz 南〜Marktstraße〜Domsheide) の地図から起こした 50x50.
  // 建物の色を障害物として判定し, 文字ラベルを除外してから起こしたもの. '1' が障害物
  const BREMEN =
    '1111000000000000000000000000000000000011111111111111110000000000000000000000000000000000111111111111111000000000000000000000000000000000001111111111111100000000000000000100000000000000000111111111111110001000000000000001100000000000000001111111111111111110000000000000111110000000000000011111111111111111110000000000011111111000000000000100111111111111111100000000001111111111000000000000001111111111111111000000000001111111111100000000000001111111111111110000000000001111111111000000000000011111111111111100000000000001111111110000000000000011111111111111000000000000011111111110000000000000011111111111110000000000000111111111100000000000000011111111111110000011100000011111110001000000000000011111111111100000011000000011111000111000000000000011111101111000000011100000010110011110000000000001111100011110000000111100000000001111110000000011111111000111100000000111100000000111111100000000111111110001111000000000111000000001111111100000001111111100011100000000000000000000111111111000000111111111000111000000000000000110011111111110000000000011110001110000000000000000111111111111100000000000111110001100000000000000000111111111110000000000001111110000000000000000000000101111111000000000000011111110000000000000000000011001111100011000000000011111100000000000000000001111000000001111000000000000110000000011000000000111111000000111110000000000001000000001110100000011111110000011111100000000000000000001111111100000011111110001111110000000000000000000011111111000000011111111111110000000000000000000001111111111000000011111111111100000000000000000000111111111111000000011111111110000000000000000000011111111111111000000011111111000000000000000000001111111111111111100000011111100000000000000000000111111111111111111000000011110000000000000000000011111111111111111111000000001000000000000000110001111111111111111111111100000000000000000000011111011111111111111111111111100000000000000000000111111111111111111111111111111100000000000000000011111111111111111111111111111111000000000000000110111111111111111111111111111111110000000000000001111111111111111111111111111111111000000000000000011111111111111111111111111111111000000000000000000001111111111111111111111111111100000000000000000001111111011111111111111111111100000000000000000000011111100001111111111111111111100000000000000000000001100000011111111111111111110000000000000000000000001100001111111111111111111100000000000011100011000000000011111111111111111111000000000001111100111100000001111111111111111111110000000001111111111111100000001';
  function bremen() {
    const m = blank(50, 50, 1);
    for (let i = 0; i < 2500; ++i) if (BREMEN.charCodeAt(i) === 49) m.free[i] = 0;
    return m;
  }

  // 6x6 の木 (閉路なし, 空きマスはすべて幅 1). 6x6 の全パターン (1,061 万通り) から, 5 台のランダム配置で LaCAM3 が
  // 初期解に 2 秒以上かかるものを探して選んだ. 文字列は行優先 36 文字 ('@' = 障害物). start/goal は instanceSeed で固定
  function fromPattern(pattern, w, h) {
    const m = blank(w, h, 1);
    for (let i = 0; i < w * h; ++i) if (pattern.charCodeAt(i) === 64) m.free[i] = 0;
    return m;
  }
  const smallTree = pattern => fromPattern(pattern, 6, 6);
  const SMALL_TREES = [
    ['small_tree_1', '@@@.....@.@..@..@..@.@......@.@@@@@@', 821540000],
    ['small_tree_2', '@@...@@..@..@.@..@@.@@....@@@..@@@@@', 1719425020],
    ['small_tree_3', '@@...@@@.@..@...@...@@@..@.....@.@@@', 1664658025],
  ];

  // 20x20 の木 (閉路なし, 幅 1). 2 マス間隔の 10x10 格子の全域木 (DFS 型) で, 道が盤面全体に広がる.
  // ランダムな全域木 600 個から, big_tree のステージ seed の配置で LaCAM3 の初期解が最も遅いもの
  // (50 台で 24 秒. 10〜20 台は一瞬) をユーザーが選んだ (m22). '@' = 障害物
  const BIG_TREE =
    '.................@.@@@@@@@@@@@@@@@.@.@.@...............@...@.@@@@@@@@@@@@@@@@@.@.@.......@.......@.@.@.@@@@@.@.@@@.@@@.@.@.....@.@...@.....@.@@@@@.@@@@@.@@@@@@@...@.@.....@.......@@@.@.@.@.@@@@@@@@@.@.@.@.@.@.........@.@.@.@.@.@@@@@.@@@.@.@.@...@...@.@.@...@.@.@@@@@@@.@.@.@@@@@.@.....@.@.@.@.......@.@.@.@.@.@.@@@@@@@@@.@.@...@...@.....@.@.@.@@@@@@@.@@@.@.@.@.@.............@...@@@@@@@@@@@@@@@@@@@@@';

  // 15x25 のパルテノン神殿 (平面図, 入口が下). 外周の列柱, ケラ (神室) の壁, 奥の像, 内部の列柱. '@' = 障害物
  const TEMPLE =
    '................................@.@.@.@.@.@...................@.........@...................@.@@@@@@@.@......@.....@......@.@..@..@.@......@.....@......@.@.@.@.@.@......@.....@......@.@.@.@.@.@......@.....@......@.@.@.@.@.@......@.....@......@.@.@.@.@.@......@.....@......@.@@...@@.@...................@.........@...................@.@.@.@.@.@................................';

  // 16x16 の八分音符 (符頭 = 広い部屋, 符幹 = 幅 1 の縦道, はた = 行き止まりの曲線). '@' = 障害物
  const NOTE =
    '@@@@@@@@@.@@@@@@@@@@@@@@@...@@@@@@@@@@@@@.@..@@@@@@@@@@@@.@@..@@@@@@@@@@@.@@@.@@@@@@@@@@@.@@@..@@@@@@@@@@.@@@@.@@@@@@@@@@.@@@..@@@@@@@@@@.@@@.@@@@@@@@@@@.@@@@@@@@@.......@@@@@@@@.........@@@@@@..........@@@@@@..........@@@@@@@.........@@@@@@@@.......@@@@@@';

  // Rotation (writer: through さん): 5x5 の壁を一周する幅 1 のリング + 右上の突起 1 マス (自由マス 25)
  const ROTATION =
    '@@@@@@.@' + '.......@' + '.@@@@@.@' + '.@@@@@.@' + '.@@@@@.@' + '.@@@@@.@' + '.@@@@@.@' + '.......@';

  // Sunflower (2026-09-01): ひまわりの花頭 1 個. 種 = 中央の円形障害物, 幅 1 の花びらリング + 放射状の花びら 12 枚
  const SUNFLOWER =
    '@@@@@@@@@@@@@@@@@@@' +
    '@@@@@@@@@.@@@@@@@@@' +
    '@@@@@.@@@.@@@.@@@@@' +
    '@@@@@..@...@..@@@@@' +
    '@@@@@...@.@...@@@@@' +
    '@@...@.......@...@@' +
    '@@@.....@@@.....@@@' +
    '@@@@...@@@@@...@@@@' +
    '@@@.@.@@@@@@@.@.@@@' +
    '@.....@@@@@@@.....@' +
    '@@@.@.@@@@@@@.@.@@@' +
    '@@@@...@@@@@...@@@@' +
    '@@@.....@@@.....@@@' +
    '@@...@.......@...@@' +
    '@@@@@...@.@...@@@@@' +
    '@@@@@..@...@..@@@@@' +
    '@@@@@.@@@.@@@.@@@@@' +
    '@@@@@@@@@.@@@@@@@@@' +
    '@@@@@@@@@@@@@@@@@@@';

  // 障害物は固定 (乱数 seed も固定). start / goal は (map, N) ごとに固定 seed で生成する
  const STAGE_AGENTS = [10, 20, 30, 40, 50];
  const MAP_DEFS = [
    { id: 'tutorial', name: 'Tutorial', gen: () => tutorial(), agents: [2], instanceSeed: 35 },
    { id: 'empty', name: 'Empty 16x16', gen: () => empty(), agents: STAGE_AGENTS },
    { id: 'random', name: 'Random 16x16', gen: () => random(3), agents: STAGE_AGENTS },
    { id: 'room', name: 'Room 4x4', gen: () => room(2), agents: STAGE_AGENTS },
    { id: 'maze', name: 'Maze 6x6', gen: () => maze(5), agents: STAGE_AGENTS },
    { id: 'warehouse', name: 'Warehouse', gen: () => warehouse(2), agents: STAGE_AGENTS },
    { id: 'warehouse_hard', name: 'Warehouse-hard', gen: () => warehouse(1, 6, 4, 5), agents: STAGE_AGENTS },
    { id: 'hourglass', name: 'Hourglass', gen: () => hourglass(), agents: STAGE_AGENTS },
    { id: 'bremen', name: 'Bremen', gen: () => bremen(), agents: [10, 50, 100, 200, 300] },
    // 5x5 の空マップに 21〜25 台 (25 台では空きマスなし). 参考解は LaCAM* 300 秒 (tools/precompute.js では計算しない)
    { id: 'empty_but_not_empty', name: 'Empty but not empty', gen: () => blank(5, 5, 1), agents: [21, 22, 23, 24, 25], refSolver: 'LaCAM3' },
    ...SMALL_TREES.map(([id, pattern, seed], i) => ({ id, name: `Small tree No.${i + 1}`, gen: () => smallTree(pattern), agents: [5], instanceSeed: seed, refSolver: 'LaCAM3' })),
    { id: 'big_tree', name: 'Big tree', gen: () => fromPattern(BIG_TREE, 20, 20), agents: STAGE_AGENTS, refSolver: 'LaCAM3' },
    { id: 'temple', name: 'Temple', gen: () => fromPattern(TEMPLE, 15, 25), agents: STAGE_AGENTS, refSolver: 'LaCAM3' },
    { id: 'note', name: 'Eighth note', gen: () => fromPattern(NOTE, 16, 16), agents: [5, 10, 15, 20, 25], refSolver: 'LaCAM3' },
    // writer 応募 (through さん, 2026-08-31): リング + 突起 1 マス. start/goal は投稿された手動配置で固定
    { id: 'rotation', name: 'Rotation', author: 'through', gen: () => fromPattern(ROTATION, 8, 8), agents: [5, 10, 20], refSolver: 'through',
      instances: {
        5:  { starts: [57, 56, 32, 46, 12], goals: [62, 59, 48, 24, 14] },
        10: { starts: [58, 32, 10, 11, 57, 38, 59, 54, 24, 46], goals: [62, 46, 6, 12, 58, 40, 60, 13, 16, 61] },
        20: { starts: [38, 13, 9, 6, 54, 14, 32, 61, 8, 22, 58, 56, 57, 16, 48, 12, 30, 40, 62, 11], goals: [8, 22, 11, 48, 54, 6, 40, 46, 60, 24, 12, 9, 10, 62, 59, 58, 30, 16, 13, 32] },
      } },
    { id: 'sunflower', name: 'Sunflower', gen: () => fromPattern(SUNFLOWER, 19, 19), agents: [10, 20, 30, 40, 50], refSolver: 'LaCAM3' },
    // writer 応募 (Hori04 さん, 2026-09-01 投稿, 2026-09-03 採用): 応募名「エデ〇オン」は商標的に良くないため Power button に改名 (ユーザー決定)
    { id: 'power_button', name: 'Power button', author: 'Hori04', gen: () => fromPattern(
      '....@....' +
      '....@....' +
      '..@.@.@..' +
      '.@..@..@.' +
      '.@..@..@.' +
      '.@.....@.' +
      '..@...@..' +
      '...@@@...' +
      '.........', 9, 9), agents: [16], refSolver: 'Hori04',
      instances: {
        16: { starts: [32, 33, 42, 41, 51, 50, 59, 58, 49, 57, 48, 47, 39, 38, 29, 30], goals: [30, 29, 38, 39, 47, 48, 57, 49, 58, 59, 50, 51, 41, 42, 33, 32] },
      } },
    // writer 応募 (sigtuna さん, 2026-09-01 投稿, 2026-09-03 採用): Clock
    { id: 'clock', name: "Clock", author: 'sigtuna', gen: () => fromPattern(
      '@@@@@@@@@@@@@@@' +
      '@@@@@.....@@@@@' +
      '@@@....@....@@@' +
      '@@.....@.....@@' +
      '@@.....@.....@@' +
      '@......@......@' +
      '@......@......@' +
      '@......@@@@@..@' +
      '@.............@' +
      '@.............@' +
      '@@...........@@' +
      '@@...........@@' +
      '@@@.........@@@' +
      '@@@@@.....@@@@@' +
      '@@@@@@@@@@@@@@@', 15, 15), agents: [12, 24, 36], refSolver: 'sigtuna',
      instances: {
        12: { starts: [22, 118, 202, 106, 40, 162, 184, 62, 72, 190, 152, 34], goals: [40, 72, 118, 162, 190, 202, 184, 152, 106, 62, 34, 22] },
        24: { starts: [201, 185, 169, 153, 137, 121, 91, 77, 63, 49, 35, 21, 23, 39, 55, 71, 87, 103, 133, 147, 161, 175, 189, 203], goals: [24, 40, 56, 72, 88, 118, 148, 162, 176, 190, 204, 202, 200, 184, 168, 152, 136, 106, 76, 62, 48, 34, 20, 22] },
        36: { starts: [95, 144, 65, 128, 83, 154, 99, 79, 141, 124, 68, 159, 130, 81, 156, 98, 64, 140, 85, 160, 126, 70, 158, 94, 155, 84, 143, 100, 66, 129, 80, 139, 96, 145, 69, 125], goals: [23, 24, 40, 41, 57, 72, 88, 103, 118, 133, 148, 162, 177, 191, 190, 204, 203, 202, 201, 200, 184, 183, 167, 152, 136, 121, 106, 91, 76, 62, 47, 33, 34, 20, 21, 22] },
      } },
    // writer 応募 (ku さん, 2026-09-01 投稿, 2026-09-03 採用): Lattice
    { id: 'lattice', name: "Lattice", author: 'ku', gen: () => fromPattern(
      '...............' +
      '.@.@.@.@.@.@.@.' +
      '...............' +
      '.@.@.@.@.@.@.@.' +
      '...............' +
      '.@.@.@.@.@.@.@.' +
      '...............' +
      '.@.@.@.@.@.@.@.' +
      '...............' +
      '.@.@.@.@.@.@.@.' +
      '...............' +
      '.@.@.@.@.@.@.@.' +
      '...............' +
      '.@.@.@.@.@.@.@.' +
      '...............', 15, 15), agents: [10, 20, 30, 40, 50], refSolver: 'ku',
      instances: {
        10: { starts: [164, 141, 127, 100, 93, 85, 158, 201, 135, 21], goals: [128, 137, 42, 102, 74, 107, 211, 111, 203, 47] },
        20: { starts: [89, 67, 35, 214, 223, 215, 75, 161, 130, 128, 203, 209, 65, 107, 103, 77, 212, 193, 183, 175], goals: [34, 130, 98, 1, 104, 33, 222, 53, 139, 103, 224, 215, 10, 93, 7, 165, 113, 49, 13, 91] },
        30: { starts: [135, 113, 216, 211, 69, 109, 97, 215, 167, 158, 120, 33, 218, 188, 45, 165, 12, 61, 0, 34, 44, 185, 38, 210, 30, 161, 89, 175, 68, 87], goals: [152, 36, 1, 155, 43, 224, 219, 124, 195, 137, 69, 75, 67, 221, 150, 3, 8, 73, 171, 162, 100, 177, 12, 33, 38, 201, 127, 181, 128, 109] },
        40: { starts: [119, 135, 83, 183, 130, 163, 68, 195, 223, 103, 12, 220, 11, 102, 137, 94, 87, 175, 39, 62, 17, 153, 99, 155, 203, 122, 10, 43, 96, 181, 192, 79, 222, 45, 159, 210, 36, 55, 212, 81], goals: [115, 15, 191, 87, 216, 103, 79, 13, 123, 133, 60, 75, 203, 124, 21, 160, 189, 127, 99, 128, 55, 145, 143, 61, 5, 73, 149, 42, 100, 137, 14, 102, 23, 184, 150, 214, 179, 74, 151, 154] },
        50: { starts: [94, 199, 47, 87, 173, 71, 207, 131, 31, 152, 137, 0, 95, 177, 156, 193, 165, 117, 120, 180, 39, 191, 125, 161, 85, 182, 171, 157, 15, 92, 38, 77, 151, 159, 179, 214, 183, 126, 62, 111, 124, 8, 167, 218, 90, 175, 101, 188, 162, 36], goals: [154, 191, 222, 93, 8, 213, 1, 6, 115, 175, 210, 64, 127, 169, 135, 197, 34, 183, 90, 205, 165, 214, 155, 158, 91, 125, 137, 96, 113, 117, 130, 72, 122, 40, 111, 12, 11, 49, 102, 139, 147, 187, 60, 17, 3, 95, 87, 30, 68, 207] },
      } },
  ];

  function getMap(id) {
    const d = MAP_DEFS.find(x => x.id === id);
    if (!d) throw new Error('unknown map ' + id);
    return d.gen();
  }

  // ステージのインスタンス (start/goal). def.instances に固定配置があればそれを使い (writer 採用ステージ),
  // 無ければ従来どおり stageSeed から生成する
  function getInstance(id, N, G) {
    const d = MAP_DEFS.find(x => x.id === id);
    const fixed = d && d.instances && d.instances[N];
    // 通常の配列で返す (L.generateInstance と同じ型に合わせる. 型付き配列だと .map の結果が数値に潰れる)
    if (fixed) return { starts: fixed.starts.slice(), goals: fixed.goals.slice() };
    return L.generateInstance(G, N, stageSeed(id, N));
  }

  // (map, N) ごとの固定 seed
  function stageSeed(id, N) {
    const d = MAP_DEFS.find(x => x.id === id);
    if (d && d.instanceSeed != null) return d.instanceSeed;
    let h = 2166136261;
    for (let i = 0; i < id.length; ++i) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) * 100 + N;
  }

  function toText(m) {
    let s = '';
    for (let y = 0; y < m.h; ++y) { for (let x = 0; x < m.w; ++x) s += m.free[y * m.w + x] ? '.' : '@'; s += '\n'; }
    return s;
  }

  return { MAP_DEFS, STAGE_AGENTS, getMap, getInstance, stageSeed, toText, isConnected, tutorial, empty, random, room, maze, warehouse, hourglass, bremen };
});
