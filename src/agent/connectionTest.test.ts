import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { describeConnectionError, keyHint, scrubKeys, suggestModel } from "./connectionTest.ts";

const apiErr = (status: number, message: string): InstanceType<typeof Anthropic.APIError> =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

describe("connection test helpers", () => {
  test("scrubKeys keeps only the last 4 characters of any key", () => {
    const key = "sk-ant-test-abcdefghijklmnop1234";
    assert.equal(scrubKeys(`bad key ${key}.`), "bad key sk-ant-…1234.");
    assert.equal(scrubKeys("nothing here"), "nothing here");
    assert.equal(keyHint(key), "…1234");
    assert.equal(keyHint(""), null);
    assert.equal(keyHint(undefined), null);
  });

  test("SDK errors map to technician-facing codes", () => {
    assert.equal(describeConnectionError(apiErr(401, "invalid x-api-key"), "m").code, "invalid_key");
    assert.equal(describeConnectionError(apiErr(403, "no"), "m").code, "permission");
    assert.equal(describeConnectionError(apiErr(404, "model: nope"), "m").code, "model_unavailable");
    assert.equal(describeConnectionError(apiErr(400, "Your credit balance is too low to access the Anthropic API."), "m").code, "billing");
    assert.equal(describeConnectionError(apiErr(400, "something else"), "m").code, "unknown");
    assert.equal(describeConnectionError(apiErr(429, "slow down"), "m").code, "rate_limited");
    assert.equal(describeConnectionError(apiErr(529, "Overloaded"), "m").code, "overloaded");
    assert.equal(describeConnectionError(apiErr(500, "oops"), "m").code, "overloaded");
    assert.equal(describeConnectionError(new Anthropic.APIConnectionError({ message: "ECONNREFUSED" }), "m").code, "network");
    assert.equal(describeConnectionError(new Anthropic.APIConnectionTimeoutError(), "m").code, "network");
    const u = describeConnectionError(new Error("boom sk-ant-test-zzzzzzzzzzzzzz9876"), "m");
    assert.equal(u.code, "unknown");
    assert.ok(!u.message.includes("zzzz"), "key scrubbed from the message");
  });

  test("suggestModel prefers a catalog id the key can see", () => {
    assert.equal(suggestModel(["claude-x-1", "claude-opus-5"]), "claude-opus-5");
    assert.equal(suggestModel(["claude-x-1"]), "claude-x-1");
    assert.equal(suggestModel([]), undefined);
  });
});
