import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseLocalOrderText } from "../tools/local-text-parser.mjs";
import { parseRememberedOrderAutomatically } from "../tools/local-auto-import.mjs";
import { makeOrderPdf } from "./fixtures/order-pdf.mjs";

const learningSource = await readFile(new URL("../src/intake-learning.js", import.meta.url), "utf8");
const context = vm.createContext({ Date, Math, Number, Object, String, RegExp, JSON, Array });
vm.runInContext(learningSource, context);

const sourceProduct = {
  customer: "甲医科", product: "ケリソン18cm上向3mm", productCode: "K-03-L",
  category: "", specLength: "18cm", specShape: "上向", bladeWidth: "3mm",
};
const learned = context.IntakeLearning.learn({
  rules: [], parsed: sourceProduct,
  order: { ...sourceProduct, product: "ケリソンパンチ18cm上向3mm", category: "ケリソンパンチ" },
  intakeId: "confirmed-1", updatedAt: "2026-11-02T00:00:00.000Z",
}).rule;

const recalledText = [
  "得意先: 甲医科",
  "品名: ケリソン18cm上向3mm",
  "数量: 7",
  "納期: 2026-11-30",
].join("\n");

test("auto intake uses a confirmed exact product memory without invoking AI", async () => {
  let calls = 0;
  const result = await parseLocalOrderText({
    name: "再注文", text: recalledText, engine: "auto", learningRules: [learned],
  }, { aiParser: async () => { calls += 1; throw new Error("AI must not run"); } });

  assert.equal(calls, 0);
  assert.equal(result.engineVersion, 2);
  assert.equal(result.engine, "memory");
  assert.equal(result.text, recalledText);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].parsed.product, "ケリソンパンチ18cm上向3mm");
  assert.equal(result.results[0].parsed.category, "ケリソンパンチ");
  assert.equal(result.results[0].parsed.quantity, 7);
  assert.equal(result.results[0].parsed.dueDate, "2026-11-30");
  assert.deepEqual(result.results[0].parsed._memory, { version: 1, key: learned.key, document: 0, page: 1, row: "1" });
});

test("auto intake falls back once with the original full text for unknown products", async () => {
  const calls = [];
  const fallback = { results: [{ parsed: { customer: "別の得意先", product: "未知製品", quantity: 2 }, confidence: 0 }] };
  const result = await parseLocalOrderText({
    name: "未登録", text: "得意先: 別の得意先\n品名: 未知製品\n数量: 2\n納期: 2026-12-01",
    engine: "auto", learningRules: [learned],
  }, { aiParser: async (input) => { calls.push(input); return fallback; } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "未登録");
  assert.equal(calls[0].text, result.text);
  assert.equal(result.engine, "ai");
  assert.deepEqual(result.results, fallback.results);
});

test("auto intake with no rules falls back without requiring a memory parser match", async () => {
  const calls = [];
  const result = await parseLocalOrderText({ name: "無学習", text: recalledText, engine: "auto" }, {
    aiParser: async (input) => { calls.push(input); return { results: [{ parsed: { quantity: 7 } }] }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.engine, "ai");
});

test("auto paste drops attachments and retains the original body after an AI fallback", async () => {
  const calls = [];
  const result = await parseLocalOrderText({
    text: recalledText, engine: "auto", files: [{ base64: "MUST_IGNORE" }], base64: "MUST_IGNORE",
  }, { aiParser: async input => {
    calls.push(input);
    return { text: "generic AI preview", results: [{ parsed: { quantity: 7 } }] };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].files, undefined);
  assert.equal(calls[0].base64, undefined);
  assert.equal(result.text, recalledText);
});

test("auto PDF uses extracted text for memory, and the original file alone for unresolved AI fallback", async () => {
  const file = {
    name: "synthetic.pdf", mimeType: "application/pdf", learningRules: [learned],
    base64: makeOrderPdf([{ lines: recalledText.split("\n") }]).toString("base64"),
  };
  const calls = [];
  const aiParser = async input => { calls.push(input); return { results: [{ parsed: { quantity: 2 } }] }; };
  const memory = await parseRememberedOrderAutomatically(file, { aiParser });
  assert.equal(memory.engine, "memory");
  assert.equal(calls.length, 0);
  const unknownFile = { ...file, base64: makeOrderPdf([{ lines: ["unknown format"] }]).toString("base64") };
  const unknown = await parseRememberedOrderAutomatically(unknownFile, { aiParser });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].base64, unknownFile.base64);
  assert.equal(calls[0].text, undefined);
  assert.equal(unknown.text, "unknown format");
  await parseRememberedOrderAutomatically({ ...file, mimeType: "image/jpeg" }, { aiParser });
  assert.equal(calls.length, 2, "local images cannot use client-supplied text instead of OCR");
});

test("auto PDF falls back with every original page if any page cannot be read from text alone", async () => {
  for (const pages of [
    [{ lines: recalledText.split("\n") }, { image: true }],
    [{ lines: recalledText.split("\n"), image: true }],
    [{ lines: recalledText.split("\n"), outlines: true }],
    [{ lines: recalledText.split("\n") }, {}],
  ]) {
    const base64 = makeOrderPdf(pages).toString("base64");
    const calls = [];
    const result = await parseRememberedOrderAutomatically({
      name: "混在する注文.pdf", mimeType: "application/pdf", base64, learningRules: [learned],
      text: recalledText, pdfText: { pageCount: 1, pages: [recalledText] },
    }, { aiParser: async input => {
      calls.push(input);
      return { results: [{ parsed: { quantity: 7 } }, { parsed: { quantity: 9 } }] };
    } });
    assert.equal(result.engine, "ai");
    assert.equal(result.results.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].base64, base64);
    assert.equal(calls[0].text, undefined);
    assert.equal(calls[0].pdfText, undefined);
    assert.match(result.text, /原本を別途開き/);
  }
});
