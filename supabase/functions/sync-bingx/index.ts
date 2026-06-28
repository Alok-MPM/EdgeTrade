import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

async function bingxFetch(path: string, params: Record<string, string | number>, apiKey: string, apiSecret: string) {
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const qstr = sorted.map(([k, v]) => `${k}=${v}`).join("&");
  const sig = await hmacSha256Hex(apiSecret, qstr);
  const res = await fetch(`https://open-api.bingx.com${path}?${qstr}&signature=${sig}`, {
    headers: { "X-BX-APIKEY": apiKey }
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.data?.orders || j?.data || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const startTs = Date.now() - 30 * 24 * 3600 * 1000;
  const ts = Date.now();

  // Perpetual futures history
  const futOrders = await bingxFetch("/openApi/swap/v2/trade/allOrders", {
    timestamp: ts, startTime: startTs, limit: 500
  }, apiKey, apiSecret);

  if (Array.isArray(futOrders)) {
    for (const o of futOrders) {
      if (o.status !== "FILLED") continue;
      const t = parseInt(o.updateTime || o.time);
      const pnl = parseFloat(o.profit || "0");
      trades.push({
        external_trade_id: `bingx-${o.orderId}`,
        symbol: (o.symbol || "").replace("-USDT", "/USDT"),
        direction: o.side === "BUY" ? "long" : "short",
        lot_size: parseFloat(o.executedQty || o.origQty),
        lot_unit: "qty",
        entry_price: parseFloat(o.avgPrice || o.price),
        exit_price: null,
        entry_time: msToTime(t),
        fees: parseFloat(o.commission || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: msToDate(t),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
