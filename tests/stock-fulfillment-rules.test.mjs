import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all(["finished-stock-orders.js", "finished-stock.js"].map(name =>
  readFile(new URL(`../src/${name}`, import.meta.url), "utf8")));
const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, Array, JSON, Error, isFinite, parseInt });
vm.runInContext(sources.join("\n"), context);
const stock = context.FinishedStock;
const copy = value => JSON.parse(JSON.stringify(value));
const job = (extra = {}) => ({
  id: "F03", customer: "田中医科", product: "Tezoe スタンツェ 直上", productCode: "26001",
  specShape: "直・上向", bladeWidth: "赤", quantity: 0, stockPlannedQuantity: 0,
  version: 1, stages: { finish: { status: "pending" } }, ...extra,
});
function fixture({ shipped = 5, linked = true } = {}) {
  const order = job(), events = [];
  const mutate = (action, input) => {
    const result = stock.prepareMutation(action, {
      expectedVersion: events.length, requestId: `request-${events.length}`, ...input,
    }, { jobs: [order], events, at: "2026-10-23T00:00:00.000Z", id: `event-${events.length}` });
    events.push(copy(result.event));
    return events.at(-1);
  };
  mutate("opening", { productId: "26001", quantity: 12, date: "2026-10-01", note: "現物確認" });
  mutate("schedule", { jobId: order.id, jobVersion: 1, orderQuantity: 5, stockQuantity: linked ? 5 : 0, shipmentMode: "split", shipDate: "2026-10-23" });
  if (shipped) mutate("ship", { productId: "26001", quantity: shipped, date: "2026-10-20", customer: order.customer, orderRef: "F03", purpose: "sale", ...(linked ? { orderJobId: order.id, jobVersion: 1 } : {}) });
  return { order, events, mutate };
}
const fulfilled = { date: "2026-10-20", orderQuantity: 5, shippedQuantity: 5, productId: "26001" };

test("all-stock order requires explicit full linked shipment and preserves all input and stock quantities", () => {
  const h = fixture(), before = copy(h);
  const balance = stock.snapshot({ jobs: [h.order], events: h.events }).products[0].stockQuantity;
  assert.deepEqual(copy(stock.fulfillment(h.order, h.events)), fulfilled);
  assert.deepEqual(copy(h), before);
  assert.equal(stock.snapshot({ jobs: [h.order], events: h.events }).products[0].stockQuantity, balance);
  assert.equal(h.order.stages.finish.status, "pending");
});

test("partial shipments, missing captured demand, manufacture and replenishment are ineligible", () => {
  const full = fixture(), partial = fixture({ shipped: 4 });
  assert.equal(stock.fulfillment(partial.order, partial.events), null);
  assert.equal(stock.fulfillment(full.order, full.events.filter(event => event.action !== "schedule")), null);
  assert.equal(stock.fulfillment(job({ quantity: 1 }), full.events), null);
  assert.equal(stock.fulfillment(job({ quantity: 5, stockPlannedQuantity: 5 }), full.events), null);
  assert.equal(stock.fulfillment(job({ stockPlannedQuantity: 1 }), full.events), null);
  for (const customer of ["在庫", "在庫用", " 在庫用 "]) assert.equal(stock.fulfillment(job({ customer }), full.events), null);
  assert.equal(stock.fulfillment(job({ archived: true }), full.events), null);
});

test("unlinked or other-job shipments never fulfill the order", () => {
  const h = fixture({ linked: false });
  assert.equal(stock.fulfillment(h.order, h.events), null);
  h.events.at(-1).orderJobId = "ANOTHER";
  assert.equal(stock.fulfillment(h.order, h.events), null);
});

test("reversal removes linked shipment eligibility and a replacement uses its effective shipment date", () => {
  const h = fixture();
  h.mutate("reverse", { eventId: h.events.at(-1).id, date: "2026-10-21", note: "出荷取消" });
  assert.equal(stock.fulfillment(h.order, h.events), null);
  h.mutate("ship", { productId: "26001", quantity: 5, date: "2026-10-22", orderJobId: h.order.id, jobVersion: 1, purpose: "sale" });
  assert.deepEqual(copy(stock.fulfillment(h.order, h.events)), { ...fulfilled, date: "2026-10-22" });
});

test("the completion date is the latest effective shipment day, including backdated append order", () => {
  const h = fixture({ shipped: 3 });
  h.mutate("ship", { productId: "26001", quantity: 2, date: "2026-10-19", orderJobId: h.order.id, jobVersion: 1, purpose: "sale" });
  assert.deepEqual(copy(stock.fulfillment(h.order, h.events)), fulfilled);
});

test("only the latest appended schedule captures demand and must match the product", () => {
  const h = fixture();
  const schedule = copy(h.events.find(event => event.action === "schedule"));
  h.events.push({ ...schedule, id: "new-schedule", requestId: "new-schedule", orderQuantity: 6, at: "2026-10-22T00:00:00.000Z" });
  assert.equal(stock.fulfillment(h.order, h.events), null);
  h.events.at(-1).orderQuantity = 5;
  assert.deepEqual(copy(stock.fulfillment(h.order, h.events)), fulfilled);
  h.events.at(-1).productId = "26002";
  assert.equal(stock.fulfillment(h.order, h.events), null);
  h.events.at(-1).productId = "26001";
  h.events.at(-1).orderQuantity = 0;
  assert.equal(stock.fulfillment(h.order, h.events), null);
  delete h.events.at(-1).orderQuantity;
  assert.equal(stock.fulfillment(h.order, h.events), null);
});

test("incorrect Tezoe identity or a different product linked shipment cannot complete an order", () => {
  const h = fixture();
  for (const extra of [{ product: "別製品" }, { productCode: "26002" }, { productCode: "unknown" }, { specShape: "弱弯上向" }]) {
    assert.equal(stock.fulfillment(job(extra), h.events), null);
  }
  const other = fixture({ shipped: 0 });
  other.mutate("opening", { productId: "26002", quantity: 5, date: "2026-10-01", note: "別製品現物確認" });
  const shipment = other.mutate("ship", { productId: "26002", quantity: 5, date: "2026-10-20", customer: "田中医科", orderRef: "F03", purpose: "sale" });
  shipment.orderJobId = other.order.id;
  assert.equal(stock.fulfillment(other.order, other.events), null);
});

test("invalid zero manufacture or stock quantities and invalid captured demand fail closed", () => {
  const h = fixture();
  const invalid = [undefined, null, "", " ", false, true, [], {}, NaN, Infinity, -1, 0.5, 1000001, "invalid"];
  for (const field of ["quantity", "stockPlannedQuantity"]) {
    for (const value of invalid) assert.equal(stock.fulfillment(job({ [field]: value }), h.events), null, `${field}: ${String(value)}`);
  }
  assert.deepEqual(copy(stock.fulfillment(job({ quantity: "0", stockPlannedQuantity: "0" }), h.events)), fulfilled);
  for (const value of [undefined, null, "", " ", false, [], [5], {}, -1, 0, 0.5, 1000001, "invalid"]) {
    const events = copy(h.events);
    events.find(event => event.action === "schedule").orderQuantity = value;
    assert.equal(stock.fulfillment(h.order, events), null);
  }
});

test("invalid dates and corrupt replay records cannot qualify for completion", () => {
  const h = fixture();
  for (const action of ["schedule", "ship"]) {
    for (const date of ["", "2026-02-30", "2026-13-01", "2026-10-20T00:00:00Z", "invalid"]) {
      const events = copy(h.events);
      events.find(event => event.action === action).date = date;
      assert.equal(stock.fulfillment(h.order, events), null);
    }
  }
  const events = copy(h.events);
  events.at(-1).quantity = null;
  assert.equal(stock.fulfillment(h.order, events), null);
  assert.equal(stock.fulfillment(h.order, {}), null);
});

test("outstanding or invalid polishing blocks completion and shipped orders remain auditable", () => {
  const h = fixture();
  assert.deepEqual(copy(stock.fulfillment(job({ shippingStatus: "shipped" }), h.events)), fulfilled);
  assert.deepEqual(copy(stock.fulfillment(job({ polishing: { sentQuantity: 1, returnedQuantity: 1 } }), h.events)), fulfilled);
  for (const polishing of [{ sentQuantity: 1, returnedQuantity: 0 }, { sentQuantity: 0, returnedQuantity: 1 }, { sentQuantity: null, returnedQuantity: 0 }, { sentQuantity: false, returnedQuantity: false }]) {
    assert.equal(stock.fulfillment(job({ polishing }), h.events), null);
  }
});
