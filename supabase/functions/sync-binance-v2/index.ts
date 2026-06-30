import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function decryptData(ciphertext: string, secret: string) {
  try {
    const decoder = new TextDecoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret.padEnd(32, "0").slice(0, 32)),
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, keyMaterial, encrypted);
    return decoder.decode(decrypted);
  } catch (e) {
    console.log("DECRYPT DEBUG - secret length:", secret.length, "ciphertext length:", ciphertext.length, "error:", (e as Error).message);
    throw new Error("Decryption failed: " + (e as Error).message);
  }
}

async function hmacSha256Hex(key: string, message: string) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const FAPI_BASE = "https://fapi.binance.com";

async function signedFetch(path: string, params: Record<string, string>, apiKey: string, apiSecret: string) {
  const timestamp = Date.now().toString();
  const fullParams = { ...params, timestamp, recvWindow: "10000" };
  const query = new URLSearchParams(fullParams).toString();
  const signature = await hmacSha256Hex(apiSecret, query);
  const url = `${FAPI_BASE}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
  return res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { connection_id } = await req.json();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const secret = Deno.env.get("ENCRYPTION_SECRET")!;

    const { data: conn, error: connErr } = await supabase
      .from("user_broker_connections")
      .select("*")
      .eq("id", connection_id)
      .single();
    if (connErr || !conn) throw new Error("Connection not found");

    const apiKey = await decryptData(conn.api_key_encrypted, secret);
    const apiSecret = await decryptData(conn.api_secret_encrypted, secret);

    const DAYS_90 = 90 * 24 * 3600 * 1000;
    const startTime = Date.now() - DAYS_90;

    // Step 1: Discover active symbols using REALIZED_PNL income history (covers closed futures trades)
    const incomeResp = await signedFetch("/fapi/v1/income", {
      incomeType: "REALIZED_PNL",
      startTime: startTime.toString(),
      limit: "1000",
    }, apiKey, apiSecret);

    console.log("INCOME RESPONSE:", JSON.stringify(incomeResp).slice(0, 1000));

    let symbols: string[] = [];
    if (Array.isArray(incomeResp)) {
      symbols = [...new Set(incomeResp.map((i: any) => i.symbol).filter(Boolean))];
    } else {
      console.log("INCOME ERROR (not array):", JSON.stringify(incomeResp));
    }
    console.log("ACTIVE SYMBOLS FOUND:", JSON.stringify(symbols));

    // Step 2: Fetch trades for each active symbol
    let allTrades: any[] = [];
    for (const symbol of symbols) {
      const tradesResp = await signedFetch("/fapi/v1/userTrades", {
        symbol,
        startTime: startTime.toString(),
        limit: "1000",
      }, apiKey, apiSecret);

      console.log(`TRADES for ${symbol}:`, JSON.stringify(tradesResp).slice(0, 500));

      if (Array.isArray(tradesResp)) {
        allTrades.push(...tradesResp.map((t: any) => ({ ...t, symbol })));
      }
    }

    console.log("TOTAL TRADES FOUND:", allTrades.length);

    let inserted = 0;
    for (const t of allTrades) {
      const externalId = `binance-futures-${t.symbol}-${t.id}`;

      const { data: existing } = await supabase
        .from("trades")
        .select("id")
        .eq("external_trade_id", externalId)
        .maybeSingle();
      if (existing) continue;

      const { error: insertErr } = await supabase.from("trades").insert([{
        user_id: conn.user_id,
        connection_id: connection_id,
        external_trade_id: externalId,
        chart_name: t.symbol,
        direction: t.side === "BUY" ? "LONG" : "SHORT",
        lot_size: parseFloat(t.qty),
        lot_unit: "qty",
        entry_price: parseFloat(t.price),
        exit_price: parseFloat(t.price),
        entry_time: new Date(t.time).toISOString(),
        fees: parseFloat(t.commission) || 0,
      }]);
      if (!insertErr) inserted++;
      else console.log("INSERT ERROR:", JSON.stringify(insertErr));
    }

    await supabase.from("user_broker_connections").update({
      sync_status: "success",
      last_sync: new Date().toISOString(),
    }).eq("id", connection_id);

    return new Response(JSON.stringify({
      trades_synced: inserted,
      message: inserted > 0 ? `${inserted} trades synced!` : "Connected! No new trades found.",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.log("SYNC ERROR:", (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
