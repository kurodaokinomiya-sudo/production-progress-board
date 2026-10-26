import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [learning, ai] = await Promise.all([
  readFile(new URL("../src/intake-learning.js", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/AiImport.gs", import.meta.url), "utf8"),
]);
function harness() {
  const context = vm.createContext({ Date, Number, Object, String, RegExp, Math, JSON });
  vm.runInContext(`${learning}\n${ai}`, context);
  const parsed = { customer: "松井", product: "慈大式 彫骨器(強弯・上向)", productCode: "CK021", quantity: 123, dueDate: "2099-12-31", note: "ORDER-PRIVATE-NOTE", serialNo: "ORDER-PRIVATE-SERIAL" };
  const lesson = context.IntakeLearning.learn({ rules: [], parsed, order: { ...parsed, specLength: "18cm", note: "ORDER-PRIVATE-NOTE / COMMON-NOTE" }, intakeId: "lesson-1", includeNote: true });
  let sent;
  context.aiCustomerRulesSnapshot_ = () => context.defaultCustomerRules_();
  context.readIntakeLearningRules_ = () => lesson.rules;
  context.sendAiRequest_ = (request) => { sent = request; return { marker: "provider-response" }; };
  context.validateAiImportResponse_ = (response) => { assert.equal(response.marker, "provider-response"); return [{ parsed: { quantity: 3 } }]; };
  return { context, get sent() { return sent; } };
}

test("Geminiへ同じ文章に該当する製品の修正例だけを渡し、過去の注文値や備考は渡さない", () => {
  const h = harness();
  const result = h.context.runAiImport_({ text: "商品名:慈大式 彫骨器(強弯・上向) CK021 数量:3丁 (2027/1/15) 松井" });
  assert.equal(result[0].parsed.quantity, 3);
  const instruction = h.sent.systemInstruction.parts[0].text;
  assert.match(instruction, /18cm/);
  assert.match(instruction, /CK021/);
  assert.doesNotMatch(instruction, /2099-12-31|ORDER-PRIVATE-NOTE|ORDER-PRIVATE-SERIAL|COMMON-NOTE|"quantity":123/);
  assert.match(h.sent.contents[0].parts.at(-1).text, /2027\/1\/15/);
});

test("異なる得意先・製品の文章には保存した修正例を送らない", () => {
  const h = harness();
  for (const text of ["得意先:別商事 商品名:慈大式 彫骨器(強弯・上向) CK021", "得意先:松井 商品名:別製品 ZY123"]) {
    h.context.runAiImport_({ text });
    assert.doesNotMatch(h.sent.systemInstruction.parts[0].text, /18cm/);
  }
});
