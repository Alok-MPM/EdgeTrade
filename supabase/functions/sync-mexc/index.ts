import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

async function mexcFetch(path: string, params: Record<string, string | number>, apiKey: string, apiSecret: string) {
  const ts = Date.now();
  const allParams = { ...params, timestamp: ts };
  const qstr = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join("&");
  const sig = await hmacSha256Hex(apiSecret, qstr);
  const res = await fetch(`https://api.mexc.com${path}?${qstr}&signature=${sig}`, {
    headers: { "X-MEXC-APIKEY": apiKey }
  });
  if (!res.ok) return null;
  const j = await res.json();
  return Array.isArray(j) ? j : (j?.data || null);
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const startTime = Date.now() - 30 * 24 * 3600 * 1000;

  const symbols = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","DOGEUSDT","ADAUSDT"];
  for (const symbol of symbols) {
    const orders = await mexcFetch("/api/v3/myTrades", { symbol, startTime, limit: 500 }, apiKey, apiSecret);
    if (!Array.isArray(orders)) continue;
    for (const o of orders) {
      const ts = parseInt(o.time);
      trades.push({
        external_trade_id: `mexc-${o.id}`,
        symbol: symbol.replace("USDT", "/USDT"),
        direction: o.isBuyer ? "long" : "short",
        lot_size: parseFloat(o.qty),
        lot_unit: "qty",
        entry_price: parseFloat(o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.commission),
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
