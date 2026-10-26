import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [source, stockSource, ordersSource] = await Promise.all(["finished-stock-ui.js", "finished-stock.js", "finished-stock-orders.js"].map(name => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")));
const core = `${ordersSource}\n${stockSource}`;
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const copy = value => JSON.parse(JSON.stringify(value));

function element() {
  return {
    innerHTML: "", textContent: "", value: "", open: false, disabled: false, checked: false, dataset: {}, listeners: new Map(),
    classList: { toggle() {} }, querySelector: () => null, querySelectorAll: () => [],
    setAttribute(name, value) { this[name] = value; }, replaceChildren() { this.innerHTML = ""; this.textContent = ""; },
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); },
    async fire(type, extra = {}) { for (const callback of this.listeners.get(type) || []) await callback({ target: this, preventDefault() {}, ...extra }); },
    showModal() { this.open = true; }, close() { this.open = false; },
  };
}

function harness() {
  let editable = true, readHandler = null, mutationHandler = null, jobs = [];
  const elements = new Map(), fields = {};
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const panel = get('[data-view-panel="finishedStock"]'), dialog = get("#finished-stock-dialog"), form = get("#finished-stock-form");
  const buttons = ["refresh", "opening"].map(action => ({ ...element(), dataset: { stockAction: action } }));
  panel.querySelectorAll = () => buttons;
  form.elements = { namedItem: name => fields[name], [Symbol.iterator]: function* () { yield* Object.values(fields); } };
  form.querySelectorAll = () => [...Object.values(fields), get("#finished-stock-submit")];
  form.reportValidity = () => true;
  const closeButton = element(); dialog.querySelectorAll = () => [closeButton];
  let markup = "";
  Object.defineProperty(get("#finished-stock-form-fields"), "innerHTML", {
    get: () => markup,
    set(value) {
      markup = value;
      for (const name of Object.keys(fields)) delete fields[name];
      for (const match of value.matchAll(/<(input|select|textarea)\b([^>]*\bname="([^"]+)"[^>]*)>(?:([^]*?)<\/\1>)?/g)) {
        const [, tag, attrs, name, body = ""] = match;
        const input = { ...element(), name };
        if (tag === "input") input.value = attrs.match(/\bvalue="([^"]*)"/)?.[1] || "";
        if (tag === "textarea") input.value = body;
        if (tag === "select") {
          const options = [...body.matchAll(/<option\b([^>]*)>([^]*?)<\/option>/g)];
          const selected = options.find(option => /\bselected\b/.test(option[1])) || options[0];
          input.value = selected?.[1].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
        }
        fields[name] = input;
      }
    },
  });
  class FormData {
    constructor() { this.entries = Object.entries(fields).filter(([, input]) => !input.disabled).map(([name, input]) => [name, input.value]); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  const context = vm.createContext({ document: { querySelector: get, activeElement: null }, FormData,
    crypto: { randomUUID: (() => { let id = 0; return () => `ui-${++id}`; })() } });
  vm.runInContext(`${core}\n${source}`, context);
  let events = [];
  const snapshot = () => context.FinishedStock.snapshot({ jobs, events });
  const calls = { reads: 0, mutations: [] };
  const commit = (action, payload) => {
    const prepared = context.FinishedStock.prepareMutation(action, payload, { jobs, events, at: "2026-10-20T09:00:00Z", actor: "editor", id: `event-${events.length}` });
    if (prepared.event) events.push(prepared.event);
    return prepared.snapshot;
  };
  const api = { async getFinishedStock() { calls.reads += 1; return readHandler ? readHandler() : snapshot(); } };
  for (const [method, action] of Object.entries({ openFinishedStock: "opening", receiveFinishedStock: "receive", shipFinishedStock: "ship", reverseFinishedStock: "reverse", saveFinishedStockSchedule: "schedule" })) {
    api[method] = async payload => { calls.mutations.push(copy(payload)); return mutationHandler ? mutationHandler(action, payload) : commit(action, payload); };
  }
  const ui = context.FinishedStockUI.create({ api, canEdit: () => editable, today: () => "2026-10-20" });
  get("#finished-stock-product-filter").value = "all";
  return {
    ui, get, panel, dialog, form, fields, buttons, calls, snapshot, commit,
    setEditable(value) { editable = value; }, setRead(handler) { readHandler = handler; }, setMutation(handler) { mutationHandler = handler; },
    setJobs(value) { jobs = value; },
    async ready() { ui.render(); await tick(); },
    async open(action = "opening", data = {}) { await panel.fire("click", { target: { closest: () => ({ disabled: false, dataset: { stockAction: action, productId: "26001", ...data } }) } }); },
    fill() { fields.quantity.value = "5"; fields.date.value = "2026-10-20"; fields.note.value = "現物確認"; fields.lotNo.value = "LOT-5"; },
    submit: () => form.fire("submit"), close: (method = "button") => method === "backdrop" ? dialog.fire("click") : method === "escape" ? dialog.fire("cancel") : closeButton.fire("click"),
  };
}

for (const method of ["button", "backdrop", "escape"]) {
  test(`${method}: empty and edited stock forms close through the same draft-preserving path`, async () => {
    const h = harness(); await h.ready(); await h.open();
    await h.close(method); assert.equal(h.dialog.open, false);
    await h.open(); assert.equal(h.fields.quantity.value, "");
    h.fill(); await h.close(method); assert.equal(h.dialog.open, false);
    await h.open();
    assert.equal(h.fields.quantity.value, "5"); assert.equal(h.fields.note.value, "現物確認");
    assert.equal(h.calls.mutations.length, 0);
  });

  test(`${method}: pending saves refuse normal closure and successful saves do not restore the submitted draft`, async () => {
    const h = harness(); await h.ready(); await h.open(); h.fill();
    const write = deferred(); h.setMutation(() => write.promise);
    const pending = h.submit(); await h.close(method);
    assert.equal(h.dialog.open, true); assert.equal(h.calls.mutations.length, 1);
    const result = h.commit("opening", h.calls.mutations[0]);
    write.resolve(result); await pending;
    assert.equal(h.dialog.open, false);
    await h.open(); assert.equal(h.fields.quantity.value, "");
    assert.equal(h.snapshot().version, 1);
  });

  test(`${method}: a failed/lost reply remains recoverable with the same request id and no duplicate stock`, async () => {
    const h = harness(); await h.ready(); await h.open(); h.fill();
    let lost = true;
    h.setMutation((action, payload) => { const result = h.commit(action, payload); if (lost) { lost = false; throw new Error("synthetic lost reply"); } return result; });
    await h.submit(); await h.close(method); await h.open();
    assert.equal(h.fields.quantity.value, "5"); assert.equal(h.fields.note.value, "現物確認");
    await h.submit();
    assert.equal(h.calls.mutations[0].requestId, h.calls.mutations[1].requestId);
    assert.equal(h.snapshot().version, 1); assert.equal(h.snapshot().products[0].stockQuantity, 5);
  });
}

test("forced access clear discards confidential drafts and ignores a late save even if editing is later restored", async () => {
  for (const success of [true, false]) {
    const h = harness(); await h.ready(); await h.open(); h.fill();
    const write = deferred(); h.setMutation(() => write.promise);
    const pending = h.submit();
    h.setEditable(false); h.ui.clear(); assert.equal(h.dialog.open, false);
    h.setEditable(true);
    if (success) write.resolve(h.snapshot()); else write.reject(new Error("late failure"));
    await pending;
    await h.ui.refresh(); await h.open();
    assert.equal(h.fields.quantity.value, ""); assert.equal(h.fields.note.value, "");
    assert.equal(h.dialog.open, true);
  }
});

test("loading disables mutations; pending submission blocks duplicate submit and close", async () => {
  const h = harness(), read = deferred(); h.setRead(() => read.promise);
  h.ui.render();
  assert.match(h.get("#finished-stock-status").textContent, /読み込んで/);
  assert.equal(h.buttons[1].disabled, true);
  read.resolve(h.snapshot()); await tick();
  assert.equal(h.buttons[1].disabled, false);
  await h.open(); h.fill();
  const write = deferred(); h.setMutation(() => write.promise);
  const submitted = h.submit();
  assert.equal(h.fields.note.disabled, true);
  assert.equal(h.form["aria-busy"], "true");
  await h.submit(); await h.close();
  assert.equal(h.calls.mutations.length, 1); assert.equal(h.dialog.open, true);
  write.resolve(h.snapshot()); await submitted;
  assert.equal(h.dialog.open, false); assert.equal(h.form["aria-busy"], "false");
});

test("lost response retains failed draft and retries committed event once with the same request id", async () => {
  const h = harness(); await h.ready(); await h.open(); h.fill();
  let loseReply = true;
  h.setMutation((action, payload) => { const result = h.commit(action, payload); if (loseReply) { loseReply = false; throw new Error("reply lost"); } return result; });
  await h.submit();
  assert.equal(h.dialog.open, true); assert.equal(h.fields.quantity.value, "5");
  assert.match(h.get("#finished-stock-form-status").textContent, /入力を保持/);
  await h.close(); await h.open();
  assert.equal(h.fields.quantity.value, "5"); assert.equal(h.fields.note.value, "現物確認");
  await h.submit();
  assert.equal(h.calls.mutations[0].requestId, h.calls.mutations[1].requestId);
  assert.equal(h.calls.mutations[1].expectedVersion, 1);
  assert.equal(h.snapshot().version, 1); assert.equal(h.snapshot().products[0].stockQuantity, 5);
  assert.equal(h.dialog.open, false);
});

test("stale stock version refreshes latest version and unchanged input can then be resubmitted", async () => {
  const h = harness(); await h.ready(); await h.open(); h.fill();
  h.commit("opening", { requestId: "other-device", expectedVersion: 0, productId: "26002", quantity: 1, date: "2026-10-20", note: "他端末" });
  await h.submit();
  assert.match(h.get("#finished-stock-form-status").textContent, /別の端末/);
  assert.equal(h.fields.lotNo.value, "LOT-5");
  await h.submit();
  assert.equal(h.calls.mutations[0].requestId, h.calls.mutations[1].requestId);
  assert.equal(h.calls.mutations[0].expectedVersion, 0); assert.equal(h.calls.mutations[1].expectedVersion, 1);
  assert.equal(h.snapshot().version, 2); assert.equal(h.snapshot().products[0].stockQuantity, 5);
});

test("background inventory refresh preserves in-progress form input", async () => {
  const h = harness(); await h.ready(); await h.open(); h.fill();
  h.fields.producers.value = "豊・幹";
  const read = deferred(); h.setRead(() => read.promise);
  h.ui.invalidate({ refresh: true }); await tick();
  assert.equal(h.dialog.open, true); assert.equal(h.fields.note.value, "現物確認");
  read.resolve(h.snapshot()); await tick();
  assert.equal(h.fields.quantity.value, "5"); assert.equal(h.fields.producers.value, "豊・幹");
  assert.equal(h.fields.note.disabled, false);
});

test("passive sync cannot starve a slow stock read, while forced invalidation still discards stale results", async () => {
  const h = harness(), initialRead = deferred();
  h.setRead(() => initialRead.promise);
  h.ui.render(); await tick();
  for (let sync = 0; sync < 4; sync += 1) {
    h.ui.invalidate({ refresh: true, passive: true }); h.ui.render(); await tick();
  }
  assert.equal(h.calls.reads, 1);
  initialRead.resolve(h.snapshot()); await tick();
  assert.equal(h.calls.reads, 1, "periodic sync must accept the in-flight read instead of replacing it");
  assert.match(h.get("#finished-stock-rows").innerHTML, /26001/);
  assert.equal(h.buttons[1].disabled, false);

  const staleRead = deferred(), freshRead = deferred(), staleSnapshot = h.snapshot();
  h.setRead(() => staleRead.promise);
  h.ui.invalidate({ refresh: true }); await tick();
  h.commit("opening", { requestId: "forced-change", expectedVersion: 0, productId: "26001", quantity: 5, date: "2026-10-20", note: "更新確認", lotNo: "FORCED-LATEST" });
  h.setRead(() => freshRead.promise);
  h.ui.invalidate({ refresh: true });
  staleRead.resolve(staleSnapshot); await tick();
  assert.equal(h.calls.reads, 3, "a forced invalidation queues one fresh read after discarding the stale result");
  assert.equal(h.buttons[1].disabled, true);
  freshRead.resolve(h.snapshot()); await tick();
  assert.match(h.get("#finished-stock-lot-rows").innerHTML, /FORCED-LATEST/);
  assert.equal(h.buttons[1].disabled, false);
});

test("lot and customer markup is escaped, and role revocation ignores a late inventory response", async () => {
  const h = harness(), attack = '<img src=x onerror="alert(1)">';
  h.commit("opening", { requestId: "unsafe-name", expectedVersion: 0, productId: "26001", quantity: 5, date: "2026-10-20", note: attack, lotNo: attack, producers: [attack] });
  h.commit("ship", { requestId: "unsafe-customer", expectedVersion: 1, productId: "26001", quantity: 1, date: "2026-10-20", customer: attack, orderRef: attack, purpose: "sale" });
  await h.ready();
  for (const selector of ["#finished-stock-lot-rows", "#finished-stock-history-rows"]) {
    assert.doesNotMatch(h.get(selector).innerHTML, /<img/); assert.match(h.get(selector).innerHTML, /&lt;img/);
  }
  const read = deferred(); h.setRead(() => read.promise);
  h.ui.invalidate({ refresh: true }); await tick();
  h.setEditable(false); h.ui.clear();
  read.resolve(h.snapshot()); await tick();
  assert.equal(h.get("#finished-stock-lot-rows").innerHTML, "");
  assert.equal(h.get("#finished-stock-history-rows").innerHTML, "");
  assert.equal(h.buttons[1].disabled, true);
});

test("schedule saves customer quantity and planned dates, and an order-linked shipment updates both physical stock and demand", async () => {
  const h = harness();
  h.setJobs([{ id: "order-ui", version: 7, product: "Tezoe スタンツェ 直上", productCode: "26001", customer: "テスト先", serialNo: "注文UI", quantity: 5, stockPlannedQuantity: 0, dueDate: "2026-10-30", stages: { finish: { status: "working" } } }]);
  h.commit("opening", { expectedVersion: 0, requestId: "order-ui-opening", productId: "26001", quantity: 5, date: "2026-10-20", note: "確認" });
  await h.ready();
  assert.match(h.get("#finished-stock-order-rows").innerHTML, /注文UI/);
  await h.open("schedule", { jobId: "order-ui" });
  h.fields.orderQuantity.value = "5"; h.fields.stockQuantity.value = "2";
  h.fields.shipDate.value = "2026-10-20"; h.fields.completionDate.value = "2026-10-30";
  await h.submit();
  assert.equal(h.calls.mutations[0].orderQuantity, 5);
  assert.equal(h.calls.mutations[0].stockQuantity, 2);
  assert.equal(h.calls.mutations[0].date, undefined);
  assert.equal(h.snapshot().orders[0].hasSchedule, true);
  assert.match(h.get("#finished-stock-order-rows").innerHTML, /2026-10-30/);
  await h.open("ship", { orderJobId: "order-ui" });
  assert.equal(h.fields.customer.value, "テスト先");
  h.fields.quantity.value = "2"; h.fields.date.value = "2026-10-20";
  await h.submit();
  assert.equal(h.calls.mutations[1].orderJobId, "order-ui");
  assert.equal(h.calls.mutations[1].jobVersion, 7);
  assert.equal(h.snapshot().products[0].stockQuantity, 3);
  assert.equal(h.snapshot().orders[0].remainingQuantity, 3);
  assert.equal(h.snapshot().orders[0].allocatedQuantity, 0);
});

test("stock-only production can set its completion date without creating customer demand", async () => {
  const h = harness();
  h.setJobs([{ id: "replenishment-ui", version: 3, customer: "在庫用", product: "Tezoe スタンツェ 直上", productCode: "26001", serialNo: "STOCK-10", quantity: 10, stockPlannedQuantity: 0, dueDate: "", stages: { finish: { status: "working" } } }]);
  await h.ready();
  assert.match(h.get("#finished-stock-plan-rows").innerHTML, /STOCK-10/);
  assert.match(h.get("#finished-stock-plan-rows").innerHTML, /完成予定/);
  assert.doesNotMatch(h.get("#finished-stock-order-rows").innerHTML, /STOCK-10/);
  await h.open("completion", { jobId: "replenishment-ui" });
  h.fields.completionDate.value = "2026-11-25";
  await h.submit();
  assert.equal(h.calls.mutations[0].orderQuantity, 0);
  assert.equal(h.calls.mutations[0].stockQuantity, 0);
  assert.equal(h.calls.mutations[0].completionDate, "2026-11-25");
  assert.equal(h.snapshot().orders.length, 0);
  assert.equal(h.snapshot().productions[0].dueDate, "2026-11-25");
  assert.equal(h.snapshot().products[0].stockQuantity, 0);
});
