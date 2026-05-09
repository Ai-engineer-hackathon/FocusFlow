const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const analyze = require("../api/analyze");
const primer = require("../api/primer");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function attachJson(res) {
  res.json = (value) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
  };
}

function route(req, res) {
  attachJson(res);

  if (req.url === "/api/analyze") {
    analyze(req, res);
    return;
  }

  if (req.url === "/api/primer") {
    primer(req, res);
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "not_found" }));
}

loadEnv();

http.createServer(route).listen(PORT, () => {
  console.log(`FocusFlow backend listening at http://localhost:${PORT}`);
});
