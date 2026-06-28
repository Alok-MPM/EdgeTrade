import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Dhan HQ API
// api_key_encrypted = access_token (long-lived, from DhanHQ dashboard)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const accessToken = conn.api_key_encrypted as string;
  const trades: NormalizedTrade[] = [];

  async function dhanFetch(path: string) {
    const res = await fetch(`https://api.dhan.co${path}`, {
      headers: { "access-token": accessToken, "Content-Type": "application/json" }
    });
    if (!res.ok) return null;
    return res.json();
  }

  // Trade book (today's trades)
  const tradebook = await dhanFetch("/tradebook");
  if (Array.isArray(tradebook)) {
    for (const t of tradebook) {
      const ts = new Date(t.createTime || new Date());
      const pnl = parseFloat(t.drvExpiryDate ? "0" : (t.tradedQuantity > 0 ? "1" : "-1")); // best effort
      trades.push({
        external_trade_id: `dhan-${t.orderId}-${t.exchangeOrderId || "0"}`,
        symbol: t.tradingSymbol || t.customSymbol || "UNKNOWN",
        direction: t.transactionType === "BUY" ? "long" : "short",
        lot_size: parseFloat(t.tradedQuantity || t.quantity),
        lot_unit: "qty",
        entry_price: parseFloat(t.tradedPrice || t.price),
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

  // Historical trades via ledger
  const today = new Date().toISOString().split("T")[0];
  const fromDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split("T")[0];
  const ledger = await dhanFetch(`/ledger?from=${fromDate}&to=${today}`);
  if (Array.isArray(ledger)) {
    for (const l of ledger) {
      if (!l.narration?.includes("Trade")) continue;
      const ts = new Date(l.voucherdate || today);
      const pnl = parseFloat(l.credit || "0") - parseFloat(l.debit || "0");
      const key = `dhan-ledger-${l.voucherNo || l.narration}-${l.voucherdate}`;
      if (trades.find(t => t.external_trade_id === key)) continue;
      trades.push({
        external_trade_id: key,
        symbol: (l.narration || "").split(" ")[2] || "UNKNOWN",
        direction: pnl > 0 ? "long" : "short",
        lot_size: null,
        lot_unit: "qty",
        entry_price: null,
        exit_price: null,
        entry_time: null,
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
