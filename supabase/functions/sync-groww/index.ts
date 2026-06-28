import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Groww API (limited public API)
// api_key_encrypted = authToken from Groww API
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const authToken = conn.api_key_encrypted as string;
  const trades: NormalizedTrade[] = [];

  // Groww trade history endpoint
  const res = await fetch("https://groww.in/v1/api/stocks-trading/v1/order/orders?page=0&size=50&order=desc", {
    headers: {
      "Authorization": `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "X-Groww-Client": "web",
    }
  });

  if (res.ok) {
    const json = await res.json();
    const orders = json?.content || json?.data || json?.orders || [];
    for (const o of orders) {
      if (o.orderStatus !== "EXECUTED") continue;
      const ts = new Date(o.executionTime || o.createdAt || new Date());
      const pnl = parseFloat(o.pnl || "0");
      trades.push({
        external_trade_id: `groww-${o.orderId}`,
        symbol: o.tradingSymbol || o.symbol || "UNKNOWN",
        direction: o.orderType === "BUY" ? "long" : "short",
        lot_size: parseFloat(o.executedQuantity || o.quantity || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(o.averagePrice || o.price || "0"),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: 0,
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
