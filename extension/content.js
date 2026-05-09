const FF = {
  dwellThresholdMs: 30_000,
  minParagraphChars: 60,
};

function getReadableRoot() {
  return (
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body
  );
}

function isElementVisible(el) {
  const style = window.getComputedStyle(el);
  if (!style || style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.height > 0 && rect.width > 0;
}

function getCandidateParagraphElements() {
  const root = getReadableRoot();
  const els = Array.from(root.querySelectorAll("p"));
  return els
    .filter((p) => isElementVisible(p))
    .filter((p) => (p.innerText || "").trim().length >= FF.minParagraphChars);
}

function extractParagraphTexts(paragraphEls) {
  return paragraphEls.map((p) => (p.innerText || "").replace(/\s+/g, " ").trim());
}

function maybeReadabilityText() {
  try {
    if (!window.Readability) return null;
    const clone = document.cloneNode(true);
    const parsed = new window.Readability(clone).parse();
    return parsed?.textContent || null;
  } catch {
    return null;
  }
}

function setupDwellTracking(paragraphEls) {
  const inViewSince = new Map();
  const fired = new Set();

  const observer = new IntersectionObserver(
    (entries) => {
      const now = Date.now();
      for (const entry of entries) {
        const idx = Number(entry.target?.dataset?.ffParagraphIndex);
        if (!Number.isFinite(idx)) continue;

        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          if (!inViewSince.has(idx)) inViewSince.set(idx, now);
          const start = inViewSince.get(idx);
          if (!fired.has(idx) && start && now - start > FF.dwellThresholdMs) {
            fired.add(idx);
            nudgeOnDwell(idx, paragraphEls);
          }
        } else {
          inViewSince.delete(idx);
        }
      }
    },
    { threshold: [0.6] },
  );

  paragraphEls.forEach((p, idx) => {
    p.dataset.ffParagraphIndex = String(idx);
    observer.observe(p);
  });
}

function nudgeOnDwell(paragraphIndex, paragraphEls) {
  const anchor = paragraphEls[paragraphIndex];
  if (!anchor) return;

  const existing = anchor.parentElement?.querySelector(
    `.ff-gap-banner[data-ff-anchor-index="${paragraphIndex}"]`,
  );
  if (existing) {
    existing.style.borderLeftColor = "rgba(37, 99, 235, 0.75)";
    const subtitle = existing.querySelector(".ff-gap-banner__subtitle");
    if (subtitle) subtitle.textContent = "Looks dense. Want that 90-second primer now?";
    return;
  }

  injectBanner(paragraphIndex, "this concept", paragraphEls, {
    subtitleOverride: "Looks dense. Want a 90-second primer before continuing?",
    hideKnowButton: true,
  });
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function injectBanner(paragraphIndex, concept, paragraphEls, opts = {}) {
  const anchor = paragraphEls[paragraphIndex];
  if (!anchor) return;
  if (anchor.dataset.ffBannerInjected === "1") return;

  anchor.classList.add("ff-gap-highlight");

  const banner = createEl("div", "ff-gap-banner");
  banner.dataset.ffAnchorIndex = String(paragraphIndex);
  banner.dataset.ffConcept = concept;

  const row = createEl("div", "ff-gap-banner__row");
  const left = createEl("div");
  const title = createEl("div", "ff-gap-banner__title", "Quick nudge");
  const subtitle = createEl("div", "ff-gap-banner__subtitle");
  if (opts.subtitleOverride) {
    subtitle.textContent = opts.subtitleOverride;
  } else {
    subtitle.innerHTML = `This paragraph leans on <span class="ff-gap-banner__concept"></span>. Want a 30s primer?`;
    subtitle.querySelector(".ff-gap-banner__concept").textContent = concept;
  }
  left.append(title, subtitle);

  const actions = createEl("div", "ff-gap-banner__actions");
  const showPrimerBtn = createEl("button", "ff-gap-banner__btn ff-gap-banner__btn--primary", "Show Primer");
  showPrimerBtn.type = "button";
  actions.append(showPrimerBtn);
  let knowBtn = null;
  if (!opts.hideKnowButton) {
    knowBtn = createEl("button", "ff-gap-banner__btn", "I know this");
    knowBtn.type = "button";
    actions.append(knowBtn);
  }

  row.append(left, actions);

  const primer = createEl("div", "ff-gap-banner__primer");
  primer.hidden = true;

  const primerMeta = createEl("div", "ff-gap-banner__primerMeta");
  const status = createEl("div", "ff-gap-banner__status", "Loading primer…");
  const spinner = createEl("div", "ff-gap-banner__spinner");
  primerMeta.append(status, spinner);

  const primerText = createEl("div", "ff-gap-banner__primerText", "");
  primer.append(primerMeta, primerText);

  banner.append(row, primer);

  const parent = anchor.parentElement;
  if (!parent) return;
  parent.insertBefore(banner, anchor);

  const requestId = crypto.randomUUID();
  let primerRequested = false;

  showPrimerBtn.addEventListener("click", () => {
    primer.hidden = !primer.hidden;
    if (primer.hidden) {
      showPrimerBtn.textContent = "Show Primer";
      return;
    }
    showPrimerBtn.textContent = "Hide Primer";

    if (primerRequested) return;
    primerRequested = true;

    chrome.runtime.sendMessage(
      { type: "GET_PRIMER", requestId, concept, url: location.href },
      (resp) => {
        if (!resp?.ok) {
          status.textContent = resp?.error || "Failed to start primer.";
          spinner.remove();
          return;
        }
      },
    );
  });

  if (knowBtn) {
    knowBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "MARK_KNOWN", concept });
      banner.remove();
      anchor.classList.remove("ff-gap-highlight");
      anchor.dataset.ffBannerInjected = "";
    });
  }

  const onPrimerMessage = (msg) => {
    if (!msg || msg.requestId !== requestId) return;
    if (msg.type === "PRIMER_CHUNK") {
      primerText.textContent += msg.chunk;
      status.textContent = "Primer";
      return;
    }
    if (msg.type === "PRIMER_DONE") {
      status.textContent = "Primer";
      spinner.remove();
      chrome.runtime.onMessage.removeListener(onPrimerMessage);
      return;
    }
    if (msg.type === "PRIMER_ERROR") {
      status.textContent = msg.error || "Primer failed.";
      spinner.remove();
      chrome.runtime.onMessage.removeListener(onPrimerMessage);
    }
  };

  chrome.runtime.onMessage.addListener(onPrimerMessage);
  anchor.dataset.ffBannerInjected = "1";
}

async function analyzeAndInject() {
  const paragraphEls = getCandidateParagraphElements();
  if (!paragraphEls.length) return;

  setupDwellTracking(paragraphEls);

  const paragraphs = extractParagraphTexts(paragraphEls);
  const readabilityText = maybeReadabilityText();
  if (readabilityText && readabilityText.length > 200) {
    // Keep the contract stable; extra context can be useful later if backend supports it.
    // For now, we only send paragraphs as specified.
  }

  chrome.runtime.sendMessage(
    { type: "ANALYZE_PAGE", paragraphs, url: location.href },
    (resp) => {
      if (!resp || !Array.isArray(resp.concepts) || resp.concepts.length === 0) return;
      const idx = Math.max(0, Math.min(paragraphEls.length - 1, resp.load_bearing_paragraph_index ?? 0));
      injectBanner(idx, resp.concepts[0], paragraphEls);
    },
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", analyzeAndInject, { once: true });
} else {
  analyzeAndInject();
}
