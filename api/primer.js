const { handleOptions, readJson, requirePost, sendError, setCors } = require("../lib/http");
const { createJsonResponse, createStreamingResponse } = require("../lib/openai");

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

function normalizePrerequisites(result) {
  const items = Array.isArray(result?.items)
    ? result.items
        .map((item) => ({
          concept: compactText(item.concept || item.name || item.label, 48),
          oneLiner: compactText(item.oneLiner || item.reason || item.description, 140)
        }))
        .filter((item) => item.concept && item.oneLiner)
        .slice(0, 4)
    : [];

  return { items };
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJson(req);
    const selectedText = compactText(body.selectedText || body.concept || body.concepts?.[0], 1200);
    const title = compactText(body.title, 160);
    const paragraph = compactText(body.paragraph || body.targetParagraph, 1200);
    const previousParagraph = compactText(body.previousParagraph, 1000);
    const nextParagraph = compactText(body.nextParagraph, 1000);
    const codeContext = Array.isArray(body.codeContext)
      ? body.codeContext.map((code) => String(code || "").trim()).filter(Boolean).slice(0, 3)
      : [];

    if (!selectedText) {
      sendError(res, 400, "missing_input", "Send selectedText.");
      return;
    }

    setCors(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    sse(res, "start", { selectedText });

    const context = `Tutorial title: ${title || "unknown"}
Highlighted text:
${selectedText}

Previous paragraph:
${previousParagraph || "(none)"}

Current paragraph:
${paragraph || "(none)"}

Next paragraph:
${nextParagraph || "(none)"}

Nearby code from the article:
${codeContext.length ? codeContext.map((code, index) => `Code ${index + 1}:\n${code}`).join("\n\n") : "(none)"}`;

    const openAIResponse = await createStreamingResponse({
      system: `Write a short inline primer for a developer who highlighted technical text while reading.

Output constraints:
- Start directly with the explanation.
- Keep it under 180 words.
- Explain the selected text in the context of the provided article paragraph.
- Use the previous and next paragraph only to resolve references or article-specific meaning.
- If the selection contains code, explain what it does and why it matters.
- If the selection is a term or phrase, explain the concept and why it matters here.
- If nearby article code is provided, ground the explanation in that code.
- Reuse the article's actual variable names, function names, component names, API names, and code style.
- Do not invent generic examples using foo, bar, baz, x, y, user, data, handleClick, or other placeholder names unless those names appear in the article code.
- If a code example is helpful, adapt the article's own identifiers. If there is not enough code context, explain in prose instead of making up a generic snippet.
- Do not use markdown code fences.
- Keep code examples to one plain line, or use inline backticks for short identifiers and expressions.
- Avoid generic textbook framing.
- Include one tiny code example only if it makes the paragraph easier to understand.
- Do not mention that you are an AI or that you received context.`,
      user: context
    });

    await pipeOpenAIStream(openAIResponse, res);
    sse(res, "prose_done", {});

    try {
      const prerequisites = await createJsonResponse({
        system: `Identify prerequisite concepts for a developer who highlighted technical text.

Return only valid JSON:
{
  "items": [{"concept": string, "oneLiner": string}]
}

Rules:
- Return 2 to 4 prerequisite chips that the highlighted term builds on.
- Skip the article's main topic. Do not include the main topic from the title if the article is about that topic.
- Skip the highlighted term itself.
- Skip extremely basic concepts such as variable, function, loop, string, number, class, and object unless directly necessary for this specific highlighted term.
- Order from most foundational to least foundational.
- If there are no meaningful prerequisites because the term is already foundational, return { "items": [] }.
- Each oneLiner must stand on its own. Do not use references like "this concept", "it", "that", "as above", or "the above".
- Prefer technical prerequisites that help the reader understand the highlighted term in the article context.`,
        user: context
      });
      sse(res, "prerequisites", normalizePrerequisites(prerequisites));
    } catch (error) {
      sse(res, "prerequisites", { items: [] });
    }

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
