/*
 * tools/difficulty.js — 各ステージの difficulty (AtCoder 風, 灰 0〜 赤 2800〜) を計測データから計算し
 *                        src/difficulty.js に埋め込む
 *   node tools/difficulty.js <計測データのディレクトリ> [--force] [--dry-run] [--check]
 *
 * 計測データ (ディレクトリ内の JSON, 生成方法は tools/difficulty/README.md):
 *   measure_all.json    LaCAM3 (単一スレッド 60 秒, seed 3 本の中央値): msRatio, solRatio, improve, convSec
 *   probe_initial.json  LNS2 が初めて衝突 0 に到達するまでの ms (seed 8 本, 失敗は 60000 扱い)
 *   probe_narrow.json   幅 1 通路を逆向きに共有するペア数 / N
 *   tutorial_opt.json   tutorial の厳密解 (下界が緩いので, 下界比をこれで補正する)
 *
 * difficulty は reference.js と同じく「一度公開したら再計算しない」(レーティングの事前値なので, 変えると
 * 過去の performance がずれる). 既定では既存エントリを保持し, 未計算のステージだけ追加する.
 *
 * 式 (2026-08-30 に確定. 重みは ebne:21 / bremen:300 / warehouse_hard:50 ≈ 赤 と, ユーザー指定の
 * 目標 (warehouse_hard 10 緑 … 50 ≈ 3000, 各マップ 50 台の色) にフィットさせたもの):
 *   G = ln√(makespan/LB × sum_of_loss/LB)    E = anytime 改善率 + 収束秒/60
 *   T = log10(1 + t_feas)                     C = すれ違い不能ペア / N     labor = N × 参考解 makespan
 *   (G, E, T, C はマップごとに台数の昇順で単調回帰: 同じマップで台数が多いほど難しい)
 *   H = hG·ln(1 + G/qg) + hE·E   S = sW·(labor − 14)   F = fT·T   X = cW·C^qc
 *   difficulty = √(H² + S² + F² + X²)
 */
const fs = require('fs'), path = require('path');
const M = require('../src/maps.js');
const REF = require('../src/reference.js');

const OUT_PATH = path.join(__dirname, '..', 'src', 'difficulty.js');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const dir = argv.find(a => !a.startsWith('--'));
const FORCE = has('--force'), DRY = has('--dry-run'), CHECK = has('--check');

// フィット済みの重み (backups/difficulty-20260830/difficulty_fit_final.json). 変えないこと
const P = { hG: 530.2599958001202, hE: 722.8951866219752, sW: 0.08774461626532612, pw: 1, fT: 269.7007569733206, cW: 11.490386602468575, qc: 4, qg: 0.01 };
const TL_MS = 60000;
// 手動の初期値上書き (ステージ → d0). 式は「ソルバーにとっての難しさ」なので, 状態空間が小さく人間なら試行錯誤で
// 解けそうなステージは控えめに始め, 成績によるフィードバック (計測値 ±1200) で動けるようにする. 計測成分はそのまま残す.
// 2026-08-30 ユーザー決定: Small tree は計測値 2411 / 3004 / 3241 → 1800 / 2000 / 2200 (計測の順序は保つ)
const OVERRIDES = {
  'small_tree_1:5': 1800, 'small_tree_2:5': 2000, 'small_tree_3:5': 2200,
  // Big tree (m22) / Eighth note (2026-08-31): どちらも幅 1 の長い道を多数のペアが逆向きに通るため
  // 狭路指標 C が較正範囲 (≤3.4) を大きく超え, 計測値が暴走する (note:20 で 1.1 万, big_tree:50 で 46 億).
  // Small tree と同じ方針で控えめな単調列から始める. temple は計測値が穏当なので上書きしない
  'big_tree:10': 1400, 'big_tree:20': 1700, 'big_tree:30': 2000, 'big_tree:40': 2300, 'big_tree:50': 2600,
  'note:5': 600, 'note:10': 900, 'note:15': 1200, 'note:20': 1600, 'note:25': 2000,
  // Rotation (writer: through さん, 2026-09-01 採用): リング + 退避 1 マス. LaCAM3 は N=10 が 900 秒 (逆向きのみ),
  // N=20 は解けず, LNS2 も N≥10 で失敗 → 計測パイプラインが使えない. 参考記録は作者の人力解 (経路なし).
  // src/difficulty.js には d0 のみのエントリを手動で追加してある (成分なし. --check は上書き表で整合を見る)
  'rotation:5': 1200, 'rotation:10': 2200, 'rotation:20': 2800,   // 2026-09-01 ユーザー決定
  // Sunflower (2026-09-01): 全面幅 1 (リング + 花びらの行き止まり) で狭路指標 C が較正範囲外になるため計測しない.
  // LNS2 は 25 台以上で失敗, LaCAM3 は 50 台まで解ける. 控えめな単調列から始める (d0 のみのエントリ)
  'sunflower:10': 1000, 'sunflower:20': 1400, 'sunflower:30': 1800, 'sunflower:40': 2200, 'sunflower:50': 2600,
  // Power button (writer: Hori04): 計測値 3335 は高すぎ (ユーザー判断, 2026-09-03). LNS2 全滅 + 下界比 5 倍が
  // 効いた値だが, 63 マスの小盤面で人間は試行錯誤できるため控えめに始める
  'power_button:16': 2400,
};

function pava(v) {
  const blocks = v.map(x => ({ sum: x, n: 1 }));
  for (let i = 0; i < blocks.length - 1;) {
    if (blocks[i].sum / blocks[i].n > blocks[i + 1].sum / blocks[i + 1].n) {
      blocks[i].sum += blocks[i + 1].sum; blocks[i].n += blocks[i + 1].n; blocks.splice(i + 1, 1);
      if (i > 0) --i;
    } else ++i;
  }
  const out = []; for (const b of blocks) for (let k = 0; k < b.n; ++k) out.push(b.sum / b.n);
  return out;
}
function score(c) {
  const H = P.hG * Math.log(1 + c.g / P.qg) + P.hE * c.e;
  const S = P.sW * Math.max(0, Math.pow(c.labor, P.pw) - Math.pow(14, P.pw));
  const F = P.fT * c.t;
  const X = P.cW * Math.pow(c.c, P.qc);
  return Math.round(Math.sqrt(H * H + S * S + F * F + X * X));
}

// 計測データ → ステージごとの成分 (単調回帰後)
function loadComponents(d) {
  const rd = f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  const meas = rd('measure_all.json'), init = rd('probe_initial.json'), narrow = rd('probe_narrow.json');
  const topt = fs.existsSync(path.join(d, 'tutorial_opt.json')) ? rd('tutorial_opt.json') : null;
  const rows = [];
  for (const st of Object.keys(meas)) {
    const m = meas[st], ref = REF[st], ini = init[st], nr = narrow[st];
    if (!m.solved || !ref || !ini || !nr) { console.log(`  ${st}: 計測データが不足 (スキップ)`); continue; }
    let ms = m.msRatio, sol = m.solRatio;
    if (st === 'tutorial:2' && topt) { ms *= ref.lb.makespan / topt.optMakespan; sol *= ref.lb.moves / topt.optMoves; }
    const [map, Ns] = st.split(':'), N = +Ns;
    const logs = ini.lns.map(x => Math.log10(1 + (x.ok ? x.ms : TL_MS)));
    const tFeas = Math.pow(10, logs.reduce((a, b) => a + b, 0) / logs.length) - 1;
    rows.push({ st, map, N, g: Math.max(0, Math.log(Math.sqrt(ms * sol))), e: m.improve + m.convSec / 60, t: Math.log10(1 + tFeas), c: nr.C, labor: N * ref.makespan });
  }
  for (const map of new Set(rows.map(r => r.map))) {
    const g = rows.filter(r => r.map === map).sort((a, b) => a.N - b.N);
    for (const k of ['g', 'e', 't', 'c']) { const v = pava(g.map(r => r[k])); g.forEach((r, i) => { r[k] = v[i]; }); }
  }
  return rows;
}

const existing = fs.existsSync(OUT_PATH) ? require(OUT_PATH) : {};
if (CHECK) {
  let bad = 0;
  for (const st of Object.keys(existing)) {
    const e = existing[st];
    const want = OVERRIDES[st] != null ? OVERRIDES[st] : score(e);
    if (want !== e.d0) { console.log(`  ${st}: d0=${e.d0} だが${OVERRIDES[st] != null ? '上書き表' : '式'}からは ${want}`); ++bad; }
    if (!REF[st]) { console.log(`  ${st}: reference.js に無い`); ++bad; }
  }
  console.log(`既存の difficulty: ${Object.keys(existing).length} ステージ ${bad ? `(問題 ${bad} 件)` : '(すべて整合)'}`);
  process.exit(bad ? 1 : 0);
}
if (!dir) { console.error('計測データのディレクトリを指定してください'); process.exit(1); }

const out = FORCE ? {} : { ...existing };
for (const st of Object.keys(OVERRIDES)) if (out[st] && out[st].d0 !== OVERRIDES[st]) { out[st] = { ...out[st], measured: out[st].measured != null ? out[st].measured : out[st].d0, d0: OVERRIDES[st] }; console.log(`  ${st}: 上書き ${out[st].measured} → ${OVERRIDES[st]}`); }
const rows = loadComponents(dir);
let added = 0;
for (const r of rows) {
  if (out[r.st]) continue;
  // 成分は丸めて保存し, d0 は丸めた成分から計算する (--check で式との整合を厳密に確認できるように)
  const c = { g: +r.g.toFixed(5), e: +r.e.toFixed(5), t: +r.t.toFixed(5), c: +r.c.toFixed(5), labor: r.labor };
  out[r.st] = { d0: OVERRIDES[r.st] != null ? OVERRIDES[r.st] : score(c), ...c };
  if (OVERRIDES[r.st] != null) out[r.st].measured = score(c);
  ++added;
}
const stages = []; for (const d of M.MAP_DEFS) for (const N of d.agents) stages.push(`${d.id}:${N}`);
const missing = stages.filter(st => !out[st]);
if (missing.length) console.log(`注: 計測データが無いステージ: ${missing.join(' ')}`);

const COLORS = [[2800, '赤'], [2400, '橙'], [2000, '黄'], [1600, '青'], [1200, '水'], [800, '緑'], [400, '茶'], [0, '灰']];
const color = d => COLORS.find(([lo]) => d >= lo)[1];
for (const st of stages) if (out[st]) console.log(`  ${st.padEnd(26)} ${String(out[st].d0).padStart(5)} ${color(out[st].d0)}${existing[st] ? '' : '  (新規)'}`);
console.log(`\n${added} ステージを追加, 計 ${Object.keys(out).length} ステージ`);

const js = `/* difficulty.js — 自動生成 (tools/difficulty.js). 各ステージの difficulty の事前値 d0 とその成分.
 * d0 は LaCAM3 / LNS2 の計測から決まる固定値. プレイヤーの成績によるフィードバック後の値はサーバーが持つ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DIFFICULTY = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return ${JSON.stringify(out)};
});
`;
if (DRY) console.log('--dry-run: ファイルは書き換えていません');
else if (fs.existsSync(OUT_PATH) && fs.readFileSync(OUT_PATH, 'utf8') === js) console.log('src/difficulty.js に変更はありません');
else { fs.writeFileSync(OUT_PATH, js); console.log(`wrote src/difficulty.js (${(js.length / 1024).toFixed(1)} KB)`); }
