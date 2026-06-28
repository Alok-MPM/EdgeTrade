import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Pocketful API
// api_key_encrypted = access_token (from Pocketful API login)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const accessToken = conn.api_key_encrypted as string;
  const trades: NormalizedTrade[] = [];

  const res = await fetch("https://trade.pocketful.in/api/v1/trades", {
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" }
  });

  if (res.ok) {
    const json = await res.json();
    const tradebook = json?.data?.trades || json?.data || [];
    for (const t of tradebook) {
      const ts = new Date(t.trade_time || t.created_at || new Date());
      const pnl = parseFloat(t.pnl || "0");
      trades.push({
        external_trade_id: `pocketful-${t.trade_id || t.order_id}`,
        symbol: t.symbol || t.trading_symbol || "UNKNOWN",
        direction: t.transaction_type === "BUY" ? "long" : "short",
        lot_size: parseFloat(t.quantity || t.filled_quantity || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(t.trade_price || t.price || "0"),
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
