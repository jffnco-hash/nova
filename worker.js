const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function authorized(request, env) {
  // Fail closed: never expose a billable OpenAI proxy without a configured token.
  if (!env.APP_TOKEN) return false;
  return request.headers.get("Authorization") === `Bearer ${env.APP_TOKEN}`;
}

async function openaiJson(path, payload, env) {
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    return { error: data.error?.message || "OpenAI request failed", status: response.status };
  }
  return { data };
}

async function generateImage(body, env, animated = false) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json({ error: "Prompt is required" }, 400);

  const payload = {
    model: animated ? (env.ANIMATION_MODEL || "gpt-image-2.6-flare") : (env.IMAGE_MODEL || "gpt-image-2.5-flare"),
    prompt: prompt.slice(0, 32000),
    size: body.size || "1024x1024",
    quality: body.quality || "medium",
    output_format: animated ? "gif" : (body.output_format || "png"),
  };

  if (animated) {
    const frameCount = Number(body.frame_count || 9);
    const frameDuration = Number(body.frame_duration_ms || 200);
    if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16) {
      return json({ error: "frame_count must be from 2 to 16" }, 400);
    }
    if (!Number.isInteger(frameDuration) || frameDuration < 20 || frameDuration > 2000) {
      return json({ error: "frame_duration_ms must be from 20 to 2000" }, 400);
    }
    payload.frame_count = frameCount;
    payload.frame_duration_ms = frameDuration;
  }

  const result = await openaiJson("/images/generations", payload, env);
  if (result.error) return json({ error: result.error }, result.status);
  const image = result.data.data?.[0]?.b64_json;
  if (!image) return json({ error: "No image data returned" }, 502);
  return json({
    media_base64: image,
    media_type: animated ? "image/gif" : `image/${payload.output_format}`,
    format: payload.output_format,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "NOVA", features: ["chat", "image", "animated-gif"] });
    }

    if (url.pathname === "/video") {
      return json({
        error: "OpenAI video generation is currently unavailable through the API.",
        code: "VIDEO_API_UNAVAILABLE",
        note: "The Sora 2 API and Videos API were shut down on September 24, 2026. Animated GIF creation remains available through the Images API."
      }, 501);
    }

    const routes = ["/chat", "/image", "/animation"];
    if (!routes.includes(url.pathname) || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    if (!env.APP_TOKEN) return json({ error: "Server is not configured: APP_TOKEN is required" }, 503);
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
    if (!env.OPENAI_API_KEY) return json({ error: "Server is missing OPENAI_API_KEY" }, 500);

    try {
      const body = await request.json();

      if (url.pathname === "/chat") {
        const message = String(body.message || "").trim();
        if (!message) return json({ error: "Message is required" }, 400);

        const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
        const input = [
          ...history.map(item => ({
            role: item.role === "assistant" ? "assistant" : "user",
            content: String(item.content || "").slice(0, 6000),
          })),
          { role: "user", content: message.slice(0, 6000) },
        ];

        const result = await openaiJson("/responses", {
          model: env.CHAT_MODEL || "gpt-6-astra",
          instructions: "You are NOVA, a helpful, clear, multilingual assistant. Reply in the user's language.",
          input,
        }, env);

        if (result.error) return json({ error: result.error }, result.status);
        return json({ text: result.data.output_text || "لم يصل نص في الرد." });
      }

      if (url.pathname === "/image") return await generateImage(body, env, false);
      if (url.pathname === "/animation") return await generateImage(body, env, true);

    } catch (error) {
      return json({ error: error?.message || "Unexpected server error" }, 500);
    }
  },
};
