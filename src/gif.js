/*
 * gif.js — 依存なしの GIF89a エンコーダ (LZW, グローバルパレット 255 色 + 透明 1 色, 差分フレーム)
 *   const q = new GIF.Quantizer(); q.sample(imageData) ...; const pal = q.build();
 *   const enc = new GIF.Encoder(w, h, pal); enc.addFrame(indices, delayCs); const bytes = enc.finish();
 *   indices は Uint8Array(w*h). 255 = 透明 (前フレームのまま).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GIF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- byte buffer
  function ByteBuf() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  ByteBuf.prototype.ensure = function (k) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2; while (cap < this.n + k) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.n)); this.buf = nb;
  };
  ByteBuf.prototype.byte = function (b) { this.ensure(1); this.buf[this.n++] = b & 0xff; };
  ByteBuf.prototype.bytes = function (arr, off, len) { this.ensure(len); this.buf.set(arr.subarray(off, off + len), this.n); this.n += len; };
  ByteBuf.prototype.short = function (v) { this.byte(v & 0xff); this.byte((v >> 8) & 0xff); };
  ByteBuf.prototype.str = function (s) { for (let i = 0; i < s.length; ++i) this.byte(s.charCodeAt(i)); };
  ByteBuf.prototype.result = function () { return this.buf.slice(0, this.n); };

  // ---------------------------------------------------------------- LZW (GIF 版, 最大 12 bit)
  const HSIZE = 5003, MAXBITS = 12, MAXMAXCODE = 1 << MAXBITS;
  const MASKS = [0x0000, 0x0001, 0x0003, 0x0007, 0x000F, 0x001F, 0x003F, 0x007F, 0x00FF, 0x01FF, 0x03FF, 0x07FF, 0x0FFF, 0x1FFF, 0x3FFF, 0x7FFF, 0xFFFF];
  const htab = new Int32Array(HSIZE), codetab = new Int32Array(HSIZE), accum = new Uint8Array(256);

  function lzwEncode(pixels, minCodeSize, out) {
    const initBits = minCodeSize + 1;
    const clearCode = 1 << minCodeSize, eofCode = clearCode + 1;
    let nBits = initBits, maxcode = (1 << nBits) - 1, freeEnt = clearCode + 2, clearFlg = false;
    let curAccum = 0, curBits = 0, aCount = 0;
    let hshift = 0; for (let f = HSIZE; f < 65536; f *= 2) ++hshift; hshift = 8 - hshift;

    const flush = () => { if (aCount > 0) { out.byte(aCount); out.bytes(accum, 0, aCount); aCount = 0; } };
    const charOut = c => { accum[aCount++] = c; if (aCount >= 254) flush(); };
    const output = code => {
      curAccum &= MASKS[curBits];
      curAccum = curBits > 0 ? (curAccum | (code << curBits)) : code;
      curBits += nBits;
      while (curBits >= 8) { charOut(curAccum & 0xff); curAccum >>>= 8; curBits -= 8; }
      if (freeEnt > maxcode || clearFlg) {
        if (clearFlg) { nBits = initBits; maxcode = (1 << nBits) - 1; clearFlg = false; }
        else { ++nBits; maxcode = nBits === MAXBITS ? MAXMAXCODE : (1 << nBits) - 1; }
      }
      if (code === eofCode) {
        while (curBits > 0) { charOut(curAccum & 0xff); curAccum >>>= 8; curBits -= 8; }
        flush();
      }
    };

    out.byte(minCodeSize);
    htab.fill(-1);
    let ent = pixels[0];
    output(clearCode);
    const n = pixels.length;
    outer: for (let p = 1; p < n; ++p) {
      const c = pixels[p];
      const fcode = (c << MAXBITS) + ent;
      let i = (c << hshift) ^ ent;
      if (htab[i] === fcode) { ent = codetab[i]; continue; }
      if (htab[i] >= 0) {
        let disp = HSIZE - i; if (i === 0) disp = 1;
        do {
          if ((i -= disp) < 0) i += HSIZE;
          if (htab[i] === fcode) { ent = codetab[i]; continue outer; }
        } while (htab[i] >= 0);
      }
      output(ent);
      ent = c;
      if (freeEnt < MAXMAXCODE) { codetab[i] = freeEnt++; htab[i] = fcode; }
      else { htab.fill(-1); freeEnt = clearCode + 2; clearFlg = true; output(clearCode); }
    }
    output(ent);
    output(eofCode);
    out.byte(0); // block terminator
  }

  // ---------------------------------------------------------------- encoder
  const TRANSPARENT = 255;
  function Encoder(w, h, palette) {
    this.w = w; this.h = h; this.out = new ByteBuf(); this.frames = 0;
    const o = this.out;
    o.str('GIF89a');
    o.short(w); o.short(h);
    o.byte(0xF7); o.byte(0); o.byte(0);            // global color table 256 entries, 8 bit
    for (let i = 0; i < 256; ++i) {
      const c = palette[i] || [0, 0, 0];
      o.byte(c[0]); o.byte(c[1]); o.byte(c[2]);
    }
    o.byte(0x21); o.byte(0xFF); o.byte(11); o.str('NETSCAPE2.0'); o.byte(3); o.byte(1); o.short(0); o.byte(0); // loop forever
  }
  // indices: Uint8Array(w*h), 255 = 透明 (前フレームの画素を維持)
  Encoder.prototype.addFrame = function (indices, delayCs) {
    const o = this.out;
    o.byte(0x21); o.byte(0xF9); o.byte(4);
    o.byte((1 << 2) | 1);                            // disposal = 1 (残す), transparent flag
    o.short(Math.max(2, Math.round(delayCs)));
    o.byte(TRANSPARENT); o.byte(0);
    o.byte(0x2C); o.short(0); o.short(0); o.short(this.w); o.short(this.h); o.byte(0);
    lzwEncode(indices, 8, o);
    this.frames++;
  };
  Encoder.prototype.finish = function () { this.out.byte(0x3B); return this.out.result(); };

  // ---------------------------------------------------------------- quantizer
  // 5bit/ch のバケットで出現頻度上位 255 色を採用. map() で最近傍にマッピング (キャッシュ付き)
  function Quantizer() { this.count = new Map(); }
  Quantizer.prototype.sample = function (data, step) {
    step = step || 1;
    const cnt = this.count;
    for (let i = 0; i < data.length; i += 4 * step) {
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      const e = cnt.get(key);
      if (e) { e[0]++; e[1] += data[i]; e[2] += data[i + 1]; e[3] += data[i + 2]; }
      else cnt.set(key, [1, data[i], data[i + 1], data[i + 2]]);
    }
  };
  Quantizer.prototype.build = function () {
    const arr = [...this.count.values()].sort((a, b) => b[0] - a[0]).slice(0, 255);
    this.palette = arr.map(e => [Math.round(e[1] / e[0]), Math.round(e[2] / e[0]), Math.round(e[3] / e[0])]);
    while (this.palette.length < 255) this.palette.push([0, 0, 0]);
    this.palette.push([0, 0, 0]); // 255: transparent slot
    this.cache = new Map();
    return this.palette;
  };
  Quantizer.prototype.index = function (r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    let idx = this.cache.get(key);
    if (idx !== undefined) return idx;
    let best = 0, bd = Infinity; const P = this.palette;
    for (let i = 0; i < 255; ++i) {
      const dr = P[i][0] - r, dg = P[i][1] - g, db = P[i][2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    this.cache.set(key, best);
    return best;
  };
  // RGBA → インデックス. prev (前フレームのインデックス) を渡すと同一画素を透明にする. cur は書き込み先 (再利用可)
  Quantizer.prototype.map = function (data, prev, cur) {
    const n = data.length >> 2;
    const full = cur || new Uint8Array(n);
    const diff = prev ? new Uint8Array(n) : null;
    for (let p = 0, i = 0; p < n; ++p, i += 4) {
      const idx = this.index(data[i], data[i + 1], data[i + 2]);
      if (diff) diff[p] = (idx === prev[p]) ? TRANSPARENT : idx;
      full[p] = idx;
    }
    return { full, frame: diff || full };
  };

  return { Encoder, Quantizer, lzwEncode, TRANSPARENT };
});
