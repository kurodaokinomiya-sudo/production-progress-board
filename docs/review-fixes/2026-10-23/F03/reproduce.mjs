// Original F03 reproduction, now checks the agreed fulfillment behavior.
// Synthetic local state; never connects to Sheets/Gmail.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { sheetsFixture } from "../../../../tests/helpers/sheets-fixture.mjs";

const root = new URL("../../../../", import.meta.url);
const sources = await Promise.all(["finished-stock-orders.js", "finished-stock.js", "materials.js", "intake-duplicates.js", "intake-learning.js", "app.js"].map(file => readFile(new URL(`src/${file}`, root), "utf8")));
const storage = new Map();
const context = vm.createContext({ Date, Intl, Math, Number, Object, String, Array, RegExp, Set, Map, JSON, URL, structuredClone,
  setTimeout, clearTimeout, crypto: webcrypto, window: { crypto: webcrypto }, navigator: {},
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  document: { querySelector: () => null, querySelectorAll: () => [] },
  fetch: async (url, request) => ({ ok: true, json: async () => url === "/api/local/product-metadata" ? { jobs: JSON.parse(request.body).jobs } : {} }),
});
vm.runInContext(`${sources.slice(0, 5).join("\n")}\n${sources[5].slice(0, sources[5].indexOf("async function init()"))}\ndelay = () => Promise.resolve(); globalThis.ui = { api, state };`, context);
context.ui.state.access = { role: "owner", canEdit: true, isOwner: true, isAdmin: true };
const empty = context.ui.api.read(); empty.jobs = []; empty.intake = []; empty.finishedStockEvents = []; context.ui.api.write(empty);
const server = await sheetsFixture(["src/finished-stock-orders.js", "src/finished-stock.js", "apps-script/FinishedStock.gs"]);

for (const [name, api] of [["server", server.context], ["MockApi", context.ui.api]]) {
  const order = await api.saveJob({ customer: "検証受注", product: "Tezoe スタンツェ 直・上向", productCode: "26001", quantity: 5, serialNo: "SYNTHETIC-ONLY", requestId: "order" });
  await api.openFinishedStock({ requestId: "opening", expectedVersion: 0, productId: "26001", quantity: 5, date: "2026-10-01", note: "合成fixture" });
  await api.saveFinishedStockSchedule({ requestId: "schedule", expectedVersion: 1, jobId: order.id, jobVersion: order.version, orderQuantity: 5, stockQuantity: 5, shipmentMode: "split", shipDate: "", completionDate: "" });
  const zero = await api.saveJob({ ...order, quantity: 0, requestId: "zero" });
  const snapshot = await api.shipFinishedStock({ requestId: "shipment", expectedVersion: 2, productId: "26001", orderJobId: zero.id, jobVersion: zero.version, quantity: 5, date: "2026-10-01", purpose: "sale" });
  const projected = snapshot.orders.find(row => row.jobId === zero.id);
  assert.equal(projected.remainingQuantity, 0);
  assert.equal(projected.shippedQuantity, 5);
  const fulfilled = await api.saveJob({ ...zero, shippingStatus: "shipped", requestId: "complete" });
  assert.equal(fulfilled.completionKind, "stock_fulfillment");
  assert.notEqual(fulfilled.stages?.finish?.status, "done");
  console.log(JSON.stringify({ name, manufacturingQuantity: zero.quantity, orderQuantity: projected.quantity, shippedQuantity: projected.shippedQuantity, remainingQuantity: projected.remainingQuantity, completionKind: fulfilled.completionKind, completedAt: fulfilled.completedAt }));
}
