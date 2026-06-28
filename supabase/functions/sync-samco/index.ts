import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, NormalizedTrade } from "../_shared/utils.ts";

// Samco StockNote API
// api_key_encrypted = userId
// api_secret_encrypted = session_token (from StockNote API login)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const sessionToken = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];

  const res = await fetch("https://api.stocknote.com/trade/tradebook", {
    headers: { "sessionToken": sessionToken, "Content-Type": "application/json" }
  });

  if (res.ok) {
    const json = await res.json();
    const tradebook = json?.tradeBookDetail || json?.data || [];
    for (const t of tradebook) {
      const ts = new Date(t.exchangeTransactionTime || t.fillTime || new Date());
      trades.push({
        external_trade_id: `samco-${t.orderNumber}-${t.fillId || "0"}`,
        symbol: t.tradingSymbol || "UNKNOWN",
        direction: t.transactionType === "BUY" ? "long" : "short",
        lot_size: parseFloat(t.filledQuantity || t.quantity || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(t.fillPrice || t.price || "0"),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: 0,
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
