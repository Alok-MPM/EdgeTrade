import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Deriv uses their own REST API with OAuth token
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiToken = conn.api_key_encrypted as string; // Deriv API token (read scope)
  const trades: NormalizedTrade[] = [];

  // Deriv uses WebSocket API — we use their REST-compatible endpoint
  const res = await fetch(`https://api.deriv.com/v3/profit_table?limit=200&description=1&sort=DESC`, {
    headers: { "Authorization": `Bearer ${apiToken}` }
  });

  if (res.ok) {
    const json = await res.json();
    const contracts = json?.profit_table?.transactions || [];
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const c of contracts) {
      const ts = new Date((c.sell_time || c.purchase_time) * 1000);
      if (ts.getTime() < cutoff) continue;
      const pnl = parseFloat(c.sell_price || "0") - parseFloat(c.buy_price || "0");
      trades.push({
        external_trade_id: `deriv-${c.contract_id}`,
        symbol: c.shortcode?.split("_")[0] || "UNKNOWN",
        direction: c.contract_type?.includes("CALL") || c.contract_type?.includes("HIGHER") ? "long" : "short",
        lot_size: null,
        lot_unit: "qty",
        entry_price: parseFloat(c.buy_price || "0"),
        exit_price: parseFloat(c.sell_price || "0"),
        entry_time: ts.toTimeString().slice(0, 5),
        fees: 0,
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
