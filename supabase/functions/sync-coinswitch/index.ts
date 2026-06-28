import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const trades: NormalizedTrade[] = [];

  const res = await fetch("https://coinswitch.co/pro/api/v2/orders/trades?page=1&per_page=200", {
    headers: { "x-auth-apikey": apiKey, "Content-Type": "application/json" }
  });

  if (res.ok) {
    const json = await res.json();
    const orders = json?.data?.trades || json?.data || [];
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const t of orders) {
      const ts = new Date(t.createdAt || t.created_at).getTime();
      if (ts < cutoff) continue;
      trades.push({
        external_trade_id: `csw-${t.id || t.orderId}`,
        symbol: (t.symbol || t.trading_pair || "").replace("_", "/").toUpperCase(),
        direction: t.side === "BUY" ? "long" : "short",
        lot_size: parseFloat(t.quantity || t.qty || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(t.price || t.executedPrice || "0"),
        exit_price: null,
        entry_time: new Date(ts).toTimeString().slice(0, 5),
        fees: parseFloat(t.fees || t.fee || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
