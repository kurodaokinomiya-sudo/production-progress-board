import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all([
  "src/finished-stock.js", "apps-script/Config.gs", "apps-script/Parser.gs", "apps-script/Repository.gs", "apps-script/FinishedStock.gs",
].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
sources[0] = `${await readFile(new URL("../src/finished-stock-orders.js", import.meta.url), "utf8")}\n${sources[0]}`;
const source = sources.join("\n");
const copy = value => JSON.parse(JSON.stringify(value));
const at = "2026-10-20T00:00:00.000Z";
const fullReturn = (quantity = 10) => ({ sentQuantity: quantity, returnedQuantity: quantity, history: [
  { requestId: "sent", action: "send", quantity, at: "2026-10-18T00:00:00.000Z" },
  { requestId: "returned", action: "return", quantity, at: "2026-10-19T00:00:00.000Z" },
] });
const productJob = (extra = {}) => ({
  id: "J-1", customer: "田中医科", product: "Tezoe スタンツェ 直上", productCode: "26001", specShape: "直・上向", bladeWidth: "赤",
  dueDate: "2026-11-12", quantity: 10, stockPlannedQuantity: 5, serialNo: "26-1", archived: false, version: 3,
  stages: { welding: { status: "done", assignee: "豊" }, base: { status: "done", assignee: "幹" }, grinding: { status: "done", assignee: "望" }, heat: { status: "done", assignee: "鈴" }, finish: { status: "done", assignee: "河" } },
  polishing: fullReturn(extra.quantity === undefined ? 10 : extra.quantity), ...extra,
});
function pureContext() {
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, Array, JSON, Error, isFinite, parseInt });
  vm.runInContext(sources[0], context);
  return context.FinishedStock;
}
function pureHarness(jobs = [productJob()]) {
  const stock = pureContext();
  const events = [];
  let serial = 0;
  const mutate = (action, input) => {
    const result = stock.prepareMutation(action, input, { jobs, events, at, actor: "editor@example.com", id: `event-${++serial}` });
    if (result.event) events.push(result.event);
    return result;
  };
  const input = (extra = {}) => ({ expectedVersion: events.length, requestId: `req-${serial + 1}`, ...extra });
  return { stock, jobs, events, mutate, input };
}

test("stock plan quantities are bounded and supported Tezoe identity is exact", () => {
  const stock = pureContext();
  assert.equal(stock.normalizePlannedQuantity(undefined, 10), 0);
  assert.equal(stock.normalizePlannedQuantity(5, 10), 5);
  assert.throws(() => stock.normalizePlannedQuantity(11, 10), /製造総数量以下/);
  assert.throws(() => stock.normalizePlannedQuantity(1.5, 10), /整数/);
  assert.throws(() => stock.validateJob(productJob({ productCode: "26012" }), null, []), /型|刃向き|刃幅|番号/);
  assert.throws(() => stock.validateJob(productJob({ product: "Tezoe 26002 スタンツェ 直上" }), null, []), /番号と品名|刃向き/);
  assert.throws(() => stock.validateJob(productJob({ specShape: "直・上向・弱弯" }), null, []), /型/);
  assert.throws(() => stock.validateJob(productJob({ productCode: "35002", product: "Tezoe ケリソン", specShape: "直・上向25°", bladeWidth: "紫" }), null, []), /角度/);
  assert.throws(() => stock.validateJob(productJob({ productCode: "35002", product: "Tezoe スタンツェ", specShape: "直・上向35°", bladeWidth: "紫" }), null, []), /種類/);
  assert.throws(() => stock.validateJob(productJob({ product: "別製品" }), null, []), /Tezoe/);
  assert.equal(stock.CATALOG.length, 7);
});

test("N01 save relevance follows normalized product identity and the previous job", () => {
  const stock = pureContext();
  for (const brand of ["Tezoe", "tezoe", "TEZOE", "Ｔｅｚｏｅ"]) {
    const job = productJob({ product: `${brand} スタンツェ 直・上向`, stockPlannedQuantity: 0 });
    assert.equal(stock.needsJobValidation(job, null), true);
    assert.equal(stock.productFor(job).id, "26001");
    assert.equal(stock.needsJobValidation({ product: "別製品" }, job), true);
    assert.throws(() => stock.validateJob({ ...job, productCode: "26002", stockPlannedQuantity: 1 }, job, []), /製品番号|刃向き/);
    assert.throws(() => stock.validateJob({ ...job, specShape: "強弯", stockPlannedQuantity: 1 }, job, []), /型/);
  }
  assert.equal(stock.needsJobValidation({ product: "鋭匙鉗子", stockPlannedQuantity: 0 }, null), false);
  assert.equal(stock.needsJobValidation({ product: "鋭匙鉗子", stockPlannedQuantity: 1 }, null), true);
  const wideStock = productJob({ customer: "在庫用", product: "Ｔｅｚｏｅ スタンツェ 直・上向", stockPlannedQuantity: 0 });
  assert.equal(stock.snapshot({ jobs: [wideStock], events: [] }).plans[0].quantity, wideStock.quantity);
});

test("Tezoe以外の在庫用案件は製品在庫の補充計画へ混入しない", () => {
  const stock = pureContext();
  const ordinary = productJob({ id: "OTHER-STOCK", customer: "在庫用", product: "鋭匙鉗子 直", productCode: "OTHER", bladeWidth: "2mm", stockPlannedQuantity: 0 });
  const tezoe = productJob({ id: "TEZOE-STOCK", customer: "在庫用", quantity: 6, stockPlannedQuantity: 0 });
  assert.doesNotThrow(() => stock.validateJob(ordinary, null, []));
  const result = stock.snapshot({ jobs: [ordinary, tezoe], events: [] });
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].jobId, tezoe.id);
  assert.equal(result.plans[0].plannedQuantity, 6);
  assert.equal(result.orders.length, 0);
});

test("due-date stock plans do not become physical stock and split order quantity from total production", () => {
  const stock = pureContext();
  const snap = stock.snapshot({ jobs: [productJob()], events: [] });
  assert.equal(snap.products[0].stockQuantity, 0);
  assert.equal(snap.products[0].stockRegistered, false);
  assert.equal(snap.products[0].plannedQuantity, 5);
  assert.equal(snap.products[0].nextDueDate, "2026-11-12");
  assert.equal(snap.plans[0].totalQuantity, 10);
  assert.equal(snap.plans[0].orderQuantity, 5);
  assert.equal(snap.products[0].orderQuantity, 5);
  assert.equal(snap.products[0].shortageQuantity, 5);
  assert.equal(snap.plans[0].quantity, 5);
  assert.equal(snap.plans[0].finishReady, true);
  assert.equal(stock.snapshot({ jobs: [productJob({ archived: true })], events: [] }).plans.length, 0);
});

test("deleted Tezoe replenishment jobs do not leave inventory warnings for uneditable orders", () => {
  const stock = pureContext();
  const deleted = productJob({ id: "deleted-stock", customer: "在庫用", product: "Tezoeスタンツェ26021", productCode: "26021", stockPlannedQuantity: 0, archived: true });
  const active = productJob({ id: "active-order", productCode: "26002", stockPlannedQuantity: 0 });
  const shipped = productJob({ id: "shipped-stock", customer: "在庫", stockPlannedQuantity: 0, shippingStatus: "shipped" });
  const snapshot = stock.snapshot({ jobs: [deleted, active, shipped], events: [] });
  assert.deepEqual(copy(snapshot.issues.map(issue => issue.jobId)), [active.id]);
  assert.match(snapshot.issues[0].message, /製品番号/);
  assert.deepEqual(copy(snapshot.productions.map(plan => plan.jobId)), [shipped.id]);
  assert.equal(snapshot.productions[0].stockQuantity, shipped.quantity);
});

test("opening stock is explicit, records unknown provenance, and rejects future dates", () => {
  const h = pureHarness([]);
  const opened = h.mutate("opening", h.input({ productId: "26001", quantity: 3, date: "2026-10-18", note: "手元現物を確認", lotNo: "棚A" }));
  assert.equal(opened.snapshot.products[0].stockQuantity, 3);
  assert.equal(opened.snapshot.products[0].stockRegistered, true);
  assert.equal(opened.snapshot.lots[0].unknownOrigin, true);
  assert.equal(h.stock.validateJob(productJob({ id: undefined }), null, h.events), 5, "unlinked opening lots must not be attributed to a new unsaved job");
  assert.throws(() => h.mutate("opening", h.input({ productId: "26001", quantity: 1, date: "2026-10-22", note: "先行入力" })), /今日まで/);
  assert.throws(() => h.mutate("opening", h.input({ productId: "26001", quantity: 1, date: "2026-10-18", note: "未来製造", productionDate: "2026-10-21" })), /製造日は今日まで/);
  assert.throws(() => h.mutate("opening", h.input({ productId: "26001", quantity: 1, date: "2026-10-18" })), /理由/);
});

const customJob = (extra = {}) => productJob({
  product: "Tezoe 特注スタンツェ", productCode: "26031", specLength: "21cm",
  specShape: "側弯・上向", bladeWidth: "黄", stockPlannedQuantity: 0, ...extra,
});

test("contradictory embedded Tezoe codes never create a new stock identity", () => {
  const stock = pureContext();
  for (const product of ["Tezoeスタンツェ２６００１", "Tezoe 26001 特注スタンツェ", "TEZOE26001 試作"]) {
    for (const stockPlannedQuantity of [0, 2]) {
      const job = customJob({ product, productCode: "２６０３１", stockPlannedQuantity });
      assert.throws(() => stock.validateJob(job, null, []), /26001.*26031/);
      const result = stock.snapshot({ jobs: [job], events: [] });
      assert.equal(result.issues.length, 1);
      assert.equal(result.orders.length, 0);
      assert.equal(result.plans.length, 0);
      assert.equal(result.products.some(row => row.custom), false);
    }
  }
  assert.equal(stock.productFor(customJob({ product: "Ｔｅｚｏｅ 特注２６０３１", productCode: "２６０３１" })).code, "26031");
  assert.ok(stock.productFor(customJob({ productCode: "" })).custom);
});

test("one inconsistent replenishment remains editable and leaves other orders and reservations usable", () => {
  const bad = productJob({ id: "legacy-stock", customer: "在庫用", productCode: "26002", stockPlannedQuantity: 0 });
  const good = productJob({ id: "customer-order" });
  const h = pureHarness([bad, good, { ...bad, id: "deleted", archived: true }]);
  const result = h.mutate("opening", h.input({ productId: "26001", quantity: 4, date: "2026-10-20", note: "棚卸" })).snapshot;
  assert.deepEqual(copy(result.issues.map(row => row.jobId)), [bad.id]);
  assert.deepEqual(copy(result.orders.map(row => [row.jobId, row.allocatedQuantity])), [[good.id, 4]]);
  assert.deepEqual(copy(result.productions.map(row => row.jobId)), [good.id]);
  const corrected = { ...bad, productCode: "26001" };
  assert.equal(h.stock.validateJob(corrected, bad, h.events), corrected.quantity);
  const fixed = h.stock.snapshot({ jobs: [corrected, good], events: h.events });
  assert.equal(fixed.issues.length, 0);
  assert.equal(fixed.plans.find(row => row.jobId === bad.id).quantity, corrected.quantity);
});

test("historic mismatched custom stock can be reviewed and reversed without new movements", () => {
  const job = customJob({ product: "Tezoe 特注スタンツェ 26001", stockPlannedQuantity: 4 });
  const h = pureHarness([job]);
  const definition = Object.fromEntries(["productCode", "product", "specLength", "specShape", "bladeWidth"].map(field => [field, job[field]]));
  const legacyId = "tezoe-" + h.stock.hash(Object.values(definition).map(value => value.toLowerCase()));
  h.events.push({ action: "receive", id: "legacy-receipt", requestId: "previous-request", requestHash: "e".repeat(64), at,
    date: "2026-10-19", quantity: 2, jobId: job.id, productId: legacyId, productDefinition: definition });
  const original = copy(h.events);
  const product = h.stock.snapshot({ jobs: h.jobs, events: h.events }).products.find(row => row.id === legacyId);
  assert.equal(product.stockQuantity, 2);
  assert.match(product.identityIssue, /26001.*26031/);
  assert.throws(() => h.mutate("opening", h.input({ productId: legacyId, quantity: 1, date: "2026-10-20", note: "棚卸" })), /26001.*26031/);
  assert.throws(() => h.mutate("ship", h.input({ productId: legacyId, quantity: 1, date: "2026-10-20", customer: "顧客", orderRef: "1", purpose: "sale" })), /26001.*26031/);
  const corrected = { ...job, productCode: "26001" };
  assert.throws(() => h.stock.validateJob(corrected, job, h.events), /受領済み/);
  const reversed = h.mutate("reverse", h.input({ eventId: "legacy-receipt", date: "2026-10-20", note: "番号訂正" }));
  assert.deepEqual(h.events.slice(0, 1), original);
  assert.equal(reversed.snapshot.products.find(row => row.id === legacyId).stockQuantity, 0);
  assert.equal(h.stock.validateJob(corrected, job, h.events), 4);
});

test("new and custom Tezoe variants register automatically with separate exact identities", () => {
  const stock = pureContext();
  const jobs = [
    customJob({ id: "new-shape" }),
    customJob({ id: "another-width", bladeWidth: "3mm" }),
    customJob({ id: "without-code", productCode: "", specShape: "特注・左向" }),
  ];
  const result = stock.snapshot({ jobs, events: [] });
  assert.deepEqual(copy(result.issues), []);
  const products = result.products.filter(product => product.custom);
  assert.equal(products.length, 3);
  assert.equal(new Set(products.map(product => product.id)).size, 3);
  assert.ok(products.every(product => !product.stockRegistered && product.plannedQuantity === 0));
  assert.equal(result.orders.length, 3);
  assert.equal(stock.productFor({ ...jobs[0], customer: "別の得意先", note: "別の注文備考" }).id, products[0].id);
  assert.notEqual(stock.productFor({ ...jobs[0], specLength: "23cm" }).id, products[0].id);
  assert.notEqual(stock.productFor({ ...jobs[0], specShape: "側弯・下向" }).id, products[0].id);
  const customWithStandardCode = stock.productFor(customJob({ productCode: "26001" }));
  assert.notEqual(customWithStandardCode.id, stock.productFor(productJob()).id);
  assert.equal(customWithStandardCode.custom, true);
});

test("custom Tezoe stock can be added, retried, shipped and reversed after the source job changes", () => {
  const h = pureHarness([customJob()]);
  const productId = h.stock.productFor(h.jobs[0]).id;
  const request = h.input({ productId, quantity: 4, date: "2026-10-18", note: "特注品の現物確認" });
  const received = h.mutate("opening", request);
  assert.equal(received.snapshot.products.find(product => product.id === productId).stockQuantity, 4);
  assert.equal(h.mutate("opening", request).retry, true);
  h.jobs[0] = customJob({ archived: true, specShape: "特注・右向" });
  const reloaded = h.stock.snapshot({ jobs: h.jobs, events: h.events });
  assert.equal(reloaded.products.find(product => product.id === productId).stockQuantity, 4);
  assert.deepEqual(copy(reloaded.issues), []);
  const shipped = h.mutate("ship", h.input({
    productId, quantity: 1, date: "2026-10-20", customer: "特注先", orderRef: "CUSTOM-1", purpose: "sale",
  }));
  assert.equal(shipped.snapshot.products.find(product => product.id === productId).stockQuantity, 3);
  const reversed = h.mutate("reverse", h.input({ eventId: shipped.event.id, date: "2026-10-20", note: "数量訂正" }));
  assert.equal(reversed.snapshot.products.find(product => product.id === productId).stockQuantity, 4);
  assert.equal(h.stock.snapshot({ jobs: [], events: h.events }).products.find(product => product.id === productId).stockQuantity, 4);
  const corrupt = copy(h.events);
  corrupt[0].productDefinition.specShape = "別仕様";
  assert.throws(() => h.stock.snapshot({ jobs: [], events: corrupt }), /製品|仕様/);
});

test("custom Tezoe replenishment and order shipment follow the existing stock and job safeguards", () => {
  const h = pureHarness([customJob({ stockPlannedQuantity: 5 })]);
  const productId = h.stock.productFor(h.jobs[0]).id;
  assert.equal(h.stock.snapshot({ jobs: h.jobs, events: [] }).plans[0].productId, productId);
  h.mutate("schedule", h.input({ jobId: "J-1", jobVersion: 3, orderQuantity: 5, stockQuantity: 2, shipmentMode: "split" }));
  const received = h.mutate("receive", h.input({
    jobId: "J-1", jobVersion: 3, quantity: 5, date: "2026-10-20", productionDate: "2026-10-19", producers: ["河"],
  }));
  assert.equal(received.snapshot.products.find(product => product.id === productId).stockQuantity, 5);
  assert.throws(() => h.stock.validateJob({ ...h.jobs[0], specShape: "反対向き" }, h.jobs[0], h.events), /製品/);
  assert.throws(() => h.mutate("receive", h.input({
    jobId: "J-1", jobVersion: 2, quantity: 1, date: "2026-10-20", productionDate: "2026-10-19", producers: ["河"],
  })), /別の端末/);
  const shipped = h.mutate("ship", h.input({
    productId, orderJobId: "J-1", jobVersion: 3, quantity: 2, date: "2026-10-20", purpose: "sale",
  }));
  assert.equal(shipped.snapshot.orders[0].shippedQuantity, 2);
  assert.equal(shipped.snapshot.products.find(product => product.id === productId).stockQuantity, 3);
});

test("receipts require a ready job, immutable production facts, and cannot exceed the plan", () => {
  const h = pureHarness();
  const pending = productJob({ stages: { finish: { status: "working", assignee: "河" } } });
  h.jobs[0] = pending;
  assert.throws(() => h.mutate("receive", h.input({ jobId: "J-1", jobVersion: 3, quantity: 1, date: "2026-10-20", productionDate: "2026-10-19", producers: ["河"] })), /最終仕上げ完了後/);
  h.jobs[0] = productJob({ polishing: { sentQuantity: 2, returnedQuantity: 1 } });
  assert.throws(() => h.mutate("receive", h.input({ jobId: "J-1", jobVersion: 3, quantity: 1, date: "2026-10-20", productionDate: "2026-10-19", producers: ["河"] })), /最終仕上げ完了後/);
  for (const polishing of [undefined, { sentQuantity: 0, returnedQuantity: 0 }, { sentQuantity: 2, returnedQuantity: 2 }, { sentQuantity: 10, returnedQuantity: 11 }, { sentQuantity: Infinity, returnedQuantity: Infinity }, { sentQuantity: -1, returnedQuantity: -1 }, { sentQuantity: "10", returnedQuantity: "10" }]) {
    h.jobs[0] = productJob({ polishing });
    assert.equal(h.stock.snapshot({ jobs: h.jobs, events: h.events }).plans[0].finishReady, false);
    assert.throws(() => h.mutate("receive", h.input({ jobId: "J-1", jobVersion: 3, quantity: 1, date: "2026-10-20", productionDate: "2026-10-19", producers: ["河"] })), /最終仕上げ完了後/);
  }
  h.jobs[0] = productJob({ shippingStatus: "shipped" });
  const receive = (quantity, requestId) => h.mutate("receive", h.input({ jobId: "J-1", jobVersion: 3, quantity, date: "2026-10-20", productionDate: "2026-10-19", producers: "河・鈴", lotNo: requestId, requestId }));
  receive(3, "receive-1");
  receive(2, "receive-2");
  assert.equal(h.stock.snapshot({ jobs: h.jobs, events: h.events }).plans[0].quantity, 0);
  assert.equal(h.stock.snapshot({ jobs: h.jobs, events: h.events }).products[0].stockQuantity, 5);
  assert.equal(h.stock.snapshot({ jobs: h.jobs, events: h.events }).lots[0].producers.join("/"), "河/鈴");
  assert.equal(h.stock.snapshot({ jobs: h.jobs, events: h.events }).lots[0].unknownOrigin, false);
  assert.deepEqual(copy(h.stock.snapshot({ jobs: h.jobs, events: h.events }).lots[0].stageAssignees), { welding: "豊", base: "幹", grinding: "望", heat: "鈴", finish: "河" });
  assert.throws(() => receive(1, "receive-3"), /在庫受領数量/);
  assert.throws(() => h.mutate("receive", h.input({ jobId: "J-1", jobVersion: 2, quantity: 1, date: "2026-10-20", productionDate: "2026-10-19", producers: ["河"] })), /別の端末/);
  assert.throws(() => h.mutate("receive", h.input({ jobId: "J-1", jobVersion: 3, quantity: 1, date: "2026-10-20", productionDate: "2026-10-21", producers: ["河"] })), /製造日は今日まで/);
});

test("shipment is FIFO or selected-lot, records lot trace, and cannot oversell or predate receipt", () => {
  const h = pureHarness([]);
  h.mutate("opening", h.input({ productId: "26001", quantity: 2, date: "2026-10-10", productionDate: "2026-10-09", producers: ["豊"], lotNo: "old", note: "旧在庫を確認" }));
  h.mutate("opening", h.input({ productId: "26001", quantity: 3, date: "2026-10-15", productionDate: "2026-10-14", producers: ["幹"], lotNo: "new", note: "追加分を確認" }));
  const shipped = h.mutate("ship", h.input({ productId: "26001", quantity: 4, date: "2026-10-20", customer: "田中医科", orderRef: "受注A", purpose: "sale" }));
  assert.deepEqual(copy(shipped.event.allocations.map(row => [row.lotNo, row.quantity])), [["old", 2], ["new", 2]]);
  assert.equal(shipped.event.allocations[0].unknownOrigin, false);
  assert.equal(shipped.snapshot.products[0].stockQuantity, 1);
  assert.throws(() => h.mutate("ship", h.input({ productId: "26001", quantity: 2, date: "2026-10-20", customer: "田中医科", orderRef: "受注B", purpose: "sale" })), /超えています/);
  assert.throws(() => h.mutate("ship", h.input({ productId: "26001", quantity: 1, date: "2026-10-09", customer: "田中医科", orderRef: "受注C", purpose: "sale" })), /入庫日・製造日以降/);
  assert.throws(() => h.mutate("ship", h.input({ productId: "26001", quantity: 1, date: "2026-10-21", customer: "田中医科", orderRef: "受注C2", purpose: "sale" })), /今日まで/);
  assert.throws(() => h.mutate("ship", h.input({ productId: "26001", quantity: 2, date: "2026-10-20", customer: "田中医科", orderRef: "受注D", purpose: "sale", lotId: "event-2" })), /超えています/);
});

test("reversal preserves history and restores shipment while preventing reversal of used lots", () => {
  const h = pureHarness([]);
  const opened = h.mutate("opening", h.input({ productId: "26001", quantity: 5, date: "2026-10-10", note: "現物確認" }));
  const shipped = h.mutate("ship", h.input({ productId: "26001", quantity: 2, date: "2026-10-20", customer: "田中医科", orderRef: "受注A", purpose: "sale" }));
  assert.throws(() => h.mutate("reverse", h.input({ eventId: opened.event.id, date: "2026-10-20", note: "訂正" })), /出荷済み/);
  assert.throws(() => h.mutate("reverse", h.input({ eventId: shipped.event.id, date: "2026-10-21", note: "未来取消" })), /今日まで/);
  const reversed = h.mutate("reverse", h.input({ eventId: shipped.event.id, date: "2026-10-20", note: "出荷入力を訂正" }));
  assert.equal(reversed.snapshot.products[0].stockQuantity, 5);
  assert.equal(reversed.snapshot.history.length, 3);
  assert.equal(reversed.snapshot.history[0].action, "reverse");
});

test("idempotent retry succeeds before stale version checking and rejects changed content", () => {
  const h = pureHarness([]);
  const request = h.input({ productId: "26001", quantity: 2, date: "2026-10-10", note: "現物確認", requestId: "same-id" });
  h.mutate("opening", request);
  const retry = h.mutate("opening", { ...request, expectedVersion: 0 });
  assert.equal(retry.event, null);
  assert.equal(h.events.length, 1);
  assert.throws(() => h.mutate("opening", { ...request, quantity: 3 }), /同じリクエストID/);
  assert.throws(() => h.mutate("opening", { ...h.input({ productId: "26001", quantity: 1, date: "2026-10-10", note: "もう一度", expectedVersion: 0 }) }), /別の端末/);
});

test("product notes coexist with legacy movement history and leave stock, lots and forecasts alone", () => {
  const h = pureHarness();
  const opening = h.mutate("opening", h.input({ productId: "26001", quantity: 6, date: "2026-10-10", note: "現物確認" }));
  const baseline = opening.snapshot;
  const note = "検品見本は棚B\n左右の刃を確認";
  assert.equal(baseline.products[0].note, "");
  assert.equal(baseline.products[0].noteRevision, "");
  const input = { productId: "26001", note, expectedRevision: "", requestId: "product-note" };
  const { event, snapshot } = h.mutate("note", input);
  assert.equal(snapshot.products[0].note, note);
  assert.equal(snapshot.products[0].noteRevision, event.id);
  assert.equal(snapshot.products[1].note, "");
  assert.equal(snapshot.products[1].noteRevision, "");
  const { note: savedNote, noteRevision, ...stock } = snapshot.products[0];
  const { note: oldNote, noteRevision: oldRevision, ...oldStock } = baseline.products[0];
  assert.deepEqual(stock, oldStock);
  for (const key of ["history", "lots", "plans", "orders", "productions", "issues"]) assert.deepEqual(snapshot[key], baseline[key]);
  assert.equal(h.mutate("note", input).event, null);
  assert.throws(() => h.mutate("note", { ...input, note: "別の内容" }), /同じリクエストID/);
  assert.throws(() => h.mutate("note", { ...input, requestId: "different-note" }), /別の端末で製品の備考/);
  assert.throws(() => h.mutate("reverse", h.input({ eventId: event.id, date: "2026-10-20", note: "取消" })), /取消対象/);
  assert.equal(h.events.length, 2);
  const otherProduct = h.mutate("note", { productId: "26002", note: "別の製品", expectedRevision: "", requestId: "other-product-note" });
  assert.equal(otherProduct.snapshot.products[1].note, "別の製品");
  const clear = h.mutate("note", { ...input, note: "", expectedRevision: event.id, requestId: "clear-product-note" });
  assert.equal(clear.snapshot.products[0].note, "");
  assert.equal(clear.snapshot.products[0].noteRevision, clear.event.id);
});

test("a custom product note survives the removal of its source plan without registering stock", () => {
  const h = pureHarness([customJob()]);
  const productId = h.stock.productFor(h.jobs[0]).id;
  const input = { productId, note: "特注品は分けて保管", expectedRevision: "", requestId: "custom-note" };
  assert.throws(() => h.mutate("note", { ...input, productId: "arbitrary" }), /製品を選択/);
  assert.throws(() => h.mutate("note", { ...input, note: "長".repeat(1001) }), /1000文字以内/);
  assert.throws(() => h.mutate("note", { ...input, note: null }), /備考の内容/);
  h.mutate("note", input);
  const after = h.stock.snapshot({ jobs: [], events: h.events });
  const custom = after.products.find(row => row.id === productId);
  assert.equal(custom.note, input.note);
  assert.equal(custom.stockRegistered, false);
  assert.equal(custom.stockQuantity, 0);
  assert.equal(custom.plannedQuantity, 0);
  assert.equal(after.lots.length, 0);
  assert.equal(after.history.length, 0);
});

function serverHarness(initialRole = "editor") {
  let uuid = 0;
  let role = initialRole;
  const state = { failFlush: false, beforeLock: null };
  const grids = new Map();
  const lock = { held: false, waitLock() { assert.equal(this.held, false); this.held = true; if (state.beforeLock) { const callback = state.beforeLock; state.beforeLock = null; callback(); } }, releaseLock() { this.held = false; } };
  const access = () => ({ role, email: `${role}@example.com`, canEdit: ["owner", "admin", "editor"].includes(role), isOwner: role === "owner", isAdmin: ["owner", "admin"].includes(role), canWork: ["owner", "admin", "editor", "worker"].includes(role) });
  const sheetFor = name => {
    const grid = grids.get(name);
    if (!grid) return null;
    return {
      getLastRow: () => grid.length,
      getLastColumn: () => Math.max(0, ...grid.map(row => row.length)),
      getRange(row, col, height = 1, width = 1) {
        const values = () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => grid[row - 1 + r]?.[col - 1 + c] ?? ""));
        const range = {
          getValues: values, getDisplayValues: () => values().map(line => line.map(String)),
          setValues(rows) { assert.equal(lock.held, true, "finished-stock and job writes must hold the lock"); rows.forEach((line, r) => { grid[row - 1 + r] ||= []; line.forEach((value, c) => { grid[row - 1 + r][col - 1 + c] = value; }); }); return range; },
          setValue(value) { return range.setValues([[value]]); }, setFontWeight() { return range; }, setBackground() { return range; }, setFontColor() { return range; },
        };
        return range;
      },
      setFrozenRows() {}, autoResizeColumns() {},
    };
  };
  const spreadsheet = { getSheetByName: sheetFor, insertSheet(name) { grids.set(name, []); return sheetFor(name); } };
  const context = vm.createContext({
    Date, Math, Number, Object, RegExp, String, Array, JSON, Error, isFinite,
    requireEditorAccess_: () => { const caller = access(); if (!caller.canEdit) throw new Error("EDITOR_REQUIRED"); return caller; },
    requireWorkerAccess_: () => { const caller = access(); if (!caller.canWork) throw new Error("WORKER_REQUIRED"); return caller; },
    requireAppAccess_: access,
    Utilities: { getUuid: () => `uuid-${++uuid}`, formatDate: (date) => new Date(+date + 9 * 3600000).toISOString().slice(0, 10) },
    SpreadsheetApp: { flush() { if (state.failFlush) { state.failFlush = false; throw new Error("lost reply after write"); } } }, LockService: { getScriptLock: () => lock },
  });
  vm.runInContext(source, context);
  context.getSpreadsheet_ = () => spreadsheet;
  context.ensureSystem_ = () => {};
  context.appendLog_ = () => {};
  context.readSettings_ = () => ({});
  const fixture = productJob();
  const pending = context.normalizeJobInput_({ ...fixture, stages: { ...fixture.stages, finish: { status: "working", assignee: "河" } } }, null);
  grids.set(context.APP.SHEETS.JOBS, [[...context.APP.JOB_HEADERS], context.jobToRow_({ ...pending, stages: fixture.stages, polishing: fixture.polishing })]);
  return { context, grids, lock, state, job: () => context.readJobs_()[0], setRole(value) { role = value; } };
}

test("server RPCs require editor access, lock ledger writes, and retain job stock plan through worker process save", () => {
  const h = serverHarness("editor"), stock = h.context.getFinishedStock();
  assert.equal(stock.products[0].stockQuantity, 0);
  assert.equal(h.grids.has(h.context.APP.SHEETS.FINISHED_STOCK), false, "a read must not create or seed a ledger");
  const job = h.job();
  const opened = h.context.openFinishedStock({ expectedVersion: 0, requestId: "start", productId: "26001", quantity: 2, date: "2026-10-19", note: "開始在庫確認" });
  assert.equal(opened.products[0].stockQuantity, 2);
  assert.equal(h.lock.held, false);
  const jobSaved = h.context.saveJob({ ...job, requestId: "update-stock-plan", note: "updated" });
  assert.equal(jobSaved.stockPlannedQuantity, 5);
  const hWorker = serverHarness("worker");
  assert.throws(() => hWorker.context.getFinishedStock(), /EDITOR_REQUIRED/);
  assert.throws(() => hWorker.context.openFinishedStock({}), /EDITOR_REQUIRED/);
  for (const api of ["receiveFinishedStock", "shipFinishedStock", "reverseFinishedStock"]) assert.throws(() => hWorker.context[api]({}), /EDITOR_REQUIRED/);
  hWorker.setRole("editor");
  const readyJob = hWorker.job();
  const workerJob = hWorker.context.saveJobProcess({ id: readyJob.id, version: readyJob.version, stages: { finish: { status: "working", assignee: "河" } } });
  hWorker.setRole("worker");
  hWorker.context.saveJobProcess({ id: workerJob.id, version: workerJob.version, stages: { base: { status: "working", assignee: "豊" } } });
  assert.equal(hWorker.job().stockPlannedQuantity, 5);
});

test("server registers custom Tezoe from saved jobs and retains its product definition in the shared ledger", () => {
  const h = serverHarness();
  const saved = h.context.saveJob({ ...customJob(), version: h.job().version, requestId: "custom-save" });
  const inventory = h.context.getFinishedStock();
  assert.deepEqual(copy(inventory.issues), []);
  const custom = inventory.products.find(product => product.custom);
  assert.ok(custom);
  assert.equal(custom.stockRegistered, false);
  assert.equal(saved.productCode, "26031");
  const request = { expectedVersion: 0, requestId: "custom-opening", productId: custom.id, quantity: 2, date: "2026-10-19", note: "現物を確認" };
  h.state.failFlush = true;
  assert.throws(() => h.context.openFinishedStock(request), /lost reply/);
  h.context.openFinishedStock(request);
  const reloaded = h.context.getFinishedStock();
  assert.equal(reloaded.products.find(product => product.id === custom.id).stockQuantity, 2);
  assert.equal(reloaded.history.length, 1);
  assert.equal(reloaded.history[0].productDefinition.specShape, saved.specShape);
  assert.equal(h.grids.get(h.context.APP.SHEETS.FINISHED_STOCK).length, 2);
});

test("server note saves are editor-only, reject stale revisions and retry a committed note once", () => {
  const h = serverHarness("editor");
  const sheet = h.context.APP.SHEETS.FINISHED_STOCK;
  const input = { productId: "26001", note: "注意事項", expectedRevision: "", requestId: "note-save" };
  h.state.failFlush = true;
  assert.throws(() => h.context.saveFinishedStockNote(input), /lost reply/);
  const saved = h.context.saveFinishedStockNote(input);
  assert.equal(saved.products[0].note, input.note);
  assert.equal(saved.products[0].stockQuantity, 0);
  assert.equal(saved.history.length, 0);
  assert.equal(h.grids.get(sheet).length, 2);
  assert.throws(() => h.context.saveFinishedStockNote({ ...input, note: "古い下書き", requestId: "stale-note" }), /別の端末で製品の備考/);
  assert.equal(h.context.getFinishedStock().products[0].note, input.note);
  assert.equal(h.grids.get(sheet).length, 2);
  for (const role of ["viewer", "worker"]) {
    h.setRole(role);
    assert.throws(() => h.context.saveFinishedStockNote(input), /EDITOR_REQUIRED/);
  }
});

test("lost replies retry the committed event without duplication and stale versions recheck under the lock", () => {
  const h = serverHarness("editor");
  const request = { expectedVersion: 0, requestId: "retry-after-reply-loss", productId: "26001", quantity: 2, date: "2026-10-19", note: "開始在庫確認" };
  h.state.failFlush = true;
  assert.throws(() => h.context.openFinishedStock(request), /lost reply/);
  const rows = h.grids.get(h.context.APP.SHEETS.FINISHED_STOCK);
  assert.equal(rows.length, 2, "event row committed before the simulated response failure");
  const retry = h.context.openFinishedStock(request);
  assert.equal(retry.products[0].stockQuantity, 2);
  assert.equal(rows.length, 2);

  const fresh = serverHarness("editor");
  fresh.state.beforeLock = () => {
    const event = fresh.context.FinishedStock.prepareMutation("opening", {
      expectedVersion: 0, requestId: "concurrent", productId: "26001", quantity: 1, date: "2026-10-19", note: "別端末の記録"
    }, { events: [], jobs: [], at, actor: "other@example.com", id: "concurrent-event" }).event;
    fresh.grids.set(fresh.context.APP.SHEETS.FINISHED_STOCK, [[...fresh.context.FINISHED_STOCK_HEADERS_], [event.id, event.requestId, event.action, event.date, JSON.stringify(event)]]);
  };
  assert.throws(() => fresh.context.openFinishedStock({ expectedVersion: 0, requestId: "stale-client", productId: "26001", quantity: 1, date: "2026-10-19", note: "開始在庫" }), /別の端末/);
  assert.equal(fresh.grids.get(fresh.context.APP.SHEETS.FINISHED_STOCK).length, 2);
});

test("job saves cannot reduce planned quantity below received lots or change their product identity", () => {
  const h = serverHarness("editor"), job = h.job();
  h.context.openFinishedStock({ expectedVersion: 0, requestId: "opening", productId: "26001", quantity: 1, date: "2026-10-19", note: "初期在庫" });
  h.context.receiveFinishedStock({ expectedVersion: 1, requestId: "receive", jobId: job.id, jobVersion: job.version, quantity: 2, date: "2026-10-20", productionDate: "2026-10-19", producers: ["豊"] });
  const latest = h.job();
  assert.throws(() => h.context.saveJob({ ...latest, stockPlannedQuantity: 1, requestId: "too-small" }), /受領済み/);
  assert.throws(() => h.context.saveJob({ ...latest, productCode: "26002", specShape: "直・下向", bladeWidth: "青", requestId: "changed-product" }), /製品番号|型|受領済み/);
});

test("orders reserve stock once, capture customer demand across manufacturing changes, and linked shipments release demand once", () => {
  const job = productJob({ quantity: 5, stockPlannedQuantity: 0, createdAt: "2026-10-01T00:00:00Z", stages: { finish: { status: "working" } } });
  const h = pureHarness([job]);
  let result = h.mutate("opening", h.input({ productId: "26001", quantity: 2, date: "2026-10-19", note: "現物" }));
  assert.equal(result.snapshot.orders[0].allocatedQuantity, 2);
  assert.equal(result.snapshot.orders[0].shortageQuantity, 3);
  assert.equal(result.snapshot.products[0].availableQuantity, 0);
  const schedule = h.input({ jobId: job.id, jobVersion: 3, orderQuantity: 5, stockQuantity: 2, shipmentMode: "split", shipDate: "2026-10-20", completionDate: "2026-11-12" });
  h.mutate("schedule", schedule);
  assert.equal(h.mutate("schedule", schedule).retry, true);
  job.quantity = 3; job.version = 4;
  h.stock.validateJob(job, productJob({ quantity: 5, stockPlannedQuantity: 0 }), h.events);
  let snap = h.stock.snapshot({ jobs: h.jobs, events: h.events, at });
  assert.equal(snap.orders[0].quantity, 5, "manufacturing changes must not rewrite captured order quantity");
  assert.equal(snap.orders[0].totalQuantity, 3);
  const projection = vm.runInNewContext(`${sources[0]}\nFinishedStockOrders.forecast`, { Date, Math, Number, Object, RegExp, String, Array, JSON, Error, isFinite, parseInt });
  assert.equal(projection(snap, "26001", "2026-11-12").quantity, 0);
  assert.throws(() => h.mutate("ship", h.input({ productId: "26001", quantity: 1, date: "2026-10-20", customer: "他受注", orderRef: "他", purpose: "sale" })), /確保済み/);
  const ship = h.input({ productId: "26001", orderJobId: job.id, jobVersion: 4, quantity: 2, date: "2026-10-20", customer: "改ざん", orderRef: "改ざん", purpose: "sale" });
  result = h.mutate("ship", ship);
  assert.equal(result.event.customer, job.customer);
  assert.equal(result.event.orderJobId, job.id);
  assert.equal(result.snapshot.orders[0].remainingQuantity, 3);
  assert.equal(result.snapshot.products[0].stockQuantity, 0);
  assert.equal(projection(result.snapshot, "26001", "2026-11-12").quantity, 0, "shipment must not be deducted twice");
  assert.equal(h.mutate("ship", ship).retry, true);
  assert.throws(() => h.mutate("ship", h.input({ ...ship, expectedVersion: h.events.length, requestId: "overship", quantity: 1 })), /確保できる/);
  job.shippingStatus = "shipped";
  snap = h.stock.snapshot({ jobs: h.jobs, events: h.events, at });
  assert.equal(snap.orders.length, 0);
  assert.equal(projection(snap, "26001", "2026-11-12").quantity, 0);
});

test("schedule validates identities, stock targets, dates, stale jobs and together-shipment readiness", () => {
  const h = pureHarness([productJob({ quantity: 5, stockPlannedQuantity: 0, stages: { finish: { status: "working" } } })]);
  h.mutate("opening", h.input({ productId: "26001", quantity: 2, date: "2026-10-19", note: "現物" }));
  const data = { jobId: "J-1", jobVersion: 3, orderQuantity: 5, stockQuantity: 2, shipmentMode: "together", shipDate: "2026-11-12", completionDate: "2026-11-12" };
  for (const change of [{ orderQuantity: -1 }, { stockQuantity: 6 }, { stockQuantity: 1.5 }, { shipmentMode: "unknown" }, { shipDate: "2026-02-30" }, { shipDate: "2026-11-11" }, { jobVersion: 2 }]) {
    assert.throws(() => h.mutate("schedule", h.input({ ...data, ...change })), /FINISHED_STOCK_INVALID/);
  }
  h.mutate("schedule", h.input(data));
  const ship = { productId: "26001", orderJobId: "J-1", jobVersion: 3, quantity: 2, date: "2026-10-20", customer: "田中医科", orderRef: "受注", purpose: "sale" };
  assert.throws(() => h.mutate("ship", h.input(ship)), /製造完了後/);
  h.jobs[0].stages.finish.status = "done";
  h.mutate("ship", h.input(ship));
  assert.throws(() => h.mutate("schedule", h.input({ ...data, stockQuantity: 1 })), /在庫出荷予定数/);
});

test("server schedule RPC is editor-only and shipping completion cannot abandon a stock reservation", () => {
  const h = serverHarness("editor"), job = h.job();
  h.context.openFinishedStock({ expectedVersion: 0, requestId: "start-orders", productId: "26001", quantity: 2, date: "2026-10-19", note: "現物" });
  assert.throws(() => h.context.saveJob({ ...job, shippingStatus: "shipped", requestId: "premature-shipment" }), /在庫からの出荷予定分/);
  const payload = { expectedVersion: 1, requestId: "schedule-orders", jobId: job.id, jobVersion: job.version, orderQuantity: 5, stockQuantity: 0, shipmentMode: "split", shipDate: "", completionDate: "" };
  h.context.saveFinishedStockSchedule(payload);
  assert.equal(h.context.saveFinishedStockSchedule(payload).version, 2);
  h.context.saveJob({ ...job, shippingStatus: "shipped", requestId: "direct-production-shipment" });
  assert.equal(h.context.getFinishedStock().products[0].stockQuantity, 2);
  for (const role of ["viewer", "worker"]) { h.setRole(role); assert.throws(() => h.context.saveFinishedStockSchedule({}), /EDITOR_REQUIRED/); }
});

test("stock-only jobs replenish their whole quantity without a customer order or physical stock before receipt", () => {
  const h = serverHarness("editor"), original = h.job();
  const job = h.context.saveJob({ ...original, customer: "在庫用", quantity: 10, stockPlannedQuantity: 0, dueDate: "", requestId: "stock-only" });
  let snapshot = h.context.getFinishedStock();
  assert.equal(snapshot.orders.length, 0);
  assert.equal(snapshot.plans[0].quantity, 10);
  assert.equal(snapshot.productions[0].orderProductionQuantity, 0);
  assert.equal(snapshot.products[0].stockQuantity, 0);
  assert.throws(() => h.context.saveFinishedStockSchedule({ expectedVersion: 0, requestId: "false-order", jobId: job.id, jobVersion: job.version, orderQuantity: 1, stockQuantity: 1, shipmentMode: "split", shipDate: "", completionDate: "" }), /在庫用の製造/);
  h.context.saveFinishedStockSchedule({ expectedVersion: 0, requestId: "completion-only", jobId: job.id, jobVersion: job.version, orderQuantity: 0, stockQuantity: 0, shipmentMode: "split", shipDate: "", completionDate: "2026-11-25" });
  snapshot = h.context.receiveFinishedStock({ expectedVersion: 1, requestId: "stock-only-receipt", jobId: job.id, jobVersion: job.version, quantity: 3, date: "2026-10-20", productionDate: "2026-10-19", producers: ["豊"] });
  assert.equal(snapshot.products[0].stockQuantity, 3);
  assert.equal(snapshot.orders.length, 0);
  assert.equal(snapshot.plans[0].quantity, 7);
  assert.equal(snapshot.productions[0].quantity, 7);
  assert.equal(snapshot.productions[0].dueDate, "2026-11-25");
});
