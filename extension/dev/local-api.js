/**
 * Local HTTP API for extension integration testing.
 *
 * Endpoints (contract must match the extension contract):
 * - POST /api/analyze  { paragraphs: string[] } -> { load_bearing_paragraph_index: number, concepts: string[] }
 * - POST /api/primer   { concept: string, url?: string } -> streamed plain text (or non-streamed fallback)
 *
 * Usage (PowerShell):
 *   $env:OPENAI_API_KEY="sk-..."; node extension/dev/local-api.js
 *
 * Then in the extension popup:
 *   Backend API Base = http://localhost:8787
 */

const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8787);

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function text(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function requireKey(res) {
  if (process.env.OPENAI_API_KEY) return true;
  json(res, 500, { error: "Missing OPENAI_API_KEY in environment." });
  return false;
}

async function openaiChatJson({ model, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content");
  return JSON.parse(content);
}

async function openaiStreamText({ model, messages, onChunk }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${errText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Missing response body reader");

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const sep = buffer.indexOf("\n\n");
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const lines = frame.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
}

function clampIndex(idx, len) {
  if (!Number.isFinite(idx)) return 0;
  return Math.max(0, Math.min(len - 1, Math.floor(idx)));
}

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      if (!requireKey(res)) return;
      const body = await readJson(req);
      const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];

      const prompt = [
        {
          role: "system",
          content:
            "You analyze a technical tutorial and identify prerequisite concepts the author assumes without explaining. " +
            "Return JSON ONLY with keys: load_bearing_paragraph_index (number), concepts (string array). " +
            "load_bearing_paragraph_index should be the earliest paragraph index (0-based) where understanding depends on the concepts.",
        },
        {
          role: "user",
          content:
            "Paragraphs (0-based index):\n" +
            paragraphs.map((p, i) => `[${i}] ${String(p || "").slice(0, 1200)}`).join("\n\n"),
        },
      ];

      const out = await openaiChatJson({ model: "gpt-4o-mini", messages: prompt });
      const concepts = Array.isArray(out.concepts) ? out.concepts.map(String) : [];
      const loadIdx = clampIndex(out.load_bearing_paragraph_index, Math.max(1, paragraphs.length));

      json(res, 200, { load_bearing_paragraph_index: loadIdx, concepts });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/primer") {
      if (!requireKey(res)) return;
      const body = await readJson(req);
      const concept = String(body.concept || "").trim();
      const pageUrl = String(body.url || "").trim();

      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("transfer-encoding", "chunked");

      const messages = [
        {
          role: "system",
          content:
            "Write a concise 60-90 second primer for a developer reading a tutorial article. " +
            "Make it practical and tailored to the likely context (web dev / JS). Use short paragraphs and one tiny example if helpful.",
        },
        { role: "user", content: `Concept: ${concept}\nArticle URL: ${pageUrl}` },
      ];

      await openaiStreamText({
        model: "gpt-4o-mini",
        messages,
        onChunk: (chunk) => res.write(chunk),
      });

      res.end();
      return;
    }

    text(res, 404, "Not found");
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`FocusFlow local API running on http://localhost:${PORT}`);
});

