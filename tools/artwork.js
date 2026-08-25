// tools/artwork.js — イメージイラスト (assets/hero.svg, 1200x630) を生成する
//   node tools/artwork.js
const fs = require('fs'), path = require('path');

const W = 1200, H = 630;
const C = 44, BX = 36, BY = 95, COLS = 14, ROWS = 10;
const cx = (i) => BX + (i + 0.5) * C, cy = (j) => BY + (j + 0.5) * C;
const hue = (i) => (i * 137.508) % 360;
const col = (i) => `hsl(${hue(i).toFixed(1)}, 70%, 50%)`;

const obstacles = [];
for (let x = 3; x <= 7; ++x) { obstacles.push([x, 3]); obstacles.push([x, 6]); }
obstacles.push([10, 1], [11, 5], [1, 8], [12, 8]);

// 経路 (セル列). 最後の要素が現在位置 (先端). goal は別途
const agents = [
  { path: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [8, 3], [8, 4]], goal: [8, 4] },
  { path: [[13, 9], [12, 9], [11, 9], [10, 9], [9, 9], [9, 8], [9, 7], [9, 6], [9, 5], [8, 5], [7, 5], [6, 5], [5, 5], [4, 5], [3, 5], [2, 5], [1, 5], [1, 4]], goal: [1, 4] },
  { path: [[12, 2], [12, 3], [12, 4], [11, 4], [10, 4], [9, 4], [9, 5], [9, 6], [9, 7], [9, 8], [8, 8], [7, 8], [6, 8]], goal: [4, 8], hand: true },
  { path: [[6, 1], [6, 2], [7, 2], [8, 2], [9, 2], [9, 3], [10, 3], [10, 4], [10, 5], [10, 6], [10, 7], [10, 8], [10, 9], [11, 9]], goal: [12, 9] },
  { path: [[5, 4], [4, 4], [3, 4], [2, 4], [2, 3], [2, 2], [1, 2], [0, 2]], goal: [0, 2] },
  { path: [[13, 3], [13, 4], [13, 5], [13, 5], [13, 6], [12, 6], [11, 6], [11, 7]], goal: [11, 7] },
];

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
for (const [x, y] of obstacles) svg += `<rect x="${BX + x * C + 1}" y="${BY + y * C + 1}" width="${C - 2}" height="${C - 2}" rx="3" fill="#3b3a37"/>`;

// ゴール
agents.forEach((ag, i) => {
  const [gx, gy] = ag.goal; const r = C * 0.36;
  svg += `<rect x="${cx(gx) - r}" y="${cy(gy) - r}" width="${2 * r}" height="${2 * r}" rx="4" fill="${col(i)}" fill-opacity="0.15" stroke="${col(i)}" stroke-width="2.5"/>`;
  svg += `<text x="${cx(gx)}" y="${cy(gy) + 1}" font-size="${C * 0.36}" font-weight="700" fill="${col(i)}" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>`;
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
    svg += `<line x1="${x1 + ox}" y1="${y1 + oy}" x2="${x2 + ox}" y2="${y2 + oy}" stroke="${col(i)}" stroke-width="5" stroke-linecap="round" stroke-opacity="0.85"/>`;
    const mx = (x1 + x2) / 2 + ox, my = (y1 + y2) / 2 + oy, ah = C * 0.16;
    svg += `<polygon points="${mx + ux * ah * 0.6},${my + uy * ah * 0.6} ${mx - ux * ah * 0.5 - uy * ah * 0.55},${my - uy * ah * 0.5 + ux * ah * 0.55} ${mx - ux * ah * 0.5 + uy * ah * 0.55},${my - uy * ah * 0.5 - ux * ah * 0.55}" fill="${col(i)}"/>`;
    lastOff = [ox, oy];
  }
  // 残り (先端からゴールまで) を点線で
  const hd = ag.path[ag.path.length - 1];
  if (hd[0] !== ag.goal[0] || hd[1] !== ag.goal[1]) svg += `<line x1="${cx(hd[0])}" y1="${cy(hd[1])}" x2="${cx(ag.goal[0])}" y2="${cy(ag.goal[1])}" stroke="${col(i)}" stroke-width="2" stroke-dasharray="4 5" stroke-opacity="0.5"/>`;
});
// スタート点
agents.forEach((ag, i) => { const [sx, sy] = ag.path[0]; svg += `<circle cx="${cx(sx)}" cy="${cy(sy)}" r="${C * 0.14}" fill="${col(i)}" fill-opacity="0.6"/>`; });
// エージェント (先端)
agents.forEach((ag, i) => {
  const [hx, hy] = ag.path[ag.path.length - 1]; const r = C * 0.37;
  svg += `<g filter="url(#soft)"><circle cx="${cx(hx)}" cy="${cy(hy)}" r="${r}" fill="${col(i)}" stroke="#fff" stroke-width="2.5"/></g>`;
  svg += `<text x="${cx(hx)}" y="${cy(hy) + 1}" font-size="${r * 1.05}" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>`;
});
// 手 (ドラッグ中)
{
  const ag = agents.find(a => a.hand); const [hx, hy] = ag.path[ag.path.length - 1];
  const x = cx(hx) + 6, y = cy(hy) + 8;
  svg += `<g transform="translate(${x} ${y}) scale(1.15)" filter="url(#soft)">
    <path d="M6 20 L6 4 Q6 0 9.5 0 Q13 0 13 4 L13 14 L15 13 Q18 12 19 14 L21 13 Q24 12 25 14.5 L27 14 Q30 13.5 30.5 16 L30.5 26 Q30 36 22 38 L14 38 Q9 38 6 33 L0 24 Q-1.5 21 1.5 19.5 Q4 18.5 6 20 Z" fill="#fff" stroke="#2b2a28" stroke-width="2.2" stroke-linejoin="round"/>
  </g>`;
}
// タイトル
const TX = 700;
svg += `<text x="${TX}" y="205" font-size="64" font-weight="800" fill="#2b2a28" letter-spacing="0.5">Human MAPF</text>`;
svg += `<text x="${TX}" y="250" font-size="25" font-weight="600" fill="#3b3a37">人力マルチエージェント経路計画</text>`;
svg += `<text x="${TX}" y="282" font-size="18" fill="#666">Multi-Agent Path Finding, solved by hand</text>`;
svg += `<text x="${TX}" y="340" font-size="18" fill="#2b2a28">全員をぶつけずにゴールへ。</text>`;
svg += `<text x="${TX}" y="368" font-size="18" fill="#2b2a28">makespan と total distance で MAPF ソルバーに挑め。</text>`;
// ランクチップ
const chips = [['DIAMOND', '#1e9be0'], ['PLATINUM', '#78909c'], ['GOLD', '#d4a017'], ['SILVER', '#9e9e9e'], ['BRONZE', '#a5602c']];
let x = TX; const yChip = 412;
for (const [name, c] of chips) {
  const w = name.length * 9.2 + 20;
  svg += `<rect x="${x}" y="${yChip}" width="${w}" height="28" rx="14" fill="${c}"/><text x="${x + w / 2}" y="${yChip + 15}" font-size="12" font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="middle" letter-spacing="0.4">${name}</text>`;
  x += w + 7;
}
// 衝突ルールのミニ図 (頂点衝突 ✗ / 追従 ○)
const mini = (x0, y0, items, cap, capColor) => {
  const s = 30; let o = `<g transform="translate(${x0} ${y0})"><rect x="0" y="0" width="${3 * s}" height="${s}" fill="#f4f1ea" stroke="#bbb"/><line x1="${s}" y1="0" x2="${s}" y2="${s}" stroke="#ccc"/><line x1="${2 * s}" y1="0" x2="${2 * s}" y2="${s}" stroke="#ccc"/>`;
  for (const it of items) {
    if (it.t === 'a') o += `<circle cx="${(it.x + 0.5) * s}" cy="${s / 2}" r="${s * 0.32}" fill="${it.c}" fill-opacity="${it.g ? 0.35 : 1}" stroke="#fff" stroke-width="1.5"/>`;
    if (it.t === 'ar') { const x1 = (it.x1 + 0.5) * s, x2 = (it.x2 + 0.5) * s; const d = Math.sign(x2 - x1); o += `<line x1="${x1 + d * s * 0.3}" y1="${s / 2}" x2="${x2 - d * s * 0.42}" y2="${s / 2}" stroke="${it.c}" stroke-width="2.5"/><polygon points="${x2 - d * s * 0.3},${s / 2} ${x2 - d * s * 0.48},${s / 2 - 5} ${x2 - d * s * 0.48},${s / 2 + 5}" fill="${it.c}"/>`; }
    if (it.t === 'x') { const cxx = (it.x + 0.5) * s, r = s * 0.26; o += `<path d="M${cxx - r},${s / 2 - r} L${cxx + r},${s / 2 + r} M${cxx + r},${s / 2 - r} L${cxx - r},${s / 2 + r}" stroke="#e02020" stroke-width="3.5" stroke-linecap="round"/>`; }
  }
  o += `<text x="${3 * s + 10}" y="${s / 2 + 1}" font-size="14" font-weight="600" fill="${capColor}" dominant-baseline="middle">${cap}</text></g>`;
  return o;
};
const A = '#e0492f', B = '#2f6fe0';
svg += mini(TX, 470, [{ t: 'a', x: 0, c: A }, { t: 'a', x: 2, c: B }, { t: 'ar', x1: 0, x2: 1, c: A }, { t: 'ar', x1: 2, x2: 1, c: B }, { t: 'x', x: 1 }], '同じマスに同時に入ると衝突', '#d32f2f');
svg += mini(TX, 514, [{ t: 'a', x: 0, c: B }, { t: 'a', x: 1, c: A }, { t: 'ar', x1: 1, x2: 2, c: A }, { t: 'ar', x1: 0, x2: 1, c: B }], '列になって進むのは OK', '#2f7d32');
svg += `<text x="${TX}" y="590" font-size="13" fill="#777">hirokinagai-39.github.io/human-mapf — ブラウザで無料 / 日本語・英語対応</text>`;
svg += `</svg>\n`;

const out = path.join(__dirname, '..', 'assets', 'hero.svg');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
console.log('wrote', out, (svg.length / 1024).toFixed(1) + ' KB');
