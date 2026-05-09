async function load() {
  const { ffApiBase = "" } = await chrome.storage.local.get(["ffApiBase"]);

  document.getElementById("apiBase").value = ffApiBase;
  document.getElementById("status").textContent = "Ready.";
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

document.getElementById("saveApi").addEventListener("click", saveApiBase);
load();
