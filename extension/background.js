const API_BASE = "https://your-vercel-backend.api";

const ENABLE_MOCK = true;

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

  const res = await fetch(`${API_BASE}/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paragraphs }),
  });
  if (!res.ok) throw new Error(`Analyze failed: ${res.status}`);
  return await res.json();
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

  const res = await fetch(`${API_BASE}/primer`, {
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
