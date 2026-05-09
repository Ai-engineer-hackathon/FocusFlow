const DEFAULT_API_BASE = "https://your-vercel-backend.api";

const ENABLE_MOCK = false; // Set true to use mocked responses.

function normalizeConceptKey(concept) {
  return String(concept || "").trim().toLowerCase();
}

async function getKnownConcepts() {
  const { ffKnownConcepts = {} } = await chrome.storage.local.get(["ffKnownConcepts"]);
  return ffKnownConcepts;
}

async function markConceptKnown(concept) {
  const key = normalizeConceptKey(concept);
  if (!key) return;
  const ffKnownConcepts = await getKnownConcepts();
  ffKnownConcepts[key] = true;
  await chrome.storage.local.set({ ffKnownConcepts });
}

async function analyzePage(paragraphs) {
  if (ENABLE_MOCK) {
    return {
      load_bearing_paragraph_index: Math.min(3, Math.max(0, (paragraphs?.length || 1) - 1)),
      concepts: ["closures", "dependency array", "stale state"],
    };
  }

  const apiBase = await getApiBase();
  const res = await fetchWithFallback(apiBase, ["/analyze", "/api/analyze"], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paragraphs }),
  });
  if (!res.ok) throw new Error(`Analyze failed: ${res.status}`);
  return await res.json();
}

async function getApiBase() {
  const { ffApiBase } = await chrome.storage.local.get(["ffApiBase"]);
  return (ffApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

async function fetchWithFallback(apiBase, paths, init) {
  let lastRes = null;
  for (const path of paths) {
    const res = await fetch(`${apiBase}${path}`, init);
    if (res.status !== 404) return res;
    lastRes = res;
  }
  return lastRes || fetch(`${apiBase}${paths[0]}`, init);
}

async function streamPrimerToTab({ tabId, requestId, concept, url }) {
  if (ENABLE_MOCK) {
    const mock =
      `Primer: ${concept}\n\n` +
      `- What it is: a short definition.\n` +
      `- Why it matters here: a quick intuition.\n` +
      `- Mini example: ...\n` +
      `\n(backend not wired yet; mock streaming)\n`;
    for (const chunk of mock.match(/.{1,45}/g) || []) {
      await chrome.tabs.sendMessage(tabId, { type: "PRIMER_CHUNK", requestId, chunk });
      await new Promise((r) => setTimeout(r, 35));
    }
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_DONE", requestId });
    return;
  }

  const apiBase = await getApiBase();
  const res = await fetchWithFallback(apiBase, ["/primer", "/api/primer"], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ concept, url }),
  });

  if (!res.ok) {
    await chrome.tabs.sendMessage(tabId, {
      type: "PRIMER_ERROR",
      requestId,
      error: `Primer failed: ${res.status}`,
    });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_CHUNK", requestId, chunk: text });
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_DONE", requestId });
    return;
  }

  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_CHUNK", requestId, chunk });
  }
  await chrome.tabs.sendMessage(tabId, { type: "PRIMER_DONE", requestId });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    if (!request || !request.type) return;

    if (request.type === "ANALYZE_PAGE") {
      const paragraphs = Array.isArray(request.paragraphs) ? request.paragraphs : [];
      const analysis = await analyzePage(paragraphs);

      const known = await getKnownConcepts();
      const concepts = (analysis.concepts || []).filter((c) => !known[normalizeConceptKey(c)]);

      sendResponse({
        load_bearing_paragraph_index: analysis.load_bearing_paragraph_index ?? 0,
        concepts,
      });
      return;
    }

    if (request.type === "MARK_KNOWN") {
      await markConceptKnown(request.concept);
      sendResponse({ ok: true });
      return;
    }

    if (request.type === "SET_API_BASE") {
      const apiBase = String(request.apiBase || "").trim();
      if (!apiBase) {
        sendResponse({ ok: false, error: "Missing apiBase" });
        return;
      }
      await chrome.storage.local.set({ ffApiBase: apiBase });
      sendResponse({ ok: true });
      return;
    }

    if (request.type === "GET_PRIMER") {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing sender tab" });
        return;
      }
      const requestId = request.requestId || crypto.randomUUID();
      sendResponse({ ok: true, requestId });
      await streamPrimerToTab({
        tabId,
        requestId,
        concept: request.concept,
        url: request.url,
      });
      return;
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
