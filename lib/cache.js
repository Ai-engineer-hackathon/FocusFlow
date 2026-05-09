const crypto = require("node:crypto");

const analysisCache = new Map();
const MAX_CACHE_ENTRIES = 100;

function hashInput(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
}

function getAnalysisCache(key) {
  return analysisCache.get(key);
}

function setAnalysisCache(key, value) {
  if (analysisCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = analysisCache.keys().next().value;
    analysisCache.delete(firstKey);
  }

  analysisCache.set(key, {
    ...value,
    cached_at: new Date().toISOString()
  });
}

module.exports = {
  getAnalysisCache,
  hashInput,
  setAnalysisCache
};
