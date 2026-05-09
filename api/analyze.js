const { getAnalysisCache, hashInput, setAnalysisCache } = require("../lib/cache");
const { handleOptions, readJson, requirePost, sendError, sendJson } = require("../lib/http");
const { createJsonResponse, getModel } = require("../lib/openai");

const MAX_PARAGRAPHS = 80;
const MAX_PARAGRAPH_CHARS = 1200;

function normalizeParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs)) return [];
  return paragraphs
    .map((paragraph) => String(paragraph || "").replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 25)
    .slice(0, MAX_PARAGRAPHS)
    .map((paragraph) => paragraph.slice(0, MAX_PARAGRAPH_CHARS));
}

function normalizeResult(result) {
  const index =
    typeof result.load_bearing_paragraph_index === "number"
      ? result.load_bearing_paragraph_index
      : null;

  const concepts = Array.isArray(result.concepts)
    ? result.concepts
        .map((concept) => {
          if (typeof concept === "string") return { name: concept };
          return {
            name: String(concept.name || concept.concept || "").trim(),
            reason: concept.reason ? String(concept.reason).trim() : undefined,
            confidence:
              typeof concept.confidence === "number" ? concept.confidence : undefined
          };
        })
        .filter((concept) => concept.name)
    : [];

  return {
    load_bearing_paragraph_index: index,
    concepts,
    should_show_banner: index !== null && concepts.length > 0,
    model: getModel()
  };
}

function buildPrompt({ title, url, paragraphs }) {
  const numberedParagraphs = paragraphs
    .map((paragraph, index) => `[${index}] ${paragraph}`)
    .join("\n\n");

  return `Title: ${title || "Untitled tutorial"}
URL: ${url || "unknown"}

Paragraphs:
${numberedParagraphs}`;
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJson(req);
    const paragraphs = normalizeParagraphs(body.paragraphs);

    if (paragraphs.length < 3) {
      sendError(res, 400, "not_enough_content", "Send at least three tutorial paragraphs.");
      return;
    }

    const cacheKey = hashInput(body.url || JSON.stringify(paragraphs));
    const cached = getAnalysisCache(cacheKey);
    if (cached) {
      sendJson(res, 200, { ...cached, cached: true });
      return;
    }

    const result = await createJsonResponse({
      system: `You detect where a developer tutorial first relies on a prerequisite concept that an early-career reader may not know.

Return only valid JSON with this exact shape:
{
  "load_bearing_paragraph_index": number | null,
  "concepts": [{"name": string, "reason": string, "confidence": number}]
}

Rules:
- Paragraph indexes are zero-based and must refer to the provided paragraph list.
- Flag only concepts that are load-bearing: later explanation breaks without them.
- Ignore jargon if the article explains it before relying on it.
- Prefer the earliest paragraph where comprehension would break.
- If the article is beginner-safe or no single prerequisite matters, return null and an empty concepts array.
- Return at most 3 concepts, all tied to the same earliest paragraph.`,
      user: buildPrompt({
        title: body.title,
        url: body.url,
        paragraphs
      })
    });

    const normalized = normalizeResult(result);
    setAnalysisCache(cacheKey, normalized);
    sendJson(res, 200, { ...normalized, cached: false });
  } catch (error) {
    sendError(res, 500, "analysis_failed", error.message);
  }
};
