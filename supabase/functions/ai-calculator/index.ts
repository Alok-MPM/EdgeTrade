import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are the AI Calculator assistant inside EdgeTrade, a professional trading journal app.

YOUR ONLY JOB: help the user with position sizing, risk amount, risk:reward ratio, drawdown scenarios, and analyzing trade setups (including chart screenshots they upload).

STRICT RULES:
- Only answer questions related to trading calculations, position sizing, risk management, or chart/trade-setup analysis.
- If the user asks anything unrelated to trading/calculation (food, jokes, general chit-chat, coding help, unrelated topics), politely decline in 1 sentence and steer back to trading calculations. Example: "Main sirf trading calculations aur position sizing mein help karta hoon — apna trade setup ya chart bhejo."
- Be concise. Keep responses under 200 words.
- Format numbers clearly. Use the user's broker currency context if given.
- If a chart image is provided, analyze it visually and suggest entry/stop-loss/target reasoning along with the calculation.`;

interface CalcRequestBody {
  message: string;
  image_base64?: string | null;
  image_mime_type?: string | null;
  context?: {
    broker?: string;
    capital?: string | number;
    risk_pct?: string | number;
    entry?: string | number;
    stop_loss?: string | number;
    target?: string | number;
  };
}

function buildContextBlock(ctx: CalcRequestBody["context"]) {
  if (!ctx) return "No additional trade context provided.";
  return `- Broker: ${ctx.broker || "Not specified"}
- Capital/Balance: ${ctx.capital || "Not provided"}
- Risk %: ${ctx.risk_pct ?? "Not provided"}
- Entry Price: ${ctx.entry || "Not provided"}
- Stop Loss: ${ctx.stop_loss || "Not provided"}
- Target: ${ctx.target || "Not provided"}`;
}

async function callGemini(apiKey: string, fullPrompt: string, imageBase64?: string | null, mimeType?: string | null) {
  const parts: any[] = [{ text: fullPrompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mimeType || "image/jpeg", data: imageBase64 } });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Gemini error: ${data.error?.message || res.status}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

async function callGroq(apiKey: string, fullPrompt: string, hasImage: boolean) {
  if (hasImage) {
    throw new Error("Groq skipped: no image support on this model");
  }
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: fullPrompt }],
      max_tokens: 500,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Groq error: ${data.error?.message || res.status}`);
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned empty response");
  return text;
}

async function callMistral(apiKey: string, fullPrompt: string, hasImage: boolean) {
  if (hasImage) {
    throw new Error("Mistral skipped: no image support on this model");
  }
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: fullPrompt }],
      max_tokens: 500,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Mistral error: ${data.error?.message || res.status}`);
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Mistral returned empty response");
  return text;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body: CalcRequestBody = await req.json();
    const { message, image_base64, image_mime_type, context } = body;

    if (!message && !image_base64) {
      return new Response(JSON.stringify({ error: "No message or image provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fullPrompt = `${SYSTEM_PROMPT}

User's trade context:
${buildContextBlock(context)}

User message: ${message || "Analyze this chart and suggest trade parameters."}`;

    const hasImage = !!image_base64;

    const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
    const GROQ_KEY = Deno.env.get("GROQ_API_KEY");
    const MISTRAL_KEY = Deno.env.get("MISTRAL_API_KEY");

    const attempts: { name: string; run: () => Promise<string> }[] = [];

    if (GEMINI_KEY) {
      attempts.push({
        name: "gemini",
        run: () => callGemini(GEMINI_KEY, fullPrompt, image_base64, image_mime_type),
      });
    }
    if (GROQ_KEY) {
      attempts.push({ name: "groq", run: () => callGroq(GROQ_KEY, fullPrompt, hasImage) });
    }
    if (MISTRAL_KEY) {
      attempts.push({ name: "mistral", run: () => callMistral(MISTRAL_KEY, fullPrompt, hasImage) });
    }

    if (attempts.length === 0) {
      return new Response(
        JSON.stringify({ error: "No AI provider configured. Set GEMINI_API_KEY in Supabase secrets." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const reply = await attempt.run();
        return new Response(JSON.stringify({ reply, provider: attempt.name }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        errors.push(`${attempt.name}: ${e.message}`);
      }
    }

    return new Response(
      JSON.stringify({ error: "All AI providers failed.", details: errors }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
