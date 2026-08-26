/*
 * leaderboard.gs — Human MAPF オンラインランキング (Google Apps Script, スプレッドシートにバインド)
 *
 * デプロイ手順は server/README.md を参照. ビルド (node build.js) で lns2.js + maps.js + このファイルを
 * 連結した dist/leaderboard.gs が生成されるので, それを Apps Script に貼り付ける.
 *
 * API (ウェブアプリ URL):
 *   GET  ?stage=<map>:<N>   → { ok, makespan: [entry...], moves: [entry...], players }
 *   GET  ?all=1             → { ok, best: { "<map>:<N>": { makespan: entry, moves: entry, players } } }
 *   GET  ?dump=1&token=<BACKUP_TOKEN>[&from=0&limit=500]
 *                           → { ok, total, from, count, next, rows: [{ts,stage,name,makespan,moves,paths}] }  (バックアップ用. tools/backup.js)
 *   POST body JSON { stage, name, paths: ["UDLRW..." x N] }
 *                           → { ok, score:{makespan,moves}, makespan:{rank,total,improved,best,entries}, moves:{...} }
 *   entry = { name, makespan, moves, ts }
 * スコアはクライアントの申告ではなく, 送られた経路をサーバー側で検証・計算して記録する.
 */
var SHEET_NAME = 'scores';
var TOP_N = 20;

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(['ts', 'stage', 'name', 'makespan', 'moves', 'paths']); }
  return sh;
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// バックアップ用: シートの生の行 (paths 込み) をそのまま返す. 応答が大きくなるので from/limit で分割して取る
var DUMP_MAX = 500;
function dump_(from, limit) {
  var sh = getSheet_(), last = sh.getLastRow();
  var total = Math.max(0, last - 1);
  from = Math.max(0, Math.floor(from) || 0);
  limit = Math.min(Math.max(1, Math.floor(limit) || DUMP_MAX), DUMP_MAX);
  var n = Math.max(0, Math.min(limit, total - from));
  var rows = n ? sh.getRange(2 + from, 1, n, 6).getValues().map(function (r) {
    return { ts: +r[0], stage: String(r[1]), name: String(r[2]), makespan: +r[3], moves: +r[4], paths: String(r[5]).split(",") };
  }) : [];
  var next = from + rows.length;
  return { ok: true, total: total, from: from, count: rows.length, next: next < total ? next : null, rows: rows };
}

function readAll_() {
  var sh = getSheet_(); var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 5).getValues();
  return rows.map(function (r) { return { ts: +r[0], stage: String(r[1]), name: String(r[2]), makespan: +r[3], moves: +r[4] }; });
}
function cmpMakespan_(a, b) { return a.makespan - b.makespan || a.moves - b.moves || a.ts - b.ts; }
function cmpMoves_(a, b) { return a.moves - b.moves || a.makespan - b.makespan || a.ts - b.ts; }
function bestPerName_(rows, cmp) {
  var best = {};
  rows.forEach(function (r) { var b = best[r.name]; if (!b || cmp(r, b) < 0) best[r.name] = r; });
  return Object.keys(best).map(function (k) { return best[k]; }).sort(cmp);
}
function board_(rows, stage) {
  var rs = rows.filter(function (r) { return r.stage === stage; });
  return { makespan: bestPerName_(rs, cmpMakespan_), moves: bestPerName_(rs, cmpMoves_) };
}
function strip_(e) { return e ? { name: e.name, makespan: e.makespan, moves: e.moves, ts: e.ts } : null; }

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.dump) {
      // トークンはスクリプトプロパティ BACKUP_TOKEN に設定する (未設定ならダンプ無効). 公開リポジトリに書かないこと
      var tok = PropertiesService.getScriptProperties().getProperty("BACKUP_TOKEN");
      if (!tok) return json_({ ok: false, error: "dump disabled" });
      if (String(p.token || "") !== String(tok)) return json_({ ok: false, error: "bad token" });
      return json_(dump_(+p.from || 0, +p.limit || DUMP_MAX));
    }
    var rows = readAll_();
    if (p.stage) {
      var b = board_(rows, String(p.stage));
      return json_({ ok: true, stage: p.stage, makespan: b.makespan.slice(0, TOP_N).map(strip_), moves: b.moves.slice(0, TOP_N).map(strip_), players: b.makespan.length });
    }
    if (p.all) {
      var best = {}, seen = {};
      rows.forEach(function (r) {
        if (seen[r.stage]) return; seen[r.stage] = true;
        var bb = board_(rows, r.stage);
        best[r.stage] = { makespan: strip_(bb.makespan[0]), moves: strip_(bb.moves[0]), players: bb.makespan.length };
      });
      return json_({ ok: true, best: best });
    }
    return json_({ ok: true, service: 'human-mapf-leaderboard', submissions: rows.length });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body;
    try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
    var v = validate_(body);
    if (!v.ok) return json_({ ok: false, error: v.error });
    lock.waitLock(20000);
    var sh = getSheet_();
    var ts = Date.now();
    sh.appendRow([ts, v.stage, v.name, v.makespan, v.moves, body.paths.join(',')]);
    var rows = readAll_();
    var b = board_(rows, v.stage);
    var rankIn = function (list) {
      var mine = null, idx = -1;
      for (var i = 0; i < list.length; ++i) if (list[i].name === v.name) { mine = list[i]; idx = i; break; }
      return { rank: idx + 1, total: list.length, improved: !!(mine && mine.ts === ts), best: strip_(mine), entries: list.slice(0, TOP_N).map(strip_) };
    };
    return json_({ ok: true, score: { makespan: v.makespan, moves: v.moves }, makespan: rankIn(b.makespan), moves: rankIn(b.moves) });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
  finally { try { lock.releaseLock(); } catch (err) { } }
}

// 解の検証: ステージのマップ・start/goal を再生成し, 経路の合法性と衝突を確認. スコアはここで計算する
function validate_(body) {
  var stage = String(body.stage || '');
  var m = /^([a-z_]+):(\d+)$/.exec(stage);
  if (!m) return { ok: false, error: 'bad stage' };
  var def = null;
  for (var d = 0; d < MAPS.MAP_DEFS.length; ++d) if (MAPS.MAP_DEFS[d].id === m[1]) def = MAPS.MAP_DEFS[d];
  var N = +m[2];
  if (!def || def.agents.indexOf(N) < 0) return { ok: false, error: 'unknown stage' };
  var name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!name) return { ok: false, error: 'bad name' };
  if (!Array.isArray(body.paths) || body.paths.length !== N) return { ok: false, error: 'bad paths' };
  var map = MAPS.getMap(def.id), G = LNS2.buildGraph(map);
  var ins = LNS2.generateInstance(G, N, MAPS.stageSeed(def.id, N));
  var paths = [];
  for (var i = 0; i < N; ++i) {
    var s = String(body.paths[i]);
    if (s.length > 5000 || /[^UDLRW]/.test(s)) return { ok: false, error: 'bad path ' + i };
    var c = ins.starts[i]; var p = [c];
    for (var k = 0; k < s.length; ++k) {
      var ch = s.charAt(k); var x = c % map.w;
      if (ch === 'R') { if (x === map.w - 1) return { ok: false, error: 'off map' }; c += 1; }
      else if (ch === 'L') { if (x === 0) return { ok: false, error: 'off map' }; c -= 1; }
      else if (ch === 'D') { c += map.w; }
      else if (ch === 'U') { c -= map.w; }
      if (c < 0 || c >= map.w * map.h || !map.free[c]) return { ok: false, error: 'illegal move' };
      p.push(c);
    }
    if (p[p.length - 1] !== ins.goals[i]) return { ok: false, error: 'agent ' + (i + 1) + ' not at goal' };
    paths.push(LNS2.trimPath(p));
  }
  if (LNS2.findCollisions(paths, G.V, false).count > 0) return { ok: false, error: 'collision' };
  var mt = LNS2.metrics(paths);
  return { ok: true, stage: stage, name: name, makespan: mt.makespan, moves: mt.moves };
}
