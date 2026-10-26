import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseLocalOrderText } from "../tools/local-text-parser.mjs";

const source = await readFile(new URL("../apps-script/Parser.gs", import.meta.url), "utf8");
const context = vm.createContext({ Date, Number, Object, String, RegExp, Math, JSON });
vm.runInContext(source, context);
const example = "商品名：慈大式　彫骨器（強弯・上向）　CK021 　数　量：１０丁 （2026/ 8/26） 松井";

test("実例の行内注文はAIなしで品名・数量・括弧内納期・末尾得意先を読み取る", async () => {
  for (const text of [example, example.replace(" 　数　量", "\n数　量")]) {
    const result = await parseLocalOrderText({ text, engine: "legacy" });
    assert.equal(result.results.length, 1);
    const parsed = result.results[0].parsed;
    assert.equal(parsed.customer, "松井");
    assert.equal(parsed.dueDate, "2026-08-26");
    assert.equal(parsed.quantity, 10);
    assert.equal(parsed.productCode, "CK021");
    assert.equal(parsed.product, "慈大式 彫骨器(強弯・上向)");
    assert.equal(parsed.specShape, "強弯・上向");
    assert.match(parsed._parseWarnings.join(" "), /原文と確認/);
  }
});

test("同じ製品でも次の注文の日付・得意先・数量を原文から読み直す", () => {
  const parsed = context.parseOrderText_(example.replace("１０丁", "３丁").replace("2026/ 8/26", "2027/ 1/15").replace("松井", "別商事"), {}).parsed;
  assert.equal(parsed.customer, "別商事");
  assert.equal(parsed.dueDate, "2027-01-15");
  assert.equal(parsed.quantity, 3);
});

test("明記された納期・得意先を優先し、無関係な括弧日付や担当名を推測しない", () => {
  const explicit = context.parseOrderText_("得意先: 明記商事\n納期: 2026/12/10\n" + example, {}).parsed;
  assert.equal(explicit.customer, "明記商事");
  assert.equal(explicit.dueDate, "2026-12-10");
  assert.equal(explicit._parseWarnings, undefined);
  for (const suffix of ["備考: (2026/8/26) 松井", "数量:10丁 (2026/8/26) 担当:松井", "数量:10丁 (2026/2/30) 松井", "数量:10丁 (2026/8/26) 受注担当 松井"]) {
    const parsed = context.parseOrderText_("商品名: 慈大式 彫骨器 CK021\n" + suffix, {}).parsed;
    assert.equal(parsed.customer, "", suffix);
    assert.equal(parsed.dueDate, "", suffix);
  }
});

test("行内に続くラベルを品名に混ぜず、空白付きラベルと型の向きを保持する", () => {
  const parsed = context.parseOrderText_("得 意 先：松井 商品名：慈大式 彫骨器(弱湾・下向) CK022 数 量：2丁 納 期：2026/11/30", {}).parsed;
  assert.equal(parsed.customer, "松井");
  assert.equal(parsed.dueDate, "2026-11-30");
  assert.equal(parsed.product, "慈大式 彫骨器(弱湾・下向)");
  assert.equal(parsed.productCode, "CK022");
  assert.equal(parsed.specShape, "弱弯・下向");
  assert.equal(parsed.quantity, 2);
});
