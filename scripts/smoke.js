const analyze = require("../api/analyze");
const primer = require("../api/primer");

function makeReq(body) {
  return {
    method: "POST",
    body
  };
}

function makeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: "",
    events: [],
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      this.headersSent = true;
    },
    end(value = "") {
      this.body += value;
      this.ended = true;
    },
    write(value) {
      this.body += value;
      this.headersSent = true;
    },
    json(value) {
      this.setHeader("content-type", "application/json");
      this.end(JSON.stringify(value));
    }
  };
}

async function main() {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const analyzeRes = makeRes();
  await analyze(
    makeReq({
      paragraphs: [
        "React Hooks let function components use state and effects in a direct way.",
        "The useState Hook returns a current value and a setter that asks React to render again.",
        "The useEffect Hook runs after React commits updates to the screen.",
        "Because the callback inside useEffect forms a closure over state at render time, every referenced value belongs in the dependency array."
      ]
    }),
    analyzeRes
  );

  if (analyzeRes.statusCode !== 500 || !analyzeRes.body.includes("OPENAI_API_KEY")) {
    throw new Error("Expected missing API key error from analyze endpoint.");
  }

  const primerRes = makeRes();
  await primer(makeReq({ concept: "closures" }), primerRes);

  if (primerRes.statusCode !== 400 || !primerRes.body.includes("missing_input")) {
    throw new Error("Expected validation error from primer endpoint.");
  }

  if (oldKey) process.env.OPENAI_API_KEY = oldKey;
  console.log("Smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
