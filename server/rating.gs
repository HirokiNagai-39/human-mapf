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
var RT = { KAPPA: 200, YZERO: 2.25, OFFSET: 300, TAU: 300, DCLAMP: 600, RELCLAMP: 500, DECAY: 0.9,
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
  var byStage = {}, byPlayer = {};
  subs.forEach(function (s) { (byStage[s.stage] = byStage[s.stage] || []).push(s); (byPlayer[s.name] = byPlayer[s.name] || []).push(s); });
  var players = Object.keys(byPlayer);
  var D = {}, R = {}, ability = {};
  for (st in D0) D[st] = D0[st];
  players.forEach(function (p) { R[p] = 1000; ability[p] = 1000; });

  for (var it = 0; it < RT.ITER; ++it) {
    // performance
    Object.keys(byStage).forEach(function (st) {
      var list = byStage[st].slice().sort(function (a, b) { return a.r - b.r; });
      list.forEach(function (s, i) {
        var y = clamp_(s.y, 0.03, 0.97);
        s.pAbs = D[st] + RT.OFFSET + RT.KAPPA * Math.log(y / (1 - y)) / LN6;
        if (list.length >= 2) {
          var others = list.filter(function (o) { return o !== s; }).map(function (o) { return R[o.name]; });
          var pRel = clamp_(perfFromRank_(others, i + 1), s.pAbs - RT.RELCLAMP, s.pAbs + RT.RELCLAMP);
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
