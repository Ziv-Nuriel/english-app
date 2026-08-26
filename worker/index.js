const RESPONSE_TOOL = {
  name: "dialogue_response",
  description: "Grammar feedback and an in-character reply for the English dialogue practice.",
  input_schema: {
    type: "object",
    properties: {
      grammar_ok: { type: "boolean", description: "true if the student's message is grammatically correct for the target rule described in the system prompt" },
      note: { type: "string", description: "If grammar_ok is false: a short note IN HEBREW explaining the grammar mistake and how to fix it. If grammar_ok is true: empty string." },
      reply: { type: "string", description: "A short, natural in-character reply in English (1-2 sentences) that fits the scenario, responds to what the student actually asked or said, and invites a follow-up question." }
    },
    required: ["grammar_ok", "note", "reply"]
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { ...corsHeaders(), "content-type": "application/json" } });
    }

    const { scenario, grammarFocus, history, message } = body || {};
    if (typeof message !== "string" || !message.trim() || message.length > 300) {
      return new Response(JSON.stringify({ error: "Invalid message" }), { status: 400, headers: { ...corsHeaders(), "content-type": "application/json" } });
    }
    if (typeof scenario !== "string" || typeof grammarFocus !== "string") {
      return new Response(JSON.stringify({ error: "Missing scenario/grammarFocus" }), { status: 400, headers: { ...corsHeaders(), "content-type": "application/json" } });
    }

    const systemPrompt = `You are role-playing as a character in an English-learning app for a Hebrew-speaking student.
Scenario: ${scenario}
The student is practicing this grammar point: ${grammarFocus}

Stay fully in character. Look at the student's latest message and judge whether it is grammatically correct with respect to the target grammar point above (minor unrelated issues can be ignored). Then write a short, natural, in-character reply that responds to what they actually asked or said, and that invites a follow-up question. Keep the reply to 1-2 short sentences of plain English.`;

    const messages = [
      ...(Array.isArray(history) ? history.slice(-8).map(h => ({
        role: h.who === "you" ? "user" : "assistant",
        content: String(h.text || "").slice(0, 500)
      })) : []),
      { role: "user", content: message }
    ];

    try {
      const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: systemPrompt,
          messages,
          tools: [RESPONSE_TOOL],
          tool_choice: { type: "tool", name: "dialogue_response" }
        })
      });

      if (!apiResp.ok) {
        const detail = await apiResp.text();
        return new Response(JSON.stringify({ error: "Upstream error", detail }), { status: 502, headers: { ...corsHeaders(), "content-type": "application/json" } });
      }

      const data = await apiResp.json();
      const toolUse = (data.content || []).find(c => c.type === "tool_use");
      if (!toolUse) {
        return new Response(JSON.stringify({ error: "No structured response from model" }), { status: 502, headers: { ...corsHeaders(), "content-type": "application/json" } });
      }

      return new Response(JSON.stringify(toolUse.input), {
        headers: { ...corsHeaders(), "content-type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders(), "content-type": "application/json" } });
    }
  }
};
