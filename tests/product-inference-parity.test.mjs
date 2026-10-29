import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { sheetsFixture } from "./helpers/sheets-fixture.mjs";
import { productInferenceCases } from "./fixtures/product-inference-cases.mjs";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const storage = new Map();
const client = vm.createContext({ Date, Intl, Math, Number, Object, String, Array, RegExp, Set, Map, JSON, URL, structuredClone,
  setTimeout, clearTimeout, window: {}, navigator: {},
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  document: { querySelector: () => null, querySelectorAll: () => [] },
  fetch: async (_url, request) => ({ ok: true, json: async () => ({ jobs: JSON.parse(request.body).jobs }) }),
});
vm.runInContext(`${app.slice(0, app.indexOf("async function init()"))}\ndelay = () => Promise.resolve(); globalThis.ui = { api, state, inferSpecsFromProductName, applyProductInference };`, client);
client.ui.state.access = { role: "editor", canEdit: true };
const data = client.ui.api.read(); data.jobs = []; data.intake = []; client.ui.api.write(data);
const server = await sheetsFixture(["apps-script/Import.gs"]);
const plain = value => JSON.parse(JSON.stringify(value));

for (const [index, [product, shape]] of productInferenceCases.entries()) {
  test(`N04 UI/Mock/Server preserve shape and direction: ${product}`, async () => {
    const expected = { specLength: "", specShape: shape, bladeWidth: "" };
    assert.deepEqual(plain(client.ui.inferSpecsFromProductName(product)), expected);
    assert.deepEqual(plain(server.context.inferSpecsFromProductName_(product, {})), expected);
    const input = { id: `N04-${index}`, customer: "合成比較", product, quantity: 3 };
    const mockSaved = await client.ui.api.saveJob(input);
    const serverSaved = server.context.saveJob(input);
    assert.equal(mockSaved.specShape, shape);
    assert.equal(serverSaved.specShape, shape);
    assert.equal(client.ui.api.read().jobs.find(job => job.id === input.id).specShape, shape);
    assert.equal(server.context.readJobs_().find(job => job.id === input.id).specShape, shape);
  });
}

test("N04 direction correction keeps measurements, explicit specs and unknown category", async () => {
  const product = "鋭匙鉗子　全長１８０ｍｍ　強彎／下向　刃幅３．５ｍｍ";
  const expected = { specLength: "180mm", specShape: "強弯・下向", bladeWidth: "3.5mm" };
  assert.deepEqual(plain(client.ui.inferSpecsFromProductName(product)), expected);
  assert.deepEqual(plain(server.context.inferSpecsFromProductName_(product, {})), expected);
  const explicit = { specLength: "21cm", specShape: "利用者指定型", bladeWidth: "4mm" };
  assert.deepEqual(plain(client.ui.inferSpecsFromProductName(product, explicit)), explicit);
  assert.deepEqual(plain(server.context.inferSpecsFromProductName_(product, explicit)), explicit);
  for (const [index, context] of [["client", client.ui.api], ["server", server.context]]) {
    const saved = await context.saveJob({ id: `N04-explicit-${index}`, customer: "合成比較", product, quantity: 3, ...explicit });
    for (const key of Object.keys(explicit)) assert.equal(saved[key], explicit[key]);
    const legacy = await context.saveJob({ id: `N04-legacy-${index}`, customer: "合成比較", product: "鋭匙鉗子 弱弯・上向", quantity: 3, specShape: "弱弯" });
    assert.equal(legacy.specShape, "弱弯", "saved nonempty legacy shape is never normalized");
    const unknown = await context.saveJob({ id: `N04-unknown-${index}`, customer: "合成比較", product: "未登録器具", quantity: 3 });
    assert.equal(unknown.category, "");
  }
});

test("N04 only empty or auto-filled controls change when product changes", () => {
  const field = (value = "", autoFilled = false) => ({ value, dataset: autoFilled ? { autoFilled: "true" } : {} });
  const elements = { product: field("鋭匙鉗子 弱弯・上向"), category: field(), specLength: field("21cm"), specShape: field(), bladeWidth: field("4mm") };
  const form = { elements, querySelector: () => null };
  client.ui.applyProductInference(form);
  assert.equal(elements.specShape.value, "弱弯・上向");
  assert.equal(elements.specShape.dataset.autoFilled, "true");
  assert.equal(elements.specLength.value, "21cm");
  elements.product.value = "鋭匙鉗子 強彎/下向";
  client.ui.applyProductInference(form);
  assert.equal(elements.specShape.value, "強弯・下向");
  elements.specShape.value = "明示入力"; delete elements.specShape.dataset.autoFilled;
  elements.product.value = "鋭匙鉗子 弱弯・上向";
  client.ui.applyProductInference(form);
  assert.equal(elements.specShape.value, "明示入力");
  assert.equal(elements.specLength.value, "21cm");
  assert.equal(elements.bladeWidth.value, "4mm");
});

test("N04 pasted multi-item order parsing retains the same directional shapes", () => {
  const text = "得意先: 合成本文\n品名: 鋭匙鉗子 弱弯・上向\n数量: 3\n連番: N04-BODY-1\n\n品名: 鋭匙鉗子 強彎/下向\n数量: 5\n連番: N04-BODY-2";
  const parsed = server.context.parsePastedOrderItems_(text, {});
  assert.equal(parsed.length, 2);
  assert.deepEqual(Array.from(parsed, item => item.parsed.specShape), ["弱弯・上向", "強弯・下向"]);
  assert.deepEqual(Array.from(parsed, item => client.ui.inferSpecsFromProductName(item.parsed.product).specShape), ["弱弯・上向", "強弯・下向"]);
  assert.deepEqual(Array.from(parsed, item => item.parsed.quantity), [3, 5]);
});
