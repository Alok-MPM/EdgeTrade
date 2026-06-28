// v3
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function validateBinance(apiKey: string, apiSecret: string): Promise<boolean> {
  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(queryString));
    const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    const res = await fetch(
      `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
      { headers: { "X-MBX-APIKEY": apiKey } }
    );
    return res.ok;
  } catch { return false; }
}

async function validateBybit(apiKey: string, apiSecret: string): Promise<boolean> {
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const paramStr = timestamp + apiKey + recvWindow;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(paramStr));
    const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    const res = await fetch("https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED", {
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
        "X-BAPI-SIGN": signature,
      },
    });
    const data = await res.json();
    return data.retCode === 0;
  } catch { return false; }
}

async function validateOKX(apiKey: string, apiSecret: string, passphrase: string): Promise<boolean> {
  try {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + "GET" + "/api/v5/account/balance";
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prehash));
    const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
    const res = await fetch("https://www.okx.com/api/v5/account/balance", {
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase,
      },
    });
    const data = await res.json();
    return data.code === "0";
  } catch { return false; }
}

async function validateDelta(apiKey: string, apiSecret: string): Promise<boolean> {
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const prehash = "GET" + timestamp + "/v2/profile";
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(apiSecret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prehash));
    const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    const res = await fetch("https://api.delta.exchange/v2/profile", {
      headers: { "api-key": apiKey, "timestamp": timestamp, "signature": signature },
    });
    return res.ok;
  } catch { return false; }
}

async function validateZerodha(apiKey: string, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.kite.trade/user/profile", {
      headers: {
        "X-Kite-Version": "3",
        "Authorization": `token ${apiKey}:${accessToken}`,
      },
    });
    const data = await res.json();
    return data.status === "success";
  } catch { return false; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { broker_id, account_label, api_key, api_secret, api_passphrase, access_token } = body;

    if (!broker_id || !api_key) {
      return new Response(
        JSON.stringify({ success: false, error: "broker_id aur api_key required hai" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let isValid = false;
    const brokerLower = broker_id.toLowerCase();

    if (brokerLower === "binance") {
      if (!api_secret) return errorResponse("Binance ke liye api_secret chahiye");
      isValid = await validateBinance(api_key, api_secret);
    } else if (brokerLower === "bybit") {
      if (!api_secret) return errorResponse("Bybit ke liye api_secret chahiye");
      isValid = await validateBybit(api_key, api_secret);
    } else if (brokerLower === "okx") {
      if (!api_secret || !api_passphrase) return errorResponse("OKX ke liye api_secret aur passphrase chahiye");
      isValid = await validateOKX(api_key, api_secret, api_passphrase);
    } else if (brokerLower === "delta") {
      if (!api_secret) return errorResponse("Delta ke liye api_secret chahiye");
      isValid = await validateDelta(api_key, api_secret);
    } else if (brokerLower === "zerodha") {
      if (!access_token) return errorResponse("Zerodha ke liye access_token chahiye");
      isValid = await validateZerodha(api_key, access_token);
    } else {
      return errorResponse("Invalid broker_id");
    }

    if (!isValid) {
      return new Response(
        JSON.stringify({ success: false, error: "API key invalid hai ya broker se connect nahi ho paya" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const extraData = access_token ? { access_token: access_token } : null;

    const { error: dbError } = await supabase
      .from("user_broker_connections")
      .upsert({
        user_id: user.id,
        broker_id: brokerLower,
        account_label: account_label ?? brokerLower,
        api_key_encrypted: api_key,
        api_secret_encrypted: api_secret ?? null,
        api_passphrase_encrypted: api_passphrase ?? null,
        extra_data: extraData,
        is_active: true,
        sync_status: "connected",
        last_sync: new Date().toISOString(),
      }, {
        onConflict: "user_id,broker_id",
      });

    if (dbError) {
      return new Response(
        JSON.stringify({ success: false, error: "Database mein save nahi hua" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: `${broker_id} successfully connect ho gaya!` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function errorResponse(msg: string) {
  return new Response(
    JSON.stringify({ success: false, error: msg }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
