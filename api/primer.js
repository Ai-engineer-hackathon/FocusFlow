const { handleOptions, readJson, requirePost, sendError, setCors } = require("../lib/http");
const { createStreamingResponse } = require("../lib/openai");

function compactText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function pipeOpenAIStream(openAIResponse, res) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of openAIResponse.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const line = part
        .split("\n")
        .find((entry) => entry.startsWith("data: "));
      if (!line) continue;

      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const event = JSON.parse(payload);
        const delta =
          event.type === "response.output_text.delta"
            ? event.delta
            : event.type === "response.refusal.delta"
              ? event.delta
              : "";

        if (delta) sse(res, "delta", { text: delta });
      } catch {
        // Ignore malformed upstream chunks and continue streaming usable deltas.
      }
    }
  }
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJson(req);
    const concept = compactText(body.concept || body.concepts?.[0], 80);
    const title = compactText(body.title, 160);
    const paragraph = compactText(body.paragraph || body.targetParagraph, 1200);
    const before = compactText(body.previousParagraph, 800);
    const after = compactText(body.nextParagraph, 800);

    if (!concept || !paragraph) {
      sendError(res, 400, "missing_input", "Send concept and paragraph.");
      return;
    }

    const openAIResponse = await createStreamingResponse({
      system: `Write a short inline primer for a developer who is reading a tutorial and is about to hit an assumed prerequisite.

Output constraints:
- Start directly with the explanation.
- Keep it under 180 words.
- Explain the concept only in the context of the provided article paragraph.
- Avoid generic textbook framing.
- Include one tiny code example only if it makes the paragraph easier to understand.
- Do not mention that you are an AI or that you received context.`,
      user: `Tutorial title: ${title || "unknown"}
Concept to explain: ${concept}

Previous paragraph:
${before || "(none)"}

Paragraph that assumes the concept:
${paragraph}

Next paragraph:
${after || "(none)"}`
    });

    setCors(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    sse(res, "start", { concept });

    await pipeOpenAIStream(openAIResponse, res);
    sse(res, "done", {});
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      sendError(res, 500, "primer_failed", error.message);
      return;
    }

    sse(res, "error", { message: error.message });
    res.end();
  }
};
