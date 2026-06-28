import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Zerodha Kite Connect API
// api_key_encrypted = Kite API Key
// api_secret_encrypted = access_token (obtained from OAuth flow, refreshes daily at 6AM)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const accessToken = conn.api_secret_encrypted as string;
  const authHeader = `token ${apiKey}:${accessToken}`;
  const trades: NormalizedTrade[] = [];

  async function kiteFetch(path: string) {
    const res = await fetch(`https://api.kite.trade${path}`, {
      headers: { "Authorization": authHeader, "X-Kite-Version": "3" }
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data || null;
  }

  // Get all tradebook entries
  const tradebook = await kiteFetch("/trades");
  if (Array.isArray(tradebook)) {
    for (const t of tradebook) {
      const ts = new Date(t.fill_timestamp || t.order_timestamp);
      const pnl = parseFloat(t.pnl || "0");
      trades.push({
        external_trade_id: `zerodha-${t.trade_id}`,
        symbol: t.tradingsymbol || "UNKNOWN",
        direction: t.transaction_type === "BUY" ? "long" : "short",
        lot_size: parseFloat(t.filled_quantity || t.quantity),
        lot_unit: t.product === "MIS" || t.product === "NRML" ? "qty" : "lot",
        entry_price: parseFloat(t.average_price || t.price),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: 0, // Zerodha tradebook doesn't include fees directly
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  // Get P&L from positions (for intraday)
  const positions = await kiteFetch("/portfolio/positions");
  if (positions?.day && Array.isArray(positions.day)) {
    for (const p of positions.day) {
      if (p.quantity !== 0) continue; // Only closed positions
      const pnl = parseFloat(p.pnl || "0");
      const today = new Date().toISOString().split("T")[0];
      // Avoid duplicate with tradebook
      const exists = trades.find(t => t.symbol === p.tradingsymbol);
      if (exists) continue;
      trades.push({
        external_trade_id: `zerodha-pos-${p.tradingsymbol}-${today}`,
        symbol: p.tradingsymbol || "UNKNOWN",
        direction: (p.net_quantity || 0) >= 0 ? "long" : "short",
        lot_size: Math.abs(p.net_quantity || 0),
        lot_unit: "qty",
        entry_price: parseFloat(p.average_price || "0"),
        exit_price: null,
        entry_time: null,
        fees: 0,
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl),
        date: today,
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));
