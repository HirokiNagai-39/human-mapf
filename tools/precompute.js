/*
 * tools/precompute.js — 各ステージの LNS2 参考解を計算し src/reference.js に埋め込む
 *   node tools/precompute.js [seeds=8] [timeLimitSec=5] [--force] [--only <指定>] [--check] [--dry-run]
 *
 * 参考解はランク (DIAMOND〜BRONZE) の判定基準なので, 公開済みステージを計算し直すと
 * 過去にプレイした人のランクが後からズレる. そのため既定では
 *   「src/reference.js の既存エントリはそのまま残し, まだ無いステージだけ計算する」
 * 挙動になっている. 全部計算し直したいときだけ --force を付ける.
 *
 *   --only <指定>  指定したステージだけ計算し直す (既存でも上書き)
 *                  例: --only city / --only city:30,city:40 / --only maze,warehouse
 *   --force        既存エントリも含めて全ステージ計算し直す (ランクが変わるので注意)
 *   --check        計算しない. 既存エントリの検証だけして終了
 *   --dry-run      計算はするがファイルに書かない
 */
const fs = require('fs'), path = require('path');
const L = require('../src/lns2.js'), M = require('../src/maps.js');

const REF_PATH = path.join(__dirname, '..', 'src', 'reference.js');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const flagVal = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const nums = argv.filter(a => /^\d+$/.test(a));
const SEEDS = +(nums[0] || 8), TL = +(nums[1] || 5) * 1000;
const FORCE = has('--force'), CHECK_ONLY = has('--check'), DRY = has('--dry-run');
const ONLY = (flagVal('--only') || '').split(',').map(s => s.trim()).filter(Boolean);
const onlyHit = (id, N) => ONLY.some(o => o === id || o === `${id}:${N}`);
if (ONLY.length && FORCE) { console.error('--only と --force は同時に指定できません'); process.exit(1); }

function encodePath(p, w) {
  let s = '';
  for (let t = 1; t < p.length; ++t) {
    const d = p[t] - p[t - 1];
    s += d === 0 ? 'W' : d === 1 ? 'R' : d === -1 ? 'L' : d === w ? 'D' : d === -w ? 'U' : (() => { throw new Error('bad step'); })();
  }
  return s;
}
function decodePath(s, start, w) {
  const p = [start];
  let c = start;
  for (const ch of s) { c += ch === 'W' ? 0 : ch === 'R' ? 1 : ch === 'L' ? -1 : ch === 'D' ? w : -w; p.push(c); }
  return p;
}

// 既存エントリがいまのマップ定義とまだ整合しているか検証する.
// マップやシード, エージェント数を変えると既存の参考解は無効になるので, それを見逃さないための保険.
function verify(key, e) {
  const [id, Ns] = key.split(':'), N = +Ns;
  const def = M.MAP_DEFS.find(d => d.id === id);
  if (!def) return 'マップ ' + id + ' が MAP_DEFS にない';
  if (!def.agents.includes(N)) return N + ' agents が MAP_DEFS にない';
  const map = M.getMap(id), G = L.buildGraph(map);
  const ins = M.getInstance(id, N, G);
  if (String(ins.starts) !== String(e.starts) || String(ins.goals) !== String(e.goals)) return 'start/goal が現在の生成結果と違う (マップかシードが変わった)';
  if (e.paths == null) {
    // writer 採用ステージ: 作者の人力スコアのみ (経路は投稿検証後に破棄済み). 経路検証はできない
    if (!(e.makespan >= e.lb.makespan && e.moves >= e.lb.moves)) return 'スコアが下限より小さい';
    return null;
  }
  if (e.paths.length !== N) return '経路の本数が ' + e.paths.length + ' で N=' + N + ' と違う';
  const paths = [];
  for (let i = 0; i < N; ++i) {
    if (/[^UDLRW]/.test(e.paths[i])) return `agent ${i + 1}: 不正な文字`;
    const p = decodePath(e.paths[i], e.starts[i], map.w);
    for (let t = 1; t < p.length; ++t) {
      const a = p[t - 1], b = p[t];
      if (b < 0 || b >= map.w * map.h || !map.free[b]) return `agent ${i + 1}: t=${t} で障害物か盤外`;
      if (Math.abs(b - a) === 1 && Math.floor(a / map.w) !== Math.floor(b / map.w)) return `agent ${i + 1}: t=${t} で行をまたいだ横移動`;
    }
    if (p[p.length - 1] !== e.goals[i]) return `agent ${i + 1}: ゴールに着いていない`;
    paths.push(L.trimPath(p));
  }
  const col = L.findCollisions(paths, G.V, false);
  if (col.count > 0) return '衝突 ' + col.count + ' 件';
  const mt = L.metrics(paths);
  if (mt.makespan !== e.makespan || mt.moves !== e.moves) return `スコア不一致 (記録 ${e.makespan}/${e.moves} → 実際 ${mt.makespan}/${mt.moves})`;
  return null;
}

function solveStage(id, N) {
  const map = M.getMap(id), G = L.buildGraph(map);
  const seed = M.stageSeed(id, N);
  const { starts, goals } = M.getInstance(id, N, G);
  let best = null, lb = null, tried = 0, solved = 0;
  for (let k = 0; k < SEEDS; ++k) {
    const S = new L.Solver(G, starts, goals, seed + k * 1000003);
    const r = S.solve(TL); ++tried; lb = r.lowerBound;
    if (!r.ok) continue; ++solved;
    if (!best || r.makespan < best.makespan || (r.makespan === best.makespan && r.moves < best.moves)) best = r;
  }
  if (!best) return null;
  return {
    entry: { makespan: best.makespan, moves: best.moves, lb: { makespan: lb.makespan, moves: lb.moves }, starts, goals, paths: best.paths.map(p => encodePath(L.trimPath(p), map.w)) },
    solved, tried,
  };
}

// ---------------------------------------------------------------- main
const existing = fs.existsSync(REF_PATH) ? require(REF_PATH) : {};
const nExisting = Object.keys(existing).length;
console.log(`既存の参考解: ${nExisting} ステージ (${path.relative(process.cwd(), REF_PATH)})`);

// 1. 既存エントリの検証
let bad = 0;
for (const [key, e] of Object.entries(existing)) {
  const err = verify(key, e);
  if (err) { console.log(`  ⚠ ${key}: ${err}`); ++bad; }
}
console.log(bad ? `  ⚠ ${bad} ステージが現在の定義と不整合 (--only か --force で計算し直してください)` : '  すべて現在の定義と整合しています');
if (CHECK_ONLY) process.exit(bad ? 1 : 0);

// 2. 計算対象を決める
const stages = [];
for (const d of M.MAP_DEFS) for (const N of d.agents) stages.push([d.id, N]);
const targets = stages.filter(([id, N]) => {
  const key = `${id}:${N}`;
  if (FORCE) return true;
  if (ONLY.length) return onlyHit(id, N);
  return !(key in existing);
});
const kept = stages.length - targets.length;
if (FORCE) console.log(`\n--force: 全 ${targets.length} ステージを計算し直します (既存のランク基準が変わります)`);
else if (ONLY.length) console.log(`\n--only ${ONLY.join(',')}: ${targets.length} ステージを計算し直します (残り ${kept} は据え置き)`);
else console.log(`\n差分計算: 未計算の ${targets.length} ステージだけ計算します (既存 ${kept} は据え置き)`);
if (ONLY.length && targets.length === 0) console.log('  (--only の指定に一致するステージがありません)');

// 3. 計算
const out = Object.assign({}, existing);
const changes = [];
let failed = 0;
for (const [id, N] of targets) {
  const key = `${id}:${N}`;
  const r = solveStage(id, N);
  if (!r) { console.log(`  ${key}: NOT SOLVED`); ++failed; continue; }
  const before = existing[key];
  out[key] = r.entry;
  const tag = before
    ? (before.makespan === r.entry.makespan && before.moves === r.entry.moves ? '変化なし' : `変化 ${before.makespan}/${before.moves} → ${r.entry.makespan}/${r.entry.moves}`)
    : '新規';
  if (before && tag !== '変化なし') changes.push(`${key}: ${tag}`);
  console.log(`  ${key}: makespan=${r.entry.makespan} moves=${r.entry.moves} LB=${r.entry.lb.makespan}/${r.entry.lb.moves} (${r.solved}/${r.tried} seeds) ${tag}`);
}

// 4. 書き出し
if (changes.length) {
  console.log('\n⚠ 既存ステージの参考解が変わりました (この分だけ過去のランク判定とズレます):');
  for (const c of changes) console.log('  ' + c);
}
const orphans = Object.keys(out).filter(k => !stages.some(([id, N]) => `${id}:${N}` === k));
if (orphans.length) console.log(`\n注: MAP_DEFS に無いステージが reference.js に残っています (削除はしません): ${orphans.join(' ')}`);

const js = `/* reference.js — 自動生成 (tools/precompute.js). 各ステージの LNS2 参考解. paths は U/D/L/R/W の 1 文字/ステップ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.REFERENCE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return ${JSON.stringify(out)};
});
`;
if (DRY) console.log('\n--dry-run: ファイルは書き換えていません');
else if (fs.existsSync(REF_PATH) && fs.readFileSync(REF_PATH, 'utf8') === js) console.log('\nsrc/reference.js に変更はありません');
else { fs.writeFileSync(REF_PATH, js); console.log(`\nwrote src/reference.js ${(js.length / 1024).toFixed(1)} KB (${Object.keys(out).length} ステージ)`); }
if (failed) process.exitCode = 1;
