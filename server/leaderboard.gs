/*
 * leaderboard.gs — Human MAPF オンラインランキング (Google Apps Script, スプレッドシートにバインド)
 *
 * デプロイ手順は server/README.md を参照. ビルド (node build.js) で lns2.js + maps.js + このファイルを
 * 連結した dist/leaderboard.gs が生成されるので, それを Apps Script に貼り付ける.
 *
 * シート:
 *   scores … ts, stage, name, makespan, moves, paths   (1 提出 1 行. 既存データはそのまま使う)
 *   users  … name, namekey, salt, hash, iter, tokenSalt, serial, created, lastLogin, fail, failUntil, legacy
 *
 * API (ウェブアプリ URL):
 *   GET  ?stage=<map>:<N>   → { ok, makespan: [entry...], moves: [entry...], total: [entry...], players }
 *                             部門は 3 つ: makespan / total distance / 総合 (makespan × distance の積が小さいほど上位)
 *   GET  ?all=1             → { ok, best: { "<map>:<N>": { makespan: entry, moves: entry, total: entry, players } } }
 *   GET  ?checkname=<name>  → { ok, name, available, taken, legacy, submissions }  登録前の名前チェック
 *   GET  ?dump=1&token=<BACKUP_TOKEN>[&sheet=scores|users][&from=0&limit=500]
 *                           → { ok, sheet, total, from, count, next, rows: [...] }  (バックアップ用. tools/backup.js)
 *   POST { action: 'register', name, password }  → { ok, name, token, legacy, claimed }
 *   POST { action: 'login',    name, password }  → { ok, name, token, submissions }
 *   POST { action: 'submit',   name, token, stage, paths }
 *                           → { ok, name, score:{makespan,moves}, makespan:{rank,total,improved,best,entries}, moves:{...} }
 *   entry = { name, makespan, moves, ts }
 *
 * スコアはクライアントの申告ではなく, 送られた経路をサーバー側で検証・計算して記録する.
 * 投稿にはログインが必須 (トークン検証). 記録される名前は必ず登録済みの表示名になるので, なりすましはできない.
 */
var SHEET_NAME = 'scores';
var USERS_SHEET = 'users';
var TOP_N = 20;
// パスワードのハッシュ反復回数. GAS の Utilities.computeDigest は 1 回あたり十数 ms かかるため
// 大きくしすぎると登録・ログインがタイムアウトする. スクリプトプロパティ HASH_ITER で調整できる
// (行ごとに iter を保存しているので、変更しても既存アカウントはそのままログインできる).
var HASH_ITER_DEFAULT = 100;
function hashIter_() {
  var v = +(PropertiesService.getScriptProperties().getProperty('HASH_ITER') || HASH_ITER_DEFAULT);
  return v >= 1 && v <= 5000 ? Math.floor(v) : HASH_ITER_DEFAULT;
}
var MAX_FAIL = 5;          // 連続ログイン失敗の上限
var LOCK_MS = 60 * 1000;   // 上限に達したときのロック時間
// 移行期間: この時刻までは「まだ登録されていない名前」に限り, ログイン前 (トークン無し) の投稿も受け付ける.
// 更新前からページを開いて解いている人の結果を無駄にしないための猶予. 登録済みの名前は最初から保護される.
// スクリプトプロパティ LEGACY_UNTIL (ISO 8601 か ミリ秒) で延長・即時終了できる (再デプロイ不要).
var LEGACY_UNTIL_DEFAULT = '2026-08-27T23:59:59+09:00';   // 2026-08-27 23:59 JST
function legacyUntil_() {
  var v = PropertiesService.getScriptProperties().getProperty('LEGACY_UNTIL') || LEGACY_UNTIL_DEFAULT;
  var n = /^[0-9]+$/.test(v) ? +v : Date.parse(v);
  return isNaN(n) ? 0 : n;
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(['ts', 'stage', 'name', 'makespan', 'moves', 'paths']); }
  return sh;
}
function getUsers_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(USERS_SHEET);
    sh.appendRow(['name', 'namekey', 'salt', 'hash', 'iter', 'tokenSalt', 'serial', 'created', 'lastLogin', 'fail', 'failUntil', 'legacy']);
  }
  return sh;
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// ---------------------------------------------------------------- 名前
// 表示名: 制御文字と <> を除き, 連続空白を 1 つにして 16 文字まで
function cleanName_(s) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); }
// 同一性の判定キー: 全角/半角, 大文字/小文字, 空白の違いを吸収する ("Foo" と "ｆｏｏ" は同じ名前とみなす)
function nameKey_(s) { return cleanName_(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase(); }

// ---------------------------------------------------------------- ハッシュ
function sha256hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; ++i) { var b = (bytes[i] + 256) % 256; out += (b < 16 ? '0' : '') + b.toString(16); }
  return out;
}
function hashPw_(pw, salt, iter) {
  var h = salt + '|' + pw;
  for (var i = 0; i < iter; ++i) h = sha256hex_(h);
  return h;
}
function randomHex_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
// 長さと内容が一致するかを, 途中で return せずに比べる
function equalConst_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; ++i) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// トークンはサーバー側で再計算できる値にする (シートに平文で持たない).
// serial を増やすと, その利用者の全端末のトークンが無効になる.
function makeToken_(u) { return sha256hex_(u.tokenSalt + '|' + u.namekey + '|' + u.serial); }

// ---------------------------------------------------------------- users シート
var USER_COLS = 12;
function readUsers_() {
  var sh = getUsers_(), last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, USER_COLS).getValues();
  return rows.map(function (r, i) {
    return {
      row: i + 2, name: String(r[0]), namekey: String(r[1]), salt: String(r[2]), hash: String(r[3]),
      iter: +r[4] || HASH_ITER_DEFAULT, tokenSalt: String(r[5]), serial: +r[6] || 1,
      created: +r[7], lastLogin: +r[8], fail: +r[9] || 0, failUntil: +r[10] || 0, legacy: !!r[11],
    };
  });
}
function findUser_(namekey) {
  var us = readUsers_();
  for (var i = 0; i < us.length; ++i) if (us[i].namekey === namekey) return us[i];
  return null;
}
function touchUser_(u, fields) {
  var sh = getUsers_();
  if (fields.lastLogin != null) sh.getRange(u.row, 9).setValue(fields.lastLogin);
  if (fields.fail != null) sh.getRange(u.row, 10).setValue(fields.fail);
  if (fields.failUntil != null) sh.getRange(u.row, 11).setValue(fields.failUntil);
}

// scores に既にある名前か (先着 claim の判定に使う). 表示名は既存の表記に合わせる
function legacyInfo_(namekey) {
  var rows = readAll_(), n = 0, name = null, ts = -1;
  for (var i = 0; i < rows.length; ++i) {
    if (nameKey_(rows[i].name) !== namekey) continue;
    ++n;
    if (rows[i].ts > ts) { ts = rows[i].ts; name = rows[i].name; }
  }
  return { count: n, name: name };
}

// ---------------------------------------------------------------- ダンプ (バックアップ用)
var DUMP_MAX = 500;
function dump_(sheetName, from, limit) {
  var users = sheetName === USERS_SHEET;
  var sh = users ? getUsers_() : getSheet_();
  var cols = users ? USER_COLS : 6;
  var last = sh.getLastRow();
  var total = Math.max(0, last - 1);
  from = Math.max(0, Math.floor(from) || 0);
  limit = Math.min(Math.max(1, Math.floor(limit) || DUMP_MAX), DUMP_MAX);
  var n = Math.max(0, Math.min(limit, total - from));
  var vals = n ? sh.getRange(2 + from, 1, n, cols).getValues() : [];
  var rows = vals.map(function (r) {
    if (users) return { name: String(r[0]), namekey: String(r[1]), salt: String(r[2]), hash: String(r[3]), iter: +r[4], tokenSalt: String(r[5]), serial: +r[6], created: +r[7], lastLogin: +r[8], fail: +r[9], failUntil: +r[10], legacy: !!r[11] };
    return { ts: +r[0], stage: String(r[1]), name: String(r[2]), makespan: +r[3], moves: +r[4], paths: String(r[5]).split(',') };
  });
  var next = from + rows.length;
  return { ok: true, sheet: sheetName, total: total, from: from, count: rows.length, next: next < total ? next : null, rows: rows };
}

// ---------------------------------------------------------------- ランキング集計
function readAll_() {
  var sh = getSheet_(); var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, 5).getValues();
  return rows.map(function (r) { return { ts: +r[0], stage: String(r[1]), name: String(r[2]), makespan: +r[3], moves: +r[4] }; });
}
function cmpMakespan_(a, b) { return a.makespan - b.makespan || a.moves - b.moves || a.ts - b.ts; }
function cmpMoves_(a, b) { return a.moves - b.moves || a.makespan - b.makespan || a.ts - b.ts; }
// 総合部門: makespan × total distance の積が小さいほど上位
function score_(e) { return e.makespan * e.moves; }
function cmpTotal_(a, b) { return score_(a) - score_(b) || a.makespan - b.makespan || a.ts - b.ts; }
function bestPerName_(rows, cmp) {
  var best = {};
  rows.forEach(function (r) { var b = best[r.name]; if (!b || cmp(r, b) < 0) best[r.name] = r; });
  return Object.keys(best).map(function (k) { return best[k]; }).sort(cmp);
}
function board_(rows, stage) {
  var rs = rows.filter(function (r) { return r.stage === stage; });
  return { makespan: bestPerName_(rs, cmpMakespan_), moves: bestPerName_(rs, cmpMoves_), total: bestPerName_(rs, cmpTotal_) };
}
function strip_(e) { return e ? { name: e.name, makespan: e.makespan, moves: e.moves, ts: e.ts } : null; }

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.dump) {
      // トークンはスクリプトプロパティ BACKUP_TOKEN に設定する (未設定ならダンプ無効). 公開リポジトリに書かないこと
      var tok = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!tok) return json_({ ok: false, error: 'dump disabled' });
      if (!equalConst_(String(p.token || ''), String(tok))) return json_({ ok: false, error: 'bad token' });
      var sheet = String(p.sheet || SHEET_NAME);
      if (sheet !== SHEET_NAME && sheet !== USERS_SHEET) return json_({ ok: false, error: 'bad sheet' });
      return json_(dump_(sheet, +p.from || 0, +p.limit || DUMP_MAX));
    }
    if (p.bench) {
      // ハッシュの所要時間を実環境で測る (チューニング用). BACKUP_TOKEN で保護する
      var bt = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!bt || !equalConst_(String(p.token || ''), String(bt))) return json_({ ok: false, error: 'bad token' });
      var n = Math.min(Math.max(1, +p.n || 100), 2000);
      var t0 = Date.now();
      hashPw_('benchmark-password', 'benchmark-salt', n);
      var ms = Date.now() - t0;
      return json_({ ok: true, iterations: n, ms: ms, msPerIteration: ms / n, currentIter: hashIter_() });
    }
    if (p.checkname) {
      var nm = cleanName_(p.checkname), key = nameKey_(nm);
      if (!key) return json_({ ok: false, error: 'bad name' });
      var u = findUser_(key), lg = legacyInfo_(key);
      return json_({ ok: true, name: u ? u.name : (lg.name || nm), available: !u, taken: !!u, legacy: !u && lg.count > 0, submissions: lg.count });
    }
    if (p.recompute) {
      var rt = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
      if (!rt || !equalConst_(String(p.token || ''), String(rt))) return json_({ ok: false, error: 'bad token' });
      var rlock = LockService.getScriptLock(); rlock.waitLock(20000);
      try { return json_(recomputeRatings_()); } finally { rlock.releaseLock(); }
    }
    var rows = readAll_();
    if (p.ratings) return json_(ratingsResponse_(rows));
    if (p.stage) {
      var b = board_(rows, String(p.stage));
      return json_({ ok: true, stage: p.stage, makespan: b.makespan.slice(0, TOP_N).map(strip_), moves: b.moves.slice(0, TOP_N).map(strip_), total: b.total.slice(0, TOP_N).map(strip_), players: b.makespan.length });
    }
    if (p.all) {
      var best = {}, seen = {};
      rows.forEach(function (r) {
        if (seen[r.stage]) return; seen[r.stage] = true;
        var bb = board_(rows, r.stage);
        best[r.stage] = { makespan: strip_(bb.makespan[0]), moves: strip_(bb.moves[0]), total: strip_(bb.total[0]), players: bb.makespan.length };
      });
      return json_({ ok: true, best: best });
    }
    return json_({ ok: true, service: 'human-mapf-leaderboard', submissions: rows.length, auth: true, legacyUntil: new Date(legacyUntil_()).toISOString(), legacyOpen: Date.now() < legacyUntil_() });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body;
    try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
    var action = String(body.action || 'submit');
    lock.waitLock(20000);
    if (action === 'register') return json_(doRegister_(body));
    if (action === 'login') return json_(doLogin_(body));
    if (action === 'submit') return json_(doSubmit_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) { return json_({ ok: false, error: String(err) }); }
  finally { try { lock.releaseLock(); } catch (err) { } }
}

function checkPw_(pw) {
  pw = String(pw == null ? '' : pw);
  if (/[\u0000-\u001f]/.test(pw)) return 'password has control characters';
  if (pw.length < 8) return 'password too short';
  if (pw.length > 72) return 'password too long';
  return null;
}

// 新規登録. scores に既にある名前は「先着 claim」= 最初に登録した人がその名前と過去の記録を引き継ぐ
function doRegister_(body) {
  var name = cleanName_(body.name), key = nameKey_(name);
  if (!key) return { ok: false, error: 'bad name' };
  var pwErr = checkPw_(body.password);
  if (pwErr) return { ok: false, error: pwErr };
  if (findUser_(key)) return { ok: false, error: 'name taken' };
  var lg = legacyInfo_(key);
  if (lg.count > 0 && lg.name) name = lg.name;   // 既存の記録と同じ表記に揃える (ランキングは表示名で集計するため)
  var salt = randomHex_(), tokenSalt = randomHex_(), now = Date.now();
  var iter = hashIter_();
  var u = { name: name, namekey: key, salt: salt, hash: hashPw_(body.password, salt, iter), iter: iter, tokenSalt: tokenSalt, serial: 1 };
  getUsers_().appendRow([u.name, u.namekey, u.salt, u.hash, u.iter, u.tokenSalt, u.serial, now, now, 0, 0, lg.count > 0]);
  return { ok: true, name: u.name, token: makeToken_(u), legacy: lg.count > 0, claimed: lg.count };
}

function doLogin_(body) {
  var key = nameKey_(body.name);
  if (!key) return { ok: false, error: 'bad name' };
  var u = findUser_(key);
  var now = Date.now();
  if (!u) {
    var lg = legacyInfo_(key);
    return { ok: false, error: lg.count > 0 ? 'not registered (legacy)' : 'no such user', legacy: lg.count > 0, submissions: lg.count };
  }
  if (u.failUntil && now < u.failUntil) return { ok: false, error: 'locked', retryAfter: Math.ceil((u.failUntil - now) / 1000) };
  if (!equalConst_(hashPw_(body.password, u.salt, u.iter), u.hash)) {
    var fail = u.fail + 1;
    touchUser_(u, { fail: fail, failUntil: fail >= MAX_FAIL ? now + LOCK_MS : 0 });
    return { ok: false, error: 'wrong password', remaining: Math.max(0, MAX_FAIL - fail) };
  }
  touchUser_(u, { lastLogin: now, fail: 0, failUntil: 0 });
  return { ok: true, name: u.name, token: makeToken_(u), submissions: legacyInfo_(key).count };
}

// 投稿. 記録する名前はトークンから引いた登録済みの表示名を使う (body.name は照合のみ)
// 旧バージョンのページを開いたままの人にも意味が通じるよう, 案内文を添える
var RELOAD_HINT = ' — ページを再読み込みしてログインしてください / please reload the page and log in';
function doSubmit_(body) {
  var key = nameKey_(body.name);
  if (!key) return { ok: false, error: 'bad name' };
  var u = findUser_(key);
  // 投稿は登録済みアカウントのトークン必須 (移行期間は 2026-08-27 で終了. 未登録の名前は受け付けない)
  if (!u) return { ok: false, error: 'login required' + RELOAD_HINT };
  if (!equalConst_(String(body.token || ''), makeToken_(u))) return { ok: false, error: 'bad token' + RELOAD_HINT };
  return record_(body, u.name, false);
}

function record_(body, name, legacy) {
  var v = validate_(body, name);
  if (!v.ok) return { ok: false, error: v.error };
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
  return { ok: true, name: v.name, legacy: !!legacy, score: { makespan: v.makespan, moves: v.moves, total: v.makespan * v.moves }, makespan: rankIn(b.makespan), moves: rankIn(b.moves), total: rankIn(b.total) };
}

// 解の検証: ステージのマップ・start/goal を再生成し, 経路の合法性と衝突を確認. スコアはここで計算する
function validate_(body, name) {
  var stage = String(body.stage || '');
  var m = /^([a-z_][a-z0-9_]*):(\d+)$/.exec(stage);
  if (!m) return { ok: false, error: 'bad stage' };
  var def = null;
  for (var d = 0; d < MAPS.MAP_DEFS.length; ++d) if (MAPS.MAP_DEFS[d].id === m[1]) def = MAPS.MAP_DEFS[d];
  var N = +m[2];
  if (!def || def.agents.indexOf(N) < 0) return { ok: false, error: 'unknown stage' };
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
