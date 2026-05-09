const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.5";

function getModel() {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

function getApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return key;
}

function extractText(data) {
  if (typeof data.output_text === "string") return data.output_text;

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("");
}

async function createResponse(body, { stream = false } = {}) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: getModel(),
      ...body,
      stream
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
  }

  return response;
}

async function createJsonResponse({ system, user }) {
  const response = await createResponse({
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    text: {
      format: {
        type: "json_object"
      },
      verbosity: "low"
    }
  });

  const data = await response.json();
  const text = extractText(data);
  return JSON.parse(text);
}

function createStreamingResponse({ system, user }) {
  return createResponse(
    {
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      text: {
        verbosity: "low"
      }
    },
    { stream: true }
  );
}

module.exports = {
  createJsonResponse,
  createStreamingResponse,
  extractText,
  getModel
};
