import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalOrderText } from "../tools/local-text-parser.mjs";

test("ローカルのAI本文取込は保存済み得意先ルールを転送する", async () => {
  const rules = { ownCompanyNames: ["検証用製作所"], aliases: [{ issuer: "検証用発注会社", customer: "検証得意先" }] };
  let sent;
  await parseLocalOrderText({ name: "注文", text: "注文本文", engine: "ai", customerRules: rules }, {
    aiParser: async (input) => { sent = input; return { results: [{ parsed: { customer: "検証得意先", product: "鉗子", quantity: 1 } }] }; },
  });
  assert.deepEqual(sent.customerRules, rules);
});

test("ローカルAIも同じルールを読取指示と回答補正に使い、自社なら空欄で確認を促す", async () => {
  const names = ["PROGRESS_GEMINI_API_KEY", "PROGRESS_AI_FREE_TIER_CONFIRMED", "PROGRESS_AI_DAILY_LIMIT"];
  const old = names.map((name) => process.env[name]);
  const rules = { ownCompanyNames: ["検証用製作所"], aliases: [{ issuer: "検証用発注会社", customer: "検証得意先" }] };
  try {
    process.env.PROGRESS_GEMINI_API_KEY = "test-only";
    process.env.PROGRESS_AI_FREE_TIER_CONFIRMED = "true";
    process.env.PROGRESS_AI_DAILY_LIMIT = "10";
    for (const customer of ["検証用発注会社", "検証用製作所"]) {
      const api = await import(`../tools/local-ai-import.mjs?rules-test=${encodeURIComponent(customer)}`);
      let sent;
      const result = await api.parseLocalOrderAi({ text: "注文本文", customerRules: rules }, { transport: async (url, options) => {
        sent = JSON.parse(options.body);
        return { ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
          complete: true, documentItemCount: 1, printedQuantityTotal: null, warnings: [], items: [{
            customer, product: "鉗子", dueDate: "2026-11-30", quantity: 2, serialNo: "QA-1", specLength: "", specShape: "", bladeWidth: "", note: "", sourceRow: "1", sourcePage: 1, sourceDocument: 0, evidence: "品名 鉗子 数量2", warnings: [],
          }],
        }) }] } }] }) };
      } });
      assert.match(sent.systemInstruction.parts[0].text, /検証用発注会社/);
      assert.equal(sent.generationConfig.responseJsonSchema, undefined);
      assert.equal(result.results[0].parsed.customer, customer === "検証用製作所" ? "" : "検証得意先");
      if (customer === "検証用製作所") assert.ok(result.results[0].parsed._ai.warnings.some((warning) => /自社|御社|宛先/.test(warning)));
    }
  } finally { names.forEach((name, i) => old[i] === undefined ? delete process.env[name] : process.env[name] = old[i]); }
});
