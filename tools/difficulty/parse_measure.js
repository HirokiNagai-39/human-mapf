// parse_measure.js — measure_all の生ログ (ma_*.s*.out.txt) を読み直し, 60 秒時点に揃えた指標を出す
//   LaCAM3 は --no-multi-thread だと時間制限を大きく超えて走る (comp_time が 60 秒指定で最大 280 秒) ので,
//   anytime 改善は 1 秒刻みの checkpoints の 60 個目までで評価する. 下界比は最終解のもの (時間超過ぶんは
//   下界に近づく方向にしか働かないので順位付けには影響しない)
'use strict';
const fs = require('fs');
const M = require('../../src/maps.js');
const TMP = process.env.DIFF_TMP || (__dirname + '/lacam_tmp');
const T = 60, SEEDS = [0, 1, 2];
const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

const out = {};
const ONLY_MAPS = process.env.DIFF_ONLY ? new Set(process.env.DIFF_ONLY.split(',')) : null;
for (const d of M.MAP_DEFS) if (!ONLY_MAPS || ONLY_MAPS.has(d.id)) for (const N of d.agents) {
  const st = `${d.id}:${N}`, runs = [];
  for (const s of SEEDS) {
    const f = `${TMP}/ma_${d.id}_${N}.s${s}.out.txt`;
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    const g = k => +((new RegExp(`^${k}=(-?[\\d.]+)`, 'm').exec(txt) || [])[1]);
    if (!g('solved')) { runs.push({ solved: 0 }); continue; }
    const ckAll = ((/^checkpoints=(.*)$/m.exec(txt) || [])[1] || '').split(',').filter(x => x !== '').map(Number);
    const ck = ckAll.slice(0, T + 1).filter(x => x > 0);
    const init = g('cost_initial_solution'), solLb = g('sum_of_loss_lb');
    const at60 = ck.length ? ck[ck.length - 1] : g('sum_of_loss');
    let conv = ck.findIndex(v => v <= at60 * 1.05); if (conv < 0) conv = ck.length;
    runs.push({
      solved: 1, compTime: g('comp_time'),
      msRatio: g('makespan') / g('makespan_lb'), solRatio: g('sum_of_loss') / solLb,
      initRatio: init / solLb, improve60: init > 0 ? (init - at60) / init : 0, conv60: conv,
      tInit: g('comp_time_initial_solution'),
    });
  }
  const ok = runs.filter(r => r.solved);
  out[st] = ok.length ? {
    solved: ok.length, compTimeMax: Math.max(...ok.map(r => r.compTime)),
    msRatio: med(ok.map(r => r.msRatio)), solRatio: med(ok.map(r => r.solRatio)), initRatio: med(ok.map(r => r.initRatio)),
    improve: med(ok.map(r => r.improve60)), convSec: med(ok.map(r => r.conv60)), tInit: med(ok.map(r => r.tInit)),
  } : { solved: 0 };
}
fs.writeFileSync(__dirname + '/measure_all.json', JSON.stringify(out, null, 1));
console.log('stage                      解け  実時間s  ms/LB  sol/LB  初期/LB  改善60s  収束s');
for (const st of Object.keys(out)) {
  const r = out[st];
  if (!r.solved) { console.log(st.padEnd(26) + '  未解決'); continue; }
  console.log(st.padEnd(26) + `${r.solved}/3`.padStart(4) + (r.compTimeMax / 1000).toFixed(0).padStart(8) + r.msRatio.toFixed(2).padStart(7)
    + r.solRatio.toFixed(2).padStart(8) + r.initRatio.toFixed(2).padStart(9) + (r.improve * 100).toFixed(0).padStart(8) + '%' + String(r.convSec).padStart(6));
}
