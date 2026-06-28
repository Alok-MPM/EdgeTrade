import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

// Finvasia Shoonya NorenAPI
// api_key_encrypted = user ID (uid)
// api_secret_encrypted = SHA256 of password (user generates: sha256(password))
// api_passphrase_encrypted = susertoken from login response
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const uid = conn.api_key_encrypted as string;
  const susertoken = conn.api_passphrase_encrypted as string;
  const trades: NormalizedTrade[] = [];

  async function shoonyaFetch(endpoint: string, jData: Record<string, string>) {
    const jKey = susertoken;
    const params = new URLSearchParams({ jData: JSON.stringify(jData), jKey });
    const res = await fetch(`https://api.shoonya.com/NorenWClientTP/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.stat === "Ok" ? (j?.orders || j) : null;
  }

  const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const tradebook = await shoonyaFetch("TradeBook", { uid });
  if (Array.isArray(tradebook)) {
    for (const t of tradebook) {
      const dateStr = t.exch_tm || t.norentm || "";
      const ts = dateStr ? new Date(dateStr) : new Date();
      const pnl = parseFloat(t.rpnl || t.pnl || "0");
      trades.push({
        external_trade_id: `shoonya-${t.norenordno}-${t.flid || "0"}`,
        symbol: t.tsym || "UNKNOWN",
        direction: t.trantype === "B" ? "long" : "short",
        lot_size: parseFloat(t.flqty || t.qty),
        lot_unit: "qty",
        entry_price: parseFloat(t.flprc || t.prc),
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
