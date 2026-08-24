import assert from "node:assert/strict";
import test from "node:test";

import {
  ResearchResponseCache,
  ResearchSourceClient,
} from "./research-source-adapter.ts";

const policy = {
  timeoutMs: 100,
  maxAttempts: 3,
  retryDelayMs: 10,
  minIntervalMs: 0,
  cacheTtlMs: 100,
};

test("caches successful source responses until their TTL expires", async () => {
  let now = 0;
  let calls = 0;
  const client = new ResearchSourceClient({
    now: () => now,
    policies: { Crossref: policy },
  });

  const request = async () => {
    calls += 1;
    return `body-${calls}`;
  };
  assert.equal(await client.fetch("Crossref", "same-query", request), "body-1");
  assert.equal(await client.fetch("Crossref", "same-query", request), "body-1");
  now = 101;
  assert.equal(await client.fetch("Crossref", "same-query", request), "body-2");
  assert.equal(calls, 2);
});

test("retries transient source failures with exponential backoff", async () => {
  const sleeps = [];
  let calls = 0;
  const client = new ResearchSourceClient({
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    policies: { Crossref: policy },
  });

  const result = await client.fetch("Crossref", "retry-query", async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error("503 Service Unavailable");
    }
    return "recovered";
  });

  assert.equal(result, "recovered");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("does not retry malformed responses", async () => {
  let calls = 0;
  const client = new ResearchSourceClient({
    policies: { Crossref: policy },
  });

  await assert.rejects(
    client.fetch("Crossref", "invalid-response", async () => {
      calls += 1;
      throw new SyntaxError("Unexpected JSON response");
    }),
    /Unexpected JSON response/,
  );
  assert.equal(calls, 1);
});

test("reserves per-source request slots for concurrent lookups", async () => {
  const sleeps = [];
  const client = new ResearchSourceClient({
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    policies: {
      Crossref: { ...policy, minIntervalMs: 25 },
    },
  });

  await Promise.all([
    client.fetch("Crossref", "query-a", async () => "a"),
    client.fetch("Crossref", "query-b", async () => "b"),
  ]);
  assert.deepEqual(sleeps, [25]);
});

test("deduplicates concurrent requests for the same cache key", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = new ResearchSourceClient({
    policies: { Crossref: policy },
  });
  const request = async () => {
    calls += 1;
    await gate;
    return "shared";
  };

  const first = client.fetch("Crossref", "shared-query", request);
  const second = client.fetch("Crossref", "shared-query", request);
  assert.equal(calls, 0);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["shared", "shared"]);
  assert.equal(calls, 1);
});

test("evicts oversized and least-recently-used cache entries", () => {
  const cache = new ResearchResponseCache({ maxEntries: 2, maxBytes: 16 });
  cache.set("a", "1234", 1_000);
  cache.set("b", "5678", 1_000);
  assert.equal(cache.get("a"), "1234");
  cache.set("c", "90ab", 1_000);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "1234");
  assert.equal(cache.get("c"), "90ab");
  cache.set("too-large", "123456789", 1_000);
  assert.equal(cache.get("too-large"), undefined);
});
