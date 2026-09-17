import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const parserSource = await readFile(new URL("../apps-script/Parser.gs", import.meta.url), "utf8");
const importSource = await readFile(new URL("../apps-script/Import.gs", import.meta.url), "utf8");
const purchaseOrder = await readFile(new URL("./fixtures/tanaka-tc-purchase-order.txt", import.meta.url), "utf8");

test("複数品目PDFを6件の重複しない取込候補として保存する", () => {
  const saved = [];
  const logs = [];
  const context = vm.createContext({
    Date,
    Math,
    Number,
    Object,
    RegExp,
    String,
    APP: { DEFAULTS: {} },
    ensureSystem_: () => {},
    sanitizeText_: (value, max) => String(value || "").slice(0, max),
    withDocumentLock_: (callback) => callback(),
    appendIntake_: (item) => {
      const savedItem = { ...item, id: `INTAKE-${saved.length + 1}` };
      saved.push(savedItem);
      return savedItem;
    },
    appendLog_: (...args) => logs.push(args),
    Utilities: {
      base64Decode: () => [1, 2, 3],
      newBlob: () => ({ mock: true }),
      getUuid: () => "batch-uuid",
    },
  });
  vm.runInContext(`${parserSource}\n${importSource}`, context);
  context.ocrBlob_ = () => purchaseOrder;

  const result = context.createIntakeFromImage({
    base64: "AQID",
    mimeType: "application/pdf",
    name: "発注書_2026年11月納入分_TC_26_1790_260831田中医科.pdf",
  });

  assert.equal(result.added, 6);
  assert.equal(saved.length, 6);
  assert.equal(new Set(saved.map((item) => item.sourceRef)).size, 6);
  assert.match(saved[0].sourceRef, /:item:1:/);
  assert.match(saved[5].sourceRef, /:item:6:/);
  assert.match(saved[0].subject, /品目1（1\/6）/);
  assert.match(saved[0].originalText, /^この確認候補: 品目1/);
  assert.deepEqual(saved.map((item) => item.parsed.quantity), [10, 10, 10, 5, 5, 5]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][3].added, 6);
});

test("ブラウザで抽出したPDF文字列もOCRを経由せず6件保存する", () => {
  const saved = [];
  const context = vm.createContext({
    Date,
    Math,
    Number,
    Object,
    RegExp,
    String,
    APP: { DEFAULTS: {} },
    ensureSystem_: () => {},
    sanitizeText_: (value, max) => String(value || "").slice(0, max),
    withDocumentLock_: (callback) => callback(),
    appendIntake_: (item) => {
      const savedItem = { ...item, id: `INTAKE-${saved.length + 1}` };
      saved.push(savedItem);
      return savedItem;
    },
    appendLog_: () => {},
    Utilities: { getUuid: () => "browser-pdf-batch" },
  });
  vm.runInContext(`${parserSource}\n${importSource}`, context);

  const result = context.createIntakeFromPdfText({
    mimeType: "application/pdf",
    name: "発注書_2026年11月納入分_TC_26_1790_260831田中医科.pdf",
    text: purchaseOrder,
  });

  assert.equal(result.added, 6);
  assert.deepEqual(saved.map((item) => item.parsed.quantity), [10, 10, 10, 5, 5, 5]);
});
