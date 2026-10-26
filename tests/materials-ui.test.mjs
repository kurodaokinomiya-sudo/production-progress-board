import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/materials-ui.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

function node() {
  return {
    innerHTML: "", textContent: "", value: "", hidden: false, disabled: false, open: false, dataset: {}, listeners: new Map(),
    addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks); },
    async fire(type, extra = {}) { const event = { target: this, preventDefault() {}, ...extra }; for (const callback of this.listeners.get(type) || []) await callback(event); },
    setAttribute(name, value) { this[name] = value; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    showModal() { this.open = true; }, close() { this.open = false; },
  };
}

function stock(overrides = {}) {
  return {
    materials: [
      { id: "straight", code: "CK00128", name: "慈大式彫骨器", shape: "直", stockQuantity: -2, onOrderQuantity: 7, nextExpectedDate: "2026-10-24" },
      { id: "tezoe", code: "TEZOE", name: "Tezoe共通", shape: "共通", stockQuantity: 0, onOrderQuantity: 0 },
    ],
    orders: [{ id: "purchase-1", materialId: "straight", orderDate: "2026-10-20", quantity: 10, receivedQuantity: 3, remainingQuantity: 7, expectedDate: "2026-10-24", note: "分納" }],
    history: [
      { id: "opening-1", action: "opening", date: "2026-10-20", materialId: "straight", quantity: 1, note: "開始残高" },
      { id: "use-1", action: "use", date: "2026-10-21", materialId: "straight", quantity: -3, product: "慈大式彫骨器", customer: "ユフ", serialNo: "A1020", jobId: "job-1", actor: "担当A" },
    ],
    unresolved: [{ id: "job-check", product: "Tezoe", quantity: 2, specShape: "不明", reason: "型を確認してください" }],
    initializedAt: "2026-10-20T00:00:00Z", ...overrides,
  };
}

function harness(initial = stock()) {
  let editable = true;
  const elements = new Map();
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); };
  const panel = get('[data-view-panel="materials"]');
  const dialog = get("#material-dialog");
  const form = get("#material-form");
  const fields = ["materialId", "date", "quantity", "expectedDate", "note"];
  const inputs = fields.map((name) => { const input = node(); input.name = name; return input; });
  inputs.forEach((input) => { inputs[input.name] = input; });
  inputs.namedItem = (name) => inputs[name];
  form.elements = inputs;
  form.reset = () => inputs.forEach((input) => { input.value = ""; });
  elements.set("#material-form-material", inputs.materialId);
  const buttons = new Map(["refresh", "order", "close"].map((action) => [action, { ...node(), dataset: { materialAction: action } }]));
  panel.querySelectorAll = () => [buttons.get("refresh"), buttons.get("order")];
  panel.querySelector = (selector) => selector.includes("refresh") ? buttons.get("refresh") : null;
  dialog.querySelectorAll = () => [buttons.get("close")];
  const calls = { read: 0, mutations: [], errors: [], snapshots: [], jobs: [] };
  const api = { async getMaterialInventory() { calls.read += 1; return initial; } };
  for (const operation of ["saveMaterialOrder", "receiveMaterialOrder", "adjustMaterialStock", "cancelMaterialOrder"]) api[operation] = async (payload) => { calls.mutations.push({ operation, payload }); return initial; };
  const context = vm.createContext({ document: { readyState: "complete", querySelector: get }, crypto: { randomUUID: (() => { let count = 0; return () => `request-${++count}`; })() } });
  vm.runInContext(source, context);
  const ui = context.MaterialInventoryUI.create({ api, canEdit: () => editable, today: () => "2026-10-20", onSnapshot: (value) => calls.snapshots.push(value), onError: (message) => calls.errors.push(message), onJob: (id) => calls.jobs.push(id) });
  ui.setSnapshot(initial);
  return {
    ui, api, get, calls, dialog, form, inputs, buttons, setEditable(value) { editable = value; },
    async click(action, attributes = {}) { const button = { ...node(), dataset: { materialAction: action, ...attributes } }; const target = { closest: () => button }; await (action === "close" ? dialog : panel).fire("click", { target }); },
    submit: () => form.fire("submit"),
  };
}

test("materials UI loads without a DOM, fetches only when asked, and keeps domain policy out of the controller", async () => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  let reads = 0;
  const ui = context.MaterialInventoryUI.create({ canEdit: () => true, api: { async getMaterialInventory() { reads += 1; } } });
  ui.setSnapshot(stock());
  ui.render();
  assert.equal(await ui.refresh(), null);
  assert.equal(reads, 0);
  const h = harness();
  assert.equal(h.calls.read, 0);
  await h.ui.refresh();
  assert.equal(h.calls.read, 1);
  assert.equal(h.calls.snapshots.length, 1);
  assert.doesNotMatch(source, /CK00128|TEZOE26002|mapJob|localStorage|shippingStatus|productCode/);
});

test("dashboard distinguishes negative stock, zero stock, on-order quantities, next delivery and unresolved mappings", () => {
  const h = harness();
  const rows = h.get("#material-stock-rows").innerHTML;
  assert.match(rows, /material-stock-negative/);
  assert.match(rows, /不足 2 セット/);
  assert.match(rows, /material-stock-zero/);
  assert.match(rows, /在庫なし/);
  assert.match(rows, /2026-10-24/);
  assert.match(h.get("#material-order-rows").innerHTML, /分納/);
  assert.match(h.get("#material-order-rows").innerHTML, />7<\/strong>/);
  assert.equal(h.get("#material-unresolved").hidden, false);
  assert.match(h.get("#material-unresolved-list").innerHTML, /注文を確認・修正/);
  assert.match(h.get("#material-history-rows").innerHTML, /−3/);
});

test("purchase rows retain full receipts and cancellations and show only the linked receipt dates and quantities", () => {
  const data = stock({
    orders: [
      { id: "full", materialId: "straight", orderDate: "2026-10-15", quantity: 10, receivedQuantity: 10, remainingQuantity: 0, canceledQuantity: 0, expectedDate: "2026-10-19", note: "全数入庫済み" },
      { id: "partial", materialId: "straight", orderDate: "2026-10-20", quantity: 10, receivedQuantity: 3, remainingQuantity: 7, canceledQuantity: 0, expectedDate: "2026-10-24", note: "分納中" },
      { id: "cancel", materialId: "straight", orderDate: "2026-10-20", quantity: 5, receivedQuantity: 0, remainingQuantity: 0, canceledQuantity: 5, expectedDate: "2026-10-21", note: "未入庫取消" },
      { id: "waiting", materialId: "straight", orderDate: "2026-10-10", quantity: 5, receivedQuantity: 0, remainingQuantity: 5, canceledQuantity: 0, expectedDate: "2026-10-19", note: "未入庫の発注" },
      { id: "mixed", materialId: "straight", orderDate: "2026-10-18", quantity: 10, receivedQuantity: 4, remainingQuantity: 0, canceledQuantity: 6, expectedDate: "2026-10-18", note: "分納後取消" },
    ],
    history: [
      { id: "full-later", action: "receive", orderId: "full", materialId: "straight", date: "2026-10-17", quantity: 7 },
      { id: "partial-later", action: "receive", orderId: "partial", materialId: "straight", date: "2026-10-23", quantity: 2 },
      { id: "unrelated", action: "receive", orderId: "other", materialId: "straight", date: "2026-10-25", quantity: 999 },
      { id: "mismatched", action: "receive", orderId: "full", materialId: "tezoe", date: "2026-10-25", quantity: 999 },
      { id: "full-earlier", action: "receive", orderId: "full", materialId: "straight", date: "2026-10-16", quantity: 3 },
      { id: "partial-earlier", action: "receive", orderId: "partial", materialId: "straight", date: "2026-10-21", quantity: 1 },
      { id: "mixed-receipt", action: "receive", orderId: "mixed", materialId: "straight", date: "2026-10-19", quantity: 4 },
      { id: "cancel-event", action: "cancel", orderId: "cancel", materialId: "straight", date: "2026-10-20", quantity: 5 },
    ],
  });
  const original = JSON.stringify(data);
  const h = harness(data);
  const rows = h.get("#material-order-rows").innerHTML.match(/<tr[\s\S]*?<\/tr>/g);
  const rowFor = (note) => rows.find((row) => row.includes(note));
  assert.deepEqual(rows.map((row) => data.orders.find((order) => row.includes(order.note)).id), ["waiting", "partial", "cancel", "mixed", "full"]);
  assert.equal(h.get("#material-orders-count").textContent, "5件（入庫待ち 2件）");
  assert.match(rowFor("全数入庫済み"), /data-material-order-status="received"/);
  assert.match(rowFor("全数入庫済み"), /2026-10-16<\/span><span>3 セット[\s\S]*2026-10-17<\/span><span>7 セット/);
  assert.match(rowFor("分納中"), /一部入庫/);
  assert.match(rowFor("分納中"), /2026-10-21<\/span><span>1 セット[\s\S]*2026-10-23<\/span><span>2 セット/);
  assert.match(rowFor("未入庫の発注"), /予定日を過ぎています/);
  assert.match(rowFor("未入庫取消"), /入庫なし[\s\S]*取消 5 セット/);
  assert.match(rowFor("分納後取消"), /2026-10-19<\/span><span>4 セット[\s\S]*入庫済・残数取消[\s\S]*取消 6 セット/);
  for (const note of ["全数入庫済み", "未入庫取消", "分納後取消"]) {
    assert.doesNotMatch(rowFor(note), /data-material-action="(?:receive|cancel)"|予定日を過ぎています/);
  }
  assert.match(rowFor("分納中"), /data-material-action="receive"/);
  assert.doesNotMatch(h.get("#material-order-rows").innerHTML, /999 セット|2026-10-25/);
  assert.equal(JSON.stringify(data), original);
});

test("legacy received totals without date history are marked unknown and never use a planned date", () => {
  const h = harness(stock({
    orders: [{ id: "legacy", materialId: "straight", orderDate: "2026-10-20", quantity: 5, receivedQuantity: 5, remainingQuantity: 0, expectedDate: "2026-10-24" }],
    history: [{ id: "known", action: "receive", orderId: "legacy", materialId: "straight", date: "2026-10-22", quantity: 2 }],
  }));
  const receiptCell = h.get("#material-order-rows").innerHTML.match(/<td class="material-order-receipts">([\s\S]*?)<\/td>/)[1];
  assert.match(receiptCell, /2026-10-22<\/span><span>2 セット/);
  assert.match(receiptCell, /日付不明<\/span><span>3 セット/);
  assert.doesNotMatch(receiptCell, /2026-10-20|2026-10-24/);
  h.ui.setSnapshot(stock({ orders: [], history: [] }));
  assert.match(h.get("#material-order-rows").innerHTML, /colspan="9"[\s\S]*発注はまだありません/);
});

test("all dynamic names, identifiers, notes and history are escaped and history offers no mutation control", async () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const h = harness(stock({
    materials: [{ id: attack, name: attack, code: attack, shape: attack, specification: attack, stockQuantity: 2 }],
    orders: [{ id: attack, materialId: attack, note: attack, remainingQuantity: 1 }],
    unresolved: [{ id: attack, product: attack, specShape: attack, reason: attack }],
    history: [{ id: attack, materialId: attack, action: attack, date: attack, quantity: 1, product: attack, customer: attack, serialNo: attack, note: attack, actor: attack, jobId: attack }],
  }));
  for (const selector of ["#material-stock-rows", "#material-order-rows", "#material-history-rows", "#material-unresolved-list", "#material-history-material"]) {
    assert.doesNotMatch(h.get(selector).innerHTML, /<img|onerror="/);
    assert.match(h.get(selector).innerHTML, /&lt;img/);
  }
  assert.doesNotMatch(h.get("#material-history-rows").innerHTML, /data-material-action="(?:adjust|cancel|receive|delete|edit)"/);
  await h.click("order");
  assert.doesNotMatch(h.get("#material-form-material").innerHTML, /<img/);
  assert.match(h.get("#material-form-material").innerHTML, /&lt;img/);
});

test("history filters combine material, action and product/customer/serial search while preserving the snapshot", async () => {
  const h = harness();
  const filter = h.get("#material-history-material");
  filter.value = "straight";
  await filter.fire("change");
  const action = h.get("#material-history-action");
  action.value = "use";
  await action.fire("change");
  for (const needle of ["慈大式", "ユフ", "a1020", "Ａ１０２０"]) {
    const search = h.get("#material-history-search");
    search.value = needle;
    await search.fire("input");
    assert.equal(h.get("#material-history-count").textContent, "1 / 2件");
    assert.match(h.get("#material-history-rows").innerHTML, /ユフ/);
    assert.doesNotMatch(h.get("#material-history-rows").innerHTML, /開始残高/);
  }
  filter.value = "tezoe";
  await filter.fire("change");
  assert.match(h.get("#material-history-rows").innerHTML, /条件に合う履歴がありません/);
  assert.equal(h.calls.mutations.length, 0);
  await h.click("job", { materialJob: "job-check" });
  assert.deepEqual(h.calls.jobs, ["job-check"]);
});

test("history keeps one purchase row with every receipt and cancellation while stock movements stay separate", () => {
  const data = stock({
    orders: [{ id: "purchase-1", materialId: "straight", orderDate: "2026-10-10", quantity: 10, receivedQuantity: 7, remainingQuantity: 0, canceledQuantity: 3, note: "発注時の備考" }],
    history: [
      { id: "purchase-1", action: "order", materialId: "straight", date: "2026-10-10", quantity: 10, note: "発注時の備考", actor: "発注担当" },
      { id: "receipt-1", action: "receive", orderId: "purchase-1", materialId: "straight", date: "2026-10-12", quantity: 4, note: "初回の検品", actor: "入庫担当A" },
      { id: "receipt-2", action: "receive", orderId: "purchase-1", materialId: "straight", date: "2026-10-15", quantity: 3, note: "二回目の検品", actor: "入庫担当B" },
      { id: "cancel-1", action: "cancel", orderId: "purchase-1", materialId: "straight", date: "2026-10-16", quantity: 3, note: "残数を取消", actor: "取消担当" },
      { id: "opening-1", action: "opening", materialId: "straight", date: "2026-10-01", quantity: 2, note: "開始残高" },
      { id: "usage-1", action: "use", materialId: "straight", date: "2026-10-17", quantity: 2, product: "使用案件", jobId: "used-job" },
      { id: "adjustment-1", action: "adjust", materialId: "straight", date: "2026-10-18", quantity: -1, note: "棚卸し訂正" },
    ],
  });
  const before = JSON.stringify(data);
  const h = harness(data);
  const markup = h.get("#material-history-rows").innerHTML;
  const rows = markup.match(/<tr\b[\s\S]*?<\/tr>/g) || [];
  const grouped = rows.filter((row) => row.includes('data-material-history-order="purchase-1"'));
  assert.equal(grouped.length, 1);
  assert.equal(rows.length, 4, "a purchase and three inventory movements remain four logical rows");
  assert.equal(h.get("#material-history-count").textContent, "4 / 4件");
  assert.match(grouped[0], /2026-10-10/);
  assert.match(grouped[0], /2026-10-12[\s\S]*4 セット[\s\S]*2026-10-15[\s\S]*3 セット/);
  const groupedText = grouped[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const label of [/発注\s*10/, /入庫\s*7/, /残\s*0/, /取消\s*3/]) assert.match(groupedText, label);
  for (const value of ["発注時の備考", "発注担当", "初回の検品", "入庫担当A", "二回目の検品", "入庫担当B", "残数を取消", "取消担当", "2026-10-16"]) assert.ok(grouped[0].includes(value), value);
  for (const value of ["開始残高", "使用案件", "棚卸し訂正"]) assert.ok(rows.some((row) => !row.includes("data-material-history-order") && row.includes(value)), value);
  assert.doesNotMatch(markup, /data-material-action="(?:adjust|cancel|receive|delete|edit)"/);
  assert.equal(JSON.stringify(data), before);
  assert.equal(h.calls.mutations.length, 0);
});

test("history never merges receipts from other purchases or materials and retains unmatched records", () => {
  const h = harness(stock({
    orders: [
      { id: "first", materialId: "straight", orderDate: "2026-10-10", quantity: 5, receivedQuantity: 2, remainingQuantity: 3 },
      { id: "second", materialId: "straight", orderDate: "2026-10-11", quantity: 6, receivedQuantity: 3, remainingQuantity: 3 },
    ],
    history: [
      { id: "first", action: "order", orderId: "first", materialId: "straight", date: "2026-10-10", quantity: 5 },
      { id: "second", action: "order", orderId: "second", materialId: "straight", date: "2026-10-11", quantity: 6 },
      { id: "first-receipt", action: "receive", orderId: "first", materialId: "straight", date: "2026-10-12", quantity: 2, note: "一件目の入庫" },
      { id: "second-receipt", action: "receive", orderId: "second", materialId: "straight", date: "2026-10-13", quantity: 3, note: "二件目の入庫" },
      { id: "orphan", action: "receive", orderId: "unknown", materialId: "straight", date: "2026-10-14", quantity: 99, note: "対応発注のない記録" },
      { id: "wrong-material", action: "receive", orderId: "first", materialId: "tezoe", date: "2026-10-15", quantity: 88, note: "材料が異なる記録" },
    ],
  }));
  const rows = h.get("#material-history-rows").innerHTML.match(/<tr\b[\s\S]*?<\/tr>/g) || [];
  const first = rows.find((row) => row.includes('data-material-history-order="first"'));
  const second = rows.find((row) => row.includes('data-material-history-order="second"'));
  assert.equal(rows.length, 4);
  assert.match(first, /2026-10-12[\s\S]*2 セット/);
  assert.doesNotMatch(first, /二件目の入庫|対応発注のない記録|材料が異なる記録|99|88/);
  assert.match(second, /2026-10-13[\s\S]*3 セット/);
  assert.doesNotMatch(second, /一件目の入庫|対応発注のない記録|材料が異なる記録|99|88/);
  for (const note of ["対応発注のない記録", "材料が異なる記録"]) assert.ok(rows.some((row) => !row.includes("data-material-history-order") && row.includes(note)));
});

test("history filters and receipt searches select complete purchase rows without duplicating events", async () => {
  const data = stock({
    orders: [
      { id: "received", materialId: "straight", orderDate: "2026-10-10", quantity: 5, receivedQuantity: 3, remainingQuantity: 0, canceledQuantity: 2, note: "入庫のある発注" },
      { id: "waiting", materialId: "straight", orderDate: "2026-10-11", quantity: 6, receivedQuantity: 0, remainingQuantity: 6, note: "待機発注" },
    ],
    history: [
      { id: "received", action: "order", orderId: "received", materialId: "straight", date: "2026-10-10", quantity: 5, note: "入庫のある発注" },
      { id: "receive-1", action: "receive", orderId: "received", materialId: "straight", date: "2026-10-12", quantity: 1, note: "初回検品", actor: "受入担当" },
      { id: "receive-2", action: "receive", orderId: "received", materialId: "straight", date: "2026-10-14", quantity: 2, note: "分納検品" },
      { id: "cancel-1", action: "cancel", orderId: "received", materialId: "straight", date: "2026-10-15", quantity: 2, note: "残数取消" },
      { id: "waiting", action: "order", orderId: "waiting", materialId: "straight", date: "2026-10-11", quantity: 6, note: "待機発注" },
      { id: "adjust-1", action: "adjust", materialId: "straight", date: "2026-10-16", quantity: -1, note: "棚卸し" },
    ],
  });
  const before = JSON.stringify(data);
  const h = harness(data);
  const filter = h.get("#material-history-action");
  for (const [action, count] of [["order", 2], ["receive", 1], ["cancel", 1]]) {
    filter.value = action;
    await filter.fire("change");
    assert.equal(h.get("#material-history-count").textContent, `${count} / 3件`);
    const markup = h.get("#material-history-rows").innerHTML;
    assert.match(markup, /data-material-history-order="received"/);
    assert.match(markup, /初回検品[\s\S]*分納検品|分納検品[\s\S]*初回検品/);
    if (action !== "order") assert.doesNotMatch(markup, /待機発注/);
  }
  filter.value = "all";
  await filter.fire("change");
  const search = h.get("#material-history-search");
  for (const needle of ["分納検品", "受入担当"]) {
    search.value = needle;
    await search.fire("input");
    assert.equal(h.get("#material-history-count").textContent, "1 / 3件");
    const markup = h.get("#material-history-rows").innerHTML;
    assert.match(markup, /入庫のある発注/);
    assert.match(markup, /2026-10-12[\s\S]*1 セット[\s\S]*2026-10-14[\s\S]*2 セット/);
    assert.doesNotMatch(markup, /待機発注|棚卸し/);
  }
  assert.equal(JSON.stringify(data), before);
  assert.equal(h.calls.mutations.length, 0);
});

test("grouped purchase history escapes order identifiers and every event note and actor", () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const data = stock({
    orders: [{ id: attack, materialId: "straight", orderDate: "2026-10-10", quantity: 2, receivedQuantity: 2, remainingQuantity: 0, note: attack }],
    history: [
      { id: attack, action: "order", orderId: attack, materialId: "straight", date: "2026-10-10", quantity: 2, note: attack, actor: attack },
      { id: "received", action: "receive", orderId: attack, materialId: "straight", date: "2026-10-12", quantity: 2, note: attack, actor: attack },
    ],
  });
  const original = JSON.stringify(data);
  const h = harness(data);
  const markup = h.get("#material-history-rows").innerHTML;
  assert.equal((markup.match(/data-material-history-order=/g) || []).length, 1);
  assert.doesNotMatch(markup, /<img|onerror="/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /2026-10-12[\s\S]*2 セット/);
  assert.equal(JSON.stringify(data), original);
});

test("purchase input survives background snapshots and records order and expected delivery dates", async () => {
  const h = harness();
  await h.click("order", { materialId: "tezoe" });
  h.inputs.quantity.value = "12";
  h.inputs.expectedDate.value = "2026-10-25";
  h.inputs.note.value = "追加入荷";
  h.ui.setSnapshot(null);
  assert.equal(h.dialog.open, true);
  assert.equal(h.inputs.note.value, "追加入荷");
  h.ui.setSnapshot(stock());
  assert.equal(h.inputs.quantity.value, "12");
  assert.equal(h.inputs.materialId.value, "tezoe");
  await h.submit();
  assert.equal(h.calls.mutations[0].operation, "saveMaterialOrder");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.mutations[0].payload)), { materialId: "tezoe", orderDate: "2026-10-20", quantity: 12, expectedDate: "2026-10-25", note: "追加入荷", requestId: "material-request-1" });
  assert.equal(h.dialog.open, false);
  assert.equal(h.calls.snapshots.length, 1);
});

test("partial receipts require positive integer quantities within outstanding and a receipt date", async () => {
  const h = harness();
  await h.click("receive", { materialOrder: "purchase-1" });
  assert.equal(h.inputs.quantity.value, "7");
  assert.equal(h.inputs.quantity.max, "7");
  h.inputs.quantity.value = "8";
  await h.submit();
  assert.equal(h.calls.mutations.length, 0);
  assert.match(h.get("#material-form-status").textContent, /7 セット以内/);
  h.inputs.quantity.value = "2.5";
  await h.submit();
  assert.equal(h.calls.mutations.length, 0);
  h.inputs.quantity.value = "2";
  h.inputs.date.value = "2026-10-22";
  await h.submit();
  assert.equal(h.calls.mutations[0].operation, "receiveMaterialOrder");
  assert.equal(h.calls.mutations[0].payload.quantity, 2);
  assert.equal(h.calls.mutations[0].payload.date, "2026-10-22");
});

test("signed adjustments and outstanding cancellation require a reason, without inventing inventory movements", async () => {
  const h = harness();
  await h.click("adjust", { materialId: "straight" });
  h.inputs.quantity.value = "-2";
  await h.submit();
  assert.equal(h.calls.mutations.length, 0);
  assert.match(h.get("#material-form-status").textContent, /理由/);
  h.inputs.note.value = "棚卸しの差";
  await h.submit();
  assert.equal(h.calls.mutations[0].payload.quantity, -2);
  assert.equal(h.calls.mutations[0].operation, "adjustMaterialStock");
  await h.click("cancel", { materialOrder: "purchase-1" });
  assert.equal(h.get("#material-field-quantity").hidden, true);
  assert.match(h.get("#material-dialog-summary").textContent, /未入庫 7 セット/);
  await h.submit();
  assert.equal(h.calls.mutations.length, 1);
  h.inputs.note.value = "発注先と取消確認済み";
  await h.submit();
  assert.equal(h.calls.mutations[1].operation, "cancelMaterialOrder");
  assert.equal(h.calls.mutations[1].payload.note, "発注先と取消確認済み");
  assert.equal("quantity" in h.calls.mutations[1].payload, false);
});

test("unknown network failure retains inputs and request ID for retry even after a refresh confirms receipt", async () => {
  const h = harness();
  const payloads = [];
  h.api.receiveMaterialOrder = async (payload) => {
    payloads.push(payload);
    if (payloads.length === 1) throw new TypeError("Failed to fetch");
    return stock({ orders: [] });
  };
  await h.click("receive", { materialOrder: "purchase-1" });
  h.inputs.note.value = "荷物確認済み";
  await h.submit();
  assert.equal(h.dialog.open, true);
  assert.equal(h.inputs.quantity.value, "7");
  assert.equal(h.inputs.note.value, "荷物確認済み");
  assert.match(h.get("#material-form-status").textContent, /反映済みの可能性/);
  assert.equal(h.get("#material-submit").textContent, "同じ内容で再試行");
  h.ui.setSnapshot(stock({ orders: [] }));
  await h.submit();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].requestId, payloads[1].requestId);
  assert.equal(h.dialog.open, false);
  assert.equal(h.calls.snapshots.length, 1);
});

test("changed failed payload gets a new request ID; double-submit and pending close are blocked", async () => {
  const h = harness();
  const payloads = [];
  let finish;
  h.api.adjustMaterialStock = async (payload) => {
    payloads.push(payload);
    if (payloads.length === 1) throw new Error("数量を確認してください");
    return new Promise((resolve) => { finish = resolve; });
  };
  await h.click("adjust", { materialId: "straight" });
  h.inputs.quantity.value = "1";
  h.inputs.note.value = "戻し";
  await h.submit();
  h.inputs.quantity.value = "2";
  const inFlight = h.submit();
  await h.submit();
  await h.click("close");
  assert.equal(payloads.length, 2);
  assert.notEqual(payloads[0].requestId, payloads[1].requestId);
  assert.equal(h.dialog.open, true);
  assert.equal(h.inputs.note.disabled, true);
  assert.match(h.get("#material-form-status").textContent, /反映中/);
  finish(stock());
  await inFlight;
  assert.equal(h.dialog.open, false);
  assert.equal(h.inputs.note.disabled, false);
});

test("closing and reopening a failed adjustment restores its input and retains its retry identity", async () => {
  const h = harness();
  const payloads = [];
  h.api.adjustMaterialStock = async (payload) => {
    payloads.push(payload);
    if (payloads.length === 1) throw new TypeError("Network error");
    return stock();
  };
  await h.click("adjust", { materialId: "tezoe" });
  h.inputs.quantity.value = "4";
  h.inputs.note.value = "現物の返却";
  await h.submit();
  await h.click("close");
  assert.equal(h.dialog.open, false);
  await h.click("order", { materialId: "straight" });
  await h.click("close");
  await h.click("adjust", { materialId: "tezoe" });
  assert.equal(h.inputs.quantity.value, "4");
  assert.equal(h.inputs.note.value, "現物の返却");
  assert.equal(h.get("#material-submit").textContent, "同じ内容で再試行");
  await h.submit();
  assert.equal(payloads[0].requestId, payloads[1].requestId);
});

test("refresh deduplicates reads and invalidation queues a newer read before a stale result can replace it", async () => {
  const h = harness();
  const resolvers = [];
  h.api.getMaterialInventory = () => new Promise((resolve) => resolvers.push(resolve));
  const oldRead = h.ui.refresh();
  assert.equal(h.ui.refresh(), oldRead);
  h.ui.invalidate({ refresh: true });
  resolvers[0](stock({ materials: [{ id: "old", code: "STALE", stockQuantity: 99 }] }));
  await new Promise(setImmediate);
  assert.equal(resolvers.length, 2);
  resolvers[1](stock({ materials: [{ id: "latest", code: "LATEST", stockQuantity: 22 }] }));
  await oldRead;
  assert.match(h.get("#material-stock-rows").innerHTML, /LATEST/);
  assert.doesNotMatch(h.get("#material-stock-rows").innerHTML, /STALE/);
  const staleBeforeMutation = h.ui.refresh();
  await h.click("adjust", { materialId: "latest" });
  h.inputs.quantity.value = "1";
  h.inputs.note.value = "返却";
  h.api.adjustMaterialStock = async () => stock({ materials: [{ id: "latest", code: "SAVED", stockQuantity: 23 }] });
  await h.submit();
  resolvers[2](stock({ materials: [{ id: "old", code: "LATE", stockQuantity: 99 }] }));
  await staleBeforeMutation;
  assert.match(h.get("#material-stock-rows").innerHTML, /SAVED/);
  assert.doesNotMatch(h.get("#material-stock-rows").innerHTML, /LATE/);
});

test("permission is checked at fetch, opening, submit and render; revoked roles see no stored inventory data", async () => {
  const h = harness();
  await h.click("adjust", { materialId: "straight" });
  h.inputs.quantity.value = "1";
  h.inputs.note.value = "返却";
  h.setEditable(false);
  await h.submit();
  await h.ui.refresh();
  await h.click("job", { materialJob: "job-check" });
  assert.equal(h.calls.mutations.length, 0);
  assert.equal(h.calls.read, 0);
  assert.equal(h.calls.jobs.length, 0);
  h.ui.render();
  assert.equal(h.dialog.open, false);
  assert.equal(h.get('[data-view-panel="materials"]').hidden, true);
  for (const selector of ["#material-stock-rows", "#material-order-rows", "#material-history-rows", "#material-unresolved-list", "#material-form-material", "#material-history-material"]) assert.doesNotMatch(h.get(selector).innerHTML, /CK00128|Tezoe|purchase-1|job-check/);
  h.setEditable(true);
  h.ui.render();
  assert.doesNotMatch(h.get("#material-stock-rows").innerHTML, /CK00128/);
});

test("materials navigation, native dialog, script order and tablet overflow are independently namespaced", () => {
  assert.match(html, /data-view="materials" data-edit-only hidden/);
  assert.match(html, /data-view-panel="materials"[^>]*hidden/);
  assert.match(html, /<dialog[^>]*id="material-dialog"/);
  assert.match(html, /materials\.js" defer data-inline="materials"[\s\S]*materials-ui\.js" defer data-inline="materials-ui"[\s\S]*app\.js/);
  assert.match(css, /\.material-table-wrap[^}]*overflow:\s*auto/);
  assert.match(css, /\.material-stock-negative[^}]*var\(--color-danger\)/);
  assert.match(css, /\.material-stock-zero[^}]*var\(--color-warning\)/);
  assert.doesNotMatch(source, /onclick\s*=/);
});
