import assert from "node:assert/strict";
import test from "node:test";

test("ローカル診断も固定文・本番回答形式を使用し、通常取込と上限を共有", async () => {
  const names = ["PROGRESS_GEMINI_API_KEY", "PROGRESS_AI_FREE_TIER_CONFIRMED", "PROGRESS_AI_DAILY_LIMIT"];
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.PROGRESS_GEMINI_API_KEY = "local-test-only-key";
    process.env.PROGRESS_AI_FREE_TIER_CONFIRMED = "true";
    process.env.PROGRESS_AI_DAILY_LIMIT = "1";
    for (const step of ["connection", "format"]) {
      const api = await import(`../tools/local-ai-import.mjs?diagnostic-test=${step}`);
      const calls = [];
      const transport = async (url, options) => {
        calls.push({ url, request: JSON.parse(options.body) });
        return { ok: true, json: async () => ({}) };
      };
      const result = await api.diagnoseLocalAi({ step, text: "PRIVATE", base64: "PRIVATE" }, { transport });
      assert.equal(result.accepted, true);
      assert.doesNotMatch(JSON.stringify(calls), /PRIVATE/);
      if (step === "connection") assert.deepEqual(Object.keys(calls[0].request), ["contents"]);
      else {
        assert.equal(calls[0].request.generationConfig.responseMimeType, "application/json");
        assert.equal(calls[0].request.generationConfig.responseJsonSchema, undefined);
        assert.match(calls[0].request.systemInstruction.parts[0].text, /出力構造/);
        assert.equal(result.outputValid, false);
      }
      await assert.rejects(() => api.parseLocalOrderAi({ text: "test" }, { transport }), /日次上限/);
      assert.equal(calls.length, 1);
    }
  } finally {
    names.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]);
  }
});
