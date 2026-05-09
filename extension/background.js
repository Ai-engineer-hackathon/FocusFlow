const DEFAULT_API_BASE = "http://localhost:3000";

const ENABLE_MOCK = false; // Set true to use mocked responses.

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

function extractSseEvents(raw) {
  const events = [];
  for (const frame of raw.split("\n\n")) {
    const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;

    const event = eventLine ? eventLine.slice(7).trim() : "message";

    try {
      const parsed = JSON.parse(dataLine.slice(6));
      events.push({ event, data: parsed });
    } catch {
      // Ignore incomplete frames; the next network chunk may complete them.
    }
  }
  return events;
}

async function streamPrimerToTab({
  tabId,
  requestId,
  selectedText,
  url,
  title,
  previousParagraph,
  paragraph,
  nextParagraph,
  codeContext,
}) {
  if (ENABLE_MOCK) {
    const mock =
      `Primer for: ${selectedText}\n\n` +
      `This explains the selected technical text in the context of the surrounding paragraph.\n`;
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
    body: JSON.stringify({
      selectedText,
      url,
      title,
      previousParagraph,
      paragraph,
      nextParagraph,
      codeContext,
    }),
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
  let sseBuffer = "";
  const isSse = (res.headers.get("content-type") || "").includes("text/event-stream");

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });

    if (!isSse) {
      await chrome.tabs.sendMessage(tabId, { type: "PRIMER_CHUNK", requestId, chunk });
      continue;
    }

    sseBuffer += chunk;
    const parts = sseBuffer.split("\n\n");
    sseBuffer = parts.pop() || "";
    for (const event of extractSseEvents(parts.join("\n\n"))) {
      if (event.event === "delta" && event.data?.text) {
        await chrome.tabs.sendMessage(tabId, {
          type: "PRIMER_CHUNK",
          requestId,
          chunk: event.data.text,
        });
      }
      if (event.event === "prose_done") {
        await chrome.tabs.sendMessage(tabId, { type: "PRIMER_PROSE_DONE", requestId });
      }
      if (event.event === "prerequisites") {
        await chrome.tabs.sendMessage(tabId, {
          type: "PRIMER_PREREQUISITES",
          requestId,
          items: Array.isArray(event.data?.items) ? event.data.items : [],
        });
      }
    }
  }
  await chrome.tabs.sendMessage(tabId, { type: "PRIMER_DONE", requestId });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    if (!request || !request.type) return;

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
        selectedText: request.selectedText,
        url: request.url,
        title: request.title,
        previousParagraph: request.previousParagraph,
        paragraph: request.paragraph,
        nextParagraph: request.nextParagraph,
        codeContext: request.codeContext,
      });
      return;
    }

    if (request.type === "GET_PREREQUISITES") {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing sender tab" });
        return;
      }

      const apiBase = await getApiBase();
      const res = await fetchWithFallback(apiBase, ["/prerequisites", "/api/prerequisites"], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedText: request.selectedText,
          url: request.url,
          title: request.title,
          previousParagraph: request.previousParagraph,
          paragraph: request.paragraph,
          nextParagraph: request.nextParagraph,
          codeContext: request.codeContext,
        }),
      });

      if (!res.ok) {
        // Never break prose; just report empty prerequisites.
        await chrome.tabs.sendMessage(tabId, {
          type: "PRIMER_PREREQUISITES",
          requestId: request.requestId,
          items: [],
        });
        sendResponse({ ok: true });
        return;
      }

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      const items = coercePrereqItems(data) || [];

      await chrome.tabs.sendMessage(tabId, {
        type: "PRIMER_PREREQUISITES",
        requestId: request.requestId,
        items: Array.isArray(items) ? items : [],
      });
      sendResponse({ ok: true });
      return;
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
