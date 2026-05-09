async function load() {
  const { ffApiBase = "", ffKnownConcepts = {} } = await chrome.storage.local.get([
    "ffApiBase",
    "ffKnownConcepts",
  ]);

  document.getElementById("apiBase").value = ffApiBase;
  document.getElementById("status").textContent = `Known concepts: ${Object.keys(ffKnownConcepts).length}`;
}

async function saveApiBase() {
  const apiBase = document.getElementById("apiBase").value.trim();
  if (!apiBase) {
    document.getElementById("status").textContent = "Enter a backend URL.";
    return;
  }

  await chrome.storage.local.set({ ffApiBase: apiBase });
  chrome.runtime.sendMessage({ type: "SET_API_BASE", apiBase }, (resp) => {
    document.getElementById("status").textContent = resp?.ok ? "Saved." : `Error: ${resp?.error || "unknown"}`;
  });
}

async function clearKnown() {
  await chrome.storage.local.set({ ffKnownConcepts: {} });
  document.getElementById("status").textContent = "Cleared known concepts.";
}

document.getElementById("saveApi").addEventListener("click", saveApiBase);
document.getElementById("clearKnown").addEventListener("click", clearKnown);
load();
