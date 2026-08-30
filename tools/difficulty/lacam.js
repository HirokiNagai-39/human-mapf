// lacam.js — ゲームのマップ/配置を LaCAM3 に渡して解かせ、経路をゲームの表現に戻す
'use strict';
const fs = require('fs'), { execFileSync } = require('child_process');
const L = require('../../src/lns2.js');
const BIN = process.env.LACAM3 || '/Users/hirokinagai/Desktop/lacam3/build/main';
const TMP = process.env.DIFF_TMP || (__dirname + '/lacam_tmp');
fs.mkdirSync(TMP, { recursive: true });

// MovingAI 形式で書き出す
function writeMap(m, name) {
  let s = `type octile\nheight ${m.h}\nwidth ${m.w}\nmap\n`;
  for (let y = 0; y < m.h; ++y) {
    for (let x = 0; x < m.w; ++x) s += m.free[y * m.w + x] ? '.' : '@';
    s += '\n';
  }
  const p = `${TMP}/${name}.map`;
  fs.writeFileSync(p, s);
  return p;
}
function writeScen(m, starts, goals, mapName, name) {
  let s = 'version 1\n';
  for (let i = 0; i < starts.length; ++i) {
    const sx = starts[i] % m.w, sy = (starts[i] / m.w) | 0;
    const gx = goals[i] % m.w, gy = (goals[i] / m.w) | 0;
    s += `0\t${mapName}.map\t${m.w}\t${m.h}\t${sx}\t${sy}\t${gx}\t${gy}\t1\n`;
  }
  const p = `${TMP}/${name}.scen`;
  fs.writeFileSync(p, s);
  return p;
}
// LaCAM3 を実行して経路 (セル番号の配列) を返す
function solve(m, starts, goals, { seconds = 30, seed = 0, name = 'inst', extra = [] } = {}) {
  const mapPath = writeMap(m, name);
  const scenPath = writeScen(m, starts, goals, name, name);
  const outPath = `${TMP}/${name}.out.txt`;
  const t0 = Date.now();
  try {
    execFileSync(BIN, ['-m', mapPath, '-i', scenPath, '-N', String(starts.length),
      '-t', String(seconds), '-s', String(seed), '-o', outPath, ...extra],
      { stdio: 'pipe', timeout: (seconds + 30) * 1000 });
  } catch (e) { /* 解けなくても出力は書かれる */ }
  const ms = Date.now() - t0;
  if (!fs.existsSync(outPath)) return { ok: false, ms };
  const txt = fs.readFileSync(outPath, 'utf8');
  const solved = /^solved=1$/m.test(txt);
  if (!solved) return { ok: false, ms, raw: txt.split('\n').slice(0, 12).join('\n') };
  // solution= 以降に "t:(x,y),(x,y),..." が時刻ぶん並ぶ
  const lines = txt.split('\n');
  const si = lines.findIndex(l => l.startsWith('solution='));
  const steps = [];
  for (let i = si + 1; i < lines.length; ++i) {
    const line = lines[i].trim();
    if (!line) continue;
    const body = line.replace(/^\d+:/, '');
    const cells = [...body.matchAll(/\((\d+),(\d+)\)/g)].map(mm => (+mm[2]) * m.w + (+mm[1]));
    if (cells.length !== starts.length) break;
    steps.push(cells);
  }
  if (!steps.length) return { ok: false, ms, raw: 'solution を読めなかった' };
  const paths = starts.map((_, a) => steps.map(st => st[a]));
  return { ok: true, ms, paths, makespan: +(/^makespan=(\d+)$/m.exec(txt) || [])[1], soc: +(/^soc=(\d+)$/m.exec(txt) || [])[1] };
}
// ゲームのルールで検証する
function verify(m, G, starts, goals, paths) {
  const w = m.w;
  for (let i = 0; i < paths.length; ++i) {
    if (paths[i][0] !== starts[i]) return `agent ${i + 1}: 開始位置が違う`;
    for (let t = 1; t < paths[i].length; ++t) {
      const a = paths[i][t - 1], b = paths[i][t];
      if (a === b) continue;
      const d = Math.abs(a - b);
      if (!(d === w || (d === 1 && ((a / w) | 0) === ((b / w) | 0)))) return `agent ${i + 1}: t=${t} で隣接していない移動`;
      if (!m.free[b]) return `agent ${i + 1}: t=${t} で障害物`;
    }
    if (paths[i][paths[i].length - 1] !== goals[i]) return `agent ${i + 1}: ゴール未到達`;
  }
  const trimmed = paths.map(p => L.trimPath(p));
  const col = L.findCollisions(trimmed, G.V, false);
  if (col.count > 0) return `衝突 ${col.count} 件`;
  return null;
}
module.exports = { solve, verify, writeMap, writeScen };
