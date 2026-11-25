import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all([
  "../src/intake-learning.js", "../apps-script/Parser.gs", "../apps-script/Import.gs", "../apps-script/AiImport.gs",
].map(path => readFile(new URL(path, import.meta.url), "utf8")));
const tcText = (await readFile(new URL("./fixtures/tanaka-tc-purchase-order.txt", import.meta.url), "utf8")).replace(/\r\n?/g, "\n");
const text = "得意先: 田中\n品名: ケリソン18cm上向3mm\n数量: 10\n納期: 2026-11-30\n連番: CURRENT-1";
const copy = value => JSON.parse(JSON.stringify(value));

function harness(body = text) {
  const c = vm.createContext({ Date, JSON, Math, Number, Object, String, RegExp, Array });
  vm.runInContext(sources.join("\n"), c);
  const saved = [], calls = { ai: 0, ocr: 0, editor: 0 }, rules = [];
  Object.assign(c, {
    requireEditorAccess_: () => { calls.editor++; }, ensureSystem_: () => {},
    readIntakeLearningRules_: () => rules,
    withDocumentLock_: fn => fn(), appendLog_: () => {},
    sanitizeText_: (value, maximum) => String(value || "").trim().slice(0, maximum),
    appendIntake_: item => { saved.push(copy(item)); return item; },
    Utilities: { getUuid: () => "synthetic-batch", base64Decode: () => [0], newBlob: () => ({ synthetic: true }) },
    ocrBlob_: () => { calls.ocr++; return body; },
    runAiImport_: input => { calls.ai++; calls.aiInput = copy(input); return [{ parsed: { product: "AI結果", _ai: { document: 1, page: 1, row: "1", evidence: "合成応答", warnings: [] } } }]; },
  });
  const remember = (value, order = value, id = "synthetic-confirmed") => {
    const result = c.IntakeLearning.remember({ rules, parsed: value, order, intakeId: id });
    rules.splice(0, rules.length, ...result.rules);
    return result;
  };
  const parse = value => c.parsePastedOrderItems_(value, {});
  const recall = value => c.parseRememberedOrderItems_(value, {}, rules, c.defaultCustomerRules_());
  return { c, rules, saved, calls, remember, parse, recall };
}

test("unchanged confirmed products are remembered with only stable product data", () => {
  const h = harness(), parsed = h.parse(text)[0].parsed;
  const result = h.remember({ ...parsed, note: "ORDER-PRIVATE-NOTE", externalOrderNo: "PRIVATE-ORDER" });
  assert.equal(result.changed, true);
  assert.equal(result.rule.confirmed, true);
  assert.deepEqual([...result.rule.fields], []);
  assert.equal(h.rules.length, 1);
  assert.doesNotMatch(JSON.stringify(h.rules), /quantity|dueDate|serialNo|externalOrderNo|CURRENT-1|PRIVATE|2026-11-30/);
  const retry = h.remember(parsed);
  assert.equal(retry.changed, false);
  assert.equal(h.rules.length, 1);
});

test("memory fills product specs and uses this order's quantities, dates, serials and notes", () => {
  const h = harness(), parsed = h.parse(text)[0].parsed;
  h.remember(parsed, { ...parsed, productCode: "KNOWN-3", note: "PRIVATE-NOTE" });
  const next = text.replace("数量: 10", "数量: 37").replace("2026-11-30", "2027-02-12").replace("CURRENT-1", "NEW-2") + "\n備考: 今回だけ";
  const [result] = h.recall(next);
  assert.equal(result.parsed.quantity, 37);
  assert.equal(result.parsed.dueDate, "2027-02-12");
  assert.equal(result.parsed.serialNo, "NEW-2");
  assert.equal(result.parsed.note, "今回だけ");
  assert.equal(result.parsed.productCode, "KNOWN-3");
  assert.equal(result.parsed._memory.version, 1);
  assert.equal(result.parsed._learning.original.productCode, "");
});

test("different customers, catalogue codes, names and explicit specifications cannot bypass AI", () => {
  const h = harness(), parsed = h.parse(text)[0].parsed;
  h.remember({ ...parsed, productCode: "KNOWN-3" });
  for (const value of [
    text.replace("田中", "別会社"),
    text.replace("ケリソン18cm上向3mm", "別製品18cm上向3mm"),
    text + "\n品番: OTHER-3",
    text.replace("品名: ", "品名: F06-35-30L ") + "\n製品番号: KNOWN-3",
    text + "\n全長: 21cm",
    text + "\n形状: 下向",
    text + "\n刃幅: 4mm",
  ]) assert.ok(h.recall(value) === null, value);
});

test("unrecognized, ambiguous and incomplete rows reject the entire batch", () => {
  const h = harness();
  h.remember(h.parse(text)[0].parsed);
  for (const value of [
    text.replace("数量: 10\n", ""), text.replace("数量: 10", "数量: -10"),
    text.replace("数量: 10", "数量: 10〜20"), text.replace("数量: 10", "数量: 1.5"),
    text.replace("数量: 10", "数量: 0"), text.replace("2026-11-30", "11/30"),
    text.replace("2026-11-30", "2026-02-30"), text + "\n数量: 11",
    text + "\n納期: 2027-01-02", text + "\n別の鉗子 5本",
    text + "\n品名: 未登録の鉗子\n数量: 2\n納期: 2026-12-01",
    text + "\n合計数量: 11",
    text.replace("ケリソン18cm上向3mm", "ケリソン18cm上向3mm 数量: 12"),
  ]) assert.ok(h.recall(value) === null, value);
  assert.equal(h.recall(text + "\n合計数量: 10").length, 1);
});

test("identical product rows stay separate, and an unknown row falls back once with the whole source", () => {
  const h = harness();
  h.remember(h.parse(text)[0].parsed);
  const two = text + "\n品名: ケリソン18cm上向3mm\n数量: 5\n納期: 2026-12-15\n連番: NEW-2";
  assert.deepEqual(Array.from(h.recall(two), result => result.parsed.quantity), [10, 5]);
  const unknown = two.replace("連番: NEW-2", "連番: NEW-2\n品名: 未登録の鉗子\n数量: 2\n納期: 2027-01-02");
  h.c.createIntakeFromText({ text: unknown, engine: "auto" });
  assert.equal(h.calls.ai, 1);
  assert.equal(h.calls.aiInput.text, unknown);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].parsed.product, "AI結果");
});

const tanakaOrder = "得意先: 田中\n納期: 2027-02-01\n注文番号: A001\n品名: ケリソン18cm上向3mm\n数量: 7";
const mizuhoOrder = "得意先: ミズホ\n納期: 2027-02-27\n注文番号: B002\n品名: ケリソン18cm上向3mm\n数量: 9";

function orderHeaderHarness() {
  const h = harness();
  h.remember(h.parse(tanakaOrder)[0].parsed);
  h.remember(h.parse(mizuhoOrder)[0].parsed);
  return h;
}

test("separate orders bind customer, date and order number to their own items", () => {
  const h = orderHeaderHarness();
  const orders = `${tanakaOrder}\n\n${mizuhoOrder}`;
  assert.equal(h.c.createIntakeFromText({ text: orders, engine: "auto" }).added, 2);
  assert.equal(h.calls.ai, 0);
  assert.deepEqual(h.saved.map(({ parsed }) => [parsed.customer, parsed.quantity, parsed.dueDate, parsed.externalOrderNo]), [
    ["田中", 7, "2027-02-01", "A001"],
    ["ミズホ", 9, "2027-02-27", "B002"],
  ]);
});

test("interleaved order labels fall back to AI with the original document", () => {
  for (const orders of [
    `${tanakaOrder}\n${mizuhoOrder}`,
    `${tanakaOrder}\n\n納期: 2027-02-28\n\n${mizuhoOrder}`,
  ]) {
    const h = orderHeaderHarness();
    h.c.createIntakeFromText({ text: orders, engine: "auto" });
    assert.equal(h.calls.ai, 1);
    assert.equal(h.calls.aiInput.text, orders);
    assert.deepEqual(h.saved.map(({ parsed }) => parsed.product), ["AI結果"]);
  }
});

test("shared order headers and dates belonging to individual items are still read without AI", () => {
  const h = orderHeaderHarness();
  const order = `${tanakaOrder}\n納期: 2027-02-08\n\n品名: ケリソン18cm上向3mm\n数量: 5`;
  assert.equal(h.c.createIntakeFromText({ text: order, engine: "auto" }).added, 2);
  assert.equal(h.calls.ai, 0);
  assert.deepEqual(h.saved.map(({ parsed }) => [parsed.customer, parsed.quantity, parsed.dueDate, parsed.externalOrderNo]), [
    ["田中", 7, "2027-02-08", "A001"],
    ["田中", 5, "2027-02-01", "A001"],
  ]);
});

test("known text imports save review candidates with original text and make no AI request", () => {
  const h = harness();
  h.remember(h.parse(text)[0].parsed);
  const result = h.c.createIntakeFromText({ name: "合成注文", text, engine: "auto", files: [{ base64: "MUST_IGNORE" }] });
  assert.equal(result.added, 1);
  assert.equal(h.calls.ai, 0);
  assert.equal(h.saved[0].status, "pending");
  assert.match(h.saved[0].originalText, /AIなし/);
  assert.ok(h.saved[0].originalText.includes(text));
  assert.equal(h.saved[0].parsed.quantity, 10);
  h.c.createIntakeFromText({ text, engine: "ai" });
  assert.equal(h.calls.ai, 1, "an explicit AI selection still forces a fresh reading");
});

test("customer alias rules are applied before the strict product identity comparison", () => {
  const h = harness();
  h.remember(h.parse(text)[0].parsed);
  assert.equal(h.recall(text.replace("田中", "田中医科器械製作所")).length, 1);
  assert.equal(h.recall(text.replace("田中", "有限会社 興之宮医科工業")), null);
});

test("TC column and inline tables require every row quantity and explicit row delivery date", () => {
  const h = harness();
  const results = h.parse(tcText);
  results.forEach((result, index) => h.remember(result.parsed, result.parsed, `TC-${index}`));
  assert.equal(h.recall(tcText).length, 6);
  assert.equal(h.recall(tcText.replace(/\n2026-11-30\n2026-11-30/, "\n2026-11-30")), null);
  assert.equal(h.recall(tcText + "\n7 _ x"), null);
  assert.equal(h.recall(tcText.replace("6 _ ", "7 _ ")), null);
  assert.equal(h.recall(tcText.replace("\n10\n10\n", "\n10\n")), null);
  assert.equal(h.recall(tcText.replace("\n個\n個", "\n個")), null);
  assert.equal(h.recall(tcText + "\n1000"), null, "a price or amount cannot stand in for the quantity column");
  assert.equal(h.recall("株式会社田中医科器械製作所 TC_27_2345\n1 _ 06-56-60S 千葉大式鋭匙鉗子<直/6mm>18cm\n2027-03-31\n1000"), null);
  const inline = "発注元: 田中\nTC_27_2345\n1 _ 06-56-60S 千葉大式鋭匙鉗子<直/6mm>18cm 2027-03-31 19個\n2 _ 06-51-50S 鋭匙鉗子<直/5mm>21cm 2027-04-30 8個";
  const recalled = h.recall(inline);
  assert.deepEqual(Array.from(recalled, result => result.parsed.quantity), [19, 8]);
  assert.equal(h.recall(inline + " 3 _ 未登録の鉗子 2027-04-30 2個"), null);
  assert.equal(h.recall(tcText + "\nTC_27_9999"), null);
  assert.equal(h.recall(tcText.replace("発注致します。 株式会社田中医科器械製作所", "発注致します。 株式会社別会社")), null);
});

test("PDF text and image OCR use remembered products; unresolved files use the original AI attachment once", () => {
  const h = harness();
  h.remember(h.parse(text)[0].parsed);
  const file = { name: "synthetic.pdf", mimeType: "application/pdf", base64: "AA==", pdfText: { pageCount: 1, pages: [text] } };
  assert.equal(h.c.createIntakeAutomatically(file).added, 1);
  assert.equal(h.calls.ai, 0);
  assert.equal(h.calls.ocr, 0);
  assert.equal(h.c.createIntakeAutomatically({ ...file, mimeType: "image/jpeg", text: "not trusted for images" }).added, 1);
  assert.equal(h.calls.ocr, 1);
  assert.equal(h.calls.ai, 0);
  h.c.createIntakeAutomatically({ ...file, pdfText: { pageCount: 1, pages: ["unknown layout"] } });
  assert.equal(h.calls.ai, 1);
  assert.equal(h.calls.aiInput.base64, file.base64);
  assert.equal(h.calls.aiInput.text, undefined);
  assert.ok(h.calls.editor >= 6);
});

test("auto PDF with unverified extracted text sends the original to AI and never previews the partial text", () => {
  const h = harness();
  h.remember(h.parse(text)[0].parsed);
  const file = { name: "mixed-pages.pdf", mimeType: "application/pdf", base64: "AQID", text };
  h.c.runAiImport_ = input => {
    h.calls.ai++;
    assert.deepEqual(copy(input), { name: file.name, mimeType: file.mimeType, base64: file.base64 });
    return [1, 2].map(page => ({ itemNumber: page, parsed: { product: `AI明細${page}`, _ai: { document: 1, page, row: "1", evidence: "", warnings: [] } } }));
  };
  const result = h.c.createIntakeAutomatically(file);
  assert.equal(result.added, 2);
  assert.equal(h.calls.ai, 1);
  assert.equal(h.calls.ocr, 0);
  assert.equal(h.saved.length, 2);
  for (const item of h.saved) {
    assert.match(item.originalText, /原本を別途開き、明細数・数量・納期を確認/);
    assert.doesNotMatch(item.originalText, /AIなし|CURRENT-1/);
  }
});

test("auto PDF with missing coverage cannot bypass AI using OCR of uncertain coverage", () => {
  const h = harness();
  h.remember(h.parse(text)[0].parsed);
  const file = { name: "mixed-pages.pdf", mimeType: "application/pdf", base64: "AQID" };
  for (const pdfText of [undefined, { pageCount: 2, pages: [text] }, { pageCount: 2, pages: [text, " "] }]) {
    h.c.createIntakeAutomatically({ ...file, pdfText });
  }
  assert.equal(h.calls.ai, 3);
  assert.equal(h.calls.ocr, 0);
  assert.equal(h.calls.aiInput.base64, file.base64);
});

test("auto PDF can use verified text from all pages as separate orders", () => {
  const h = orderHeaderHarness();
  const file = { name: "text-pages.pdf", mimeType: "application/pdf", base64: "AQID", pdfText: { pageCount: 2, pages: [tanakaOrder, mizuhoOrder] } };
  assert.equal(h.c.createIntakeAutomatically(file).added, 2);
  assert.equal(h.calls.ai, 0);
  assert.deepEqual(h.saved.map(({ parsed }) => [parsed.customer, parsed.externalOrderNo, parsed.quantity]), [
    ["田中", "A001", 7], ["ミズホ", "B002", 9],
  ]);
});

test("forgetting and conflicting approved specifications prevent automatic reuse", () => {
  const h = harness(), parsed = h.parse(text)[0].parsed;
  h.remember(parsed);
  const [rule] = h.rules;
  const supplemented = h.c.IntakeLearning.apply({ parsed, rules: h.rules }).parsed;
  const forgotten = h.c.IntakeLearning.remember({ parsed: supplemented, order: supplemented, rules: [], intakeId: "older-candidate" });
  assert.equal(forgotten.rules.length, 0);
  h.rules.push({ ...copy(rule), key: JSON.stringify(["田中", "OTHER-3", parsed.product]), source: { ...copy(rule.source), productCode: "OTHER-3" }, target: { ...copy(rule.target), productCode: "OTHER-3" } });
  assert.equal(h.recall(text), null);
});
