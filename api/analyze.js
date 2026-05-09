const { getAnalysisCache, hashInput, setAnalysisCache } = require("../lib/cache");
const { handleOptions, readJson, requirePost, sendError, sendJson } = require("../lib/http");
const { createJsonResponse, getModel } = require("../lib/openai");

const MAX_PARAGRAPHS = 80;
const MAX_PARAGRAPH_CHARS = 1200;
const USER_LEVELS = new Set(["beginner", "intermediate", "advanced"]);

function normalizeParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs)) return [];
  return paragraphs
    .map((paragraph) => String(paragraph || "").replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 25)
    .slice(0, MAX_PARAGRAPHS)
    .map((paragraph) => paragraph.slice(0, MAX_PARAGRAPH_CHARS));
}

function normalizeResult(result) {
  const sourceBreakpoints = Array.isArray(result.breakpoints)
    ? result.breakpoints
    : [
        {
          paragraph_index: result.load_bearing_paragraph_index,
          concepts: result.concepts
        }
      ];

  const breakpoints = sourceBreakpoints
    .map((breakpoint) => {
      const paragraphIndex =
        typeof breakpoint.paragraph_index === "number"
          ? breakpoint.paragraph_index
          : typeof breakpoint.load_bearing_paragraph_index === "number"
            ? breakpoint.load_bearing_paragraph_index
            : null;

      const concepts = Array.isArray(breakpoint.concepts)
        ? breakpoint.concepts
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
        paragraph_index: paragraphIndex,
        concepts
      };
    })
    .filter(
      (breakpoint) =>
        breakpoint.paragraph_index !== null && breakpoint.concepts.length > 0
    )
    .sort((a, b) => a.paragraph_index - b.paragraph_index)
    .slice(0, 8);

  const firstBreakpoint = breakpoints[0] || null;

  return {
    breakpoints,
    load_bearing_paragraph_index: firstBreakpoint ? firstBreakpoint.paragraph_index : null,
    concepts: firstBreakpoint ? firstBreakpoint.concepts : [],
    should_show_banner: breakpoints.length > 0,
    model: getModel()
  };
}

function normalizeUserLevel(userLevel) {
  const normalized = String(userLevel || "").trim().toLowerCase();
  return USER_LEVELS.has(normalized) ? normalized : "intermediate";
}

function levelGuidance(userLevel) {
  if (userLevel === "beginner") {
    return `Assumed reader: a developer who knows basic programming syntax, variables, functions, arrays, objects, and basic HTML/CSS, but may not know framework internals, browser APIs, async patterns, or intermediate JavaScript concepts.
Flag more concepts when they are needed to understand the next paragraph, but still avoid basic syntax and common words.`;
  }

  if (userLevel === "advanced") {
    return `Assumed reader: an experienced developer who knows common programming, JavaScript, web development, HTTP, async/await, and basic framework concepts.
Flag only deeper or specialized concepts that even a strong developer may need before following this article, such as framework internals, distributed systems ideas, advanced type-system behavior, browser APIs, performance models, or security assumptions.`;
  }

  return `Assumed reader: a junior-to-intermediate developer who knows basic programming, JavaScript syntax, functions, variables, arrays, objects, basic HTML/CSS, and common web vocabulary.
Do not flag basic syntax or broad terms like JavaScript, function, variable, component, HTML, CSS, browser, or API unless the article uses them in a specialized way. Flag intermediate prerequisite concepts that are required but not explained.`;
}

function buildPrompt({ title, url, paragraphs, userLevel }) {
  const numberedParagraphs = paragraphs
    .map((paragraph, index) => `[${index}] ${paragraph}`)
    .join("\n\n");

  return `Title: ${title || "Untitled tutorial"}
URL: ${url || "unknown"}
Reader level: ${userLevel}

Paragraphs:
${numberedParagraphs}`;
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (!requirePost(req, res)) return;

  try {
    const body = await readJson(req);
    const paragraphs = normalizeParagraphs(body.paragraphs);
    const userLevel = normalizeUserLevel(body.userLevel);

    if (paragraphs.length < 3) {
      sendError(res, 400, "not_enough_content", "Send at least three tutorial paragraphs.");
      return;
    }

    const cacheKey = hashInput(`${userLevel}:${body.url || JSON.stringify(paragraphs)}`);
    const cached = getAnalysisCache(cacheKey);
    if (cached) {
      sendJson(res, 200, { ...cached, cached: true });
      return;
    }

    const result = await createJsonResponse({
      system: `You detect where a developer tutorial relies on prerequisite knowledge the reader may not have.

${levelGuidance(userLevel)}

Important product behavior:
- You are not making a glossary. You are finding concepts that explain why the article's code or reasoning works.
- The concept name does not need to appear verbatim in the paragraph. If the paragraph describes the situation, name the underlying concept.
- For React/useEffect articles, actively look for hidden prerequisites such as closures, stale closures, render snapshots, dependency arrays, cleanup timing, component unmounting, race conditions, async state updates, memory leaks, AbortController, subscriptions, intervals, Strict Mode double invocation, referential equality, and memoization.
- If a paragraph says a promise/fetch/request can finish after props, state, dependencies, navigation, or unmounting changes, that is usually "race condition" and/or "async state update after unmount".
- If a paragraph says cleanup runs before the next effect or when unmounting, that is usually "effect cleanup timing".
- If a paragraph says old values are read inside callbacks/effects, that is usually "stale closure" or "render snapshot".

Return only valid JSON with this exact shape:
{
  "breakpoints": [
    {
      "paragraph_index": number,
      "concepts": [{"name": string, "reason": string, "confidence": number}]
    }
  ]
}

Rules:
- Paragraph indexes are zero-based and must refer to the provided paragraph list.
- Flag only concepts that are load-bearing: later explanation breaks without them.
- Ignore jargon if the article explains it before relying on it.
- Return breakpoints across the whole article, not just the first one.
- Each breakpoint should be the first paragraph where its listed concept is assumed without explanation.
- Avoid duplicate concepts. If the same concept appears again later, include it only at the first load-bearing paragraph.
- Prefer 3 to 8 high-signal breakpoints for a substantial technical article. Return fewer only if the article truly has fewer prerequisite breaks.
- Return at most 3 concepts per breakpoint.
- If the article is beginner-safe, return an empty breakpoints array.`,
      user: buildPrompt({
        title: body.title,
        url: body.url,
        paragraphs,
        userLevel
      })
    });

    const normalized = normalizeResult(result);
    setAnalysisCache(cacheKey, normalized);
    sendJson(res, 200, { ...normalized, cached: false });
  } catch (error) {
    sendError(res, 500, "analysis_failed", error.message);
  }
};
