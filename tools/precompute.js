// tools/precompute.js — 全ステージの LNS2 参考解を前計算し src/reference.js に埋め込む
//   node tools/precompute.js [seeds=8] [timeLimitSec=5]
const fs = require('fs'), path = require('path');
const L = require('../src/lns2.js'), M = require('../src/maps.js');
const SEEDS = +(process.argv[2] || 8), TL = +(process.argv[3] || 5) * 1000;

function encodePath(p, w) {
  let s = '';
  for (let t = 1; t < p.length; ++t) {
    const d = p[t] - p[t - 1];
    s += d === 0 ? 'W' : d === 1 ? 'R' : d === -1 ? 'L' : d === w ? 'D' : d === -w ? 'U' : (() => { throw new Error('bad step'); })();
  }
  return s;
}

const out = {};
for (const d of M.MAP_DEFS) {
  const map = M.getMap(d.id), G = L.buildGraph(map);
  for (const N of d.agents) {
    const seed = M.stageSeed(d.id, N);
    const { starts, goals } = L.generateInstance(G, N, seed);
    let best = null, lb = null, tried = 0, solved = 0;
    for (let k = 0; k < SEEDS; ++k) {
      const S = new L.Solver(G, starts, goals, seed + k * 1000003);
      const r = S.solve(TL); ++tried; lb = r.lowerBound;
      if (!r.ok) continue; ++solved;
      if (!best || r.makespan < best.makespan || (r.makespan === best.makespan && r.moves < best.moves)) best = r;
    }
    const key = `${d.id}:${N}`;
    if (!best) { console.log(`${key}: NOT SOLVED`); continue; }
    const paths = best.paths.map(p => encodePath(L.trimPath(p), map.w));
    out[key] = { makespan: best.makespan, moves: best.moves, lb: { makespan: lb.makespan, moves: lb.moves }, starts, goals, paths };
    console.log(`${key}: makespan=${best.makespan} moves=${best.moves} LB=${lb.makespan}/${lb.moves} (${solved}/${tried} seeds solved)`);
  }
}
const js = `/* reference.js — 自動生成 (tools/precompute.js). 各ステージの LNS2 参考解. paths は U/D/L/R/W の 1 文字/ステップ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.REFERENCE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return ${JSON.stringify(out)};
});
`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'reference.js'), js);
console.log('wrote src/reference.js', (js.length / 1024).toFixed(1) + ' KB');
