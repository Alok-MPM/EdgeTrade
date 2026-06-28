import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Fyers API v3
// api_key_encrypted = access_token (from Fyers OAuth, refresh daily)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const accessToken = conn.api_key_encrypted as string;
  const trades: NormalizedTrade[] = [];

  async function fyersFetch(path: string) {
    const res = await fetch(`https://api-t1.fyers.in/api/v3${path}`, {
      headers: { "Authorization": accessToken }
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data || j?.tradeBook || null;
  }

  const tradebook = await fyersFetch("/tradebook");
  if (Array.isArray(tradebook)) {
    for (const t of tradebook) {
      const ts = new Date(t.orderDateTime || t.exchOrdTim || new Date());
      const pnl = parseFloat(t.pl || "0");
      trades.push({
        external_trade_id: `fyers-${t.id || t.orderNumStatus}`,
        symbol: (t.symbol || "NSE:UNKNOWN").split(":")[1] || t.symbol,
        direction: t.side === 1 ? "long" : "short",
        lot_size: parseFloat(t.filledQty || t.qty),
        lot_unit: "qty",
        entry_price: parseFloat(t.tradePrice || t.limitPrice),
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
