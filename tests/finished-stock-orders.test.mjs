import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/finished-stock-orders.js", import.meta.url), "utf8");
function ordersApi() {
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, Array, JSON, Error, isFinite });
  vm.runInContext(source, context);
  return context.FinishedStockOrders;
}
const identify = job => {
  if (/tezoe/i.test(job.product || "") && job.productCode === "26001") return { id: "26001", code: "26001" };
  if (/tezoe/i.test(job.product || "")) throw new Error("Tezoe品名と製品番号が一致しません");
  return null;
};
const stockLot = (id, remainingQuantity, date, at = `${date}T00:00:00.000Z`) => ({ id, productId: "26001", lotNo: id, quantity: remainingQuantity, remainingQuantity, date, at, productionDate: date, producers: [id] });
const job = (id, quantity, extra = {}) => ({
  id, customer: `得意先${id}`, product: "Tezoe スタンツェ 直上", productCode: "26001", quantity,
  stockPlannedQuantity: 0, dueDate: "2026-11-12", createdAt: `2026-10-${id === "A" ? "01" : "02"}T00:00:00.000Z`,
  archived: false, shippingStatus: "waiting", version: 4, stages: { finish: { status: "done", assignee: "河" } },
  polishing: { sentQuantity: 0, returnedQuantity: 0 }, ...extra,
});
const product = stockQuantity => ({ id: "26001", code: "26001", name: "Tezoe スタンツェ 直上", stockQuantity, stockRegistered: true });
const plain = value => JSON.parse(JSON.stringify(value));

test("order and production readiness require exact actual full polishing return, including legacy ordinary completion", () => {
  const api = ordersApi();
  const candidates = [
    job("ordinary", 5),
    job("partial", 5, { polishing: { sentQuantity: 2, returnedQuantity: 2 } }),
    job("outstanding", 5, { polishing: { sentQuantity: 5, returnedQuantity: 4 } }),
    job("over-return", 5, { polishing: { sentQuantity: 5, returnedQuantity: 6 } }),
    job("negative", 5, { polishing: { sentQuantity: -1, returnedQuantity: -1 } }),
    job("invalid", 5, { polishing: { sentQuantity: NaN, returnedQuantity: NaN } }),
    job("coerced-boolean", 1, { polishing: { sentQuantity: true, returnedQuantity: true } }),
    job("coerced-string", 5, { polishing: { sentQuantity: "5", returnedQuantity: "5" } }),
    job("ready", 5, { polishing: { sentQuantity: 5, returnedQuantity: 5 } }),
  ];
  const result = api.project({ products: [product(0)], plans: [], lots: [], history: [] }, candidates, { productFor: identify });
  for (const entry of [...result.orders, ...result.productions]) {
    assert.equal(entry.finishReady, entry.jobId === "ready", entry.jobId);
  }
  assert.equal(result.orders.length, candidates.length);
  assert.equal(result.productions.length, candidates.length);
});

test("orders use the latest captured demand, exclude reversed shipments, and reserve FIFO stock once", () => {
  const api = ordersApi();
  const jobs = [job("A", 4), job("B", 3, { createdAt: "2026-10-02T00:00:00.000Z" })];
  const base = {
    products: [product(5)],
    plans: [],
    lots: [stockLot("lot-old", 3, "2026-10-01"), stockLot("lot-new", 2, "2026-10-05")],
    history: [
      { id: "schedule-old", action: "schedule", jobId: "A", orderQuantity: 9, stockQuantity: 5, shipmentMode: "split", shipDate: "2026-11-01", at: "2026-10-03T00:00:00.000Z" },
      { id: "schedule-latest", action: "schedule", jobId: "A", orderQuantity: 4, stockQuantity: 3, shipmentMode: "split", shipDate: "2026-11-02", completionDate: "2026-11-12", at: "2026-10-04T00:00:00.000Z" },
      { id: "schedule-B", action: "schedule", jobId: "B", orderQuantity: 3, stockQuantity: 2, shipmentMode: "split", shipDate: "2026-11-03", at: "2026-10-05T00:00:00.000Z" },
      { id: "ship-reversed", action: "ship", orderJobId: "A", quantity: 2 },
      { id: "reverse-ship", action: "reverse", eventId: "ship-reversed" },
      { id: "ship-real", action: "ship", orderJobId: "A", quantity: 1 },
    ],
  };
  const result = api.project(base, jobs, { productFor: identify, today: "2026-10-20" });
  assert.equal(result.orders.length, 2);
  const orderA = result.orders.find(order => order.jobId === "A");
  const orderB = result.orders.find(order => order.jobId === "B");
  assert.equal(orderA.quantity, 4, "latest schedule preserves the customer quantity despite later manufacturing changes");
  assert.equal(orderA.shippedQuantity, 1, "reversed shipments do not count as shipped");
  assert.equal(orderA.remainingQuantity, 3);
  assert.equal(orderA.stockTargetQuantity, 2, "cumulative schedule target is reduced by actual shipment");
  assert.equal(orderA.allocatedQuantity, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(orderA.allocations.map(row => [row.lotId, row.quantity]))), [["lot-old", 2]]);
  assert.equal(orderB.allocatedQuantity, 2, "the next order receives only its target from remaining eligible FIFO stock");
  assert.deepEqual(JSON.parse(JSON.stringify(orderB.allocations.map(row => [row.lotId, row.quantity]))), [["lot-old", 1], ["lot-new", 1]]);
  assert.equal(orderB.shortageQuantity, 1);
  assert.equal(result.products[0].reservedQuantity, 4);
  assert.equal(result.products[0].availableQuantity, 1);
  assert.equal(result.products[0].orderQuantity, 6);
  assert.equal(result.products[0].shortageQuantity, 2, "product shortage sums order-level shortages when targets leave stock unallocated");
  assert.equal(base.lots[0].remainingQuantity, 3, "projection must not mutate the source stock snapshot");
});

test("project exposes manual production separately from customer quantity and handles closed orders", () => {
  const api = ordersApi();
  const open = job("A", 3, { stockPlannedQuantity: 0 });
  const archived = job("B", 8, { archived: true });
  const shipped = job("C", 10, { shippingStatus: "shipped", stockPlannedQuantity: 2 });
  const base = { products: [product(0)], plans: [{ jobId: "C", productId: "26001", quantity: 1, plannedQuantity: 2, receivedQuantity: 1 }], lots: [], history: [] };
  const result = api.project(base, [open, archived, shipped], { productFor: identify });
  assert.deepEqual(plain(result.orders.map(order => order.jobId)), ["A"]);
  assert.equal(result.orders[0].orderProductionQuantity, 3);
  assert.equal(result.productions.find(row => row.jobId === "A").quantity, 3);
  const closedProduction = result.productions.find(row => row.jobId === "C");
  assert.equal(closedProduction.orderProductionQuantity, 0);
  assert.equal(closedProduction.stockQuantity, 1, "a shipped order's remaining surplus plan can still enter inventory");
  assert.equal(closedProduction.quantity, 1);
  assert.equal(result.productions.some(row => row.jobId === "B"), false);
});

test("invalid Tezoe identity is surfaced as an issue instead of silently disappearing", () => {
  const api = ordersApi();
  const invalid = job("bad", 2, { productCode: "26002", product: "Tezoe スタンツェ 直上" });
  const nonTezoe = job("other", 2, { productCode: "", product: "別製品" });
  const result = api.project({ products: [product(0)], plans: [], lots: [], history: [] }, [invalid, nonTezoe], { productFor: identify });
  assert.equal(result.orders.length, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].jobId, "bad");
  assert.equal(result.issues[0].customer, invalid.customer);
  assert.equal(result.issues[0].serialNo, invalid.serialNo || "");
  assert.equal(result.issues[0].product, invalid.product);
  assert.equal(result.issues[0].productCode, invalid.productCode);
  assert.match(result.issues[0].message, /一致しません/);
});

test("invalid Tezoe manufacturing and stock-plan quantities are reported instead of normalized to zero", () => {
  const api = ordersApi();
  const invalidJobs = [
    job("negative", -1),
    job("fraction", 1.5),
    job("bad-plan", 5, { stockPlannedQuantity: -1 }),
    job("oversized-plan", 2, { stockPlannedQuantity: 3 }),
    job("shipped-invalid", -1, { shippingStatus: "shipped" }),
  ];
  const result = api.project({ products: [product(0)], plans: [], lots: [], history: [] }, invalidJobs, { productFor: identify });
  assert.equal(result.orders.length, 0);
  assert.equal(result.issues.length, invalidJobs.length - 1, "closed customer orders do not produce legacy identity/quantity warnings");
  assert.deepEqual(plain(result.issues.map(issue => issue.jobId)), invalidJobs.slice(0, -1).map(item => item.id));
});

test("schedule sequence wins over timestamp and history ordering when choosing latest customer demand", () => {
  const api = ordersApi();
  const base = {
    products: [product(0)], plans: [], lots: [],
    history: [
      { id: "uuid-new", action: "schedule", jobId: "A", orderQuantity: 7, stockQuantity: 4, shipmentMode: "split", at: "2026-10-01T00:00:00.000Z", sequence: 22 },
      { id: "uuid-old", action: "schedule", jobId: "A", orderQuantity: 5, stockQuantity: 2, shipmentMode: "together", at: "2026-10-02T00:00:00.000Z", sequence: 21 },
    ],
  };
  const result = api.project(base, [job("A", 3)], { productFor: identify });
  assert.equal(result.orders[0].quantity, 7);
  assert.equal(result.orders[0].stockTargetQuantity, 4);
  assert.equal(result.orders[0].shipmentMode, "split");
});

test("forecasts include only due production, dated orders through the cutoff, and conservatively include undated orders", () => {
  const api = ordersApi();
  const jobs = [
    job("A", 5, { stockPlannedQuantity: 1, dueDate: "2026-11-01" }),
    job("B", 3, { dueDate: "2026-11-20", createdAt: "2026-10-03T00:00:00.000Z" }),
    job("C", 2, { dueDate: "2026-11-30", createdAt: "2026-10-04T00:00:00.000Z" }),
  ];
  const base = {
    products: [product(2)],
    plans: [{ jobId: "A", productId: "26001", quantity: 1, plannedQuantity: 1, receivedQuantity: 0 }],
    lots: [],
    history: [
      { id: "schedule-A", action: "schedule", jobId: "A", orderQuantity: 5, stockQuantity: 1, shipmentMode: "split", shipDate: "2026-11-05", completionDate: "2026-11-01", at: "2026-10-10T00:00:00.000Z" },
      { id: "schedule-B", action: "schedule", jobId: "B", orderQuantity: 3, stockQuantity: 0, shipmentMode: "together", shipDate: "2026-11-15", completionDate: "2026-11-20", at: "2026-10-11T00:00:00.000Z" },
    ],
  };
  const projected = api.project(base, jobs, { productFor: identify });
  assert.equal(api.forecast(projected, "26001", "2026-11-03").incomingQuantity, 5, "stock plan plus order manufacturing due by cutoff");
  assert.deepEqual(plain(api.forecast(projected, "26001", "2026-11-03")), { incomingQuantity: 5, outgoingQuantity: 6, quantity: 1, undatedOrderQuantity: 2, futureReservedQuantity: 4, availableQuantity: -3 });
  assert.deepEqual(plain(api.forecast(projected, "26001", "2026-11-10")), { incomingQuantity: 5, outgoingQuantity: 7, quantity: 0, undatedOrderQuantity: 2, futureReservedQuantity: 3, availableQuantity: -3 });
  assert.deepEqual(plain(api.forecast(projected, "26001", "2026-11-30")), { incomingQuantity: 10, outgoingQuantity: 10, quantity: 2, undatedOrderQuantity: 2, futureReservedQuantity: 0, availableQuantity: 2 });
  assert.throws(() => api.forecast(projected, "26001", "2026-02-30"), /基準日/);
});

test("completed linked shipments are not deducted twice in future forecasts", () => {
  const api = ordersApi();
  const active = job("A", 5, { stockPlannedQuantity: 0 });
  const base = {
    products: [product(3)], plans: [], lots: [],
    history: [
      { id: "ship-1", action: "ship", orderJobId: "A", quantity: 2 },
      { id: "schedule-1", action: "schedule", jobId: "A", orderQuantity: 5, stockQuantity: 5, shipmentMode: "split", shipDate: "2026-11-01", at: "2026-10-10T00:00:00.000Z" },
    ],
  };
  let projected = api.project(base, [active], { productFor: identify });
  assert.equal(projected.orders[0].remainingQuantity, 3);
  assert.deepEqual(plain(api.forecast(projected, "26001", "2026-11-12")), { incomingQuantity: 5, outgoingQuantity: 3, quantity: 5, undatedOrderQuantity: 0, futureReservedQuantity: 0, availableQuantity: 5 });
  const closed = api.project(base, [job("A", 0, { shippingStatus: "shipped" })], { productFor: identify });
  assert.equal(closed.orders.length, 0);
  assert.equal(closed.productions.length, 0, "completed zero-quantity production should not be shown as stock supply");
  assert.deepEqual(plain(api.forecast(closed, "26001", "2026-11-12")), { incomingQuantity: 0, outgoingQuantity: 0, quantity: 3, undatedOrderQuantity: 0, futureReservedQuantity: 0, availableQuantity: 3 });
});

test("split forecasts separate scheduled stock shipment from production-completion shipment", () => {
  const api = ordersApi();
  const base = {
    products: [product(0)], productions: [],
    orders: [{
      productId: "26001", remainingQuantity: 5, stockTargetQuantity: 2,
      hasSchedule: true, shipmentMode: "split", shipDate: "2026-10-21", completionDate: "2026-11-12",
    }],
  };
  assert.equal(api.forecast(base, "26001", "2026-10-20").outgoingQuantity, 0);
  assert.equal(api.forecast(base, "26001", "2026-10-21").outgoingQuantity, 2);
  assert.equal(api.forecast(base, "26001", "2026-11-11").outgoingQuantity, 2);
  assert.equal(api.forecast(base, "26001", "2026-11-12").outgoingQuantity, 5);
  const afterStockShipment = {
    ...base,
    orders: [{ ...base.orders[0], remainingQuantity: 3, stockTargetQuantity: 0 }],
  };
  assert.equal(api.forecast(afterStockShipment, "26001", "2026-10-21").outgoingQuantity, 0);
  assert.equal(api.forecast(afterStockShipment, "26001", "2026-11-12").outgoingQuantity, 3);
  const together = { ...base, orders: [{ ...base.orders[0], shipmentMode: "together" }] };
  assert.equal(api.forecast(together, "26001", "2026-10-21").outgoingQuantity, 5);
});

test("exact stock-only customers use total quantity as stock plan without creating customer orders", () => {
  const api = ordersApi();
  const stockJob = job("stock", 10, { customer: "　在庫用　", stockPlannedQuantity: 0, dueDate: "2026-11-01" });
  const similarCustomer = job("similar", 4, { customer: "在庫用分", stockPlannedQuantity: 0 });
  const base = {
    products: [product(0)],
    plans: [{ jobId: "stock", productId: "26001", quantity: 10, plannedQuantity: 10, receivedQuantity: 0 }],
    lots: [],
    history: [{ id: "stock-schedule", action: "schedule", jobId: "stock", orderQuantity: 0, stockQuantity: 0, shipmentMode: "split", shipDate: "", completionDate: "2026-11-01", at: "2026-10-20T00:00:00.000Z" }],
  };
  assert.equal(api.isStockOnly(stockJob), true);
  assert.equal(api.isStockOnly(similarCustomer), false);
  assert.equal(api.plannedQuantity(stockJob), 10);
  assert.equal(api.plannedQuantity(similarCustomer), 0);
  const result = api.project(base, [stockJob, similarCustomer], { productFor: identify });
  assert.deepEqual(plain(result.orders.map(row => row.jobId)), ["similar"]);
  const stockProduction = result.productions.find(row => row.jobId === "stock");
  assert.equal(stockProduction.quantity, 10);
  assert.equal(stockProduction.stockQuantity, 10);
  assert.equal(stockProduction.orderProductionQuantity, 0);
  assert.equal(stockProduction.orderQuantity, 0);
  assert.equal(stockProduction.shippingStatus, "waiting");
  assert.deepEqual(plain(api.forecast(result, "26001", "2026-10-31")), { incomingQuantity: 0, outgoingQuantity: 4, quantity: -4, undatedOrderQuantity: 4, futureReservedQuantity: 0, availableQuantity: -4 });
  assert.deepEqual(plain(api.forecast(result, "26001", "2026-11-01")), { incomingQuantity: 10, outgoingQuantity: 4, quantity: 6, undatedOrderQuantity: 4, futureReservedQuantity: 0, availableQuantity: 6 });
});

test("stock-only receipts reduce remaining supply and are not counted again in forecasts", () => {
  const api = ordersApi();
  const stockJob = job("stock", 10, { customer: "在庫", stockPlannedQuantity: 0, shippingStatus: "shipped", dueDate: "2026-11-01" });
  const base = {
    products: [product(3)],
    plans: [{ jobId: "stock", productId: "26001", quantity: 7, plannedQuantity: 10, receivedQuantity: 3 }],
    lots: [Object.assign(stockLot("received", 3, "2026-10-20"), { jobId: "stock" })],
    history: [],
  };
  const result = api.project(base, [stockJob], { productFor: identify });
  assert.equal(result.orders.length, 0);
  assert.equal(result.productions.length, 1, "an unfinished stock receipt remains visible even after the job is marked shipped");
  assert.equal(result.productions[0].quantity, 7);
  assert.equal(result.productions[0].stockQuantity, 7);
  assert.equal(result.productions[0].plannedQuantity, 10);
  assert.equal(result.productions[0].receivedQuantity, 3);
  assert.equal(result.productions[0].orderProductionQuantity, 0);
  assert.deepEqual(plain(api.forecast(result, "26001", "2026-10-31")), { incomingQuantity: 0, outgoingQuantity: 0, quantity: 3, undatedOrderQuantity: 0, futureReservedQuantity: 0, availableQuantity: 3 });
  assert.deepEqual(plain(api.forecast(result, "26001", "2026-11-01")), { incomingQuantity: 7, outgoingQuantity: 0, quantity: 10, undatedOrderQuantity: 0, futureReservedQuantity: 0, availableQuantity: 10 });
});

test("stock-only schedules with customer demand are flagged, while customer labels remain exact", () => {
  const api = ordersApi();
  const stockJob = job("stock", 10, { customer: "在庫用" });
  const normalStockNamedJob = job("normal", 10, { customer: "在庫品販売先" });
  const base = {
    products: [product(0)], plans: [], lots: [],
    history: [{ id: "bad-stock-schedule", action: "schedule", jobId: "stock", orderQuantity: 10, stockQuantity: 0, shipmentMode: "together", shipDate: "2026-11-12", sequence: 1 }],
  };
  const result = api.project(base, [stockJob, normalStockNamedJob], { productFor: identify });
  assert.equal(result.orders.some(row => row.jobId === "stock"), false);
  assert.equal(result.orders.find(row => row.jobId === "normal").quantity, 10);
  const issue = result.issues.find(row => row.jobId === "stock");
  assert.match(issue.message, /注文数量0/);
  assert.equal(issue.customer, stockJob.customer);
});

test("stock committed to a later shipment remains unavailable for a new order before its shipping date", () => {
  const api = ordersApi();
  const snapshot = { products: [product(5)], productions: [], orders: [{ productId: "26001", remainingQuantity: 5, stockTargetQuantity: 5, hasSchedule: true, shipmentMode: "together", shipDate: "2026-12-01" }] };
  const before = api.forecast(snapshot, "26001", "2026-11-01");
  assert.equal(before.quantity, 5);
  assert.equal(before.futureReservedQuantity, 5);
  assert.equal(before.availableQuantity, 0);
  const after = api.forecast(snapshot, "26001", "2026-12-01");
  assert.equal(after.quantity, 0);
  assert.equal(after.futureReservedQuantity, 0);
  assert.equal(after.availableQuantity, 0);
});
