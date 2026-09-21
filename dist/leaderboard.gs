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
    // writer 応募 (occhan さん, 2026-09 投稿): 50x50 のドット絵
    { id: 'ceo', name: 'CEO', author: 'occhan', gen: () => fromPattern(
      '..................................................' +
      '..................................................' +
      '..................................................' +
      '..................................................' +
      '..................................................' +
      '...........................@......................' +
      '.........................@@@@@@...................' +
      '....................@@@@@@@@@@@@..................' +
      '..................@@@@@@@@@@@@@@@.................' +
      '.................@@@@@@@@@@@@@@@@@................' +
      '................@@@@@@@@@@@@@@@@@@@...............' +
      '................@@@@@@@@@@@@@@@@@@@...............' +
      '...............@@@@@@@@@@@@@@@@@@@@@..............' +
      '..............@@@@@@@@@@@@@@@@@@@@@@..............' +
      '.............@@@@@@@@@@@@@@@@@@@@@@@@@............' +
      '............@@@@@@@@@@@@@@@@@..@@@@@@.............' +
      '............@@@@@@@@@@@@@@@@....@@@@@@@...........' +
      '............@@@@@@@@@@@@@@@......@@@@@@@..........' +
      '...........@@@@@@@@@@@@@@@@......@@@@@@...........' +
      '...........@@@@@@@@@@@@@@........@@@@@@@..........' +
      '...........@@@@@@@@@@@@..........@@@@@@...........' +
      '...........@@@@@@@@@@.........@@..@@@@@...........' +
      '...........@@@@@@@@@@@@....@@@@@@.@@@@@@..........' +
      '...........@@@@@@@@...............@@@@@@..........' +
      '...........@@@@@@...@@.......@@@....@@@@..........' +
      '..........@@@@@@..@@@@@....@@@@@@...@@@...........' +
      '...........@@@@@...@@.....@.........@@@...........' +
      '..........@@@@@@...........@........@@@...........' +
      '...........@@@@.............@@......@@@...........' +
      '.............@@@....@@@...@@@@@.....@@@...........' +
      '.............@@@...@@@.@@@@@@@@@....@@............' +
      '..............@@..@@.....@@@@@......@.............' +
      '...............@..@...........@....@..............' +
      '...............@...@.@@@@@@@@@.....@..............' +
      '...............@...........@@......@..............' +
      '................@......@@@@.......@...............' +
      '..................................@...............' +
      '.................................@................' +
      '................................@..@..............' +
      '..............................@....@..............' +
      '...........................@......................' +
      '.................@..................@.............' +
      '.................@..................@@............' +
      '................@@...................@@@..........' +
      '...............@@@...................@@@@@........' +
      '.............@@@@...................@@@@@@@.......' +
      '...........@@@@@@...................@@@@@@@@@.....' +
      '........@@@@@@@@@..................@@@@@@@@@@@@...' +
      '......@@@@@@@@@@@....................@@@@@@@@@@@@.' +
      '....@@@@@@@@@@@@......................@@@@@@@@@@@@', 50, 50), agents: [50, 100, 200, 300, 500], refSolver: 'occhan',
      instances: {
        50: { starts: [1453, 546, 50, 2059, 1246, 1878, 1517, 1938, 1919, 1950, 1712, 1921, 1201, 2467, 343, 1913, 2193, 1961, 2020, 143, 901, 1505, 186, 2305, 1253, 2254, 2024, 1407, 2333, 1347, 436, 352, 1978, 505, 254, 339, 346, 2372, 748, 1731, 2304, 1009, 1966, 324, 2351, 1123, 253, 1151, 1274, 902], goals: [1285, 852, 2219, 695, 2233, 1681, 708, 1059, 851, 1962, 2005, 403, 1448, 127, 47, 1698, 2435, 112, 1071, 1961, 224, 688, 2110, 1342, 1475, 2349, 133, 2007, 2418, 1719, 206, 829, 2090, 904, 2321, 1828, 101, 1779, 2076, 1841, 65, 1777, 1191, 2258, 2082, 1246, 1621, 85, 894, 1688] },
        100: { starts: [2000, 907, 2279, 543, 976, 118, 1430, 110, 982, 1644, 697, 384, 2280, 221, 909, 804, 1445, 929, 405, 644, 1322, 1391, 1561, 2097, 2184, 1043, 190, 2013, 2145, 2091, 14, 1332, 1857, 2010, 357, 1870, 1392, 154, 2476, 2105, 2422, 1977, 1587, 608, 2162, 1596, 2306, 1297, 2072, 60, 2168, 1333, 8, 1290, 1595, 941, 1914, 1959, 1374, 123, 1125, 544, 1641, 850, 2062, 72, 1176, 1534, 1648, 2423, 389, 2218, 161, 1385, 43, 495, 1462, 1273, 1714, 1291, 242, 1931, 1996, 2426, 2174, 940, 290, 2351, 1908, 2058, 1335, 450, 901, 1371, 410, 2232, 2377, 1475, 1778, 52], goals: [1343, 40, 1687, 333, 991, 2321, 106, 1140, 156, 1419, 143, 2259, 1831, 981, 165, 1445, 1807, 2122, 2300, 295, 1763, 1998, 2419, 745, 30, 443, 2068, 1340, 78, 2295, 2327, 207, 1511, 273, 2382, 1681, 1171, 2146, 1355, 384, 1695, 2050, 94, 1431, 2213, 880, 1970, 1256, 1254, 1009, 1693, 2032, 1405, 2126, 438, 954, 1926, 291, 1887, 858, 18, 1731, 1469, 2025, 294, 2160, 1430, 1608, 1739, 264, 780, 2177, 1152, 752, 982, 1974, 1805, 2065, 1563, 699, 1194, 1761, 1978, 69, 554, 845, 1582, 1953, 332, 506, 1149, 409, 212, 1616, 2176, 497, 1843, 2139, 2474, 1333] },
        200: { starts: [447, 38, 1541, 1808, 2250, 2270, 1499, 2162, 2047, 1624, 1452, 811, 53, 507, 47, 195, 1245, 465, 1937, 1696, 56, 1522, 1994, 1653, 138, 300, 931, 41, 1370, 712, 336, 2253, 343, 2150, 1107, 2007, 79, 455, 222, 185, 539, 1838, 2326, 2399, 1596, 362, 89, 1592, 1963, 2330, 282, 497, 804, 1691, 2452, 2092, 753, 2038, 177, 1901, 125, 1484, 104, 163, 1800, 2475, 150, 1646, 1072, 1651, 245, 2084, 310, 2469, 1809, 550, 1880, 2015, 2348, 59, 489, 215, 83, 1874, 1603, 26, 441, 286, 952, 459, 175, 113, 1849, 1029, 2104, 1697, 2236, 367, 1695, 1566, 1325, 843, 1054, 2420, 505, 1024, 316, 2116, 990, 464, 1243, 695, 991, 1241, 757, 649, 903, 2482, 901, 996, 993, 1352, 1246, 2023, 893, 491, 1059, 314, 1591, 1042, 752, 203, 558, 1652, 2378, 1094, 350, 591, 692, 1612, 1721, 946, 599, 2006, 1811, 341, 335, 2106, 1219, 1976, 1640, 75, 2147, 1457, 1798, 1789, 466, 2065, 1928, 146, 1205, 1884, 486, 995, 2211, 1298, 1008, 2246, 22, 407, 1169, 1301, 1001, 443, 184, 1767, 2267, 106, 700, 2181, 1183, 255, 1285, 161, 555, 1493, 798, 156, 129, 2279, 1795, 880, 229, 1275, 598, 62, 1353, 160, 333, 697], goals: [2345, 41, 109, 1749, 314, 1881, 1663, 1224, 2012, 1179, 58, 1228, 2132, 881, 1762, 1923, 2300, 1713, 1818, 1393, 1422, 1172, 1989, 2419, 382, 279, 1241, 2095, 1580, 880, 1782, 877, 390, 149, 438, 804, 1404, 2022, 858, 1890, 2054, 1581, 1140, 1002, 1954, 802, 1254, 292, 135, 1454, 334, 2112, 2053, 194, 2331, 978, 369, 2346, 2075, 657, 2099, 1504, 2164, 1246, 43, 2347, 2425, 1826, 1176, 2330, 791, 2225, 28, 1094, 1605, 98, 2003, 593, 2103, 1937, 549, 1640, 1209, 645, 2021, 397, 1542, 1891, 1496, 1421, 2156, 1378, 642, 605, 280, 249, 1158, 1611, 282, 1621, 1, 592, 322, 1346, 712, 2298, 1732, 362, 1392, 1792, 1661, 2418, 893, 2032, 1293, 290, 2402, 1778, 1395, 842, 408, 1518, 1321, 1644, 496, 1610, 1444, 1402, 1028, 331, 2468, 1502, 2036, 2270, 1894, 846, 29, 130, 211, 320, 319, 1758, 138, 80, 131, 218, 1595, 753, 286, 891, 1813, 2230, 552, 696, 1328, 126, 161, 1870, 1170, 157, 231, 268, 1204, 15, 1634, 2348, 1585, 497, 2098, 2428, 1601, 1500, 1981, 1657, 1799, 216, 2235, 1629, 158, 2030, 1350, 1920, 187, 346, 1887, 1680, 1357, 1982, 1191, 698, 538, 2161, 46, 1448, 18, 1968, 1342, 2326, 2259, 831] },
        300: { starts: [2299, 1632, 252, 1650, 1346, 1835, 398, 198, 2163, 344, 156, 2114, 2141, 2180, 1978, 504, 7, 1358, 1707, 1839, 157, 2317, 1538, 103, 27, 1604, 1938, 1299, 324, 1103, 2246, 2284, 646, 92, 1659, 2022, 2221, 1245, 1540, 2318, 1450, 16, 267, 304, 1499, 1198, 269, 434, 2476, 1445, 1857, 281, 1661, 8, 1805, 247, 1149, 1876, 2160, 1551, 789, 1989, 1873, 839, 2368, 1921, 318, 1235, 1826, 341, 1159, 1424, 1824, 2214, 2282, 748, 1910, 1871, 1917, 1234, 696, 1506, 1574, 415, 799, 1740, 1349, 1225, 2324, 1091, 2208, 611, 565, 1854, 72, 1500, 945, 703, 1554, 1998, 1905, 2371, 223, 663, 1906, 1339, 1897, 397, 1785, 658, 2307, 259, 142, 2156, 910, 1996, 1614, 485, 2034, 510, 1481, 1483, 1914, 1462, 2466, 1889, 2133, 1953, 2236, 1818, 2279, 1060, 908, 188, 462, 1534, 991, 1490, 791, 1928, 2140, 1878, 2174, 1926, 446, 1076, 2040, 1375, 743, 2170, 2099, 1155, 391, 229, 2418, 1816, 65, 1933, 706, 1738, 196, 367, 2168, 1836, 1433, 2177, 512, 2209, 129, 2186, 2321, 1042, 1924, 182, 2147, 1997, 1374, 2230, 440, 438, 2243, 2010, 162, 2182, 1764, 1512, 1366, 741, 158, 2108, 1970, 2196, 1009, 2310, 2248, 166, 1435, 1405, 1981, 692, 1882, 1708, 165, 1730, 2181, 2220, 1595, 355, 1962, 2074, 1803, 1545, 1994, 150, 2486, 2080, 388, 604, 143, 1870, 335, 2105, 754, 1552, 1752, 56, 243, 1047, 2113, 2225, 1584, 1123, 1410, 163, 2295, 21, 1218, 1441, 97, 1965, 2012, 321, 928, 111, 995, 253, 1133, 549, 1987, 690, 1251, 2171, 225, 2185, 2112, 854, 172, 1666, 263, 107, 2124, 1307, 1247, 110, 850, 2041, 2428, 1456, 639, 1686, 1055, 393, 879, 86, 1491, 806, 807, 2397, 1309, 78, 2369, 9, 1850, 458, 184, 1556, 2066, 561, 1925, 250, 1170, 1447, 2077, 588, 2468, 1912, 1400, 1992, 943, 275], goals: [611, 197, 1696, 332, 2129, 1289, 1512, 2020, 1957, 2170, 1094, 189, 187, 1492, 2433, 1995, 366, 1629, 599, 2150, 104, 2404, 2077, 2254, 1723, 1986, 1533, 1173, 309, 981, 1499, 658, 1952, 504, 890, 502, 2143, 255, 979, 2417, 1226, 1322, 439, 2384, 1518, 74, 497, 458, 2090, 1779, 1619, 2142, 121, 1355, 1869, 1755, 1209, 1327, 593, 2246, 1704, 705, 2045, 809, 353, 388, 1246, 1101, 1644, 2174, 2080, 190, 803, 267, 586, 2483, 1625, 1329, 749, 2203, 1346, 252, 1001, 199, 1151, 1660, 2176, 1522, 192, 1200, 686, 266, 804, 707, 2232, 369, 209, 1877, 58, 241, 1827, 296, 417, 2132, 487, 929, 1997, 287, 1798, 335, 2276, 2022, 1613, 229, 793, 1417, 1684, 491, 1940, 1443, 1440, 2317, 160, 2259, 2229, 1732, 1842, 1670, 1052, 2144, 6, 162, 1958, 779, 1656, 1427, 7, 2004, 1692, 226, 993, 101, 2261, 1382, 2379, 1928, 1898, 1284, 2169, 1225, 2160, 1809, 2089, 2296, 1844, 1831, 1267, 2356, 50, 1787, 342, 44, 548, 536, 1354, 846, 171, 1344, 947, 2486, 1753, 490, 2118, 358, 100, 185, 41, 1820, 1025, 32, 258, 2019, 1880, 645, 1333, 660, 1345, 881, 1317, 561, 689, 256, 1583, 1655, 213, 0, 1738, 42, 364, 1752, 60, 1457, 512, 77, 999, 1093, 173, 1662, 1124, 4, 401, 1455, 828, 385, 1765, 396, 808, 564, 2084, 159, 743, 1823, 2225, 1845, 210, 751, 1371, 1357, 223, 1420, 323, 227, 1391, 2028, 2182, 1506, 10, 545, 594, 550, 1868, 1666, 2302, 1501, 1650, 2107, 1347, 1306, 907, 2059, 2272, 92, 1642, 1620, 1562, 1846, 606, 797, 2062, 1886, 2165, 1894, 494, 2214, 898, 2072, 982, 1155, 1057, 1305, 137, 1585, 1628, 555, 336, 1945, 592, 452, 1838, 355, 1782, 747, 158, 1600, 73, 1452, 36, 1393, 2018, 1589, 1645, 2153, 1403, 2268, 1194, 1832, 1103, 499, 2397, 2285] },
        500: { starts: [1308, 272, 2294, 2039, 2346, 391, 614, 17, 297, 901, 459, 486, 172, 490, 1522, 1518, 450, 1716, 2285, 1492, 2070, 1845, 1849, 166, 1887, 2250, 780, 362, 205, 1425, 2096, 2301, 1350, 266, 890, 1752, 946, 1294, 1622, 2003, 1909, 2436, 651, 1982, 117, 2046, 605, 951, 221, 694, 2452, 1742, 1318, 2087, 1541, 2170, 211, 1911, 842, 66, 1355, 709, 1972, 801, 123, 1107, 1571, 69, 2357, 2307, 408, 1180, 499, 1059, 897, 298, 1125, 2001, 2451, 2302, 2050, 1854, 2088, 2223, 515, 2195, 505, 213, 1882, 1609, 1401, 382, 1395, 210, 1226, 1285, 854, 61, 802, 102, 2475, 231, 1040, 2060, 1108, 125, 1392, 1307, 2066, 158, 310, 2297, 644, 2110, 2044, 2193, 1, 603, 436, 82, 1056, 1503, 1828, 1160, 37, 592, 491, 2000, 35, 1447, 1099, 312, 444, 808, 1024, 1474, 1174, 2375, 460, 1816, 1029, 807, 252, 1604, 1943, 1621, 1759, 1074, 1442, 132, 83, 357, 456, 2090, 1937, 288, 2232, 286, 2471, 1794, 1371, 2036, 1653, 587, 170, 2174, 1250, 108, 255, 2125, 1661, 1855, 299, 2025, 1356, 1423, 2100, 1744, 1922, 180, 1815, 346, 2210, 1591, 1998, 1256, 2209, 1745, 182, 2252, 2279, 648, 1274, 1561, 1106, 1606, 1659, 1733, 1650, 2259, 2101, 1740, 1556, 127, 1181, 689, 591, 1942, 998, 1096, 1071, 1949, 1664, 1929, 1821, 1788, 1321, 1275, 1850, 1441, 997, 692, 218, 2213, 1499, 1292, 2093, 2256, 2260, 1197, 1786, 1225, 319, 71, 900, 2021, 1449, 855, 2095, 194, 206, 504, 1491, 1075, 511, 1743, 1405, 976, 1178, 1051, 589, 2104, 761, 406, 493, 1631, 2229, 1300, 1807, 1457, 2097, 1331, 2423, 1910, 757, 284, 1907, 1376, 982, 613, 1597, 657, 1721, 753, 47, 2261, 365, 1103, 262, 1588, 695, 364, 163, 2142, 1422, 2450, 1397, 2382, 1838, 1696, 1902, 1126, 195, 1976, 1205, 1098, 1158, 2005, 2099, 977, 24, 191, 190, 793, 1719, 352, 209, 2156, 1908, 13, 38, 830, 1169, 1858, 2453, 2335, 1581, 2276, 1969, 1003, 991, 1712, 1808, 1562, 1814, 275, 1865, 2268, 1123, 197, 145, 239, 1945, 2373, 2206, 1793, 409, 1925, 1399, 1461, 1094, 2333, 222, 1708, 1101, 1046, 1544, 1965, 848, 1978, 2157, 2085, 403, 485, 57, 1870, 366, 2404, 270, 110, 1303, 2233, 169, 144, 215, 164, 643, 1155, 285, 49, 902, 301, 1962, 1863, 1667, 2076, 1195, 1241, 598, 1625, 2379, 1830, 1993, 849, 2180, 1198, 1879, 2470, 1875, 1718, 2367, 1627, 2115, 899, 1382, 1751, 1836, 2058, 1805, 1871, 1253, 636, 151, 2023, 48, 56, 955, 100, 124, 944, 1968, 200, 2399, 34, 1975, 2013, 1697, 1660, 293, 746, 1950, 2320, 2483, 453, 799, 1500, 73, 2417, 2354, 193, 1654, 861, 2251, 1873, 46, 84, 1149, 2432, 1967, 1431, 1832, 1747, 2300, 877, 1963, 1936, 454, 65, 268, 2326, 1266, 1645, 175, 395, 1233, 134, 204, 1175, 995, 1342, 1148, 2478, 687, 2194, 1245, 245, 1920, 1758, 2227, 1210, 1598, 1848, 1540, 1410, 1563, 139, 237, 1351, 2191, 1047, 810, 2131, 1110, 2449, 797, 1701, 1874, 2164, 300, 1866, 2474, 1467, 80, 94, 2329, 1368, 1209, 1710, 2134, 758], goals: [1002, 1397, 2309, 81, 898, 901, 2151, 2282, 316, 1000, 397, 930, 2303, 1447, 2236, 489, 1756, 209, 2310, 1827, 1023, 1295, 1399, 1170, 1832, 312, 229, 1571, 1796, 1517, 352, 1625, 167, 2211, 1257, 954, 5, 1661, 1181, 542, 490, 2245, 1984, 1356, 2015, 829, 2182, 241, 230, 136, 232, 750, 929, 1341, 1968, 1698, 1408, 660, 10, 88, 1783, 1251, 2423, 2021, 1896, 1643, 1824, 1403, 2173, 950, 658, 932, 2280, 2319, 1943, 269, 14, 1859, 1430, 539, 2376, 2010, 1102, 1563, 1176, 1924, 565, 1404, 455, 1393, 1990, 245, 2450, 2160, 102, 1145, 2152, 2253, 798, 1666, 1959, 216, 7, 1788, 2473, 535, 0, 70, 1751, 213, 1809, 1894, 1109, 2371, 283, 537, 2053, 1939, 1879, 1653, 2248, 2261, 1979, 2030, 2243, 2381, 1206, 648, 1548, 1664, 1096, 2034, 290, 1889, 1914, 556, 220, 1079, 1955, 2143, 662, 94, 1158, 1043, 37, 882, 82, 976, 1550, 1505, 1209, 164, 1853, 254, 1941, 1813, 2299, 75, 1724, 217, 1705, 1423, 247, 1444, 1972, 1203, 310, 1639, 1871, 2285, 104, 654, 1555, 1611, 1510, 1400, 2106, 1325, 1670, 1800, 190, 299, 411, 460, 740, 2350, 2293, 2190, 896, 1762, 1712, 1051, 555, 1222, 1740, 1794, 2377, 2042, 1581, 1716, 1076, 549, 25, 1816, 1466, 2281, 1582, 541, 1494, 1599, 701, 355, 1535, 2022, 395, 2085, 1340, 1259, 2062, 1542, 2138, 200, 2170, 218, 149, 1032, 1601, 462, 797, 1587, 240, 2023, 484, 502, 2071, 414, 2000, 846, 607, 1405, 1359, 2208, 1981, 188, 441, 1418, 958, 1217, 2163, 1450, 497, 1947, 2028, 27, 2149, 1172, 2304, 1370, 2119, 1293, 1616, 187, 1637, 2260, 2436, 1374, 206, 126, 1095, 2195, 1732, 1205, 1910, 653, 1836, 457, 2, 1432, 2269, 1328, 1865, 1415, 793, 641, 2009, 4, 1507, 1606, 1644, 464, 1484, 1448, 1327, 2073, 2204, 1772, 356, 2039, 611, 407, 1461, 1719, 644, 1978, 604, 1385, 841, 165, 1892, 1574, 1266, 647, 1634, 1626, 1372, 1874, 1335, 1490, 1833, 909, 309, 1649, 239, 183, 645, 1986, 1605, 2419, 2044, 696, 897, 1296, 1485, 32, 507, 1782, 1554, 1467, 1590, 811, 553, 76, 1650, 221, 1848, 1454, 1856, 1977, 2099, 389, 85, 1010, 1182, 394, 2038, 1771, 204, 2082, 384, 1546, 1202, 790, 49, 161, 1655, 2161, 1107, 544, 2466, 2255, 2232, 2200, 1954, 306, 1592, 18, 1094, 2322, 2370, 1144, 238, 1657, 163, 2046, 1409, 56, 249, 391, 341, 859, 1233, 710, 320, 1416, 1731, 779, 263, 6, 1160, 1141, 260, 235, 401, 1930, 1868, 1995, 2435, 906, 1900, 1584, 1347, 2430, 170, 890, 745, 1933, 1633, 28, 1495, 416, 1394, 1966, 2061, 3, 1840, 1055, 1533, 649, 2244, 1099, 2128, 72, 955, 1957, 2132, 2320, 120, 642, 609, 150, 1100, 345, 613, 347, 1421, 2178, 168, 1595, 59, 2400, 105, 1072, 243, 999, 2284, 1133, 1691, 417, 697, 2183, 1693, 941, 382, 753, 2352, 219, 191, 1854, 1103, 461, 1963, 1880, 495, 1375, 321, 1759, 366, 2058, 1009, 1919, 1850, 1106, 270, 2401, 459, 350, 1624, 663, 1790, 2246, 1858, 807, 1793, 1898, 589, 2032, 1420, 1867, 252, 1042] },
      } },
    // writer 応募 (miku_hatsune さん, 2026-09 投稿): 応募名「Invader」はユーザー決定で Crab に改名
    { id: 'crab', name: 'Crab', author: 'miku_hatsune', gen: () => fromPattern(
      '@@..@@@..@@' +
      '@@@.@@@.@@@' +
      '@@.......@@' +
      '@..@...@..@' +
      '...........' +
      '.@.......@.' +
      '.@..@@@..@.' +
      '@@@..@..@@@', 11, 8), agents: [10, 20, 30], refSolver: 'miku_hatsune',
      instances: {
        10: { starts: [76, 48, 46, 24, 14, 42, 39, 52, 58, 69], goals: [35, 84, 55, 63, 59, 3, 28, 50, 53, 57] },
        20: { starts: [57, 81, 14, 52, 44, 35, 84, 25, 50, 26, 83, 65, 34, 42, 30, 38, 60, 53, 37, 46], goals: [83, 24, 57, 28, 80, 60, 51, 61, 42, 66, 50, 46, 53, 81, 68, 69, 62, 38, 35, 8] },
        30: { starts: [38, 30, 14, 74, 3, 60, 35, 47, 55, 46, 51, 48, 76, 49, 25, 59, 81, 57, 80, 68, 65, 63, 83, 66, 2, 69, 7, 50, 53, 42], goals: [42, 63, 51, 74, 65, 8, 26, 25, 28, 49, 50, 27, 61, 41, 24, 58, 7, 69, 34, 3, 62, 14, 44, 83, 52, 29, 76, 80, 81, 30] },
      } },
    // writer 応募 (Hori04 さん, 2026-09-05 投稿): 外周を壁で囲んだ内側 2x9 (自由マス 18) に 18 台 = 空きマスゼロ
    { id: 'packed2x9', name: '2x9', author: 'Hori04', gen: () => fromPattern(
      '@@@@' +
      '@..@' +
      '@..@' +
      '@..@' +
      '@..@' +
      '@..@' +
      '@..@' +
      '@..@' +
      '@..@' +
      '@..@' +
      '@@@@', 4, 11), agents: [18], refSolver: 'Hori04',
      instances: {
        18: { starts: [6, 10, 14, 18, 22, 26, 30, 34, 38, 37, 33, 29, 25, 21, 17, 13, 9, 5], goals: [5, 9, 13, 17, 21, 25, 29, 33, 37, 38, 34, 30, 26, 22, 18, 14, 10, 6] },
      } },
    // Human MAPF Contest 001 (2026-09-11 12:00 開始). Div.2 = 30 台 (生成 seed 88), Div.1 = 100 台 (seed 50).
    // 条件: 番号はスタートが上の行ほど小さく同じ行では左が小さい / 全員の BFS 距離 >= 30.
    // 120 インスタンスを LaCAM* 10 秒で解き, スコア/下限 の中央値が最大のものを採用
    { id: 'contest001', name: 'HMC001', gen: () => fromPattern(
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@' +
      '@......@@@@@@......@@@@@@......@' +
      '@..................@@@@@@......@' +
      '@..@...@@@@@@...@@.@@@@@@......@' +
      '@..@...@@@@@@..................@' +
      '@........@@........@@@@@@......@' +
      '@......@.@@.@......@@@@@@......@' +
      '@@@.@.@@.@@.@@@.@@.@@@@@@@@@.@@@' +
      '@@@.@....@@.@@@.@@.....@@@@@.@@@' +
      '@@@.@@@@.@@.@@@...@@@@.@@@@@.@@@' +
      '@@@.@@@@....@@@@@.@@@@.@@@...@@@' +
      '@@@.@@@@.@@@@@@@@.@@@@.....@@@@@' +
      '@@@.@....@@@@@@@@.@@@@@@@..@@@@@' +
      '@......@@@@@@......@@@@@@......@' +
      '@......@@@@@@.........@@@......@' +
      '@.@@......@@@..@@..@@.@@@......@' +
      '@......@@.@@@..@@..@@..........@' +
      '@......@@..........@@@@@@...@@.@' +
      '@......@@@@@@......@@@@@@......@' +
      '@@.@@@.@@@@@@.@.@@@@@@@@@.@@@.@@' +
      '@@.@@@.....@@.@.@@@@@@....@@@.@@' +
      '@@.@@@@@@@....@.@@@@@@.@@@@@@.@@' +
      '@@...@@@@@.@@@@.@@@@....@@@@@.@@' +
      '@@@@.@@@@@....@.@@@@.@@.@@@@@.@@' +
      '@@@@.@@@@@@@@.@.@@@@.@@.@@@@@.@@' +
      '@......@@@@@@........@@........@' +
      '@......@@@@@@......@@@@@@......@' +
      '@..@.......@@...@@.@@@@@@......@' +
      '@..@...@@@.@@...............@..@' +
      '@......@@@.........@@@@@@...@..@' +
      '@......@@@@@@......@@@@@@......@' +
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', 32, 32), agents: [30, 75], refSolver: 'LaCAM3', stageNames: { 30: 'Div.2', 75: 'Div.1' },
      instances: {
        30: { starts: [47, 73, 77, 82, 130, 164, 189, 200, 203, 252, 454, 462, 464, 465, 468, 469, 474, 497, 513, 517, 685, 687, 765, 802, 803, 860, 879, 909, 912, 918], goals: [756, 977, 740, 806, 724, 944, 554, 910, 542, 986, 827, 926, 990, 965, 869, 165, 708, 61, 252, 346, 153, 71, 835, 571, 76, 355, 190, 109, 67, 218] },
        75: { starts: [35, 36, 38, 57, 77, 82, 89, 94, 100, 142, 157, 163, 174, 196, 208, 222, 227, 232, 235, 259, 264, 278, 284, 304, 316, 342, 355, 376, 378, 419, 422, 430, 441, 449, 452, 453, 461, 484, 485, 487, 493, 509, 545, 553, 560, 580, 589, 601, 602, 646, 674, 682, 724, 726, 803, 813, 818, 830, 834, 859, 865, 871, 893, 900, 912, 921, 922, 946, 953, 962, 963, 966, 974, 975, 977], goals: [60, 893, 506, 355, 906, 986, 978, 646, 570, 961, 558, 813, 861, 442, 740, 37, 925, 724, 816, 733, 534, 985, 553, 824, 706, 874, 662, 836, 38, 954, 665, 834, 195, 820, 185, 920, 900, 441, 348, 892, 827, 261, 59, 187, 126, 541, 92, 197, 420, 957, 505, 90, 232, 454, 218, 124, 166, 242, 151, 303, 410, 58, 149, 101, 165, 176, 392, 158, 48, 89, 155, 446, 299, 152, 145] },
      } },
    // writer 応募 (miku_hatsune さん, 2026-09 投稿, 2026-09-21 採用): 5x5 に卍型の障害物 (応募名「まじ卍」→ ユーザー決定で 卍 に改名)
    { id: 'manji', name: '卍', author: 'miku_hatsune', gen: () => fromPattern(
      '...@.' +
      '@@.@.' +
      '.....' +
      '.@.@@' +
      '.@...', 5, 5), agents: [4, 8, 12], refSolver: 'miku_hatsune',
      instances: {
        4: { starts: [11, 10, 12, 24], goals: [7, 14, 22, 0] },
        8: { starts: [17, 20, 12, 15, 9, 13, 2, 4], goals: [14, 4, 24, 15, 20, 11, 10, 1] },
        12: { starts: [14, 11, 13, 24, 10, 23, 4, 0, 1, 17, 15, 12], goals: [4, 0, 1, 7, 20, 22, 24, 15, 14, 23, 2, 10] },
      } },
    // writer 応募 (sigtuna さん, 2026-09 投稿, 2026-09-21 採用): 19x22 の迷路 (応募名「PAC-MAN」→ ユーザー決定で Game に改名)
    { id: 'game', name: 'Game', author: 'sigtuna', gen: () => fromPattern(
      '@@@@@@@@@@@@@@@@@@@' +
      '@........@........@' +
      '@.@@.@@@.@.@@@.@@.@' +
      '@.@@.@@@.@.@@@.@@.@' +
      '@.................@' +
      '@.@@.@.@@@@@.@.@@.@' +
      '@....@...@...@....@' +
      '@@@@.@@@.@.@@@.@@@@' +
      '@@@@.@.......@.@@@@' +
      '@@@@.@.@@.@@.@.@@@@' +
      '.......@...@.......' +
      '@@@@.@.@@@@@.@.@@@@' +
      '@@@@.@.......@.@@@@' +
      '@@@@.@.@@@@@.@.@@@@' +
      '@........@........@' +
      '@.@@.@@@.@.@@@.@@.@' +
      '@..@...........@..@' +
      '@@.@.@.@@@@@.@.@.@@' +
      '@....@...@...@....@' +
      '@.@@@@@@.@.@@@@@@.@' +
      '@.................@' +
      '@@@@@@@@@@@@@@@@@@@', 19, 22), agents: [10, 20, 30, 50, 100], refSolver: 'sigtuna',
      instances: {
        10: { starts: [371, 240, 306, 359, 137, 345, 208, 279, 158, 22], goals: [81, 112, 200, 286, 316, 395, 121, 314, 185, 277] },
        20: { starts: [81, 395, 85, 356, 335, 71, 302, 236, 387, 325, 392, 163, 289, 274, 23, 116, 348, 162, 120, 78], goals: [235, 329, 385, 87, 109, 88, 48, 270, 317, 389, 42, 310, 121, 126, 348, 30, 271, 280, 234, 55] },
        30: { starts: [163, 213, 32, 195, 89, 316, 320, 327, 269, 251, 164, 200, 358, 93, 34, 117, 99, 389, 321, 239, 88, 352, 282, 128, 29, 388, 381, 126, 313, 289], goals: [143, 26, 202, 166, 358, 269, 308, 87, 124, 115, 89, 356, 198, 234, 310, 164, 91, 344, 137, 183, 321, 159, 93, 251, 274, 302, 129, 295, 362, 397] },
        50: { starts: [281, 112, 42, 26, 46, 65, 396, 394, 117, 352, 22, 369, 202, 383, 269, 236, 78, 87, 67, 24, 357, 395, 31, 92, 128, 335, 156, 74, 388, 392, 282, 295, 99, 121, 237, 271, 52, 289, 389, 313, 193, 325, 309, 55, 86, 131, 79, 277, 81, 278], goals: [81, 237, 299, 318, 383, 175, 302, 329, 345, 277, 125, 396, 313, 386, 316, 358, 390, 99, 88, 166, 235, 371, 52, 359, 314, 295, 58, 124, 196, 311, 27, 352, 286, 205, 30, 96, 240, 159, 190, 317, 195, 293, 397, 208, 369, 206, 395, 77, 162, 393] },
        100: { starts: [371, 271, 185, 25, 281, 369, 82, 92, 126, 131, 232, 358, 205, 137, 286, 343, 335, 391, 268, 93, 261, 253, 191, 158, 26, 78, 207, 385, 345, 117, 235, 395, 143, 356, 306, 116, 84, 234, 329, 46, 348, 349, 302, 200, 236, 316, 359, 386, 289, 52, 352, 80, 311, 87, 183, 353, 175, 125, 71, 91, 392, 339, 192, 31, 55, 107, 273, 283, 389, 115, 156, 390, 206, 159, 274, 387, 130, 118, 203, 382, 378, 278, 309, 42, 74, 120, 193, 325, 318, 129, 259, 194, 89, 279, 199, 251, 223, 198, 180, 312], goals: [20, 22, 25, 27, 29, 31, 34, 36, 42, 52, 61, 71, 77, 79, 81, 83, 85, 87, 89, 91, 93, 99, 101, 107, 109, 115, 117, 120, 122, 124, 126, 129, 131, 137, 147, 158, 160, 162, 164, 175, 180, 185, 190, 193, 196, 198, 199, 200, 202, 205, 208, 213, 223, 234, 236, 238, 240, 251, 261, 267, 269, 272, 274, 276, 278, 281, 283, 289, 299, 305, 309, 311, 313, 315, 317, 321, 325, 329, 335, 339, 343, 346, 348, 350, 352, 354, 356, 359, 362, 369, 371, 378, 382, 384, 386, 388, 390, 392, 394, 396] },
      } },
    // writer 応募 (kukone さん, 2026-09 投稿, 2026-09-21 採用): 10x10 の風車型 (自由マス 24)
    { id: 'pinwheel', name: 'Pinwheel', author: 'kukone', gen: () => fromPattern(
      '@@@@@@@@@@' +
      '@@@@.@@@@@' +
      '@@@@..@@@@' +
      '@@@@..@@@@' +
      '@@.......@' +
      '@.......@@' +
      '@@@@..@@@@' +
      '@@@@..@@@@' +
      '@@@@@.@@@@' +
      '@@@@@@@@@@', 10, 10), agents: [4, 8, 12, 20], refSolver: 'kukone',
      instances: {
        4: { starts: [14, 48, 85, 51], goals: [48, 51, 14, 85] },
        8: { starts: [14, 51, 85, 48, 34, 53, 65, 46], goals: [74, 57, 25, 42, 54, 55, 45, 44] },
        12: { starts: [14, 24, 25, 48, 47, 57, 85, 75, 74, 51, 52, 42], goals: [25, 57, 74, 42, 34, 46, 65, 53, 14, 48, 85, 51] },
        20: { starts: [25, 35, 45, 46, 47, 57, 56, 55, 65, 75, 74, 64, 54, 53, 52, 42, 43, 44, 34, 24], goals: [14, 65, 51, 46, 74, 34, 57, 53, 25, 75, 42, 47, 64, 24, 56, 52, 35, 85, 43, 48] },
      } },
    // 登録ユーザー 100 人突破の記念マップ (2026-09-21). 32x32 のドット絵
    { id: 'hundred', name: '100', gen: () => fromPattern(
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@' +
      '@..............................@' +
      '@..@..@.@..@.@...@..@@..@...@..@' +
      '@..@..@.@..@.@@.@@.@..@.@@..@..@' +
      '@..@@@@.@..@.@.@.@.@.@@.@.@.@..@' +
      '@..@..@.@..@.@...@.@..@.@..@@..@' +
      '@..@..@..@@..@...@.@..@.@...@..@' +
      '@..............................@' +
      '@.@..........................@.@' +
      '@.@...@@....@@@@......@@@@...@.@' +
      '@.@..@@@...@@@@@@....@@@@@@..@.@' +
      '@.@.@@@@..@@....@@..@@....@@.@.@' +
      '@.@...@@..@@....@@..@@....@@.@.@' +
      '@.@...@@........@@..@@.......@.@' +
      '@.@...@@..@@....@@..@@....@@.@.@' +
      '@.@...@@..@@....@@..@@....@@.@.@' +
      '@.@...@@..@@....@@..@@....@@.@.@' +
      '@.@...@@..@@....@@..@@....@@.@.@' +
      '@.@...@@..@@..............@@.@.@' +
      '@.@...@@..@@....@@..@@....@@.@.@' +
      '@.@...@@..@@....@@..@@....@@.@.@' +
      '@.@.@@@@@..@@@@@@....@@@@@@..@.@' +
      '@.@.@@@@@...@@@@......@@@@...@.@' +
      '@.@..........................@.@' +
      '@..............................@' +
      '@.....@...@..@@..@@@..@@@@.....@' +
      '@.....@@.@@.@..@.@..@.@........@' +
      '@.....@.@.@.@.@@.@@.@.@@@......@' +
      '@.....@...@.@..@.@....@........@' +
      '@.....@...@.@..@.@....@........@' +
      '@..............................@' +
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@', 32, 32), agents: [10, 20, 30, 50, 100], refSolver: 'LaCAM3' },
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

/* reference.js — 自動生成 (tools/precompute.js). 各ステージの LNS2 参考解. paths は U/D/L/R/W の 1 文字/ステップ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.REFERENCE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {"tutorial:2":{"makespan":7,"moves":12,"lb":{"makespan":5,"moves":10},"starts":[12,2],"goals":[2,12],"paths":["RRRUULU","LLDDD"]},"empty:10":{"makespan":17,"moves":97,"lb":{"makespan":17,"moves":97},"starts":[163,46,121,25,133,166,155,30,61,171],"goals":[231,29,15,119,143,57,132,64,233,207],"paths":["RRRRDDDD","LU","RRRRRRUUUUUUU","LLDDDDDD","RRRRRRRRRR","RRRUUUUUUU","LLLLLLLU","LLLLLLLLLLLLLLDDD","LLLDDDDLDDDDDDD","RRRRDD"]},"empty:20":{"makespan":14,"moves":181,"lb":{"makespan":14,"moves":179},"starts":[93,230,153,106,3,191,30,66,101,37,126,151,177,20,100,28,89,139,98,23],"goals":[190,69,86,87,194,44,38,48,183,61,83,26,64,137,85,221,110,252,138,217],"paths":["RDDDDDD","LUUUUUUUUUU","LLLUUUU","LLLU","LDDDDDDDDDDDD","LLULUUUUUUUU","LLLLLLLLD","LLU","RRDDDDD","RRRRRRRRD","LLLLLLLLLLLUU","URRRUUUUUUU","LUUUUUUU","RRRRDRDDDDDD","RUWWWWWWWLR","DRDDDDDDDDDDD","RRRRRD","RDDDDDDD","RRRRRRDDWRR","RRDDDDDDDDDDDD"]},"empty:30":{"makespan":19,"moves":298,"lb":{"makespan":19,"moves":294},"starts":[73,71,19,85,134,58,87,186,197,165,77,233,69,16,208,0,137,102,20,93,187,57,111,255,239,12,149,6,140,114],"goals":[12,247,101,148,52,59,145,254,96,32,1,162,153,45,6,80,246,225,224,222,204,194,105,232,41,22,157,133,167,5],"paths":["RUURRUU","DDDDDDDDDDD","DDDDDRWR","LDDDD","UULLUUU","R","DDLLLLLLDD","RRRRDDDD","LLLLLUUUUUU","LLLLLUUUUUUUU","LLLLLLLLLLLLUUUU","LLLLLLLUUUU","RRRDDDRDD","RRRRRRRRRRRRRD","RRRRRRUUUUUUUUUUUUU","DDDDDWWWWRL","LLDDDDDLDD","LDDDDLLLLDDDD","LDLLDDDDDDLDDDDDD","RDDDDDDDD","RD","LLLDDDDDDLDLLDLD","LLLLLL","LLLLLLLU","LLLLLUUUUUUUUULUUU","LLLLLLDWWWWWWWWWWLR","RRRRRRRR","LDDDDDDDD","LLLLLDD","RURUURUUUU"]},"empty:40":{"makespan":21,"moves":439,"lb":{"makespan":21,"moves":429},"starts":[0,172,229,99,14,61,72,155,3,49,152,48,45,202,141,8,21,63,40,104,114,177,123,248,82,126,216,139,143,108,111,199,47,53,174,98,183,97,43,6],"goals":[71,189,163,104,168,187,68,151,21,158,15,247,129,123,72,211,153,108,39,31,103,231,166,111,141,7,112,230,91,130,209,64,80,136,42,18,81,58,110,77],"paths":["RRRDRDRRDDR","RD","LLUUUUWWWWWWWWLR","RRRRR","DDDDDLDDLDLDLLLD","LDDDDLDDDD","LWLLL","LLLL","RRD","RRRRRRDRRDRDDDRRDRR","RURUUUURRRRUUUUR","RRRRRDDDDDDDDDDDDRR","LLLLLDLLLLLLDDDLDD","UUUUUWR","LLUUUWLLLU","LLLLLDDDDDDDDDDDDD","DDDDDRDRWRRDDDU","LLLDDD","L","RRRUURRRRUUU","RRRRRU","RRDRRRRDD","LLLLDLDD","RRRRRRRUUUUUUUUU","RRRRRRRDRDDRRR","LWUUUULLLLLUULU","LLLLLLLLUUUUUU","LDLLDLLDDDD","LLLLUUU","LDLLLDLLLLLLWWUD","LLLDDLLLLLLLLLLLDDDDD","LLLUUULLLLUUUUUWRL","LLLLLLLDLLLLLLLLDD","RDDDDRRDUD","ULLLLUUUUUUU","UUUUU","LLLLLLUUUUUU","RRRRRURRURRU","DRDRRDD","DRRRRRRRDDD"]},"empty:50":{"makespan":23,"moves":523,"lb":{"makespan":23,"moves":501},"starts":[154,60,235,102,160,43,237,185,74,10,89,219,149,108,87,133,232,99,67,247,25,236,158,84,91,211,7,3,174,239,119,204,150,52,123,164,171,162,190,177,32,47,14,27,98,203,96,94,148,145],"goals":[8,35,221,226,160,28,15,167,32,250,213,47,193,117,246,103,196,82,228,29,17,121,176,217,21,75,43,5,59,87,12,16,199,91,98,76,111,115,54,188,241,70,71,63,118,148,227,102,109,172],"paths":["LLUUUUUUUUU","LLLULLLLLL","URR","LDLDDDDULLWDDDD","","RUWWWWWWWWLR","URUUUUUUUUUUURUU","LLUWWWWUD","LLLLLLLLLLUUWWWWWWWWWRL","DDDDRDLDDDDDDDDDD","LLLLDDDDDDDD","RRRUUUUUUUUUUUR","LDLLLDD","LLLDLLDLLU","LDDDDDDDDDD","RRUU","LLLLUULWR","UL","RDDDDDDLDDDRD","RRRRRUUUUUUUUUURUUUU","LLLLLLLL","LLLUUUUUUU","LLLLLLLLLDLLLLDL","DDDDDDRRRDRRD","LLLLLLUUUU","RRRRRRUUUUURUUUUR","RRRRDD","RR","LLUUUUUULU","LLLLLLLUUUUUUUUUL","RRRUUUURRUUU","LLLLLLLLULLLUULUUUUUUUU","DDRWWDWWWLR","RRRRRRRDD","LWULWLWULLLLLDL","RRURRURRRRUUUU","UURRRRUU","WUUUR","LLLLLLUUUUUUUULL","RRRRRRRWRRRR","RDDDDDDDDDLDDRDD","LLLLLLLLLDD","LLLDLLLLDDD","RRRRDD","RRRRD","LLLLLLLUUU","RRRDDDDDDDD","LLLLLWLLLD","URRRRRRRRRUU","RRRRDWRRRRRRR"]},"random:10":{"makespan":20,"moves":124,"lb":{"makespan":20,"moves":124},"starts":[62,39,179,104,114,79,207,84,224,195],"goals":[204,232,181,228,234,86,38,46,142,115],"paths":["LDDDDDLDDDD","DRDDDWDRDDDDDDDL","RR","LDLDLLDDDDDD","RRRRRRRDDDDDDDR","LDWLLLLLLLL","LLLLLLLLUUUUUUUULUU","RRRURRRRRRRUU","RRRRRRRRRRRUUURUURRU","RUUULUU"]},"random:20":{"makespan":22,"moves":248,"lb":{"makespan":22,"moves":240},"starts":[79,253,74,24,205,75,224,144,235,147,0,81,250,132,214,137,155,17,103,125],"goals":[227,152,137,12,103,221,237,24,89,222,241,200,192,208,5,212,116,84,149,68],"paths":["LLLLLLLLLLLDDDDDDDLDDD","LLLLUUULUUU","LLDDDRD","RRRRU","LLLULUUWLULUU","RDRDDDLDDDRDD","RRRRRRRRRRRRR","RRRRURRRUUUUUUUR","LLUULUUUUUUUR","RRRDRRRRRRDRDRD","RDDLDDDDDDDDDDRDDD","RRRRDDDRRDDRDD","LLLLLLLLLUUULRRLL","LLLLDDDDD","URUUUUUUULUUUULU","LLLDDLLDDD","LLLLLUULLWWWWLR","RRRDDDDWWWWLR","DLLDD","ULULLLLLLLUL"]},"random:30":{"makespan":20,"moves":287,"lb":{"makespan":20,"moves":269},"starts":[70,7,188,134,61,108,209,150,67,180,62,72,131,13,118,66,119,80,38,229,24,241,97,158,183,238,248,242,226,149],"goals":[159,133,237,212,121,35,240,140,148,164,59,68,110,91,151,1,103,12,114,64,228,19,100,196,193,231,168,175,5,70],"paths":["DRRRRRRRRRDDDDWWWWUD","LDDDLDDDDRLD","RDDD","DLDDDLD","LLLLLDDDDR","ULLULULLLLLUL","LDD","RRRURRRWDU","RDDDDD","U","LLLWLR","LLLL","RRRRRRRRRRRUU","LLDDDDD","RDDWWWUD","LLUURUU","UWWWWRL","UUURURRRRRRRRRRRU","DLWDDLLLDD","LULULLLUUUUUUUU","LDDDDDDLDLDDDDDDL","UULUUUUUUUUUUURURR","RRWR","LLLLLLLLLDDLDWLR","LLLLDLL","LLLLLLL","RUUULUU","RRRRRRRRRRUUUUUURRRD","RRUUURUUUUUURUUUULU","UUUURUWWWWWWWLR"]},"random:40":{"makespan":24,"moves":457,"lb":{"makespan":24,"moves":437},"starts":[89,149,248,217,116,46,112,140,194,150,174,38,100,253,9,213,114,226,80,71,143,154,245,142,135,201,94,5,225,209,172,127,229,167,249,168,208,28,231,134],"goals":[127,188,64,204,109,42,144,45,27,77,146,197,130,227,131,234,165,12,104,253,53,160,143,196,90,136,38,199,169,66,30,192,248,241,243,110,4,156,185,46],"paths":["RRRWRRRDD","RRDRRRRRDWWLR","LLUUUUUULLLLLULUUUU","URRR","RRRDRWRRRRRUU","LLLL","DDWWWWWWWUD","WDRRUUULUUUU","RRRRRUUUUUUURRURRUUU","RURRRDRRRUUUUU","UWULLLWDLLLLLLLLL","DLDDDDDDLDDRD","LLDD","LLLLWULLLLLL","LLLLLDDDDLDDDD","RDRRRR","RRDDDR","RRRRUUUUUURUUURRURRRUUUU","RRRRRRRRD","RDDDRDRRRDDDRDDDD","LLUULULULLLLLLU","LLLLLLLLLLD","UUWUUWWRRUWRURRRRRRRU","LLLLDLLDLLDWLLD","UUURRR","LUUUWWU","LLULLLLLLUU","RDDDDLDDDRDRDDDD","RRRRRUURRUUR","ULUURUUURUUU","URRUUUUUUUU","LDLLLLDLLLLLLDDLDLLL","RRRD","LLLDLDLLDDD","LLLLLL","RRRRURRUUU","RURRRUUUUUUUUUUUU","DDWDDRDDDRDLLWWWUD","RRUUU","RUURURURURRRRU"]},"random:50":{"makespan":23,"moves":669,"lb":{"makespan":23,"moves":597},"starts":[19,206,253,73,26,20,241,248,138,27,6,236,86,125,10,56,219,227,185,55,224,47,252,38,17,197,114,36,64,89,80,12,25,43,53,228,110,238,203,108,176,141,103,52,132,240,157,123,71,32],"goals":[58,231,111,128,209,245,175,62,236,155,7,227,57,230,208,184,207,59,143,67,242,168,12,117,152,55,98,237,116,97,156,159,104,77,38,28,35,52,36,89,79,99,255,113,193,24,68,18,92,103],"paths":["RRRRRRRDD","LLLLLDDLL","UUUUWLUURRRUUU","LLLLLLLLLDDDD","LLLDLDLLDDDDDDLLLLDDDDR","DDDDRDDDDDDDDDD","RRRRRRRRRRUURUUUURRRD","RRRUUURUUURRUUUUUU","RRDDDDDD","RRDDDDDDDLLD","RWLDRU","LLLLLLLLL","RRRUUWDU","DDWLDLLLLLLDDDD","LLLLLLDDDDLLLDDDDDLDDDD","WDDDDDDDD","RLRRRUR","RRRUURUUUUWUUURRRRUU","RRUURRRRUWWLR","LLLDLDUWWWDU","RRD","LLLLLDLLDDDDDDD","UUUULWURURUUULUUUUUU","WDLWDWDDWDWUD","RRRRRRDDRDDDDDD","RRUUUUUUUUUWWWWWWWLR","U","DDRDDDRRRRDRDDRDRRDDD","RRDRDDWUDWWWLRRWWWLR","LDLULLLLLLDWWWLR","RRRDRDWRRDDRRRRDRRU","RWDRDDDDDDDLDRRWWLUDR","LLDDRDWRDWWLD","RDRDLR","DRUWRUL","RRUURUUUUUUURRRRRUUUU","LLULLLLLLLLUUUL","UUWLWULLLLULLLLLUUUUUUU","LLLLULUWULUULUUUUU","ULLLWUDWRWWLWUWWD","URRURRUURRRUURRRRRRRRU","LDLLLLLLULLLUU","RDDDDRDRDRRRRDDRD","DLLLDDDWWWWWWWWLR","DDDLDLL","RRRRRRUUURUUUUUUUUUUUR","LLLLUULULWULLLURLWWWWRL","WDLLULUUWLLLLUUUULL","URRRRRDDWWWWWWRLDWU","DDRDDDRRRWWDRRRUU"]},"room:10":{"makespan":20,"moves":130,"lb":{"makespan":20,"moves":130},"starts":[214,217,79,347,340,193,64,30,191,18],"goals":[239,127,221,329,310,69,74,207,29,164],"paths":["RRRRRRD","RRRRRUUUUU","DRRRRRDDRRRRDDDD","RU","LLULLLLLLLLL","UUUURRRRRDRRUUUURR","RUUURRRRRDDDRRRR","RRDDRRRRDDDDDDD","RRUUUURRRRRDRRUUUUUU","LLDDDDDLLLLDDD"]},"room:20":{"makespan":27,"moves":343,"lb":{"makespan":26,"moves":319},"starts":[22,310,125,19,317,213,152,155,95,119,151,13,329,168,350,210,30,8,264,348],"goals":[207,205,143,243,301,348,263,46,335,341,97,120,285,331,12,30,110,21,247,232],"paths":["RRDDDDRRRDDRRRRRDDDRRRR","RUUURURRRRRUURRWWWWWDUWRL","LDWWWDUWWWWWUDDWU","RRRRRDDDDRRRDDRRRRRDDDRRDD","RRRUWWWWWWWWWWWWWWWDU","LDDDDRRRDDD","RRDDRDRRRRRDRRRRDDDRDRRUUUR","UUUUUURRRRR","RRDRRRRDDDRDDDRRRRRDDDDD","RRRDRRRRRDDDRRDDDDDRRRDD","LLDDDLLLLLLDLLLLLLLLUUUUUU","LLLLLLLLDDDDDRD","LULLLLLU","DDLLLLDDDDDLLDLLD","LUUUUUUUUUURURRUUUURRUUU","RRUUUUUUUUURRRRURURRRD","LDDDDRRRRR","LLLDDLULL","LLUUULLLLLDLLLLLLLLLLDD","LUULLUUUUR"]},"room:30":{"makespan":23,"moves":414,"lb":{"makespan":23,"moves":374},"starts":[159,218,259,307,53,122,359,269,324,336,205,234,81,332,203,103,345,229,342,360,110,321,97,232,36,11,331,127,339,141],"goals":[196,8,56,308,63,65,281,109,101,224,143,122,195,7,359,288,296,45,310,142,30,292,198,96,184,333,215,74,70,341],"paths":["LDDWWWRLURDWL","LUWLUURURRUUUUUUULL","RUUURRRRUUUUUUURU","RWWWWUD","DLLLLLUUULLLLDDDWWUD","LLLUUURRR","LLUUURLU","UURRRRRRRRRRUUUUUUUR","RRUUUUURRRUUUUUUU","URRUUUUU","LLUUULLLWDUWWWWWWWWWUD","RUUUURUU","DRDDDDDL","LLUUUULUUUUULUUUUURRUUU","DLDDDDRDRRRRDD","LDDWLDDRDDDLLLLDDD","UUURRRRRDRRRUWWWWWDU","RURUUUUURRUUURRUWWWWLR","RRRUURRR","LLLUUUUUURUULLLLUULLUL","RUULLLLLUU","LWWWWLLWRDULLLLLLLLU","RRRRRDDDDDR","LLUUUULUUU","DDDLDLLLDDDDWWLR","LDDDDDRRDDDDDDDDDDLLDD","LUUUULUURLLR","URRRRUUWWWWWWWLR","LUUUURUUUUUUUUUULLL","RRRRDDDDDDDDRDRRRRRD"]},"room:40":{"makespan":32,"moves":642,"lb":{"makespan":32,"moves":578},"starts":[312,298,15,354,110,134,303,155,0,132,95,235,1,324,360,201,122,244,200,255,268,278,58,8,301,183,250,70,231,248,333,206,168,232,38,318,202,101,106,74],"goals":[212,202,150,157,243,350,15,318,255,269,321,314,177,262,328,304,103,191,98,124,6,143,32,216,141,355,92,112,225,63,317,354,298,174,340,96,159,44,74,307],"paths":["LLLULLUUUU","LUULUUURLR","RRDDDLDDDRD","LLULLLUUUULUUUUUL","RDDDDDLDDWWWWWWWWWWWWRLRL","RRURRDDWRDRDDDDDDRDDD","LLLUURUUUUUUUUUULUUU","DDDRRRRRRRRRDDDDRDRWWWWWWWWRUDL","RRRDDDDDLDDDDDDDRRRRDRR","LDDDDWLLLLULRDDLLLDLLLLLLLDD","RRRRRRRRDDRRRRRDDDRRDDDDDRRDWWRL","DDDRDRR","RDDDRDDRDRDDWWRUDD","RRURRRWRUUURURRRRRUURRDDD","LLLUULLDLLLLLLLL","LDLLLDLLLLLDDDLLD","UWWWWLDUR","LUWULLDLLULDLLLLLLDLLLUU","DLLLLUUUUUUWLLL","ULUUUURURRU","RUUUUUUUURRUUUUURU","UULUUWRUULLWURL","RRWURRURRRURRRRRD","LDDDLWLDDRRDDDDDD","LUUUUULLLUULLULL","DDDDDDRDDD","URRRRRRRRRRUWDWUURRRUUUUUU","RRRRDD","RRRRRRRRRRUURRRD","UUUWRWUURUURRUUUR","RRRUWWLWRWWWWWWWWDUWWWWWWWDU","LLLLDDDDDDDD","DDLLLLDDDDDRWWLDUR","ULLUUWR","RRRRRDDDRRDDDDDRDRRRRDDDDDRRRRRD","LLLLLDLLLLULLLUUUUUUUULUUU","LLDLLLUUUWWWLWR","LUURU","RRRRRURU","LDDDDDDDLLLUDDLLLDLLLLLLLDDDD"]},"room:50":{"makespan":35,"moves":922,"lb":{"makespan":32,"moves":744},"starts":[164,241,100,101,121,105,74,20,190,145,130,15,302,70,12,236,331,312,26,324,305,248,68,259,332,207,245,72,315,95,340,319,54,142,344,291,1,106,301,62,64,230,21,35,336,203,37,109,149,124],"goals":[184,16,81,278,30,202,235,308,152,145,350,58,11,0,285,319,141,32,129,289,98,113,29,257,237,214,8,99,92,148,102,315,342,36,168,34,38,231,48,307,210,243,183,314,125,281,177,292,153,230],"paths":["RDLRWWWWWLWRUDWLR","UUUUUULRWUDURRRUUUUU","LLUUURRDWRLD","DDDDDDDRRRRRRDD","RDRLDUUWDRRUUUURUU","RDRDDDDWWWWDWUDUWWWWWWLR","LDDLLLDDDDWDLLLDLLLD","RDDWRDDDDLDRDDDDDDDDR","RRUULL","WWWLRWWWWLR","DDDDLLLDDDLDDLLDLLDD","DDDLLLLLUUULLLLLDLLLLDD","LLUURUUURUUUUUUURLLLRLLLLUUUL","LLUUULRLLLLLLDLLLLLU","LLLLLLLDDDDDLDLLDDDDDDDDDLLWWRDUL","RRRRDWLRDDRDRRRLWWWWWWWRL","LUUUUUUUULUURRWUDWUD","RRRRUUUUUWDRUURRRUUUUURUULLLLUU","RUWDURRDRRRDDRRRRDDLLD","RUURR","RRUUUUUUUUUUU","RRURRRRRRRRRRUURRRRUURUUU","LUUWWWWDURLWWWWWDRLU","LL","LLUUUURWWURWWWWWWUD","LLLLLLLDLLLLLWWWWWWWWWUD","UUULULUUULLLLWLUUUUULL","LLLLULDDDDRRRDDDDDLLLLLLUUULLUULU","RRRRUUURUUUUUUUUU","RRRRDRRRRWDRRURRRURRDD","LLUUUUUUULLLUULLULLLUU","LRRWLLLLLWDU","WDDDLLLLDDDDRLDLLDLLLLLLLLDDDDLLDDD","RUUUURURRDRRRRUU","RUURRRRRRRRRRRRUUURUUUUU","RUUUUUUURURRUUUURRRRRUU","LDD","RLDLDLLLDDLDDDLLLWDU","LUUUUURURLULUUULLLLLUUU","DDLDLDDDLRDDDDDDDWWDU","LLDDLLLDDDDDLD","RRRRRRRRRRRUURRDD","RRRDDDDRRDDDDDRDDRRRRUUU","WDDDDDDDDDLDDDDWURRLLDDDLLLULLD","LUUWLRRDRRUUURUULURUUUUULLLLLD","RWLDULLWWWWWDRRURWRDWRDDLD","LLDDDDLLLLLDDLLLLLDD","LLLLDDLLLDDDDDDDD","DDDLLLDLLLLLWLLDLLLUULUUL","RDLLLLLDDDLDLLLDWWWWWLRWWWLR"]},"maze:10":{"makespan":39,"moves":209,"lb":{"makespan":39,"moves":201},"starts":[235,100,25,266,30,153,8,182,177,213],"goals":[210,239,162,230,143,178,9,231,203,153],"paths":["RDDLLLLLLLLLUUU","DDDDDDDDDDLLLLLDLLLLUUULLLLLD","RRDDRRRRRDDDDDDDDDLLLUUUUULLLDD","LLLLUURR","RRDDDDDDDDDDDLDLLUUUUUULLLDDLLU","RRRRDDDRRRDDDRRRRRRRRUULLLUUUUUULLDDDLL","R","RDDRRDDDLLLLLLDLLUUURURRD","RRRUUURRRDDDDDRRRU","LLLLLLLLLUUU"]},"maze:20":{"makespan":47,"moves":485,"lb":{"makespan":45,"moves":449},"starts":[72,23,20,32,216,205,82,4,120,221,188,8,152,135,202,84,208,155,288,148],"goals":[24,136,185,183,69,264,109,143,47,214,236,231,33,131,234,4,31,285,125,124],"paths":["DDRRRDDDRDRRUUWURRRDDLDDRDRRUUUUUUUULLLLLLUUULL","RRRRDDRRRRRDDDDDDDDDDDDLLLLLDLLLLUUULLLLLLUUUUU","RRRRRRDWRDRRRRRDDDDDDDWWWWWWWRLWWWRL","DWDDDDDDDDDDLLUU","UUUUULLLDDLLLUULLLUUULL","RRRRRRDDDRR","URDDDDDDDDDLLLUUUUULLLDDLLUUU","RRRRRRDDDRRRRRDDDDDDDDDLLLUUUUULLLDDLLU","DDRRRDDDRRRDDDRDRRRRURWLDWURRRUUUUUUUUUUULLUU","RRRRRRURRRR","DRRRRRRDDDRDRRRRRRRURULUWWWWWWWLR","RRDDDRRRRRDDDDDDDDDDDDLLLLLDLLLUUURRR","UUUUUUU","LDDDDDLLLUUUUUWWWUWDWWWWWWWWWWUD","DLLD","LLLLLLLUUULLLLLU","RRRDDDRRRRRRRRUUURUUULUUUUUUUUL","RRDDDRDRRDDRDRRRRR","LUUULULLUUUUULLLDDLLLUU","ULLLDDLDLLUUULWUD"]},"maze:30":{"makespan":56,"moves":822,"lb":{"makespan":52,"moves":728},"starts":[213,148,218,114,254,230,17,41,270,269,258,78,58,101,43,272,285,3,281,7,191,259,211,47,159,23,74,54,137,132],"goals":[119,32,129,180,120,272,213,17,107,229,217,69,202,281,212,8,53,200,108,10,149,35,261,171,287,176,62,63,266,105],"paths":["LLLLLLLLLUUUUU","RDDDDRRRUUUUUUUULUUU","LLUUUUUDULLWDUUWWDWWWUWWDWWWWUDWWUDUD","LLDDDD","DLLLLLLLLLULULLLLLUUUUUU","LLLULLLLLLDDDD","RDDRRRDDDRRRDDDRDRWURUWURRRDDDWLDDDRRRDDLLLLLLLLUUURR","LRURRRDDRRRRRDDDDDDDRDDLLLLUUUUULLLDDLLLUULLUULULLLUUU","UULLLUUUUUULLLDDLLLUULU","LLLLLLDLUDUWDWWUDUUUR","LLUURUDRRRRRDDRRDRRRRRRUUULLU","RRRRRDDDDDDDDLLLUUUUULLLDDLLLUULLUULULLWWWWWWWWWWUD","UURRRDDRRRRRDDDDDDDD","LDDDDDDDDDDLLLLLLD","RDRRRRRDDDDDDDDDWDDDLLLWWWWWDLLULLLUUURWWWWWWWWWWLLRR","UUUWWRWRRRRRURDDDRRWLDURRDRRRRURUUURUULUUUUUULLLLLLUUULU","RRUUULLLUUUUUULLLDDLLLUULLLUUULUWWWWWWWWWWWWWWWWWWWRL","RRRRRRRDDDRRRRRDDDDDDDRDDLLDLLUUR","RRRRRRUURULLLLUUUUUULLLDDLLLUUU","RRRWLDUR","DRDRRDDRDRRRRRRRURULULLULUUUUR","LLLUURRRRRRDDRRDRRRRRRUUULLLUUUUUULLLDDLLLUULLLUUULULU","LDDD","DRRDDDDDDDDDDDDLLLLLLLLULULLLLLUUU","RRRURURRRDDDDDDRRDDDWRWL","RRRRDDRRRRRDDDDDDDDDLLLUUUUULLLDDLLLD","RUUURWRDDWRR","RDDDRRRDDDRRRUUDURRRDDDDDUDRRRUULUUUUUULLLU","DRRRDDDRRRWWDDDRWRRDRUWWWWWWWWWWWWWWWWWWWWWDU","LLWLLDDLLLUULLLUWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWRL"]},"maze:40":{"makespan":53,"moves":1161,"lb":{"makespan":51,"moves":1003},"starts":[143,66,231,163,222,131,80,52,280,206,287,253,154,224,120,221,50,216,109,255,207,69,34,27,159,263,186,29,21,3,228,1,107,84,64,40,26,146,58,226],"goals":[9,155,261,188,55,1,178,157,47,276,132,131,137,79,231,206,100,33,213,7,43,262,273,145,61,280,245,5,209,71,14,53,44,234,70,228,103,163,153,40],"paths":["WDRRRUURRRDDDDDRRUUUUUUUULLLLLLUUUU","DDDDDDDDDRDDDLDLLLLLLULLLUULLLUUULU","LLLDLDWWWWWWWWWWWWWWWWWWDUWWWWDUWDWUDUDUDUDU","UURRRDDWLDDDDWWURRRDDDLLLLLLLLLUULLLLLUU","RRRRRRDDRRRRRRRRUULLLUUUUURUULLLLDDDLLLUULLUUUU","LULLDDWDLLLUULLLUUULLUUUU","RRRDDDDDDDDLLLUUUUUDRWLULLLDDLD","RRRDDDRRRDDDRRRUURURRDDDDDDRRDDDLLLLLLLLLUULLUUUU","RRRRRRRUUUWUUUUUURLURUUULLLU","LDUDDDRRRD","UUULLUUUULUWURWWWWWWWLRWWWWLR","ULLLUUUUUWUUWDWWWWLURWDUDWWUWDWWWWWUDUD","LUR","RRRRDDRRRRRRRDWURURULUUUUUUURUUWLLLLWL","DDRRRDDDRRRRRRD","RRU","DDDWWLWWRWLWWRLWRLWRLWRWLWRWLWRL","RRRRUUUUUUUUUUU","DDDRRRUURRRDDDDDRRDDDLLLLLLLLUURRU","RUURRRRRRDDRRRRRRRRRULUUUUUUUUUULLLLLLUUULLU","RRRRDDDRRRRRRRRUURUWLUUUUUUUULLLLUWWDLLUU","RRRDDRRRDDDRRURURURDDDRDDDDURRDDDLLLLLLLLDU","RDRRRDDDRRRDDDRRRUURRDDWRDDWDRRDDDLLLLLLLLLUULLLLLDDD","DDDRRRRRDDDDDRDLRWWLRDDDLLRUDLULLUUUUULLLD","RRRRUURRRDDDDDRRUUUUUUUULLLLLU","D","DDDLDDLDLLLLLULLUWWWWWWWWWWWWLR","DDLLLUULLLLU","RRRRRRDDRRRRRDRDDWDDDDDDLDDDLLLLLLLLLUULU","RRRRRRRDDDRRRRRDDDRDDDDDDLLDLLUUUUUULLLDDLLLUULLLUUU","DDRRRRRRRRUUUUUUUUUUUUUULU","DDDR","RRDDDRRRUURRRDDDDDRRUUUUUUUULLLLLLUUR","DDDDDWLDDDLLDWWWLURWDWWWWWRRLL","RRWDDDDDDDDRDDLLLLUUURDLUUUWULLLDDLLLUULLLUUUL","WRWURRRDDRRRRRDRWDWDDDDDDDDDLDLLLLLLLLLUUR","RDDDRRRRRDDDDDRDDWLRDDDLDLLLLLLLLLUULLLUUULLULUURU","LRDDWWUDUWWWWWDUDU","UURRRDDRRRRRDDDDRDDDDDDLDDLLLLLLLLLUULLLLLLUUUU","RRDDRRRRRRRRUUUUUUUUURWWUULLLLLLLUUULLLD"]},"maze:50":{"makespan":60,"moves":1359,"lb":{"makespan":52,"moves":1029},"starts":[146,267,210,219,284,276,80,71,35,261,8,206,135,165,102,266,114,229,171,257,70,211,66,172,30,81,131,52,32,115,200,166,44,227,41,169,106,233,161,53,58,282,43,183,216,109,182,177,256,223],"goals":[170,245,207,52,14,231,159,176,51,71,75,113,211,213,6,7,128,221,50,190,64,225,226,67,266,229,163,205,88,30,125,13,169,81,10,220,269,287,168,119,186,200,122,227,155,253,219,276,236,132],"paths":["UURRRDDDDDDRDRDRLDDLLLLLLLLLUUUULLULULLL","LLDLLLLUUWRWWWLRWWWLRLR","LLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDU","LLLUUUUULLLDDLLUUULLLLUULLU","RRULLDLUWDLUDLLLURRRRWWRRRRRUUUULUUUUUUUUUULU","LLLUUURRRRRRRRR","RRWRDDDDDRLWURLRLRLDDDWDDLLLWUUUUUULLDLDLLL","RDDRRDDDD","LD","RRRRRRRRRUULLLUUUUUULLLDDLLUUULLLLUU","LDDDD","RDRRRRDDRRRRRRWRRRUWLRULLLLUWUUUUULU","DDDDDDDDDLLLLLLLLLUUUU","RDDDRRDDRDDLLLLLLLLLUUURRU","RDDDRRRDDDRRRDDDRRRRRRRRRUULUUUUUUUUULULLLLLUULLLU","DRRRULDURDUWWRRWUUUUULUUUUUULULLLLLUULLU","LDLLWWWUDWUDWWWWWWWWWWUWDWWWWWWUD","ULLLDWWWWUDULUULLLLDDD","RRRDDRRRDDDRRRRRRRRRUUUUUUUUUUUUU","LUUUUURRDWWWWWWWWWWWWWWWWWWWRUDLWURDL","RRDDRRRDDDDRUDRUURURURDDRDDLRWWWLDDRRRUUUUUUUULUL","LDWRRWWULLWDLL","DDDDDDDDDDRDDDLLLLLLLLLLUUUL","RRDDRRRDDDRRRRRRRDUWDRRUUULUUUUURUUUUU","RRDDDDDDDDDRLDRLDDDDLDLLLU","RRDDDDDDDRDDDDDLLLLLLLLLULUURR","LLDDWDU","RRRDDDRRRDDWDDRRUURUURRDDRDDDDRRDRDDLDLLLLLLLLLUUUULLUULLLDD","DDDDDDDDDDRLDLLLUUUUULLLDDLLUUULLLLU","DDDDDDRRLRUUUUUUUULLUUU","LUUUULLLDDLLLUU","DDDRRURUUUWDDLUUUUUUUUULUL","DRRRRRRDDDDDDLRWWWWWLRWWWLR","RDDRRRRRRRRUUUUUUUUUUULL","URRRU","DDWLRDWWWWLRWWWWWULDRWLRWWWWWWULDR","RRRDDDRRDRWWLUURURRRDDLRDDDRDRRDDLL","RRRDDLDLLURWDLLURRDWUDURRDWWWWWWWWWRLRL","RUUURRRRDDDDDDDWULRULRWWLUURWWWWDLDDRRRUUU","RRDDDRRRDDDDRRUURURURDDDRDDDRRDRDDLDLLLLLLLLLUUUULLUULLLULUU","ULURRRRDDRRRRRRDDDDDDDWWLR","WRRRRWRWWURLDLURRUUWWLLLWULUWR","RDRRRRRDDDDDRDDDLWDLLLUUUUULLDLDLLUUULLLLD","DLWRDRRDDRWDLDLLLLLLLLLUUUUWDWRLWRLWWWWWWWWWWWWRLRL","RDRRDDLDLLLLLLLLUUULULUULLU","DDDRRRUUURRRDDDDDDRDLUWRLRDLURRDRDL","URDLRDDRDUWRLDRWRUULWRWLDWLDLRWUWRWLDWUR","RRUURUURRRDDDDDDRRDDDLDLLLLLLLLUUUULLLLLDDDRRRD","UURRRURRDWDDRRRRRRRLDUWRRRUWUDWWWU","RRRRRDDRRRRRRRRUULLUUUUUU"]},"warehouse:10":{"makespan":27,"moves":125,"lb":{"makespan":27,"moves":123},"starts":[302,162,46,139,22,122,232,43,45,178],"goals":[129,32,293,249,252,267,280,44,160,106],"paths":["RRRRRUUURRRRRRUUUUU","RRRRRRRUUUUUUR","RDRRRRRRRRRRRRRRDDDDDDDDDRR","RRRRRRRRRRRRRRDDDRRRRD","DDDDDDDDDD","RDRRRRRRDDDDD","LDDRRR","R","DDDDDLR","LLLUUU"]},"warehouse:20":{"makespan":17,"moves":195,"lb":{"makespan":17,"moves":191},"starts":[221,101,90,165,46,176,148,174,219,146,18,217,136,162,41,91,223,34,77,45],"goals":[110,220,316,224,4,243,79,158,148,77,171,268,113,153,22,294,278,145,18,60],"paths":["URUUUURRR","RRRRRDDDDDL","RDDLDDDDDDDLLLLD","RRRRRRRRRRRDDRR","RURRRU","LDDLD","LLUURRU","URRRRRRR","LLLLUURRU","UUU","LLLLDDDDDDLLLDL","DRRRRRD","U","RRRRRRRRRRRRRRU","RURRR","DDLDDDDDDDLLLDU","LLLLLLLLLDDDLLLLL","LLLLDDDDD","RRRRRRRUURRRU","LLLLLLLLD"]},"warehouse:30":{"makespan":28,"moves":431,"lb":{"makespan":28,"moves":387},"starts":[315,242,35,171,102,211,302,248,25,185,83,222,246,174,228,145,61,170,14,250,285,41,44,10,217,288,81,152,43,223],"goals":[1,176,100,288,34,230,103,33,306,245,101,301,198,12,98,311,31,238,158,73,233,172,115,287,292,148,225,274,286,15],"paths":["LLLLLLLLLLLLLLLUUUUUUUUUUUUU","RRRUUULR","LLLLDDDWWWWWWLRWLR","RRRRDRDLDDDLL","LLULURURRR","LDLLL","RRRRUUUURUUUUUURRRD","LLUWLLUULLLLLLUUUUUURR","RRRRRDDDDDDDDDDDD","DRRRRRRRRRRRRRRD","LLLLLD","LWDDDLLLDLLLLLLLLL","LULUDLWWRUWWRWL","RUURUUULULLU","LLLLLLLUULLLLLLLUUUL","DDDDDRDRRRRD","ULLLLLLULDWWWWWWWWWLR","LDDDWLR","DDDDDRDRRRRR","LLLLLLLLLLLULLUWUUUUULLL","LLUDLRUULLLL","LLLLDDDDDLLLD","LLLLLLLLLULLLLLLLLLLLLDDDDD","LLDDDDDDLDDDDDRDRRR","RRRRDDRDR","LLLLUUUUURRU","DRRDDRDDDRRR","RRRRRRRDDDDD","LLLLLLDDDDDDDWDLLLLLLLDDRDRR","LUUUUUUUUU"]},"warehouse:40":{"makespan":31,"moves":601,"lb":{"makespan":31,"moves":565},"starts":[83,277,13,69,238,253,198,246,213,180,153,280,240,299,291,165,28,145,102,122,239,315,185,231,139,223,7,159,211,254,84,166,115,283,38,75,237,215,184,171],"goals":[305,77,205,31,157,44,112,292,177,281,318,146,20,101,143,306,107,151,16,106,89,236,242,98,176,144,178,284,34,74,158,139,15,252,244,289,180,22,229,233],"paths":["DDDLRDLLLLLWLLDDDDDLD","WUUUUURRRRRURURUU","RRRRRRRRDDDDDDDDWWWWWWWRL","RRRRRRRRUUWLR","RRUDUWRRRRRUUWURRRR","RURRRRRRRRRRRRRRRRRRRRUUUUUUUUU","URUUURRRRR","LDDR","RRRRRRRRRUUR","LLLLLLLLLLLLDDDDDLL","DDDDDDDRRRR","RRRRUUUUUU","RRRURRUUUUURRRRURRUULU","UUUUUUUURURRRRRRRR","LUULLLLLULUULLLU","URRDWRWWDDDRLDDD","RRRRRRRRRRDDD","RRRRRR","RRRRURUURU","RURRRRRR","RRRWURRRUURRRRRRUUUUL","LLLLLLLLLUUUL","DRRRRRRRWDRRRR","RWUDLUUULUURURRRRR","RRRRRRWRRRRRDRRR","LLUULLLLLLLLU","RRRRRRRRDDDDDDRRD","LLLLLLLDLLLLLLDDDDD","RRRRUUUUUUUURRR","UUULUUURURRRRU","DRRRRRRDDL","LLLLU","RURRRRRRUUUURRRRRRRR","RRRRRRRRUURRRRRRR","DDDWLDWDDDDDWWUD","RDDDDDWDDDRDRRRRR","RRRRWURRRRUUURRRRD","RRRRRRRRRRRRRRUUUUUUUUU","DWRRRRRRDRRRRRURRRRRRRRRRR","LLLDDRULDLLLLD"]},"warehouse:50":{"makespan":28,"moves":743,"lb":{"makespan":26,"moves":667},"starts":[291,246,136,222,245,13,87,254,104,61,182,146,149,294,122,206,250,305,301,285,166,129,112,169,107,163,172,45,248,156,212,321,241,275,22,147,92,319,141,284,183,73,123,298,153,137,86,9,243,150],"goals":[47,22,163,274,41,61,150,243,112,205,277,92,278,38,304,156,73,43,299,234,279,198,281,53,102,249,312,116,303,39,159,218,105,171,170,96,31,79,291,151,268,178,248,122,104,216,306,30,316,247],"paths":["LLLLLLLUULUUUUUULLULLLWLU","LUUUURRRRRRRUUUUUU","DLLLLDLLRLLLLLLLLLLLLLL","RRRRRDRD","UUUUUUULUURURRRD","RRDD","LLLLDDWDLL","URRRRURRRRRRRRRDL","RURDLRRRRRRR","DDRRRRRRDDDDWWWWRL","LLLLLLLLLLLLLLLLLLLLDDDDD","LLLLLLLLUU","LDLLDLDDDDLLLLL","LLLUWULUUUUUUUUUR","WDDDDDDDLLD","LULLLUWDU","LLLLLLUUULLLLLLLUUULLUL","RRUUURRRRRRUUUUUUUUUURRRRRRD","LL","LLUULLL","LLLLDDDDDRRWWDU","RDLDRDWWWLRWWL","RDDDDDLLLLDLLLLLLLLLLDDLL","WULUUUUWRLWWWWRL","LLLLL","RURDRRRRDDRRRRRRRRRRRD","RRRDRDDDLDLD","LLLLLLLLLLLLLLLLLLLLLDDDD","LLLLDDLLLLLLLLLLD","LLLUUULUURR","RRRRRRRRRRRRRRRRUUU","UWLLLLLLLULULLLU","RRRUUUDUUUUL","LULLLLLLWLUUULLLL","LDDDLLLLLLDDDDLLLLULLD","DLULUULLL","RRRRRRURUUWRWDU","RUUUWWUUULLLLLLLUUUULLLL","RRDRRRDDRRRRRRRDDD","UURRRRRRWUUULU","DLDLDLLLLLDWWWWWLR","RRRRRRRRRRRDDDRRD","DRRRRRRRDDDRRRD","LLLLLLLLLLLLLLLUUUUUUU","LUULL","LDDDDLLLLLDLLLLLLLU","LLULULLLLLLDDDDDWDDLDDDDD","LLDWWWWWWLWRWWDU","RDDRRDR","LDLLLDDRRRRRRRRRD"]},"warehouse_hard:50":{"makespan":39,"moves":904,"lb":{"makespan":27,"moves":672},"starts":[211,111,125,19,172,259,68,75,213,149,302,163,8,220,208,49,65,23,99,312,15,271,253,181,221,237,254,199,24,322,225,214,64,112,262,60,217,93,55,187,117,303,202,57,72,219,122,287,157,313],"goals":[299,111,157,156,257,314,200,187,53,252,56,93,149,63,102,7,173,18,5,19,217,249,103,100,307,105,17,125,174,319,51,150,223,212,275,59,151,204,62,168,8,203,66,137,170,57,323,25,143,74],"paths":["WWWWWWWWWRDDRRRRRRRRRRRRD","WWWWWRRRRRRRRRRRRRDULWRUDLLLLLLLLLLLLL","DRRRRWRWWWWWRDUR","LLLLLLLLLLLLLDDDDDDWWWWUD","LLLLDDLLLLLLDDLLLLLLLRWDWUR","RLLLLLLLLLLDDRRRRRRUURRRRRRDDRR","DDDWDDWDLLLLLLLLLLLWLLRDDLLLLLLUU","DRRWLLDDRRRRRRRRRRRRD","LUUWRLUUUULLLLLLLLL","DDDLLLLLWWLLLLLLLDDDDLLLLLLUULLLL","RRRRUWUUUUUUUUDRWLUWU","RRRRWRLRWLWWRUUUWWWWWWWDRLU","LLDDDDRRRRRRRRRRRRRRRRRRD","LLLLLLLLUUUWWUUUR","LLUUWLRUULLLL","WDLLLLLLLLLLLLLLLLLLUUR","RRRDDDDRRRRR","LLLLLWWWWWWWWWWWWLR","ULLLLLLLLLLLLLLLLLLUUL","RRRRRRUUUUUUUUUUUUR","LLLLLLLLLDDRWLDDDDDWWDDDRRRRRRRRRRRRUUL","RRRUULRD","RRRWUULRUUUULLL","UUULLLLLLWWWWWWWWWWWRL","LLLLLLLLLDDDDLLLWRRRRLLLLLL","DLLLLLWLUUUUUUL","RRUWUUWUUURRRRRRUWUUURRRRR","DLLLLLLLLLLLLLLLLLLLLLLLLUUU","WDDDDDDWWUUUDDD","LLL","UUUUUUUR","LLWDDLLLLLLLLLLLLUUUUWWWWWRL","RRRRDDRRRRRRDDDDL","DDRWRLLWLWRDWWDWUD","LLLLLLLLLLLLD","LWWWWWRRRRLWUWWWDLLL","LLLLLDDLLLLLLUUUULLLLLWWWWRL","DDDDDLLLLLLLLLLLLWDULL","WRRWLDDRRRRRRRWWLWUU","URRRRRLRWLWWRR","LLLLLUUUULLLL","RRRRLWLRUUUULLLWWWWWWLLLDURRR","RRRRRWLUUUURRRRRWWRRRRRRRUULL","LDWDDDRRRRRWRU","LLLWLDDDWDRR","LLLLLLLUUUUUWWULLLLL","RRDDDDDDDDL","DLLLLLLUULLLLLLUUUUUUUUU","RRRRRUULRRRRWRRRD","RRRRRUUUUUUUURRRRRRUU"]},"warehouse_hard:10":{"makespan":27,"moves":159,"lb":{"makespan":27,"moves":151},"starts":[64,62,18,5,310,324,159,103,221,93],"goals":[314,225,108,23,161,16,63,322,71,319],"paths":["LLDDLRDWDDDDDDDRR","LLLLLLLLLLLLDDDDDDD","LLLLLLDDDDLLLL","RRRRRRRRRRRRRRRRRR","RRUUUUUUL","UUUULLLLLLUUUUUUUULL","RRRUUUUR","RRRRRRRRRRRRRRRDDDDDDDDRRRR","LLLUUUUUURRR","DDDWLRDDDDDDRWWWWWWWWLLRR"]},"warehouse_hard:20":{"makespan":28,"moves":304,"lb":{"makespan":28,"moves":296},"starts":[202,51,7,21,165,59,12,161,269,305,261,249,87,257,181,143,101,123,15,107],"goals":[61,123,299,152,73,321,93,272,250,204,317,252,109,11,313,12,5,169,143,271],"paths":["RRRRUUUUUURRRRR","RRRRRRRRRRRRRRRRRDDRRRRR","RRRRRRRRRRRRRRRRRDDDDDDDDDDD","LLLDDDDLLLLLLDDLLLLLLLLLL","RRRRRRRRRUUUUL","RRRDDDDRRRRRRDDDDDDRRR","RRRRRRDDDWWWWWWUUDD","RDDRRRRRRDDRRRR","LLLLLLLLLLLLLLLLLLL","RUUUULL","RDDRRRRR","DLLLLLLLLLLLLLLLLLLLLLL","DLLL","LUUUUUUUUUURRRRR","DRRRRRRDDDDR","ULLLLLLUUUU","LUUUURRRRR","LLLLLDDR","RRWRDDDDD","LDDRRRRRRRRRRRRDDDDRRR"]},"warehouse_hard:30":{"makespan":32,"moves":550,"lb":{"makespan":26,"moves":442},"starts":[159,160,237,115,61,173,313,24,149,4,116,274,87,153,251,258,171,312,12,309,156,303,157,106,222,6,122,193,204,271],"goals":[324,53,105,6,322,81,111,13,259,70,150,156,272,170,121,120,204,3,8,201,55,172,157,250,167,253,162,215,314,60],"paths":["RRRDDDDDDRRRRRRRRRRRR","RRUWULLLLLLLLLLLLUURRR","ULLLRRRUDLLLLLLUWUUUL","LLLLLLLLLUUUU","RRRRRRRDDDDDDDDDDRRRR","LLLLLLLLLLLLLLLLLUUU","RRRRRUUUWWUWRWLUUUULLLLLLL","LLLLLLDDLLLLLLUUR","DDDDDLLLLLLLLLWRRRDURLLLLLLLLLL","RRRRRRRRRRRRRRDDRR","LLLLLLLLLLLLLLLLDD","LLLLLLLLLLLLLLLLLLUUUU","DWUWWDDDDDDWDRRRRRRRRRR","RRRUURWLUURRRRRRRRRRRRDDDDRR","LUUUURRRRRRUURRRRRRUURRRRRRDDRRR","RRRRDDRRRRRRUULRUUUUUURRWWLLLRRR","LLLLLLLLLDDLLLLLLLL","LLLLLLUUUULRUUUULLLLLLUUUURRR","DDLLLLLLUURR","LLLUUUULLLLL","UUUUL","RRWRWLRRRRRRRUURRRRRRUUUURRRR","WWWWWWWWWWWWWWWLLWRR","LLLLLLDDDDDD","LLLLUUL","DDWRLDDDDDDDDLLL","LLLLLLLLLLDD","DLLL","RRRRRRRRDDDDRR","LLLUULWRRLLLRRUUUULLLLLLUULL"]},"warehouse_hard:40":{"makespan":40,"moves":726,"lb":{"makespan":26,"moves":506},"starts":[50,149,293,17,218,216,71,7,252,266,112,164,19,203,106,304,67,10,156,257,215,21,187,69,202,5,255,209,117,324,151,315,131,15,305,161,119,64,58,93],"goals":[301,205,157,6,214,199,309,271,267,151,308,113,137,68,50,172,313,287,255,209,222,112,306,7,0,225,5,10,114,202,93,262,56,243,193,69,203,65,159,49],"paths":["DDDWURLDDDDDDDDR","DLLLLLLLLLLLLLLLLLLDDL","UUWUUUDWULLLLLLLLLLL","LLLLWLLLLLLL","RRRRRRDDLLLLLLUUWRWLLLLL","RRRRRRRRU","LLLDDDWDLLLLLLDDDDDDLLL","RRRRRDDDDDDDDRRRRRRDDRRR","RRRRDDRRRRRWRRRRRRRUWUL","LLLLLLLLLLUULLLLLLUUR","DDLLLLLWLDDUDDDDDRR","LWLUUR","LLLLLLLDDDDD","RRLWRRUUUURRRRRRUUUURRRRRRDD","UULLLLLLWWWRLWWWWDDRLUWU","RRRRRRRRUURRRRRRUUUURRRR","LWRRDDWDWDLLWRRDWWULRDDDDDDLLLLL","RRDDDDDDDDDDWRLDULRD","DDLWRDDL","LUWURRR","RRRRRRR","RRRDDLLLLLLLRUURLLLLRRRRLRLLLLLLLDDDD","DLLRRUULLLLLLDDDDDD","LUULLLLLLLLLLL","LLUUUUUDRLUUUUWWWWWDDRLUU","LLLLLDDDDDDDDD","WRWUWDDUUULLLLLLUUUUUUUURRRRR","LLLUUUURRRRRRUUUULL","LLL","LLLLLLLLLLLLUULLLLLLDUUUUUUULLLLLLDDDDRR","RRRRWRUURRRRRRUUUURRRRRRDDD","LLLUULRUULRDWWWDRWWL","UUU","LLLDWDRRRRRLRRDWUWDDDDDDDWULRD","RRRRRRRUURRRRRRDWDRLWUUWRLUUU","RDDRRRRRRWLRUUUUUWDLRUUR","LDDLLLLLLLLLLLLDDLLL","LLDDLWWRLRLRUURRR","RRRWRDDDWDLRDWDLRUULLL","WUUURRRRRRD"]},"hourglass:10":{"makespan":23,"moves":104,"lb":{"makespan":23,"moves":104},"starts":[69,18,200,8,1,426,36,116,372,0],"goals":[140,20,4,429,76,426,263,180,413,13],"paths":["RRRRRRRRDDD","RR","LLULULULULULUUUU","RRDDDDDDDDDDDLDDDDDDDDD","RRRRRRRRRRRRDDD","","LLLLLDDDDDDDDDDRD","RDDD","LDD","RRRRRRRRRRRRR"]},"hourglass:20":{"makespan":28,"moves":263,"lb":{"makespan":28,"moves":251},"starts":[133,343,345,1,301,366,120,136,324,282,12,303,9,414,430,76,54,413,305,79],"goals":[69,113,100,40,388,38,406,73,426,350,116,381,326,412,2,89,330,242,345,241],"paths":["LUUU","RRRUUUUUUULULUUU","RUUUUUUURURURURURUUDR","RRRRRRRRRRRRRRRRRRD","DDRDRRD","RUUUUUUUURURURURURURURUU","LLLLDDDULWWWDDDDLDLDLDDDDDD","UULUR","LLLDDDDD","RRRRDRDD","DDDDDLLR","LLLDLDLDLD","RDDDDDDDLDWRDDDDRDDD","LL","UUUUUUUUUUULULULULULULULULUU","LLDWWLLLLLLWWWWWWWWWRL","LLDDDDDDWWWDDDDRRDRDRDR","LLLUUUUUUUU","LLDD","LLLLLDDDDWWDDWLDD"]},"hourglass:30":{"makespan":40,"moves":495,"lb":{"makespan":38,"moves":421},"starts":[49,307,67,428,75,59,113,262,263,281,119,156,139,400,154,348,44,403,282,159,371,406,13,382,340,72,47,199,111,416],"goals":[374,73,431,307,155,23,99,50,70,10,405,344,9,20,390,410,160,430,241,308,159,67,38,117,371,93,36,29,1,132],"paths":["RRRDDDDDDWDDDRDRDRDDRRDRDR","LLLUUWWWWULDDRLUUWRUUUUUUUU","RRRRRRDDDDDDDDRDRDWDDDDDDDL","RRRRRUUUWUUUWDUWWWLR","LLDWDLLDWDWWWWWWWWWUWD","LLLLLLLWLLLLLLLLU","RUWWWRRRRRR","UUULUUUULUUU","LUUWUULLULUUUU","RRUUUWDLDRRLRDWLWUWUUURUUUUUUULUU","LLLDDDDWLWDDLDLDLDLDDDDD","RDRDWWLDDLDLDDDD","LLLLUUUUUU","RRRRRRRRRUUUUUUUWUUURUUURRRUUURRRURURUR","RRRDWLDRDWDLDLDRDRRDDDDWR","LDDDWDU","RRRRRRDRRRRRDDDD","RRRRRRD","RUURLWRDDDWURUDLUUWWLWWWWRL","LLDDLRDDRDRDRDR","LLLLUUUUWRWUUDLUUURURU","RRRUUWUUULRRLLWLURUUWWWWWRUULUUULLULLULU","RRRRD","RRRRRRUUUUUWWUUUURURUUU","RRRRRRRRRRD","DLWWWWR","RRRRRURRRRR","LULUUUUUUU","LULULULULU","LLLLLLLUUUUULUUURUULUUULLL"]},"hourglass:40":{"makespan":45,"moves":662,"lb":{"makespan":35,"moves":540},"starts":[155,132,114,369,351,93,159,55,344,349,135,400,264,393,220,199,138,323,36,27,364,23,242,3,407,66,390,54,67,8,303,405,368,434,49,88,74,113,280,417],"goals":[156,5,13,434,425,341,177,408,282,22,73,418,116,330,100,322,69,30,132,424,437,382,133,401,439,420,155,324,179,426,368,409,25,263,110,154,58,67,302,40],"paths":["RWLRWWWWWWWUD","ULUUUUU","RRRRUUUUU","RDDDR","LLLLLLLLLLDDDD","RRDDDLDRDULRRWULLRWLDDDDLDLDLDLDLD","LLLD","LDDDDDDWLRULWRRLDWWULLDDWRWWLDDDDDLDDDDD","RUUU","LLLUUUUURLUWDRWWLUWDRWWWLUUUUULLULLLUUULLLUL","RUUUWWRLWLR","RRRRRRRRRRRRRRRRRR","LLUUURUUUU","UUU","URURURURURUR","LRLRLRWLWRLRDDLDLDLDD","LLLLLLUUU","RRUUUUUUUURUWLLUUUUU","LLLLLLLLDDDLDDWURLD","RRRDDDRDDRWLLURWWDWWDDDDWULRDDLDLDLDLDDDLDDLD","RRDRWRRRRRRRDD","RRRRRRDRDDDWRWDRLDWDDDDLDLDLDLDLDLDD","LUUUUULLLWWWWWRL","RRRRRRRDDDDDDDDDWLRDDLDLDLDLDLDLDLDLD","RRRRDRURRRRRRD","RRRRRRRDDDWDDWRLWWWDDDLDLDLDLDLDLDLDDDLLL","LLUUUUUUUUUURULULLD","LDDLDWDLLDWUWRULRDWWRWDDWWWURLDDDDDDDLD","RDURRRRDRRRDDLDDWWWUD","RDDDDRDDDRDDLDDLDLDLDLDDDDDD","RRDRDDL","RRRRWWWDWU","LUUUUUUUUUULLLULULUUULU","LLLUUUUUUUU","LDDLDWWWWWWWWWWWURDLWWWWWWWWWWWWWRUDL","RRRDWDDWWWWRDUL","RRRRRU","LLWULLU","RD","LLLLLLLLUUUUUUUUUURURURURURUURRURUR"]},"hourglass:50":{"makespan":63,"moves":1070,"lb":{"makespan":30,"moves":768},"starts":[308,372,139,240,72,156,352,140,396,284,58,413,16,300,426,422,10,134,4,261,370,386,320,40,415,100,120,57,111,159,367,177,264,110,421,92,68,160,342,348,138,28,67,400,303,7,302,75,412,54],"goals":[60,32,20,437,324,381,14,416,90,386,433,92,176,285,110,388,414,407,345,31,53,347,393,387,50,260,373,59,119,91,401,179,327,429,342,68,95,408,423,344,177,19,282,28,30,431,321,400,99,200],"paths":["LULLLUWLDWRRWUUWLUULWWWWWWWRUURRRUUURRRUUURRD","LLLDLLLULLUUURRUUUWWDWWDWLRDDUWRWWUWRLUWUWDWWUUUUUUUUURRUUL","UUUURRRURRRUR","RRDRDRDRDRDRDRDDD","RDDRDDWULDDRDWUUDWULDDDDRDDDDWLL","RDDDDLDLDLDLDLDLDLD","LLLLLUUUUUWLUURURURUUURUUUU","LLLLDDDDDLDDRRDRRRDRDRDRDD","LLLLLLLLUUUUWULRWWUWWDWWWWWRLWUUWLWWRUUUULLLULUU","LLLDDDDDWWWWWWWLR","DLLLLDDDLLWDLURUWWDWWWDDDDDRDDDRRDDDDDD","LLLLUUUULDRLRWWURUUUWWDWDDURLWLUWWRUWUWLUWDWLWWRUUUULLUUU","LLLLLLLLDDDDDDDDWWULRD","RRRRRRU","RUUUUURUWULRURUWWRUWDDWWWWRLWUUULRUULLLULUL","RRRRRRRRUU","DDDDDDDDDDWUUWWURLDDDDRDDDRRRDRDDDD","RDRDDDDLDLDDDDDDD","RRRRRDRDDDDDRDWRUWDDLDWLDDDDDDDL","RUWLWDDDRUUWUUUUULULUURUURU","LLLUUUUUWRWUWWLUURUUUULUURU","RRRUWU","RRRRDDRRRRRRDWWWWWWWWWWWWWWWWWWWWRL","LLLLLLLLLDDDDDDUWWDDDDDLDDDDDDD","LLLLLLUUUULRRLWUWWUWWDWWWWWWLRUUWWWLRWUUUWDWDRLUUUULUUUULU","LLLLLLDDLWDWLRUWWWUDDURDDDDDLDL","LLDWLLWULLDWLDLRWLWUDRWRRDDDDRDDDRRRDRDRD","RR","RRRWWRRRRR","LLULLLUU","LLLLLLLDLDWWWWWWWWWWWWWWWDU","RRWWURDLWLRRLRURWWULDLWD","DDD","RRRDDRWRWRWWWRUWRULWDLWDWLDWULRDDDDDDDDDDRDDLDL","RRRRRUUUU","LLLU","RRRRRRD","LLWLDDDDLDDDDDDDD","LLDLDDD","LLWULLDWWWWWWLR","LLLDD","RRRRRURRRRRRR","RRRRRDDDDWRDUWLWWLRWRDDDDLDD","RRRRRRRRUURUUUUUWWUWLWWDLRLRWRUUWDRLUUUULUUUULLUU","RUUURLRDRWWLWLWUUURUULLUUUUUU","RRRDDDDDUDRLRLWUWWDLDLRRWWDWUWWDDWUUDDUUWDDDDWULWWRDDDDDDDDRDDD","DDLLUWWWWWWWRL","LLDDDDDDDDLDDLLDDDDLLLDDLLL","UWUUUULLUWWDWWLRUUUWWWDRLRWLRLRLUWDUWLUUUWDLRUURRRUUURR","DDDDDDLDWURUULWWURDDDLWD"]},"bremen:10":{"makespan":66,"moves":335,"lb":{"makespan":66,"moves":333},"starts":[360,540,2129,1541,1734,2228,1545,130,1117,1984],"goals":[389,1092,333,432,1745,1888,58,1190,387,1258],"paths":["RRRRRURURURUURRRRRRRRRRRRRRRRRRDDDDDDRRRU","DDDDDDDDDDRRD","RRRRRRRRRUUUUUUUUUUUUUUUUUULULLUUUUUULUULUUUUUUUUU","LLLUUUUUULULLUUUUUULUULUULUUUUU","RRRRRRRRRRR","RRRRRRRRRRUUUUUUU","LLLLLLLUUUUUULULLUUUUUULUULUULULLLUULUUULLULULLULLULULLLLLLLLLLLLU","RRRRRRDDDDDRRRDRDDDDDDDDDDDDDDD","RRRUUURRRRRURUURURURURURRRRRRRUUUUU","LLLLLLLLLUULULULLULUULLULULULUULULLULLLL"]},"bremen:50":{"makespan":69,"moves":1814,"lb":{"makespan":69,"moves":1796},"starts":[37,285,480,257,383,2031,2289,1211,1118,837,919,316,1521,745,2137,406,2237,1584,1454,1567,277,175,281,1165,1571,185,1738,965,2281,1684,1720,126,1001,1624,85,2297,1451,1823,1343,213,7,643,2498,2445,211,309,224,1771,1237,1441],"goals":[1746,229,567,840,456,407,1279,774,508,950,1637,1396,388,1222,336,762,1883,533,759,1837,2398,1113,1103,1066,610,331,432,734,316,1536,538,1781,75,1241,1095,1056,111,10,1295,592,579,2325,1569,1276,54,1346,2183,488,1591,276],"paths":["LDDDDDDDRRRDRDDDDDDDDDDDDRRRRDDRDDRDDDDDDDDDD","LLLUULLLD","LDDDDLDLDDLLLLLLLLLULUUUU","RRRRRRRRRRURUURRRRRRRRRRRRRRRRRRDDDDDRRRDRDDDDDDDD","LLLLLLLULULLULLULULLLLLLLLLLLLLLDDDDDDD","LLLLLLUUULULULLULUULLULULULUULULLULLLLLUUUUUUUUUUUUUUUUU","UUUUUUUUUUUUUUUUUUUULULULLLLDLDLLL","RRRRRRRRRUUUUURRRRUUUU","LUULLLLLLLLLUUUUUUUUUU","LLLULUULULLLDLDWLDDLLLLLLLLDDDLLLLLDDDDLLLLLLLLLLLLULULUU","DDDDDDDDDDRDRDRDRDRDRDRDRRDRRRRRRRRURUUU","URURUURRRRRRRRRRRRRRRRRRDDDDDRRRDRDDDDDDDDDDDDRRRRDDRDDRDDD","LLUUUURUWUUUUUURRRRRURUURURURURURRRRRRRRUUUUU","LLLLLLLLLLLLULULLLDLDLDDUUDDLLLLLLLDDDDDRDRDD","RUUUUUUUUUUUUUUUUUULULUUUUUUUUUUUUUUUUU","RRRRRDDDDDDRD","LLLLUUUUUUU","RRRRUUUUUUULULLUUUUUULUULUUUUU","RRUURRURUUWUUUUUUUUU","RDRRRRRRDRDRDRRDRRRRRRRRR","RRRRRRRRRDDRRRDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDRRDRDRRRRRR","LLLLLUULLLLLLLLLDDDDDDDDDDDDDDDRRDDDDDD","LDLWDDDDDDDLDLDUDDLLDLLLLLLDDLLLLLLLLLLLLLDDDDLLLU","RUU","LLLLULULUULULLULLUUUUUUUUUUUUU","LLLLDDD","UUUUUUUUUULULLUUUUUULUULUULUUUUU","RRRRRRRRRRURUURURURURURRRRDD","LLLLLLUUUUUUUULULULLULUULUUUUUUUUUUUUUUUULULULLUUUUUUUUR","RRUUU","RRDRRRRRRDRRRRRRRRRRUUUUUUUUUUUULURUUUUUUUUUUUUU","RRRRRRRRRRDDDDDRDDDDDDDDDDDDDDDDRDDDDDLDLLDDLDLDLDLD","RDDRDRRRRRRRRUUUUUUUUUUURRRRUUUUUURURURUURRRRRRRU","DRDRWDRRDRRRRRRRRRRRRUUUUUURUUUUUU","RDDDDDDRRRDRDDDDDDDDDDDDRRRRRD","LLDDLLLLLLULLLLLLLLLLLLLLUUUUUUUUULULULLULUULLULULULUULULLULLLLLLUUUU","RRRRRUURRURURUUUUUUUUUUUUUURUUUUUUUUU","UULLLUULLULULULUULULLULUUUUUUUUUUUUUULUUUUUUUUUUU","RRU","RRRRRUURRRRRRRRRRRRRRRRRRDDDDDRRRDRDDRDR","RRRRRRRRRRRRRRRRRRRRRRDDDLDDRDDDDDD","LLLLDWDDDDDDDDDDDDLDDDLDLLDDLDLDLDLDLDLLLLLDDDDDDDDDD","LLLLLLULULLULLLLLLLLLLLLLLUUUUUUUUULULULLULUULU","LLLLULLUUUUUUUUUUUULUUUUUUUUUUULULLLLDLDLLDLLLUL","LLLLLLULUU","RRRRRRRURURUURRRRRRRRRRDDDDDDDWRRRRRRRRRRRDDDDDDDDRDDDRRRRDDRDDRDD","RRRRRRRRRRRDDDDDDDDDDDDDDDRDDDWRRDDDDDDLDLLDDLDDDDDDDLDDDDD","RRRRRRRDRRRRRRRRRRUUUUUUUUUUUUUUUUUUUUUUUUUUU","RRRRDDDDDDD","LLLUUUULULLUUUUUULUULUULULLLUULUUULLUU"]},"bremen:100":{"makespan":82,"moves":3541,"lb":{"makespan":82,"moves":3387},"starts":[1037,1347,1695,1673,218,876,406,166,124,1218,73,2134,2384,328,539,1043,177,1303,990,1590,1319,2288,1831,1260,20,1541,1259,1416,2326,2247,1253,589,11,36,1342,35,186,357,737,1495,490,963,213,479,2294,65,2124,2186,265,64,126,416,1925,1535,181,1264,538,1452,2229,1536,588,2323,70,1271,1465,415,81,2320,1771,2325,2080,1643,693,1118,659,1058,1187,1307,2341,2395,691,1642,2032,1733,356,1191,1594,172,824,2445,1267,359,1205,560,2086,1318,109,758,331,1639],"goals":[1644,1330,528,1469,1545,985,2179,263,315,173,2371,1880,1791,115,488,680,686,1266,774,1883,1192,1587,155,1696,1772,1340,167,969,286,1601,117,1213,1015,2336,2378,1535,1683,2386,670,858,2476,1548,581,1138,365,1035,1640,1134,20,729,682,1001,232,1063,1169,2248,1741,1400,885,2392,1188,1154,205,72,935,2030,1445,338,1891,440,784,1881,119,592,1594,130,1798,80,2282,661,1313,1849,579,1568,218,2125,1140,531,610,1983,1882,739,1271,1744,1189,1103,2345,1721,952,873],"paths":["RRDRRRRRDDDDDDDDDDD","LLLLLLULLLULULLLLDLDLLD","LLLLLULLUUUUUUUULULLUUUUUULUULUULULLLUUL","LLLULUUUWWWWWWWWWWWWWWWWWWWWWWWWWUD","UURWURRRRRRRRRRRRRRRRRDDDDDDRRRDDDDDDDDDDDDRDRRRRDDDDDDDDDRD","URURURURWURRRRRDDDDDDDWRLWWWWWWWWWRLWWWRL","RRRRRDDDDDDRDRDDRDRDRRRDDDDDDDDDDRDRDRDRDRDRDRDRRDRRDDDDDD","LLLDD","LLLLLLLDLLDDDWWWWWWWWWWWUD","RUUUUUUUULULULLUUUUUUULUURURURUWRRRRRRD","LLLWDLLDLLLDDLDDRDRDRDRDDDRDDDDDRDDDDDDLDDDDRDRDRDRDRDRDDDDDDDDLDLLDLDDDD","LLLLUUUUU","RRURRUUUUUUURURRUUU","LLLULLULLULULLLLL","LUWWWWWWRLWLR","LLLLLLLLUUULUULUUULLLDWWWWULWDR","RDDDDDDWRRRRRRRRDDDD","RRRRRRURRRRRRR","LLLLLUULUULUULULLLDLDLDUWDDLLLU","DLLLLLLLDDDDD","DDRDRDRDRDRDRDRDRRDRRRRRRRRRRRRRRUUUUUUUUUUUUU","LUUUUUUUUUUUUUU","LLLLLLLLULLULUULLULULULUULULLULLLLLUUUUUUUUUUUUULUUUUUUULUU","RRRRRRRRRDDDRDRDRDRDRDRDRDRRDRRRRRRRRRRRRRRRURURRU","LLLLLDDDDDDDDRDRDRDDDRDDDDDDDDDDDDDDDRDRDRDDDDD","LUUUU","RRUUUUUUUUUUUUUURUUUUUUURRURWRR","RRUURUUUUUUUWWLRLRWWWWWLRWWRL","RRRRRRRRRURRRUUUUUUUUUUUUUUUUURULUUULUUUUUUUUUUUULUUUUUUU","LDLDDLLLLLLULLLLLLLLLLLLLLUUUUUUUUULULULLULUULUULLLULUULULLULLLLLLLLLDLDLDDDDD","RRRRRRRUURUUUUUUUUUUURRRUUUUUUURRUUUR","LLLLLLLLLLDDLDLDDLLDLLLLLDDDDDDDWLLLLLLL","DLDDDDDDDDDDDDRDRDRDDRDRDDWWWUD","DDDDDDDRDDDDDDDDDDDDDDDDDRRDLDDDLDLDDDDDDDDDDDDDDDDDWWWWWWWWWWWWWWWLR","LLLLDDLWDLLDDLDLDLDDDDDLLLLDDDDDDDDD","RDDDDDDDRRDDDDDDDDDDDDDDRDDDDLDDDLDLLD","DDDDRDDDDDDDDDDDDDDDDDRDRDDLDLDLLDDLDLD","RRRRRRRRDRDRDRDDDRDDDDDDDDDDDDDDDRDRDRDRDRDRDRDRRDRRRRRRRRDDDDDDDDDDD","LLLLULULLLDLDLDDLLLUDLLLLUUU","LLLLLLLLLLDDLDLDLDLDLDWUDLLLLLLLULLULUULLULULULUULULLULLLLUUUUUUUU","LDDDDDDDDDDDDDDDLDDDDLDLLDDLDLDLDLDLDLLLLDDDDDDDDDDDDD","RRRRRDDDDRDDDDDRDRDRDRDRDRDRDRRDRRRRRRRRRRRRRRRURURRRRUUUU","RRRRUUURRRRRRRRRRRRRWDDDDDDDDDDR","RRRRRRRRRDDDDDDDDDDDDDWWWWWWWWWWWWWWWWWWWLR","RDDLLLLLLULLLLLLLLLLLLLLUUUUUUUUULULULUULLUUUWUULUUUURUUUUUULUULULULLUUUUUUU","RRRRRRRRRRRRRRRRRRRRDDDDDDDDDDDDDDDDRLDDD","RRRRRRRRRRRRRRURUUURUUUUUU","RRUUUUUUUUUUUUUUUURUUURUUULLLLDWLL","RRUUUURRRU","RDDDDDLWDRDRDRDRDDDRRDRDRDRRDRRURURUR","RRRRRRDDDDDDDDDDDWWWWWWRRLLWWWURDLWWWWWWWURDL","DLLLLDDDWLLLLLDDDDDDDLDDDDLLLLULUU","RRRRRRRRRRRRRUUUUUUUUUUUUUULULLUUUUUULUULUULUUUUUUUUU","DLDLDLDLDLDLLLLLLLULLULUULUULLLULUULUUWUULUU","LLDDDDDDDWDDDLDLDDLLDLLLLLDWDDLDDD","RRRRDRDDRDRDRDRDRDRDRDRRDDRDRRRRRRRRRRDDDDDDDRRDDDRRRRRRURUUU","LRRRDDDDDDDDDDRDDDDDDDDDDDDDD","LLU","RRRRRRRRRUUUUUUUUUUUUUUUUUUUULULUUUUUUL","RRRDDDDDDDDDDDDDDDRRDRDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDU","DDDDDDDDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWLR","RRUUUUUUUUULULULLULUULLULULULUULULLULLLLLLLLUU","LLDLLDLLLLLLLLLLLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRL","LULUUUUUUUULULULLUUUUUUUURURURUURRRRU","RRRUUURRUUUUUUURRRRRURUURWLLDRURURUUWRURRWRRRRDDDDRDDL","RDRDRDDDRDDDDDDDDDDDDDDDRDRDRDRDRDRDRDRRDRDDRDD","RRRRRDDDDDDRRRDRDDDDDDDDDDDDRRRRRDDDDDDDD","RRRRRRRRRRRRRURRRRRUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUULUURUU","RRRRRRRDRRRRRRRRRRRRRD","RRRRRRRRRRURRRUURUUUUUUUUUUUUUUUUUUUUUURUUUURLUUUUUUUUU","RRRRRRRRUUUUUUUUUUUUWUUUURLULUUUUUUUULLLU","DLLLLLLLLLLLDLDDDWWWWWWRL","LLLLLLLLLLUULLLLULUUULLULULLULLULWWUL","RRUUURRRRRURUUDUDWWURURURURUURRRRRRRRRRRR","RRURRRRRRRDRRDRDRDRRRRRURURURURRRRRRRRRRDDDDDDDDRRRRDDDDDDDDDDD","RRRRRRRRRRRRUURRRRRURUURURURURUUUUUUUUUUU","RDRRRRRRRRDRRDDDDDDDDDD","RRURRRRRRRRRRRWUUUUUURRRRRURUURURURUWUUUUUUUUUUUUR","LLLULLLLLL","LLLLLLULLLLLUULLLLLLLLLUUUUUUULULULLULUULUULLLULUULULLULUUUUUUUUUUUU","LLLLLLLLLUULLLDDLDLDWRUUDLDDLLLLLLLDDDDLLLLDLLDDDDLWWDWWWUD","RRRRRRRDDDD","RRRRRRUUUUUUUUUUUUURUUURUULULLLUUUUULLULUULULLLU","LLDLDLLLLLLLULLULUULLUWRLWWWWWWWWWWWWWWWWUD","RRRRRRRRRURURURWWWWWWWWWWWWLLRR","LLLDDDDDLDLLDDLDLDLDLDDDDLLLLLDDLDD","LLLUUUUUULUUUWWWWWWWWWWWRWL","RRRRRRRRRDDDDDDD","LLLLLLULULLUULLLLL","LLLLULLULLLLLLUUUUUUU","RRDDDRDRDRDRDRDRDRDRRDRRRRD","RRRRRRURURURUWURRRRRRRRRRRRRRRRRRDDDDDRRRDDDDDDD","RRRRRRRRRRRRRRRRD","RRRRRRRRDDRDDDDDDDDDDDDDDDRDRDRDRDRDRDRDRRDRRRRRRRRRRRRRRRURU","RRUUUUUURUUUUUUUUUUUUWWWWWRLWWWWWWWWRLWWWWWWWWWWWWRL","LLLLLLULULLLLLLLLUU","RRRRRRRRRRRRRRRRRRRRRRRRRRRDDDDDRRRDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDRRDRDRRRU","RRRRRDDRDRDRRRDDDDDDDDDDDRRDRDDDWWWRWLWWWRL","LLDDDDDDDLDLDDLLLLDLLLDDDLLLLLLLLLLLLLLDDDLLLLUUUU","UUUUUULUULULLUUUUUULUULUULULLLDLDLDDLLLLD"]},"bremen:200":{"makespan":89,"moves":8036,"lb":{"makespan":88,"moves":7128},"starts":[1400,2082,1485,968,2033,133,1345,2288,13,54,1265,514,1279,1113,852,1440,2271,1733,1085,282,962,1044,1218,4,1725,1187,1449,1835,132,926,1792,735,262,1621,9,2396,2422,1156,2331,913,802,1683,2324,1035,183,1931,35,2299,362,1470,63,970,33,2332,1419,265,2188,1138,1545,1296,1723,1585,1038,640,1306,2443,1650,1258,1929,729,19,1622,164,718,1828,869,566,2272,478,1736,71,2372,1826,1883,636,222,333,103,1215,437,225,1315,763,874,361,1175,840,2426,590,1675,1318,2131,711,1444,2084,274,161,2389,431,1090,1623,688,834,2220,1062,559,825,276,179,1006,615,1741,206,1738,106,1364,940,69,680,2473,1437,1571,1140,273,1549,1152,1788,585,1673,808,922,810,1643,1645,1732,528,858,638,186,1569,1790,120,136,485,2087,335,1347,1672,1833,1343,82,2181,1157,838,2276,1487,1418,2336,1941,1471,2428,919,1505,692,483,27,1701,1690,358,77,1635,1233,1303,1381,489,2026,486,812,1160,1242,2030,325,535,1517,1640,617,511,768,1936,2285],"goals":[667,1120,802,1541,2128,558,116,1319,1645,1440,1521,1320,2229,1880,266,429,2395,686,873,132,1270,480,2380,466,539,81,117,1011,658,1103,1137,1496,1088,792,1122,1469,1296,1780,2221,86,74,2136,430,1289,183,1494,1437,1874,1721,110,1887,1441,839,1518,435,922,277,537,1452,79,958,861,1985,2084,826,2345,1540,122,2178,2173,467,2426,1637,1547,2333,326,1208,1330,1225,2138,165,123,1651,173,508,1831,801,784,1619,1234,1543,2429,1092,718,2025,1332,1110,974,164,168,1793,800,2246,1928,2435,874,2337,1237,1303,1682,778,665,1369,611,532,1102,987,2176,1438,1420,1365,437,2197,1701,4,1733,1265,1832,273,12,1089,1468,1550,1442,410,1036,2134,2299,1381,460,1568,1428,790,741,2273,2421,1282,858,852,1722,2323,1539,1979,1684,838,1536,1063,413,1067,221,2220,212,641,2321,975,1883,279,1650,206,416,1246,2081,2330,683,2328,2174,618,1843,610,2324,1041,1331,538,256,729,2177,1937,1830,170,208,1455,227,361,1986,1835,632,1640,2477,1051,234],"paths":["RRRRRRURRURURRUWUUUUUUUUUUUURRRRRRD","LLLWLLUUWULUULULULLULUULUUUWLUUUURUUWWWWWWWWWWWWWWWWWWLR","DDLDLDLDLDLDLLLLLLLULLULUULLULULUUUULLLLULLLLLLLLLUULUUUUUUU","DDDWLDDDDDLDDWRDRDLUULUDRWWDRDRRRRRDRDRDRDRRDRRRRRRURRRRRRRUUUUU","LLLLLDD","LLLLLLLLLLLLLLLLLLLLLLLLLDDDDDDDDDWWWWWWLR","LLLLLLLUULULUUULUUULUULUUUULLLLULUUULLULULLULLULULLLL","LLLLLLLULLLLLLUUUUUUULULULLULUULUUUUUU","RRDRDRRRRRDRRRRRRRRRRRDRRRRDDDRRRDDDDDDDDDRDDDDDRRRRRDDDDDDDDDDD","RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRDDDDDDRRRDRDDDDDDDDDDDDDDDDDDDD","RRDDDRRRDRDWWWWLRWWDULRWWWDUWWWWWWWWDUWWWWWWRL","RRRRDDDRRDDDDDDLDDDDDDDR","RRRRURURRRRDDRLDDDLDLLDDLDLDLDLDLDLDDDDDDDD","RRRRDDRDRDDDRDRDRDRDRDRDRDRRDRRD","DDDDDRDRRRRRRRRUUUUUUUUUUURRRRUUUUUURU","LUUUULLUULUUULUULUULUUUULLLLUUULRLRWWWWWRLUD","RRRRRRRRRRRRRRRDRRRRRRDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDU","RRRRUUUUUUWRUURULULULUUUUUUUUUU","UUUULWUULUULULLLDLDLDRLRLDURUUWWWWDLDDLLLLD","UUUWDU","RRRRRRRRDDDDDD","LLLLLLLLUUULLUULUULULULUUWWWWWWRL","RDDDDRDRDRDRDRDRDRDRRDRRDDDDDDDDDDD","RRRRRRRRRRDDDDRDDDDRDWWWWWWWLR","RDRRWDRRRRRRRRRRRUUUUUUUUUURUUUUUULUUURUULUUUWUU","LLUUUUUULUULUULULUUUUUUUUUUU","LLLLLLLLLLUUUUULUULLLUUUULUULUUUULLLLULUUULLULULLULLULULLL","LLLLLLDLLLLLULULLULUULLULULUUUULLLLULUUUUU","LLLLLLLLLLLLLLLLLLLLLLLLDDDDDDDDDDD","LLLLLLLDLLDLLLLLLLLLLLDDDLLLU","LLLLUUUUUUUUUUULUU","RRRRRDDDDDDRRRRRDDDDRDDDDDWWWWWWWWWWLRWWWWLR","RRRRRURUURRDRRRRRRRRRRRRDRRRRDDDDDDDRDDDDDDRDDDD","RRRDRDRDRRDDRRRRRRRRRRRRUUUUUUUUUUUUUUUUUUURUUUR","RRRRRDDDDRDDDDRDDRRDDDRRDDDDDDDDRDR","LLLLLLLULLLLLLLLLLLLULLUUUUUUUULULUUULLLULUUU","RRRRRRRURURRUURRRRRRRUUUUUURRRUUURRURRUUUUUUUUU","RRRRRRRRRRRRDDRDDDRDRDRDRDRDRDRDRRDRRU","LLLLLUURLLLLLL","ULLUULUULUURRRRUUUURUURURURUURURRRRRRRRRRRRRRRRRRD","DDDDDDRDRRRRRRRRUUUUUUUUUUURRRRUUUUUUUURRRUUURRRRRR","RRRDDDDDDDDD","RUUUUUUURRRRRRRRRRRRRUUUUUUUUUURURULLUUUULLLUUUUUULUULUUUULLUUUL","RRRDDDDWRDLRRWWWLWRLWRWDLWULRRLWLRWWWLR","","RRURRRRRRRRRUURRUUUUUU","RDDDDDDDDDDDRDDDDDDDDDDRDDRDLDDDRDLL","LLLDDLLLLLLLULLULLLLLLLLLLLLUUUUUUUUL","RRRDRDRDRDDDRDDDDDDDDDDDDDWLLDDUDRWLRWURDDRRDDDDD","LLLLLUULUUULLLLUUUUUUUUUUULUUUUURUUUUUUWWWWWWWWWWWWWWUDWDU","RRDDDDDDDRDRDRDDDRDDDDDDDDDDDDLDDRDRDDDRRRDRDRDRDRRDRRRRRRDRRRWWUD","RRRRRURUURURURURURRRRRRRRRRDDDDDDDDRDDDDDDDD","RRRWDDDWDDDDRRRDDDDDDDDDWDUWWWWWWWWWRLWWWDU","LLLLLLUUUUUUUUUWULULULULLWLWULLUU","ULUUUUUURURURRRRRURUWLUWLWDRUWRWLRRWWLDURUURURRURURRRRUUU","DDDRDRDRDDDRRDRDRDDD","UUUUUUUUUUUURUUUULUUULULLUUUUUULUUUUUUUULLLULULLLUU","LUUUUUUUUUUUUWRLWWWWWWWWWWWLR","LLLLDLLDLLLLLLDLDLDLDDLLLLLLULULLULUUULLLULUUUULLLLULLLLLLLLLDLDDD","LLLLLLLUULULUUUUULULUULUUUULLLLULUUUUUUUU","LLLUULLULULULUULULUULLLLULUUUU","LDLDLDLWDDULDLLLWLLLLUUULULUDWWWLULLLULUUUULLLLUUUUUUULUU","DWDDDDWRDRDDLDLLLDDDDDDDDDLD","DDDDDDDDDDDRDRDLLDLDDLLDLLDDLDDDDDDDDDD","RRRURRRRRRRUURURUUURWRRRRRRURUWLRWUWWDDUU","RRUU","RRURURURURUURRURURRRRRRRDDRDWRRRDDDRRRDRDRDRDRRDRRRRRRURRRRRUUUURU","RRUWUUUUUUUUUUURURRRUUURUUURURURUURRRR","LDDDDD","WUURURRDRRRRRDDDDDDRDRDRDDDDRDDDDDLLLLLLDDLDLDLDDDDLDLDDLLLLDLLDLD","LLLLDDDDDDDDRDR","RRDRDRDDWRDDDLDDDDDDDDD","RRRRURRRRDRRRRRRRRRRDRRRRDDDDDDDRDDDDDDRDDDDDDDDDDRDDLLDDD","RDDDDDDRDDDDDDLDDRDDDRRRDRDRDRDRRDLRRRRRRRURRRRRRRRURRRRRUUUU","RRDRRRDDDDDDDDD","ULULUULLUUUUULUUWRRURURUWURRRRRRRRDDDDRLWWWWRLWRL","LLLLLLLLDDDDDDDDDDDDD","RRRRRRRRRRRRRRRRUUUUUUUUUUUUUUUUUUUUULULLLLDLDLLD","RRRRRRRDDDDDDDDRDDDWDLDLDLDLDLLLLLLUL","DDDDDDDRRDWWWWWWWWLR","LLLLLLDD","RRRUUUUUUUUUULULULLULUULUUUUUUUUUUUUUUUULULULLUUUUUUUUUULLUURRWWURRRRRRRRD","LLLULLULUULLULULULUULULLULLLLLLLLLDLDLDDDDDD","RRURRUUUUUUWRDUUURLUUUULULLUUUUUULUUUUUUULULLULULLUUUULLLLL","LLLLLLLDLDLDDUUDDLLLLLLLLLULULLUULLLLLLLUU","RRRRRRRRRRRRRRDDDDDDDDDDRDDDRDDDDDDDRDDDDDLLLLDDLDLDLDLDDDU","LLLWLLLLULLLULLUUWLLLLLLLLLLLLDDDDDDDDDDLLDDDDDDDLDDDDLLLLUUULUUUU","RURRRRRRRRRRRRRRRRRRRRRRRRRRDRDRDRDDDDDDDDDRDDWWWWWWRL","RRDDDDDDRRDDWWWWWUWDWURDLURDLURDLWWWWWWURDLWUD","LLDDDDDDDDDDDDDDLDD","RRRRRRRRRRRDDDRRRDDDDDDDDDRDDDDRRRDDDDDDDDDD","RWDDDRDRRRDRRRDRDRDRDRRDRDDDDDDDDDDDD","DDRDRDRRDRDDDDDRDDDDDWDWRRRRDRDRDRDRRDRRRRRRURRRRRRUUUUUUUURRUUUUUU","LLLLLULUU","DDDDDDDRDRDDRDRDRDDDDDDDDRDDDRRRDRRRDRDRDDDDDDD","DRDRRRRRRD","LLLLLLULUULULLLDLDLDDUUDDLLLLLLLLDDDLLLLLLLLLDDD","UUUUUUUUWURLLUUWRLLWULUUULUUWDWWLWWLRLWLUUUUULLURURURUUUUURRRR","LUULLLULLLLLLLLULLULULULLLULUULLLLLLDD","DLLLLLUULULULUURUUUUUURURULUUUULULULUULUUUUUUUURRRU","RDDRDRDRDRDRDRDRDRRDRRRRRRRRRRRRRRRU","LLLLUUURUUWLLULULULLUUWWUULUWLRLRLDLWUULLLUULLLLULLLLLLLLULULUUULLUUUU","RDRDDRDRDRRRDDDDDWRDDDDRDRLDDRRRDRDRDRDRRDRRRRRRDRRRRRDDDDDDDDRRDRDRRDRRUUUU","LLLLLLLDLLDDLDLDLDLDDDLLLD","RDDDDDDD","RRRRRDDDDDDDDLWDLDDWLDLLWWDU","DDDDDDDDDDDRDRDDRDRDRRRDDDDDDDDDRRDRDRDRDRDRDRDRRDRRRRRRDDDDRRRDDDDDD","ULUUUUUUUUUUUUUUUUUUUUUULWWWWWRDULWURDL","LLULLLULULLULLULWULLLLLLLLLLLLLDDDDDDDDDDDDDDDDDLDDDDLLLDDDWWDUWRL","DDDDWDWRDLDDLLLLLDDLDLDWRLWRLLWWWWWWRRRWWWWWWWWWWWWWWWWWULLDL","ULLLLUUUULUUWRURUUUUURRRRRURUURURLUDR","LLLLLLULLLDLWDWLDDLLLLLLLLLULULLUWWWWWWWWWWWWWRLWWRL","ULUULULLURUULUUULULLLULULLLWLUULLLLLDDDUDLDDLDDDDDRRDDDRDRRDDDDDDDDDDLDDR","RRRRRUUUUUURLULULULLUUUUWDDUDWLWWUWULLLULUUUULLLLUUUUUUUUUULUUUUWDU","RRRRRRURURRRRRRURUWULRRWLDURURURUUUURRR","LLDDDDDDDDLDDDDLLLLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUDWWLRWLRLRWLR","RRURURURWURURRRRRDDDDDRDDD","RRRDDDDDDRRRRRRRDDDDDDRDDRDDDDRDDDDDDLLLLDDLDLDLDLDDDDLLDLLLDDDD","RRRDRRRRDDDRDDDDDDDDDDDDDRDDDDDDDRLD","RRRRRRRRRRDRRDDDDRDDDDDLWWRURUDLWURDLUR","LLLLDDRDRDDRDRDDDDDDDDD","LLUUUUUUUUUULUUUUUUUULUUUUUUUU","RRRRRDDDDDDDDDDRDRDDRDRDRRRDDDDDDDDDRRDDWDRRRDRDRDRDRRDRRRRRRDRRRRRDDDDDDDDRRDRDRRRRRUUUU","LLDLLLLLLWDLLLLLLLULLULUULLULULUUUULLLLULLLLLLLLLDLDLDDDDDLDDR","LLUU","RRRRRDRDRDRDRDRDRDRDRRDRRRRRUU","DDDDDDDDRDWLDLLLDLLDDLDLDLDLDLWWDLDLLLULLLUUULLLUULLLULUUUULU","DRDRRRRRRRRRRRRDRRRDDDDDDDDDDDRRDDRDDDDDWDDDDDRDDLLLLDDLDLDLDDD","LUUULUUULLULULWUDLWWWWWWWWWWWWWWWWWWURRDRLLLWWURDWUDL","RRWUUUUUUUUURLUUULULULLULUULUUUUUUUUUUUUUUUULULULLUULLLUUUUUUUUUUUU","RRUWUUUUUUWWWWRLWWLRWRL","LLLUU","LLDDDDDDDLLLDDLDLDLDLDLWWDLLLLLLLULLULUULLULULUUUULLLLULLLLLLLLLDLDLDLDDD","RRRRRRRRRRRRRDDRRRDRDDDDDDDDDDDDRRDDDDDDDD","LLLLLLLLLLUUUUULULULUULUUUULUULUUUULLLLULUUULUULLUULLLLULLLULLLLLDLLDLDDDDD","RRRRRRRRRUUUUUUUUUUURRRRUUUUUURURURUURRRDRRRRRRRRRRRDRDRDDDDRDDDDDRDDDDDD","LLLLDDDDDDD","RRRDDDDDDDDDDDRDDRWDDDDDLDDDDDDDDDDDDDDDDRRDRDRRDRRRURUUR","RRDRDRRDRRRRRRRRRRUUUUUUURRUUUURLUUWULDLLLLLLDLDLLLDDRR","RRUUUUUUU","LLDDDDDDDLWDDDDDDRRRWRDRDLLUWDLRUWWUDLUDUDLUWLWLWWWDU","UUUUUUURRRRUURURURURUURURRRRRRRRRRRDRDRDRDDDDDRRDDDDDDDDDDDDDLDLDLDLLLLDDD","LLLUUUUUUUUUUUUUUUUUWWWWWWRLWLRWWWWWWWWWUDWWWWWWWLR","LLLUUUWUUUUUULUUULUURUUUU","LDLDLDLLLDDLDDLDLDDD","RDRRRRRRRDDDDDDDRDRDDRDLDDRDDLDDLDLLDDLDLDLDLDDDDLLDLLLDDLLDLLDDDDDLD","RRUUUURURRUUUUUUURRURURUURRRRRRRRRRRRRDRDRDRDDDDRDRDDDDDDDDDDDDDLDLDLD","LLLLLWULLULWLUUULLULLULULLLULUULLLLLLLLLLLDDDDDDDDDDDDDLDDD","LLULLLLLLLLLLLLLLLLLLLLLLLLLLLDDDDDDDDDDDDDDDDDLDDDDLLLLUUUUUU","DRRRDDWWWWWWWWWURRDLL","LLLLLLLLDDLLDLLLLDDLDLDDDDDL","RRRRRDRRRRRRRDRRRDDDDDDDDDDDDRRDRDDDDDRDDLDDRDDDD","DDDDDRRDDDDDDDDDDDRDRDDDDDRDDDDDLLLLLLDDLDLDLDLDDDDLLDWWRLRLWWWWDU","RRRDDDDDDDDDDDRRDRRLLDDDDDDLLDLDLLDDLDD","RUUUUUUUUUUUUUURULUUUUUUUUUU","RDRRDDDDDDDDDDDDRDDDDDDLDDRLDLDLD","LLLLLLWDLDDLDLLLLDLDLDLDLDLDLDLLLLLULUUULLLULLULULUUUULLLUUUUU","LLULWULLULULUULULLUUUUUUUUUUUUWLUURURUUU","LLLLLLLLLLULLULUULLULUUUUUUUUUU","LLLLUUULLUUUUUUULLUULUUUULLLUULLUULLULULLWLRLLLWWRUDL","RRRRDDDDDDDDDDRDDDDDDDDDRDDRDDRDDWLWDDDLLLLDDLDLDLDLDDDDLLDLLLDDLLDLLDDDLLU","UUUURUUURUUURRUURRRUWUWUUDUUURULLULLUUUUUUUUULUULUUULLULULLUUUULLLLDLLULULLLULLLLLLDDD","RRRRRRRRRRRRRUUUURRRRRURULRURURURURURURRRRRRRRRRD","DDDDDDRRDDRDRDLLDLDDLLLLDDLDDDDLLLDDDLLDLLLLDDLDLLDDDLD","LUUUUUUUULULULLULUUULLULLUUURRRUUUUUUUURRRRRR","LLDDLDDDDDDLWWWWDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDU","UUUUUUURURURRRRRUUWWWURWLWDRURURURUUWUUUUUUU","LLLLLLLLLLLUUUUUUUUULULULLULUULLULULUUUULLLLULLLLLLLLLDLDLDLDDDDD","UUUUUUUWUUUUUUULUUUULLUUUUULUUULLLLULUULULLLULLULULLULULULLLULLLLLLLLLLLLDDD","LLLUURUUUUUUUUUURLULULULUUUUUU","RURUURURRRRRRRRUUUUUURRRUUURRURRUUUUUUUUUU","DDDDDDDRDWLDDDDDRRRRDRDRDRDRRDRRRDDDDD","URUURRURURRRRRRRRRRDDDDDWRWDRRRDRDRDRDRRDRDDRDDDDDDDD","LLLLLLWLLWWLWUDWWRLRLLWRLRWWWWLRRLWWWWWWWWLRWWWWWWWWWWWRL","RRDDDDDDDDDDDRRDDRDRDDDDRDLLLDLLDDLDLDLDLDDDDLDDDDDDDLLD","RDDDRDDDDDDDDRRRRRRRDDDDRDDRDDDDDDDRUDRDDLDDDLLDDLDDDLLDLDDLLDLLDLLLDDLLDD","WURURURURURUURRURURRUUUUUUUUUUUUURURRRRRRD","RRRDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWDU","RDDDDDRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDU","RDDRDRWDDDDDDRRRRRWDDDDDRDWRDRDDDDDWRDDRDDLDDDLLLLDDLDLDLDDDDLDLDDLLLLDLDDDLDD","RRURUUWRUUURWRUUUUUUWWWWWWWWWWWDWUWRL","LDUWDLD","RRRRRRURRRRRRRRRRURUUUUURRRRRURUURURURURURURRRRRRRU","URWURURURUUURULUULUULUUUULLLLULUUULLULULLULLULULLLLLLLLLLLLLLDDD","LDLLLLLLLLLDDWUWWDWDDWUWLDRWWLLWWRRLLRR","DDDWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLR","RRDDDDDDDDDDDDRDDDDDDDLLDDDDDDDDDD","DDRDRDRRDRDDDDDDDDDRLLURDLULWRRURURWLRWDDRDWWDRRRDRDRDRDRRDRR","UUUUUUUUUURURRRRUUUUUURURURUURRDWWWWWWWWWWWRRLRLLWWURDL","LLLULLLUUUUULULUULUULUULLLULUUULLULULLULLUULLLLLLLLLLLLLDD","LLLLLUUULULULLULUULLULULUUUULLLLULLLLLLLDDDD","RRWWUU","LLLLLLLUUULLULULLULLULULLLLLLLLLDDDDD","RRRRRDRDRDRDRDRRDRRRRRRDRRDD","LLLLLDDDDWWWDUUDWWWWWWWWWWDU","RDRRDRDRDRRRRRURURURURR","RRRUUUURRURURUWURURRRRRRRRRRRDRDRDRRDDDDDRDDDDDRDDDDDDDDDRRDDDRDDDLDDRRD","RDDDDDDDDLRDDDDDRDRDRDRDRDRDRDRDDDDDDDDDDDDDD","LLLLLLLLLULLLULULLULUULLULULUUUULLLLULLLLLLLLLUULULU","RURUUUUUUUUUUUUUUUWRUUURULUULLLUUUUUULUUUUUUUUUUUUU"]},"bremen:300":{"makespan":91,"moves":11453,"lb":{"makespan":90,"moves":9941},"starts":[224,587,228,1837,1277,2035,2221,584,408,1206,283,763,2276,1035,924,1108,1885,223,1840,434,1088,1257,1623,1404,2277,1175,202,633,1396,1488,464,1736,225,2084,920,2429,2037,565,1113,513,1700,179,1726,120,58,1881,1038,1210,708,1742,617,1117,2124,5,1741,1890,12,1519,157,1164,1347,707,2083,850,1549,1134,1309,119,1095,823,1775,1058,900,1429,1254,1368,1172,2397,1332,1788,1039,314,1018,1877,1979,910,278,885,2087,2171,2285,211,1437,2273,1487,1456,2180,2238,2297,2030,1043,841,710,1489,461,2424,801,209,661,1602,802,122,691,2178,57,263,1057,563,1831,1318,1649,641,1568,276,667,530,640,610,313,2295,1495,1258,614,1157,657,1118,115,218,280,689,937,1791,1331,1390,1071,1849,325,1468,557,2174,1271,2390,2375,1116,1747,1211,1644,739,104,793,1293,1633,1799,2137,2034,382,1312,1641,1205,1683,1345,1537,1771,19,407,175,1554,1119,783,1314,1112,236,913,744,665,257,1327,2086,936,1444,215,413,1067,1245,2222,752,1499,1156,1115,1339,1450,1348,590,1170,2272,921,1936,1192,838,1738,1542,1222,1218,737,1454,692,528,488,1636,463,2279,889,1536,2394,235,2224,1051,439,20,1826,1504,1012,1110,1154,1522,167,75,2298,688,1186,518,1933,738,583,1987,25,1733,1355,256,1642,585,2131,2197,1313,1925,178,2341,1393,1440,437,1338,166,1208,1731,331,808,2270,213,165,338,970,1721,818,1139,935,436,384,1929,1416,517,1841,826,568,2423,2249,966,1838,206,2186,275,1006,108,1983,1500,2225,1237,690,14,771,1194],"goals":[1797,1586,809,165,739,1927,1546,2279,1892,564,438,1840,338,1744,1058,821,1622,860,25,1089,1934,2340,583,412,122,406,1670,456,30,1378,1257,1828,1887,822,178,1835,560,1792,428,2298,910,1234,2180,1639,1213,1298,2138,1687,55,851,214,2498,2398,2347,787,885,70,1419,72,2130,2325,177,1544,1520,2178,1538,769,538,1343,1504,1837,339,1001,2124,465,1205,789,1553,2373,1488,414,740,1088,1925,950,2084,1638,158,528,2034,1017,1067,2334,121,159,1429,1686,770,2435,1572,1518,384,1454,2290,1271,255,1640,670,387,1281,1156,835,2346,2089,389,692,1776,2327,1781,1771,636,280,1315,1498,1355,1784,2189,1264,1785,579,1452,2288,1313,1883,1889,459,210,2324,1931,20,1041,708,1398,1136,1283,1584,1522,1018,1195,1152,71,1066,876,2289,179,213,128,1172,437,333,1747,2283,969,1733,1645,1061,2131,1157,286,907,1369,1194,2026,1874,331,772,581,1977,1750,743,127,556,1265,2270,211,116,837,2246,464,1390,1347,1212,386,1734,1618,1885,225,309,956,2285,1002,2132,863,1465,365,1389,2297,1246,278,1634,1979,1893,170,608,103,559,720,1169,2339,1650,183,791,1102,1342,1930,1724,157,1938,2494,1024,203,1043,1222,785,1736,2369,1793,1540,221,1011,667,1485,1225,1691,1094,2081,1644,2236,534,2030,126,82,812,1722,1163,1144,800,611,1942,2425,1341,1720,1101,308,163,668,2333,61,1602,1782,168,1380,1214,1721,2031,1595,385,1358,1346,60,1220,1295,1269,1057,79,1254,2424,2128,104,511,431,971,377,2287,68,685,54,262,607,1982],"paths":["RDRRRRRRRRRRRDDDDRRDDDDDDDDDDDDDRDDDDDDRRRRRRDRRDDDDDD","RDDDDDDDDDDDWDDDDDDLDLDD","LLLLLLLULULLLDLLLLLLLLDDDDDDDDDDDDD","UWUURUUWURUUUUUWRRWLUUUUULUURULUULDUULUUULLUULLUUWLLLLLULLLULLULULLWULUULLLLDDD","RRRRRRURURRRRRUUUUUUUUUWWLR","UULWLLLWLWLWLLWWWWWWWWWWWWWWWWWWWWWWWWWWWLR","RRRRRRRRRRRRRRRRRRUUUUUURRRURUUUURRRUUU","RRRRDDDDDDDDDDDDDDDDDLDLLDDLDLDLDLDLDLDDDDDDDDD","RDDDDDRDDRRRDDRDRDRRDDRDDDDDLLRRWLDWRLRDDRRRDDDRRRDRDDDRRDRRRRRDRDRRRRRRURRUR","URRURUUUUUUUUURRURRRU","RRRDDRRDWWLRLRWWLRWWLRWRWLWWWWWWWWWWWWWWWDUWWWWWWRLRLWWRL","DDRDRDRRRRDDDDDDWDDDRDRDRDRDRDRDRDRRDWRRRRRRRRURRRRD","RRRRRRUUUUURUURURUUWUUUUURRURUURLUUULRUUUUUUUUUULUUUUURUUU","RRRRRRRRRDDDDDDDDDDDDDD","LDLULLDDLDLLLLLLLLLLL","RRRURRRRRRUURRRRUUUWWWWWWDUWWWWDU","DLLLLLLLDDDLLWLUURWUWWDLWWWWWWRUULWLUUWWLWUUWUDLUDU","LLULULLLLLLLDDDDLLLDDDDDDDDDDDWWWWWWWWWWWWWWWWWWWLR","LWURUURRUUUUUUUUULLULULLULULUURWUUULLLUULULWULLUUUULULLUUULUUU","RRRRDDDDDDDDDDDDDRWWWWWWWWWWWWWWRL","RDDWDWDLDDDLDLDWDDLDLDDDDD","RRRRRRRRRRRDDDDRRRDRDRDRDRDRDRDDRRRRRRRRRRDDDDDDRDDDRRWWWWWWWWDU","LLLLUUULLUUURRRUUUUUUURRRRRUWUWWRWURURWURURUUDRRUWR","RRURRURURRUUUUUUUUUUUUURUUUU","ULUUUUURULUULULWWLLLULUUUULULULURUUURUUUUUUUULULULUUUUUULUURURUUURRRRR","DRDRRRRRRRURWWURUUUUURUUUUUUULLLLLLUUUUULUUWLLLLLLLULULLLLDLLDDLLDLLLDLLLLD","RURRRRDDDDDDDDDDWRRRDRRDRDDRDRDRRDDRDDDDDDDDRRDDDD","LLLLUUULUULLULULLULLULULLLDLLLLLLLLLLLDDDDDD","LLLLRULULUUUUWLDLLWLUUUULUUULLLUULUUUUUUUULULUUUU","URUUULULULULLDLDLDLLLLDD","LLDWLLLLDDDDDDDDLDDDDDDDWWWWWWWWWWWDWUWWWDWUWDWUWDWUWWWUDWWWWWDU","LDLLLLLDWDLULUWWDDWWUWDLUURWDDRULLWURWDWWDUWWLRWWWWWWWRL","RDRRRRRRRRRRDDRRDDDDDDDDDDDDDDDDDRDDDDDDDDDLDDDDLWWDUWWRL","UULULLLLLULLLLULULLULUULUUUULURURUUUUUUUURRUU","UULULLULUUULUUULURURURULRRWLUURRUDWUWUDDRRRRRRDRDRRU","UUWUUUUURRRRUURURUUWWDUWWWUDWWWWWWWWWWWWWWWWDUWWDUWWDWU","LLLLLLLLLLULLUULULULLULUULLULULULUULULLULLUUUUUUUUUUUUUU","RDDDRRRDDRDDWDULWDDDDDLLDDDDDDDRRRWRRDRDRDRDDDRRDRRRRRUWRRDRRUURRRRRR","URRRRRRRUURRRRRURUUWDURURURUUUULUUWWWWWRL","RDRRRRDDDDWRDDDDDDDDDDDDDRDRDRDRDRDRDRDRRDRRRRRRRRDRRRDDDDDDDDRRDRDRRRRRRUU","RURURURURURUURRURUUUUUURUUWWWWWWWWWWWWWWWWWWWWWWLR","RRRRRDDDDDRDDWDDDDDDDDRDLDDDLDD","DRRDRRDDDDDDD","RRRRRRRRRRRRRRRRDDDDDRRDDDDDDDDDDDDDDDRDDDDLDDRDDDD","DDDDDDDDDDDDDDRDRDRDDDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWDRRWLDURU","RRRUUUURRUUURWRRRRRRRRRRRUUUUU","DDDDDDDDDDDDDDDDDDDDDD","RRRRRRRRRDDDDRDRDRDRDRDRDRDRRDDRRRRRRRRUURUU","LUULUUUUUUULUUUU","LLLDWLLLWLLLLLLDLLLLLLLULLULUULLULULUULULULLULLLLLLLLLUUULLUUUUU","LLLUUURLUUUUU","DDDWRDDDDRDRDRDRDRDURRDRDDDRRRRRRRRRRRDDDDDDRDDDRRRRDRRRRRDDR","RRRRRRDRRRRRRRRDRDDRRRDRRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLDUR","RRRRDDDDDDDRDDDDDDDRRDRDDRDRDRRDDRDDDDDDWDDRRRDDDRRRDRDDDRRDRRRRRDRDRRRRDDDDRDRDDDRRRRRRRRU","LUULUUUUUUUUUUUUUUUUULL","UUUULUUUUUUUUUUULLLLUUUUUWWWWLR","RRRRRRRRD","UUUURWWWLWRWLDWLDUWRDWWLWWWLLUDWRRRWLWRWLRWLR","RRURRRRRRURRRRDRRRU","RRDRDRRDDDRDRDRDRDRDRDRDDDRRRRDDDDD","LLLLLDDDLDDDLLDDLDLLLDLLDDDDLLLLLLDLLDDDDDWWWWWWWWWWWWWRL","URRRUURRRRUUUUURRURURUUURDRRRRRRRRD","RRRRUUUURRRRRRUUUUUURU","RRDDDDDRWDRRDRRRRRRDRRURRRRRDDDDDRRDWWWRLWWWWWLR","LLLLLDLLLLDLLDDLLLLDLLDDLLDLLDDDDD","RRRRDDRDRDRDDLLDLDLRWWWRLWWWWWWWRLLR","WWURRRRRURRRRRRWUUUUUUUUUL","RRRRRRRRRRRRRRRRRDDDDDRRDDD","LLDDDDDWWLR","LLLLDDDRWUDLDDLLLLLLLLLLDLLDDLLLDDDDDD","WRRRDRRRRRRRWRRWLR","RURDRRRRRRRDRRRUUWURRRRUUUWDRRWURURURURUURRRRRRRUURUUUR","RDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLR","RURWURURURURRRRRDRDDLLDDLDLLDDDLDDDLDLDDLLLLDLDDLDLRLL","RRRRRRUUUUUUUUUURUUURRRRUUUWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWRL","LLLLULLUULLLLLDLLUWWWWDUWWWWWWUDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUD","LLUUUURRRRRURUURURURWURURRRRRRRRDDDR","LWLLLLLLLUULLLLLULLLLLLLLLUUUUURUUURLLWUWURWLRLULLLLULLULLULUUUUUULULULLLLLLDDLLLLLDDDDDDD","URURURRRRDDDDDLDLLDDLDLDLDLDLDLLLLLDDDDDLDLDDDDD","UULRUUUWLURWWWRLUDWLRWWRWLULDRWWWRLRL","LUULUULLUULUULUULLLLLUUULLULULLULULLULLLDLLDDLDDD","RRURURUWURUDRRRRRRRRRRRRRRRDDDDDDRDRRRRRDDDDDWWRL","RUURURRRRRUWWDRURURUWRURURUURRRDDDDRRWDDDRDDRDD","LLRDWWWLRLRLWRLRWLRLWWWRLWWWWWWWWWWWRLWWWWWWWWRWL","LLLLUULULULLULUULLULULUUULLULLULLLLLLLLLUULUULLUUWWWWWWWWWWWWWWWWWWWRL","DDDDDRRRRRRRRDDDDRDRDRDRDRDRDRDRDRRDRDRRRRDDDDR","RRRRRRRRDDRRDDDDDDDDDDDDDDDDDDDDDDDDD","LUULWWUWWULULLLUULUUULLULULLULULLRLULLLDLLLULLLLLLD","UUURURRUUUUUUUUULWUUDUWLUULUUULUUUUUULLLUULULULLUL","RRRUUWRRRRRRRRRUR","LLULLLLULLLLUUUUUULWULULLULUULLULUUUUUUUUUUU","DDDWDDDDDLDRDRDRDDRDRDRRDDWLRWWWLRLRWWWWWWLR","DLLDDDDDDDDLDDDDDDDDD","RDUUUUUWRRLUDUUUULULULLULUULULLURUWLUWUUURUUUURUUUUULULULUUUUUULUURURUUURRRR","RURUUULULUULLUUUUULUULUUUULLLUULUULLLULULLULULLULLLDLLLULLLLLD","UURRURURRRRRRRRRURRUUUUURRRRRURUURURURURUURRRRRDDDDRDDDLDDDDLDLDLDLLLDDD","RRRRRRUUUUUUUUUU","LLLLLLLLULLLLLUUUUUULWWULULLULUUULUUWUUUUUURUUUUUUUU","LLDDLLLLLUULLLLLWDDD","LLLUUUULLUUUWDRDRDDWLWWLRRULLUWDDLWULWUUULUU","LLLDLLDDDDDDDLDLLDDLDLDLDLDLDLLLLLLLULUULLULLUU","LLLLLLLUUUUUUUUULRWWWWWWWWWWWWWLRWWLRWLRWWLR","LLDDDDDDDDDLDDLLLDDDDWWWWWWWWWWWWWWWLR","DDDDDDDDDDDDDDDDRWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWDU","DDDWDDRDRDDRDRDRRDDRDWRRRDDD","RUUUUUUUUUUULULULLULUULULLULUULULULLULLLLLUUUUUUUUUUUUUUUUULUUULWWRRLL","WDDDWRDWDDRDRRDRRRWRRRURRRRRRDDDDDLDUUWRDDDRDRRDLRWWWURDDRRRRDDDRRDRRRRRDRDRRRUUUURRRRUUU","RDRRRDDDDRRRDDDDDRRRURWWLDUR","URRRUUUUUUURRRURUURUURRRRRRRRRRRRRRRDDDDDDDDRRDRRUUL","RURURURUURRURURRRRRRRRRRRUUUUUURRRRRURUURURURURURRDURRDDDDRRDDLDDDDLDLDLDL","DDDDDDRDRRR","RRRRRRRRRRRRDDDDDDRDDDDDDDDWLRWWUDWWWWWWWWWUDUDWWWWWWWWWLDUR","LDWDDDDDDDDDDDDRDDLDDDDDDLDDDDDDLDLDDRRDDRRDRDRRRRU","RRRRRRRRRUURRWLRWWLDRUWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWLR","RRRRRRRRRRRRDRRRRRRRRRRRRRRRRRDDDDDRRR","RUURRRUURDWURURRRRRRRRRRRRRDWDDDDDDDRRRRRRRRDDRDRDD","RRDDDRRRRRRRRDDDDRDRDRDRDRDRDWWDRRRWWLWRWWDU","RRRRRDDRDDWDDDDDDDDDDDDDRDRDRDRDRDRDRDRDDDDDDDDDDD","WUWWWUDWWRUDDUWLWWWRWULDWWRWWLWWWWDUWWDUWWDUWWWWWLR","RDLRDRDRDDDDRRRRDDRRDLLRLDLUDUDWWUUWWLLL","LLLLLLLLLLUUUUUUUULLULUUUUUUUUUUU","LLLLLLLLLLLUUUUUUU","LULULUUU","RRRRRRRRRRDDRRRDRDDDDDDDDDDDDDRRRDDDRDDRRRDDRD","LLUWLLUULLLLLDDDDDLDDDDDDDDDLDLDD","RRRRRRRRDDDDDDDDDDDDDRDDDDDLLDLLDDDLDDD","LDDRDDDDDDDDDDDDRDDLDDDDDLDDDDDDDLDLDDRRWWWLRWWWWWWWWWWWWWWLR","DRDRDRDDRDDDDDDDDWDU","RRDDRDRDRDDDRDDDDDDDDDDLDDDLDDDURRRDRDRDRDRDRDDDRRDRRRRRURRDRRUUL","DDLLLLLLUUUUWLUUUURUUUUUUUUUUUUULUULULUUUUUUULLULUULULLLU","LLLLLLLLLLDDLDLDLDLDDULDRLLLLLLLLUWUULLLULULLULUUUUUULLLDLLLLLLLLLLDLDDD","RRRRRRRRRRRDDDRDRDRDRDRDRDRDRDDRRRRRRRRRRDDDDDDRDDLR","LULDLDDRDDDDDDDDRDWDDDWLRWWUWWDUDWUDWUWWDWUWDUDWUD","RRRRRDRRRRRRDDDDRRDRDRDRDRDRDRDRRDRRRDWRRUDWWWWWWWWWWWWWRL","RRRRDRDRDDRDRDRRDDDDDWDDDDDRDRUURDRWDRDRDDURDRWLLURDRDDDRRDRRRRRDRDRRRRRRUU","DLLLLLULLLLUUUUUUUUUUUUUWWWRL","LLLDLLDWWWWWLR","LLLDDDDRDRDRDDDRDDDDDDDDDDDDDDDRDRDRDRDRDRDDDDDDDDLDDDDD","RRRRRRDDRRDDDDDDDDDDDDDDDDRDDDWUDDLDLDLLDDDDLLLDLDDDD","LLLLLULUUULLLUUULLLULULLULUUULWLRLL","RRRDWDRWWWWWWWWWDLURWWWWWWWWDUWWDUWWWWWWWWWWWWWDUWWWWWDUWWDU","LLLLLLLLLDLWLLLLLLULWWWWWWLLLULUULULLULUULULULLULLLUUUUULUUUUUU","RURURURUURRRWRURRRRRRDDDDDRRDRD","LUUULLUULWUWDWWWWWUDWWLRWLRWWWLRWWWWWWLRWWWWLR","LUURRRRRURULDRWUUWLWLDRWDRWWUURURURURURURRRDDDRDRDDDLDDDDLDLDD","ULLULLLLLLLLLLUULLLRULWWWWDRUL","ULLULUUUULLLLLLLDDDDDLDDDDDRRDDDWDRRDDRDRDDLDDDLDDDDDDDRRRDR","UUUUUUUUU","RRRUUUUURRRRRRURURUUURURRRRRRRRRRDDDDDDDRRRRDDDDRDDDRRRRDDRRDDDDDRRRDDDRRU","RUUUUUULULULLULUULLULULULUULULLULLLLLLLLLUUL","LLUUUUUUUUULULULLUUUUUUUURURURUURRRU","LULLLLLLLLLLLLLLUUUUUUUUULULULLUUUULLLLULUUUUUUUUU","UURUUUUURURRURRRRRRRRRUUUUUUURUUURRURRRUULLLLLLULUUULUUUUUUULLLULULLLDLDLDDLD","RRDDRDDDDRDRDRDRDRDRDRDRRDDRRRRRRRRRRRDDDDDDDDWWWWWWWWWWWWWULRDWWWWULLRRDWWULLRRD","LLLLUWULUUUUUUULUULLULLULUUUUUULLLUUUULULLLUUUUUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRL","UUUUUUUUUUUURRUUUUUUUU","LLLLLUUUUUUULULULLUUUUUULUULUULULLLUULUUUUUUUU","LLLLLLULWULLLDLDDULDDURULDDURWURURULWWWWUUDRLDDLDLDDLLLLDLLLDDDDRDRD","RRRRRRRRRRURRRRRURRRRRRRRRRRRRRRDDDDDDDDRRR","LLLLULLLLLLUUUUUUUU","RRRRDDDDDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRL","DDDDDLDRDDDDDDDWWWRL","LLULLUUUUUUUUULLLULLUULLLUUUUUWLUULLLUULULLLDLDLDDLLLLDLLLLDD","LLULUUUUUULU","RLURRUUURRRRRRUUUWRRRUWWWWWWWWWWWWWWWWWWRL","LLLULLULLLLUUUULLWDUDLRLLLLDLLDDLLDDDDLDDLDDDDDDDDLDDR","RRRRRDDDDRDWRRRDRWRRWDRDDDDRDDRRRRDDRD","LLLLLDDWLLLLLWDLDLLLLLLLULLULUULLULULUULULULLULLLLLUU","WURRRRUUUUUUUUURRUURRRRUUUUUURURUUURURDRRRRRRRDDRRRRRRRRRRD","LDDDLWDLLDLDLDDLLUWDRLUWWWWDLRUUWRUUWUWLLLULWWWWRUULLULLULLULUUUUUULULULLLLLUULLUU","LLLLLLLDDLDLLDDLDLDLDLDLDLLLLLLLULUULLULUUUUU","RRRRRRUUUUUUUR","RRRRRDDDDD","LLLDLDDDDWDDDRDRDRDDDRDDDDDDDDDDDDDDDRDRDRDRDRLUWWWDDDDRDD","RRRRRRRRUURURURUURRRRRRRRRRRRRDDDD","LLLLLULLLLLDDDDDDRDRDRDDDRRDRDR","URURUURRURURRRRURRRRRRRUUUUURRRRRURUURURURURURU","WDWLLDRDDDRDRDRDRDDDWUDRWRRDRDDDRRDDLWWWWWLRWLWR","UULULLLDLDLDDLLLLLDLLLDDDDLDDDWLLLLLDLLLLLLLLLLDLDLDDDDDDDLD","RRUURRRRUUUUURRRRRUUWWRUWLWLUDRWWRRURURUUURRRRRRRRRRRRRDRDD","LUUUUUUUUUURRRRUUUUUUUUUUURRRRDRRRRRRRR","LLLLLLLLLLLLLLLULUDULLLDLLLLLLLLLLLDDDDDDDDWWWWWWWWWWWWWWWWWWRL","RRDDDDDDDWWWUDWWWWWUD","LLLDDDDWLDDDDDDDRRDDLDLDDDDLLLDDDLLLLDLLDLDLLDLDDLDDDDWLLLLLL","ULULLUUUULUUU","RRRRRRRRRUUU","RRRRRURURURRRUUUUUUU","RRRDDDDRRDRDRRRRUUU","UUUULUULUUULLLLLUUULLULULLULWLLLUDULLLDLLDDLDDDD","LLLLU","RURRUURRRRRRRRRRRRRRRRRRDDDDDDRRRDRDDDDDDDDDDDDRRRDDDDRDDRDRRU","LLDDDDDDRDDDDDDDDDD","UULLLLLLUUURWULUUURRRRUUUUUURURUUURUUDWRDRRRRRRDRDRRRRRRRRRDDRD","LLLDWLWDDDLDDLDLDLDDLLLWWWWWWWWWWRLWWRL","RRRUUUUUUULULULLULUULLWWRUDLUUDRDLWWWWWWWWRUDWUDL","DWDDDDDWDRDRRDRRRRRRDRRURRRRDDDRRLDURLDDRRRDDDRRRDRDDDRRDRRRRRURRDR","LLLLLLLLLLUUUUULLUUUUUULUUUULLLULULULLUUUULLLULUU","RRURUUUUUUUUUUUUUUUUWWWWLR","LLLLLLLLLUUU","LDDLDLLDDDDDDDDDDDDDDDD","RRRUUUUUULUUU","LLLLLLLLLLDDLDLLDDLDLDLDDDDDDDDD","LLULLULLLLLLLUUUUULULLLLLUUULLLLLLLLDDDDDLLDDDDLDDLDDDRDRDD","LLLLDDDDLDDWWWWWRRLLWWWWURDLWWWWURDL","RRRRWUUUURUULWUUWWLUUWWDLLWULLULUULUULURUUULUURUUUUUUUULULULLUUUUUUU","RRRRRUURURURURURRRRRRRRRDDDDDDDDDDDDDDD","RRDDDDDDDDRRRRDRRRRRUU","DDRRRRU","LUUULUULUUWLLLLLLLUUUUWWWWWLRWWWWWWWWWWWWWRL","LLULLUWWWWWWWDWURLDWLRWUWWDUDWWRULDRUL","LLDLLLLLDDLDDLDLLLLDDDWWWWWWWWWWDUWWWWWWLRDU","LLDLDDDRDRDRDRDRDRDRDRRDDRRRRRRRRRRRRRRR","RWRLUUWURUWURUULUULLLULUUUUUULUUUUUULURRRRRDRRDLWWWWWWWWWWWWWWWWWWURDL","LLLLWULUUULLLUUULLLULULLULULUUULLLLDDDLLDDLLDLLLDDDDLLDD","RRUURUUUUUUUUUUUUUUULUUUUUUULUULLU","LLLLLLLLLLULLLDLDLDDLLLLLLLLLULULLUULLLLLLU","RDDDLDLDUDDLWLLLLLLUUWWWWWWDU","DWRWLLDLLLLDLLULLWUDDWWDLWDLDUWWWWWWWDUDRULDDLLLLDLLLDLDDDDD","RRDDDDDDDDDDDDDDRWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWDUWWWWWWWWLRWWWWWWWWLRWWWWWWLR","LLLLLDDDDDDDDDDLDDDDDLLLLDDLDLDLDDDDD","RRRRRRRRUUUUUUUUURUUUUUUUUUUURLULUUULUUUWUULLULUUULUUUUUUURUU","UUWDURR","LDLDLDLDLDLDLLLLLLLULLULUUULUULLLLUULULLULLLLLLLLLUUULWWWUDWWWWUD","LLLLLUWUUUUWRLUUUURRRUUUUUUUUUUUUWWWWWWURLD","DRDDRRDDDDDDDDDDDDDDDDDDRDDLDLDLLDDDLLDLDLDLDDD","RUUUUUUULUUU","RDRDRRRRUUUUUUUUUUULURUUUUUUUUWWWUDWUD","DDDDDDDDDDDDDRDDDDLLDDDDLDDDDDRDDDD","RRRRRRRRRRRRRRRRDDDDDDDRDDDDRDDDDDDDDDDLDRDDDDDDRDDDRDDLDDDDDDDLDLDDRDRDDDRRRRRDD","LLLULLULUULUUUUUURUUUUUUURRRRD","RURUURUUUUUUUUUUUUUUULUUUUUUULUULLD","RRRRRRUWRURRRRRURWRWDUURWLDURURURURURRRRDDRRDDDRRRRDDDRRR","DRRRDRRRRRRRRR","RRRRRRRRRRRRRRRRUUUURRRRUUWRUWRRURURURURURRRRDDDDWLRWWWLR","DRDRDRDRDRRDDRRRRRRRRUUU","LLWDDDDLLDRRRDDDDDDRWRDDWRDDUDDDDDWLDDDDLDDDRRRRDDDWUWDDRRRRDDDDRDDLDDDDLLLLDDDLLD","RRRRRRRRRRRDDDDDDRRRDRDDDDDDDDDDDDDRRDDDDDDRDDDDDDDD","LLLDDLLLLLLUUULRUUUUUURUUUUUUUU","LLLLLLULULLULUUULLULULLULL","UUUUUULLUULUULUULLLDDLDLDDLLLLLLLLDDDLLLLLLLLD","LDDD","RUUUUULRRRUUUWRWWULLWWWDRUDWULDRULWWWDRULWWWRDUL","LLLDDDDDDDDLDLDLDLLLLLLUL","RRRWRRRRDDDDDDDDDRDDDDDDDDDDDDD","RRURRRURUUUUUUUUURUUUULUURUWWWWWWWRL","RRRRRRRRRRRDDDDDDDRRDDDDDDDDDDDDDDDDDDDDDLDLDLDDDDDWWDLLDDDDLDL","RRRRRRRRURRRUWWWWWWWLR","RRRURURRRRRDDRRDWRRDRDRDRDRDRWRRDWDDDRRRDDDRDRRRRDRRRDD","RRRRRRRRURRRRUURRRRRRRRRRRRRRRRDDDDDDDD","LDDDDDDLWLLLLLDLLLLLDWWWWWWWWWUDRLLR","ULULLLLLLUULLUUUUUDWUWDUDUWWWWWWUDWWWDUWWWWWWUD","UUURRUUUUUURRRUURRUURUUULUULULUUUUUUUULLLUULUUUUUUUUUUUU","DLDLDDLLLLLLULLLLLLLLLLLLUUUUUUULUUULLLULUULLULLULULUUUUUULLUULLUUUUUU","RRRRRRDDRDRDRDDDDWWWWWWWWWWWWWWWWWRLWWRLWRL","ULULULLULUULLULULULUULULUUU","RRRRRRRRDWDDDRRRDRDDDDDDDDDDDDDRRRRD","LULLLLULLLULLULLLUUUUULUULLLWLLLUUULLULLULUULULULLULLLLLLLLLUUULLULUUUUU","LLLUUUULUUULLLUUUUULULWLULULLLDLWWWWWWDLDUDDLLLLDLLLLULULULLUULLLL","RDDRDDDDDDDDWWWWWWWWDUWWWWDU","DDWDDDWRDDDDDDDDRDDDDLDDDLDLLDDDLLDLDLDLDLDLLLLDDDDDDDDDDD","URRURWWDDWRLWWWRWLWWWWWLR","LDDDDDRDRDRDDDRDDDDDDDDDDDDDDDRDDDDDD","LLLLLULULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWULRDWWURLD","DLDLDLLLLLULULLULUULLULULULUULULLULLLUUUUULUUUUUUUUUUUUUU","LLLLLLULLULLULURDLRLULWLLDLLLLUDWWWWUD","RRUUUURRRRRRRWRDWWWWDUWWDU","RRRRRRRRRRRRRDWWWWUD","LLUUU","LLLLLLLDDDDDDDDDDDDLDDDDDDWDDDLDLDLLLDDDDDD","DDDDDDDDDDDDDDDDDDDDDDLDLLDDLDLDLDD","UUWULLULULLUUUUUWUUURURURUWWWWLR","RRRRRDRRDRRDRRRURDRRRRUUUUUURUUUULUUWRUDLULULLLLDLDLLDD","RDWDDLLDDDLLLDLRWDUWDWWUWDWWWWWWWWUDWWWWWWWWWWWWWWWWWWUDLRWLR","LDDDDDDLDLLDDLDLDLDLDLDLLLLLLLULLU","RRDDDDWRWDDDDDDLDLDDDLLLDLDLDDDDDD","RDWRRRDWDDDDDDDDDDRRRRRDDDDDDDDDDDWWWWWWWLR","R","LLLLULULULLULUULLULULUULULULLULLLLDD","RRRRDRDRDRDRDRDRDRRDRRRRRRRRURRRRRRRUURRUUUURUUU","LLLLLLLUUUUUUUUU","WLLLLLLLLULLLDLLLLLLLULLULUULUUUUULURRUU","RURURURURURRRRRRRRRDDDDDDDDDRRRRRDDDDD","DDRDDDDDRULDDDDDDWDDLWRUDRWWLWWWWLRWWWWWLR","RRUUWUUUUUUUDURWWUUWLWWLWURUWLWWDLWUUULLLUUWLUULLLUUUUULLUULLLLLLLU","LLLDLDDLLLLLLUULLUUUURUUUUUUUUUURUUURRURRRUULLLLUUUUULLUUUUUULLLLLULULLUULUUUUUUUUU","LLLDDDLLDLLWDWDLLLLLWWWWWWWWWWWWLRWWWWUWDWWWWDUWDUWWDUWWWWUDWWWWWDU","LLLDLLLLLLLDDLDDLLLDDDDDDD","RRRDDDDDRDDDDDDRDRDDRDRDRRRDDDDDDDDRDRDRDRDRDRDDDWRRRRRDDDDDD","RUUUUUUUUUUUUWRURUULRRLULUUULUUUUUUURUUULUUULULULLLLLLUULULLLULLULULLULUULLLLLLLLLLLLLDDLL","LLULLULULUULLLLDDDDDLLDLLDDDD","RRRRRRRRRRUWRRWWRRRRRRRURULRURURURURURUUUU","RRDDRDDDDDDDDDDRDRDDRDRDRRRWRRRUD","RRRRUUUUUUUURUUUURUULULULUUUUUUULLULUULULLLUUUUULL","RRRURURUURRURURRRRRRRRRRRDDDDRDRDRDRDRDRDRDRRDRRRRRRRRDRDDDDDDDD","RUUUUURUULLLULULLULUULUUUUULURLUURUUUUUUUULULULLUUUUUUUURURUUURU","ULUUUUULUUUUUWWWLRWWWWWLRLRWWWWWWWWWWWWWWWWWWWLRLRWWWLR","LLLLLLWLUUULLLLLUUULLULULLULULUUULLLLLLLLLLLLLLLLLD","DLLDDDD","LLLLWULLUUULLLLWLLLLWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWUD","LLLDDDDDLDDDLLDDLDLLLDLLDDDDLR"]},"empty_but_not_empty:21":{"makespan":8,"moves":98,"lb":{"makespan":6,"moves":68},"starts":[8,15,11,14,5,17,1,19,22,3,20,4,24,18,0,2,6,10,16,12,23],"goals":[16,11,8,20,0,17,2,18,4,19,24,23,21,12,3,15,22,9,5,6,7],"paths":["WLWLWDD","DWUWUWR","DLUWRRRU","DDLWLLL","U","WLDWUR","DUR","LRDWUL","WURRUUU","RDLWDRD","RRURDR","DLDWDD","WLLWLUD","URWULLD","RRR","DLDDL","DWDRWD","UWRDRRUR","LUU","WWWUWL","WURUULL"]},"empty_but_not_empty:22":{"makespan":8,"moves":102,"lb":{"makespan":6,"moves":66},"starts":[22,6,1,19,15,12,8,11,21,5,24,4,0,23,20,17,16,7,2,3,18,14],"goals":[0,3,1,9,14,23,8,19,20,2,10,11,16,22,17,4,21,15,13,6,24,12],"paths":["LUULUU","RURLR","","UWDWUU","RRRWRU","LLDRRRD","WURDWL","LURDDRRR","L","RRUDU","LUUULLLD","DLLLDLR","WWWDRDD","LRLWRWL","UWRRDWU","RUUUR","RDL","DLLD","RRDDL","RDDLULL","RD","LL"]},"empty_but_not_empty:23":{"makespan":9,"moves":129,"lb":{"makespan":6,"moves":65},"starts":[3,11,17,5,16,4,21,1,15,20,24,8,9,13,14,7,2,12,22,19,0,18,23],"goals":[7,18,15,16,23,9,24,19,20,2,17,4,6,14,0,11,21,3,10,13,1,12,22],"paths":["WWDLUD","URDDRRLUD","RRLULDLL","DRLRDWUD","RRDWWUD","WWWDUWD","LRWWRRR","LRRRDRDD","RLD","UUUURR","LWRWUDULL","LURRLWR","LWLLWDU","RWWWUDLR","UWWLLLLU","DDLLWWWUR","LDDDD","LRDRUUU","LULUWWWUD","WDUWULUWD","DWRLUR","UWWLLR","LWWWUD"]},"empty_but_not_empty:24":{"makespan":13,"moves":168,"lb":{"makespan":6,"moves":66},"starts":[6,21,1,12,13,4,22,5,7,8,14,9,24,10,0,19,17,23,11,15,18,2,16,3],"goals":[1,7,4,3,13,23,24,20,8,2,11,21,22,15,5,12,6,19,9,0,10,18,17,16],"paths":["UDULRWDUWLWR","WWURUUWLR","RLLDUWRRRR","WURUWDUWDU","DUWUDRWDUL","DDWLDDRL","WWRRWWUD","DWDWD","RURDWWLWRL","ULWWDUWDU","LLULLRDWUUWDD","DDLDLL","WWULDL","DWDWRUL","WWDDWUUWWDDWU","WLLULR","LWUWUDDWUWULR","WWRUWLDUR","ULRURRRDUD","DWRULUUWWRLU","LWDLULUWWWRWL","DRURWWDDLD","UWRURDWWDL","RDWDWDLLL"]},"empty_but_not_empty:25":{"makespan":13,"moves":194,"lb":{"makespan":6,"moves":88},"starts":[14,15,8,0,20,23,12,5,11,19,17,13,21,9,22,3,4,2,10,16,18,7,1,6,24],"goals":[0,2,20,7,14,23,4,13,6,17,21,5,9,12,8,1,3,11,24,22,19,16,15,18,10],"paths":["DLUULULL","URDUWRUU","RWLLDDLLD","WWDRWRRWLWLR","UURRRRUWLDR","LLRLRWRWWWWLR","RRUDUWU","WWDWWRRRRULD","UWWUWLDRWWDU","DWUDULLDUURDL","LLWRDWRLRWWL","UWLUWLLD","LWWUWURRRRU","DDULDUDLLRU","UWRRUDUWULLR","WWWRLWLL","WWWDUWL","WWLLWDDRWLWR","RRDDRWR","DUDLWWRULRRWD","WDRLRWU","DRLDLLDWRWWU","WWLDWRWRDLDL","RWURDWDDWWWDU","LLRULLLUWDWU"]},"small_tree_1:5":{"makespan":20,"moves":78,"lb":{"makespan":16,"moves":44},"starts":[3,6,18,24,7],"goals":[26,29,14,17,27],"paths":["DDLRWLDDLRRWLUD","DDDRRRWWLUURUURRDDDD","DRRUWDLLUDRRUU","RRUUWDDLLRRUURUURRDD","LDDUDDUUUDDDRRR"]},"small_tree_2:5":{"makespan":26,"moves":105,"lb":{"makespan":12,"moves":37},"starts":[11,3,22,8,29],"goals":[25,2,30,24,13],"paths":["WLRLDLRUULWRDDWDUUULLDLDDD","LWWRRDRWWLWDLWWWWWRUULL","WUUUDDUULLWRRDRLULLDLDDDLD","LDDDLWRUUURURRDDUULLDLDDDL","ULUWDWWUUUWDDDWRLUUULLDLD"]},"small_tree_3:5":{"makespan":28,"moves":97,"lb":{"makespan":15,"moves":27},"starts":[4,19,11,14,27],"goals":[17,32,23,30,29],"paths":["LLDDLRUWWDLRLDLRURUURRDRD","URRWLUUWWDDRWWLUURRDRDDDLLLD","DDWWWUULULLDDLDURUURRDRDD","WUDLDLDD","RRWWWUUULULLDDLRUURRDRDDD"]},"big_tree:10":{"makespan":133,"moves":759,"lb":{"makespan":104,"moves":511},"starts":[54,324,47,93,243,281,213,135,288,226],"goals":[131,174,335,286,0,140,332,182,373,114],"paths":["UURRDDRLUUWDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDUUUULLLLLLUULLUURRRRDWDRRRRUUUUUDDDDDLLLLUULLLLDDR","UULLDDDDRRRRRRRRUULLUUUULLUUUURRDDRRWLLUURLDDRRRRDDDDRRRRRRUUUUUULLLLWWWWWWWWWWWRRRRDDDDDDLLLLLLUUUURLDDDDRRRRRRUUUUUULLLL","WRRRRRRRUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDUUULLLLLLUULLUURRRRRWRLLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDRRRRUUR","LLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWRRLLLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUURRDDRRUU","RLLUUUULLUUUUUURRRRRRRRRRRRRRUULLLLLLLLLLLLLL","RDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDLLLLLLLLLLLLLLDDDDD","LLLLLUWDRRRRRLLLLLUULLDDUUUDWUDDDDDRRDDDDRRDDRRRRUULL","RRRUUUULLUWDRRUWDLLUULLDDLWRUURLDDLLLLLLLLLLLLLLDDDDDDRRD","DDRRDDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRUURLDDLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRUULRDDL","DUUUURRDDRRRRDDDDRRRRWLLLLUUUURLDDDDRRRRRRUUDUUUUULLLLLLUULLUURRRRRLDWWWWWWWWWWWWWWWWWURLD"]},"big_tree:20":{"makespan":162,"moves":1354,"lb":{"makespan":82,"moves":526},"starts":[288,34,136,216,170,45,371,248,246,51,302,204,296,295,247,174,10,326,328,96],"goals":[335,202,373,284,358,108,367,336,186,56,292,49,50,169,354,12,114,214,371,98],"paths":["DDRRDDRRRRUURWLDWURWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWLLRDWDUUR","DLRUULRDWULRDDLLLLLLLLRRRRRRRRUULRDDLLLLLLLLLLLLLLDDDDDDRRDD","LLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLUDRRR","LLLLLLLLUULLDDDDRRDWULLUUUUUWWWWDDDDDRRDDDDRRDDLLLLLLLLUUUURRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDU","LLLLDDDDRRDDDWUUUDDWUULLUUUURRDDRRWWLLUULWLDDDDRRDDDDRRDDRRRRUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDUDUDWULWWWRWDURLLRRRDDRRU","RRRRRRRRRUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLRLRLRLRLDUUULLLLUURRRRRRD","LLLLWWWRRRUUUDDDWUULLUUUULLUUUURRDWWULLDDDDRRDDDDRRDDLLL","DDDDRRDDRRRRUULRRRWWDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWLLDURR","UUUWDDDRRDDDDWUUUDDWUUULLUUUURRDDRWWLUULLDWDDDRRDDDDRRUWDLLUUUULLUUWWWWWWWWDUUUUDD","RWRRUURRDDWWWWRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLUDUDUDUDUDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUUDULLUULLLRRRDD","DDDRRRRRRRRUULLUUDDWUUUULLUUUURRDDWWUULLDDWDDRRDDDDRRDWDLWRUULLUUUULLUWWWWWDUUUURRDDRRRRDDDD","DDLLUUUULLUUUUUURRRRRWRRRRRRRRRUURLDDLLLLL","LRRRUUUUUULLLLRRRRDDDDDDLLLLLLUUUULWLLLUURLDDRRRRDDDWUUULWLLLUULLDWWWWWWWWWDUURRDDRRRRDDDDRRRRWRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDLLLL","LLLUUUULLLLUURWWWWWWWWWWWWWWWWWWWWWWWWWWWRL","RDDDDRRDDRRRRUWDWUWURLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLWWWRWWLRWLRWWRD","LLUULLUWDRRDDRRRRRRDDDDDDLLLLLLUUUURLDDDDRRRRRRLLLLLLUUUURWLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLL","RRRRRRDDRRDDUUUUWDDDDDDLLLLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDRRRRUUUUUDDDDDLLLLUWWWWDRRRRUUUULRUWDDDDDUDLLLLU","LLUULLDDDDRRRRRRRRUULLUUUULLUUUURRWWLLUWWDUWDRRDDRRRRRR","RRDDRWRRRUULRLLRRLRLRDDLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRLDDLLLLLRR","LLWRLDDRRRRUUUUUWDLRDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUULWLUULLDURRDDRRDDWWWWWUUUWWUWDDDD"]},"big_tree:30":{"makespan":603,"moves":7934,"lb":{"makespan":117,"moves":1462},"starts":[292,213,134,174,293,288,334,48,330,14,236,320,88,44,161,209,364,41,188,281,260,91,93,306,182,202,214,282,18,3],"goals":[87,60,7,96,98,1,92,213,329,342,206,247,42,214,198,120,95,102,160,360,204,335,15,215,138,161,125,164,126,176],"paths":["UUDDRRRRRRUUUUUULLLLWRRRRDDDUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLLWLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRWRWRWRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDWDDDRRDDDDRRUWDLLUUUULLUUUUUULLLLUURRRRR","LDDDDRRRRRRUUUUUULLLWRRRDDDDUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLWLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRWRWRDDLLLLLLLLLLLLLLDWWWWWWWWWWWWWWWWWWWWURRRRRRRRRRRRRRUULLWLWLRRWWRRDDLLLLLLLLLLLLLLD","RRRRWLLLLUULLLLDDRRWWDDRRRRRLLLLLUULLUURRRRDDRRRRUUUULLUULLDWWDWWWLWLLRLRLRLRLRLLWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWRLRWRLRLRLWRUURRDDRRDDDDLLLLUURWWLDDRRWLLUULWLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUURWWWLDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLLLLLL","LLUUDDRRRRRRDULLLLLLWRRRRRRDULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLLLWLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRWRWRWRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLUWDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDURR","RRRRRUUUUUUDDUULLLLLWRRRRRDDUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWWWDWLLRLRLRLRLRLLWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWRLRWUDUDUDWUURRDDRRDDDDLLLLUULWLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUURWWLDDRRWLLUURRWWWLLDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUWWWUUUDDDWWWWWWWWWWWWWWUUUWWUWWWWWWWWWWWWWWWWWWWWWWWWWDWWUWWWWWWWWWWWWWWWWWWWWWWDWWUWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWDUDWWWWWWWWWUDDDD","UULLUUUURRDDRRRRDDDDRRRRRWLLRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDUDUDUDUDUDDWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDURWRLWRDUDUDWUWDDRRUWWWWWWDLLUUWDDRRUWWWWDLLUULLLLLLLLLLLLLLL","DDLLLWLUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUUDDUURRRRRWLDDRRRRUUUULLUULLDUDUDUDUDUDUDUDUDUDUDURRDDRRDDDDLLLLUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDUUDRRDDRRRRDDDDRRRRRRUDLLLLLLUUUULRLRDDDDRRRRRRUUWDDLLLLLLUUUULWWWWWWWWWWWWWWWWLRRDDDDRRRRRRUUUUDDDDLLLLLLUUUULLLLUULWLUWDUUWLRLRLRWDUDUWLWLWRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRWWWWWWWWWWWWWWWWWWWRRDDRRRRUUUULWLRLRLRLRLRLRLRLRLRLRLRLRLUDRWRLRLRLRLRLRLRLRLRLRLRLLRRUWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWDUDDDDDLLLLUDUDUDUDUULL","RRRRRRUURRDDRRDDDDLLLLUULLLLDDRWLUURRRRDDRRRRUUUUUWWWWWWWWWWWWWWDDDDDUUUULWLUULLDWDWLRLRLRLRLRLRLRLRLRLRLRWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUUDUDUDUDUDUDUDUDULRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRL","LWWWWWWWLUUUULLUUUURRRWLLLRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWDUDUDUDUDUDUDUDUDUDUDUWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLRLDDDDUUUURLDDDDRRDDDDRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRUWWUWUWUWDDDDLLUUUULLUUUURLDURWRLLDUUDDDDDRRDDDDRWWWWWWWWLUUUULLUUUUUDUDDURLDDDDUUUURLDDDDRRDDDDR","RRDDRRDDDDLLLLUULLLLDDRRDDRRLLUULLUURRRRDDRRRRUUUULLUULLLWWWLLWLLLWLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRWRWRWRRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDRLUDLLLLLLLLU","ULLLWLLLLLWRRRRDDDDRRRRRRWLLRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDUDUDUDUDUDLWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWWUDURRLRLRWLWRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDWWDWWWWWWDWWRLRWRWDDDDRRDWDWLWWLWRWRRLUULLUUUULLUUUWDWWWWUURLDDWWWWWWWWWWWWWWWWWWWWWWWWUURWWWWLUWUDDDDWUUUWUDDDD","UURRDDDDRRRRRRRRUULLUUUULWWLUUUUUDDDDDRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLUUUUUDDDDDRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLRWDWDDDRRDDWRWWWRWRRUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDLLLLUUUWDLLUUUULWWWWWWWWWWWWWWWLUUUUUDDDDDR","LLLLLLDDRRRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLRLRLRLLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRLRLRLDDLLLLLLLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRRRRRRRUURWWRWDUWDULWWLDDLLLLLLLLLLLL","RRRRRRRRRRUURRDDRRDDDDLLLLUULLLLWRRRRRRWWWWWWWWWWWWWWWLLLLLRRRDWDWRRRRUUUUUWWWWDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRL","LUUUUUURRRRRRRRRRRRRRUURRDDRRDDDDLLLLWWRRRRUUUUUWUWWWWWWWWWWWWWWDDDDDUUUUWUWWWWDDDDDDLLLLUULLLLDDRRDDRRRRRRDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDDDLLLLLLUUUULRDDDDRRRRRRUUUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDDDLLLLLLUUUURWWLDDDDRRRRRRUUUUUWWWWWWWWWWWDDWDDDLLLLLLUUUWURLLRDDDDRRRRRRLLLLLLUUUULWLWWWWWWWWWWWWWWWWLRRRDDDDRRRRRRUUUDDDLLLLLLUUUULLLLUURWRWLWRWWLLDDRWLUULWWLUWUWDDRRDDRRRRRRLLDDDDRRRRRRUUUUUWWWWWWWWWWWWWWWWWWWULLLLLLUULLUURRRRDDRRRRUUUULRLRLRLRLRLRLRLRLRLRLRLRLLRRUWWWWWWWWWWWWWWWWWWWWWWDDDDDLLLLUULLLLDDRRDDRRRLLLUULLUURRRRDUDUDUDUDUDUDUDUDUDULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURLDDDDRRRRRRUUUUU","RRRDDDDRRRRRRUUUUUULLRRDDDDDUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRWRDDLLLLLLLLLLLLLLDDDDWWWWWWWWWWWWWWWWWUUUURRRRRRRRRRRRRRUULWLWLRRWWRDDLLLLLLLLLLLLLLDDDD","RRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURLDURRRRDWDRRRRUUUULLUULLLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRDDUULWRDDRRDDDDLLLLUURWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLRR","RRRRRRRRRRRRRUURRDDRRDDDDLLLLUULLWRRDWWDRRRRUUUULWLUULLDWDLLWWLWWWLWLLRLRLRLRLRLLWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWRLRWRLRLRLWRRRRUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLRLRLRLRLDUDWDWDDRRDDDDRRDWDLWRUULLUUUULLUUUUUUDDDUUULLLLU","DRRRRDDDDRRRRRRUUUUUUDDDDDDLRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRDDLLLLLLLLLLLLLLDDDDDDWWWWWWWWWWWWWWWWUUUUUURRRRRRRRRRRRRRUURWRLWRLLDDLLLLLLLLLLLLLLDDDDDD","WRDDDDRRRRRRRRRWLWRLLLLLLLLLUUUULLDDDD","DRRDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRWRLLRRLRLRWLLWLRLRRRLDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUUDDLLUUUULLUUUUUURRRRRRRRRRRRRRUULWLRRDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUU","LDDRRDDRRRRRRLLLLLLUWDRRRRRRLLLLLLUULLUURRRRDDRRRRUUUULLUULLLLWLLLWLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRWRWRWRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDRRRRUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDURLDDLLLLLRRRRRUUR","RDDRRWLLUURWLDULLLLDDRRDDRRRLLLUULLUURRRRDDRRRRUUUULLUULLDDLWWLWWWLWLLRLRLRLRLRLLWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWRLRWRLRLRLWRRRUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLUDUDUDDWWDUDWDWDRRDDDDRRUWUWDDLLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUUDUDUDUDUDUDUDUDUDUDUDUDULRDUDUDUDUDUDUDUDUDUDUDUDULRDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWULRDUDUDUDUUDLLUUL","DLLUULLDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRL","ULLUUUUUURRRRRRRRRRRRRRUURRDDRRDDDDWWWWWWWUUUULWLWUULLLWLWWWLLWLLLWLWWWWWWWWWWLWWLWLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRWRRRWRWRWRRRRRRRDDRWLUULLDURRDDRRDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUUDDULRDDDDWWWWWWWWWWWWUUUULLWUDUDUDUDUDUDUDUDUDUDUDUDUUDDWRLRLRLRLRLRLRLRLRLRLRLUDRWRLRLRLRLRLRLRLRLRLRLRLRLWWRLRLRLRLWLRRLRLRLRLRDDDD","UULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDDDRRUUUUDDDDLLUUUULLUUUUUURRRRRRRRRRRRRRUULRRLDDLLLLLLLLLLLLLLDDDDDDR","LLRLDDDDRRRRRRUUUUUULRDDDDDDUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWDLRLRLRLRLRLLWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWUDUWUDUDUDWURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDWWDWWWWWWDWWDUDWRWRDDDDRRUWUWUWDDDLLUUUULLUUUUUULWRDDRLUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLR","WDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLRWWWWWRLLWLRLRRRDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUUUDDDLLUUUULLUUUUUURRRRRRRRRRRRRRUURLDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUUUU","DDDDDDLLLLUULLLLDDRWWRDDRRRRLLLLUULLUURRRRDDRRRRUUUULLUULLDDWWLWWWLWLLRLRLRLRLRLLWLWLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWRLRWRLRLRLWRRUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDWWWWWWDWWDUDWDWRRDDDDRRDWDWRWRRRUURLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRRLLDDLLLLUULLUUUULLUUUUDUDDUUUDRLUUWWWWLR","RRRRRRRRRRRRRDDRRDDDDLLLLUULLLLDWURRRRRWWWWWWWWWWWWWWWLLLLLRRRRRWRWLWLLLLLDDRRDDRRRRWWWWWWWWWWWWWWWWWWWRRDDDDDDLLLLLLUUUULRDDDDRRRRRRUUUUDDDDLLLLLLUUUURLDDDDRRRRRRUUUUUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDDDDDLLLLLLUUUULLLLUURWLDDRRRRDDDDRRRRRRUUUUDDWDDLLLLLLUUUURWRLLDDDDRRRRRRUDLLLLLLUUUURWLRLRLRLRLRLRLRLRLDDDDRRRRRRUUUUUWDDDDDLLLLLLUUUULLLLUURWLLWLUWUDUDUDWDUDUWUWLWRDDRRDDRRRRRLDDDDRRRRRRUUUUUULLWWWWWWWWWWWWWWWWWWWLLLLUULLUURRRRDDRRRRUUUUUWWWWWWWWWWWWWWWWWWWWWWWWWDDDDDLLLLUULLLLDDRRDDRRRRWWWWWWWWWWWWWWWWWWWWWWWWWLLLLUULLUURRRRLRLRLRLRLRLRLRLRLRLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULRDDDDRRRRRRUUUUUULL"]},"big_tree:40":{"makespan":776,"moves":16090,"lb":{"makespan":115,"moves":1806},"starts":[102,326,220,80,350,85,135,134,218,328,49,160,238,83,7,300,78,98,51,374,186,248,88,132,246,333,174,367,152,236,128,242,164,3,131,330,243,294,373,360],"goals":[126,222,286,161,87,45,41,218,370,78,326,160,252,176,204,42,202,281,338,247,368,92,34,167,166,124,373,132,294,40,5,240,170,9,58,184,88,188,186,356],"paths":["DRRRRWDDRRDDRRRRDWDDDRRRRRRUUUUUULLLLLLRRRRRRDDUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWWWDWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWUWULLLLLLLWRWRRRWWWRWRWWWWRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRUWDLLUUUULLUUUURRRWLLLRLRLRLRLRLRLRLDURWRDWDRRRRDWDDDRRRRRRUUUUUULLLLLLUULLUUWDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLWLUULLDDDDRRDDDDRRUUUUDDDDLLUUUULLUUUUDUDUDUDUDUDUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWLRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDUUUDDRRLWWLRLRLRLRLUU","LRUDLLUULLDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLWLDUDUDUDURLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRWWWLDDUURLLRRLRWLRWLDURLRLRWWLDURLRWLLRRWLDULRLRLRLRWLRRWWWWWWWLDUDDUURLDUDURLWDWWULRLRDDUDLLLLLLLLLWLLLLLDDDDDWDRRDDUULLUUUUUURRRRRRRRRRRRRRUULWLRRDDLLLLLLLLLLLLLLDDDDDDRRDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUULLUUUUUURRRRRRRRRRRRRRUURLDDLLLLLLLLLLLLLLDDDDDDRRDDDWWWWWWUUULLUUUUUURRRRRRRRRRRRRWRUURWRLLDDLLLLLLLLLLLLLLDDDDDDRRDDD","DDDRRRRLLLRRRDDRRUU","DDDUUUUURRRRRRRWRRRRRRRUULWWWRDWURRDDRRUDLLUULLDDLLLLLLLLLLLLLLDDDDDDRWWWWWWWWWWWWWWWWLUUUUUURRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLDWDUDUDUDUUWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLDDDUUUWRWRWRLWWLLDURWRWRLLLDURWRLWWWRLLDURWRWRWRWWRWRRRRRRRRLLRLLRRRLLRLRRLWLWWRRWRWLLRLLLLLLLLLLWLLLDDDDDDRWRDDDDUUUULLUUUUUURRRRRRRRRRRRRRUULRRLDDLLLLLLLLLLLLLLDDDDDDRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLUUUUDUUURRRRRRRRRRRRRRUULRDDLLLLLLWLLLLLLLLDDDDDDRWWWWLUUUUUURRRRRRRRRRRRRRUURWRLLDDLLLLLLLLLLLLLLDDDDDDRWWWWWWWWWWWWLUUUUUURRRRRRRRRRRRRRWUURRWDULLLWRDDLLLLLLLLLLLLLLDDDDDDR","ULLUUUULLUUUUDURRDDRRRRDDDDRRRRRRUUUUUUDDDDDDLLRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWUDUDUDUDUDUDUDUDUDUDUDUDWUDUDUDUDUDUDLLLLLRRRWRWRWUDWWLLLRRWRWUDLLLRRWRLWWWRLLLRRWRWUWURWWRDWWWWWWWUWDWDRRDUWDWDDUWWDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLWLLUULLDWWDDDRRDDDDRRUWWWWUWDDLLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUDRLRLRLRLRLRLRLRLRLRLRLWUDUDUDUDUDWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRRUWWWWWWWWWWWWWWWWWWDDDDDLLLLUWDRRRRUUUULLUULLLRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRWLLLLUULLUURRRRDWDRRRRUUUUUWWDDDDDLWRUUUULWWLUULLLWLRWWLLWWWWLRWWWWWLRRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLDUUDRLUULRDDRLUULLLLUURRWRRR","LLLDDRRRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLRRRRDDDDUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRRWRDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDUDUDUDUDUDWWWULRDDRLWRRLRDUUWDWUUDUDUDWDWUUDUDDLRUWDWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUWDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLLWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWLRLRLRLRLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWRWWWWLWLRRRWLRRDDLLLLLLLLWRRRRRRRRUULWLRWWLRRDDLLLLLLLLLWWWWRRRRRRRRRUURWRLWWLDDUURWRWDUWWWLWLDDLLLLLLLLLWWWWWWWWWWWWWWWWWWWWRRRRRRRRRUULWWWWLRWWWWWLRRRWRDDRRUWDLLUULLDDLLWRRUURWRWDWUWLLDDLLLWRRRUURWRWDUDDRWRLLUULRLRLRLLRLDDLLLLLLLLL","RRLLLUULLLLDDRRDDRRRRRRLLLLLLUULLUURRRRLLLLDDRRLLUURRRRDDRRRRUUUULLUULLLWWWWWLLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRWWRRWWLLRWLWRLRRWRWWLWLWRRWRRRLRWLLRRWLWRWDWDWRWRWWDDWWWWWWWUWDWDDLLRWLWLLRWWLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLWLLUUWLLUWUWWLLWWWWWWRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDURWWLDDRRRRUUUULLUUWLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLWLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRDUDUDUWWDDUWDWRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURRWRLLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLDDLLLLLLLRRRRRRRUULLWWWWLRWWWWWLRRRDDLLLLLLLLLLWRRRRRRRRRRUULWLRRLRDDLLLLLWRRRRRUURWRLRDDWRLUULLRLRLRLDDLLLLLLLLLLLLL","UULLRRRWLLLLLDDRRDDRRRRLLLLUULLUURRRRDWULLLLDDRLUURRRRDDRRRRUUUUUWWWWWWWWWWWWWWWWWWWWWDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUURLRLRLRLRLRLRLRWWLLRDDRRRRDDDDRRRRRRUUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDDLLLLLLUUUURWRRWWWRWWWWDWWWWWWWULLLLDDDDRRRRRRUUUUWWWWWWWUULLLLLLUULLUURRRRDWUDUDWDRLUULLLLDDRLUURRRRDWDRRRRUUUULLWUULRDUDUDUDUDUDUDUDUDUDUDUWLRLRLRLRLRWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDDWWUDUWWDRLWRWRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWWLWLLUULLDWDDDRRDDDDRRUDLLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDDLLLLLLUUUURRWWRWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWULLWLLDDDDRRRRRRUUUU","DDDDLLLLRRRRUUUUUUDDDDDUUUUULLLLLLUULLUDRRDDRRRLLLUULLUURRRRDDRRRRUUUULLUULLDWWWDLWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRUULLLLLWRWRRRWWWRRWRDUWWDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDRWRWLLLWRWWWWWWWWWWWWWWWWWWWUUUWDDDWWWWWWWRWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLWRUDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLWWWWWWWWWWWWWWWWWWWWWWWWWUUUDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWRRRUULWWWWWWWWWWWWWWWWLRRDDLLLLRLRLRLLR","UUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLRRRRRDDDUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRWWWLLRRDDUWDRLRWLRWLWRRLRLRDWWWWWWWDWUWWWWWWWDWDWDWLWWLLWWWWWWWRWLWLUULWWWWLLRRWLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWWLLLWUURWWWWWWWWWWWWWWWLWDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRLRLRRWLLWLLLDDRRDULLUURRRRDDRRRRUUUULWLUUDDUDUDUDUDUDUDUDUDUDUDUWUDUDUDUDUDWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDRWWLRLWWRRLWRWDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWRRWRLLLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUWDDDLLWRRUUUUUUDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDLLLLUURLDDRRRRUUU","RRRRRUURRDDRRDDDDLLLLUULLLLDDUURRRRRWWRWWWWWWLLRWRWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLLDDDDRRDDDDRRDDLLLLLLLLUUUURRDDRR","WWWUUUUUURRRRRRWRRRRRRRRUWURRDDRRDDDDLLLLUULLLLRRRRDDRRRRUUUULLUWULLLLWLWWWWWLLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRWWRRWWLLRWLWRLRRWRWWLWLWRRWRWWLWRLLRWRWRWLRLRLRLRWLRWLLLLLLLWRWRRRWWWRWRWWWWRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUURLDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLWRRDDRRRRRRDDDDDDLLLLLLUUUURWWWWRWLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUWUDUUDUDDUUDWUWUWWWWWWWWWWWWWWWWWWDDLLUULLDDWUURWRWDULLDDLLLLLLLLLLLLLRRRRRRRRRRRRRUURLDDLLLRRRUULWLRRDDLLLLLWLLLLLLLLLDDDDDDWWWWUUUUUURRRRRRRRRRRRRRUURRWDULLDDLLLLLLLLLLLLLLDDDDDDWWWWWWWWWWWWUUUUUURRRRRRRRRRRRRRUULWWWLRWWWLWRWRDDLLLLLLLLLLLLLLDDDDDD","DDDLLLLLRRRRRUUUUUDDDDDUUUUUULLLLLLUULLRRDDRRRRLLLLUULLUURRRRDDRRRRUUUULLUULLLLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRWWRRWWLLRWLWRLRRWRRRLRLRWWLWRDUDWULRDWUWDWDWRWRWDWWDDWWWWWWWUWDWDLLLRWLWLUWDWUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLWLUULWLUUWLWWLLWWWWWWRRRDDRRDDRRRRDDWWWWWWWWWWWWWWWWWWWWDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUUUWDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRUDLLUUUULLUUUURRDDRRRRRLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUURWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWWRWRDWDUULLLLDDWWWWWWWWWWDDRRRRRRUUUUUULLLLLLUULLUURRRRRWLLLLLDDRLUURRRRRLLLLLDDRRDDRRRWRRRDDDDDDLLLLLLUUUULLWRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLLLUULLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUURRDDRRRRLRDD","LDDRRRRDDRRDDRRRRRWWLDDDDRRRRRRUUUUUULLRRDDDDDDUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWDLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWUWWURRWWWWWWWLWRWDDRRLWRWDDUWWDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWLLLUULLUUWWWWWWDDRRDDRRRRDDDDRRRRRRUUUUUULLWLLLLUULLUURRRRDDUULLLLDDRRLLUURRRRRWWWLLLLLDDRRDDWUULLUURRWLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWLLLUULLDDDDRRDDDDRRUUDDLLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLWWWWRRDDDDDDLLLLLLUUUULRLRLRLRLRLRLRLRLRLRLRLRLRLRLLLWLWWUWURWWWWLDWDRRRRLRRRLLDDDDRRRRRRUUUUUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDDDDDLLLLLLUUUURWWRWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLLLWLDDDDRRRRRRUUUUUULL","RRRRRRWRDDLLLLLLRRRRRRUURLRRDDRRUWWDLRDWDDDLLLLUDWRRRRUUUULLUULLDDLLLLLLLLLLLLLLDDDDDDUUUUUURRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWDUDUDUDURWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLDDUURWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRRRRRRRRLLRLLRRRLLRLRRLWLWWRRWUWDLRLLLLLLLLLLWLLLLDDDDDDWRRDDDUUULLUUUUUURRRRRRRRRRRRRRUURLDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDLLUUUULLUUUUUURRRRRRRRRRRWRRRUURLDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUU","URRDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRLLLRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRLDWDUDUDUDUULWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRDDLRUULLRWLWRLRRDDUULWLWRRDDUULWRLLRWRDDUURWRWDWDWWRRWWWWWWWLWRWDDDDUWDWLLRWWLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWWWWRWWWWWWWLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWLRLRLRLRLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWRWWWWLWLRRRRLDDLLLLLLLLLLRRRRRRRRRRUURWRLLLRDDLLLLLLLLLLLLRRRRRRRRRRRRUULWLRRDDLRUULWLWLRRRLRDDLLLLLLLLLLLLWWWWWWWWWWWWWWWWRRRRRRRRRRRRUURRDDWRLUULLLRDDLLLLLLLLLLLLRRRRRRRRRRRRUURWRWLWLDDLLLLWRRRRUULWLWLWWWLRWWWLWRWRWRWWRDDLLLLLLLLLLLL","ULLUUWDDRRUDDDDDLLLLUURLDDRRRRUUUDDDLLLLUULLLLDURRRRDDRRRRUUUULLWUULLLWLWWWWWLLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRWWRRWWLLRWLWRLRRWRWWLWLWRRWRWWLWRLLRWRWRRWRWDWDWRWWRDWWWWWWWUWDWDDDLRWLWLLRWWLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWLLLUWULLDWDDWWDRRDDDDRRDWWDLWLRLWLLLLLLUUUURWRLLDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULWRDDRRRRRRDDDDDDLLLLLLUUUULWLLLUWULLUUWWWWDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUWUWUDUWWDDUWDWDLLLLUULWWLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWLWWLWLUULLUWUDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLDURWWRDDRWRLLUULLDDLLLLLLLLLLLLLRRRRRRRRRRRRRUULRDDLLLLLLLLRRRRRRRRUURLRRDWDUULLDDLLLLLLLLLLLLLLDDDDDDRRDD","DDLLLLUULLLLDDRRDDRRRRRLLLLLUULLUURRRRRWWWWWWLLRDWDRRRRUUUULLUULWLDWWWDWLLLLLWWWLLWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLDURRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRRRRRRRUDLRLLRRUDLRLRUDWLWWRUWURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLWRRRRRRUUUUUULLLLLLUULLUURRRRDWDRRRRUUUUUWWWWWDDDDDLLLLUULLLLDDUURRRRDDWRRRRUUUUUWWUWDDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUUDURLL","RRRUURRDDRRDDDDLLLLUULLLLDDRWLUURRRRDDWUULLLLDDUURRRRDDRRRRUUUULWLUULLDWDLLLLWWWLLWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRRRRRRUUDDUDLRUUDDUDUUDWDWWUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUWDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLWLLWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWLRLRLRLRLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWRWWWWLWLRRRWLRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDRRRRUUDUDUDUDUDUDUDUDULRRRLLDURRDDRRUU","LLWLLUULLUUUULWLUUUUUDUDUDUDUDDDWUUUDDDDDRWWWRDDDDRRUDLLUUUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDDDRRUDLLUUUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDDDRRDWDWWRWRWRWRWLLLLUULLUUUULWWWWWWWWWWWWWWWWWWWWLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUWDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLWUULLUWWWWDDDDDRWWWWWWWWWWWWWLUUUUUWWWDUDUDUDUDUDRLDDDDRWWWRDDDDRRDULLUUUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDDDRRUWUUUDDDDUDLLUUUUL","DWUURWRRWWWWWWLRWWWLWWWWWWWRLRRLLLWWRRLLLDDDDRRDDDDRRDDLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLLUUUULRDDDDRRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRLWLLLLLUUUULWLWUWDUDUDUDUDDURRDDDDRRRRRRRRUUDWWWWWWWWWWWWWWWWWWWWWWWWWWUDUDWWUDDRLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLLUUUURWWWRLLDDDDRRRRRR","LLUUUURRDDRRRRDDDDRRRRLRRRUUUUUULLLLLLUDRRRRRRDULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWUULLLLLLWRWRRRWWWRWRRRLWWRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDWDRWLUULLUUUULLUUUUWUWDUDUDUDUDUDUDUDRRDDRRRRLRRWRWWLLDDDDRRRRRRUUUUUULLLLLLUUDDRRRRRRDDDDDDLLLLLLUUUULLWLLUUWRWWWWWWLDDRRRRDDDDRLWRRRRRRUUUUUULLLLLLUULLUURRRRDWDRRRRUUWUWUDUWWDDUWDWDDLLLLUURRWWWWWWLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLDDRRDDRRRRRWLLLLLUULLUURRRRRWWWLLLWWWWWWRRRRWLLLLWWWWWWWWRRDWDUULLWLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLLLDDDDRRRRRRUUUUUULLLLLLUULLUURR","LLLLLLDDRRRRDDRRDDRRRRDDDDRRRRRRUUUUUULRDDDDDDLRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRRWRWDWDRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRWWWLUDRRDUWDWWWDUWWWWWWWWWWDWWWWWWWDWUWWWWWWWDWDWLWLWWLLWWWWWWWRWLWUURWLWRWWWRWWWWWWWWWWWWWWWWWWWWWWLWLDDRRRRUUUULLUULLDWWWWWWWWWWWWWWWWWWWWULWLWLRRWWRDWWWWWWWWWWWWWWWWWWWWWWWWWWWDWWUDUDUDUDUDUDUWDLRLRLRLRLRLRLRLRLRLWWRLRLRLRLRLRLRLRLRLRLRLWWWWWWWWWWWWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWUDUDUDUDUDUDUDUDUDLRUDUWULRDWULRRWRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWULRDWWWWWWWWWWWULRRRWWDDRRWUDLLUULWWRWDDRRUUWDDLLUULLDWWWWWULWLWLRRLRWWRDWWWWWWWULWLWLWLWWWLRWWWLWRWRWRWWRWRD","DDRRRRRRDDDWUUULLLRRRDDUULLLLLLUULLUURRLLDDRRDDUULLUURRRRDDRRRRUUUULLUULLDDLLWWWLLWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRRRRUULLWRWRRRDDUWDWRRLWWRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLUWWWWWWDRRRLRWLLWWWWWWWWWWWWWWWWRDWDRRRRRWLLLLLUUWLRLWRDDRRRRDUDWDWDDRRRRRRUUUUUULLLLLLUULLUURWLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLWLLUULLDDDDRRDDDDRRUUUDDDLLUUUULLUUUURWWWWWWWWWWWRLLUDDUDURWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLDDWDWDRRDDDDRRUUUDDDLLUUUULLUUUURWLUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDRWWWWWWWWWWWWWWWWWWWWWWWLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUUWWDUUUDDWWDUUUDUDUDUDDUUDDUR","UWUUUUDRRDDRRRRRWRWWLWWWWLLLLLWRRRRRWLLLWRRRLLLLLUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDRLUDWWDWDUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWWDWDDWWRRDDDDRRUWUUWWWWUWDDDDLLUUUULLUUUURWLDWWWWWWWWWWWWWWDUWURRRWWWLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUULWWWWRDDWWWWWWWWWWWWWWWWWWWWRWRRWLWWWWWWWWWWRLLLRLRLUDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWWUWLRDDWWWWWWWWWWWWWWWWWWWWWRRRWLLLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLDUWWWWWWWWWWWWWWWWWWWWWWWUWWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDRWRRLLWLRWRDUWWLRLRLRLRLWLRLUD","RDDLLLLUULLUUUULLUUUUDUDUDURWRRLLLUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDDUUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLWWWWWWRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDDUUULL","RRRRDDDDDDWUUUUUULRDDDDUUUULLLLLLUULLUUDDRRDDRRLLUULLUURRRRDDRRRRUUUULLUULLDDWWWLLWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRRUULLLLWRWRRRRRLWRWDDUWWDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLRLWLLLLLLLUUUULWLDWWWWWWWWWDUURRDDDDRRRRRRRRUDLRLRLRLRLRLRLRLRLRLRLRLRLRUDUDLRUDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRUURWLRLRLRLRLRLRLRLRLDDLWLLLUDLRUDUDRRR","RRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUDDDDLLLLRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDWLRLRLRLRUWULWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDLLRRUWURRLRWLRWLWRDUDUDWWUWDDUDWUUDDWUWDWRWRWDWDWWDDWWWWWWWUWDWLLLLRWLWUURWWWWWWWWWWWWWWWWWWWWWWLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUWDRRRRRRUUUUUULLLLLLUULLUURRRRRWWWLDDRRRRUUUULLUULLLWWWWWWWWWWWWWRDDUDUDUDUDUDUDUDUDUDWWUDUDUDUDUDUDUDUDUDUDUDWWWWWWWWWWWWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWUDUDUDUDUDUDUDUDUDDUUDULWLRRRRLWRWDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWLLLUULLUDRRDDRRRRRLDDDDRRRRRRUUUUUULLLLLLUUWWWWWWWWWWWWWWWLLUURRRRDULLLLDDRRWDDRRRRRRDDDDDDLLLLLLUUUULWRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLLLRDDDDRRRRRRUUUUUULLLLLLUU","DRRRRRRDDDDWUUUULLRRDDDUUULLLLLLUULLUURLDDRRDDRLUULLUURRRRDDRRRRUUUULLUULLDDLWWWLLWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRRRUULLLWRWRRRRDUWDWDRLWWRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDRWRWRWLLLUULLUUUULLUUUWDWWWWWWWWWWWWWWDUWUURRDDRRRRRWWLLRDDDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLUUUURWWRWWWWRWLLLDDDDRRWWWWWWWWWLWRRRRRUUUUUULLLLLLUULLUURRRRRWRLLLLLLDDRRDDRRRRRRDDDDDDLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWLLUUUULLWLWWLWUULLDWDWDDRRDDDDRRUUDDLLUUUULLUUUURRDDRRRRDDDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLUUUULWWLLWRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLLUURWLDDRRRRDDDDRR","ULLLLDDDDRRRRRRUUUDDDLLRRUUUUUULLLLLLUUDDRRRRRRLLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRWWRRRDUWDDUDWUDWUWDRLRLRWWLWRRLRDWUUUWDWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWDUDLLUULLDDLLLLLLLLLLLLLLWWWWWWWWWWWRRRRRRRRRRRRRRUURWRLWRLLDDLLLLLLLLLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRRRRRRRRRUURLDDLLLLLLLLLLLLLLWRRRRRRRRRRRRRRUULRDDLLRRUURWRLWWWLDDLLLLLLLLLLLLLLWWWWWWWWWWWWWWRRRRRRRRRRRRRRUURRDWDUULLDDLLLLLLLLLLLLLLWRRRRRRRRRRRRRRUURWLDDLLLLLLWRRRRRRUULWLWWWLRWWWLWRWRWRDDLLLLLLLLLLLLLL","UULLLLLLDDRRRRDDRRDDRRRRDDDDRRRRRRUUUUUDDDDDLLLRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWDWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWLLWLRLRLRLRRWRWUWUDUDUDUDUDUDUDUDUDUDUDUDWUDUDUDUDUDUDDLLLLRRRWRWUWUDWWDLLRRWUWUDDLLRRWUDWWWUDLLRRWUWURWRWWDDWWWWWWWUWDWRRDDUWDWDDUWWDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLWLUULLDDWWDDRRDDDDRRUUWWWWUWDDDLLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLRRLRLRLRLRLRLRLRLRLRLRLWLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRDUWLRLWWRDUWDWDDDLLLLUURWWWWWWLDDRRRRUUUULLUULLDULLLLRRRRRLLLLLLLLLL","UUUULLUUUUUURRRRRRRRRRRRRRUURRDDRRDDDDLLLLUULLLRRRDDRRRRUUUULLUUWLLLLLWLWWWWWLLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWRRWRRWWLLRWLWRLRRWRWWLWLWRRWRWWLWRLLRWRWRWLRLRLRLRLWRWLLLLLLLWRWRRRWWWRWRWWWWRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUULLRLRLRLRLRLUU","DDDDLLUUUULLUUUUUURRRRRRRRRRRRRRUURRDDRRDDDDLLLLRWRRRUUUUUWWWWWWUWWWWWWWWWWWWWWWWWWWWWDDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUUDUDUDUDUDUDUDUDUDURR","RRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWRRWRRWWLLRWLWRLRRWRWWLWLWRRWWWWWWWWLRWWWWWWWWWWWWWWWWWWWLLLLLWRWRRRWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRDULLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWLWR","LUURRRWLLLDDRRDDRRRRRRDULLLLLLUULLUURRRLLLDDRRDULLUURRRRDDRRRRUUUULLUULLDDLLLWWWLLWWWLWLLWLWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLRLRLRLRRWRWRWRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLLLLLLRRRWRWRWRLWWLLLRRWRWRLLLLRRWRLWWWRLLLRRWRWRWRWWRWRRRRRUULWRRWRDDRLWRWRDUWWDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWWWWWWWLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWWUDUDUDUDUDUDURLDUDUDUDUDUDUDUDUDUDWWUDUDUDUDUDUDUDUDUDUDUDWWWWWWWWWWWWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDULWWWWWWWWWWWWWWWWWWRRRLRLRLWWRDUWDWDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWRLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLRRRRDDWUULLLLWLRWWLLWWWWLRWWWWWLRRRRRRRDDRRDWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUD","LLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLRRRDDDDDUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRRWRWDDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDUDUDUDUDUDWWWUUDDRRLWRUDUDLRWLWRUDUDUDWLWRUDUDLLRRWLWRWDWDWDWDWWLLWWWWWWWRWLWLLUUDWUWLLRRWLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURRWWWRWWWWRWWWWWWWLLLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLRLRLRLRLRLRRLLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLWLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLDURLRLRLDDLLLLLLLLLLLLLRRRRRRRRRRRRRUULRDDLLLLLLLLLLLLLLDDDDDDUUUUUDUURRRRRRRRRRRRRRUURLDDLLLLLLLWLLLLLLLDDDDDDRRDDUULLUUUUUURRRRRRRRRRRRRRUULRDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUDLLUUUULLUUUUUURRRRRRRRRRRRWRRUULRDDLLLLLLLLLLLLLLDDDDDDRRDDDDRRUUU","LUUUULLUUUUUURRRRRRRRRRRRRRUURRDDRRDDDDLLLLUULLRRRWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUUULRDDRLUULLLLUURRRRRR","LLUUUDDDRRRRRRUUUUDDDDLRUUUUUULLLLLLUULRDDRRRRRLLLLLUULLUURRRRDDRRRRUUUULLUULLLLWWLLLWLWWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWRLRWRWRWRWWLWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRWWRRRRLWRDUDWUDWUWDDUDUDWWUWDRLRWLUDRWLWRWRWDWDWDWWDLWWWWWWWRWLWLLLUDWUWULRDWULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWWWRWWWWRWWWWWWWLLLLLLLUDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRRWWWWRWLWRWWLLLLLLWRRRRRWWRWWWLLLLLLDDRRDWULLUURRRWLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWLLLLLUWDRRRRRLLWRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRRLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUUDUDUDUDUDUDUDUDUDUDUDUDUDURWWWRWRRWDULLLLLLLLRRRRDUDWWDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUUUDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDURWLLLLLUWDRRRRRLLLLLUWWWWWWWWWWWWWWWWWWWWWWWWWWDRRRRDURLLLLLU","LLWLUULLUUUULLUUUWURWWWWWWWRDWWDRRRRDDDDRRRRLLLRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWDLWLRLRLRLRRWUWULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDLLLRRRWUWULWRLRDDLRUWULWRDDLRUWUDWWWUDDLRUWURWRWDWWDRWWWWWWWLWRWRDDDUWDWDLRWWLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLWUULLUWWULWWWWWWRDDDWWWWWWWWWWWWWWWWWWWUUWWWWWUWDUDUDUDUDUDUDUDWDUWWWWDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDRRDDDDRRDWWWWDLLLLLLLLUUUULRLRDDDDRRRRRRRRUULLUUUUDDDDRRUDLLUUUULLUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDWDWRRDDDDRRDWWWDLRUULLUUUULLUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWWWWWWDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUUWWDUUWWDWWDUUWWWWWWWWDUWWDU","UUUURRDDDDRRRRRRRRRRRRUURRDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWULLLRRRD"]},"big_tree:50":{"makespan":1441,"moves":25102,"lb":{"makespan":115,"moves":2076},"starts":[114,320,340,216,92,247,250,328,202,278,220,306,240,12,281,329,354,214,268,198,238,244,48,215,54,288,322,210,260,1,57,342,137,93,90,378,252,96,213,43,161,53,212,170,108,254,10,174,123,242],"goals":[170,51,297,34,306,300,13,376,280,18,130,2,336,161,298,272,132,41,90,140,108,224,78,85,295,169,282,328,1,226,7,373,136,138,368,114,212,377,45,40,120,270,123,200,209,5,83,210,206,325],"paths":["ULLLLDDRRDDRRRRRRDDUWUWWLLLLRRRWLLLLWLUUWWDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDWDDDRRDDLWRRRWRWWLLLUULLUUUULLUUUURRLRLRDURR","UURRDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDWWUULLLWLUULLUUWDDDDWDDWWRRWDWDDDWRRDDWLWLRWLLLWLLWRWWLWLLUUUURWRWWDWWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWLRLRLRLRLRLRLWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRLRUUDUDUDUDUDUDUDUDUUULRDDUWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWWULRLRUDDUDUDUUDDUDUUDDUDUDUUDUDDUUDUDUDUDWUDDUDUDUUDDUDUWUWDUDUDUDUDUDUDUDLLUUDDWRLUUWDWDRRDUWLRLWRUDWLRLRLRLLUUWWDWDWRLUULLRLRLRLRLDULLRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRRLLDULWRDDLLLRRRUURRDULWRWDDUDUDUDUWDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDUULLLLLLUULLUURRRRDDWRRRRUUUULLUULLLWLWLWLWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRDDRRUDLLUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLDDLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRUULRDDLLLWWWWWWWWRRRUURWRLLDDLLLWWWWWWWWWWWWWWRRRUURRWDULLDDLLL","UUWWURWRDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRWLLLUUWLLUULLLWRRWWLWWLLWWUWUWWWRWWWWWWWRWWLLDDRRRRDDRRDDRRRRDDDDRRRRRWWWWWWWWWWWWWWRUUUUUULLLLLLUULLUURRRRRWWLLLLLDDUURRRRDWUDUDULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURLDDDDRRLLUUUWDDDRRRRRRUUUUUULLLLLLUULLUURRRRDUDUDUDUDUDUDUDUDUDUDUDWDRRRRUUUUDUUWWWWWWWWWWWWWWWWWWWDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDUUUUULLLLLLUULLUURRRRDULLLLDDRRDDRRRRRRDDDDDDLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLUUUURRLLDDDDRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLUUUURRRRLLLLDDDDRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWDWUDUDUDUDUDUURRDDRRDDDDLLLLUULLRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLDDRRDDRRRRRRDDDDDDUUUUUULLLLLLUULLUURRRLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWLDDDDRRRRRWRUUUUUULLLLLLUULLUURRRRRLLLLLDDRLUURRRRRLLLLLDDRRDDRRRRRRDDDDDDLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRUUUUUULLLLLLUULLUURRRRRWWWWLLLLRRRDULLLLDURRRRRLLLLLDDRRDDRRRRRRDDDDDUUUUULLLLLLUULLUURRRRRLLLLLDDRRDDRRRRRRDDDDDDLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLUUUURWRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWWWWWWWWRLRLRLWWWWWWRWRWWWWWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWLRLLLRRRLLLLDDDDRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLUUUURLDDDDRRRRR","LLLLDDDDRRRRWLLLLUWDWRWWRRRRLLLWRRRRWUUUWWDDDLLLLLLUUUULWWLLLUULLDDWDWDRRWDDDDRRDDRRWWWRWWRUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDLLLLUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLRLRLRLRLRRDDRRUWWDLLUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLWDWWWWURWRDDRLUULLLWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRRRDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDLWWLWWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWLWRWRLRLRLRLRWUWULRDWWWWURRLWLDWWWWWWWWWWWWWWURRWDULLDWWWWWWWWWWWWWWWWWWWWURRDWDUULLD","LLDDRRDDRRRRRRDDDDWUWUWWUULLRRDWULLLWLLLWWRRRRRRDDDDDDLLLLLLUUUULLLLUULLDWDDDRRDDWDDRRDDLLWRWWLWLLLLLLUUUULWLDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUURRRRDDUULLDURRDDRRU","WLUUUUUDDDUURRRWWWLRWLLLRWRDDRRRRDDDWDRRWWLLUUUULLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUULLDWWWWWWWWWWWWWWWWWWWWWWDWDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUUWWWUWWWWWWWWWWWWWWWWWWWWWWWWWDWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWWWWDUUU","DDDDLLUUUULLUUUURRDDRRRRDDDDUUUWDDDRWRRRWWLLLLUUUULLLLUUWWLLUWWULWWLWLWWWLWWWWWWWUWWDRRRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRUWDUDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWDWWWUWURLDDLRLRWUWWWWWWDUWWWWWWWWWWDWLLWRLRRUWWWWWUDUDUDUDDUULRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRDULWRLLRLDURLLWWWWWWRDWURWRDUDUDUDUWDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDULLLLLLUULLUURRRRDDRWRRRUUUULLUULLDWDWLWLWRLRLRLRLRLRRUURRDDRLWUULLDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWUDUDWDWWWWUUDULWWWWWWWLWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLWLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLLRWWWWWWWWWLWLWLRRRRRRWWWLRWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWLR","UUUULLUUDDUUUURRDDRRRRRRLWWWWWRRWWWWRWLRWWWWWWWDWWWWWWWWDLWWWWWWWWWWWWWWWWWWRUULLLLLLLLWRRRRRRWWWWWWWWLLLLLLUWDRRRRRWRWLLLLLLUULLDDDDRRDDDDRRDDRRRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWLLLLLWRRRRRWUDUDUDUDUDLRUWDLRLRUDUDUDUDUDUDUDUWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDUDUDUDUDUWDLLLLUWWWWWWWWWWWUDDRRRWRLRWWLLLLUWUUDDDRRRRLRLRWLLLLUWUUWWDDDRRRRUURLDURRDD","UULLUUUUUURRRRRRRRRRRRRRUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUULLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDRRDDDDRRRRRRLLLLLLUUUULLUUDWDUDUDUDUDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWWWWDUUUD","WDLLLWRRRUUUDDDLLLWRWRWWRUUUDDDWUUUUWUULWWRDDDDDDLLLLLLUUUULLLLUULLUWUWWWLWWWWWWWLWWRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWLRLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWLWWWRWRWLLLLRLRWRWWWWWWLRWWWWWWWWWWLWLLWRLRRRWWWWWRLRLRLRLLRRRWWRWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWUWDLLRWLWLLLLLRRRRRRRWLWRWUWULWWWWWWLRRRRDDRRDUUU","DWDDRRDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDWULLLLWUULLUULWRDWWUWWLLWWLWLWWWUWWWWWWWUWWDDRRRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUULWWWWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRRRLRLRLRLRLRLRLRLLLLLWRLRWWWRWRRRDDWWUDUWDRWWLRLRLRLUULWWRWDWDUULLLWWWWWWWWRRWWRDDUDUDUDUDUDRRDDDDLLLLUURLLLLLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUURRRRRWRLLLLLLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDRRRRRRDDDDUUUULLLLLLUULLUURRRRRWWWWWLLLLLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDRRRRRRDDDDDDLLLLLLRRRRRRUUUUUULLLLLLUULRDDRRRRRRDDDDDDLLLLLLUUUULLWWWLWLUULLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUWDRRDDRRRRRLRWRRWWWWRWDWULLLLDDDDRRRRRRUUUUUULLLLLLUULLWWWWWWWWWWWWWWWUURRRRDURLLLLLDDWWWWWWWWWWWWWWWWWWWWWWWWWUURRRRRWRLWWLLLLLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDDRRRRRRDDDDDDLLLLLLUUUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRRLRLRLRRLRLRLLRLRLRRWRWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWLRLLDURRLLDDDDRRRRRRUUUUUULLLLLLUULL","DLLUULLDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRWLLLLUWULLUULLWRRWWLWWLLWWLWUWWWUWWWWWWWRWWLDDRRRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLWLRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWLDUDURLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLDURLRLRLRLRLRLRLRLDWWWURWRLLDDUDUWURLRLRLDURLRLRLRLRLDWDLWRLRUULLLLLLLLLLLL","DWDRRDDDDRRRRRRRRRRRRUURRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWRLUWUDUDUDUDUDUDUDUDUDUWWDWUWWWWDUDUDUDUDUDUDUDWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWUDUDUDUDUDDUUWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWWWLLLRRRWWWWWWWWWWWWLLLRRR","RWWRDDUULRDDLLLLWRRRRUULWLRLRRDDLLLLLLLLLLLLLLDDDDDDR","RDDDDRRRRRRWRRUULLUUUULLUUUURRDDRRRRRWLRWWWWWWWRWWWWWWWWRRWWWWWWWWWWWWWWWWWWLLLLDDDDRRRRRRWWWWWWWWWWWUUUUUULLLLLLUULLUURRRRRRWWWWWWWWLLLLLLDWURRRRRWRWWLLLLLLDURRRRRWRWWWWWWLLLLLLDDRRDDRRRRRRDDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUUULLLLLLUULLUURRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLLDDRRDDRRRRRRDDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUUULLLLLLUULLUURRRRRLLLLLDDRRDDRRRRRRDDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLLUUUURLDDDDRRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUUULLLLLRRRRRDDDDDDLLLLLLUUUURRRLLLDDDDRRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLWLWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRDDRRDDDDLLLLUWULLLLDDRRDDRRRRRRDDDDDUUUUULLLLLLUULLUURRRRLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUUWDWDRRDDRRRWWRRRWWWWRWRWLLLLLRDDDDRRRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUUULLLLLLUULLUURRRRDULLLLDDRRDDRRRRRRDDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLLUUUULWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRRLRLRLRWWWWWWLRLRLRWLWRLRLRLRLRLRLRLRLRLLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWLWWWWWUWWWDRRRRLRLRLRLRLRLRLRLRLRLRLRDDUULRRWLLRRLDDUURLDDDDRRRRLLLLUUUULRDDDDRRRRRR","LUUUULLUDRLUUUURRDDRRRRRLDDDUUURWWWWRWLRWWWWWWWRWWWWWWWWRDWWWWWWWWWWWWWWWWWWULLLLDDDWWWWWWWWWWWDRRRRRRUUUUUULLLLLLUULLUURRRRRWWWWWWWWLLLLLDDWUURRRRDWDRRRRUUUULLWUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDULRDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDULLLRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWLLRLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLWRDUDUDUDUDUDUDUDULLLLWRLRWWWRRWRDDRWWLRLWRRDDDDLLLLUUDUDUDUDUDUDUDUDUDUDUDUDUDUDULLLLDDRRDDRRRRRRDDDDDUUUUULLLLLLRRRRRRDDDDDDLLLLLLUUUURRLLLWRDDDWWWWWWWWWWWUUURLDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWUDUDUDUDUDURRDDRRDDDDLLLLUULLLRRRDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDULLLLDDRRDDRRRRRRDDDDDDLLLLRRRRUUUUUULLLLLLUULLUDRRDDRRRRRRDDDDDDLLLLLLUUUURRRWRWLLLLLRDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLLRWWWWWWWWWLWLWLRRRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDRRRRRRUUUUUULLLLLLUULLUURRRRRWRLLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUWWWWWWWUUULWWWRDDDWWWWWWWWWWWWWWWWWWWWWWWDRLUWWWWWWWWWWWUUULWWRDDDWWWWWUUURWWRLWLDDD","DLLLLUULLUUUULLUUUURRDDRRRRLRLWRDDDDWRRRWWLLLUUUULLLLUULWWLDWDDWWDRWRWDDDWDRRDWDRWRRWWWRWWUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWLWWWWWWWWWWWWWWWWWWWRLWWWRLRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWLWWWWWWWWWWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWLRRDDLLLLUULLUUUULLUUUURRDDRRRRLRDULRLRLRLRLRLRLRLRLRLRLRDDDDRRRRRRUUUUUULLLLLLUUDDRRRRRRDDDDDDLLLLLLUUUURWWRRRWDWULLLLDDDDRRRRRRUUUUUULLLLLLUUWWWWWWWWWWWWWWLLUURRRRDULLLLDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLUURRRRRRWWWWLLLLRRRWRLLLLLWRRRDWDUULLLLDDRRWWWWWWWWWWWWWWWWWWWWWWWLLUURRRRDWDUULLLLDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDRRRRRRDDDDDDLLLLLLUUUURWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWWWWWWWWRLRLRLWWWWWWRWRWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWLRLLLRRRLLLDDDDRRRRRRUUUUUULLLLLLUU","LLDDDDRRRRRRLLLLLLWRWRWWRRRRLLLWRRRUWUUUWWDDDDLLLLLLUUUURRWWWWWWWWWWWWWWWWWWLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLRDDLLLLLLLLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRRRRRRRRUURLDDLLLLLLLLLLLLLWWWWWWRRRRRRRRRRRRRUURRLWLDDLLLLLLLLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRRRRRRRRUURLDDLLLLLLLLLLLLL","ULLUUUURRDDRRRRDDUWDWDWWDRRRLLLWRRRRWRRUWWDLLLLLLUUUULLLWWLUULLUUWWLWLWWWLWWWWWWWLWWRRRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWLRLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWLWWWRWUWDLLLRLRWRWWWWWWLRWWWWWWWWWWLWLLWRLRRRWWWWWRLRLRLRLLRRUWWULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDLRWLWLLLLLRRRRRRUWDWUWURRLRLRLRLWRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRLLLLLLUULLUURRRRRWWWRWWWWWLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLLLDDRRDDRRRRRRDDDDDDLLLLLRRRRRUUUUUULLLLLLUULLRRDDRRRRRRDDDDDDLLLLLLUUUULWWWLWLLUULLUULRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLWRWRWDWDRRDDRRRRLRLRRWRWLLDDDDRRRRRRUUUUUULLLLLLUULLUUWWWWWWRRRRRLDULLWRRRWRLWRLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRDWDWRLUWULLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDRRDDRRRRRRDDDDDDLLLLLLUUUURLRLRLRLRLRLRLRLRLRLRLRLRLRLRLDDDDRRRRRRUDLLLLLLUUUURWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWLRLDDUURLDDDDRRRRRRUUUUUULLLLLLUULLUU","ULLLLLRRRRRDDDDDDLWRWUWWUUUUDDDWUUUUWLLLWWRRRDDDDDDLLLLLLUUUULLLLUULLUWWWUWWWWWWWLWWRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWWWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLWLRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLLWWWWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLWLLLWRLRWWWRWRWRWRLRLRLRRRLRLRLRLRLLLWWRRWRWDULLLLWWWWWWWWRWLLRRWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWRRLDWDLLLLRRRRUURRLLLRLRRLRLRLRLLRDDLLLLLLLLRRRRRRRRUULRDDLLLLLLLLLLLLRRRRRRRRRRRRUULRDDLLLLLLLLLLLLLLDDDUUURRRRRRRRRRRRRRUURLDDLLLLLLLLLLLLLLDDDDD","DDDLLWRRUUUUDDDDLLWRWRWWUUUUDDDWUUUUWULLWWRRDDDDDDLLLLLLUUUULLLLUULLDWDDDWRRDDDDRWRDDLLWLLWRWWLWLLLLUUUURWWRWWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLRLRLRLRLRLRLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRRDDDDRRRRRRRRUULLUUUULLUUUURWWWWWRLLUULLLLUUDDRRRRDDRLUULLLLUURRRRRRD","U","RRRRRWRUURRDDRRDWWWDDDLLLLUULLLLDDWUWURRWWLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDWDDDRRDDDDRRDDRWWLUULLUUUULLUUWUURRDDRRWLLUURWLDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRLRLRLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWLLLUULRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRLRLRLRLRLRLRLRLRLRLRLRWDDRRRRUUUDUULRLRLRLRLRLRLRLRLLUUDDRWWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWLUDUDRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLWRRLRLRLRLRLRLRLRLLUULRDWDUULWRWDDRRUWDDWWWWDDDLLLLUULRLRLRLRLRLRLRLRLRLRLRLRLRLRRLDDRRRRUUUWWWDDDLLLLUULWLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUURLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRLRDDRRRRUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDLLLLUURRWWWLLDDRLUURLDDRRRRUUUWWWWWWWWWWWWWWWWWWWUUWWWWWWWWWWWDDWWWWWWWWWWWWWWWWWWWWWDDDLLLLUURWLRLRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWLDDRRRRUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWULRUDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWULWLUULLDDWWLWWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWLWRWUDUDUDUDUWULWLRRRRDDRRUWWWDD","LLLLLLLUWDRRRRRLLWRDWDWWDDRRLLUWDRRRWRRRWWLLLLLLUUUULLLLWWUULLDWWDDWDWRRDWDDDRRDDLRRWWWRWWRRUURRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWDULWLRLRLRLRLRLRLRLRLRLDURWLDUDURLRLRLRLRLRLRLRWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWLRLRLRLRLRRLLLWWWWWWWWWWWWWWWWWWWWWWWWWRDDLLLLUULLUUUULLUUUUDUDUDUDUDUDUDUDUDURWRWDDRRRRDWUDDUURWWWWWWWWWWWWWWWWWWWRLLLLLLUULLDUUULLLLUUDDRRRRDDDUUULLLLUURRR","UURRDDRRDDDDLLLLUURLLLLLDDRRDDRWLUULWLUUWWDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDWDRRDDDDRRUWWWWDLLUUUULLUUUURRDDRRRRRWLDDDDRRRWWWWWWWWWWWWWRRRUUUUUULLLLLLUULLUURRRRRWWWWWWLLLLLDDRRDDRRRRRRDDDDDDLLLWWWWWWWWWWWWWLLLUUWDDRRRRRRUUUUUULLLLLLUULLUURRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLLDDRRDDRRRRRRDDDDDDLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLUUUULWWLLLUULLDUDUDUDURRDDRRRRDDDDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLUUUULWWWWLLLUULLUDRRDDRRRRDDUULRDDDDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWLWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLRUUUUUULLLLLLUULLUURRLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULWLLLUULLUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDULWRWDWDRRDDRRWRRRWWWWRWRWLLLLLRRDDDDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLUUUULWLWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRRLRLRLRWWWWWWLRLRLRWLWRLRLRLRLRLRLRLRLRLLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWLLWUWWWWWUWWWDDRRRLRLRLRLRLRLRLRLRLRLRLRRDULLRRDWURRLLDURRLLDDDDRRRLLLUUUULLRWRDDDDRRR","UULLUUUWDDUUURRDDRRRRDWWDDDRLUUWDDRRWRRRWWLLLLLUUUULLLLUWWULLDDWWDDWRWRDDWDDRRUWWDUWWWWWWWWUWWWWDDLLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUUUDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUUR","UDDDRRRRRRRWRUULLUUUULLUUUURRDDRRRRDWDDDWWUUUULWLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUURLWWWWWWWWWWWWWWWWWWLWLWUUDUWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDWDRRWWLWLRRWWWWWWWLWLUUUUDWDUDUDUDUDWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUUDDUDDURRWRL","LLUULWWRRLLWRRRWWWLRWLLLRWRWWWWWWRWWLWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLWWRRWWWWWWWWLLLLDDDUUUUWUWWDWUWDDUDUDUWUDDDDDDRRDDDDWRRDDRWRRRWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWWDLLLLUUUDLLWWWWWWWWWWWWWWWWWWWRRUDLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUULLUUUURWWWWWWWWWWWWWWWWWWRWDWDRRRRDDWUDDUUWUDUDUDUDUDUDUDUDUDURLLLLLUULLDDUURLDDDDRRDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUULLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUDDUDUDUDUDUUUUUWDDDDDRRDDDD","DRRDDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDWWUUULLWLLUULLUWDDDDWDRWWRDWDWDDRWRUWWUWWDUWWWWWWWWUWWWWDDDLLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLUDRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLUULRDDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWWUUDUDDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDUDUDUDUDUDUDUWDRLRLRLRLRLRLRLRLUULLRRWDULLDUDURRDUDUDUWDDUDUDUDUDUULLWDUDULLLLLLLLLLLLL","RRRRRRRRRRRRRRRDDRRDDDDLLLLUULLLLDWUWRRRWWLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLUWWDDDDWWWWWWWWWWWWWDRLUUUUUWWDRWRDDRRRWLLLUULLDDDDRRDDDDRRDDLRUULLUUUULLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUWWWDUDUDRLDDDWWWWWWWWWWWWUUWDUUUDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDRRDDDDRRDDWLWLRRUULLUUUULLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUURWRDDRRRRRLLLLLUULLDUUDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUURRWWWWWWWWWWWWWWWWWWDWDWRRRRRWWRWWLWWRWWWWWWWWWWWWWWWWWWWRLLLLLLLUULWRWDULLRLRLRLRLRRWWDULLDURLDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUDDUDUDUDUDUUUUUWDDDDD","LUUDDRRDDDDLLLLUULWLLLDDRRDDRRRWLLLUWULLWWRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRWRDDDDRRDDRRRWRWWLLLLUULLUUUULLUUUWWWWWWUDWDDDRRDDDDRRDDLLLLLLLLUUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDDDRRRRRRRRUULLUUUULLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUDUUUDUDUDUDUDUDUDUDUULLRRDUWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWLLRLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLWRDWWWWWWWWWWWWWWWULLUDRWRLLUWDWRRUWUWDWDWUUDWDUDUDDULLUWWDWRWRLLUULRLRLRLRLWRWWDDRLRLRLRLRLRRUWDLLUWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDDUUWDULRLWRDULLRRDDRRLLWRWRUDUDUDUDWUUWWWWDWDLLUULLLLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLR","DRRRRRRRRRLUUUWWWWDLLUUUULLUUUURRRWWLDUDUDUDURWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLWWRRWWWWWWWWLLLDDDDUUUURWRDDRRRRDWDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULWLUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUUDDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUULLRRDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWWULRLRDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDUDUDUDUDUDUDUWDDUDUDUDUDUDUDUDUULLLWRLRDDLLRLRWRWWWWWWLRWWWWWWWWWWLWLLWRLRRRWWWWWUDUDUDUDLRUURRDUDUDUDUDUDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLRRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWLLLUWULWLUUUULLUUUUUDDDDDRRDDDDRRDDRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLWRLRLRLRLRLRUDRRRRWUDUWWDLLLLLRRRRWWWRUDUDUWDLLLLLRUULLUUUULLUUUUUDDDDDRRDDDDRRDDRRR","LWWWWWWWWWWWLLUURWRLWLDDWUURWLDDRRWWLLUURRLWLDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRUUUULLUULLDWURRDDRRLWLWUULLLWLWWWWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLWLRRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLLWWWWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLWLLLWRLRWWWRWRWRWRLRLRLRWRLRLRLRLRLWLWWRWRRWRLLLLLWWWWWWWWRWLLRRWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWRWLWRWRRRLLDURRDDRLUWDWRRLRLRLRLWRUWWWWDDDDDLLWWWWWWWWLLUULRRLDDRRWWWWWWWWWWWWWWWWWRWRUUUULLUULLDWDWLWLWLWRLRLRLRLRLRRRUURRDDUWULLDDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWUDUDWLWWWWRUDUURRWLLDDWUDUDUDUDUDUDUDUWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDULRRRDDRRUDDDDDLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRUUUULLUULLDWWDWWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDLRUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDWUWUDUDUDUDULWLWLRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULRLRLRLRLRLRLRLRLRLRLRLRLRLRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRLRDDRR","WLLLDDRRDDRRRRRRDDDUWUWWULLLRRRWLLLLWLLUWWDRRRRRRDDDDDDLLLLLLUUUULLLLUULLUWWWWWWWUWWDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUUUWWWWWWDLRDDDDWWUUUULWLUWULRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLRRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWULLWWWWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLWLLLWRLRWWWRWRWRRRLRLRLWRDUDUDUDUDULLDWDUDUURLLLLLWWWWWWWWRWLLRRWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWRWLWRWRWRDWDUURRDDUUWDWDRLRLRLRLWRRDDDDLLLLUURWWWLLRDDUULWLRRDDRRRRWWWWWWWWWWWWWWWWWWUUUULLUULLLWLWLWLWLWLWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRWWRRRDDUULLDWUDUDUDUDUDUDUDULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRRRRDDRWLRRDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUUUWWWWWWDDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLUURLDDRRRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLLUURLDDRRRRWWWWLLLLUURWWLRLDDRRRR","DDRRDWDRRRRRRDDDDDWUWUWWUUULRDDWUULLWLLLWWRRRRRDDDDDDLLLLLLUUUULLLLUULLDDWDDRRDDDWDRRDDRWWRRRUURLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLLLWWWWWWWWWWWWWWWWWWWRLWWWRLRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDDLLLLRLRLRLRLRLRLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRLLLWWRRUUUDDDLL","LLUULLDDLLLLUULLUUUULLUUUURRDDRRRRDDWDDRWWLUUUURWWWWWWWWRRWWWWWWWWWWWWWWWWWWLLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDWWWWWWWWWWWWWDRRRRUUUUUWUWWWWWWDDDDDDLLRRUUUUUWWUDDDDDDLLLLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUDUDUDUDUDUDUDUDUDUDUDWRRRRUUUULRUUWWWWWWWWWWWWWWWWWWWDWWWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWDDDDDLLLLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWURWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLLDWWWWWWWWWWWWWWWWWURWRLLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWURLDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWULWWLLLDDRRDDRRRRRRDDDUUULLLLLLUULLUURRRRDWDRRRRUUUULLUULLDWDWLWRLRLRLRLRLRUURRDDRRDDDDLLLLUWUDWWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUULLLLDDRRDDRRRRRRDDDDDDLLLRRRUUUUUULLLLLLUULLUUDDRRDDRRRRRRDDDDDDLLLLLLUUUURRWRWLLLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDWWWWWWWWWWWWWWWDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDRRRRUUUULLUULLLLWLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWLLRWWWWWWWWWLWLWLRRRRRRRRDDRRDDDDLLLLUWULRDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWURLD","UDDDRRRRRRUUDDLLLLWRWRWWRRUUDDLWRUUUWUUUWWDDDDDDLLLLLLUUUULLLLUULLDWDWDDRWRDDDDRRDWDLLLWLLWRWWLWLLLUUUULWLUDUWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDRRDDDDRRRRRLLLLLUUUULLUUUDWDUDUDUDUDWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWURRDDDDRRRRRRRRUULLUUUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLUDRLRLRLRLRLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUUDUDUDUDUDUDUDUDUDUDUDUDUDUDULRDUDUDUDUDUDUDUDUDUDULWRLRLRLRLRLRLRLRLRLLRLRLRLRLRLRLRLRLRLRLRLRLRLRWRLRLRLRLRLRLRLRLRLRLRLRLRDDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWULWWWWWLWWWRRDWWUDUDUDUDUDUDUDUDUDUDWDDDUUUWWDWUWULWWWWWLWWRWRLRLRLRDURRWWRLWLLWWWWWWWWWWWDWDUU","LLLLLLDDRRDDRRRRRRDUWLWWLLLLRRRWLLLLWUULWWRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRWDDDDRRDDRRRRUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWRLDUDUDUDUDUDUDUDUDUDUDDUUWDDUDUUDUDUDUDUDUDUDUWDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDUDUDUDUDURLDUDUDUDUDUDUDUDUDUDUDUDUDUWRLDUDUDUDUDUDUDUDUDULRRLDURRDDR","LDDDDRRRRRRUDLLLLLWRWRWWRRRUDLLWRRUUWUUUWWDDDDDLLLLLLUUUURWWWWWWWWWWWWWWWWWWLDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLRRDDLLLLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRRRRUURLDDLLLLLLLLLWWWWRRRRRRRRRUURWRLLDDLLLLLLLLLWWWWWWWWWWWWRRRRRRRRRUURRDUWLLDDLLLLLLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRRRRUURLDDLLLLLLLLLWWWWRRRRRRRRRUURWRLLDDLLLLLLLLL","LLLWWWWWRRRRRRRRRRRRRRUURWRDDRRDDDDLLLLUURLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUULWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDRRDDDDRRRRRRRLLLLLLLUUUULLUDDWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUWWWWDUUURRDDDDRRRRRRRRUULLUUUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLRRLRLRLRLRLLUUUURRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLDURLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRRLLLRRLRLRLRLRLRLRLDDLLRRUURLDDLLLLLLLLRRRRRRRRUULRDDLLLLLLLLLLLLRRRRRRRRRRRRUULRDDLLLLLLLLLLLLLL","LUUWWUUUURRRRRRRRRRRRRRUULRLRRLDDLLLLLLLLLLLLLLDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUURRRRRRRRRRRRRRUULRDDLLLLLLLLLLLLLLDDDD","RUURRDDRRDDDDLLLLUULLLLDDRRDDRRWLLUUWLLUWWDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDWRRDDDDRRDWDRWRWWLLUUUUU","LLLLUUWRRLLWDWWDRRRRRWRRLWWWWWRRWWWWDWUDWWWWWWWDWWWWWWWWLLWWWWWWWWWWWWWWWWWWRRUULLLLLLLWRRRDWWDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULWLUULLDWDLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWLRLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWLWWWRWRWLLLLRLRWRWWWWWWLRWWWWWWWWWWLWLLWRLRRRWWWWWRLRLRLRLLRRRWWRWRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLWRWLLLRWLWLLLLLRRRRRRRWLWRWRWUWUDUDUDURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRLLLLLUULLUURRRRDWDRRWRRUUUULLUULLLWLWLWLWLWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDUUUULLLLLLUULLUURRRRRLLLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWWLDUDUDUDUDUUULLL","LLLLWUUDDDUUWWWWDWRRDDRRRRDUDURRWWWWRWLRWWWWWWWRWWWWWWWWDDWWWWWWWWWWWWWWWWWWUULLLLLLLLUWDRRRRRWWWWWWWWLLLLLUURWWWLRWWLRLRLLLDDDDRRDDDDRRDDLLLLLLLLUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUWDDRRRRRRRRRWWWLLLLLLLLLUUUULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLUDRLRLUUUU","ULLLLLLDDRRRWWWWRWWDDRLUWUWWWWWWWWDDRRLRLRLRLRLWLDWWWWWDDDRRDDDDRRDDRWLUWUDWDRWWRWRRWWWUWWURWWRDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWDUUWLRLRLRLRLRLRLRLRLRLWWRWLWWWWRLRLRLRLRLRLRLRWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRWLRLRLRLRLRDULWLRLRLRLRLRLRLRLRLRLRLRLRWRLLRLRLRLRLRLRLRLRLRLDDLLLLUULLUUUULLUUUURWRDDRRRRRWWLLLLWWWWWWWWWWWWWWWWWWWWWWWLUULLUWDRWRLLDUDUDUDUDURWWRLLUDRRDDRWWWWWWWWWWWWWWWLWUULLUWULLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLWRWRWRWDWDRRDDRWWWRRRDWDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRDWURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUUDUDUDUDUDUDUDUDURWWWWWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWRLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLLWLWWWWWLWWWRRRRRWWWWWWWWWWWWWWWWWWWWLDDDUUURRWLWRRLLLRRRLLLRLDUDURLRLLWWLLLUUDUDUDUDUDDRRRRRLLLL","RRUULLLLDDDDRRLLUUWDWDWWRRRRLLLWRRRRWRUUWWDDLLLLLLUUUULLWWLLUULLUWWUWLWWWLWWWWWWWLWWRRRDDRRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDDLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRWLRLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWLWWWRWRWLLLLRLRWRWWWWWWLRWWWWWWWWWWLWLLWRLRRRWWWWWRLRLRLRLLRRRWWUWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDWURLDDUWDWLLLLLRRRRRUURLLLLLLLLLL","RRWRRRRDDRRDDDDLLLLUULLLLDDRRDDWUULLWUURWWLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDWDDRRDDDDRRDDLWLLLLLLLUUUURWWLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLRLLWWWWWWWWWWWWWLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDURRDDDDRRRRRRRRUULLUUUULLUUUUDUDUDUUULLLLUURWLDDRRRRDDDUUULLLLUURWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLDDRRRRDDRLUULLLLUUR","RRLLLLRRRRRRDDDDDDWUWUWWUUUUDDDWUUULWLLLWWRRRRDDDDDDLLLLLLUUUULLLLUULLDDDWDRRDDDDWRRDDLWLLWRWWLWLLLLLUUUULLDWDUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUWWWWWWWWWWWWDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUUWWWURRDDDDRRRRLLLLUUUURWWWLDDDDRRRRRRRRUULLUUUULLUUWDUUURRDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLUULLUWWWWWWWUDDRRDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWLLUULLDWDDDRRDDDDRRUDLLUUUULLUUUURRDDRRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDWDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLLWWWWWWWWWWWWWWWWWWWLRWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLRRUUUUUULLLLLLUULLUURLDDRRDDRRRRRRDDDDDDLLLLLLUUUURWRWLLLLWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWRRDUDUDWWUDUDWDWDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUUULLUULLDWWUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDDUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDURLLLRWWWWWWWWWLWLWLRRRRRRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUUDUDUDUDUDUDUDUDUDUDUDUDUDURLDUDUDUDUDUDUDUDUDUDUDUDURLDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDULWLWWWWWLWWWRRRRRWWWWWWWWWWWWWWWWWWWWLWWLLLLRWWWWWWWWWWWWLWWRWWWWWWWWWWWWLLUULRLRLRLRLRDDRRRRDULL","RRRDWULRDDUUWWWWDWWDDDWUUUWWWWWWWWDDDWWWWWWWWWWWWWWWWWWDDRRDDDDRRUWWDLLRRUWUWWUWWDUWWWWWWWWUWWWWDDDDLLUUUULLUUUWUUWDRLRLRWLUDRLUWDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUURWRDDRRRRDDDDRRRRRRUUUUUULLLLLLUULLUURRRRDDRRRRUUDUUUDUDUDUDUDUDUDUDULLUDRRUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLRLRLRLUDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDDRRDDDDRRDWDRLUULLUUUULLUUWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUWUDDDDWWWWWWWWWWWWWWUURLDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUUWWDUDUDUDUDUDUDUDUDUDUWUDDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWDUUUUWWWWWWWWWWWDDDWWWWWUUUDDDWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWUUDDUDUDUDUDUURWWRDDRRRRRWLLLLLUULLDD","UUUULLUUUUUURRRRRRRRRRRRRRUURRDDRRDDDDLLLLUULLLLDDRRDDRRRRRRDDDDDDLLLLLLUUUULLLLUULLDDDDRRDDDDRRDDLLLLLLLLUUUUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDUDURRDDRWWWLUULLLRRRDDR"]},"note:5":{"makespan":27,"moves":119,"lb":{"makespan":27,"moves":101},"starts":[213,233,244,182,234],"goals":[73,61,93,60,110],"paths":["RRRUDRUURLWUUUUUUU","DWUUUUUUDUUUUUUUUUUDRRDRDR","RRRRRUUUUUUUUUUUUUURRDRDRDD","RRDUDRUULWRUUUUUUUUWURRDRD","WLUUUUUUDUUUUUUUURRDRDRDDRD"]},"note:10":{"makespan":34,"moves":132,"lb":{"makespan":30,"moves":90},"starts":[126,184,179,196,197,41,43,27,153,26],"goals":[193,179,201,234,216,227,93,43,197,89],"paths":["UULUULULULLDUUDDDDDDDDDDDLLLLLDLLL","LDLLLLU","RRRRRDR","DDRRRRRR","DRRR","DDDDDDDDDLDLWDDLLLL","RDRWLULULLUDRRDRDRDD","DWWWWWULLDWDUURRD","DDDLLLL","LDDDDWWWWWWWWWWWWWDDDDDLRUUUUU"]},"note:15":{"makespan":29,"moves":177,"lb":{"makespan":22,"moves":123},"starts":[197,169,249,57,202,229,164,121,178,246,167,228,61,182,180],"goals":[43,137,194,166,199,198,89,182,210,248,218,44,179,163,212],"paths":["DUUURRRRUWDLDRRLUUUUUUUUUURRD","UDLRDUWUUWDDLLWDURRUU","LLLLLLUUUL","UDDDDDDUUWDDDDLLL","LLL","RUU","RRRRRUWUUWDDDLDWRUUUUUU","DDDDLLL","DD","RURD","DDDRRR","URRRRUUURWLDRDUUUUUUUUUUURRDR","LULULLDDDDDDDDDLDDDLLLULLU","LLLU","DD"]},"note:20":{"makespan":43,"moves":344,"lb":{"makespan":29,"moves":260},"starts":[246,125,249,89,43,93,210,167,196,218,26,25,166,194,77,94,243,193,248,244],"goals":[125,27,247,183,110,202,168,248,234,246,163,210,25,41,201,179,215,153,43,121],"paths":["UUUUURRDDDWWUWRURWLUUUUUUUUUUDURRDRDRDDRDDL","RUULUULULUWWWDUWWWWWWWWWWWWWLLUWWDRR","LL","DDDDDLDL","ULLDDDDDDDDDDRDWWWULUUUUUUUUWWUURRDRDRDDRD","UULULULLDDDDDDDDDDDR","RUURRRRURWDUWWWWWWDU","DDDRDD","DRRRRRDR","DLLLLD","LDDDDDDDDDLLLLLL","DDDDDDDDDDDLLLLLLDL","RRRDRDDWWWWWWWWWWWUUWLUUUUUUWWUUUWU","RRRRRUULLDRWWWLDWRRRUWRUUUUUWWUUUWU","ULULULLDDDDDDDDDDDDU","LUULULULLDDDDDDDDDLLLLDLL","UURRRR","RDRRRRWWWWWWWWUUWWDWWRRURUU","UURRWWLWWWWWLWWWWUWURUUUUUUUWWUUURRD","URRURRDRWWWWWWWWWLUWUWURUUUU"]},"note:25":{"makespan":49,"moves":401,"lb":{"makespan":17,"moves":167},"starts":[168,167,163,215,185,93,184,89,217,196,27,227,181,77,228,105,25,216,231,60,244,121,9,210,153],"goals":[137,179,210,26,245,169,248,247,229,105,77,163,234,60,180,89,233,168,214,94,202,232,166,227,181],"paths":["WRDRWLUUUDDDLWWWUDLRUWWWRUU","DLLDLLU","DLDD","UUURRUUUUDDDDLWWLRWRUUUUUUUUURWRDULWLUWDRWWRL","DDDDLLLL","RLUULULULLDDDDDDDDDDLWWRWU","RDDDDL","DDDDWUUUUDDDDDDDDLLDD","DLLDLLU","LUURRRRRRWDDWUDDLUUURUUUUUUUUUUWDDDDWUUWUWUDDDDDD","DRWLULLDWDDDDDDDDDDLRUUUUUUUUUUURLUDDURRDRDRD","URULUU","DDDRRRRR","WUWLULULLDDDDDDDDDDDUUUUUUUUUUURRLLDDUURRDRWD","UUU","DDDDDUUUUDDDDRWWWWWWWWLUUUUUUWWWWWWWWUUWUWURLDDDD","RLDDDDWUUDDDDDDDDDDD","UUUDUWWDUWWWWLWWDUWWWWWWR","LU","RLWULULLUWDRRDRDRDDR","RRRRURRUU","DDDDDDLD","DDDDDDWUUDDDDDDDLLLU","DR","DDLLLL"]},"temple:10":{"makespan":31,"moves":206,"lb":{"makespan":31,"moves":204},"starts":[144,303,367,359,223,194,328,189,33,77],"goals":[196,14,173,301,48,144,49,262,226,284],"paths":["DDDDDDDDLDDLLLLLUUUUUULL","RURRRRRRRUURRUURUUUUUUUUUUUUUUU","UUUUWUUUUUUUUUR","LLLLLLLLLLLLLUUU","ULLUUUUUUUULLLLLLLLUU","DDDDDDDLLLLLLUURUUUUUUUU","LLUUUUUUUUUUUUUUUULLLLLLLUU","DDDDDLDLU","DDDDDDDDDDDDDLL","RRRRRRRRRRRDDDDDDDDDDDDDR"]},"temple:20":{"makespan":35,"moves":397,"lb":{"makespan":33,"moves":375},"starts":[207,11,227,366,31,292,88,101,290,219,172,8,90,141,83,331,137,325,228,369],"goals":[204,217,140,88,322,129,59,180,240,288,29,352,147,289,309,341,299,66,369,149],"paths":["LDDDDDDLLDLUUURUUUU","DDDDDDDDDDDDDDDDDDDLLLLUUUUU","RDDDDRRDRUUULUUUUUUUU","RRRRRRRUUUUUUUUUUUUUUUUUUU","DDDDDDDDDDDDDDDDDDDRRRRRR","UULLUURRRRUUUUUUU","RUU","UULLLLLDLLLDDDDDDLLDL","LLLLLUUU","DDDLDDLLLLL","DDDDDDDDRRRRRRUUUUUUUUUUURUUUULUURU","DRDDDDRRDDDDDDDDDDDDDDDDLLDDLL","RURRRRRRRRRRDDDDR","RDDDDDDDDDDLLL","RRRDDDDDDDDDDDDDDDLL","DRRRRRRRRRRU","LDDDDDDDDDDDDRRRRRRRRRRRRRUU","RUURRUUUUUUUULLUUUUUULLLLLU","DDDDDDDDDRRRRRR","RRRRRUUUUUUUUUUUUUUU"]},"temple:30":{"makespan":44,"moves":548,"lb":{"makespan":34,"moves":474},"starts":[291,87,213,194,163,266,281,210,172,58,120,69,347,255,153,233,141,146,337,346,256,288,78,292,362,348,223,273,316,285],"goals":[359,238,117,4,228,75,43,305,366,50,239,249,85,310,167,176,35,39,303,120,371,210,288,0,46,187,365,273,322,297],"paths":["DDRRRDDRRRRR","RDDDDDDRDDDDL","UUUUUUUUURRRRRRRRDDR","LULLUUUUUULULLLUUULLLU","ULLUUUULLULLLDLLLDDDDDDDDDD","UUUUUUUUUUUUULLDLLLLLLLLL","URRUUUUUUUUUUUUUUU","DDDRDDRRRDR","DDDDDDDLDDDLDDDR","LLLLLLLL","RURRUURRRRRRRRDDDDDDDDRRDRD","DRRRRDDDDLLDDDDDDDDDDLLLUURU","RRRRRUURRRRUUUURRRUUULUUUUULLUUUUL","DDRRRDRRRRRRR","DL","RDDLDDRRRRRUUURUULUUULL","RDDDDDDDDLDDLLDDLLLUUUUUUUURRUUUUUUUUUUUURRD","UUUULLUUU","UULLULLD","LUUUUUUUURRRUULLLUUUUU","DLDRDDDDDRRRRRRRRRR","LLULUUUU","DDDDLLDDDDDDDDDDRR","LLLLDDLLUUUURRUULLUUUUUUUUUUULUUUU","LUULUURUUURRUULLUUUUUUUUUUUU","RRRRUUUUUUUUUUU","DLLDDDDDDDDLLLLLLD","","RRRRDDRRUU","RDDRRRRRRRRRRUUR"]},"temple:40":{"makespan":44,"moves":684,"lb":{"makespan":37,"moves":584},"starts":[93,159,153,240,187,286,37,356,16,291,369,289,120,80,228,353,284,53,234,322,255,20,25,368,118,49,57,321,209,251,166,5,86,150,362,15,314,44,183,210],"goals":[328,180,301,225,149,327,73,283,113,249,183,268,78,23,179,295,352,51,326,306,54,110,65,201,374,14,11,7,22,237,215,151,57,298,165,211,230,323,6,10],"paths":["URRRRRRRRDDDDDDDDDDDDDDRRDD","DDDDDLLDDDDLLLLUUUUUULLLU","ULLDLDDDDRDDDDDD","U","DDDDDDDRRDRRURRRUUUUUUUUUU","DDRRDDRRRRDRRRRRRUUUL","URRRRRRDDD","RRUUUUU","DDDDDDDDDDDDDDDDDDRRRRDURRWUUUUUUUUUURUU","RRUURU","LLULLUULUULUDDRULUUUUUUU","RRRRRRRUURR","RURRUUWWWWWWWWWWWWLR","RRUUUUR","DDDDRRRRRRDRRURRRUUUUUUUU","RUULURRU","DDDDDLLLLLLL","LDLUWWWWWWWWWWWWWWWWWDU","DDLLDDDRDRRR","LU","RUUUUUUULURUUUUUURRRRRRRRLR","DDDDRRRRRRDDDDDDDDDDDDDDDLLLLUUUUUUUUULLUUUU","LDDDLLLL","LUUUURUUULUUUUL","DDDDDDDDDDRDDDDDDD","RRRRRRRUURRRU","LUUU","LLLUUUUUUUUUUUUUUUUURURUURRU","UUULUUUUULLULLLLUUUWWWWWWWDU","UR","RRDDDDDULRDDDDDRRURUURUUUUUULLDDD","DDDLLLLDLDDDDDDR","UUR","DDDDRDDDDDRRRDRDRRRRDDRRRRURUULU","LLUUUUUUURRLRRUUUULLLUU","DDDDDDDRDDDDDD","LDLLLLLLUULUULUU","DDDDDDDDDDDLLLDDDDDDDLDLL","UUUUULLUUUURRRRUURU","RUUUULUURUUUUURRRDDRRRRRUUUURU"]},"temple:50":{"makespan":43,"moves":975,"lb":{"makespan":37,"moves":805},"starts":[68,118,277,6,120,333,151,126,41,16,131,167,53,346,281,198,311,276,104,269,108,262,85,240,106,163,30,172,361,283,133,219,339,185,80,360,66,356,353,46,50,224,150,170,78,143,187,350,268,83],"goals":[277,117,194,267,1,296,77,363,3,151,125,290,166,28,371,288,105,134,112,324,133,106,131,47,286,5,49,326,361,195,197,369,240,305,300,208,185,153,354,183,341,337,81,15,353,0,258,331,141,314],"paths":["DRRRRRDDDDDDDDDDDDDDLLLLLLU","L","DDDRRRRRRRUUUUUUUUU","DRDDDDRRRRRRDDDDDDDDDDDRDLL","RUUUUUUUU","URRRRRRRRRRUULLRLWWWWUDDU","UUUUUR","DRDDDDDDDDDDDLDLDDDLL","ULLLLLLLLU","DLDDDDDRDDD","DDDDDDDDDDDLLLLLUULUUUUUUUUU","RDDDDDDDDRR","LLDLLLULLDDLDDDDRRRDDLLWWWLR","ULUUUUUUUUUUUUURUUUUUUUURRRRRRRRRRRR","DDDDDD","DDDDLLDLDRRRWWWWWRLWLWR","LLLLLLLLDLLLUUUUUUUUUUUUUUWWWWWWURLWRLD","DRRRRRRRRUUUUUUUUUUU","LDDDDDDDLLDDDDDDLLLUURUUUUUUUULUUL","DDLLLDLLD","WDUUDLRUURRRRRRRRRRDDD","DLDLLLLLUULUUUUUUUURUU","RRRDDDDLLU","UUUUUUUUURUUUUR","LDDDRDDDDDDDDDWWWWWRL","ULLUUUULULLLLLUUUU","DRRRR","DDDDDDDDDRURDRDR","","DLLLDLULLLDDLLLLLLUUUURUULUUWRL","RDLLLUUUUULLLLLLDLLDDDDDDLLDDR","DDDLDDDDLDDDRR","URULLLLLLLDLLLUUUUU","DDDDDRDDDL","LULDDDDDDDDDDDLLDDDDDL","URRRRRRRRDRRURRRUUURULUUUUUU","DRRRRRRRDDDDDDDDDDDDLLDDLLLLLUULUUUUU","UULLULLLLLLDLLULUUURRRUUUUUUU","R","DDLDDDRDDDRRDWWWWWWWWWWWWWULRD","DRRRRRRDRRDDDDDDDDDDDDRDDLDDDDLLU","DDDLLLDDDLLLDLD","RURRUWDLRUUUURRR","DDDDDDRDDDDLLLLLLUUUURUULUUUUUUUUUUUUUUWWRL","DDLLDDDDDDDDDDRRDDDRDRDDRRR","LDDDDDDDDDDLRLDDLLLUUUULLUULUUUUUUUUUUUUUUU","DDDDDDDDRDLDDLLLLUWUUUUU","LDLLULU","DDLLDLLLUUULUUUUUUUUL","RRRRRDDDDDDDDDDDDDDDR"]},"rotation:5":{"makespan":14,"moves":28,"lb":{"makespan":12,"moves":24},"starts":[57,56,32,46,12],"goals":[62,59,48,24,14],"paths":null},"rotation:10":{"makespan":40,"moves":240,"lb":{"makespan":11,"moves":44},"starts":[58,32,10,11,57,38,59,54,24,46],"goals":[62,46,6,12,58,40,60,13,16,61],"paths":null},"rotation:20":{"makespan":181,"moves":2040,"lb":{"makespan":12,"moves":120},"starts":[38,13,9,6,54,14,32,61,8,22,58,56,57,16,48,12,30,40,62,11],"goals":[8,22,11,48,54,6,40,46,60,24,12,9,10,62,59,58,30,16,13,32],"paths":null},"sunflower:10":{"makespan":20,"moves":79,"lb":{"makespan":20,"moves":79},"starts":[111,83,173,250,146,214,47,28,176,235],"goals":[89,145,173,70,221,126,128,66,107,253],"paths":["LDLLLUUR","DRWRRRDRD","","RURUUUUURURURRRRURUR","DDDDL","UUUURURURRRRDR","DDDRRDRRR","DD","UURURURRRRR","DL"]},"sunflower:20":{"makespan":23,"moves":243,"lb":{"makespan":23,"moves":215},"starts":[195,272,89,47,271,256,233,138,167,137,214,279,165,157,120,65,184,155,187,109],"goals":[317,241,69,332,66,243,272,256,83,99,242,275,121,97,261,186,70,309,294,174],"paths":["DDRRDRRRRDRDRD","UDRWWURRRRRUR","LU","DDDRRDRRDDDDDLDDLLLDDDD","RRULULUUUUUURURRRUU","RRURRRRWWWWWWWWWWDU","RDDWWWWWLR","RLDDDDRDRDRRLRWWWWLR","DLLUULWULULLLLU","UU","DRRDRRRRRURRWWWWWRL","LULLLDWWWWWWWDLWWWWWWRU","ULWWUUULDLLLLD","UULLUL","RURRRRRUDDDRDDDDRDD","WRDWDRRRDRDDDRR","UUULUURU","DRRDDRDDDDLD","WLLLDDLDLWDLLDDWWWWWRWL","DLLUULWDLLLLDLDLDDLL"]},"sunflower:30":{"makespan":28,"moves":415,"lb":{"makespan":22,"moves":331},"starts":[174,277,62,172,97,253,110,258,66,186,205,70,81,242,118,105,175,263,138,125,167,222,187,119,297,83,275,51,89,254],"goals":[294,250,81,257,109,271,255,309,155,165,173,129,262,87,119,195,184,138,105,103,104,213,249,234,174,157,99,127,273,137],"paths":["RRDDDWRDDDWWWWUWWURRRDD","ULLLLUWLLLDLWWWWWWRL","D","RRRRDDDWUDRRWWWWWWWDRRR","RDRRRRURRRRDRRRU","DL","DLDLDDDDLDLDLLLLDLUWRR","LLLLDLDLD","DWWWWWWWWDLLDLDLDDLLU","LLUWDDDDRULUWDLRUUU","WULLDDDLDLLLLLLULUUULLL","DLDDRRR","RDRRRRRDRDRDDDDDRDR","UWWWWWWWWLUURLUULULUU","RWWDU","LRRUWWWWWWWDLLLLLDDLDDLRD","RDDDRDDRWWWWWWULWRRRRRRUURUU","LLULLDLLLLLLWULURWLWWUUUU","RUURRRRWWRRULWDL","WWWURWWLDRWULLLL","WWDLWWWLUUULULLL","DLLDLLLLULULL","LLLDDLDLDLLLLLULLLDL","DDDDDLWWWRDRWUWWD","UULLLLLULULUULLWWWWDWWWU","DDLDLDWDLWRUWWWWDDUUDLLRRU","ULLUWLULUUUULUU","DLDDDRWWWWRLWDU","LDDDRDDDDDLLDLLLLD","LUUWWWLUUUURLL"]},"sunflower:40":{"makespan":33,"moves":580,"lb":{"makespan":19,"moves":416},"starts":[184,126,251,214,66,82,213,332,232,240,235,104,275,172,262,97,298,118,147,43,105,87,272,297,103,117,250,253,63,291,256,51,263,109,81,257,215,271,125,167],"goals":[138,243,147,120,273,290,277,258,254,257,165,167,195,51,263,70,111,28,121,240,256,155,278,250,66,105,125,295,137,119,253,184,127,110,271,146,203,242,251,297],"paths":["UUULLURURWWWWWULDLDLLLLLDDL","DWRDDRWWWWLDDRDR","URUUUUUURURRRRRDRDRR","UUUWUULWWWRWRWWWWWWWUUWWDD","LWWWWWWWWWWWWWWRDDLLDLDLDDDDRDRDD","DDDLLWWWRDDDDRDDDDL","WWDRRWWDRRRRRRDL","UURWLUURRWWURUDLD","RULWWRWWWRDRDWWWWDWWUWWWWWWWWWWRL","DLUDDWWWWWWWWWWUL","DRRDWURRURRWWUWDWUUUU","UDLRRWRRDRWLDRDDRRU","URWLLLDWWLUULLUWRUWWWWWULWRD","RRRRUUURURRRRRURRUU","UDR","RRDWRRURRWRRRURRULR","ULUURUUUUURUURR","RDWURURRRUUUU","ULLLURURUWWWWWUDLDLDLLLLD","DDRRDRRRRDRDRDDDDLD","LLLDWWWWWLDLDDDDRDRDRR","RUWWWWWWDDWWWWDUWLLLLLDLDLDDLLU","LDRWWWUWURRRRRRD","ULULLLLULLLLD","LUWDRRUDRLUUWWUWD","RRWRURUWDDWURRRRDRUWLL","RURUUUUUUWRRURRRRD","WURLUWWWWDRDRRRWLDDR","WDDUWWWWWWDDDLL","UUUULUULWWWWWWRUUU","LRDDLWRWWWWWWWUULLL","DDLDDLWURLDWRDRDDWWRL","LLUUWWLUUUUU","RWWWWWWWWWWWWDU","RDDDWWWWWLDDDDDRDDL","RURRRLWUUUUURWWLWWDU","DRDDLLWWRURRRRRRURUU","DRUUWDURRRRRURRR","ULLUURWWWWWWWWLDDLLDLDLDDDDDLD","DLLDDLDDDD"]},"sunflower:50":{"makespan":35,"moves":760,"lb":{"makespan":22,"moves":554},"starts":[70,231,82,262,51,145,98,121,85,235,272,28,106,255,87,43,215,294,253,126,214,313,47,185,193,157,297,184,317,239,167,279,223,277,137,127,125,251,172,146,99,67,104,256,97,65,69,119,110,176],"goals":[89,213,87,155,146,109,172,69,279,222,223,193,88,205,62,110,175,118,121,258,106,243,107,317,242,291,167,176,261,66,98,97,309,253,294,99,81,111,272,63,214,157,70,28,185,43,290,232,239,278],"paths":["D","WRU","DDDWUWLLLWWWWWRRRUWWRRRRRU","LWWWWWWWWULULDDLLLLLULULUULLU","DLWWWWDWLWDRDDWRWWWWWWWUWDWWWWWLR","RRUU","DRDRDWDLLLL","WWWWWUUWWWWLDDUURWDRRRRURU","DLLLWWDDLDDDDDWURLDWWWRRWWWDRRRRDRR","DRWRRRUWRURUUUDRWWWWLRWLDD","RUWRRRRRWUWRUR","WWDDDDLLLDLDDDLLD","RDDRULDUUUWWWWWWWWWWWWWWDU","RRRRUURUURRD","WRLWWWDLLLLULUL","DDRUWWWWWDWDDRULUWRDRRRRDRRRRU","DWDDLWWWRWWUUULUULWWWWWWWWLLRR","RLWWWWWWWUURLLLLUULUUUULU","DRWWWWWULWUUWLUUUURWUR","DWRDDRRRWWWLLLDDDRWWLLDLWWWDUWWRL","RWWDRDRRRRURWLRDLURURUUUULUUL","UUURRRURRR","WWDLWRWWWWWWWWDWDLWRRRRWDULDRU","LDWDRDRLUWDWLUDLDDDRD","URRDDDRRDDWWWWWWWWWWURRDWURRRURR","DDDRWDDDDWWWWWWWWWWWWWWWWWWLWR","UUUURUURRU","UURUWLLLWULWLUDLLDLLDRWLDWD","ULWWUWUURURWWDD","RRRWWLRULUUUUULULLLUU","DLLDWUUULULULLLLDLLLWDULU","WLUURUUUUULULULLLLDLLLLUL","DRDWWWWWWLWWULRLLDLLWWWLLLDLLDD","WWRRWWLWWUWLLLLLL","RDWDDDDRRDRRDD","LLWWWULLLLDLLLU","UUDLLLLLUL","URRRDRRRRDRULWUWWRURUUUURURUR","RRRWWRDDRDRDLDWWWWWWWWWWWWWDWU","UWWLWLWULLLLULU","DRWWDWDDDDWWDRRWWLULWWWDU","WWWWLDDLLLDLDDWWULWWWRUWDWD","RRRWWWWWUUR","RRUWWRURUUUUULULLLUUUU","RRDDWWRURDWWWLWWUWDWRUURRRRRDRRDDDR","RDDLLULLUU","DDDDRRWWWWWWWWLDDDDDLDLLLLLDLLD","WDWDDDDDL","DWWWWLLWWWDLWRDDDDDLL","DDDWRDRRRRRDRWWWWRLWWWWWWWWWWWWWWUD"]},"clock:12":{"makespan":16,"moves":108,"lb":{"makespan":16,"moves":108},"starts":[22,118,202,106,40,162,184,62,72,190,152,34],"goals":[40,72,118,162,190,202,184,152,106,62,34,22],"paths":null},"clock:24":{"makespan":27,"moves":368,"lb":{"makespan":19,"moves":368},"starts":[201,185,169,153,137,121,91,77,63,49,35,21,23,39,55,71,87,103,133,147,161,175,189,203],"goals":[24,40,56,72,88,118,148,162,176,190,204,202,200,184,168,152,136,106,76,62,48,34,20,22],"paths":null},"clock:36":{"makespan":19,"moves":356,"lb":{"makespan":19,"moves":342},"starts":[95,144,65,128,83,154,99,79,141,124,68,159,130,81,156,98,64,140,85,160,126,70,158,94,155,84,143,100,66,129,80,139,96,145,69,125],"goals":[23,24,40,41,57,72,88,103,118,133,148,162,177,191,190,204,203,202,201,200,184,183,167,152,136,121,106,91,76,62,47,33,34,20,21,22],"paths":null},"lattice:10":{"makespan":13,"moves":85,"lb":{"makespan":13,"moves":85},"starts":[164,141,127,100,93,85,158,201,135,21],"goals":[128,137,42,102,74,107,211,111,203,47],"paths":null},"lattice:20":{"makespan":22,"moves":229,"lb":{"makespan":22,"moves":227},"starts":[89,67,35,214,223,215,75,161,130,128,203,209,65,107,103,77,212,193,183,175],"goals":[34,130,98,1,104,33,222,53,139,103,224,215,10,93,7,165,113,49,13,91],"paths":null},"lattice:30":{"makespan":19,"moves":282,"lb":{"makespan":19,"moves":280},"starts":[135,113,216,211,69,109,97,215,167,158,120,33,218,188,45,165,12,61,0,34,44,185,38,210,30,161,89,175,68,87],"goals":[152,36,1,155,43,224,219,124,195,137,69,75,67,221,150,3,8,73,171,162,100,177,12,33,38,201,127,181,128,109],"paths":null},"lattice:40":{"makespan":26,"moves":425,"lb":{"makespan":26,"moves":407},"starts":[119,135,83,183,130,163,68,195,223,103,12,220,11,102,137,94,87,175,39,62,17,153,99,155,203,122,10,43,96,181,192,79,222,45,159,210,36,55,212,81],"goals":[115,15,191,87,216,103,79,13,123,133,60,75,203,124,21,160,189,127,99,128,55,145,143,61,5,73,149,42,100,137,14,102,23,184,150,214,179,74,151,154],"paths":null},"lattice:50":{"makespan":24,"moves":623,"lb":{"makespan":24,"moves":531},"starts":[94,199,47,87,173,71,207,131,31,152,137,0,95,177,156,193,165,117,120,180,39,191,125,161,85,182,171,157,15,92,38,77,151,159,179,214,183,126,62,111,124,8,167,218,90,175,101,188,162,36],"goals":[154,191,222,93,8,213,1,6,115,175,210,64,127,169,135,197,34,183,90,205,165,214,155,158,91,125,137,96,113,117,130,72,122,40,111,12,11,49,102,139,147,187,60,17,3,95,87,30,68,207],"paths":null},"power_button:16":{"makespan":40,"moves":268,"lb":{"makespan":8,"moves":66},"starts":[32,33,42,41,51,50,59,58,49,57,48,47,39,38,29,30],"goals":[30,29,38,39,47,48,57,49,58,59,50,51,41,42,33,32],"paths":null},"ceo:50":{"makespan":78,"moves":2241,"lb":{"makespan":76,"moves":2211},"starts":[1453,546,50,2059,1246,1878,1517,1938,1919,1950,1712,1921,1201,2467,343,1913,2193,1961,2020,143,901,1505,186,2305,1253,2254,2024,1407,2333,1347,436,352,1978,505,254,339,346,2372,748,1731,2304,1009,1966,324,2351,1123,253,1151,1274,902],"goals":[1285,852,2219,695,2233,1681,708,1059,851,1962,2005,403,1448,127,47,1698,2435,112,1071,1961,224,688,2110,1342,1475,2349,133,2007,2418,1719,206,829,2090,904,2321,1828,101,1779,2076,1841,65,1777,1191,2258,2082,1246,1621,85,894,1688],"paths":null},"ceo:100":{"makespan":83,"moves":4180,"lb":{"makespan":83,"moves":4040},"starts":[2000,907,2279,543,976,118,1430,110,982,1644,697,384,2280,221,909,804,1445,929,405,644,1322,1391,1561,2097,2184,1043,190,2013,2145,2091,14,1332,1857,2010,357,1870,1392,154,2476,2105,2422,1977,1587,608,2162,1596,2306,1297,2072,60,2168,1333,8,1290,1595,941,1914,1959,1374,123,1125,544,1641,850,2062,72,1176,1534,1648,2423,389,2218,161,1385,43,495,1462,1273,1714,1291,242,1931,1996,2426,2174,940,290,2351,1908,2058,1335,450,901,1371,410,2232,2377,1475,1778,52],"goals":[1343,40,1687,333,991,2321,106,1140,156,1419,143,2259,1831,981,165,1445,1807,2122,2300,295,1763,1998,2419,745,30,443,2068,1340,78,2295,2327,207,1511,273,2382,1681,1171,2146,1355,384,1695,2050,94,1431,2213,880,1970,1256,1254,1009,1693,2032,1405,2126,438,954,1926,291,1887,858,18,1731,1469,2025,294,2160,1430,1608,1739,264,780,2177,1152,752,982,1974,1805,2065,1563,699,1194,1761,1978,69,554,845,1582,1953,332,506,1149,409,212,1616,2176,497,1843,2139,2474,1333],"paths":null},"ceo:200":{"makespan":90,"moves":8600,"lb":{"makespan":90,"moves":8474},"starts":[447,38,1541,1808,2250,2270,1499,2162,2047,1624,1452,811,53,507,47,195,1245,465,1937,1696,56,1522,1994,1653,138,300,931,41,1370,712,336,2253,343,2150,1107,2007,79,455,222,185,539,1838,2326,2399,1596,362,89,1592,1963,2330,282,497,804,1691,2452,2092,753,2038,177,1901,125,1484,104,163,1800,2475,150,1646,1072,1651,245,2084,310,2469,1809,550,1880,2015,2348,59,489,215,83,1874,1603,26,441,286,952,459,175,113,1849,1029,2104,1697,2236,367,1695,1566,1325,843,1054,2420,505,1024,316,2116,990,464,1243,695,991,1241,757,649,903,2482,901,996,993,1352,1246,2023,893,491,1059,314,1591,1042,752,203,558,1652,2378,1094,350,591,692,1612,1721,946,599,2006,1811,341,335,2106,1219,1976,1640,75,2147,1457,1798,1789,466,2065,1928,146,1205,1884,486,995,2211,1298,1008,2246,22,407,1169,1301,1001,443,184,1767,2267,106,700,2181,1183,255,1285,161,555,1493,798,156,129,2279,1795,880,229,1275,598,62,1353,160,333,697],"goals":[2345,41,109,1749,314,1881,1663,1224,2012,1179,58,1228,2132,881,1762,1923,2300,1713,1818,1393,1422,1172,1989,2419,382,279,1241,2095,1580,880,1782,877,390,149,438,804,1404,2022,858,1890,2054,1581,1140,1002,1954,802,1254,292,135,1454,334,2112,2053,194,2331,978,369,2346,2075,657,2099,1504,2164,1246,43,2347,2425,1826,1176,2330,791,2225,28,1094,1605,98,2003,593,2103,1937,549,1640,1209,645,2021,397,1542,1891,1496,1421,2156,1378,642,605,280,249,1158,1611,282,1621,1,592,322,1346,712,2298,1732,362,1392,1792,1661,2418,893,2032,1293,290,2402,1778,1395,842,408,1518,1321,1644,496,1610,1444,1402,1028,331,2468,1502,2036,2270,1894,846,29,130,211,320,319,1758,138,80,131,218,1595,753,286,891,1813,2230,552,696,1328,126,161,1870,1170,157,231,268,1204,15,1634,2348,1585,497,2098,2428,1601,1500,1981,1657,1799,216,2235,1629,158,2030,1350,1920,187,346,1887,1680,1357,1982,1191,698,538,2161,46,1448,18,1968,1342,2326,2259,831],"paths":null},"ceo:300":{"makespan":103,"moves":12966,"lb":{"makespan":87,"moves":12608},"starts":[2299,1632,252,1650,1346,1835,398,198,2163,344,156,2114,2141,2180,1978,504,7,1358,1707,1839,157,2317,1538,103,27,1604,1938,1299,324,1103,2246,2284,646,92,1659,2022,2221,1245,1540,2318,1450,16,267,304,1499,1198,269,434,2476,1445,1857,281,1661,8,1805,247,1149,1876,2160,1551,789,1989,1873,839,2368,1921,318,1235,1826,341,1159,1424,1824,2214,2282,748,1910,1871,1917,1234,696,1506,1574,415,799,1740,1349,1225,2324,1091,2208,611,565,1854,72,1500,945,703,1554,1998,1905,2371,223,663,1906,1339,1897,397,1785,658,2307,259,142,2156,910,1996,1614,485,2034,510,1481,1483,1914,1462,2466,1889,2133,1953,2236,1818,2279,1060,908,188,462,1534,991,1490,791,1928,2140,1878,2174,1926,446,1076,2040,1375,743,2170,2099,1155,391,229,2418,1816,65,1933,706,1738,196,367,2168,1836,1433,2177,512,2209,129,2186,2321,1042,1924,182,2147,1997,1374,2230,440,438,2243,2010,162,2182,1764,1512,1366,741,158,2108,1970,2196,1009,2310,2248,166,1435,1405,1981,692,1882,1708,165,1730,2181,2220,1595,355,1962,2074,1803,1545,1994,150,2486,2080,388,604,143,1870,335,2105,754,1552,1752,56,243,1047,2113,2225,1584,1123,1410,163,2295,21,1218,1441,97,1965,2012,321,928,111,995,253,1133,549,1987,690,1251,2171,225,2185,2112,854,172,1666,263,107,2124,1307,1247,110,850,2041,2428,1456,639,1686,1055,393,879,86,1491,806,807,2397,1309,78,2369,9,1850,458,184,1556,2066,561,1925,250,1170,1447,2077,588,2468,1912,1400,1992,943,275],"goals":[611,197,1696,332,2129,1289,1512,2020,1957,2170,1094,189,187,1492,2433,1995,366,1629,599,2150,104,2404,2077,2254,1723,1986,1533,1173,309,981,1499,658,1952,504,890,502,2143,255,979,2417,1226,1322,439,2384,1518,74,497,458,2090,1779,1619,2142,121,1355,1869,1755,1209,1327,593,2246,1704,705,2045,809,353,388,1246,1101,1644,2174,2080,190,803,267,586,2483,1625,1329,749,2203,1346,252,1001,199,1151,1660,2176,1522,192,1200,686,266,804,707,2232,369,209,1877,58,241,1827,296,417,2132,487,929,1997,287,1798,335,2276,2022,1613,229,793,1417,1684,491,1940,1443,1440,2317,160,2259,2229,1732,1842,1670,1052,2144,6,162,1958,779,1656,1427,7,2004,1692,226,993,101,2261,1382,2379,1928,1898,1284,2169,1225,2160,1809,2089,2296,1844,1831,1267,2356,50,1787,342,44,548,536,1354,846,171,1344,947,2486,1753,490,2118,358,100,185,41,1820,1025,32,258,2019,1880,645,1333,660,1345,881,1317,561,689,256,1583,1655,213,0,1738,42,364,1752,60,1457,512,77,999,1093,173,1662,1124,4,401,1455,828,385,1765,396,808,564,2084,159,743,1823,2225,1845,210,751,1371,1357,223,1420,323,227,1391,2028,2182,1506,10,545,594,550,1868,1666,2302,1501,1650,2107,1347,1306,907,2059,2272,92,1642,1620,1562,1846,606,797,2062,1886,2165,1894,494,2214,898,2072,982,1155,1057,1305,137,1585,1628,555,336,1945,592,452,1838,355,1782,747,158,1600,73,1452,36,1393,2018,1589,1645,2153,1403,2268,1194,1832,1103,499,2397,2285],"paths":null},"ceo:500":{"makespan":151,"moves":21811,"lb":{"makespan":89,"moves":20103},"starts":[1308,272,2294,2039,2346,391,614,17,297,901,459,486,172,490,1522,1518,450,1716,2285,1492,2070,1845,1849,166,1887,2250,780,362,205,1425,2096,2301,1350,266,890,1752,946,1294,1622,2003,1909,2436,651,1982,117,2046,605,951,221,694,2452,1742,1318,2087,1541,2170,211,1911,842,66,1355,709,1972,801,123,1107,1571,69,2357,2307,408,1180,499,1059,897,298,1125,2001,2451,2302,2050,1854,2088,2223,515,2195,505,213,1882,1609,1401,382,1395,210,1226,1285,854,61,802,102,2475,231,1040,2060,1108,125,1392,1307,2066,158,310,2297,644,2110,2044,2193,1,603,436,82,1056,1503,1828,1160,37,592,491,2000,35,1447,1099,312,444,808,1024,1474,1174,2375,460,1816,1029,807,252,1604,1943,1621,1759,1074,1442,132,83,357,456,2090,1937,288,2232,286,2471,1794,1371,2036,1653,587,170,2174,1250,108,255,2125,1661,1855,299,2025,1356,1423,2100,1744,1922,180,1815,346,2210,1591,1998,1256,2209,1745,182,2252,2279,648,1274,1561,1106,1606,1659,1733,1650,2259,2101,1740,1556,127,1181,689,591,1942,998,1096,1071,1949,1664,1929,1821,1788,1321,1275,1850,1441,997,692,218,2213,1499,1292,2093,2256,2260,1197,1786,1225,319,71,900,2021,1449,855,2095,194,206,504,1491,1075,511,1743,1405,976,1178,1051,589,2104,761,406,493,1631,2229,1300,1807,1457,2097,1331,2423,1910,757,284,1907,1376,982,613,1597,657,1721,753,47,2261,365,1103,262,1588,695,364,163,2142,1422,2450,1397,2382,1838,1696,1902,1126,195,1976,1205,1098,1158,2005,2099,977,24,191,190,793,1719,352,209,2156,1908,13,38,830,1169,1858,2453,2335,1581,2276,1969,1003,991,1712,1808,1562,1814,275,1865,2268,1123,197,145,239,1945,2373,2206,1793,409,1925,1399,1461,1094,2333,222,1708,1101,1046,1544,1965,848,1978,2157,2085,403,485,57,1870,366,2404,270,110,1303,2233,169,144,215,164,643,1155,285,49,902,301,1962,1863,1667,2076,1195,1241,598,1625,2379,1830,1993,849,2180,1198,1879,2470,1875,1718,2367,1627,2115,899,1382,1751,1836,2058,1805,1871,1253,636,151,2023,48,56,955,100,124,944,1968,200,2399,34,1975,2013,1697,1660,293,746,1950,2320,2483,453,799,1500,73,2417,2354,193,1654,861,2251,1873,46,84,1149,2432,1967,1431,1832,1747,2300,877,1963,1936,454,65,268,2326,1266,1645,175,395,1233,134,204,1175,995,1342,1148,2478,687,2194,1245,245,1920,1758,2227,1210,1598,1848,1540,1410,1563,139,237,1351,2191,1047,810,2131,1110,2449,797,1701,1874,2164,300,1866,2474,1467,80,94,2329,1368,1209,1710,2134,758],"goals":[1002,1397,2309,81,898,901,2151,2282,316,1000,397,930,2303,1447,2236,489,1756,209,2310,1827,1023,1295,1399,1170,1832,312,229,1571,1796,1517,352,1625,167,2211,1257,954,5,1661,1181,542,490,2245,1984,1356,2015,829,2182,241,230,136,232,750,929,1341,1968,1698,1408,660,10,88,1783,1251,2423,2021,1896,1643,1824,1403,2173,950,658,932,2280,2319,1943,269,14,1859,1430,539,2376,2010,1102,1563,1176,1924,565,1404,455,1393,1990,245,2450,2160,102,1145,2152,2253,798,1666,1959,216,7,1788,2473,535,0,70,1751,213,1809,1894,1109,2371,283,537,2053,1939,1879,1653,2248,2261,1979,2030,2243,2381,1206,648,1548,1664,1096,2034,290,1889,1914,556,220,1079,1955,2143,662,94,1158,1043,37,882,82,976,1550,1505,1209,164,1853,254,1941,1813,2299,75,1724,217,1705,1423,247,1444,1972,1203,310,1639,1871,2285,104,654,1555,1611,1510,1400,2106,1325,1670,1800,190,299,411,460,740,2350,2293,2190,896,1762,1712,1051,555,1222,1740,1794,2377,2042,1581,1716,1076,549,25,1816,1466,2281,1582,541,1494,1599,701,355,1535,2022,395,2085,1340,1259,2062,1542,2138,200,2170,218,149,1032,1601,462,797,1587,240,2023,484,502,2071,414,2000,846,607,1405,1359,2208,1981,188,441,1418,958,1217,2163,1450,497,1947,2028,27,2149,1172,2304,1370,2119,1293,1616,187,1637,2260,2436,1374,206,126,1095,2195,1732,1205,1910,653,1836,457,2,1432,2269,1328,1865,1415,793,641,2009,4,1507,1606,1644,464,1484,1448,1327,2073,2204,1772,356,2039,611,407,1461,1719,644,1978,604,1385,841,165,1892,1574,1266,647,1634,1626,1372,1874,1335,1490,1833,909,309,1649,239,183,645,1986,1605,2419,2044,696,897,1296,1485,32,507,1782,1554,1467,1590,811,553,76,1650,221,1848,1454,1856,1977,2099,389,85,1010,1182,394,2038,1771,204,2082,384,1546,1202,790,49,161,1655,2161,1107,544,2466,2255,2232,2200,1954,306,1592,18,1094,2322,2370,1144,238,1657,163,2046,1409,56,249,391,341,859,1233,710,320,1416,1731,779,263,6,1160,1141,260,235,401,1930,1868,1995,2435,906,1900,1584,1347,2430,170,890,745,1933,1633,28,1495,416,1394,1966,2061,3,1840,1055,1533,649,2244,1099,2128,72,955,1957,2132,2320,120,642,609,150,1100,345,613,347,1421,2178,168,1595,59,2400,105,1072,243,999,2284,1133,1691,417,697,2183,1693,941,382,753,2352,219,191,1854,1103,461,1963,1880,495,1375,321,1759,366,2058,1009,1919,1850,1106,270,2401,459,350,1624,663,1790,2246,1858,807,1793,1898,589,2032,1420,1867,252,1042],"paths":null},"crab:10":{"makespan":11,"moves":61,"lb":{"makespan":11,"moves":55},"starts":[76,48,46,24,14,42,39,52,58,69],"goals":[35,84,55,63,59,3,28,50,53,57],"paths":null},"crab:20":{"makespan":17,"moves":188,"lb":{"makespan":11,"moves":126},"starts":[57,81,14,52,44,35,84,25,50,26,83,65,34,42,30,38,60,53,37,46],"goals":[83,24,57,28,80,60,51,61,42,66,50,46,53,81,68,69,62,38,35,8],"paths":null},"crab:30":{"makespan":23,"moves":334,"lb":{"makespan":13,"moves":182},"starts":[38,30,14,74,3,60,35,47,55,46,51,48,76,49,25,59,81,57,80,68,65,63,83,66,2,69,7,50,53,42],"goals":[42,63,51,74,65,8,26,25,28,49,50,27,61,41,24,58,7,69,34,3,62,14,44,83,52,29,76,80,81,30],"paths":null},"packed2x9:18":{"makespan":6,"moves":88,"lb":{"makespan":1,"moves":18},"starts":[6,10,14,18,22,26,30,34,38,37,33,29,25,21,17,13,9,5],"goals":[5,9,13,17,21,25,29,33,37,38,34,30,26,22,18,14,10,6],"paths":null},"contest001:30":{"makespan":50,"moves":1132,"lb":{"makespan":44,"moves":1072},"starts":[47,73,77,82,130,164,189,200,203,252,454,462,464,465,468,469,474,497,513,517,685,687,765,802,803,860,879,909,912,918],"goals":[756,977,740,806,724,944,554,910,542,986,827,926,990,965,869,165,708,61,252,346,153,71,835,571,76,355,190,109,67,218],"paths":["DDDDDRRRDDRRRRDDDRRRDDDDDDDDDLLLDDLLD","LLLDDDDLLLDDDDDDDDRRRDDDDDDRRRRDDDRRRDDRRDDDRRDD","DDWDLLDDDDDLLLDDLLLDLDDDLLDDDDDDRRDWWWDDLWRUU","DDDLLLLLLLDDDDDLLLDDLLDLLDDDDDLLDDDDRRDDDRR","UURRRRRRRRRRRRDDDRRRRDDDRRRRDDDRRRDDDDDDDDDLLLDDLL","DLDDDDDDDDRDDDDRRDDRRRRDDDRRRDDDDDDRRR","LDDDDDLLDLDDDDDLLLLUULLLDDDLLLLLLLL","DDDDDDLLDDDDDDDDRRRRDDDRRRDDRDDD","URRDRRRRRDDRRRRDDDRRRRDDRDDRRRD","DDDLLDDDRDDDDDRRDDDDDDDLLDLDDDD","DDDDDDRRRRDDDRRRDDDRDRDRRRRRRRRRRRUURU","RRWRRRRRDDRRRRRDRDRRDDDDDDDDDDR","WRWRRRRDDRRRRDDRRRRDDDDDDDRDDDDD","RDDDLLLLLLLLLUULLLLDDLLDLDDDDRRDDDRDDDDD","LLDDLDLLLLLLLLUULLLDDDLLLLDDDDRRDDDDDR","LLLULUUUULLUUULLUUUULLLLLLLDLDD","DDLDDDDLLLDWDLLDDDLLLDLLLDLDDLLLUULLLLULLUUUU","UUUUUULLUUUUURRRRRRRRRRUUURRRR","UUURRRRURRRUUUWWWWDRRRUUUUURRURRRRRRRRRRRRDRRRDD","RDDDDRRRRDRRRUUURUUUURRRRRRRDDRRRRUURUUUU","UUUUUUUURRRRUUUULLUUURRUURRRRRRRRWWWWWWWWUD","UUUULLLLLLUULLLUULLLUUUUUUURRURUUUR","DDDDLLDLLLLLLLLLDLLLLLLLLUULLLLULLL","DRRDRRRRRRDDRRRURRRRRRRRRRRRUUURRRRUUUUUUULLU","RUUULLUUUUUURRUUULUUUUUUUURUUURRRRRRRR","DLDLLLLLLLLLUULLULUUUUUUUULLLLLLUULLLULULLUU","UURRRRRUUURRRLUURRRUUUURUUUUUURRUUUUURR","UUURRUUUUUUURRUUUUUUUUULLUUULULUU","LUUUUUUUUUULLULLLLUULLLLUULLUUUUUUURUUUUL","RRRUUULLUUWWWULUURRRUURUUUUUUUURRUUUULL"]},"contest001:75":{"makespan":55,"moves":3016,"lb":{"makespan":55,"moves":2806},"starts":[35,36,38,57,77,82,89,94,100,142,157,163,174,196,208,222,227,232,235,259,264,278,284,304,316,342,355,376,378,419,422,430,441,449,452,453,461,484,485,487,493,509,545,553,560,580,589,601,602,646,674,682,724,726,803,813,818,830,834,859,865,871,893,900,912,921,922,946,953,962,963,966,974,975,977],"goals":[60,893,506,355,906,986,978,646,570,961,558,813,861,442,740,37,925,724,816,733,534,985,553,824,706,874,662,836,38,954,665,834,195,820,185,920,900,441,348,892,827,261,59,187,126,541,92,197,420,957,505,90,232,454,218,124,166,242,151,303,410,58,149,101,165,176,392,158,48,89,155,446,299,152,145],"paths":["DRRWRRRRRRRRRRDDRRRRRRRRRRURUURR","RRWDRRRRRRRDDDDRRRRRDDRRRRDDDRRRDDDDDDDRRRRDDDDDDDRDDL","DRRRRRRRRDRDDRRRDDDRRRRDDDRRRDDDDR","DDDLLLLLLLLLLLULULLLLLLLLDDDDLLDDDDD","DDDLLDDDDDLLLDDLLLDDDDDDRDDRRRRDDDRRRDDDDDDLLLU","DDDDDDRRRRDDDRRRRDDRDDDDDRRDDDDDDDLLDDDDDL","DDDDRRRDDDDLLDDDDDDLLLLLUULLLLDDDLLDDDDDDDDDRRRDDDD","DDLLDDDDDDLLDLDDDDDLLLLUULLLLDDDDLLLLDDDLLLULLLL","URRRRRRRRRDDRDDRRRRDDRRRRDDDRRRDDDDDRD","LDLLDDDDDLLLDDLLLDDDDLDLLDDDDDRRDDDLLLDDDDD","DDLDDDDLLDDDDLDDLLLLUULLLLLLLDDD","DDDDDDDDRRDDDDDWRDDRRRRDDDRRRDDWWWWWWWRL","DRRRRDDRRRRDDDRRRRDDRDDDDDRRDDDDDDDD","UURURURRRRRRRRRDDDRRDRDDRRRRDDDRRRDDRWWWWWWWWRL","ULLLLLDDDDDLLLDDLLLDDLDDLLDDDDDDRRD","ULLLULLLLLLLLLUULLLLLLLLLLLLUL","DDDDDDDRDDDDRRDDRRRRDDDRRRDDRDDDRRRRRRRRRRRURRRRD","DDDDDLLDDWDDDWDDDRRRRDDDRRRDDRDRRRURRRUUU","DDDLLLDDLLDDDDDDDDRRRRDDDRRRDDRWRR","DDDDDDRDRRDDDDDRRRRDDDRRRDDDRDRDRRRRRRRRRRRUURRUWWRUUU","DDDDLLDDDDDDDDRRRRDRRRUUUUUUURRRRRRRRDDR","DDDRRRDDDDRRDDDRRDDDDDDDDLDLDDDLL","DDLLDDDDDDLLLLLUULLLDDDLLLLLLLLL","LUUURRRDDRRRRDDDRRRDDDDDDDRRRRDDDDDDDLLLLL","DLLDDDDDDLLLLLUULLLDLDDLLLLLLLLUULLLDDLLDLLDDDD","DRRRDDDDDLLLLUULLLLDDDLDLDDDDDDDDLLDDDLLLUU","DDRRRDDDDDDDRRRRDDDRRRDDRRRRRRRUUURRUU","RWDDDDDLLLLUULLLDDDLLDLDDDDDDDDDLLDDLLLUULLLLLLU","DLDDDDLLLLUULLLULUUUULLUUULUUULULLLLLLLU","DRRDDRDDDDRRRRDDDRRRDDRRDRRRDDRRRRRRRDR","DDDDDDDRRRRWDDDRRRDDRRRRWRRRUUURRUURRR","DDDDDLDDDLLLDDRRRDDDDDDLLLUULLLLULLLL","DDDLLLLUULLLLUUUUULLUUUUUUULLLLLLLLLLLDDDDL","DDDDRRRRRDDRRRRDDDRRRDDRRRRRDUWRWWLDURR","RRDRRRDDRRRRUUUURRRRUUUULLUUURURRURRRRRRRD","DDDDWRDDRRRWRDDDRRRDDDRDRDRRWWRRRRRRRWWWRDWWUL","DDDDDDDLLLDDRRRDDDDDDLLLUULLLLDLL","DWRRURRRDDRRRRURUURRRRDWWWWWWURRRDDRRRRUUU","RRRRDDRRRRRUUURRRUUUUULLUUURRRDDRRRRDDDRRRRURR","RRDDRRRRRWRRRDLLLWWWWWWRDDDDDDDRRRDDDRRRRRRRRRUR","DRDDLDDDLLLDDRRRDDRDDRDRRRRRRRRRRRUUWRWU","LLLLDLLLLUULLLDLDDLLLLLLLLUULLLLUUURRRUUUULLL","URRLLUUURRRRWWWWWRURRUURRRUUUUURRRRRRRURRRRRRRUUURR","RRRRUUUURRRRUUUULLUUURURRURRRRRRRDRR","RUUUUUUUULLUUURRURWURRRRRRRRRURRR","RRDDRRRRDDDRRRDDRRRRRRRUUURRUURRRUURURURR","URRRRUUUUUUUULLUUUUURRRRRRRRRRUURRR","UULLLLUULLLULUUUULLUUULUULUULLLLLLLDDDDL","ULWULLLLUULLLDDDLLLLLLLLLUULLLLLUU","RRRRDDDRRRDDDRDDRRRRRRRRRRRURRRRDD","UUUURRRWDWRDDRRRRDRRRUUURRRRRUUUURRRDDRRRWRU","DDRRRDDRWWRRRRRRUUURRUURRRUUUUURUUUUURRUUUUUULLUU","DDDLLLLLUUUUUUULLULLLLUULLLUUURRUUUUU","LLDDDLLLLLUUUUUUUULLLLLLUULLLU","RUUULLUUUUUURRUURRUURRUURRRUUUUURRRRRRRURRRRRRRRDD","RRUUUUUUUURRUUUUUUUULLUUUUURRRRRRRRRRRURR","LLLUUUUUUULLDWWUULLLLUULLLUUURRUUUUUUULL","LUUUUUUULLUULLLLLLUULLLULUUUULLUUURRRD","URWRUUULLUUUURURRURUUUURRUURRRUUUUURRRRRRRUUWWWDRRRRR","URRUUUUUUULLULUWLLLLLUULLLUWWWWLUUUULL","URRRRDRRRRRDDRRRRRRRRUUUURRUUURRUURRRUWUUUUURUU","LUULLUUULLUUUUUURRUUURURRRUURRRUUUUURRRRRRRURRRRRRRUUUR","UUUUUUUUULLLUULLLLLUULLLULUUUULLUUURRWWWWWWWUWRWURRR","UUUUUULLUUUULUUUURRUUUUUUUUURUUR","LUUUUUUUUUULUWLLLLLUULLLUUURRUUUULLLUUU","LLLLLLLUULLLUUUUUUUURRWWUUUUUUUUULLUUURWWWWU","LLLLLLLLLLLUUUUUUUUUUULLLLLLUULLLLUURURR","UUUWWWWURRUUURRUURRRUUURUUUUUUURRUUUURRUU","WULLLLLLLUULLULUUUUUUUULUUUURRRUUUULLUUUWWUUUUUR","UUUUURRUUULLUUUURRRURUUUUURRUURRRUUUUURRRRRRRURRRRRRRUU","URUUUUUUULLUUUURRRRUUUUUURRUURRRUUUUURRRRRRRURRRRRRRRR","UUURRRRDDRRRUUURRRRRWURRUUURRUURRRUURRRRRUUUUU","UUUUURUUUUUUULLULLLLUULLLUUURRUURRRU","UUUUUUUUUUUURUWLLUUUURRRUUUULLUUUURRRDWWWWWWWUURRRRRR","UULLUUUUUUUUUUULUUURRRUUUUULLUUURRUU"]},"manji:4":{"makespan":9,"moves":18,"lb":{"makespan":8,"moves":16},"starts":[11,10,12,24],"goals":[7,14,22,0],"paths":null},"manji:8":{"makespan":22,"moves":79,"lb":{"makespan":8,"moves":35},"starts":[17,20,12,15,9,13,2,4],"goals":[14,4,24,15,20,11,10,1],"paths":null},"manji:12":{"makespan":37,"moves":140,"lb":{"makespan":8,"moves":48},"starts":[14,11,13,24,10,23,4,0,1,17,15,12],"goals":[4,0,1,7,20,22,24,15,14,23,2,10],"paths":null},"game:10":{"makespan":24,"moves":166,"lb":{"makespan":24,"moves":166},"starts":[371,240,306,359,137,345,208,279,158,22],"goals":[81,112,200,286,316,395,121,314,185,277],"paths":null},"game:20":{"makespan":28,"moves":300,"lb":{"makespan":28,"moves":282},"starts":[81,395,85,356,335,71,302,236,387,325,392,163,289,274,23,116,348,162,120,78],"goals":[235,329,385,87,109,88,48,270,317,389,42,310,121,126,348,30,271,280,234,55],"paths":null},"game:30":{"makespan":29,"moves":514,"lb":{"makespan":28,"moves":466},"starts":[163,213,32,195,89,316,320,327,269,251,164,200,358,93,34,117,99,389,321,239,88,352,282,128,29,388,381,126,313,289],"goals":[143,26,202,166,358,269,308,87,124,115,89,356,198,234,310,164,91,344,137,183,321,159,93,251,274,302,129,295,362,397],"paths":null},"game:50":{"makespan":30,"moves":777,"lb":{"makespan":28,"moves":657},"starts":[281,112,42,26,46,65,396,394,117,352,22,369,202,383,269,236,78,87,67,24,357,395,31,92,128,335,156,74,388,392,282,295,99,121,237,271,52,289,389,313,193,325,309,55,86,131,79,277,81,278],"goals":[81,237,299,318,383,175,302,329,345,277,125,396,313,386,316,358,390,99,88,166,235,371,52,359,314,295,58,124,196,311,27,352,286,205,30,96,240,159,190,317,195,293,397,208,369,206,395,77,162,393],"paths":null},"game:100":{"makespan":87,"moves":2481,"lb":{"makespan":29,"moves":1513},"starts":[371,271,185,25,281,369,82,92,126,131,232,358,205,137,286,343,335,391,268,93,261,253,191,158,26,78,207,385,345,117,235,395,143,356,306,116,84,234,329,46,348,349,302,200,236,316,359,386,289,52,352,80,311,87,183,353,175,125,71,91,392,339,192,31,55,107,273,283,389,115,156,390,206,159,274,387,130,118,203,382,378,278,309,42,74,120,193,325,318,129,259,194,89,279,199,251,223,198,180,312],"goals":[20,22,25,27,29,31,34,36,42,52,61,71,77,79,81,83,85,87,89,91,93,99,101,107,109,115,117,120,122,124,126,129,131,137,147,158,160,162,164,175,180,185,190,193,196,198,199,200,202,205,208,213,223,234,236,238,240,251,261,267,269,272,274,276,278,281,283,289,299,305,309,311,313,315,317,321,325,329,335,339,343,346,348,350,352,354,356,359,362,369,371,378,382,384,386,388,390,392,394,396],"paths":null},"pinwheel:4":{"makespan":8,"moves":30,"lb":{"makespan":8,"moves":30},"starts":[14,48,85,51],"goals":[48,51,14,85],"paths":null},"pinwheel:8":{"makespan":6,"moves":40,"lb":{"makespan":6,"moves":32},"starts":[14,51,85,48,34,53,65,46],"goals":[74,57,25,42,54,55,45,44],"paths":null},"pinwheel:12":{"makespan":8,"moves":62,"lb":{"makespan":8,"moves":54},"starts":[14,24,25,48,47,57,85,75,74,51,52,42],"goals":[25,57,74,42,34,46,65,53,14,48,85,51],"paths":null},"pinwheel:20":{"makespan":15,"moves":144,"lb":{"makespan":6,"moves":64},"starts":[25,35,45,46,47,57,56,55,65,75,74,64,54,53,52,42,43,44,34,24],"goals":[14,65,51,46,74,34,57,53,25,75,42,47,64,24,56,52,35,85,43,48],"paths":null},"hundred:10":{"makespan":41,"moves":247,"lb":{"makespan":41,"moves":245},"starts":[751,937,843,714,426,835,316,700,498,983],"goals":[756,658,452,969,61,50,747,39,382,598],"paths":["RRRRR","DRRRRRRRUUUUUURRUUUU","UULLLLLLLLUUUURUUUUUU","DRDDDDDDDLL","LUUURURURRRRRRRRRRRRRRRRRURUUUUUU","RRUURURRRUUUUUUUUUUUUURURURRRRRRRUUUUUUU","LLULLLLLLDDLDDDDDDDDDDDDDLLLLLLLL","UUUUUUUUUUULUUULLLLLLLLLLLLLLLLLLLLUUUUUU","RUUUUURURURRRRRRRURRDDDD","LLUUUUULULUUUUUURRR"]},"hundred:20":{"makespan":51,"moves":482,"lb":{"makespan":51,"moves":476},"starts":[473,254,328,165,280,508,985,746,949,724,116,274,212,860,737,987,707,304,380,589],"goals":[231,230,489,56,749,245,97,272,552,622,308,665,730,321,227,226,515,985,764,904],"paths":["URWRRUUULUULLLLLLLLLLLLULLLLLLLL","LLLLLLLLLLLLLLLLLLLLLLLL","DDDDDR","DDRRUUUUUURRRRRRRRRRRRRRRRR","LLLDLLLDDDDDDDDDDDDLDLDLLL","UULRUUUUUULLLLLLL","LLLLLLLLLLLLLLUUUUUULLUUUUUUUULUUUUUUUULLLULLLUUUUL","ULUUUUUULUURUUUUUURRRRRRR","UUUUUULLLLLLLLLLULULULUUU","ULUUULLLLDL","DDDDDD","DDDDDDDDDRDRRRDDRRR","DDDDLDDDDDDDDDDDDDRRRRRRRU","ULULLLLLLLLLLLLLLLLLLLLLLLLLLUUUUUUUUUUUUUU","UUUUUUUUUUUUUUUURRWWWWWWWWWWWWWWWWWWWWWWWWWWDWWU","LLLLLLLLLLLLLLLLUUUUUULLUUUUUUUULUUUUUUUULLLULLL","UUUUUU","RDRDDDDDDDDDDDDDDRRDRDDDDDRRRR","DWDDDDDDDDDDD","RRRRRDDDDLLDDDDDDDDLLLLLLLUUL"]},"hundred:30":{"makespan":53,"moves":680,"lb":{"makespan":53,"moves":672},"starts":[370,449,467,299,165,234,892,899,267,790,367,366,46,556,380,408,47,281,598,941,114,261,460,900,215,873,840,189,833,257],"goals":[262,907,270,34,867,788,590,389,581,641,203,398,855,782,235,776,89,939,264,707,526,714,682,155,791,233,178,568,172,330],"paths":["UUULLLLLLLLLLLL","DDDDDDDDDDRRRRURRDRRRRDDDD","LUUUULUULLL","LLLULLLLULLUUUUUU","DDLDDDLDDDDDDDDDDDDDDDDD","RRRRRRRRRDDDDDDDDDDDDDDDDDR","LLUUULLLLLLLLUUUUUULLLL","UWUUUUUUUUUURUURUUU","LLLLLLDLDLDDDDRDDDDR","LLLLLLLLLLWLLLLLLLLLLLUUUU","DDLLLLLLUUURURUUU","D","RRRRDDDDDDDDRDDDDDDDDDDDDDDRRRRRRRDDDLLL","DRRRRRRDDDDDLDLLL","UUULULLLLLLLLLLLLLLLL","DDDDDDLLLLLDDDDDLLLLLLDLLLLL","RRRRRRRRRRD","LLLLDLDLDDDDDDDDDDDDDDLLLDDDDDDLLLLLU","LLLUUUUUULUULULULULLDLLLLL","DLLUUUUUULLLLLLLUWWWLU","DDDDDDDDDDDDDDDLLLUUL","RRURDDDDDDDDDDDDDRDDR","ULLLDDDDDDDDR","RUUUUURRRRRRRRRRRURURUUUUUURUUUUURUUURRRUUUUUURRRDDRD","DLLLDLDWDDDDDDDDDDDDRDDRRRD","DDDRRUUUUUULUULUUUUUUUUUUUUUUU","URURRURRRRRURURUUUUUUUUUUUUUUUU","DDLDDDDDDLLLDDDDL","RRRRUURRRRUUUUUUUUUUUUUUURRURUUU","URRRRRRRRDDDR"]},"hundred:50":{"makespan":47,"moves":1118,"lb":{"makespan":47,"moves":1074},"starts":[967,485,89,944,73,568,261,427,431,914,90,790,174,715,936,238,54,467,399,59,673,355,208,393,243,456,185,347,151,79,165,260,611,655,271,932,761,493,648,925,329,47,547,794,36,200,308,444,859,100],"goals":[226,682,183,338,780,926,681,421,757,795,49,271,702,807,786,242,613,340,954,86,655,770,492,41,232,382,971,957,228,237,117,941,337,910,552,48,498,939,78,559,815,208,535,55,146,515,306,196,161,593],"paths":["LLUUUUULLULLUUUUUUUUUUUUUUUUURWWWWWWWWWWWWWUD","DDDDDLLDDDRRRRRRRUU","ULLDDDD","UUUUUUURRUUUUUUUUUUUU","ULLDDDDDDRDDDDDDDDDRDDDDDDDRRRD","UUUURRRRDDDDDDDDDDDRDRDDD","RRRRDDDDDDDDDDLDDRDWWWWWDRLU","LLLUUUUULLLLLDDDDRDR","DDDDDRRRRDDDRDDR","RRRUUUURRRRRR","LULLLLLLLLWLDUR","ULULULUULUUUUUUUUULULUL","DDRRRDRRRURRRRRRRRRWWRDDDDDDDDDDDDDD","DDLLDLL","DRRRUUUUUURRRRRRR","RRRRWWWWRWLWWWWWDWU","LLLDLDDDDDDLLLLLLLLLLLLLLDDLDDDDRRDDDDD","UUUUR","DDDDDDRRRRDDDDRDDRRRRRRDDDDD","LWLLLDL","DDDRRRRRRRRRRRRRRRUURURUUULLLDD","DDDDDDDDDDDDDL","DDLLLLLLLDDDDDRRRDD","LUUUUUUWWWLUUUUURR","LLDLLULLLLLLL","UUUUURRRURRRURRRRRRRRRRRRRRRRDDDD","DDDLLLLDLLDDDDDDDDDDDDDLLLDDDDDDDDLLLLL","WRLRDDDDDDDDDDDDDDDDDDDR","DDDLLLLWDLLLLLLLLLLLLLULL","LULLDDDDDDR","DDRRRRRRWDRRRURRRRRRUUUUR","DDLDDDDDDDDDDDDDRDDDDDDDRRRRRRRRRU","RUUUUUUULUURURURRRDRRRURRRURRRDDD","UURRRDDDLDDDLDDDDDDLLUU","LLLLDLDLDDLDDDDD","UUUUUURRRRRUUUUUUUUUUUUURURUURUUUUUURRRR","LLLLLLLUUUUUUURLU","UULLLLDDDDDDDLRDDDDRRDDDDD","UUUUUUUUUUURURURURUUUUURRD","UUUULULLLLLLLLLUUUULULLLU","DDDDDDDDDDDRDRDDRRRRD","RRRDDDDDDLLU","DDDDDDRRRRRRRRRRRRWRRRUURUUURRRUUR","RRRRUUUUUUUUUUUUUUUUUUUUUUULLLLLLL","RRWRRRRRRRRRRRRDDD","DLDLLDLLWWWDDDDDDD","LL","UUUUULLLLLLLLLLLLLLLLLLLLLULLUL","ULUULLLLLULLLUUUULLLLUUUUULLLLLLUUUUULLLLLULLUU","UURRRDDDDDDRDDRDDDDRRRRDDDDDRRRR"]},"hundred:100":{"makespan":48,"moves":2441,"lb":{"makespan":45,"moves":2285},"starts":[45,236,597,439,904,936,266,417,293,241,374,428,227,267,186,633,740,957,792,279,986,795,535,970,80,508,513,942,36,421,846,377,248,380,443,318,944,189,245,71,853,748,249,165,935,537,298,889,722,747,705,826,638,816,574,921,262,972,524,932,503,691,259,125,66,146,956,631,399,376,122,930,809,252,167,558,50,568,665,361,82,162,855,659,274,371,215,756,93,616,949,739,630,197,265,296,613,566,681,337],"goals":[470,449,42,829,771,517,894,521,183,777,794,761,246,498,861,834,257,665,724,186,49,989,476,286,425,740,434,414,364,807,725,789,100,743,298,980,553,489,181,645,990,833,559,702,787,613,68,802,974,811,903,520,417,591,808,957,387,721,964,264,38,126,897,791,83,493,722,579,662,545,55,225,61,365,762,314,86,65,250,461,119,488,916,962,176,130,946,766,784,52,76,636,167,977,815,350,409,537,853,260],"paths":["LDDDDDDDRRRRDRDRDDDDRDDDDRRRUUUU","LLLDDDDDDDDDDDDLDRDDDDLLLLLDLLLWWWWUDUUUUUUUUUUU","LLUUUUUUUUULUUUUUUUULLLLLLLLWWWWWWDU","RWRRRRDDDDDDDDDDDDR","LDDLLLLUUUUULUWRWWWWWWWWWWWWWWWWWWDUWWUD","DLLLUUUULUULWWWUUUUUUUURR","RRRRRRRRRRRURRRRRRRRRDDDDDDDDDDDDDDDDDDDD","UUUUUURRRDRRRRDRDDDDDDD","WURRRRRRRRRRRRURRRRRRUU","LLLLLLLWDDDLDDDDDDLDDDRDDDWDWD","DDRRRRRRDDDDDDDDLDLDDWWWWDU","DRDDDDRRRRRDDRDRWWLDWDRRRRRRWWWWWWWWWWDU","RWRRDWRRRRRRRRRRURRRRRR","RRRRRDRDRDDDDDWRWLWWWWWRL","DRDDDDRDDDDDDDDDDDDDDDDR","LLLULLLDDDDLDLLLLLLLDLLLLLLDDLLL","DLLWWWLUUUUUUUUUUUUUUUU","UUUUULULLLLLLLLLUUUUURRRDRDRR","LLLLUU","RRRUUU","UUUUUULLLULLLLUUUWUUUULUUUUUUUUUUUUUUUL","DDDDRDDR","RUURWURRWWRD","RRRRRRUUUUUURRUUUUWRUURRRUUUUURRRRRRUUUUUURRD","ULLLLDDDDDLWDDDLDLDDDWWWDU","DDDDDDDLLDLLLLLLLLLLLLLLLLLLLLLL","UUUUUUUUURRRRRRDRRRRURRRDRRDRDRDDD","DRRUUUUUUUURRUURUURRRUUUUURRRRRRUUUUUURRDDDDD","RRRDDDDDRDDDDDDDRRRRUU","DDDDDLLDDDDDRRRRDD","LDDDRDRRUUUUUURRRRRUU","DDRRRDDDDDDDDDDLLLLLLLD","LLLLLLLLLLLLUUUUUULLLLLLLDDL","DDDDDDDDDDLDDLLLLLLLLLLLLLLLLLLLL","WWRUUUUULLLLLLLLLLLLLLLLLDL","DDDDDDDDDDDDDDDDDDLLDDDLLLLLLLL","UUUULULLLLUUWLULUUUU","DDLLLLLLLLLLLLLLLDLLLLLDDDDLDDRD","UU","DDDDWDLLDDLLDDDRDDDDDRDDD","UUURRRRDRDRDDRRDRDD","DLLLLLLLLLDLDL","DULDLLLDLDLLDDDDDDDDLLLU","DDRRDRRRRRRRRRRURRRRRRRRURRDRRRDDDDDDDDDDDDDD","RRDRRRRRRRUUUUUURRR","DLDLLLLLDDDDDLLLLLLLLLLLLLLLLUUURUR","UWULLWLWUUUUUULLDL","DLDDLLLLLLLLLLLLLLLLLLLLLLUUUUU","DRRRDDDDDLDLLDLLLL","DD","DDDRDDDRRDRDRRUU","ULLLLLLLLLULLLLLLULWLUULUUUU","DDDDDLLULWLLLLLLLLLLLLLLLLDLLLLLLLLLLUUUUUUUUUUU","UUURURUUWUUDLLLWWWWWWWDU","DDDDDDDLWLLLLLLLLULLLLLLLLLLLLLDD","DRRRR","LLDDLDDWWWWWWWDU","RRRRUUUUUURWUUWWWWWWWWLR","UUULLLDDDDDDDDDDLLLLLDDDDDDD","UUUURUURRRRURULUUUUUULUUUUUUU","DDLWWDLLLUUUUUUUULUULLULLLLUUUUUULLLLLL","LUUUUUUUUURUURURURRRRRRRURUUUUR","DDDDDDDDDDDDDDDRDDDDDLLL","DDDDRDDDDDDDDDDDDDDDDDLLLLLLL","URRRRRRRRRRRRRRRRDR","DDDLLLLLLLLDDDLDDDRRRDDR","UUUUULLULLLLLLLULWWWWWRL","ULLLLDDDLLDDLLLLLLLLLLLLLLUUUUU","DDDDDDRRRRRRRDD","DLWDDDDDDWWWWLLLLLDDDLDDLLLLLLLLLDLLLLLLLUUUUUUU","UULLL","UUULUUUUUUUUUUUUUUUUUUU","UWURRRRRRWRURURUURURRRRUUUURURRRRUUUUUURUUUUUU","LLLLLLLLLLLLLLDLLLDLLDDDDRRRURU","DDDRRRRDWURRRRRDRDRDDRDDDDDDDDDDDRRRRRRR","DRRRRUUUUUWRUUURURURRRRRD","RDURRRD","DLLLLLUUUUUUUULUULLLLLLULLLLLLLLLLULUUUU","UUULUURUURRRUUUUULLU","DLWWRWDRRRRD","URRRRDRD","DDRDRRRRRDDDDDDDWWWWWDU","RRDDDDLLLLLUU","DDDDLLLLLLLLLLLLLLDDDDDLLDL","ULLUU","UUUULLLLLLLLLLLLLLLLLUUU","WDDLLDLDLLDDDDWDDDDDDDDDDLLDDDDDDRRU","RRRRRRRDRDRUWWWRUWWWDDUUWWWWWWWWWWWWDLRU","DDDDDLLLLLLLDLLLDDDDDDDDDDDDDDDLLLD","UUUUUUUURUUURURRRRRRRRUUUUUURR","UUUULULUULUURUUUUUUULUUULUUULLLLLUUUUU","RRRRRRRRRRRRDWRRRRRRRRRRURRUURUU","ULLLUUUUUUUUUULLLLLLLLULLLULU","DRRRLDRDDDDDDDDDDDDRDRDDDRRRRRRDDDDDDR","DDDDDDDDDDDDDDDRDRRRRRD","URRRRRRRRRRRRURRRRRURRDRRRUWWWWWWWWWWWWWDDDD","LDLDDDRRRRRRRRRDRRRRRRURUUULUURRRRURRUUUUUR","URRR","DDRRRRRRRRRRDRDRD","UULULLLLLLLLLDLLL"]}};
});

/* difficulty.js — 自動生成 (tools/difficulty.js). 各ステージの difficulty の事前値 d0 とその成分.
 * d0 は LaCAM3 / LNS2 の計測から決まる固定値. プレイヤーの成績によるフィードバック後の値はサーバーが持つ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DIFFICULTY = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {"tutorial:2":{"d0":51,"g":0,"e":0,"t":0.18814,"c":0,"labor":14},"empty:10":{"d0":94,"g":0,"e":0.00725,"t":0.34505,"c":0,"labor":170},"empty:20":{"d0":481,"g":0.01377,"e":0.00725,"t":0.46083,"c":0,"labor":280},"empty:30":{"d0":881,"g":0.03922,"e":0.00725,"t":0.83099,"c":0,"labor":570},"empty:40":{"d0":896,"g":0.03922,"e":0.00725,"t":1.01748,"c":0,"labor":840},"empty:50":{"d0":1159,"g":0.07171,"e":0.00725,"t":1.05374,"c":0,"labor":1150},"random:10":{"d0":442,"g":0.01195,"e":0.00591,"t":0.49557,"c":0,"labor":200},"random:20":{"d0":857,"g":0.03825,"e":0.00591,"t":0.6349,"c":0,"labor":440},"random:30":{"d0":882,"g":0.03825,"e":0.01125,"t":0.94245,"c":0,"labor":600},"random:40":{"d0":1053,"g":0.05724,"e":0.01125,"t":0.94245,"c":0,"labor":960},"random:50":{"d0":1553,"g":0.16197,"e":0.01125,"t":1.18952,"c":0,"labor":1150},"room:10":{"d0":89,"g":0,"e":0,"t":0.32304,"c":0,"labor":200},"room:20":{"d0":1141,"g":0.0704,"e":0.0058,"t":0.96544,"c":0,"labor":540},"room:30":{"d0":1232,"g":0.0852,"e":0.0058,"t":1.02015,"c":0,"labor":690},"room:40":{"d0":1560,"g":0.14673,"e":0.03657,"t":1.71301,"c":0,"labor":1280},"room:50":{"d0":1723,"g":0.20071,"e":0.05071,"t":1.71301,"c":0,"labor":1750},"maze:10":{"d0":864,"g":0.03971,"e":0,"t":0.5616,"c":0,"labor":390},"maze:20":{"d0":1253,"g":0.08831,"e":0.01932,"t":0.91989,"c":0,"labor":940},"maze:30":{"d0":1481,"g":0.12569,"e":0.01932,"t":1.74517,"c":0,"labor":1680},"maze:40":{"d0":1871,"g":0.19087,"e":0.0648,"t":3.28391,"c":0,"labor":2120},"maze:50":{"d0":2090,"g":0.24636,"e":0.0798,"t":3.95631,"c":0,"labor":3000},"warehouse:10":{"d0":339,"g":0.00806,"e":0.01575,"t":0.34505,"c":0,"labor":270},"warehouse:20":{"d0":1129,"g":0.07108,"e":0.01919,"t":0.38908,"c":0,"labor":340},"warehouse:30":{"d0":1287,"g":0.09494,"e":0.01919,"t":0.93439,"c":0,"labor":840},"warehouse:40":{"d0":1291,"g":0.09494,"e":0.01919,"t":0.95952,"c":0,"labor":1240},"warehouse:50":{"d0":1657,"g":0.19874,"e":0.01919,"t":1.10983,"c":0,"labor":1400},"warehouse_hard:10":{"d0":1158,"g":0.07697,"e":0,"t":0.58294,"c":0.7,"labor":270},"warehouse_hard:20":{"d0":1195,"g":0.07697,"e":0.04464,"t":0.66306,"c":1.5,"labor":560},"warehouse_hard:30":{"d0":2012,"g":0.28706,"e":0.09062,"t":1.68202,"c":2.6915,"labor":960},"warehouse_hard:40":{"d0":2423,"g":0.40482,"e":0.20792,"t":3.65503,"c":2.6915,"labor":1600},"warehouse_hard:50":{"d0":2921,"g":0.48267,"e":0.22927,"t":4.77816,"c":3.3,"labor":1950},"hourglass:10":{"d0":107,"g":0,"e":0,"t":0.38908,"c":0,"labor":230},"hourglass:20":{"d0":1087,"g":0.0309,"e":0.08081,"t":2.69863,"c":0,"labor":560},"hourglass:30":{"d0":1735,"g":0.16354,"e":0.08081,"t":2.69863,"c":0,"labor":1200},"hourglass:40":{"d0":1931,"g":0.24774,"e":0.08081,"t":2.69863,"c":0,"labor":1800},"hourglass:50":{"d0":2232,"g":0.44237,"e":0.0977,"t":2.69863,"c":0,"labor":3150},"bremen:10":{"d0":242,"g":0.00299,"e":0,"t":0.70665,"c":0,"labor":660},"bremen:50":{"d0":659,"g":0.01292,"e":0.00054,"t":1.43493,"c":0,"labor":3450},"bremen:100":{"d0":1351,"g":0.05853,"e":0.00421,"t":1.8987,"c":0,"labor":8200},"bremen:200":{"d0":2234,"g":0.13193,"e":0.01509,"t":2.74269,"c":0.004,"labor":17800},"bremen:300":{"d0":2950,"g":0.13193,"e":0.01509,"t":3.63394,"c":0.004,"labor":27300},"empty_but_not_empty:21":{"d0":2854,"g":0.53551,"e":0.58974,"t":4.77816,"c":0,"labor":168},"empty_but_not_empty:22":{"d0":2933,"g":0.53551,"e":0.71185,"t":4.77816,"c":0,"labor":176},"empty_but_not_empty:23":{"d0":3210,"g":0.69952,"e":0.94016,"t":4.77816,"c":0,"labor":207},"empty_but_not_empty:24":{"d0":3406,"g":1.05003,"e":0.94016,"t":4.77816,"c":0,"labor":312},"empty_but_not_empty:25":{"d0":3508,"g":1.18454,"e":1.0044,"t":4.77816,"c":0,"labor":325},"small_tree_1:5":{"d0":1800,"g":0.43489,"e":0.03448,"t":4.77816,"c":1.2,"labor":100,"measured":2411},"small_tree_2:5":{"d0":2000,"g":1.08837,"e":0.30671,"t":4.77816,"c":0,"labor":130,"measured":3004},"small_tree_3:5":{"d0":2200,"g":1.02738,"e":0.7085,"t":4.77816,"c":0.2,"labor":140,"measured":3241},"big_tree:10":{"d0":1400,"g":0.33187,"e":0.31333,"t":3.89194,"c":27.425,"labor":1330,"measured":6500118},"big_tree:20":{"d0":1700,"g":0.90443,"e":0.45839,"t":4.77816,"c":27.425,"labor":3240,"measured":6500118},"big_tree:30":{"d0":2000,"g":1.88667,"e":0.89308,"t":4.77816,"c":123.633,"labor":18090,"measured":2684554789},"big_tree:40":{"d0":2300,"g":2.43274,"e":0.89308,"t":4.77816,"c":132.875,"labor":31040,"measured":3581852941},"big_tree:50":{"d0":2600,"g":2.88196,"e":0.89308,"t":4.77816,"c":141.66,"labor":72050,"measured":4627256679},"temple:10":{"d0":336,"g":0.0073,"e":0.0016,"t":0.60717,"c":0,"labor":310},"temple:20":{"d0":1056,"g":0.05793,"e":0.0016,"t":1.03391,"c":0,"labor":700},"temple:30":{"d0":1598,"g":0.18069,"e":0.0016,"t":1.12867,"c":0,"labor":1320},"temple:40":{"d0":1642,"g":0.18069,"e":0.05708,"t":1.16323,"c":0,"labor":1760},"temple:50":{"d0":1702,"g":0.18069,"e":0.05708,"t":1.99287,"c":0,"labor":2150},"note:5":{"d0":600,"g":0.10258,"e":0.34827,"t":4.23223,"c":0,"labor":135,"measured":1913},"note:10":{"d0":900,"g":0.26531,"e":0.34827,"t":4.23223,"c":0.4,"labor":340,"measured":2311},"note:15":{"d0":1200,"g":0.33128,"e":0.48187,"t":4.23223,"c":2.4,"labor":435,"measured":2526},"note:20":{"d0":1600,"g":0.91704,"e":0.48187,"t":4.77816,"c":5.58,"labor":860,"measured":11546},"note:25":{"d0":2000,"g":1.03835,"e":0.69078,"t":4.77816,"c":5.58,"labor":1225,"measured":11600},"rotation:5":{"d0":1200},"rotation:10":{"d0":2200},"rotation:20":{"d0":2800},"sunflower:10":{"d0":1000},"sunflower:20":{"d0":1400},"sunflower:30":{"d0":1800},"sunflower:40":{"d0":2200},"sunflower:50":{"d0":2600},"clock:12":{"d0":94,"g":0,"e":0,"t":0.34505,"c":0,"labor":192},"clock:24":{"d0":1670,"g":0.20778,"e":0.03004,"t":0.80061,"c":0,"labor":648},"clock:36":{"d0":1754,"g":0.20778,"e":0.0735,"t":1.76989,"c":0,"labor":684},"lattice:10":{"d0":88,"g":0,"e":0.01568,"t":0.32304,"c":0,"labor":130},"lattice:20":{"d0":634,"g":0.02156,"e":0.01568,"t":0.44872,"c":0,"labor":440},"lattice:30":{"d0":979,"g":0.04766,"e":0.04348,"t":0.68464,"c":0,"labor":570},"lattice:40":{"d0":1580,"g":0.15839,"e":0.06597,"t":1.1866,"c":0,"labor":1040},"lattice:50":{"d0":2376,"g":0.46969,"e":0.18267,"t":3.44642,"c":0,"labor":1200},"power_button:16":{"d0":2400,"g":1.69946,"e":0.52237,"t":4.52314,"c":0,"labor":640,"measured":3335},"ceo:50":{"d0":701,"g":0.01457,"e":0,"t":1.42621,"c":0,"labor":3900},"ceo:100":{"d0":1013,"g":0.01457,"e":0,"t":1.92589,"c":0.09,"labor":8300},"ceo:200":{"d0":2040,"g":0.07021,"e":0.0125,"t":2.43759,"c":0.136,"labor":18000},"ceo:300":{"d0":2800,"g":0.12845,"e":0.01739,"t":3.14579,"c":0.136,"labor":30900,"measured":3169},"ceo:500":{"d0":3200,"g":0.40891,"e":0.01996,"t":4.77816,"c":0.474,"labor":75500,"measured":7036},"crab:10":{"d0":1071,"g":0.05177,"e":0.14085,"t":0.34505,"c":0,"labor":110},"crab:20":{"d0":2371,"g":0.32595,"e":0.36437,"t":3.88379,"c":0,"labor":340},"crab:30":{"d0":3000,"g":0.72587,"e":0.90061,"t":4.77816,"c":0.033,"labor":690,"measured":3202},"packed2x9:18":{"d0":3200,"g":1.90333,"e":1.15902,"t":4.77816,"c":0,"labor":108,"measured":3846},"contest001:30":{"d0":1600,"g":0.17906,"e":0.00662,"t":1.60878,"c":11.433,"labor":1500,"measured":196332},"contest001:75":{"d0":2400},"manji:4":{"d0":1200,"g":0.43903,"e":0.125,"t":4.18089,"c":0,"labor":36,"measured":2390},"manji:8":{"d0":1800,"g":0.94999,"e":0.8212,"t":4.77816,"c":0.75,"labor":176,"measured":3278},"manji:12":{"d0":2800,"g":1.79306,"e":1.02294,"t":4.77816,"c":0.917,"labor":444,"measured":3724},"game:10":{"d0":1347,"g":0.10764,"e":0.04688,"t":0.46433,"c":0.7,"labor":240},"game:20":{"d0":1806,"g":0.2247,"e":0.10123,"t":1.69387,"c":0.75,"labor":560},"game:30":{"d0":2000,"g":0.30944,"e":0.26607,"t":2.56091,"c":2.067,"labor":870,"measured":2155},"game:50":{"d0":2800,"g":0.7964,"e":0.55298,"t":4.77816,"c":3.14,"labor":1500,"measured":3219},"game:100":{"d0":3200,"g":1.64261,"e":0.82922,"t":4.77816,"c":7.54,"labor":8700,"measured":37315},"pinwheel:4":{"d0":400,"g":0,"e":0.0625,"t":0.17253,"c":0,"labor":32,"measured":65},"pinwheel:8":{"d0":1200,"g":0.25697,"e":0.15901,"t":3.27232,"c":0,"labor":48,"measured":2056},"pinwheel:12":{"d0":1800,"g":0.25697,"e":0.15901,"t":3.27232,"c":0,"labor":96,"measured":2056},"pinwheel:20":{"d0":2800,"g":0.88955,"e":0.81099,"t":4.77816,"c":0,"labor":300,"measured":3240},"hundred:10":{"d0":303,"g":0.00407,"e":0,"t":0.89244,"c":0.289,"labor":410},"hundred:20":{"d0":761,"g":0.02728,"e":0.01402,"t":0.98699,"c":0.289,"labor":1020},"hundred:30":{"d0":769,"g":0.02728,"e":0.01402,"t":0.98699,"c":0.289,"labor":1590},"hundred:50":{"d0":1600,"g":0.08865,"e":0.01402,"t":1.39083,"c":0.54,"labor":2350,"measured":1296},"hundred:100":{"d0":2400,"g":0.23199,"e":0.03552,"t":3.93145,"c":1.52,"labor":4800,"measured":2061}};
});

/*
 * leaderboard.gs — Human MAPF オンラインランキング (Google Apps Script, スプレッドシートにバインド)
 *
 * デプロイ手順は server/README.md を参照. ビルド (node build.js) で lns2.js + maps.js + このファイルを
 * 連結した dist/leaderboard.gs が生成されるので, それを Apps Script に貼り付ける.
 *
 * シート:
 *   scores … ts, stage, name, makespan, moves, paths…   (1 提出 1 行. 既存データはそのまま使う)
 *            経路は 1 セル 50,000 文字の上限を超えることがある (ceo:500 で最大 7.6 万字) ので,
 *            超える分は F 列の右隣に続けて書く. 読むときは 6 列目以降を連結する
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

// ---------------------------------------------------------------- 経路の保存 (セル上限対策)
// スプレッドシートの 1 セルは 50,000 文字まで. ceo:500 (500 体 x 最大 151 手) の提出は連結すると
// 最大 7.6 万字になり, 1 セルに入れると保存が例外で落ちる. 上限を超える分は右の列に続けて書く.
var PATHS_COL = 6;          // 経路の先頭列 (F)
var CELL_MAX = 45000;       // 1 セルに入れる上限 (50,000 に余裕を持たせる)
var PATHS_MAX = 400000;     // 1 提出で受け付ける経路の総文字数 (正当な解はこれよりはるかに小さい)
function splitPaths_(s) {
  var out = [];
  for (var i = 0; i < s.length; i += CELL_MAX) out.push(s.substring(i, i + CELL_MAX));
  return out.length ? out : [''];
}
function joinPaths_(cells) {
  var s = '';
  for (var i = 0; i < cells.length; ++i) s += String(cells[i] == null ? '' : cells[i]);
  return s;
}

// ---------------------------------------------------------------- ダンプ (バックアップ用)
var DUMP_MAX = 500;
function dump_(sheetName, from, limit) {
  var users = sheetName === USERS_SHEET, custom = sheetName === CUSTOM_SHEET;
  var sh = users ? getUsers_() : custom ? getCustomSheet_() : getSheet_();
  var cols = users ? USER_COLS : custom ? CUSTOM_COLS.length : Math.max(PATHS_COL, sh.getLastColumn());
  var last = sh.getLastRow();
  var total = Math.max(0, last - 1);
  from = Math.max(0, Math.floor(from) || 0);
  limit = Math.min(Math.max(1, Math.floor(limit) || DUMP_MAX), DUMP_MAX);
  var n = Math.max(0, Math.min(limit, total - from));
  var vals = n ? sh.getRange(2 + from, 1, n, cols).getValues() : [];
  var rows = vals.map(function (r) {
    if (users) return { name: String(r[0]), namekey: String(r[1]), salt: String(r[2]), hash: String(r[3]), iter: +r[4], tokenSalt: String(r[5]), serial: +r[6], created: +r[7], lastLogin: +r[8], fail: +r[9], failUntil: +r[10], legacy: !!r[11] };
    if (custom) return { ts: +r[0], id: +r[1], kind: String(r[2]), name: String(r[3]), author: String(r[4]), w: +r[5], h: +r[6], pattern: String(r[7]), stages: JSON.parse(String(r[8]) || '{}'), solvers: JSON.parse(String(r[9]) || '{}'), status: String(r[10]) };
    return { ts: +r[0], stage: String(r[1]), name: String(r[2]), makespan: +r[3], moves: +r[4], paths: joinPaths_(r.slice(PATHS_COL - 1)).split(',') };
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
      if (sheet !== SHEET_NAME && sheet !== USERS_SHEET && sheet !== CUSTOM_SHEET) return json_({ ok: false, error: 'bad sheet' });
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
    if (p.recompute) {
      var rt = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!rt || !equalConst_(String(p.token || ''), String(rt))) return json_({ ok: false, error: 'bad token' });
      var rlock = LockService.getScriptLock(); rlock.waitLock(20000);
      try { return json_(recomputeRatings_()); } finally { rlock.releaseLock(); }
    }
    if (p.rename) {
      var rnt = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!rnt || !equalConst_(String(p.token || ''), String(rnt))) return json_({ ok: false, error: 'bad token' });
      return json_(renameCustom_(p));
    }
    if (p.unpublish) {
      var ut = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!ut || !equalConst_(String(p.token || ''), String(ut))) return json_({ ok: false, error: 'bad token' });
      return json_(unpublish_(p));
    }
    if (p.custom) return json_(customList_());
    if (p.inbox) return json_(inbox_(p));
    var rows = readAll_();
    if (p.ratings) return json_(ratingsResponse_(rows));
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
    if (action === 'publish') return json_(doPublish_(body));
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
  // 投稿は登録済みアカウントのトークン必須 (移行期間は 2026-08-27 で終了. 未登録の名前は受け付けない)
  if (!u) return { ok: false, error: 'login required' + RELOAD_HINT };
  if (!equalConst_(String(body.token || ''), makeToken_(u))) return { ok: false, error: 'bad token' + RELOAD_HINT };
  return record_(body, u.name, false);
}

function record_(body, name, legacy) {
  var v = validate_(body, name);
  if (!v.ok) return { ok: false, error: v.error };
  var sh = getSheet_();
  var ts = Date.now();
  var cells = splitPaths_(body.paths.join(','));
  var need = PATHS_COL - 1 + cells.length;
  if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
  sh.appendRow([ts, v.stage, v.name, v.makespan, v.moves].concat(cells));
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
  var cm = /^c(\d+):(\d+)$/.exec(stage);
  if (cm) return customValidate_(+cm[1], +cm[2], body, name);   // ユーザー投稿マップ (maker.gs)
  var m = /^([a-z_][a-z0-9_]*):(\d+)$/.exec(stage);
  if (!m) return { ok: false, error: 'bad stage' };
  var def = null;
  for (var d = 0; d < MAPS.MAP_DEFS.length; ++d) if (MAPS.MAP_DEFS[d].id === m[1]) def = MAPS.MAP_DEFS[d];
  var N = +m[2];
  if (!def || def.agents.indexOf(N) < 0) return { ok: false, error: 'unknown stage' };
  if (!name) return { ok: false, error: 'bad name' };
  if (!Array.isArray(body.paths) || body.paths.length !== N) return { ok: false, error: 'bad paths' };
  var totalLen = 0;
  for (var q = 0; q < N; ++q) totalLen += String(body.paths[q]).length + 1;
  if (totalLen > PATHS_MAX) return { ok: false, error: 'paths too large' };
  var map = MAPS.getMap(def.id), G = LNS2.buildGraph(map);
  var ins = MAPS.getInstance(def.id, N, G);
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

/*
 * rating.gs — レーティングと難易度のフィードバック (leaderboard.gs と同じ Apps Script に同梱される)
 *
 * 設計 (2026-08-30):
 *   par(stage) = 参考解と人間ベストの (makespan × distance) の小さい方
 *   r = 自分の自己ベスト (makespan × distance) / par   (≥ 1)
 *   y = clamp(1 − ln r / ln YZERO, 0, 1)                 par で 1, 両指標 150% (積 2.25 倍) で 0
 *   絶対評価  P_abs = D + OFFSET + KAPPA·log6(y'/(1−y'))  y' = clamp(y, 0.03, 0.97)
 *   相対評価  P_rel = ステージ内順位から逆算した performance (AtCoder 方式), 人数で減衰, P_abs ± RELCLAMP
 *   P = P_abs + λ·(P_rel − P_abs),  λ = (n−1)/(n+9)
 *   rating    = AHC Rating System ver.2 の式 (Q = {P_i − S ln j}, r = Σ q_i (R^{i−1} − R^i), 400 未満は折り返し)
 *   実力推定  ability = P の減衰付き加重平均 (難易度フィードバックにだけ使う. AHC 式は投稿数が少ない人を低く出すため)
 *   難易度    D = argmax Σ w_i [y_i ln E + (1−y_i) ln(1−E)] − (D−D0)²/(2τ²),  E = 1/(1+6^((D−ability)/400))
 *             y_i は par 到達判定用に ln 2 スケール, w_i = 解いた数/(解いた数+3), D は D0 ± DCLAMP に制限
 *   R と D は相互依存なので反復して収束させる (バッチ). 結果は ratings / stagestats シートに保存する.
 *
 * API:  GET ?ratings=1                 → { ok, updated, players: [{name, rating, solved, atPar, best}], stages: {stage: {d, d0, par, players}} }
 *       GET ?recompute=1&token=<BACKUP_TOKEN> → 強制再計算
 * 再計算は「最終投稿よりシートが古く, かつ前回の再計算から RECOMPUTE_MIN 分以上経った」GET のときに行う (トリガー不要)
 */
var RATING_SHEET = 'ratings', STAGE_SHEET = 'stagestats';
var RT = { KAPPA: 200, YZERO: 2.25, OFFSET: 300, TAU: 300, DCLAMP: 1200, RELCLAMP: 500, DECAY: 0.9,
  S_AHC: 724.4744301, R_AHC: 0.8271973364, ITER: 40, RECOMPUTE_MIN: 10 };
var LN6 = Math.log(6);

function clamp_(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function expect_(R, D) { return 1 / (1 + Math.pow(6, (D - R) / 400)); }
function perfFromRank_(others, rank) {
  var expRank = function (x) { var s = 0.5; for (var i = 0; i < others.length; ++i) s += 1 / (1 + Math.pow(6, (x - others[i]) / 400)); return s; };
  var lo = -3000, hi = 6000;
  for (var k = 0; k < 50; ++k) { var mid = (lo + hi) / 2; if (expRank(mid) > rank) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function ahcRating_(ps) {
  var Q = [];
  for (var i = 0; i < ps.length; ++i) for (var j = 1; j <= 100; ++j) Q.push(ps[i] - RT.S_AHC * Math.log(j));
  Q.sort(function (a, b) { return b - a; });
  var r = 0;
  for (var k = 0; k < Q.length; ++k) r += Q[k] * (Math.pow(RT.R_AHC, k) - Math.pow(RT.R_AHC, k + 1));
  return r >= 400 ? r : 400 / Math.exp((400 - r) / 400);
}

// rows: readAll_() の結果 (ts, stage, name, makespan, moves)
function computeRatings_(rows) {
  var D0 = {}, st;
  for (st in DIFFICULTY) D0[st] = DIFFICULTY[st].d0;
  // writer 採用マップ: 作者自身の成績は par (人間ベスト) には効くが, レーティング計算からは除外する
  var AUTH = {};
  MAPS.MAP_DEFS.forEach(function (d) { if (d.author) AUTH[d.id] = nameKey_(String(d.author)); });
  var isWriterOwn_ = function (s) { var a = AUTH[s.stage.split(':')[0]]; return a != null && a === nameKey_(s.name); };
  // 自己ベスト (総合 = makespan × distance)
  var best = {};
  rows.forEach(function (r) {
    if (!REFERENCE[r.stage] || D0[r.stage] == null) return;
    var k = r.stage + '\t' + nameKey_(r.name), prod = r.makespan * r.moves;
    if (!best[k] || prod < best[k].prod) best[k] = { stage: r.stage, name: r.name, prod: prod };
  });
  var subs = Object.keys(best).map(function (k) { return best[k]; });
  var par = {};
  subs.forEach(function (s) { var ref = REFERENCE[s.stage]; par[s.stage] = Math.min(par[s.stage] || Infinity, s.prod, ref.makespan * ref.moves); });
  subs.forEach(function (s) {
    s.r = s.prod / par[s.stage];
    s.y = clamp_(1 - Math.log(s.r) / Math.log(RT.YZERO), 0, 1);
    s.yFb = clamp_(1 - Math.log(s.r) / Math.LN2, 0, 1);
  });
  // 作者自身の成績を除外 (上の par 計算には含めている)
  var rsubs = subs.filter(function (s) { return !isWriterOwn_(s); });
  var byStage = {}, byPlayer = {};
  rsubs.forEach(function (s) { (byStage[s.stage] = byStage[s.stage] || []).push(s); (byPlayer[s.name] = byPlayer[s.name] || []).push(s); });
  var players = Object.keys(byPlayer);
  var D = {}, R = {}, ability = {};
  for (st in D0) D[st] = D0[st];
  players.forEach(function (p) { R[p] = 1000; ability[p] = 1000; });

  for (var it = 0; it < RT.ITER; ++it) {
    // performance
    Object.keys(byStage).forEach(function (st) {
      var list = byStage[st].slice().sort(function (a, b) { return a.prod - b.prod; });
      // 同率 (makespan × distance が同じ) は AtCoder と同じく順位の平均を使う: 2 位に 3 人なら全員 (2+4)/2 = 3 位
      var rankOf = [];
      for (var i0 = 0; i0 < list.length;) {
        var j0 = i0; while (j0 + 1 < list.length && list[j0 + 1].prod === list[i0].prod) ++j0;
        for (var k0 = i0; k0 <= j0; ++k0) rankOf[k0] = (i0 + 1 + j0 + 1) / 2;
        i0 = j0 + 1;
      }
      list.forEach(function (s, i) {
        var y = clamp_(s.y, 0.03, 0.97);
        s.pAbs = D[st] + RT.OFFSET + RT.KAPPA * Math.log(y / (1 - y)) / LN6;
        if (list.length >= 2) {
          var others = list.filter(function (o) { return o !== s; }).map(function (o) { return R[o.name]; });
          var pRel = clamp_(perfFromRank_(others, rankOf[i]), s.pAbs - RT.RELCLAMP, s.pAbs + RT.RELCLAMP);
          var lam = (list.length - 1) / (list.length + 9);
          s.p = s.pAbs + lam * (pRel - s.pAbs);
        } else s.p = s.pAbs;
      });
    });
    // rating / ability
    var newR = {}, newAb = {}, delta = 0;
    players.forEach(function (p) {
      var ps = byPlayer[p].map(function (s) { return s.p; }).sort(function (a, b) { return b - a; });
      var num = 0, den = 0;
      ps.forEach(function (v, i) { num += Math.pow(RT.DECAY, i) * v; den += Math.pow(RT.DECAY, i); });
      newAb[p] = num / den; newR[p] = ahcRating_(ps);
      delta = Math.max(delta, Math.abs(newR[p] - R[p]));
    });
    // 難易度 (事前値つき最尤推定, 黄金分割)
    var newD = {};
    Object.keys(D0).forEach(function (st) {
      var obs = (byStage[st] || []).map(function (s) { var n = byPlayer[s.name].length; return { R: newAb[s.name], y: s.yFb, w: n / (n + 3) }; });
      var ll = function (d) {
        var a = -(d - D0[st]) * (d - D0[st]) / (2 * RT.TAU * RT.TAU);
        for (var i = 0; i < obs.length; ++i) { var e = clamp_(expect_(obs[i].R, d), 1e-6, 1 - 1e-6); a += obs[i].w * (obs[i].y * Math.log(e) + (1 - obs[i].y) * Math.log(1 - e)); }
        return a;
      };
      var lo = D0[st] - RT.DCLAMP, hi = D0[st] + RT.DCLAMP;
      for (var k = 0; k < 60; ++k) { var m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618; if (ll(m1) < ll(m2)) lo = m1; else hi = m2; }
      newD[st] = 0.5 * D[st] + 0.5 * (lo + hi) / 2;
      delta = Math.max(delta, Math.abs(newD[st] - D[st]));
    });
    R = newR; ability = newAb; D = newD;
    if (it > 5 && delta < 0.5) break;
  }

  var out = players.map(function (p) {
    var ps = byPlayer[p].slice().sort(function (a, b) { return b.p - a.p; });
    var atPar = byPlayer[p].filter(function (s) { return s.r <= 1.02; }).length;
    return { name: p, rating: Math.round(R[p]), ability: Math.round(ability[p]), solved: ps.length, atPar: atPar, best: Math.round(ps[0].p), bestStage: ps[0].stage };
  }).sort(function (a, b) { return b.rating - a.rating; });
  var stages = {};
  Object.keys(D0).forEach(function (st) {
    var ref = REFERENCE[st];
    stages[st] = { d: Math.max(0, Math.round(D[st])), d0: D0[st], par: par[st] || ref.makespan * ref.moves, players: (byStage[st] || []).length };
  });
  return { players: out, stages: stages };
}

// ---------------------------------------------------------------- シート入出力
function getRatingSheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); }
  return sh;
}
var RATING_COLS = ['name', 'rating', 'ability', 'solved', 'atPar', 'best', 'bestStage', 'updated'];
var STAGE_COLS = ['stage', 'd', 'd0', 'par', 'players', 'updated'];

function writeRatings_(res) {
  var now = Date.now();
  var rs = getRatingSheet_(RATING_SHEET, RATING_COLS), ss = getRatingSheet_(STAGE_SHEET, STAGE_COLS);
  rs.clearContents(); rs.appendRow(RATING_COLS);
  if (res.players.length) rs.getRange(2, 1, res.players.length, RATING_COLS.length).setValues(res.players.map(function (p) { return [p.name, p.rating, p.ability, p.solved, p.atPar, p.best, p.bestStage, now]; }));
  ss.clearContents(); ss.appendRow(STAGE_COLS);
  var keys = Object.keys(res.stages);
  if (keys.length) ss.getRange(2, 1, keys.length, STAGE_COLS.length).setValues(keys.map(function (k) { var s = res.stages[k]; return [k, s.d, s.d0, s.par, s.players, now]; }));
  return now;
}
function readRatings_() {
  var rs = getRatingSheet_(RATING_SHEET, RATING_COLS), ss = getRatingSheet_(STAGE_SHEET, STAGE_COLS);
  var players = [], stages = {}, updated = 0, n;
  if ((n = rs.getLastRow()) >= 2) rs.getRange(2, 1, n - 1, RATING_COLS.length).getValues().forEach(function (r) {
    players.push({ name: String(r[0]), rating: +r[1], ability: +r[2], solved: +r[3], atPar: +r[4], best: +r[5], bestStage: String(r[6]) }); updated = Math.max(updated, +r[7] || 0);
  });
  if ((n = ss.getLastRow()) >= 2) ss.getRange(2, 1, n - 1, STAGE_COLS.length).getValues().forEach(function (r) {
    stages[String(r[0])] = { d: +r[1], d0: +r[2], par: +r[3], players: +r[4] }; updated = Math.max(updated, +r[5] || 0);
  });
  return { updated: updated, players: players, stages: stages };
}

// 全投稿から再計算してシートに保存する. ロックは呼び出し側で取る
function recomputeRatings_() {
  var rows = readAll_();
  var res = computeRatings_(rows);
  var now = writeRatings_(res);
  return { ok: true, updated: now, players: res.players.length, stages: Object.keys(res.stages).length };
}

// GET ?ratings=1 の本体. 最終投稿より古く, 前回の再計算から RECOMPUTE_MIN 分以上経っていれば再計算してから返す
function ratingsResponse_(rows) {
  var cur = readRatings_();
  var lastTs = 0; for (var i = 0; i < rows.length; ++i) if (rows[i].ts > lastTs) lastTs = rows[i].ts;
  var stale = !cur.updated || cur.updated < lastTs;
  if (stale && Date.now() - cur.updated > RT.RECOMPUTE_MIN * 60000) {
    var lock = LockService.getScriptLock();
    if (lock.tryLock(5000)) {
      try { var cur2 = readRatings_(); if (!cur2.updated || cur2.updated < lastTs) { recomputeRatings_(); cur = readRatings_(); } else cur = cur2; }
      finally { lock.releaseLock(); }
    }
  }
  return { ok: true, updated: cur.updated, stale: cur.updated < lastTs, players: cur.players, stages: cur.stages };
}

/*
 * maker.gs — ステージメーカー (ユーザー投稿マップ) のサーバー側 (leaderboard.gs と同じ Apps Script に同梱)
 *
 * custom シート: ts, id, kind('public'|'writer'), name(マップ名), author, w, h, pattern('.@' 行優先),
 *                stages(JSON {"N": {starts:[], goals:[]}}), solvers(JSON {"N": {solver, makespan, moves}}), status
 *
 * API:
 *   POST { action:'publish', name, token, kind, map:{ name, w, h, pattern, stages, solutions } }
 *     - stages   = {"N": {starts, goals}}
 *     - solutions = {"N": {paths:[...], solver:'人力'|ソルバー名}}  … 全ステージ分. サーバーで検証してから捨てる
 *                  (解けることの証明. スコアとソルバー名だけ solvers 列に残す)
 *     - kind='public' は誰でも / kind='writer' は rating >= WRITER_MIN のみ
 *   GET ?custom=1                     → { ok, maps:[{id, name, author, w, h, pattern, stages, ts}] }  (public のみ)
 *   GET ?inbox=1&name=..&token=..     → { ok, maps:[...writer 投稿全部 (solvers 込み)...] }  (管理者のみ)
 *
 * 公開マップのステージ key は "c<id>:<N>" (例 c3:20). leaderboard.gs の validate_ から
 * customValidate_ が呼ばれ, ランキング (scores シート) は公式ステージと同じ仕組みで付く.
 * rating / difficulty の計算は DIFFICULTY に無いステージを無視するので, 公開マップは自動的に unrated.
 */
var CUSTOM_SHEET = 'custom';
var CUSTOM_COLS = ['ts', 'id', 'kind', 'name', 'author', 'w', 'h', 'pattern', 'stages', 'solvers', 'status'];
var MAKER = { MIN_WH: 4, MAX_WH: 50, MIN_N: 1, MAX_STAGES: 5, MAX_NAME: 24, MAX_PATH: 5000, WRITER_MIN: 1800 };   // 台数の上限は空きマス数

function adminName_() { return PropertiesService.getScriptProperties().getProperty('ADMIN_NAME') || 'mech_39'; }

function getCustomSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(CUSTOM_SHEET);
  if (!sh) { sh = ss.insertSheet(CUSTOM_SHEET); sh.appendRow(CUSTOM_COLS); }
  return sh;
}
function readCustom_() {
  var sh = getCustomSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, CUSTOM_COLS.length).getValues().map(function (r) {
    return { ts: +r[0], id: +r[1], kind: String(r[2]), name: String(r[3]), author: String(r[4]),
      w: +r[5], h: +r[6], pattern: String(r[7]), stages: JSON.parse(String(r[8]) || '{}'), solvers: JSON.parse(String(r[9]) || '{}'), status: String(r[10]) };
  }).filter(function (m) { return m.status === 'ok'; });
}
function customById_(id) {
  var ms = readCustom_();
  for (var i = 0; i < ms.length; ++i) if (ms[i].id === id) return ms[i];
  return null;
}
function stripCustom_(m, withSolvers) {
  var o = { id: m.id, name: m.name, author: m.author, w: m.w, h: m.h, pattern: m.pattern, stages: m.stages, ts: m.ts };
  if (withSolvers) { o.solvers = m.solvers; o.kind = m.kind; }
  return o;
}

// マップとステージ定義の検証. 問題なければ { map } を返し, ダメなら { error }
function checkCustomMap_(body) {
  var mp = body.map || {};
  var w = Math.floor(+mp.w), h = Math.floor(+mp.h);
  if (!(w >= MAKER.MIN_WH && w <= MAKER.MAX_WH && h >= MAKER.MIN_WH && h <= MAKER.MAX_WH)) return { error: 'bad size' };
  var pattern = String(mp.pattern || '');
  if (pattern.length !== w * h || /[^.@]/.test(pattern)) return { error: 'bad pattern' };
  // マップ名: cleanName_ はプレイヤー名用 (16 文字で切る) なので使わない
  var name = String(mp.name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAKER.MAX_NAME);
  if (!name) return { error: 'bad map name' };
  var free = [];
  for (var i = 0; i < w * h; ++i) free.push(pattern.charAt(i) === '.' ? 1 : 0);
  var map = { w: w, h: h, free: free };
  // 連結か
  var G = LNS2.buildGraph({ w: w, h: h, free: Uint8Array.from(free) });
  var total = 0; for (i = 0; i < free.length; ++i) total += free[i];
  if (total < MAKER.MIN_N || LNS2.largestComponent(G).length !== total) return { error: 'map not connected' };
  var stages = mp.stages || {};
  var ns = Object.keys(stages);
  if (ns.length < 1 || ns.length > MAKER.MAX_STAGES) return { error: 'bad stage count' };
  for (var k = 0; k < ns.length; ++k) {
    var N = Math.floor(+ns[k]);
    if (!(N >= MAKER.MIN_N && N <= total) || String(N) !== String(ns[k])) return { error: 'bad agent count' };
    var st = stages[ns[k]] || {};
    var e = checkPlacement_(map, st.starts, N) || checkPlacement_(map, st.goals, N);
    if (e) return { error: e + ' (' + N + ' agents)' };
  }
  return { name: name, w: w, h: h, pattern: pattern, map: map, G: G, stages: stages };
}
function checkPlacement_(map, arr, N) {
  if (!Array.isArray(arr) || arr.length !== N) return 'bad placement';
  var seen = {};
  for (var i = 0; i < N; ++i) {
    var c = Math.floor(+arr[i]);
    if (!(c >= 0 && c < map.w * map.h) || !map.free[c] || seen[c]) return 'bad placement';
    seen[c] = 1;
  }
  return null;
}

// 経路 (U/D/L/R/W 文字列) がそのステージの合法解か
function checkSolution_(map, G, starts, goals, paths) {
  if (!Array.isArray(paths) || paths.length !== starts.length) return 'bad paths';
  var dec = [];
  for (var i = 0; i < paths.length; ++i) {
    var s = String(paths[i]);
    if (s.length > MAKER.MAX_PATH || /[^UDLRW]/.test(s)) return 'bad path';
    var c = starts[i], p = [c];
    for (var k = 0; k < s.length; ++k) {
      var ch = s.charAt(k), x = c % map.w;
      if (ch === 'R') { if (x === map.w - 1) return 'off map'; c += 1; }
      else if (ch === 'L') { if (x === 0) return 'off map'; c -= 1; }
      else if (ch === 'D') { c += map.w; }
      else if (ch === 'U') { c -= map.w; }
      if (c < 0 || c >= map.w * map.h || !map.free[c]) return 'illegal move';
      p.push(c);
    }
    if (p[p.length - 1] !== goals[i]) return 'not at goal';
    dec.push(LNS2.trimPath(p));
  }
  if (LNS2.findCollisions(dec, G.V, false).count > 0) return 'collision';
  var mt = LNS2.metrics(dec);
  return { makespan: mt.makespan, moves: mt.moves };
}

// POST action='publish'
function doPublish_(body) {
  var key = nameKey_(body.name);
  var u = key ? findUser_(key) : null;
  if (!u || !equalConst_(String(body.token || ''), makeToken_(u))) return { ok: false, error: 'login required' };
  var kind = String(body.kind || '');
  if (kind !== 'public' && kind !== 'writer') return { ok: false, error: 'bad kind' };
  if (kind === 'writer') {
    var rt = readRatings_();
    var mine = null;
    for (var i = 0; i < rt.players.length; ++i) if (nameKey_(rt.players[i].name) === key) mine = rt.players[i];
    if (!mine || mine.rating < MAKER.WRITER_MIN) return { ok: false, error: 'writer requires rating ' + MAKER.WRITER_MIN + '+' };
  }
  var cm = checkCustomMap_(body);
  if (cm.error) return { ok: false, error: cm.error };
  // 全ステージの解 (投稿者が解いた証明) を検証し, スコアとソルバー名だけ残す
  var solutions = (body.map && body.map.solutions) || {};
  var solvers = {};
  var ns = Object.keys(cm.stages);
  for (i = 0; i < ns.length; ++i) {
    var N = ns[i], st = cm.stages[N], sol = solutions[N];
    if (!sol) return { ok: false, error: 'unsolved stage (' + N + ' agents)' };
    var r = checkSolution_(cm.map, cm.G, st.starts, st.goals, sol.paths);
    if (typeof r === 'string') return { ok: false, error: r + ' (' + N + ' agents)' };
    var solver = String(sol.solver || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || '?';
    solvers[N] = { solver: solver, makespan: r.makespan, moves: r.moves };
  }
  // stages は座標だけ残す (余計なフィールドを落とす)
  var stages = {};
  for (i = 0; i < ns.length; ++i) stages[ns[i]] = { starts: cm.stages[ns[i]].starts.map(Number), goals: cm.stages[ns[i]].goals.map(Number) };
  if (JSON.stringify(stages).length > 45000) return { ok: false, error: 'map too large' };   // シートの 1 セル上限対策
  var sh = getCustomSheet_(), all = readCustom_();
  var id = 1; for (i = 0; i < all.length; ++i) if (all[i].id >= id) id = all[i].id + 1;
  sh.appendRow([Date.now(), id, kind, cm.name, u.name, cm.w, cm.h, cm.pattern, JSON.stringify(stages), JSON.stringify(solvers), 'ok']);
  return { ok: true, id: id, kind: kind, name: cm.name };
}

// 公開マップのステージ ("c<id>:<N>") を検証する. leaderboard.gs の validate_ から呼ばれる
function customValidate_(mapId, N, body, name) {
  var m = customById_(mapId);
  if (!m || m.kind !== 'public') return { ok: false, error: 'unknown stage' };
  var st = m.stages[String(N)];
  if (!st) return { ok: false, error: 'unknown stage' };
  var free = [];
  for (var i = 0; i < m.w * m.h; ++i) free.push(m.pattern.charAt(i) === '.' ? 1 : 0);
  var map = { w: m.w, h: m.h, free: free };
  var G = LNS2.buildGraph({ w: m.w, h: m.h, free: Uint8Array.from(free) });
  var r = checkSolution_(map, G, st.starts, st.goals, body.paths);
  if (typeof r === 'string') return { ok: false, error: r };
  return { ok: true, stage: 'c' + mapId + ':' + N, name: name, makespan: r.makespan, moves: r.moves };
}

// GET ?custom=1 / ?inbox=1
function customList_() {
  return { ok: true, maps: readCustom_().filter(function (m) { return m.kind === 'public'; }).map(function (m) { return stripCustom_(m, false); }) };
}
// GET ?unpublish=<id>&token=<BACKUP_TOKEN> — 投稿マップを非表示にする (行は監査用に残し status を 'deleted' に)
function unpublish_(p) {
  var sh = getCustomSheet_(), last = sh.getLastRow();
  var id = Math.floor(+p.unpublish);
  for (var row = 2; row <= last; ++row) {
    if (+sh.getRange(row, 2).getValue() === id && String(sh.getRange(row, 11).getValue()) === 'ok') {
      sh.getRange(row, 11).setValue('deleted');
      return { ok: true, id: id };
    }
  }
  return { ok: false, error: 'not found' };
}
// GET ?rename=<id>&mapname=<新しい名前>&token=<BACKUP_TOKEN> — 投稿マップの名前を直す (16 文字切り詰めバグの修正用)
function renameCustom_(p) {
  var name = String(p.mapname || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAKER.MAX_NAME);
  if (!name) return { ok: false, error: 'bad name' };
  var sh = getCustomSheet_(), last = sh.getLastRow();
  var id = Math.floor(+p.rename);
  for (var row = 2; row <= last; ++row) {
    if (+sh.getRange(row, 2).getValue() === id && String(sh.getRange(row, 11).getValue()) === 'ok') {
      var old = String(sh.getRange(row, 4).getValue());
      sh.getRange(row, 4).setValue(name);
      return { ok: true, id: id, from: old, to: name };
    }
  }
  return { ok: false, error: 'not found' };
}
function inbox_(p) {
  var key = nameKey_(p.name);
  var u = key ? findUser_(key) : null;
  if (!u || !equalConst_(String(p.token || ''), makeToken_(u))) return { ok: false, error: 'login required' };
  if (nameKey_(u.name) !== nameKey_(adminName_())) return { ok: false, error: 'admin only' };
  return { ok: true, maps: readCustom_().filter(function (m) { return m.kind === 'writer'; }).map(function (m) { return stripCustom_(m, true); }) };
}
