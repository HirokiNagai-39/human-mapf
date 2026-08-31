/*
 * leaderboard.js — オンラインランキングのクライアント (バックエンド: server/leaderboard.gs = Google Apps Script)
 *   LB.configured()                 バックエンド URL が設定されているか (src/config.js)
 *   LB.top(stage)     → { makespan: [...], moves: [...], total: [...] }  各部門の上位 (同名はその部門の自己ベストのみ)
 *                       部門は 3 つ: makespan / total distance / 総合 (makespan × distance の積が小さいほど上位)
 *   LB.all()          → { stage: { makespan: entry, moves: entry } }  各ステージ・各部門の 1 位
 *   LB.checkName(name)→ { name, available, taken, legacy, submissions } 登録前の名前チェック
 *   LB.register(name, password) → { name, token, legacy, claimed }    新規登録 (既存名は先着 claim)
 *   LB.login(name, password)    → { name, token, submissions }        ログイン
 *   LB.submit(stage, name, token, paths) → { ok, score, makespan:{...}, moves:{...} }
 *   entry = { name, makespan, moves, ts }
 * 部門の順序: makespan 部門 = makespan 昇順 → 総移動距離 昇順 → 登録時刻昇順 / 総移動距離部門はその逆
 * 投稿にはログインが必須. 記録される名前はサーバーがトークンから引くので, 名前を騙ることはできない.
 */
(function (root) {
  'use strict';
  const TIMEOUT_MS = 20000;
  // 登録・ログインはサーバー側でパスワードのハッシュ計算が入るぶん時間がかかる
  const AUTH_TIMEOUT_MS = 60000;

  function url() { return (root.CONFIG && root.CONFIG.leaderboardUrl || '').trim(); }
  function sanitizeName(s) {
    s = String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
    return s.slice(0, 16);
  }
  // サーバーの nameKey_ と同じ規則. 同一性の判定にだけ使う (表示は元の文字列)
  function nameKey(s) { return sanitizeName(s).normalize('NFKC').replace(/\s+/g, '').toLowerCase(); }
  const cmpMakespan = (a, b) => a.makespan - b.makespan || a.moves - b.moves || (a.ts || 0) - (b.ts || 0);
  const cmpMoves = (a, b) => a.moves - b.moves || a.makespan - b.makespan || (a.ts || 0) - (b.ts || 0);
  // 総合部門: makespan × total distance の積が小さいほど上位
  const totalScore = e => e.makespan * e.moves;
  const cmpTotal = (a, b) => totalScore(a) - totalScore(b) || a.makespan - b.makespan || (a.ts || 0) - (b.ts || 0);

  // GAS はまれに一時エラー (429/500 や HTML のエラーページ) を返すので, GET だけ少し待って再試行する.
  // POST (登録・ログイン・投稿) は二重実行になり得るため再試行しない.
  // サーバーが ok:false を返したもの (e.detail あり) は何度送っても同じなので再試行しない.
  const RETRY_DELAYS_MS = [1000, 3000];
  async function request(method, params, body, timeoutMs) {
    if (!url()) throw new Error('not configured');
    for (let attempt = 0; ; ++attempt) {
      try { return await requestOnce(method, params, body, timeoutMs); }
      catch (e) {
        if (method !== 'GET' || (e && e.detail) || attempt >= RETRY_DELAYS_MS.length) throw e;
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  async function requestOnce(method, params, body, timeoutMs) {
    const base = url(); if (!base) throw new Error('not configured');
    const q = Object.entries(params || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
    try {
      const res = await fetch(base + (q ? (base.includes('?') ? '&' : '?') + q : ''), {
        method, body: body ? JSON.stringify(body) : undefined, redirect: 'follow', signal: ctrl && ctrl.signal,
        // text/plain にして CORS プリフライトを避ける (GAS ウェブアプリは OPTIONS に応答しない)
        headers: body ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
      });
      const j = await res.json();
      if (!j || j.ok === false) { const e = new Error((j && j.error) || 'server error'); e.detail = j; throw e; }
      return j;
    } catch (e) {
      // 打ち切ったときのブラウザ既定のメッセージは意味が分からないので、判別できる印を付ける
      if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) { const t = new Error('timeout'); t.timeout = true; throw t; }
      throw e;
    } finally { if (timer) clearTimeout(timer); }
  }

  root.LB = {
    configured: () => !!url(),
    sanitizeName, nameKey, cmpMakespan, cmpMoves, cmpTotal, totalScore,
    async top(stage) {
      const j = await request('GET', { stage });
      return {
        makespan: (j.makespan || []).sort(cmpMakespan),
        moves: (j.moves || []).sort(cmpMoves),
        total: (j.total || []).sort(cmpTotal),
      };
    },
    async all() { const j = await request('GET', { all: 1 }); return j.best || {}; },
    // レーティングと難易度 (サーバーで全投稿から再計算した値). players は rating 降順, stages[stage] = { d, d0, par, players }
    async ratings() { const j = await request('GET', { ratings: 1 }); return { updated: j.updated || 0, players: j.players || [], stages: j.stages || {} }; },
    async checkName(name) { return request('GET', { checkname: sanitizeName(name) }); },
    async register(name, password) { return request('POST', {}, { action: 'register', name: sanitizeName(name), password }, AUTH_TIMEOUT_MS); },
    async login(name, password) { return request('POST', {}, { action: 'login', name: sanitizeName(name), password }, AUTH_TIMEOUT_MS); },
    async submit(stage, name, token, paths) { return request('POST', {}, { action: 'submit', stage, name, token, paths, v: 2 }); },
    // ステージメーカー: 投稿 (kind: 'public' | 'writer') / 公開マップ一覧 / 管理者の受信箱
    async publish(name, token, kind, map) { return request('POST', {}, { action: 'publish', name, token, kind, map }); },
    async customList() { const j = await request('GET', { custom: 1 }); return j.maps || []; },
    async inbox(name, token) { const j = await request('GET', { inbox: 1, name, token }); return j.maps || []; },
  };
})(typeof self !== 'undefined' ? self : this);
