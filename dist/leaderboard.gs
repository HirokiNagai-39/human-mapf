/*
 * lns2.js — 標準 MAPF 用 LNS2 (停止 + 上下左右, 頂点衝突 / 辺(スワップ)衝突)
 *
 * HirokiNagai-39/mawpf の LNS2 (algorithms/src/lns2.cpp) を JS に移植し,
 * 回転・加速・フォロワー衝突を取り除いて通常の MAPF 設定に戻したもの.
 *   1. ソフト制約 PP (衝突にペナルティを付けた時空間 A*) で初期解を作る
 *   2. 衝突しているエージェント集合から近傍 B をランダムに選ぶ
 *   3. B を (他エージェントを固定して) 順に再計画し, 衝突数が減れば採用
 *   4. 衝突 0 になったら終了
 *
 * Node (module.exports) とブラウザ / Web Worker (グローバル LNS2) の両方で動く.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LNS2 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- PRNG
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; --i) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ---------------------------------------------------------------- maps
  // MovingAI 形式 (.map) のパース. '.' と 'G' を通行可能とする.
  function parseMap(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    let w = 0, h = 0, i = 0;
    for (; i < lines.length; ++i) {
      const L = lines[i].trim(); let m;
      if ((m = /^height\s+(\d+)/.exec(L))) h = +m[1];
      else if ((m = /^width\s+(\d+)/.exec(L))) w = +m[1];
      else if (/^map$/.test(L)) { ++i; break; }
    }
    const free = new Uint8Array(w * h);
    for (let y = 0; y < h; ++y) {
      const row = lines[i + y] || '';
      for (let x = 0; x < w; ++x) {
        const ch = row[x];
        free[y * w + x] = (ch === '.' || ch === 'G') ? 1 : 0;
      }
    }
    return { w, h, free };
  }

  function makeEmptyMap(w, h) {
    return { w, h, free: new Uint8Array(w * h).fill(1) };
  }

  function makeRandomMap(w, h, density, seed) {
    const rng = makeRng(seed);
    const free = new Uint8Array(w * h);
    for (let c = 0; c < w * h; ++c) free[c] = rng() < density ? 0 : 1;
    return { w, h, free };
  }

  // ---------------------------------------------------------------- graph
  // nbr[c*5 .. c*5+nbrCnt[c]) : 先頭は自分自身 (停止), 以降は隣接セル
  function buildGraph(map) {
    const { w, h, free } = map; const V = w * h;
    const nbr = new Int32Array(V * 5); const nbrCnt = new Uint8Array(V);
    for (let c = 0; c < V; ++c) {
      if (!free[c]) continue;
      let k = 0; const b = c * 5; const x = c % w, y = (c / w) | 0;
      nbr[b + k++] = c;
      if (x > 0 && free[c - 1]) nbr[b + k++] = c - 1;
      if (x < w - 1 && free[c + 1]) nbr[b + k++] = c + 1;
      if (y > 0 && free[c - w]) nbr[b + k++] = c - w;
      if (y < h - 1 && free[c + w]) nbr[b + k++] = c + w;
      nbrCnt[c] = k;
    }
    return { w, h, free, V, nbr, nbrCnt };
  }

  function bfsDist(G, src) {
    const d = new Int32Array(G.V).fill(-1);
    const q = new Int32Array(G.V); let qh = 0, qt = 0;
    d[src] = 0; q[qt++] = src;
    while (qh < qt) {
      const c = q[qh++]; const b = c * 5, n = G.nbrCnt[c];
      for (let k = 1; k < n; ++k) { const u = G.nbr[b + k]; if (d[u] < 0) { d[u] = d[c] + 1; q[qt++] = u; } }
    }
    return d;
  }

  // 連結成分ラベル付け. 最大成分のセル配列を返す
  function largestComponent(G) {
    const label = new Int32Array(G.V).fill(-1);
    let best = [], id = 0;
    const q = new Int32Array(G.V);
    for (let s = 0; s < G.V; ++s) {
      if (!G.free[s] || label[s] >= 0) continue;
      let qh = 0, qt = 0; q[qt++] = s; label[s] = id; const cells = [];
      while (qh < qt) {
        const c = q[qh++]; cells.push(c); const b = c * 5, n = G.nbrCnt[c];
        for (let k = 1; k < n; ++k) { const u = G.nbr[b + k]; if (label[u] < 0) { label[u] = id; q[qt++] = u; } }
      }
      if (cells.length > best.length) best = cells;
      ++id;
    }
    return best;
  }

  // ランダムインスタンス生成 (最大連結成分から start / goal をそれぞれ重複なく抽出)
  function generateInstance(G, N, seed) {
    const cells = largestComponent(G);
    if (cells.length < N) throw new Error('map too small for ' + N + ' agents');
    const rng = makeRng(seed * 7919 + 17);
    const starts = shuffle(cells.slice(), rng).slice(0, N);
    const goals = shuffle(cells.slice(), rng).slice(0, N);
    return { starts, goals };
  }

  // ---------------------------------------------------------------- metrics
  function posAt(path, t) { return t < path.length ? path[t] : path[path.length - 1]; }
  // 末尾の (ゴールでの) 待機を取り除く
  function trimPath(path) {
    let e = path.length - 1;
    while (e > 0 && path[e] === path[e - 1]) --e;
    return e === path.length - 1 ? path : path.slice(0, e + 1);
  }
  function pathMoves(path) {
    let m = 0;
    for (let t = 1; t < path.length; ++t) if (path[t] !== path[t - 1]) ++m;
    return m;
  }
  function metrics(paths) {
    let makespan = 0, moves = 0, sumOfCosts = 0;
    for (const p of paths) {
      const tp = trimPath(p);
      makespan = Math.max(makespan, tp.length - 1);
      sumOfCosts += tp.length - 1;
      moves += pathMoves(tp);
    }
    return { makespan, moves, sumOfCosts };
  }

  // 衝突検出. 頂点衝突 (同時刻同セル) と辺衝突 (スワップ) を数える.
  // 経路の終端以降はその場に留まるとみなす.
  // 返り値: { count, conf: Uint8Array(N), list: [{t,type,a,b,cell,cell2}] (collect 時) }
  function findCollisions(paths, V, collect) {
    const N = paths.length;
    let T = 0;
    for (let i = 0; i < N; ++i) T = Math.max(T, paths[i].length - 1);
    const conf = new Uint8Array(N);
    const list = collect ? [] : null;
    let count = 0;
    let stampA = new Int32Array(V).fill(-1), agentA = new Int32Array(V);
    let stampB = new Int32Array(V).fill(-1), agentB = new Int32Array(V);
    const cur = new Int32Array(N), prev = new Int32Array(N);
    for (let t = 0; t <= T; ++t) {
      // swap buffers: A = time t, B = time t-1
      const ts = stampA; stampA = stampB; stampB = ts;
      const ta = agentA; agentA = agentB; agentB = ta;
      for (let i = 0; i < N; ++i) {
        prev[i] = cur[i];
        const c = cur[i] = posAt(paths[i], t);
        if (stampA[c] === t) {
          ++count; conf[i] = 1; conf[agentA[c]] = 1;
          if (list) list.push({ t, type: 'vertex', a: agentA[c], b: i, cell: c, cell2: c });
        } else { stampA[c] = t; agentA[c] = i; }
      }
      if (t === 0) continue;
      for (let i = 0; i < N; ++i) {
        const p = prev[i], c = cur[i];
        if (p === c) continue;
        if (stampB[c] !== t - 1) continue;
        const j = agentB[c];
        if (j === i || j < i) continue; // 同一ペアの二重計上を防ぐ (i<j のときのみ記録)
        if (cur[j] === p && prev[j] === c) {
          ++count; conf[i] = 1; conf[j] = 1;
          if (list) list.push({ t, type: 'edge', a: i, b: j, cell: p, cell2: c });
        }
      }
    }
    return { count, conf, list };
  }

  // ---------------------------------------------------------------- heap
  function Heap() { this.f = []; this.g = []; this.k = []; }
  Heap.prototype.size = function () { return this.f.length; };
  Heap.prototype.less = function (i, j) {
    return this.f[i] !== this.f[j] ? this.f[i] < this.f[j] : this.g[i] > this.g[j]; // f 小 → g 大 (深い方) 優先
  };
  Heap.prototype.swap = function (i, j) {
    let t = this.f[i]; this.f[i] = this.f[j]; this.f[j] = t;
    t = this.g[i]; this.g[i] = this.g[j]; this.g[j] = t;
    t = this.k[i]; this.k[i] = this.k[j]; this.k[j] = t;
  };
  Heap.prototype.push = function (f, g, k) {
    this.f.push(f); this.g.push(g); this.k.push(k);
    let i = this.f.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.less(i, p)) { this.swap(i, p); i = p; } else break; }
  };
  Heap.prototype.pop = function () {
    const n = this.f.length - 1;
    this.swap(0, n);
    const r = { f: this.f.pop(), g: this.g.pop(), k: this.k.pop() };
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, rr = l + 1; let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (rr < n && this.less(rr, m)) m = rr;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return r;
  };

  // ---------------------------------------------------------------- solver
  function Solver(G, starts, goals, seed, opts) {
    opts = opts || {};
    this.G = G; this.V = G.V;
    this.N = starts.length;
    this.starts = starts; this.goals = goals;
    this.rng = makeRng(seed);
    this.dist = new Array(this.N);
    for (let i = 0; i < this.N; ++i) this.dist[i] = bfsDist(G, goals[i]);
    const N = this.N;
    this.neighborhoodMin = Math.max(2, Math.floor(N / 20));
    this.neighborhoodMax = Math.min(N, Math.max(5, Math.floor(N / 5)));
    this.maxRepairTries = opts.maxRepairTries || 16;
    this.horizonSlack = opts.horizonSlack || 200;
    this.maxExpand = opts.maxExpand || 400000; // A* 1 回あたりの展開上限
    this.wInit = opts.collisionWeightInit || 10;
    this.wRepair = opts.collisionWeightRepair || 1000;
    let mx = 0;
    for (let i = 0; i < N; ++i) mx = Math.max(mx, this.dist[i][starts[i]]);
    this.horizon = mx + Math.max(this.horizonSlack, mx);
    this.lowerBound = { makespan: mx, moves: 0 };
    for (let i = 0; i < N; ++i) this.lowerBound.moves += Math.max(0, this.dist[i][starts[i]]);
    this.clearOcc();
  }

  Solver.prototype.clearOcc = function () {
    this.occ = [];                                  // occ[t] : Map(cell -> agent)
    this.goalAgent = new Int32Array(this.V).fill(-1); // ゴールに留まるエージェント
    this.goalTime = new Int32Array(this.N);           // ゴール到達時刻
    this.cellTimes = new Array(this.V);               // cell -> [t,...] (経路上の占有時刻)
  };

  Solver.prototype.occAt = function (t, cell) {
    if (t < this.occ.length) { const a = this.occ[t].get(cell); if (a !== undefined) return a; }
    const ga = this.goalAgent[cell];
    if (ga !== -1 && this.goalTime[ga] <= t) return ga;
    return -1;
  };

  // 時刻 nt に v -> u と動くときの衝突数 (頂点 + スワップ)
  Solver.prototype.collisionCount = function (nt, v, u) {
    let c = 0;
    if (this.occAt(nt, u) !== -1) ++c;
    if (u !== v) {
      const b = this.occAt(nt - 1, u);
      if (b !== -1 && this.occAt(nt, v) === b) ++c;
    }
    return c;
  };

  // ゴール g に時刻 t で到着したとき, それ以降に他者が g を通る回数
  Solver.prototype.futureOcc = function (g, t) {
    let k = 0;
    const ts = this.cellTimes[g];
    if (ts) for (let i = 0; i < ts.length; ++i) if (ts[i] > t) ++k;
    const ga = this.goalAgent[g];
    if (ga !== -1) k += 1000; // 別エージェントのゴールと一致 (通常起こらない)
    return k;
  };

  Solver.prototype.reserve = function (agent, path) {
    for (let t = 0; t < path.length; ++t) {
      while (this.occ.length <= t) this.occ.push(new Map());
      const c = path[t];
      this.occ[t].set(c, agent);
      (this.cellTimes[c] || (this.cellTimes[c] = [])).push(t);
    }
    const g = path[path.length - 1];
    this.goalAgent[g] = agent;
    this.goalTime[agent] = path.length - 1;
  };

  // 時空間 A* (衝突にペナルティ). hard=true なら衝突する遷移を禁止.
  Solver.prototype.astar = function (agent, wCol, hard, deadline) {
    const V = this.V, G = this.G, D = this.dist[agent];
    const s = this.starts[agent], g = this.goals[agent];
    if (D[s] < 0) return null;
    const open = new Heap();
    const gbest = new Map(), parent = new Map();
    const sk = s; // key = t*V + cell
    open.push(D[s], 0, sk); gbest.set(sk, 0); parent.set(sk, -1);
    let best = Infinity, bestKey = -1, iter = 0;
    const horizon = this.horizon, maxExpand = this.maxExpand;
    while (open.size() > 0) {
      if ((++iter & 255) === 0 && deadline && Date.now() > deadline) return null;
      if (iter > maxExpand) return null;
      const cur = open.pop();
      if (gbest.get(cur.k) !== cur.g) continue;
      if (cur.f >= best) break;
      const t = Math.floor(cur.k / V), v = cur.k - t * V;
      if (v === g) {
        const k = this.futureOcc(g, t);
        if (k === 0) { best = cur.g; bestKey = cur.k; break; }
        if (!hard) { const cand = cur.g + wCol * k; if (cand < best) { best = cand; bestKey = cur.k; } }
      }
      if (t >= horizon) continue;
      const nt = t + 1, b = v * 5, n = G.nbrCnt[v];
      for (let i = 0; i < n; ++i) {
        const u = G.nbr[b + i];
        if (D[u] < 0) continue;
        const c = this.collisionCount(nt, v, u);
        if (hard && c > 0) continue;
        const ng = cur.g + 1 + wCol * c;
        const nk = nt * V + u;
        const old = gbest.get(nk);
        if (old === undefined || ng < old) {
          gbest.set(nk, ng); parent.set(nk, cur.k);
          open.push(ng + D[u], ng, nk);
        }
      }
    }
    if (bestKey < 0) return null;
    const rev = [];
    for (let k = bestKey; k !== -1; k = parent.get(k)) rev.push(k % V);
    rev.reverse();
    return rev;
  };

  Solver.prototype.initialSoftPP = function (deadline) {
    const N = this.N; const paths = new Array(N);
    this.clearOcc();
    const order = shuffle(Array.from({ length: N }, (_, i) => i), this.rng);
    for (let k = 0; k < N; ++k) {
      const i = order[k];
      const p = this.astar(i, this.wInit, false, deadline);
      if (!p) return null;
      paths[i] = p; this.reserve(i, p);
    }
    return paths;
  };

  Solver.prototype.pickSubset = function (conflictAgents) {
    const B = [];
    if (conflictAgents.length === 0) return B;
    const kLo = Math.min(this.neighborhoodMin, conflictAgents.length);
    const kHi = Math.min(this.neighborhoodMax, conflictAgents.length);
    const K = randInt(this.rng, kLo, kHi);
    const used = new Set();
    while (B.length < K) {
      const a = conflictAgents[randInt(this.rng, 0, conflictAgents.length - 1)];
      if (!used.has(a)) { used.add(a); B.push(a); }
    }
    return B;
  };

  // B 以外を固定し, B をランダム順に再計画 (paths は破壊的に更新; 失敗時 false)
  Solver.prototype.repairSubset = function (paths, B, deadline) {
    if (B.length === 0) return false;
    const inB = new Uint8Array(this.N);
    for (const a of B) inB[a] = 1;
    this.clearOcc();
    for (let i = 0; i < this.N; ++i) if (!inB[i]) this.reserve(i, paths[i]);
    const order = shuffle(B.slice(), this.rng);
    for (const i of order) {
      if (deadline && Date.now() > deadline) return false;
      let p = this.astar(i, this.wRepair, true, deadline);
      if (!p) p = this.astar(i, this.wRepair, false, deadline);
      if (!p) return false;
      paths[i] = p; this.reserve(i, p);
    }
    return true;
  };

  function conflictList(conf) {
    const r = [];
    for (let i = 0; i < conf.length; ++i) if (conf[i]) r.push(i);
    return r;
  }

  // ---- 実行 (スライス実行に対応: begin() の後 step(ms) を繰り返す) ----
  Solver.prototype.begin = function (timeLimitMs) {
    this._t0 = Date.now(); this._deadline = this._t0 + timeLimitMs;
    this._paths = null; this._curCol = -1; this._conflictAgents = []; this._iter = 0; this._done = false;
    this._fail = null;
  };

  Solver.prototype.result = function () {
    const paths = this._paths;
    const m = paths ? metrics(paths) : { makespan: 0, moves: 0, sumOfCosts: 0 };
    return {
      ok: !!paths && this._curCol === 0, paths, collisions: this._curCol, iter: this._iter,
      makespan: m.makespan, moves: m.moves, sumOfCosts: m.sumOfCosts,
      lowerBound: this.lowerBound, timeMs: Date.now() - this._t0, reason: this._fail,
    };
  };

  // sliceMs だけ計算を進める. 終了 (成功 / 時間切れ) なら true.
  Solver.prototype.step = function (sliceMs) {
    if (this._done) return true;
    const sliceEnd = Math.min(Date.now() + sliceMs, this._deadline);
    if (!this._paths) {
      const p = this.initialSoftPP(this._deadline);
      if (!p) { this._fail = 'initial PP failed / timeout'; this._done = true; return true; }
      this._paths = p;
      const r = findCollisions(p, this.V, false);
      this._curCol = r.count; this._conflictAgents = conflictList(r.conf);
    }
    while (this._curCol > 0 && Date.now() < sliceEnd) {
      let B = this.pickSubset(this._conflictAgents);
      for (let tr = 0; tr < this.maxRepairTries; ++tr) {
        if (Date.now() > sliceEnd) break;
        const cand = this._paths.slice();
        if (!this.repairSubset(cand, B, sliceEnd)) { B = this.pickSubset(this._conflictAgents); continue; }
        const cr = findCollisions(cand, this.V, false);
        if (cr.count < this._curCol) {
          this._paths = cand; this._curCol = cr.count; this._conflictAgents = conflictList(cr.conf);
          break;
        }
        B = this.pickSubset(this._conflictAgents);
      }
      ++this._iter;
    }
    if (this._curCol === 0 || Date.now() >= this._deadline) this._done = true;
    return this._done;
  };

  // 同期実行 (Node / テスト用)
  Solver.prototype.solve = function (timeLimitMs, progress) {
    this.begin(timeLimitMs);
    let last = 0;
    while (!this.step(100)) {
      const now = Date.now();
      if (progress && now - last > 200) { last = now; progress({ iter: this._iter, collisions: this._curCol, elapsedMs: now - this._t0 }); }
    }
    return this.result();
  };

  // 便利関数: 各エージェントの (他者を無視した) 最短経路. 直進を優先してジグザグを減らす
  function shortestPath(G, s, g, D) {
    if (!D) D = bfsDist(G, g);
    if (D[s] < 0) return null;
    const path = [s]; let c = s, lastDir = 0;
    while (c !== g) {
      const b = c * 5, n = G.nbrCnt[c]; let next = -1, nextDir = 0;
      for (let k = 1; k < n; ++k) {
        const u = G.nbr[b + k];
        if (D[u] !== D[c] - 1) continue;
        const dir = u - c;
        if (next < 0 || dir === lastDir) { next = u; nextDir = dir; }
      }
      path.push(next); lastDir = nextDir; c = next;
    }
    return path;
  }

  // 障害物のみを考慮した BFS 経路 (ドラッグ補間用)
  function bfsPath(G, s, g, maxLen) {
    if (s === g) return [s];
    const prev = new Int32Array(G.V).fill(-2);
    const q = [s]; prev[s] = -1; let qh = 0;
    while (qh < q.length) {
      const c = q[qh++];
      if (maxLen && qh > maxLen * maxLen * 4) break;
      const b = c * 5, n = G.nbrCnt[c];
      for (let k = 1; k < n; ++k) {
        const u = G.nbr[b + k];
        if (prev[u] !== -2) continue;
        prev[u] = c;
        if (u === g) {
          const r = []; for (let x = g; x !== -1; x = prev[x]) r.push(x);
          r.reverse();
          if (maxLen && r.length - 1 > maxLen) return null;
          return r;
        }
        q.push(u);
      }
    }
    return null;
  }

  return {
    makeRng, parseMap, makeEmptyMap, makeRandomMap, buildGraph, bfsDist, largestComponent,
    generateInstance, posAt, trimPath, pathMoves, metrics, findCollisions, Solver,
    shortestPath, bfsPath,
  };
});

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
    { id: 'empty_but_not_empty', name: 'Empty but not empty', gen: () => blank(5, 5, 1), agents: [21, 22, 23, 24, 25] },
  ];

  function getMap(id) {
    const d = MAP_DEFS.find(x => x.id === id);
    if (!d) throw new Error('unknown map ' + id);
    return d.gen();
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

  return { MAP_DEFS, STAGE_AGENTS, getMap, stageSeed, toText, isConnected, tutorial, empty, random, room, maze, warehouse, hourglass, bremen };
});

/*
 * leaderboard.gs — Human MAPF オンラインランキング (Google Apps Script, スプレッドシートにバインド)
 *
 * デプロイ手順は server/README.md を参照. ビルド (node build.js) で lns2.js + maps.js + このファイルを
 * 連結した dist/leaderboard.gs が生成されるので, それを Apps Script に貼り付ける.
 *
 * シート:
 *   scores … ts, stage, name, makespan, moves, paths   (1 提出 1 行. 既存データはそのまま使う)
 *   users  … name, namekey, salt, hash, iter, tokenSalt, serial, created, lastLogin, fail, failUntil, legacy
 *
 * API (ウェブアプリ URL):
 *   GET  ?stage=<map>:<N>   → { ok, makespan: [entry...], moves: [entry...], total: [entry...], players }
 *                             部門は 3 つ: makespan / total distance / 総合 (makespan × distance の積が小さいほど上位)
 *   GET  ?all=1             → { ok, best: { "<map>:<N>": { makespan: entry, moves: entry, total: entry, players } } }
 *   GET  ?checkname=<name>  → { ok, name, available, taken, legacy, submissions }  登録前の名前チェック
 *   GET  ?dump=1&token=<BACKUP_TOKEN>[&sheet=scores|users][&from=0&limit=500]
 *                           → { ok, sheet, total, from, count, next, rows: [...] }  (バックアップ用. tools/backup.js)
 *   POST { action: 'register', name, password }  → { ok, name, token, legacy, claimed }
 *   POST { action: 'login',    name, password }  → { ok, name, token, submissions }
 *   POST { action: 'submit',   name, token, stage, paths }
 *                           → { ok, name, score:{makespan,moves}, makespan:{rank,total,improved,best,entries}, moves:{...} }
 *   entry = { name, makespan, moves, ts }
 *
 * スコアはクライアントの申告ではなく, 送られた経路をサーバー側で検証・計算して記録する.
 * 投稿にはログインが必須 (トークン検証). 記録される名前は必ず登録済みの表示名になるので, なりすましはできない.
 */
var SHEET_NAME = 'scores';
var USERS_SHEET = 'users';
var TOP_N = 20;
// パスワードのハッシュ反復回数. GAS の Utilities.computeDigest は 1 回あたり十数 ms かかるため
// 大きくしすぎると登録・ログインがタイムアウトする. スクリプトプロパティ HASH_ITER で調整できる
// (行ごとに iter を保存しているので、変更しても既存アカウントはそのままログインできる).
var HASH_ITER_DEFAULT = 100;
function hashIter_() {
  var v = +(PropertiesService.getScriptProperties().getProperty('HASH_ITER') || HASH_ITER_DEFAULT);
  return v >= 1 && v <= 5000 ? Math.floor(v) : HASH_ITER_DEFAULT;
}
var MAX_FAIL = 5;          // 連続ログイン失敗の上限
var LOCK_MS = 60 * 1000;   // 上限に達したときのロック時間
// 移行期間: この時刻までは「まだ登録されていない名前」に限り, ログイン前 (トークン無し) の投稿も受け付ける.
// 更新前からページを開いて解いている人の結果を無駄にしないための猶予. 登録済みの名前は最初から保護される.
// スクリプトプロパティ LEGACY_UNTIL (ISO 8601 か ミリ秒) で延長・即時終了できる (再デプロイ不要).
var LEGACY_UNTIL_DEFAULT = '2026-08-27T23:59:59+09:00';   // 2026-08-27 23:59 JST
function legacyUntil_() {
  var v = PropertiesService.getScriptProperties().getProperty('LEGACY_UNTIL') || LEGACY_UNTIL_DEFAULT;
  var n = /^[0-9]+$/.test(v) ? +v : Date.parse(v);
  return isNaN(n) ? 0 : n;
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(['ts', 'stage', 'name', 'makespan', 'moves', 'paths']); }
  return sh;
}
function getUsers_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(USERS_SHEET);
    sh.appendRow(['name', 'namekey', 'salt', 'hash', 'iter', 'tokenSalt', 'serial', 'created', 'lastLogin', 'fail', 'failUntil', 'legacy']);
  }
  return sh;
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// ---------------------------------------------------------------- 名前
// 表示名: 制御文字と <> を除き, 連続空白を 1 つにして 16 文字まで
function cleanName_(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); }
// 同一性の判定キー: 全角/半角, 大文字/小文字, 空白の違いを吸収する ("Foo" と "ｆｏｏ" は同じ名前とみなす)
function nameKey_(s) { return cleanName_(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase(); }

// ---------------------------------------------------------------- ハッシュ
function sha256hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; ++i) { var b = (bytes[i] + 256) % 256; out += (b < 16 ? '0' : '') + b.toString(16); }
  return out;
}
function hashPw_(pw, salt, iter) {
  var h = salt + '|' + pw;
  for (var i = 0; i < iter; ++i) h = sha256hex_(h);
  return h;
}
function randomHex_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
// 長さと内容が一致するかを, 途中で return せずに比べる
function equalConst_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; ++i) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// トークンはサーバー側で再計算できる値にする (シートに平文で持たない).
// serial を増やすと, その利用者の全端末のトークンが無効になる.
function makeToken_(u) { return sha256hex_(u.tokenSalt + '|' + u.namekey + '|' + u.serial); }

// ---------------------------------------------------------------- users シート
var USER_COLS = 12;
function readUsers_() {
  var sh = getUsers_(), last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, USER_COLS).getValues();
  return rows.map(function (r, i) {
    return {
      row: i + 2, name: String(r[0]), namekey: String(r[1]), salt: String(r[2]), hash: String(r[3]),
      iter: +r[4] || HASH_ITER_DEFAULT, tokenSalt: String(r[5]), serial: +r[6] || 1,
      created: +r[7], lastLogin: +r[8], fail: +r[9] || 0, failUntil: +r[10] || 0, legacy: !!r[11],
    };
  });
}
function findUser_(namekey) {
  var us = readUsers_();
  for (var i = 0; i < us.length; ++i) if (us[i].namekey === namekey) return us[i];
  return null;
}
function touchUser_(u, fields) {
  var sh = getUsers_();
  if (fields.lastLogin != null) sh.getRange(u.row, 9).setValue(fields.lastLogin);
  if (fields.fail != null) sh.getRange(u.row, 10).setValue(fields.fail);
  if (fields.failUntil != null) sh.getRange(u.row, 11).setValue(fields.failUntil);
}

// scores に既にある名前か (先着 claim の判定に使う). 表示名は既存の表記に合わせる
function legacyInfo_(namekey) {
  var rows = readAll_(), n = 0, name = null, ts = -1;
  for (var i = 0; i < rows.length; ++i) {
    if (nameKey_(rows[i].name) !== namekey) continue;
    ++n;
    if (rows[i].ts > ts) { ts = rows[i].ts; name = rows[i].name; }
  }
  return { count: n, name: name };
}

// ---------------------------------------------------------------- ダンプ (バックアップ用)
var DUMP_MAX = 500;
function dump_(sheetName, from, limit) {
  var users = sheetName === USERS_SHEET;
  var sh = users ? getUsers_() : getSheet_();
  var cols = users ? USER_COLS : 6;
  var last = sh.getLastRow();
  var total = Math.max(0, last - 1);
  from = Math.max(0, Math.floor(from) || 0);
  limit = Math.min(Math.max(1, Math.floor(limit) || DUMP_MAX), DUMP_MAX);
  var n = Math.max(0, Math.min(limit, total - from));
  var vals = n ? sh.getRange(2 + from, 1, n, cols).getValues() : [];
  var rows = vals.map(function (r) {
    if (users) return { name: String(r[0]), namekey: String(r[1]), salt: String(r[2]), hash: String(r[3]), iter: +r[4], tokenSalt: String(r[5]), serial: +r[6], created: +r[7], lastLogin: +r[8], fail: +r[9], failUntil: +r[10], legacy: !!r[11] };
    return { ts: +r[0], stage: String(r[1]), name: String(r[2]), makespan: +r[3], moves: +r[4], paths: String(r[5]).split(',') };
  });
  var next = from + rows.length;
  return { ok: true, sheet: sheetName, total: total, from: from, count: rows.length, next: next < total ? next : null, rows: rows };
}

// ---------------------------------------------------------------- ランキング集計
function readAll_() {
  var sh = getSheet_(); var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 5).getValues();
  return rows.map(function (r) { return { ts: +r[0], stage: String(r[1]), name: String(r[2]), makespan: +r[3], moves: +r[4] }; });
}
function cmpMakespan_(a, b) { return a.makespan - b.makespan || a.moves - b.moves || a.ts - b.ts; }
function cmpMoves_(a, b) { return a.moves - b.moves || a.makespan - b.makespan || a.ts - b.ts; }
// 総合部門: makespan × total distance の積が小さいほど上位
function score_(e) { return e.makespan * e.moves; }
function cmpTotal_(a, b) { return score_(a) - score_(b) || a.makespan - b.makespan || a.ts - b.ts; }
function bestPerName_(rows, cmp) {
  var best = {};
  rows.forEach(function (r) { var b = best[r.name]; if (!b || cmp(r, b) < 0) best[r.name] = r; });
  return Object.keys(best).map(function (k) { return best[k]; }).sort(cmp);
}
function board_(rows, stage) {
  var rs = rows.filter(function (r) { return r.stage === stage; });
  return { makespan: bestPerName_(rs, cmpMakespan_), moves: bestPerName_(rs, cmpMoves_), total: bestPerName_(rs, cmpTotal_) };
}
function strip_(e) { return e ? { name: e.name, makespan: e.makespan, moves: e.moves, ts: e.ts } : null; }

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.dump) {
      // トークンはスクリプトプロパティ BACKUP_TOKEN に設定する (未設定ならダンプ無効). 公開リポジトリに書かないこと
      var tok = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!tok) return json_({ ok: false, error: 'dump disabled' });
      if (!equalConst_(String(p.token || ''), String(tok))) return json_({ ok: false, error: 'bad token' });
      var sheet = String(p.sheet || SHEET_NAME);
      if (sheet !== SHEET_NAME && sheet !== USERS_SHEET) return json_({ ok: false, error: 'bad sheet' });
      return json_(dump_(sheet, +p.from || 0, +p.limit || DUMP_MAX));
    }
    if (p.bench) {
      // ハッシュの所要時間を実環境で測る (チューニング用). BACKUP_TOKEN で保護する
      var bt = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!bt || !equalConst_(String(p.token || ''), String(bt))) return json_({ ok: false, error: 'bad token' });
      var n = Math.min(Math.max(1, +p.n || 100), 2000);
      var t0 = Date.now();
      hashPw_('benchmark-password', 'benchmark-salt', n);
      var ms = Date.now() - t0;
      return json_({ ok: true, iterations: n, ms: ms, msPerIteration: ms / n, currentIter: hashIter_() });
    }
    if (p.checkname) {
      var nm = cleanName_(p.checkname), key = nameKey_(nm);
      if (!key) return json_({ ok: false, error: 'bad name' });
      var u = findUser_(key), lg = legacyInfo_(key);
      return json_({ ok: true, name: u ? u.name : (lg.name || nm), available: !u, taken: !!u, legacy: !u && lg.count > 0, submissions: lg.count });
    }
    var rows = readAll_();
    if (p.stage) {
      var b = board_(rows, String(p.stage));
      return json_({ ok: true, stage: p.stage, makespan: b.makespan.slice(0, TOP_N).map(strip_), moves: b.moves.slice(0, TOP_N).map(strip_), total: b.total.slice(0, TOP_N).map(strip_), players: b.makespan.length });
    }
    if (p.all) {
      var best = {}, seen = {};
      rows.forEach(function (r) {
        if (seen[r.stage]) return; seen[r.stage] = true;
        var bb = board_(rows, r.stage);
        best[r.stage] = { makespan: strip_(bb.makespan[0]), moves: strip_(bb.moves[0]), total: strip_(bb.total[0]), players: bb.makespan.length };
      });
      return json_({ ok: true, best: best });
    }
    return json_({ ok: true, service: 'human-mapf-leaderboard', submissions: rows.length, auth: true, legacyUntil: new Date(legacyUntil_()).toISOString(), legacyOpen: Date.now() < legacyUntil_() });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body;
    try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
    var action = String(body.action || 'submit');
    lock.waitLock(20000);
    if (action === 'register') return json_(doRegister_(body));
    if (action === 'login') return json_(doLogin_(body));
    if (action === 'submit') return json_(doSubmit_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
  finally { try { lock.releaseLock(); } catch (err) { } }
}

function checkPw_(pw) {
  pw = String(pw == null ? '' : pw);
  if (/[\u0000-\u001f]/.test(pw)) return 'password has control characters';
  if (pw.length < 8) return 'password too short';
  if (pw.length > 72) return 'password too long';
  return null;
}

// 新規登録. scores に既にある名前は「先着 claim」= 最初に登録した人がその名前と過去の記録を引き継ぐ
function doRegister_(body) {
  var name = cleanName_(body.name), key = nameKey_(name);
  if (!key) return { ok: false, error: 'bad name' };
  var pwErr = checkPw_(body.password);
  if (pwErr) return { ok: false, error: pwErr };
  if (findUser_(key)) return { ok: false, error: 'name taken' };
  var lg = legacyInfo_(key);
  if (lg.count > 0 && lg.name) name = lg.name;   // 既存の記録と同じ表記に揃える (ランキングは表示名で集計するため)
  var salt = randomHex_(), tokenSalt = randomHex_(), now = Date.now();
  var iter = hashIter_();
  var u = { name: name, namekey: key, salt: salt, hash: hashPw_(body.password, salt, iter), iter: iter, tokenSalt: tokenSalt, serial: 1 };
  getUsers_().appendRow([u.name, u.namekey, u.salt, u.hash, u.iter, u.tokenSalt, u.serial, now, now, 0, 0, lg.count > 0]);
  return { ok: true, name: u.name, token: makeToken_(u), legacy: lg.count > 0, claimed: lg.count };
}

function doLogin_(body) {
  var key = nameKey_(body.name);
  if (!key) return { ok: false, error: 'bad name' };
  var u = findUser_(key);
  var now = Date.now();
  if (!u) {
    var lg = legacyInfo_(key);
    return { ok: false, error: lg.count > 0 ? 'not registered (legacy)' : 'no such user', legacy: lg.count > 0, submissions: lg.count };
  }
  if (u.failUntil && now < u.failUntil) return { ok: false, error: 'locked', retryAfter: Math.ceil((u.failUntil - now) / 1000) };
  if (!equalConst_(hashPw_(body.password, u.salt, u.iter), u.hash)) {
    var fail = u.fail + 1;
    touchUser_(u, { fail: fail, failUntil: fail >= MAX_FAIL ? now + LOCK_MS : 0 });
    return { ok: false, error: 'wrong password', remaining: Math.max(0, MAX_FAIL - fail) };
  }
  touchUser_(u, { lastLogin: now, fail: 0, failUntil: 0 });
  return { ok: true, name: u.name, token: makeToken_(u), submissions: legacyInfo_(key).count };
}

// 投稿. 記録する名前はトークンから引いた登録済みの表示名を使う (body.name は照合のみ)
// 旧バージョンのページを開いたままの人にも意味が通じるよう, 案内文を添える
var RELOAD_HINT = ' — ページを再読み込みしてログインしてください / please reload the page and log in';
function doSubmit_(body) {
  var key = nameKey_(body.name);
  if (!key) return { ok: false, error: 'bad name' };
  var u = findUser_(key);
  if (u) {
    // 登録済みの名前は移行期間中でも必ずトークンが要る (なりすまし防止は登録した瞬間から効く)
    if (!equalConst_(String(body.token || ''), makeToken_(u))) return { ok: false, error: 'bad token' + RELOAD_HINT };
    return record_(body, u.name, false);
  }
  // 未登録の名前: 移行期間のあいだだけ, 更新前のページからの投稿を受け付ける
  if (Date.now() >= legacyUntil_()) return { ok: false, error: 'login required' + RELOAD_HINT };
  var lg = legacyInfo_(key);
  return record_(body, lg.name || cleanName_(body.name), true);   // 表記は既存の記録に合わせる
}

function record_(body, name, legacy) {
  var v = validate_(body, name);
  if (!v.ok) return { ok: false, error: v.error };
  var sh = getSheet_();
  var ts = Date.now();
  sh.appendRow([ts, v.stage, v.name, v.makespan, v.moves, body.paths.join(',')]);
  var rows = readAll_();
  var b = board_(rows, v.stage);
  var rankIn = function (list) {
    var mine = null, idx = -1;
    for (var i = 0; i < list.length; ++i) if (list[i].name === v.name) { mine = list[i]; idx = i; break; }
    return { rank: idx + 1, total: list.length, improved: !!(mine && mine.ts === ts), best: strip_(mine), entries: list.slice(0, TOP_N).map(strip_) };
  };
  return { ok: true, name: v.name, legacy: !!legacy, score: { makespan: v.makespan, moves: v.moves, total: v.makespan * v.moves }, makespan: rankIn(b.makespan), moves: rankIn(b.moves), total: rankIn(b.total) };
}

// 解の検証: ステージのマップ・start/goal を再生成し, 経路の合法性と衝突を確認. スコアはここで計算する
function validate_(body, name) {
  var stage = String(body.stage || '');
  var m = /^([a-z_]+):(\d+)$/.exec(stage);
  if (!m) return { ok: false, error: 'bad stage' };
  var def = null;
  for (var d = 0; d < MAPS.MAP_DEFS.length; ++d) if (MAPS.MAP_DEFS[d].id === m[1]) def = MAPS.MAP_DEFS[d];
  var N = +m[2];
  if (!def || def.agents.indexOf(N) < 0) return { ok: false, error: 'unknown stage' };
  if (!name) return { ok: false, error: 'bad name' };
  if (!Array.isArray(body.paths) || body.paths.length !== N) return { ok: false, error: 'bad paths' };
  var map = MAPS.getMap(def.id), G = LNS2.buildGraph(map);
  var ins = LNS2.generateInstance(G, N, MAPS.stageSeed(def.id, N));
  var paths = [];
  for (var i = 0; i < N; ++i) {
    var s = String(body.paths[i]);
    if (s.length > 5000 || /[^UDLRW]/.test(s)) return { ok: false, error: 'bad path ' + i };
    var c = ins.starts[i]; var p = [c];
    for (var k = 0; k < s.length; ++k) {
      var ch = s.charAt(k); var x = c % map.w;
      if (ch === 'R') { if (x === map.w - 1) return { ok: false, error: 'off map' }; c += 1; }
      else if (ch === 'L') { if (x === 0) return { ok: false, error: 'off map' }; c -= 1; }
      else if (ch === 'D') { c += map.w; }
      else if (ch === 'U') { c -= map.w; }
      if (c < 0 || c >= map.w * map.h || !map.free[c]) return { ok: false, error: 'illegal move' };
      p.push(c);
    }
    if (p[p.length - 1] !== ins.goals[i]) return { ok: false, error: 'agent ' + (i + 1) + ' not at goal' };
    paths.push(LNS2.trimPath(p));
  }
  if (LNS2.findCollisions(paths, G.V, false).count > 0) return { ok: false, error: 'collision' };
  var mt = LNS2.metrics(paths);
  return { ok: true, stage: stage, name: name, makespan: mt.makespan, moves: mt.moves };
}
