#!/usr/bin/env node
/*
 * tools/backup.js — オンラインランキング (Google Apps Script + スプレッドシート) の全投稿を手元に保存する
 *
 * 準備 (1 回だけ):
 *   1. Apps Script エディタ → 左の歯車 (プロジェクトの設定) → スクリプト プロパティ に
 *      BACKUP_TOKEN = <好きな長い文字列> を追加 (未設定ならダンプ API は無効のまま)
 *   2. デプロイ → デプロイを管理 → 編集 → バージョン: 新バージョン で再デプロイ
 *
 * 使い方:
 *   HUMAN_MAPF_BACKUP_TOKEN=xxxx node tools/backup.js
 *   node tools/backup.js --token xxxx [--out backups] [--url https://script.google.com/.../exec]
 *
 * 出力 (既定は backups/, .gitignore 済み):
 *   scores-YYYYMMDD-HHMMSS.json … { fetchedAt, url, total, rows: [{ts,stage,name,makespan,moves,paths}] }
 *   scores-YYYYMMDD-HHMMSS.csv  … scores シートと同じ列
 *   users-YYYYMMDD-HHMMSS.json / .csv … アカウント (パスワードのハッシュとソルト. 平文は保存されていない)
 *   scores-latest.* / users-latest.*  … 最新のコピー (差分確認用)
 * 復旧はこの CSV をスプレッドシートの各シートに貼り戻す (server/README.md 参照).
 * users のバックアップにはログイン情報が含まれるので, 取り扱いは scores より慎重に.
 */
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function die(msg) { console.error('error: ' + msg); process.exit(1); }

function configUrl() {
  const m = /leaderboardUrl:\s*'([^']*)'/.exec(fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8'));
  return m ? m[1].trim() : '';
}

const url = (arg('url') || configUrl()).trim();
const token = arg('token') || process.env.HUMAN_MAPF_BACKUP_TOKEN || '';
const outDir = path.resolve(ROOT, arg('out', 'backups'));
if (!url) die('ランキング URL が分かりません (src/config.js の leaderboardUrl か --url で指定)');
if (!token) die('トークンがありません (HUMAN_MAPF_BACKUP_TOKEN 環境変数か --token で指定)');

function stamp(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
function csvCell(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const COLS = {
  scores: ['ts', 'stage', 'name', 'makespan', 'moves', 'paths'],
  users: ['name', 'namekey', 'salt', 'hash', 'iter', 'tokenSalt', 'serial', 'created', 'lastLogin', 'fail', 'failUntil', 'legacy'],
};
function toCsv(sheet, rows) {
  const cols = COLS[sheet];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => csvCell(Array.isArray(r[c]) ? r[c].join(',') : r[c])).join(','));
  return lines.join('\n') + '\n';
}

// GAS のウェブアプリは exec → script.googleusercontent.com へ 302 する. リダイレクト先はときどき 404 の
// HTML を返す (数秒後には成功する) ので, 自分でリダイレクトをたどりつつリトライする
async function getJson(u) {
  let last = '';
  for (let attempt = 0; attempt < 4; ++attempt) {
    if (attempt) await sleep(1000 * attempt);
    let cur = u, res = null;
    for (let hop = 0; hop < 5; ++hop) {
      res = await fetch(cur, { redirect: 'manual', headers: { Accept: 'application/json' } });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).href; res = null; continue; }
      break;
    }
    if (!res) { last = 'リダイレクトが多すぎます'; continue; }
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { last = 'HTTP ' + res.status + ': ' + text.slice(0, 200); }
  }
  die('サーバーから JSON が取れませんでした (4 回試行)\n' + last);
}

async function fetchPage(sheet, from) {
  const q = `dump=1&token=${encodeURIComponent(token)}&sheet=${sheet}&from=${from}&limit=500`;
  const j = await getJson(url + (url.includes('?') ? '&' : '?') + q);
  if (!j.ok) die('サーバーが拒否しました: ' + j.error + (j.error === 'dump disabled' ? ' (スクリプトプロパティ BACKUP_TOKEN が未設定, または再デプロイ忘れ)' : ''));
  // dump 未対応の古いデプロイだと ?dump=1 が無視され, サービス情報が返ってくる
  if (!Array.isArray(j.rows)) die('デプロイ済みの Apps Script が dump API に未対応です. dist/leaderboard.gs を貼り直し,\n「デプロイを管理 → 編集 → バージョン: 新バージョン」で再デプロイしてください\n応答: ' + JSON.stringify(j).slice(0, 200));
  // sheet を指定できない世代のサーバーは指定を無視して scores を返してくる. 取り違えないように確かめる
  if (j.sheet == null) return sheet === 'scores' ? j : null;
  if (j.sheet !== sheet) die(`サーバーが別のシートを返しました (要求 ${sheet} / 応答 ${j.sheet})`);
  return j;
}

async function fetchSheet(sheet) {
  const rows = [];
  let from = 0, total = null;
  for (;;) {
    const j = await fetchPage(sheet, from);
    if (!j) return null;              // このサーバーはまだこのシートに対応していない
    total = j.total;
    rows.push(...j.rows);
    process.stdout.write(`\r  ${sheet}: ${rows.length}/${total} 件取得...   `);
    if (j.next == null) break;
    if (j.count === 0) die('取得が進みません (count=0)');
    from = j.next;
  }
  process.stdout.write('\n');
  if (rows.length !== total) die(`${sheet} の件数が合いません (取得 ${rows.length} / サーバー ${total})`);
  return rows;
}

(async () => {
  const rows = await fetchSheet('scores');
  const users = await fetchSheet('users');
  const total = rows.length;
  if (!users) console.log('  注意: サーバーが users のダンプに未対応のため、アカウントは保存していません (Apps Script が更新前)');

  const now = new Date(), tag = stamp(now);
  fs.mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify({ fetchedAt: now.toISOString(), url, total, rows }, null, 1) + '\n';
  const csv = toCsv('scores', rows);
  const files = [[`scores-${tag}.json`, json], [`scores-${tag}.csv`, csv], ['scores-latest.json', json], ['scores-latest.csv', csv]];
  if (users) {
    const ujson = JSON.stringify({ fetchedAt: now.toISOString(), url, total: users.length, rows: users }, null, 1) + '\n';
    const ucsv = toCsv('users', users);
    files.push([`users-${tag}.json`, ujson], [`users-${tag}.csv`, ucsv], ['users-latest.json', ujson], ['users-latest.csv', ucsv]);
  }
  const written = [];
  for (const [name, data] of files) {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, data);
    written.push(p);
  }

  const stages = new Set(), players = new Set();
  for (const r of rows) { stages.add(r.stage); players.add(r.name); }
  const times = rows.map(r => r.ts).filter(t => t > 0);
  console.log(`投稿 ${total} 件 / 名前 ${players.size} 種 / ${stages.size} ステージ` + (users ? ` / 登録アカウント ${users.length} 件` : ' / アカウント: 未取得'));
  if (times.length) console.log(`期間: ${new Date(Math.min(...times)).toLocaleString()} 〜 ${new Date(Math.max(...times)).toLocaleString()}`);
  for (const p of written) console.log('  wrote ' + path.relative(ROOT, p) + ' (' + (fs.statSync(p).size / 1024).toFixed(1) + ' KB)');
})().catch(e => die(String((e && e.stack) || e)));
