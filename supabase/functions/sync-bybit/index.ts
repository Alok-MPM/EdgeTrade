import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

async function bybitFetch(base: string, path: string, params: Record<string, string | number>, apiKey: string, apiSecret: string) {
  const ts = Date.now().toString();
  const recv = "5000";
  const qstr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  const preSign = ts + apiKey + recv + qstr;
  const sig = await hmacSha256Hex(apiSecret, preSign);
  const res = await fetch(`${base}${path}?${qstr}`, {
    headers: {
      "X-BAPI-API-KEY": apiKey, "X-BAPI-SIGN": sig,
      "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv,
    }
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.result?.list || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const isDemo = conn.account_type === "demo";
  const base = isDemo ? "https://api-testnet.bybit.com" : "https://api.bybit.com";

  const trades: NormalizedTrade[] = [];
  const end = Date.now();
  const start = end - 30 * 24 * 3600 * 1000;

  // Closed PnL (linear/inverse futures)
  const closedPnl = await bybitFetch(base, "/v5/position/closed-pnl", {
    category: "linear", startTime: start, endTime: end, limit: 200
  }, apiKey, apiSecret);

  if (closedPnl) {
    for (const t of closedPnl) {
      const pnl = parseFloat(t.closedPnl);
      trades.push({
        external_trade_id: `bybit-${t.orderId}`,
        symbol: (t.symbol || "").replace("USDT", "/USDT"),
        direction: t.side === "Buy" ? "long" : "short",
        lot_size: parseFloat(t.qty),
        lot_unit: "qty",
        entry_price: parseFloat(t.avgEntryPrice),
        exit_price: parseFloat(t.avgExitPrice),
        entry_time: msToTime(parseInt(t.updatedTime)),
        fees: parseFloat(t.cumEntryFee || "0") + parseFloat(t.cumExitFee || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl),
        date: msToDate(parseInt(t.updatedTime)),
      });
    }
  }

  // Spot order history
  const spotOrders = await bybitFetch(base, "/v5/order/history", {
    category: "spot", startTime: start, endTime: end, limit: 200
  }, apiKey, apiSecret);
  if (spotOrders) {
    for (const t of spotOrders) {
      if (t.orderStatus !== "Filled") continue;
      const ts = parseInt(t.updatedTime);
      trades.push({
        external_trade_id: `bybit-spot-${t.orderId}`,
        symbol: (t.symbol || "").replace("USDT", "/USDT"),
        direction: t.side === "Buy" ? "long" : "short",
        lot_size: parseFloat(t.qty),
        lot_unit: "qty",
        entry_price: parseFloat(t.avgPrice),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(t.cumExecFee || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
