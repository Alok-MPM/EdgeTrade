import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

async function bitfinexFetch(path: string, body: Record<string, unknown>, apiKey: string, apiSecret: string) {
  const nonce = Date.now().toString();
  const bodyStr = JSON.stringify(body);
  const preSign = `/api${path}${nonce}${bodyStr}`;
  const sig = await hmacSha256Hex(apiSecret, preSign);
  const res = await fetch(`https://api.bitfinex.com${path}`, {
    method: "POST",
    headers: { "bfx-apikey": apiKey, "bfx-signature": sig, "bfx-nonce": nonce, "Content-Type": "application/json" },
    body: bodyStr,
  });
  if (!res.ok) return null;
  return res.json();
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const start = Date.now() - 30 * 24 * 3600 * 1000;

  const tradeData = await bitfinexFetch("/v2/auth/r/trades/hist", { start, end: Date.now(), limit: 2500, sort: -1 }, apiKey, apiSecret);
  if (Array.isArray(tradeData)) {
    for (const t of tradeData) {
      // BFX trade array: [ID, PAIR, MTS_CREATE, ORDER_ID, EXEC_AMOUNT, EXEC_PRICE, ...]
      const [id, pair, ts, , amount, price, , , fee] = t;
      const pnl = null; // Bitfinex trade history doesn't include per-trade PnL directly
      trades.push({
        external_trade_id: `bfx-${id}`,
        symbol: (pair || "").replace("tBTC", "BTC/").replace("tETH", "ETH/")
          .replace(/^t(.{3})(.{3,4})$/, "$1/$2"),
        direction: amount > 0 ? "long" : "short",
        lot_size: Math.abs(parseFloat(amount)),
        lot_unit: "qty",
        entry_price: parseFloat(price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: Math.abs(parseFloat(fee || "0")),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl),
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
