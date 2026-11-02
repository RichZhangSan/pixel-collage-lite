import test from "node:test";
import assert from "node:assert/strict";
import { getPredictionResult, startPrediction } from "../lib/replicate.js";

test("starts a prediction without waiting for its completion", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.REPLICATE_API_TOKEN;
  process.env.REPLICATE_API_TOKEN = "test-token";
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: "prediction-123", status: "starting" }), { status: 201 });
  };

  try {
    const result = await startPrediction("data:image/jpeg;base64,Zm9v", 5);
    assert.deepEqual(result, { id: "prediction-123", status: "starting" });
    assert.equal(request.url, "https://api.replicate.com/v1/predictions");
    assert.equal(request.init.headers.Authorization, "Token test-token");
    assert.equal(request.init.headers.Prefer, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalToken;
  }
});

test("returns a pending prediction state without downloading outputs", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.REPLICATE_API_TOKEN;
  process.env.REPLICATE_API_TOKEN = "test-token";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "prediction-123", status: "processing" }), { status: 200 });
  };

  try {
    const result = await getPredictionResult("prediction-123");
    assert.equal(result.status, "processing");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalToken;
  }
});
