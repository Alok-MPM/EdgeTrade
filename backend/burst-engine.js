require('dotenv').config();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const round2 = (n) => Number(Number(n).toFixed(2));
let CTX = null; let PRIORS = null; let mining = false;
const STATE = new Map();
const EVENT_TS = []; // known event epoch-ms yahan paste karo (FOMC etc.) jab milte hain
function inEventWindow(now) {
  for (const ts of EVENT_TS) if (Math.abs(now - ts) < 30 * 60000) return true;
  const d = new Date(now); const day = d.getUTCDate(), h = d.getUTCHours();
  if (day >= 10 && day <= 13 && h >= 12 && h <= 15) return true; // CPI-like monthly window (UTC)
  return false;
}
function getState(sym) { let s = STATE.get(sym); if (!s) { s = { phase: 'SCAN', burst: null, pos: null, lastBurstTime: 0, cooldownUntil: 0, spikeUntil: 0, armedUntil: 0, history: [] }; STATE.set(sym, s); } return s; }
function med(a) { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; }
function lp0(m) { return (m.pulse && m.pulse.lastPrice) || 0; }
function build5m(candles) {
  const map = new Map();
  for (const c of candles) {
    const t = Math.floor(c.time / 300000) * 300000;
    let b = map.get(t);
    if (!b) map.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, vol: c.volume });
    else { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.vol += c.volume; }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}
function dbPost(table, rows) { if (!SUPABASE_URL || !SUPABASE_KEY) return; fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal,resolution=merge-duplicates' }, body: JSON.stringify(rows) }).catch(e => console.error('burst db:', e.message)); }
function dbPatch(table, q, obj) { if (!SUPABASE_URL || !SUPABASE_KEY) return; fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' }, body: JSON.stringify(obj) }).catch(e => console.error('burst db:', e.message)); }
function emit(market, type, data) { if (CTX) CTX.broadcastToMarket(market, { type, data }); }
function engineTick(market) {
  const now = Date.now(); const s = getState(market.symbol);
  const candles = market.candles || [];
  if (candles.length < 150) return;
  const f5 = build5m(candles.slice(-600));
  if (f5.length < 100) return;
  const closed5 = f5.slice(0, -1); const cur5 = f5[f5.length - 1];
  const medR = med(closed5.slice(-96).map(b => b.high - b.low));
  const medV = med(closed5.slice(-96).map(b => b.vol));
  const med1 = med(candles.slice(-96).map(c => c.volume));
  if (candles.slice(-3).some(c => c.volume >= 6 * med1)) s.spikeUntil = now + 30 * 60000;
  const evw = inEventWindow(now) || now < s.spikeUntil;
  const lp = lp0(market) || cur5.close;
  if (s.phase === 'IN' && s.pos) manage(market, s, lp, now);
  if (s.phase === 'SCAN' && now > s.cooldownUntil) {
    const l15 = candles.slice(-15);
    const net15 = l15.length ? l15[l15.length - 1].close - l15[0].open : 0;
    const sumR = l15.reduce((a, c) => a + (c.high - c.low), 0);
    const eff15 = sumR > 0 ? Math.abs(net15) / sumR : 0;
    const isBurst = (cur5.high - cur5.low >= 3 * medR) || (cur5.vol >= 4 * medV) || (Math.abs(net15) >= 300 && eff15 >= 0.5);
    if (isBurst && cur5.time > s.lastBurstTime) startBurst(market, s, cur5, medR, medV, evw, now);
  }
  if (s.phase === 'ARMED' && s.burst) tryEntry(market, s, candles, lp, evw, now);
  emit(market, 'burst_state', { phase: s.phase, burst: s.burst, pos: s.pos, evw, priors: PRIORS, ts: now });
}
function startBurst(market, s, b, medR, medV, evw, now) {
  const dir = b.close >= b.open ? 'bull' : 'bear';
  const range = b.high - b.low;
  s.lastBurstTime = b.time;
  s.burst = { dir, t0: b.time, high: b.high, low: b.low, range: round2(range), volMult: round2(b.vol / Math.max(1, medV)), medR };
  const f = market.flow;
  const herd = f && f.herd && f.herd.until > now ? f.herd : null;
  const bk = (market.pulse && market.pulse.buckets) || []; const b3 = bk.slice(-3);
  const oiD = b3.length ? (b3[b3.length - 1].oi || 0) - (b3[0].oi || 0) : 0;
  const trap = (herd && herd.side === dir && herd.share >= 0.72) || (oiD !== 0 && Math.sign(oiD) === (dir === 'bull' ? -1 : 1) && Math.abs(oiD) > 50);
  if (trap) {
    s.phase = 'SCAN'; s.cooldownUntil = now + 10 * 60000;
    dbPost('burst_signals', [{ symbol: market.symbol.toUpperCase(), ts_entry: now, side: dir, join: 'NONE', entry_price: round2(lp0(market)), resolved: true, ts_exit: now, outcome: 'TRAP-SKIP', burst_range: round2(range), vol_mult: s.burst.volMult, evw }]);
    emit(market, 'burst_event', { kind: 'TRAP-SKIP', side: dir, ts: now, price: round2(lp0(market)) });
    return;
  }
  s.phase = 'ARMED'; s.armedUntil = now + 15 * 60000;
  emit(market, 'burst_event', { kind: 'BURST', side: dir, ts: now, price: round2(lp0(market)), range: round2(range), volMult: s.burst.volMult });
}
function tryEntry(market, s, candles, lp, evw, now) {
  const B = s.burst;
  if (now > s.armedUntil) { s.phase = 'SCAN'; s.burst = null; return; }
  if (B.dir === 'bull' && lp < B.low) { s.phase = 'SCAN'; s.burst = null; return; }
  if (B.dir === 'bear' && lp > B.high) { s.phase = 'SCAN'; s.burst = null; return; }
  const prev = candles[candles.length - 2], last = candles[candles.length - 1];
  if (!prev || !last) return;
  let entry = null, join = null;
  if (B.dir === 'bull') {
    const zLo = B.high - B.range * 0.62, zHi = B.high - B.range * 0.38;
    if (prev.low <= zHi && prev.low >= zLo && prev.close > prev.open) { entry = prev.close; join = 'PULLBACK'; }
    else if (last.close > B.high) { entry = last.close; join = 'BREAKOUT'; }
  } else {
    const zLo = B.low + B.range * 0.38, zHi = B.low + B.range * 0.62;
    if (prev.high >= zLo && prev.high <= zHi && prev.close < prev.open) { entry = prev.close; join = 'PULLBACK'; }
    else if (last.close < B.low) { entry = last.close; join = 'BREAKOUT'; }
  }
  if (!entry) return;
  const buf = B.range * (evw ? 0.15 : 0.1);
  const sl0 = round2(B.dir === 'bull' ? B.low - buf : B.high + buf);
  s.pos = { side: B.dir, join, entry: round2(entry), sl: sl0, sl0, buf: round2(B.range * 0.1), tEntry: now, mfe: 0, mae: 0 };
  s.phase = 'IN';
  dbPost('burst_signals', [{ symbol: market.symbol.toUpperCase(), ts_entry: now, side: B.dir, join, entry_price: round2(entry), sl_initial: sl0, burst_range: B.range, vol_mult: B.volMult, evw, resolved: false }]);
  emit(market, 'burst_event', { kind: 'ENTRY', side: B.dir, join, ts: now, price: round2(entry), sl: sl0 });
}
function manage(market, s, lp, now) {
  const p = s.pos; const sign = p.side === 'bull' ? 1 : -1;
  const dev = (lp - p.entry) * sign;
  p.mfe = Math.max(p.mfe, dev); p.mae = Math.max(p.mae, -dev);
  const f5 = build5m((market.candles || []).slice(-600));
  const w = f5.slice(0, -1).slice(-3);
  if (w.length === 3) {
    const cand = p.side === 'bull' ? Math.min(...w.map(b => b.low)) - p.buf : Math.max(...w.map(b => b.high)) + p.buf;
    if (p.side === 'bull' && cand > p.sl && cand < lp) p.sl = round2(cand);
    if (p.side === 'bear' && cand < p.sl && cand > lp) p.sl = round2(cand);
  }
  let exit = null, outcome = null;
  if (p.side === 'bull' && lp <= p.sl) { exit = p.sl; outcome = p.sl >= p.entry ? 'TRAIL-PROFIT' : 'SL'; }
  if (p.side === 'bear' && lp >= p.sl) { exit = p.sl; outcome = p.sl <= p.entry ? 'TRAIL-PROFIT' : 'SL'; }
  if (!exit && now - p.tEntry > 6 * 3600 * 1000) { exit = lp; outcome = 'TIME'; }
  if (!exit) return;
  const move = round2((exit - p.entry) * sign);
  dbPatch('burst_signals', `symbol=eq.${market.symbol.toUpperCase()}&ts_entry=eq.${p.tEntry}`, { resolved: true, ts_exit: now, exit_price: round2(exit), outcome, move_usd: move, mfe_usd: round2(p.mfe), mae_usd: round2(p.mae), duration_min: Math.round((now - p.tEntry) / 60000), sl_final: p.sl });
  s.history.push({ side: p.side, join: p.join, entry: p.entry, exit: round2(exit), move, outcome, ts: p.tEntry });
  if (s.history.length > 50) s.history.shift();
  emit(market, 'burst_event', { kind: 'EXIT', side: p.side, ts: now, price: round2(exit), outcome, move });
  s.pos = null; s.burst = null; s.phase = 'SCAN'; s.cooldownUntil = now + 10 * 60000;
}
function simulate(cs) {
  const mk = () => ({ n: 0, win: 0, wt: 0, sumMove: 0, sumDur: 0, mfeSum: 0 });
  const out = { PULLBACK: mk(), BREAKOUT: mk(), bursts: 0 };
  let cooldown = 0;
  for (let i = 100; i < cs.length - 50; i++) {
    if (cs[i].time < cooldown) continue;
    const win = cs.slice(i - 96, i);
    const medR = med(win.map(b => b.high - b.low)), medV = med(win.map(b => b.vol));
    const b = cs[i]; const range = b.high - b.low;
    if (!(range >= 3 * medR || b.vol >= 4 * medV)) continue;
    out.bursts++; cooldown = b.time + 30 * 60000;
    const dir = b.close >= b.open ? 'bull' : 'bear';
    let entry = null, join = null;
    for (let j = i + 1; j <= i + 3 && j < cs.length; j++) {
      const c = cs[j];
      if (dir === 'bull') {
        const zLo = b.high - range * 0.62, zHi = b.high - range * 0.38;
        if (c.low <= zHi && c.low >= zLo && c.close > c.open) { entry = c.close; join = 'PULLBACK'; break; }
        if (c.close > b.high) { entry = c.close; join = 'BREAKOUT'; break; }
        if (c.low < b.low) break;
      } else {
        const zLo = b.low + range * 0.38, zHi = b.low + range * 0.62;
        if (c.high >= zLo && c.high <= zHi && c.close < c.open) { entry = c.close; join = 'PULLBACK'; break; }
        if (c.close < b.low) { entry = c.close; join = 'BREAKOUT'; break; }
        if (c.high > b.high) break;
      }
    }
    if (!entry) continue;
    const sign = dir === 'bull' ? 1 : -1;
    let sl = dir === 'bull' ? b.low - range * 0.1 : b.high + range * 0.1;
    let mfe = 0, exit = null, outcome = null, dur = 0;
    for (let j = i + 1; j < Math.min(cs.length, i + 49); j++) {
      const c = cs[j]; dur = (c.time - b.time) / 60000;
      if (dir === 'bull' && c.low <= sl) { exit = sl; outcome = sl >= entry ? 'TRAIL-PROFIT' : 'SL'; break; }
      if (dir === 'bear' && c.high >= sl) { exit = sl; outcome = sl <= entry ? 'TRAIL-PROFIT' : 'SL'; break; }
      mfe = Math.max(mfe, (c.close - entry) * sign);
      const w3 = cs.slice(Math.max(0, j - 2), j + 1);
      if (w3.length === 3) {
        const cand = dir === 'bull' ? Math.min(...w3.map(x => x.low)) - range * 0.1 : Math.max(...w3.map(x => x.high)) + range * 0.1;
        if (dir === 'bull' && cand > sl && cand < c.close) sl = cand;
        if (dir === 'bear' && cand < sl && cand > c.close) sl = cand;
      }
      if (dur > 240) { exit = c.close; outcome = 'TIME'; break; }
    }
    if (!exit) { exit = cs[Math.min(cs.length - 1, i + 48)].close; outcome = 'TIME'; }
    const move = (exit - entry) * sign;
    const S = out[join];
    S.n++; if (move > 0) S.win++; if (move >= 350) S.wt++; S.sumMove += move; S.sumDur += dur; S.mfeSum += mfe;
  }
  const fin = (S) => ({ n: S.n, winPct: S.n ? Math.round(S.win / S.n * 100) : 0, tradeablePct: S.n ? Math.round(S.wt / S.n * 100) : 0, avgMove: S.n ? round2(S.sumMove / S.n) : 0, avgDurMin: S.n ? Math.round(S.sumDur / S.n) : 0, avgMfe: S.n ? round2(S.mfeSum / S.n) : 0 });
  return { bursts: out.bursts, pullback: fin(out.PULLBACK), breakout: fin(out.BREAKOUT) };
}
function mount(app, markets, broadcastToMarket) {
  CTX = { markets, broadcastToMarket };
  setInterval(() => { for (const m of markets.values()) if (m.awake) engineTick(m); }, 10000);
  app.get('/api/burst-signals', async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.json([]);
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/burst_signals?symbol=eq.${symbol}&order=ts_entry.desc&limit=${Math.min(200, Number(req.query.limit || 60))}`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      res.json(r.ok ? await r.json() : []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/burst-priors', (req, res) => res.json(PRIORS || { stats: null }));
  app.get('/api/burst-mine', async (req, res) => {
    if (mining) return res.json({ busy: true });
    mining = true;
    try {
      const days = Math.min(180, Number(req.query.days || 90));
      const need = days * 288; let all = []; let end = Date.now();
      while (all.length < need) {
        const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1000&endTime=${end}`);
        if (!r.ok) break;
        const page = await r.json(); if (!page.length) break;
        all = page.concat(all); end = page[0][0] - 1;
        if (page.length < 1000) break;
      }
      const cs = all.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] }));
      const stats = simulate(cs);
      PRIORS = { updated: Date.now(), stats };
      dbPost('burst_priors', [{ symbol: 'BTCUSDT', updated: Date.now(), stats }]);
      res.json({ candles: cs.length, stats });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { mining = false; }
  });
  if (SUPABASE_URL && SUPABASE_KEY) {
    fetch(`${SUPABASE_URL}/rest/v1/burst_priors?symbol=eq.BTCUSDT&limit=1`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } })
      .then(r => r.json()).then(rows => { if (rows && rows[0]) PRIORS = { updated: rows[0].updated, stats: rows[0].stats }; }).catch(() => {});
  }
}
module.exports = { mount };
