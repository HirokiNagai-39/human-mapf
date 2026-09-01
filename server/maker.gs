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
