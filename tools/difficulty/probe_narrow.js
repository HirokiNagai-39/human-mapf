// probe_narrow.js — 「幅 1 の通路での正面衝突」の構造指標
//   幅 1 の通路 = 隣接マスが 2 つしかないマス (行き止まり・角も含む). 両端がそのようなマスの辺を
//   最短経路で逆向きに通るエージェントのペアは, どちらかが通路の外で待つか大回りするしかない.
//   C = そのペア数 (辺ごとに数え, 同じペアの複数辺は 1 回) / N   … 1 台あたり何組の「すれ違い不能」を抱えるか
'use strict';
const fs = require('fs');
const L = require('../../src/lns2.js');
const M = require('../../src/maps.js');
const out = {};
for (const d of M.MAP_DEFS) for (const N of d.agents) {
  const map = M.getMap(d.id), G = L.buildGraph(map);
  const ins = L.generateInstance(G, N, M.stageSeed(d.id, N));
  const deg = c => G.nbrCnt[c] - 1;   // nbr[0] は自分自身
  // 「幅 1 の通路」= 隣接 2 以下で, かつ障害物に接しているマス (マップ外周の角は除く. 小さいマップで外周が誤って該当するのを防ぐ)
  const hasObstacle = c => { const x = c % map.w, y = (c / map.w) | 0;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < map.w && ny < map.h && !map.free[ny * map.w + nx]; }); };
  const narrow = c => deg(c) <= 2 && hasObstacle(c);
  const sp = ins.starts.map((s, i) => L.shortestPath(G, s, ins.goals[i]));
  // 幅 1 の通路の辺 (両端とも隣接 2 以下) を u→v 向きに使うエージェントの集合.
  // 1 マスだけの扉 (room) や首 (hourglass) は 1 手待てば済むので数えず, 長い通路ほど重くする:
  // ペア (i, j) の重み = 逆向きに共有する狭い辺の本数 − 1
  const use = new Map();
  sp.forEach((p, i) => {
    for (let t = 1; t < p.length; ++t) {
      const u = p[t - 1], v = p[t];
      if (u !== v && narrow(u) && narrow(v)) { const k = u + ':' + v; if (!use.has(k)) use.set(k, new Set()); use.get(k).add(i); }
    }
  });
  const shared = new Map();
  let narrowSteps = 0;
  for (const [k, A] of use) {
    narrowSteps += A.size;
    const [u, v] = k.split(':');
    const B = use.get(v + ':' + u); if (!B) continue;
    for (const i of A) for (const j of B) if (i < j) { const pk = i + ',' + j; shared.set(pk, (shared.get(pk) || 0) + 1); }
  }
  const pairs = { size: 0 };
  for (const [, len] of shared) pairs.size += Math.max(0, len - 1);
  let narrowCells = 0; for (let c = 0; c < G.V; ++c) if (map.free[c] && narrow(c)) ++narrowCells;
  out[`${d.id}:${N}`] = { headOnPairs: pairs.size, C: +(pairs.size / N).toFixed(3), narrowStepsPerAgent: +(narrowSteps / N).toFixed(2), narrowCellFrac: +(narrowCells / G.V).toFixed(2) };
}
fs.writeFileSync(__dirname + '/probe_narrow.json', JSON.stringify(out, null, 1));
console.log('stage                      すれ違い不能ペア  C=ペア/N  狭路歩数/台  狭マス率');
for (const st of Object.keys(out)) { const r = out[st]; console.log(st.padEnd(26) + String(r.headOnPairs).padStart(10) + r.C.toFixed(2).padStart(11) + r.narrowStepsPerAgent.toFixed(1).padStart(11) + r.narrowCellFrac.toFixed(2).padStart(9)); }
