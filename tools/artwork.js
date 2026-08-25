// tools/artwork.js — イメージイラスト (assets/hero.svg, 1200x630) を生成する
//   node tools/artwork.js
// 左: 実際の Random マップ (random:10) を LNS2 参考解の経路で途中まで解いている様子 / 右: タイトル
const fs = require('fs'), path = require('path');
const L = require('../src/lns2.js'), M = require('../src/maps.js'), R = require('../src/reference.js');

const STAGE = 'random:10';
const [mapId, N] = STAGE.split(':');
const map = M.getMap(mapId), ref = R[STAGE];
const decode = (start, str) => { const p = [start]; let c = start; for (const ch of str) { c += ch === 'R' ? 1 : ch === 'L' ? -1 : ch === 'D' ? map.w : ch === 'U' ? -map.w : 0; p.push(c); } return p; };
const toXY = c => [c % map.w, Math.floor(c / map.w)];

// 「解いている途中」に見せる: 一部のエージェントは経路を途中で切り, 1 台は手でドラッグ中
const PARTIAL = { 2: 0.55, 5: 0.7, 7: 0.45, 8: 0.6 };
const HAND = 7;
const agents = ref.paths.map((str, i) => {
  const full = decode(ref.starts[i], str);
  const frac = PARTIAL[i];
  const cut = frac ? Math.max(2, Math.round(full.length * frac)) : full.length;
  return { path: full.slice(0, cut).map(toXY), goal: toXY(ref.goals[i]), hand: i === HAND };
});

const W = 1200, H = 630;
const C = 30, BX = 40, BY = 75, COLS = map.w, ROWS = map.h;
const cx = i => BX + (i + 0.5) * C, cy = j => BY + (j + 0.5) * C;
const hue = i => (i * 137.508) % 360;
const col = i => `hsl(${hue(i).toFixed(1)}, 70%, 50%)`;

// レーン割当 (ゲームと同じ: 無向辺ごとに使用エージェントを並べる)
const ekey = (a, b) => { const ka = a[1] * COLS + a[0], kb = b[1] * COLS + b[0]; return ka < kb ? ka * 1000 + kb : kb * 1000 + ka; };
const lanes = new Map();
agents.forEach((ag, i) => {
  const seen = new Set();
  for (let k = 1; k < ag.path.length; ++k) {
    const a = ag.path[k - 1], b = ag.path[k]; if (a[0] === b[0] && a[1] === b[1]) continue;
    const kk = ekey(a, b); if (seen.has(kk)) continue; seen.add(kk);
    if (!lanes.has(kk)) lanes.set(kk, []); if (!lanes.get(kk).includes(i)) lanes.get(kk).push(i);
  }
});
const laneOff = (i, a, b) => { const arr = lanes.get(ekey(a, b)); if (!arr || arr.length < 2) return 0; const k = arr.indexOf(i); const sp = Math.min(C * 0.16, C * 0.7 / arr.length); return (k - (arr.length - 1) / 2) * sp; };

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Helvetica Neue', Helvetica, Arial, 'Hiragino Sans', 'Noto Sans JP', sans-serif">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ece8df"/><stop offset="1" stop-color="#e2ddd2"/></linearGradient>
  <filter id="shadow" x="-10%" y="-10%" width="130%" height="130%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000" flood-opacity="0.22"/></filter>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.25"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
`;
// 盤面
const BW = COLS * C, BH = ROWS * C;
svg += `<g filter="url(#shadow)"><rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="8" fill="#f4f1ea"/></g>`;
svg += `<g stroke="#000" stroke-opacity="0.08" stroke-width="1">`;
for (let i = 1; i < COLS; ++i) svg += `<line x1="${BX + i * C}" y1="${BY}" x2="${BX + i * C}" y2="${BY + BH}"/>`;
for (let j = 1; j < ROWS; ++j) svg += `<line x1="${BX}" y1="${BY + j * C}" x2="${BX + BW}" y2="${BY + j * C}"/>`;
svg += `</g>`;
for (let y = 0; y < ROWS; ++y) for (let x = 0; x < COLS; ++x) if (!map.free[y * COLS + x]) svg += `<rect x="${BX + x * C + 1}" y="${BY + y * C + 1}" width="${C - 2}" height="${C - 2}" rx="3" fill="#3b3a37"/>`;

// ゴール
agents.forEach((ag, i) => {
  const [gx, gy] = ag.goal; const r = C * 0.36;
  svg += `<rect x="${cx(gx) - r}" y="${cy(gy) - r}" width="${2 * r}" height="${2 * r}" rx="3" fill="${col(i)}" fill-opacity="0.15" stroke="${col(i)}" stroke-width="2"/>`;
  svg += `<text x="${cx(gx)}" y="${cy(gy) + 1}" font-size="${C * 0.38}" font-weight="700" fill="${col(i)}" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>`;
});
// 経路
agents.forEach((ag, i) => {
  let lastOff = [0, 0];
  for (let k = 1; k < ag.path.length; ++k) {
    const a = ag.path[k - 1], b = ag.path[k];
    if (a[0] === b[0] && a[1] === b[1]) { // 待機
      svg += `<circle cx="${cx(a[0]) + lastOff[0]}" cy="${cy(a[1]) + lastOff[1]}" r="${C * 0.1}" fill="${col(i)}"/>`; continue;
    }
    const off = laneOff(i, a, b);
    const x1 = cx(a[0]), y1 = cy(a[1]), x2 = cx(b[0]), y2 = cy(b[1]);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const ox = -uy * off, oy = ux * off;
    svg += `<line x1="${x1 + ox}" y1="${y1 + oy}" x2="${x2 + ox}" y2="${y2 + oy}" stroke="${col(i)}" stroke-width="3.5" stroke-linecap="round" stroke-opacity="0.85"/>`;
    const mx = (x1 + x2) / 2 + ox, my = (y1 + y2) / 2 + oy, ah = C * 0.17;
    svg += `<polygon points="${mx + ux * ah * 0.6},${my + uy * ah * 0.6} ${mx - ux * ah * 0.5 - uy * ah * 0.55},${my - uy * ah * 0.5 + ux * ah * 0.55} ${mx - ux * ah * 0.5 + uy * ah * 0.55},${my - uy * ah * 0.5 - ux * ah * 0.55}" fill="${col(i)}"/>`;
    lastOff = [ox, oy];
  }
});
// スタート点
agents.forEach((ag, i) => { if (ag.path.length > 1) { const [sx, sy] = ag.path[0]; svg += `<circle cx="${cx(sx)}" cy="${cy(sy)}" r="${C * 0.14}" fill="${col(i)}" fill-opacity="0.6"/>`; } });
// エージェント (先端)
agents.forEach((ag, i) => {
  const [hx, hy] = ag.path[ag.path.length - 1]; const r = C * 0.37;
  svg += `<g filter="url(#soft)"><circle cx="${cx(hx)}" cy="${cy(hy)}" r="${r}" fill="${col(i)}" stroke="#fff" stroke-width="2"/></g>`;
  svg += `<text x="${cx(hx)}" y="${cy(hy) + 1}" font-size="${r * 1.1}" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>`;
});
// 手 (ドラッグ中)
{
  const ag = agents.find(a => a.hand); const [hx, hy] = ag.path[ag.path.length - 1];
  const x = cx(hx) + 4, y = cy(hy) + 5;
  svg += `<g transform="translate(${x} ${y}) scale(0.95)" filter="url(#soft)">
    <path d="M6 20 L6 4 Q6 0 9.5 0 Q13 0 13 4 L13 14 L15 13 Q18 12 19 14 L21 13 Q24 12 25 14.5 L27 14 Q30 13.5 30.5 16 L30.5 26 Q30 36 22 38 L14 38 Q9 38 6 33 L0 24 Q-1.5 21 1.5 19.5 Q4 18.5 6 20 Z" fill="#fff" stroke="#2b2a28" stroke-width="2.2" stroke-linejoin="round"/>
  </g>`;
}
// 盤面のキャプション
svg += `<text x="${BX}" y="${BY + BH + 26}" font-size="14" fill="#666">Random — 10 agents</text>`;

// タイトル
const TX = 600;
svg += `<text x="${TX}" y="240" font-size="72" font-weight="800" fill="#2b2a28" letter-spacing="0.5">Human MAPF</text>`;
svg += `<text x="${TX}" y="290" font-size="27" font-weight="600" fill="#3b3a37">人力マルチエージェント経路計画</text>`;
svg += `<text x="${TX}" y="324" font-size="19" fill="#666">Multi-Agent Path Finding, solved by hand</text>`;
svg += `<text x="${TX}" y="392" font-size="20" fill="#2b2a28">全員をぶつけずにゴールへ。</text>`;
svg += `<text x="${TX}" y="424" font-size="20" fill="#2b2a28">makespan と total distance で MAPF ソルバーに挑め。</text>`;
svg += `<text x="${TX}" y="560" font-size="15" fill="#777">hirokinagai-39.github.io/human-mapf — ブラウザで無料 / 日本語・英語対応</text>`;
svg += `</svg>\n`;

const out = path.join(__dirname, '..', 'assets', 'hero.svg');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
console.log('wrote', out, (svg.length / 1024).toFixed(1) + ' KB');
