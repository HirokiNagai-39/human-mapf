// measure_all.js — 全 46 ステージを LaCAM3 (単一スレッド, 60 秒, seed 0/1/2) で計測し,
// 難易度算出の材料 (下界比 / anytime 改善 / 収束時間 / 探索量) を JSON で保存する
'use strict';
const fs = require('fs'), { spawn } = require('child_process');
const L = require('../../src/lns2.js');
const M = require('../../src/maps.js');
const { writeMap, writeScen } = require('./lacam.js');
const BIN = process.env.LACAM3 || '/Users/hirokinagai/Desktop/lacam3/build/main';
const TMP = process.env.DIFF_TMP || (__dirname + '/lacam_tmp');
const T = 60, SEEDS = [0, 1, 2], PAR = 8;

const stages = [];
const ONLY_MAPS = process.env.DIFF_ONLY ? new Set(process.env.DIFF_ONLY.split(',')) : null;
for (const d of M.MAP_DEFS) if (!ONLY_MAPS || ONLY_MAPS.has(d.id)) for (const N of d.agents) stages.push([d.id, N]);

const jobs = [];
for (const [id, N] of stages) {
  const map = M.getMap(id), G = L.buildGraph(map);
  const ins = M.getInstance(id, N, G);
  const name = `ma_${id}_${N}`;
  writeMap(map, name); writeScen(map, ins.starts, ins.goals, name, name);
  for (const s of SEEDS) jobs.push({ st: `${id}:${N}`, N, name, s, out: `${TMP}/${name}.s${s}.out.txt` });
}

function runOne(j) {
  return new Promise(res => {
    const p = spawn(BIN, ['-m', `${TMP}/${j.name}.map`, '-i', `${TMP}/${j.name}.scen`, '-N', String(j.N),
      '-t', String(T), '-s', String(j.s), '--no-multi-thread', '--checkpoints-duration', '1', '-o', j.out], { stdio: 'ignore' });
    p.on('close', () => res()); p.on('error', () => res());
  });
}

(async () => {
  const t0 = Date.now();
  for (let i = 0; i < jobs.length; i += PAR) {
    await Promise.all(jobs.slice(i, i + PAR).map(runOne));
    console.log(`${Math.min(i + PAR, jobs.length)}/${jobs.length} (${((Date.now() - t0) / 60000).toFixed(1)} 分)`);
  }
  const per = {};
  for (const j of jobs) {
    if (!fs.existsSync(j.out)) continue;
    const txt = fs.readFileSync(j.out, 'utf8');
    const g = k => +((new RegExp(`^${k}=(-?[\\d.]+)`, 'm').exec(txt) || [])[1]);
    if (!g('solved')) { (per[j.st] = per[j.st] || []).push({ solved: 0, seed: j.s }); continue; }
    const ck = ((/^checkpoints=(.*)$/m.exec(txt) || [])[1] || '').split(',').map(Number).filter(x => x > 0);
    const sol = g('sum_of_loss'), solLb = g('sum_of_loss_lb'), init = g('cost_initial_solution');
    let conv = ck.findIndex(v => v <= sol * 1.05); if (conv < 0) conv = ck.length;
    (per[j.st] = per[j.st] || []).push({
      solved: 1, seed: j.s,
      tInit: g('comp_time_initial_solution'),
      msRatio: g('makespan') / g('makespan_lb'),
      solRatio: sol / solLb,
      initRatio: init / solLb,
      improve: init > 0 ? (init - sol) / init : 0,
      convSec: conv,
      iter: g('search_iteration'),
    });
  }
  // seed 3 本の中央値でまとめる
  const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const out = {};
  for (const st of Object.keys(per)) {
    const ok = per[st].filter(r => r.solved);
    if (!ok.length) { out[st] = { solved: 0 }; continue; }
    out[st] = {
      solved: ok.length,
      msRatio: med(ok.map(r => r.msRatio)),
      solRatio: med(ok.map(r => r.solRatio)),
      initRatio: med(ok.map(r => r.initRatio)),
      improve: med(ok.map(r => r.improve)),
      convSec: med(ok.map(r => r.convSec)),
      tInit: med(ok.map(r => r.tInit)),
    };
  }
  fs.writeFileSync(__dirname + '/measure_all.json', JSON.stringify(out, null, 1));
  console.log(`完了 (${((Date.now() - t0) / 60000).toFixed(1)} 分) → measure_all.json`);
})();
