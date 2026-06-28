import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Kotak Neo API
// api_key_encrypted = consumer_key
// api_secret_encrypted = consumer_secret
// api_passphrase_encrypted = access_token (from OAuth login)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const consumerKey = conn.api_key_encrypted as string;
  const accessToken = conn.api_passphrase_encrypted as string;
  const trades: NormalizedTrade[] = [];

  async function kotakFetch(path: string) {
    const res = await fetch(`https://gw-napi.kotaksecurities.com/trade/api/v1${path}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Sid": "napi",
        "Auth": `Bearer ${accessToken}`,
        "neo-fin-key": consumerKey,
        "Content-Type": "application/json",
      }
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data || null;
  }

  const tradebook = await kotakFetch("/orders/trade-book");
  if (Array.isArray(tradebook)) {
    for (const t of tradebook) {
      const ts = new Date(t.flDt || t.ordTm || new Date());
      const pnl = parseFloat(t.realizedPnL || t.pnl || "0");
      trades.push({
        external_trade_id: `kotak-${t.nOrdNo}-${t.flId || "0"}`,
        symbol: t.trdSym || t.sym || "UNKNOWN",
        direction: t.trnsTp === "B" ? "long" : "short",
        lot_size: parseFloat(t.flQty || t.qty || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(t.flPrc || t.prc || "0"),
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
