import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");

function harness() {
  const storage = new Map();
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    document: { querySelector: () => ({ value: "" }) }, window: {},
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, ledgerLengthValue, orderTableHeader, orderTableRows, ledgerJobGroups, ledgerTotalsText, productLabelMarkup };`, context);
  return context.ui;
}

const baseJob = (overrides = {}) => ({
  id: "job-1", customer: "ユフ", product: "鉗子 <A>", category: "鋭匙鉗子", quantity: 3,
  specLength: "120mm", specShape: "型1", bladeWidth: "3mm", serialNo: "07",
  dueDate: "2026-10-31", shippingStatus: "not_ready", stages: {}, archived: false,
  ...overrides,
});

test("normalized target customers show the preferred product code, while other customers retain length", () => {
  const ui = harness();
  for (const customer of ["ユフ", " ＴＳ　メディカル 株式会社 ", "（株）松井", "有限会社 松井", "TMマツイ", "ＴＭ　マツイ"])
    assert.equal(ui.ledgerLengthValue(baseJob({ customer, productCode: "fallback-2" })), "fallback-2", customer);
  assert.equal(ui.ledgerLengthValue(baseJob({ customer: "松井", productCode: "fallback", productMaster: { productCode: "master-10" } })), "master-10");
  assert.equal(ui.ledgerLengthValue(baseJob({ customer: "別の得意先", productCode: "ABC", specLength: "180mm" })), "180mm");
  assert.equal(ui.ledgerLengthValue(baseJob({ customer: "ユフ", productCode: "  ", specLength: "120mm" })), "—");
});

test("ledger uses product code without changing original length in labels or job data", () => {
  const ui = harness();
  const job = baseJob({ productCode: "<A&B>", customer: "ユフ" });
  const original = JSON.stringify(job);
  const header = ui.orderTableHeader();
  const row = ui.orderTableRows([job]);
  assert.match(row, /<td class="cell-length" title="&lt;A&amp;B&gt;">&lt;A&amp;B&gt;<\/td>/);
  assert.match(ui.productLabelMarkup(job), /<span class="label-spec-name">全長<\/span><strong class="label-spec-value">120<\/strong>/);
  assert.match(header, /全長／製品番号/);
  assert.equal(JSON.stringify(job), original);
});

test("category column is absent in standard and compact tables while category group totals and stage variants remain", () => {
  const ui = harness();
  for (const compact of [false, true]) {
    const header = ui.orderTableHeader({ compact, category: "鋭匙鉗子" });
    const cells = ui.orderTableRows([baseJob()], { compact });
    assert.equal((header.match(/<th scope="col"/g) || []).length, compact ? 14 : 17);
    assert.equal((cells.match(/<td(?:\s|>)/g) || []).length, compact ? 14 : 17);
    assert.doesNotMatch(header, /大分類|分類/);
  }
  const jobs = [baseJob(), baseJob({ id: "k-1", category: "ケリソンパンチ", quantity: 2 })];
  const groups = ui.ledgerJobGroups(jobs);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(([name, group]) => [name, ui.ledgerTotalsText(group)]))), [["ケリソンパンチ", "1件・2丁"], ["鋭匙鉗子", "1件・3丁"]]);
  assert.match(ui.orderTableHeader({ category: "鋭匙鉗子" }), /頭付け・幅取り/);
  assert.match(ui.orderTableHeader({ category: "ケリソンパンチ" }), /厚みとり/);
});

test("targeted code display works across views and still escapes product text", () => {
  const ui = harness();
  for (const role of ["owner", "editor", "worker", "viewer"]) {
    ui.state.access = { role };
    for (const completed of [false, true]) {
      const job = baseJob({ customer: "ＴＳメディカル", productCode: "P<&>1", shippingStatus: completed ? "shipped" : "not_ready" });
      for (const compact of [false, true]) {
        const row = ui.orderTableRows([job], { compact, completed });
        assert.match(row, /P&lt;&amp;&gt;1/, `${role} ${completed ? "completed" : "working"} ${compact ? "compact" : "standard"}`);
        assert.match(row, /鉗子 &lt;A&gt;/);
        assert.doesNotMatch(row, /cell-category/);
      }
    }
  }
});
