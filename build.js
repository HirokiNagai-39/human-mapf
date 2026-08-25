// build.js — src/ を 1 つの HTML にまとめる (dist/mapf_puzzle.html = 配布用, docs/index.html = GitHub Pages 用). 依存なし: `node build.js`
const fs = require('fs'), path = require('path');
const src = p => fs.readFileSync(path.join(__dirname, 'src', p), 'utf8');
let html = src('index.html');
html = html.replace(/<!-- BUILD:CSS -->[\s\S]*?<!-- \/BUILD:CSS -->/, () => `<style>\n${src('style.css')}\n</style>`);
html = html.replace(/<!-- BUILD:JS -->[\s\S]*?<!-- \/BUILD:JS -->/, () =>
  ['lns2.js', 'maps.js', 'reference.js', 'game.js'].map(f => `<script>\n${src(f).replace(/<\/script>/g, '<\\/script>')}\n</script>`).join('\n'));
for (const out of [path.join(__dirname, 'dist', 'mapf_puzzle.html'), path.join(__dirname, 'docs', 'index.html')]) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
}
