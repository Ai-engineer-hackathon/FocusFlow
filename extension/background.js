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
    const lines = frame.split("\n").map((l) => l.trimEnd());
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    if (dataLines.length === 0) continue;

    const event = eventLine ? eventLine.slice(7).trim() : "message";
    const dataRaw = dataLines.map((l) => l.slice(6)).join("\n").trim();

    try {
      const parsed = JSON.parse(dataRaw);
      events.push({ event, data: parsed });
    } catch {
      events.push({ event, data: dataRaw });
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
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_PROSE_DONE", requestId });
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
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_PROSE_DONE", requestId });
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_DONE", requestId });
    return;
  }

  const decoder = new TextDecoder();
  let sseBuffer = "";
  const isSse = (res.headers.get("content-type") || "").includes("text/event-stream");
  let proseDoneSent = false;
  let prereqsSent = false;

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
      const eventName = String(event.event || "").trim().toLowerCase();

      if (eventName === "delta") {
        const deltaText = typeof event.data === "string" ? event.data : event.data?.text;
        if (!deltaText) continue;
        await chrome.tabs.sendMessage(tabId, {
          type: "PRIMER_CHUNK",
          requestId,
          chunk: deltaText,
        });
      }
      if (eventName === "prose_done") {
        proseDoneSent = true;
        await chrome.tabs.sendMessage(tabId, { type: "PRIMER_PROSE_DONE", requestId });
      }
      if (eventName === "prerequisites") {
        const items =
          typeof event.data === "object" && event.data
            ? event.data.items
            : typeof event.data === "string"
              ? (() => {
                  try {
                    const parsed = JSON.parse(event.data);
                    return parsed?.items;
                  } catch {
                    return null;
                  }
                })()
              : null;
        await chrome.tabs.sendMessage(tabId, {
          type: "PRIMER_PREREQUISITES",
          requestId,
          items: Array.isArray(items) ? items : [],
        });
        prereqsSent = true;
      }
    }
  }

  // Some backends never send prose_done; still trigger prerequisite loading UI after prose completes.
  if (!proseDoneSent) {
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_PROSE_DONE", requestId });
  }
  // Some backends never send prerequisites; complete the prereq section with an empty array.
  if (!prereqsSent) {
    await chrome.tabs.sendMessage(tabId, { type: "PRIMER_PREREQUISITES", requestId, items: [] });
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
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
