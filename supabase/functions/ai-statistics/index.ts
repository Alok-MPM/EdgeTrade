import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { messages, statsContext } = await req.json();

    const systemPrompt = `You are EdgeTrade's Statistics Analyst — a sharp, data-driven trading coach embedded in the Statistics page of EdgeTrade, a professional trading journal.

Your ONLY job: help the user understand their trading statistics, identify patterns, explain weak points and strong points, and suggest data-backed improvements.

The user's current trading statistics (period: ${statsContext?.filter || 'current'}):
- Total Trades: ${statsContext?.totalTrades ?? 0}
- Wins: ${statsContext?.wins ?? 0}
- Losses: ${statsContext?.losses ?? 0}
- Breakevens: ${statsContext?.breakevens ?? 0}
- Win Rate: ${statsContext?.winRate ?? 0}%
- Average R:R: ${statsContext?.avgRR ?? 'N/A'}
- Session Performance: ${JSON.stringify(statsContext?.sessionPerformance || {})}
- Day of Week Performance: ${JSON.stringify(statsContext?.dayOfWeekPerformance || {})}
- Strategy Performance: ${JSON.stringify(statsContext?.strategyPerformance || [])}
- Capital Growth: ${JSON.stringify(statsContext?.capitalGrowth || null)}
- Identified Weak Points: ${statsContext?.weakPoints || 'None detected yet'}
- Identified Strong Points: ${statsContext?.strongPoints || 'None detected yet'}

STRICT SCOPE RULES:
- Discuss ONLY: trading statistics, win rates, session analysis, day-of-week patterns, strategy performance, capital growth, streak analysis, trade psychology patterns from the data above.
- Do NOT help with position sizing or risk calculations — that is the Calculator section's job.
- Do NOT help with app bugs, setup, or how-to-use questions — that is the Assistant section's job.
- If asked anything outside your scope, politely decline and redirect to the correct section of EdgeTrade.

Communication style: Hinglish (mix of Hindi and English). Be direct, data-backed, like a seasoned trading mentor. No fluff.

On your very first reply, introduce yourself as: "Main hoon EdgeTrade Statistics Analyst — aapke trading data ka deep dive expert. Kya samajhna chahte ho?"`;

    const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
    const GROQ_KEY = Deno.env.get("GROQ_API_KEY");
    const MISTRAL_KEY = Deno.env.get("MISTRAL_API_KEY");

    const formattedMessages = (messages || []).map((m: any) => ({
      role: m.role,
      content: m.content,
    }));

    if (GEMINI_KEY) {
      try {
        const geminiMessages = formattedMessages.map((m: any) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: geminiMessages,
            }),
          }
        );
        const data = await res.json();
        if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          return new Response(
            JSON.stringify({ reply: data.candidates[0].content.parts[0].text }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch (_) {}
    }

    if (GROQ_KEY) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROQ_KEY}`,
          },
          body: JSON.stringify({
            model: "llama3-8b-8192",
            messages: [{ role: "system", content: systemPrompt }, ...formattedMessages],
          }),
        });
        const data = await res.json();
        if (data?.choices?.[0]?.message?.content) {
          return new Response(
            JSON.stringify({ reply: data.choices[0].message.content }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch (_) {}
    }

    if (MISTRAL_KEY) {
      try {
        const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${MISTRAL_KEY}`,
          },
          body: JSON.stringify({
            model: "mistral-small-latest",
            messages: [{ role: "system", content: systemPrompt }, ...formattedMessages],
          }),
        });
        const data = await res.json();
        if (data?.choices?.[0]?.message?.content) {
          return new Response(
            JSON.stringify({ reply: data.choices[0].message.content }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch (_) {}
    }

    return new Response(
      JSON.stringify({ reply: "All AI providers unavailable. Please try again later." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 503 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
