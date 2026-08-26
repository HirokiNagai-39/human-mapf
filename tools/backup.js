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
 *   scores-YYYYMMDD-HHMMSS.csv  … シートと同じ列 (ts,stage,name,makespan,moves,paths)
 *   scores-latest.json / .csv   … 最新のコピー (差分確認用)
 * 復旧はこの CSV をスプレッドシートの scores シートに貼り戻す (server/README.md 参照).
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
function toCsv(rows) {
  const lines = ['ts,stage,name,makespan,moves,paths'];
  for (const r of rows) lines.push([r.ts, r.stage, r.name, r.makespan, r.moves, (r.paths || []).join(',')].map(csvCell).join(','));
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

async function fetchPage(from) {
  const q = `dump=1&token=${encodeURIComponent(token)}&from=${from}&limit=500`;
  const j = await getJson(url + (url.includes('?') ? '&' : '?') + q);
  if (!j.ok) die('サーバーが拒否しました: ' + j.error + (j.error === 'dump disabled' ? ' (スクリプトプロパティ BACKUP_TOKEN が未設定, または再デプロイ忘れ)' : ''));
  // dump 未対応の古いデプロイだと ?dump=1 が無視され, サービス情報が返ってくる
  if (!Array.isArray(j.rows)) die('デプロイ済みの Apps Script が dump API に未対応です. dist/leaderboard.gs を貼り直し,\n「デプロイを管理 → 編集 → バージョン: 新バージョン」で再デプロイしてください\n応答: ' + JSON.stringify(j).slice(0, 200));
  return j;
}

(async () => {
  const rows = [];
  let from = 0, total = null;
  for (;;) {
    const j = await fetchPage(from);
    total = j.total;
    rows.push(...j.rows);
    process.stdout.write(`\r  ${rows.length}/${total} 件取得...`);
    if (j.next == null) break;
    if (j.count === 0) die('取得が進みません (count=0)');
    from = j.next;
  }
  process.stdout.write('\n');
  if (rows.length !== total) die(`件数が合いません (取得 ${rows.length} / サーバー ${total})`);

  const now = new Date(), tag = stamp(now);
  fs.mkdirSync(outDir, { recursive: true });
  const json = JSON.stringify({ fetchedAt: now.toISOString(), url, total, rows }, null, 1) + '\n';
  const csv = toCsv(rows);
  const written = [];
  for (const [name, data] of [[`scores-${tag}.json`, json], [`scores-${tag}.csv`, csv], ['scores-latest.json', json], ['scores-latest.csv', csv]]) {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, data);
    written.push(p);
  }

  const stages = new Set(), players = new Set();
  for (const r of rows) { stages.add(r.stage); players.add(r.name); }
  const times = rows.map(r => r.ts).filter(t => t > 0);
  console.log(`${total} 件 / ${players.size} プレイヤー / ${stages.size} ステージ`);
  if (times.length) console.log(`期間: ${new Date(Math.min(...times)).toLocaleString()} 〜 ${new Date(Math.max(...times)).toLocaleString()}`);
  for (const p of written) console.log('  wrote ' + path.relative(ROOT, p) + ' (' + (fs.statSync(p).size / 1024).toFixed(1) + ' KB)');
})().catch(e => die(String((e && e.stack) || e)));
