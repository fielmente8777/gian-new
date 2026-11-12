import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAiAdminApiError, OpenAiAdminClient } from "../openai-admin.client.js";

const page = (results: Record<string, unknown>[], more: string | null, start = 1) => ({
  data: [{ start_time: start, end_time: start + 86_400, results }],
  has_more: more !== null,
  next_page: more,
});
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const noSleep = async () => {};

/** The nth element, failing the test instead of returning undefined. */
const at = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  assert.ok(value !== undefined, `expected an element at ${index}`);
  return value;
};

describe("OpenAiAdminClient", () => {
  it("follows every page and normalizes rows", async () => {
    const urls: URL[] = [];
    const pages = [
      page([{ line_item: "gpt-5-mini, input", project_id: "p1", amount: { value: 2.5, currency: "usd" } }], "cursor-2"),
      page([{ line_item: "embeddings", amount: { value: 1, currency: "usd" } }], null, 86_401),
    ];
    const client = new OpenAiAdminClient(
      "test-key",
      async (input) => {
        urls.push(new URL(String(input)));
        return ok(pages.shift());
      },
      noSleep,
    );

    const rows = await client.costs(1, 200_000);

    assert.equal(rows.length, 2);
    assert.equal(at(rows, 0).projectId, "p1");
    assert.equal(at(rows, 0).amountUsd, 2.5);
    assert.equal(at(rows, 1).lineItem, "embeddings");
    assert.equal(at(rows, 1).projectId, null);
    assert.equal(urls.length, 2);
    assert.equal(at(urls, 0).searchParams.get("page"), null);
    assert.equal(at(urls, 1).searchParams.get("page"), "cursor-2");
    assert.equal(at(urls, 0).searchParams.get("limit"), "180");
    assert.deepEqual(at(urls, 0).searchParams.getAll("group_by"), ["line_item", "project_id"]);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const answers = [
      new Response("", { status: 429, headers: { "retry-after": "1" } }),
      new Response("", { status: 502 }),
      ok(page([{ line_item: "x", amount: { value: 1, currency: "usd" } }], null)),
    ];
    const waits: number[] = [];
    const client = new OpenAiAdminClient(
      "k",
      async () => answers.shift() ?? new Response("", { status: 500 }),
      async (ms) => {
        waits.push(ms);
      },
    );
    const rows = await client.costs(0, 1);
    assert.equal(rows.length, 1);
    assert.deepEqual(waits, [1000, 500]);
  });

  it("gives up after three failures with OpenAI's status", async () => {
    let calls = 0;
    const client = new OpenAiAdminClient(
      "k",
      async () => {
        calls++;
        return new Response("", { status: 503 });
      },
      noSleep,
    );
    await assert.rejects(client.costs(0, 1), (e) => e instanceof OpenAiAdminApiError && e.upstreamStatus === 503);
    assert.equal(calls, 3);
  });

  it("does not retry a rejected key, and never puts the key in the error", async () => {
    let calls = 0;
    const client = new OpenAiAdminClient(
      "sk-admin-secret",
      async () => {
        calls++;
        return new Response('{"error":"sk-admin-secret is invalid"}', { status: 401 });
      },
      noSleep,
    );
    await assert.rejects(client.costs(0, 1), (e) => {
      assert.ok(e instanceof OpenAiAdminApiError);
      assert.equal(e.code, "OPENAI_ADMIN_KEY_REJECTED");
      assert.ok(!e.message.includes("sk-admin"));
      return true;
    });
    assert.equal(calls, 1);
  });

  it("refuses a non-USD amount instead of dropping it", async () => {
    const client = new OpenAiAdminClient(
      "k",
      async () => ok(page([{ line_item: "x", amount: { value: 5, currency: "eur" } }], null)),
      noSleep,
    );
    await assert.rejects(
      client.costs(0, 1),
      (e) => e instanceof OpenAiAdminApiError && e.code === "OPENAI_COST_CURRENCY_UNSUPPORTED",
    );
  });

  it("fails when OpenAI says there is more but gives no cursor", async () => {
    const client = new OpenAiAdminClient("k", async () => ok({ data: [], has_more: true, next_page: null }), noSleep);
    await assert.rejects(client.costs(0, 1), (e) => e instanceof OpenAiAdminApiError);
  });
});
