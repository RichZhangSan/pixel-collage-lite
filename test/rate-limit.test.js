import test from "node:test";
import assert from "node:assert/strict";
import { allowPrediction, clientKey, resetRateLimitsForTests } from "../lib/rate-limit.js";

test("limits prediction starts per client within a fixed window", () => {
  resetRateLimitsForTests();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(allowPrediction("client-a", 1_000), true);
  }
  assert.equal(allowPrediction("client-a", 1_000), false);
  assert.equal(allowPrediction("client-a", 61_000), true);
  assert.equal(allowPrediction("client-b", 1_000), true);
  resetRateLimitsForTests();
});

test("uses the first forwarded address when present", () => {
  assert.equal(clientKey({ ip: "203.0.113.1", headers: {} }), "203.0.113.1");
  assert.equal(
    clientKey({ headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.2" }, socket: {} }),
    "203.0.113.8"
  );
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: "::1" } }), "::1");
});
