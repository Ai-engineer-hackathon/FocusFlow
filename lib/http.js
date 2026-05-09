const ALLOWED_METHODS = "POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
}

function handleOptions(req, res) {
  if (req.method !== "OPTIONS") return false;
  setCors(res);
  res.statusCode = 204;
  res.end();
  return true;
}

function requirePost(req, res) {
  if (req.method === "POST") return true;
  setCors(res);
  res.statusCode = 405;
  res.setHeader("Allow", ALLOWED_METHODS);
  res.json({ error: "method_not_allowed" });
  return false;
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}

module.exports = {
  handleOptions,
  readJson,
  requirePost,
  sendError,
  sendJson,
  setCors
};
