const FF = {
  selectionMinChars: 3,
  selectionMaxChars: 1200,
};

let selectionButton = null;
let primerPanel = null;
let activeRequestId = null;
let activePanelState = null;
let activePrimerListener = null;
let prereqTimeout = null;
let prereqRequestedForRequestId = null;

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function renderPrimerText(el, rawText) {
  const cleaned = rawText
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "");
  const parts = cleaned.split(/(`[^`]+`)/g);

  el.replaceChildren();
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      el.append(createEl("code", "ff-inline-code", part.slice(1, -1)));
    } else {
      el.append(document.createTextNode(part));
    }
  }
}

function compactText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getReadableBlocks() {
  const root =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body;

  return Array.from(root.querySelectorAll("p, li, blockquote, pre"))
    .map((el) => ({
      el,
      text: compactText(el.innerText, 1800),
    }))
    .filter((block) => block.text.length >= 20);
}

function getNearbyCodeContext(container) {
  const root =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body;
  const codeBlocks = Array.from(root.querySelectorAll("pre, code"))
    .map((el) => ({
      el,
      text: String(el.innerText || el.textContent || "").trim(),
    }))
    .filter((block) => block.text.length >= 12);

  if (!codeBlocks.length) return [];

  const selectedEl = container?.nodeType === Node.ELEMENT_NODE ? container : container?.parentElement;
  const selectedTop = selectedEl?.getBoundingClientRect?.().top ?? 0;

  return codeBlocks
    .map((block) => ({
      text: block.text.slice(0, 1800),
      distance: Math.abs((block.el.getBoundingClientRect?.().top ?? 0) - selectedTop),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((block) => block.text);
}

function getSelectionContext(container, selectedText) {
  const selectedBlock = container?.closest?.("p, li, blockquote, pre");
  const blocks = getReadableBlocks();
  const index = selectedBlock ? blocks.findIndex((block) => block.el === selectedBlock) : -1;
  const paragraph = compactText(selectedBlock?.innerText, 1800) || selectedText;

  return {
    previousParagraph: index > 0 ? blocks[index - 1].text : "",
    paragraph,
    nextParagraph: index >= 0 && index < blocks.length - 1 ? blocks[index + 1].text : "",
    codeContext: getNearbyCodeContext(container),
  };
}

function getSelectionDetails() {
  const selection = window.getSelection();
  const selectedText = compactText(selection?.toString(), FF.selectionMaxChars);
  if (!selection || selectedText.length < FF.selectionMinChars || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || rect.width === 0 || rect.height === 0) return null;

  const container =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const context = getSelectionContext(container, selectedText);

  return {
    selectedText,
    ...context,
    rect,
  };
}

function positionFloatingEl(el, rect, opts = {}) {
  const gap = opts.gap ?? 10;
  const viewportTop = window.scrollY;
  const viewportBottom = window.scrollY + document.documentElement.clientHeight;
  const viewportRight = window.scrollX + document.documentElement.clientWidth;
  const top = Math.max(
    viewportTop + 8,
    Math.min(window.scrollY + rect.top - el.offsetHeight - gap, viewportBottom - el.offsetHeight - 8),
  );
  const left = Math.max(
    window.scrollX + 8,
    Math.min(
      window.scrollX + rect.left + (rect.width - el.offsetWidth) / 2,
      viewportRight - el.offsetWidth - 8,
    ),
  );

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

function removeSelectionButton() {
  selectionButton?.remove();
  selectionButton = null;
}

function removePrimerPanel() {
  if (activePrimerListener) {
    chrome.runtime.onMessage.removeListener(activePrimerListener);
    activePrimerListener = null;
  }
  if (prereqTimeout) {
    window.clearTimeout(prereqTimeout);
    prereqTimeout = null;
  }
  primerPanel?.remove();
  primerPanel = null;
  activeRequestId = null;
  activePanelState = null;
  prereqRequestedForRequestId = null;
}

function makePanelDraggable(panel, handle) {
  let drag = null;

  handle.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    drag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    panel.classList.add("ff-primer-panel--dragging");
    event.preventDefault();
  });

  document.addEventListener("mousemove", (event) => {
    if (!drag) return;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - panel.offsetWidth - 8;
    const maxTop = window.scrollY + document.documentElement.clientHeight - panel.offsetHeight - 8;
    const left = Math.max(window.scrollX + 8, Math.min(window.scrollX + event.clientX - drag.offsetX, maxLeft));
    const top = Math.max(window.scrollY + 8, Math.min(window.scrollY + event.clientY - drag.offsetY, maxTop));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    panel.classList.remove("ff-primer-panel--dragging");
  });
}

function requestPrimer(details, status, body, spinner) {
  activeRequestId = crypto.randomUUID();
  prereqRequestedForRequestId = null;
  body.dataset.rawText = "";
  body.replaceChildren();
  activePanelState.prereqWrap.replaceChildren();
  spinner.style.display = "";
  status.textContent = "Generating...";

  chrome.runtime.sendMessage(
    {
      type: "GET_PRIMER",
      requestId: activeRequestId,
      selectedText: details.selectedText,
      title: document.title,
      url: location.href,
      previousParagraph: details.previousParagraph,
      paragraph: details.paragraph,
      nextParagraph: details.nextParagraph,
      codeContext: details.codeContext,
    },
    (resp) => {
      if (!resp?.ok) {
        status.textContent = resp?.error || "Failed to start primer.";
        spinner.style.display = "none";
      }
    },
  );
}

function requestPrerequisites(details) {
  if (!activePanelState || !activeRequestId) return;
  if (prereqRequestedForRequestId === activeRequestId) return;
  prereqRequestedForRequestId = activeRequestId;

  chrome.runtime.sendMessage(
    {
      type: "GET_PREREQUISITES",
      requestId: activeRequestId,
      selectedText: details.selectedText,
      title: document.title,
      url: location.href,
      previousParagraph: details.previousParagraph,
      paragraph: details.paragraph,
      nextParagraph: details.nextParagraph,
      codeContext: details.codeContext,
    },
    () => {
      // Never block prose on prerequisite fetching.
    },
  );
}

function renderBreadcrumb(pathEl, path) {
  pathEl.replaceChildren();
  pathEl.hidden = !Array.isArray(path) || path.length <= 1;
  if (pathEl.hidden) return;

  pathEl.append(createEl("span", "ff-breadcrumb__label", "Path:"));
  path.forEach((label, index) => {
    if (index > 0) pathEl.append(createEl("span", "ff-breadcrumb__sep", "/"));
    pathEl.append(createEl("span", "ff-breadcrumb__item", label));
  });
}

function renderPrerequisites(items) {
  const state = activePanelState;
  if (!state) return;
  state.prereqWrap.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) return;

  const title = createEl("div", "ff-prereq__title", "Builds on");
  const chips = createEl("div", "ff-prereq__chips");
  state.prereqWrap.append(title, chips);

  for (const item of items.slice(0, 4)) {
    const chip = createEl("button", "ff-prereq__chip");
    chip.type = "button";
    chip.title = item.oneLiner || item.concept;
    chip.append(createEl("span", "ff-prereq__chipText", item.concept));
    chips.append(chip);

    chip.addEventListener("click", () => {
      state.stack.push({
        details: state.currentDetails,
        path: [...state.path],
        rawText: state.body.dataset.rawText || "",
        prerequisites: state.prerequisites || [],
      });
      state.currentDetails = {
        ...state.currentDetails,
        selectedText: item.concept,
      };
      prereqRequestedForRequestId = null;
      state.path = [...state.path, item.concept];
      state.prerequisites = [];
      state.selected.textContent = item.concept;
      state.backBtn.hidden = state.stack.length === 0;
      renderBreadcrumb(state.breadcrumb, state.path);
      requestPrimer(state.currentDetails, state.status, state.body, state.spinner);
    });
  }
}

function renderPrerequisiteLoading() {
  const state = activePanelState;
  if (!state) return;
  state.prereqWrap.replaceChildren();
  const row = createEl("div", "ff-prereq__loading");
  row.append(createEl("span", "ff-prereq__spinner"));
  row.append(createEl("span", "", "Finding prerequisites..."));
  state.prereqWrap.append(row);

  if (prereqTimeout) window.clearTimeout(prereqTimeout);
  prereqTimeout = window.setTimeout(() => {
    if (!activePanelState || activePanelState !== state) return;
    state.prereqWrap.replaceChildren();
  }, 8000);
}

function restorePreviousPrimer() {
  const state = activePanelState;
  const previous = state?.stack.pop();
  if (!state || !previous) return;

  activeRequestId = null;
  prereqRequestedForRequestId = null;
  state.currentDetails = previous.details;
  state.path = previous.path;
  state.prerequisites = previous.prerequisites;
  state.selected.textContent = previous.details.selectedText;
  state.body.dataset.rawText = previous.rawText;
  renderPrimerText(state.body, previous.rawText);
  state.status.textContent = "Explanation";
  state.spinner.style.display = "none";
  state.backBtn.hidden = state.stack.length === 0;
  renderBreadcrumb(state.breadcrumb, state.path);
  renderPrerequisites(previous.prerequisites);
}

function showSelectionButton(details) {
  removeSelectionButton();

  selectionButton = createEl("button", "ff-selection-button", "Explain");
  selectionButton.type = "button";
  document.documentElement.append(selectionButton);
  positionFloatingEl(selectionButton, details.rect, { gap: 12 });

  selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
  selectionButton.addEventListener("click", () => {
    showPrimerPanel(details);
  });
}

async function showPrimerPanel(details) {
  removeSelectionButton();
  removePrimerPanel();

  primerPanel = createEl("div", "ff-primer-panel");
  const header = createEl("div", "ff-primer-panel__header");
  const backBtn = createEl("button", "ff-primer-panel__back", "←");
  backBtn.type = "button";
  backBtn.hidden = true;
  const title = createEl("div", "ff-primer-panel__title", "Primer");
  const closeBtn = createEl("button", "ff-primer-panel__close", "×");
  closeBtn.type = "button";
  header.append(backBtn, title, closeBtn);

  const breadcrumb = createEl("div", "ff-breadcrumb");
  const selected = createEl("div", "ff-primer-panel__selected", details.selectedText);
  const status = createEl("div", "ff-primer-panel__status", "Generating...");
  const body = createEl("div", "ff-primer-panel__body");
  const prereqWrap = createEl("div", "ff-prereq");
  const spinner = createEl("div", "ff-gap-banner__spinner");
  primerPanel.append(header, breadcrumb, selected, status, body, prereqWrap, spinner);
  document.documentElement.append(primerPanel);
  positionFloatingEl(primerPanel, details.rect, { preferBelow: true, gap: 14 });
  makePanelDraggable(primerPanel, header);

  closeBtn.addEventListener("click", removePrimerPanel);
  backBtn.addEventListener("click", restorePreviousPrimer);

  activePanelState = {
    stack: [],
    path: [details.selectedText],
    currentDetails: details,
    prerequisites: [],
    backBtn,
    breadcrumb,
    selected,
    status,
    body,
    prereqWrap,
    spinner,
  };
  renderBreadcrumb(breadcrumb, activePanelState.path);
  requestPrimer(details, status, body, spinner);

  if (activePrimerListener) {
    chrome.runtime.onMessage.removeListener(activePrimerListener);
  }

  activePrimerListener = (msg) => {
    if (!msg || msg.requestId !== activeRequestId) return;
    if (msg.type === "PRIMER_CHUNK") {
      body.dataset.rawText = `${body.dataset.rawText || ""}${msg.chunk}`;
      renderPrimerText(body, body.dataset.rawText);
      status.textContent = "Explanation";
      return;
    }
    if (msg.type === "PRIMER_DONE") {
      status.textContent = "Explanation";
      spinner.style.display = "none";
      return;
    }
    if (msg.type === "PRIMER_PROSE_DONE") {
      status.textContent = "Explanation";
      spinner.style.display = "none";
      renderPrerequisiteLoading();
      requestPrerequisites(activePanelState.currentDetails);
      return;
    }
    if (msg.type === "PRIMER_PREREQUISITES") {
      if (activePanelState) {
        activePanelState.prerequisites = msg.items || [];
      }
      if (prereqTimeout) {
        window.clearTimeout(prereqTimeout);
        prereqTimeout = null;
      }
      renderPrerequisites(msg.items || []);
      return;
    }
    if (msg.type === "PRIMER_DONE") {
      if (prereqTimeout) {
        window.clearTimeout(prereqTimeout);
        prereqTimeout = null;
      }
      return;
    }
    if (msg.type === "PRIMER_ERROR") {
      status.textContent = msg.error || "Primer failed.";
      spinner.style.display = "none";
      if (prereqTimeout) {
        window.clearTimeout(prereqTimeout);
        prereqTimeout = null;
      }
    }
  };

  chrome.runtime.onMessage.addListener(activePrimerListener);
}

function handleSelectionChange() {
  window.setTimeout(() => {
    const details = getSelectionDetails();
    if (!details) {
      removeSelectionButton();
      return;
    }
    showSelectionButton(details);
  }, 0);
}

document.addEventListener("selectionchange", handleSelectionChange);
document.addEventListener("scroll", removeSelectionButton, { passive: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    removeSelectionButton();
    removePrimerPanel();
  }
});
document.addEventListener("mousedown", (event) => {
  if (selectionButton?.contains(event.target) || primerPanel?.contains(event.target)) return;
  if (!window.getSelection()?.toString()) removePrimerPanel();
});
