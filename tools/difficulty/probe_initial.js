// probe_initial.js — 「初期解 (衝突なしの解を 1 つ見つける) の難しさ」の候補指標を全ステージで採取
//   (a) 最短経路衝突: 全員が他者を無視した最短経路を通ったときの衝突数 / 衝突に巻き込まれる agent の割合
//   (b) LNS2 が初めて衝突 0 に到達するまで: 初期 PP の衝突数, 反復回数, 時間, 成功率 (seed 3 本, 60 秒)
//   使い方: node probe_initial.js            … 親. 子プロセス (PAR 並列) で (b) を回して結果を集約
'use strict';
const fs = require('fs'), { fork } = require('child_process');
const L = require('../../src/lns2.js');
const M = require('../../src/maps.js');
const TL = 60000, SEEDS = [0, 1, 2, 3, 4, 5, 6, 7], PAR = 8;

function instance(id, N) {
  const map = M.getMap(id), G = L.buildGraph(map);
  const ins = L.generateInstance(G, N, M.stageSeed(id, N));
  return { map, G, ...ins };
}

if (process.argv[2] === 'child') {
  const [id, Ns, s] = process.argv.slice(3);
  const { G, starts, goals } = instance(id, +Ns);
  const S = new L.Solver(G, starts, goals, +s * 1000003 + 7);
  S.begin(TL);
  let initCol = -1;
  while (!S.step(100)) { if (initCol < 0 && S._paths) initCol = S._curCol; }
  if (initCol < 0 && S._paths) initCol = S._curCol;
  const r = S.result();
  process.send({ ok: r.ok, iter: r.iter, ms: r.timeMs, initCol, reason: r.reason });
  process.exit(0);
}

const stages = [];
for (const d of M.MAP_DEFS) for (const N of d.agents) stages.push([d.id, N]);

const out = {};
for (const [id, N] of stages) {
  const { G, starts, goals } = instance(id, N);
  const sp = starts.map((s, i) => L.shortestPath(G, s, goals[i]));
  const col = L.findCollisions(sp, G.V, false);
  const inConf = col.conf.reduce((a, c) => a + (c ? 1 : 0), 0);
  out[`${id}:${N}`] = { spCollisions: col.count, spConflictFrac: +(inConf / N).toFixed(3), lns: [] };
}

const jobs = [];
for (const [id, N] of stages) for (const s of SEEDS) jobs.push({ id, N, s });
let next = 0, running = 0;
const t0 = Date.now();
function launch() {
  while (running < PAR && next < jobs.length) {
    const j = jobs[next++]; ++running;
    const c = fork(__filename, ['child', j.id, String(j.N), String(j.s)]);
    c.on('message', m => { out[`${j.id}:${j.N}`].lns.push({ seed: j.s, ...m }); });
    c.on('exit', () => {
      --running;
      if (next % 10 === 0 || next === jobs.length) console.log(`${next}/${jobs.length} (${((Date.now() - t0) / 60000).toFixed(1)} 分)`);
      if (next < jobs.length) launch(); else if (!running) finish();
    });
  }
}
function finish() {
  const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  for (const st of Object.keys(out)) {
    const r = out[st], ok = r.lns.filter(x => x.ok);
    r.lnsSolved = ok.length;
    r.lnsIter = ok.length ? med(ok.map(x => x.iter)) : null;
    r.lnsMs = ok.length ? med(ok.map(x => x.ms)) : null;
    r.lnsInitCol = med(r.lns.map(x => x.initCol));
  }
  fs.writeFileSync(__dirname + '/probe_initial.json', JSON.stringify(out, null, 1));
  console.log('stage                      SP衝突  巻込率   PP初期衝突  LNS成功  反復   ms');
  for (const st of Object.keys(out)) {
    const r = out[st];
    console.log(st.padEnd(26) + String(r.spCollisions).padStart(6) + r.spConflictFrac.toFixed(2).padStart(8)
      + String(r.lnsInitCol).padStart(11) + `${r.lnsSolved}/3`.padStart(8) + String(r.lnsIter ?? '-').padStart(7) + String(r.lnsMs ?? '-').padStart(7));
  }
}
launch();
