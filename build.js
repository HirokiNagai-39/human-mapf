// build.js — src/ を 1 つの HTML にまとめる (dist/mapf_puzzle.html = 配布用, docs/index.html = GitHub Pages 用). 依存なし: `node build.js`
const fs = require('fs'), path = require('path');
const src = p => fs.readFileSync(path.join(__dirname, 'src', p), 'utf8');
let html = src('index.html');
const LICENSE_HEADER = `<!--
  Human MAPF — (c) 2026 Hiroki Nagai. Licensed under CC BY-ND 4.0 (https://creativecommons.org/licenses/by-nd/4.0/):
  you may play and redistribute this file unmodified with attribution; distributing modified versions is NOT permitted.
  Contains a JavaScript port of the LNS2 solver from https://github.com/HirokiNagai-39/mawpf (MIT License, (c) 2026 AIST).
  See https://github.com/HirokiNagai-39/human-mapf/blob/main/LICENSE.md
-->
`;
html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n' + LICENSE_HEADER);
html = html.replace(/<!-- BUILD:CSS -->[\s\S]*?<!-- \/BUILD:CSS -->/, () => `<style>\n${src('style.css')}\n</style>`);
html = html.replace(/<!-- BUILD:JS -->[\s\S]*?<!-- \/BUILD:JS -->/, () =>
  ['lns2.js', 'maps.js', 'reference.js', 'difficulty.js', 'config.js', 'gif.js', 'leaderboard.js', 'game.js'].map(f => `<script>\n${src(f).replace(/<\/script>/g, '<\\/script>')}\n</script>`).join('\n'));
// ランキングサーバー (Google Apps Script) 用: ソルバー + マップ + サーバーコードを 1 ファイルに
const gs = ['lns2.js', 'maps.js', 'reference.js', 'difficulty.js'].map(src).join('\n') + '\n'
  + ['leaderboard.gs', 'rating.gs'].map(f => fs.readFileSync(path.join(__dirname, 'server', f), 'utf8')).join('\n');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'leaderboard.gs'), gs);
console.log('wrote dist/leaderboard.gs', (gs.length / 1024).toFixed(1) + ' KB');
for (const out of [path.join(__dirname, 'dist', 'mapf_puzzle.html'), path.join(__dirname, 'docs', 'index.html')]) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
}
