/**
 * Local HTTP API for extension integration testing.
 *
 * Endpoint:
 * - POST /api/primer { selectedText: string, paragraph?: string, codeContext?: string[] } -> streamed plain text
 *
 * Usage (PowerShell):
 *   $env:OPENAI_API_KEY="sk-..."; node extension/dev/local-api.js
 *
 * Then in the extension popup:
 *   Backend API Base = http://localhost:8787
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(__dirname, "..", "..");
const MODEL = process.env.FOCUSFLOW_LOCAL_MODEL || "gpt-4o-mini";

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

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

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/primer") {
      if (!requireKey(res)) return;
      const body = await readJson(req);
      const selectedText = String(body.selectedText || body.concept || "").trim();
      const pageUrl = String(body.url || "").trim();
      const title = String(body.title || "").trim();
      const previousParagraph = String(body.previousParagraph || "").trim();
      const paragraph = String(body.paragraph || "").trim();
      const nextParagraph = String(body.nextParagraph || "").trim();
      const codeContext = Array.isArray(body.codeContext)
        ? body.codeContext.map((code) => String(code || "").trim()).filter(Boolean).slice(0, 3)
        : [];

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("transfer-encoding", "chunked");
      sse(res, "start", { selectedText });

      const messages = [
        {
          role: "system",
          content:
            "Write a concise primer for a developer who highlighted technical text. " +
            "Explain the selected text in context. If nearby article code is provided, reuse its actual variable names, function names, component names, API names, and code style. " +
            "Do not invent generic examples using foo, bar, baz, x, y, user, data, or placeholder names unless those names appear in the article code. " +
            "Do not use markdown code fences. Keep code examples to one plain line, or use inline backticks for short identifiers and expressions. Keep it under 180 words.",
        },
        {
          role: "user",
          content:
            `Highlighted text:\n${selectedText}\n\n` +
            `Article title: ${title}\nArticle URL: ${pageUrl}\n\n` +
            `Previous paragraph:\n${previousParagraph || "(none)"}\n\n` +
            `Current paragraph:\n${paragraph || "(none)"}\n\n` +
            `Next paragraph:\n${nextParagraph || "(none)"}\n\n` +
            `Nearby code from the article:\n${codeContext.length ? codeContext.map((code, index) => `Code ${index + 1}:\n${code}`).join("\n\n") : "(none)"}`,
        },
      ];

      await openaiStreamText({
        model: MODEL,
        messages,
        onChunk: (chunk) => sse(res, "delta", { text: chunk }),
      });

      sse(res, "done", {});
      res.end();
      return;
    }

    text(res, 404, "Not found");
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
});

loadEnv();

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`FocusFlow local API running on http://localhost:${PORT}`);
});

