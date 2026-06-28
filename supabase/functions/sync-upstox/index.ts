import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Upstox API v2
// api_key_encrypted = access_token (OAuth token from Upstox login, refreshes daily)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const accessToken = conn.api_key_encrypted as string;
  const trades: NormalizedTrade[] = [];

  async function upstoxFetch(path: string) {
    const res = await fetch(`https://api.upstox.com/v2${path}`, {
      headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" }
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data || null;
  }

  // Trade history
  const tradebook = await upstoxFetch("/order/trades/get-trades-for-day");
  if (Array.isArray(tradebook)) {
    for (const t of tradebook) {
      const ts = new Date(t.exchange_timestamp || t.order_timestamp);
      trades.push({
        external_trade_id: `upstox-${t.trade_id}`,
        symbol: t.tradingsymbol || t.instrument_token || "UNKNOWN",
        direction: t.transaction_type === "BUY" ? "long" : "short",
        lot_size: parseFloat(t.quantity),
        lot_unit: "qty",
        entry_price: parseFloat(t.average_price || t.price),
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

  // Also get P&L report for closed positions
  const today = new Date().toISOString().split("T")[0];
  const pnlData = await upstoxFetch(`/trade/profit-loss/data?segment=EQ&financial_year=2425&from_date=${today}&to_date=${today}&page_number=1&page_size=200`);
  if (pnlData && Array.isArray(pnlData.trades_count ? pnlData.data : pnlData)) {
    const pnlList = pnlData.data || pnlData;
    for (const p of pnlList) {
      const pnl = parseFloat(p.pnl || "0");
      const key = `upstox-pnl-${p.isin || p.scrip_name}-${today}`;
      if (trades.find(t => t.external_trade_id === key)) continue;
      trades.push({
        external_trade_id: key,
        symbol: p.scrip_name || p.isin || "UNKNOWN",
        direction: "long",
        lot_size: parseFloat(p.quantity || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(p.buy_average || "0"),
        exit_price: parseFloat(p.sell_average || "0"),
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
