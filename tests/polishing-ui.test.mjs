import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");

function harness() {
  const storage = new Map();
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", value: "", disabled: false, hidden: false, dataset: {}, open: false });
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    activeElement: null,
  };
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    structuredClone, document, crypto: webcrypto,
    window: { crypto: webcrypto },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout, clearTimeout,
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.__test = { state, api, MockApi, canAccessView, polishingCounts, polishingFinishReady, invalidFinalFinishing, polishingJobs, polishingCell, polishingSentDateMarkup, polishingHistoryMarkup, activePolishingReturns, undoPolishingReturn, commitPolishingMovement, reconcilePolishingRetry, openPolishingDialog, savePolishingForm, commitPolishingEventDate, receiveSelectedPolishing, polishingMonthlySummary, sendPolishingJob };`, context);
  const ui = context.__test;
  ui.state.access = { role: "editor", canEdit: true };
  context.renderAll = () => {};
  context.renderPolishingWorkspace = () => {};
  context.showToast = (message, options) => { context.lastToast = { message, options }; };
  context.announce = () => {};
  context.refreshData = async () => {};
  return { context, ui, elements, storage };
}

function job(id, overrides = {}) {
  return {
    id, customer: `得意先${id}`, product: `製品${id}`, serialNo: id, dueDate: "2026-10-10", quantity: 5,
    version: 2, archived: false, shippingStatus: "not_ready", labelPrintStatus: "printed", labelPrintedAt: "kept",
    distributionAssignee: "豊", note: "keep this", stages: { finish: { status: "not_started", assignee: "幹" } },
    polishing: { sentQuantity: 4, returnedQuantity: 1, history: [] },
    ...overrides,
  };
}

function cancellationForm(h) {
  const form = {
    dataset: {},
    elements: { id: { value: "" }, version: { value: "" }, quantity: { value: "" }, eventRequestId: {value:""}, date: {value:""} },
    reset() { Object.values(this.elements).forEach((input) => { input.value = ""; }); },
    querySelectorAll() { return []; },
    reportValidity() { return true; },
  };
  h.elements.set("#polishing-form", form);
  h.context.openDialog = (dialog) => { dialog.open = true; };
  h.context.closeDialog = (dialog) => { dialog.open = false; };
  h.context.delay = async () => {};
  return form;
}

test("研ボタンは確認画面なしで押した日に全数を発送し、日付だけ後から編集できる", async () => {
  const h = harness(), {ui,storage} = h;
  const seed = job("dated-send", {polishing:{sentQuantity:0,returnedQuantity:0,history:[]}});
  ui.state.jobs = [seed];
  storage.set("production-board-demo-v2", JSON.stringify({jobs:[seed],intake:[],settings:{}}));
  const form = cancellationForm(h);
  const before = Date.now();
  assert.equal(await ui.sendPolishingJob(seed.id), true);
  assert.notEqual(h.elements.get("#polishing-dialog").open, true);
  let saved = ui.api.read().jobs[0];
  const recorded = saved.polishing.history[0];
  assert.equal(recorded.quantity, seed.quantity);
  assert.ok(Date.parse(recorded.at) >= before && Date.parse(recorded.at) <= Date.now());
  assert.equal(recorded.requestedDate, undefined, "server assigns the recording day by default");
  assert.match(source, /"open-polishing-send": \(\) => sendPolishingJob\(button.dataset.orderId\)/);
  assert.equal(await ui.sendPolishingJob(seed.id), false, "already sent quantities are not sent twice");
  assert.equal(ui.api.read().jobs[0].polishing.history.length, 1);
  ui.openPolishingDialog(seed.id, "date", recorded.requestId);
  form.elements.date.value = "2026-09-28";
  const saving = ui.savePolishingForm({preventDefault(){},currentTarget:form});
  assert.equal(h.elements.get("#polishing-dialog").open, false);
  await saving;
  saved = ui.api.read().jobs[0];
  assert.equal(saved.polishing.sentQuantity, seed.quantity);
  assert.equal(saved.polishing.history.length, 1);
  assert.equal(saved.polishing.history[0].recordedAt, recorded.at);
  assert.equal(saved.polishing.history[0].at, "2026-09-27T15:00:00.000Z");
  assert.match(ui.polishingSentDateMarkup(saved), />9\/28<\/time>/);
});

test("選択した複数案件の戻り日を一括で保存し、その月の研磨代に反映する", async () => {
  const h = harness(), {ui,storage} = h;
  h.context.delay = async () => {};
  const seeds = ["a","b"].map((id) => job(id, {productMaster:{classCode:"A"},polishing:{sentQuantity:5,returnedQuantity:0,history:[
    {requestId:`s-${id}`,action:"send",quantity:5,at:"2026-09-01T00:00:00Z"},
  ]}}));
  ui.state.jobs = seeds;
  storage.set("production-board-demo-v2", JSON.stringify({jobs:seeds,intake:[],settings:{}}));
  for (const seed of seeds) ui.state.polishingSelection.set(seed.id, {version:seed.version,quantity:"5"});
  h.elements.set("#polishing-return-date", {value:"2026-09-30",reportValidity:() => true});
  h.elements.set("#polishing-return-button", {disabled:false});
  await ui.receiveSelectedPolishing();
  const saved = ui.api.read().jobs;
  assert.ok(saved.every((entry) => entry.polishing.history.at(-1).at === "2026-09-29T15:00:00.000Z"));
  assert.equal(ui.polishingMonthlySummary(saved, {}, "2026-09").quantity, 10);
  assert.equal(ui.polishingMonthlySummary(saved, {}, "2026-10").quantity, 0);
});

test("既存の戻り日を変更すると月別集計が移り、訂正表示と数量・工程を保持する", async () => {
  const h = harness(), {ui,storage} = h;
  const seed = {...returnedFixture("date-edit"),productMaster:{classCode:"A"},shippingStatus:"shipped"};
  ui.state.jobs = [seed];
  storage.set("production-board-demo-v2", JSON.stringify({jobs:[seed],intake:[],settings:{}}));
  const form = cancellationForm(h);
  ui.openPolishingDialog(seed.id, "date", "r2");
  assert.equal(form.elements.date.value, "2026-10-07");
  assert.equal(h.elements.get("#polishing-date-label").textContent, "戻り日");
  form.elements.date.value = "2026-09-30";
  await ui.savePolishingForm({preventDefault(){},currentTarget:form});
  const saved = ui.api.read().jobs[0];
  assert.equal(saved.polishing.returnedQuantity, 5);
  assert.deepEqual(saved.stages, seed.stages);
  assert.equal(saved.shippingStatus, "shipped");
  assert.equal(ui.polishingMonthlySummary([saved], {}, "2026-09").quantity, 5);
  assert.equal(ui.polishingMonthlySummary([saved], {}, "2026-10").quantity, 0);
  assert.match(ui.polishingHistoryMarkup(saved), /日付訂正済み/);
  for (const role of ["worker", "viewer"]) {
    ui.state.access = {role,canEdit:false};
    assert.doesNotMatch(ui.polishingHistoryMarkup(saved), /data-action="edit-polishing-date"/);
  }
});

test("日付訂正の応答が失われても同じ内容の再試行で二重訂正せず、選択日を保持する", async () => {
  const h = harness(), {ui,storage} = h;
  h.context.delay = async () => {};
  const seed = returnedFixture("retry-date");
  ui.state.jobs = [seed];
  storage.set("production-board-demo-v2", JSON.stringify({jobs:[seed],intake:[],settings:{}}));
  const save = ui.api.savePolishingEventDate.bind(ui.api);
  let calls = 0;
  ui.api.savePolishingEventDate = async (payload) => { const result = await save(payload); if (++calls === 1) throw new Error("response lost"); return result; };
  await ui.commitPolishingEventDate({id:seed.id,version:seed.version,eventRequestId:"r2",date:"2026-09-30",requestId:"retry-date-id"});
  assert.match(ui.state.polishingSaveMessage, /入力は保持/);
  await h.context.lastToast.options.action.run();
  assert.equal(ui.state.jobs[0].polishing.history.at(-1).dateEdits.length, 1);
  assert.equal(ui.state.jobs[0].version, seed.version + 1);
  assert.match(ui.state.polishingSaveMessage, /2026\/9\/30/);
});

test("発送・戻りの再試行は元の日付を保持し、同じ要求で別の日付を受け付けない", async () => {
  const h = harness(), {ui,storage} = h;
  h.context.delay = async () => {};
  const seed = job("dated-retry", {polishing:{sentQuantity:0,returnedQuantity:0,history:[]}});
  ui.state.jobs = [seed];
  storage.set("production-board-demo-v2", JSON.stringify({jobs:[seed],intake:[],settings:{}}));
  const save = ui.api.savePolishingMovement.bind(ui.api), payloads = [];
  ui.api.savePolishingMovement = async (payload) => { payloads.push(payload); const result = await save(payload); if (payloads.length === 1) throw new Error("response lost"); return result; };
  await ui.commitPolishingMovement("send", [{id:seed.id,version:seed.version,quantity:5}], "2026-09-29");
  await h.context.lastToast.options.action.run();
  assert.equal(payloads[0].requestId, payloads[1].requestId);
  assert.equal(payloads[1].date, "2026-09-29");
  assert.equal(ui.state.jobs[0].polishing.history.length, 1);
  await assert.rejects(save({...payloads[0],date:"2026-09-30"}), /再試行内容が異なります/);
});

test("発送取り消しは数量入力なしで研磨屋にある全数を取り消し、戻り済みの記録を保つ", async () => {
  const formMarkup = html.match(/<form[^>]*id="polishing-form"[\s\S]*?<\/form>/)[0];
  assert.match(formMarkup, /<input type="hidden" name="quantity">/);
  assert.doesNotMatch(formMarkup, /type="number"|polishing-quantity-label/);
  for (const returned of [0, 2]) {
    const h = harness();
    const { ui, storage } = h;
    const seed = job(`cancel-${returned}`, { polishing: { sentQuantity: 5, returnedQuantity: returned, history: [
      { requestId: "send", action: "send", quantity: 5, at: "2026-10-01T00:00:00Z" },
      ...(returned ? [{ requestId: "return", action: "return", quantity: returned, at: "2026-10-02T00:00:00Z" }] : []),
    ] } });
    ui.state.jobs = [seed];
    storage.set("production-board-demo-v2", JSON.stringify({ jobs: [seed], intake: [], settings: {} }));
    const form = cancellationForm(h);
    ui.openPolishingDialog(seed.id, "cancel");
    assert.equal(Number(form.elements.quantity.value), 5 - returned);
    assert.equal(h.elements.get("#polishing-dialog-title").textContent, "発送を取り消す");
    assert.match(h.elements.get("#polishing-action-summary").textContent, /全数/);
    await ui.savePolishingForm({ preventDefault() {}, currentTarget: form });
    const saved = ui.api.read().jobs[0];
    assert.equal(saved.polishing.sentQuantity, returned);
    assert.equal(saved.polishing.returnedQuantity, returned);
    assert.equal(saved.polishing.history.at(-1).action, "cancel");
    assert.equal(saved.polishing.history.at(-1).quantity, 5 - returned);
    assert.equal(saved.labelPrintStatus, seed.labelPrintStatus);
    assert.equal(saved.note, seed.note);
    assert.equal(ui.polishingCounts(saved).outstanding, 0);
  }
});

test("取り消し確認後の他端末更新は版の不一致で拒否し、数量を勝手に変更しない", async () => {
  const h = harness();
  const { ui, storage } = h;
  const seed = job("stale-cancel", { polishing: { sentQuantity: 5, returnedQuantity: 0, history: [] } });
  ui.state.jobs = [seed];
  const form = cancellationForm(h);
  ui.openPolishingDialog(seed.id, "cancel");
  const newer = { ...seed, version: 3, polishing: { sentQuantity: 5, returnedQuantity: 2, history: [] } };
  storage.set("production-board-demo-v2", JSON.stringify({ jobs: [newer], intake: [], settings: {} }));
  await ui.savePolishingForm({ preventDefault() {}, currentTarget: form });
  const saved = ui.api.read().jobs[0];
  assert.equal(saved.version, 3);
  assert.equal(saved.polishing.sentQuantity, 5);
  assert.equal(saved.polishing.returnedQuantity, 2);
  assert.equal(ui.state.polishingRetry.items[0].quantity, 5);
  assert.equal(ui.state.polishingRetry.items[0].version, 2);
});

test("研磨数は発送・戻りの差と数量を基に未研磨分を数える", () => {
  const { ui } = harness();
  const counts = ui.polishingCounts(job("qty"));
  assert.deepEqual({ ...counts }, { sent: 4, returned: 1, outstanding: 3, available: 1 });
  assert.deepEqual({ ...ui.polishingCounts(job("zero", { polishing: { sentQuantity: 2, returnedQuantity: 8 } })) }, { sent: 2, returned: 8, outstanding: 0, available: 3 });
});

test("研磨一覧の業者・最終仕上げ・全件フィルタ、検索と納期順を適用する", () => {
  const { ui } = harness();
  ui.state.jobs = [
    job("late", { dueDate: "2026-10-20" }),
    job("early", { dueDate: "2026-10-01", polishing: { sentQuantity: 5, returnedQuantity: 5, history: [{}] } }),
    job("done", { dueDate: "2026-10-05", stages: { finish: { status: "done" } }, polishing: { sentQuantity: 5, returnedQuantity: 5, history: [{}] } }),
    job("archived", { archived: true }),
    job("never", { polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] } }),
  ];
  assert.deepEqual(Array.from(ui.polishingJobs({ filter: "vendor" }), (item) => item.id), ["late"]);
  assert.deepEqual(Array.from(ui.polishingJobs({ filter: "finishing" }), (item) => item.id), ["early", "late"]);
  assert.deepEqual(Array.from(ui.polishingJobs({ filter: "all" }), (item) => item.id), ["early", "done", "late"]);
  assert.deepEqual(Array.from(ui.polishingJobs({ filter: "all", query: "late" }), (item) => item.id), ["late"]);
});

test("全数が戻るまで最終仕上げ不可、全数戻り後は可能", () => {
  const { ui } = harness();
  assert.equal(ui.polishingFinishReady(job("partial")), false);
  assert.equal(ui.polishingFinishReady(job("full", { polishing: { sentQuantity: 5, returnedQuantity: 5, history: [] } })), true);
  assert.equal(ui.polishingFinishReady(job("not-all-sent", { polishing: { sentQuantity: 4, returnedQuantity: 4, history: [] } })), false);
});

test("研磨表示セルは製品名や詳細文字をHTMLとして解釈させない", () => {
  const { ui } = harness();
  const markup = ui.polishingCell(job("x", { product: '<img src=x onerror="bad">', polishing: { sentQuantity: 4, returnedQuantity: 1 } }));
  assert.match(markup, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(markup, /<img/);
});

test("発送日は最後の発送記録を日本時間で表示し、戻りや他の更新日は使わない", () => {
  const { ui } = harness();
  const tracked = job("date", { updatedAt: "2026-10-09T00:00:00.000Z", polishing: {
    sentQuantity: 4, returnedQuantity: 1, history: [
      { action: "send", at: "2026-10-03T03:00:00.000Z" },
      { action: "return", at: "2026-10-04T03:00:00.000Z" },
      { action: "send", at: "2026-10-04T16:30:00.000Z" },
      { action: "return", at: "2026-10-08T03:00:00.000Z" },
    ],
  } });
  const date = ui.polishingSentDateMarkup(tracked);
  assert.match(date, /datetime="2026-10-04T16:30:00.000Z"/);
  assert.match(date, />10\/5<\/time>/);
  assert.match(date, /2026\/10\/5 01:30/);
  assert.ok(ui.polishingCell(tracked).includes(`発 ${date}`));
  assert.equal(ui.polishingSentDateMarkup(job("empty")), "—");
});

test("編集者だけが研磨更新と戻り取消を実行できる", async () => {
  const { ui } = harness();
  ui.api.savePolishingMovement = async () => ({ jobs: [] });
  ui.state.jobs = [returnedFixture("role-gate")];
  ui.state.access = { role: "viewer", canEdit: false };
  assert.equal(await ui.commitPolishingMovement("return", [{ id: "x", version: 2, quantity: 1 }]), false);
  assert.equal(await ui.undoPolishingReturn("role-gate"), false);
  ui.state.access = { role: "worker", canEdit: false, canWork: true };
  assert.equal(await ui.commitPolishingMovement("return", [{ id: "x", version: 2, quantity: 1 }]), false);
  assert.equal(await ui.undoPolishingReturn("role-gate"), false);
  ui.state.access = { role: "editor", canEdit: true, canWork: true };
  let received;
  ui.api.savePolishingMovement = async (payload) => { received = payload; return { jobs: [] }; };
  assert.equal(await ui.commitPolishingMovement("return", [{ id: "x", version: 2, quantity: 1 }]), true);
  assert.equal(received.action, "return");
  assert.ok(received.requestId);
});

test("作業員には研磨ビューと研磨操作ボタンを表示せず、セル状態は読み取り専用", () => {
  const { ui } = harness();
  const tracked = job("worker-cell");
  const available = job("worker-send", { polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] } });
  ui.state.access = { role: "worker", canEdit: false, canWork: true };
  assert.equal(ui.canAccessView("polishing"), false);
  const status = ui.polishingCell(tracked);
  assert.match(status, />研磨中<\/span>/);
  assert.doesNotMatch(status, /研磨中\s+\d/);
  assert.doesNotMatch(status, /<button|data-action=/);
  assert.doesNotMatch(ui.polishingCell(available), /<button|data-action=/);
});

test("保存結果が古い版なら画面上の新しい案件を巻き戻さない", async () => {
  const { ui } = harness();
  const latest = job("race", { version: 9, note: "newer edit" });
  ui.state.jobs = [job("race")];
  ui.api.savePolishingMovement = async () => {
    ui.state.jobs = [latest];
    return { jobs: [job("race", { version: 3, note: "stale response" })] };
  };
  assert.equal(await ui.commitPolishingMovement("return", [{ id: "race", version: 2, quantity: 1 }]), true);
  assert.equal(ui.state.jobs[0].version, 9);
  assert.equal(ui.state.jobs[0].note, "newer edit");
});

test("応答不明後の再試行は同じ要求IDで再送しMockApi側も二重計上しない", async () => {
  const { ui, storage } = harness();
  const api = ui.api;
  const seed = job("retry");
  storage.set("production-board-demo-v2", JSON.stringify({ jobs: [seed], intake: [], settings: {} }));
  let calls = 0;
  const realSave = api.savePolishingMovement.bind(api);
  api.savePolishingMovement = async (payload) => {
    calls += 1;
    const result = await realSave(payload);
    if (calls === 1) throw new Error("response lost");
    return result;
  };
  const items = [{ id: "retry", version: 2, quantity: 2 }];
  assert.equal(await ui.commitPolishingMovement("return", items), false);
  const requestId = ui.state.polishingRetry.requestId;
  assert.equal(await ui.commitPolishingMovement("return", items), true);
  const saved = api.read().jobs[0];
  assert.equal(calls, 2);
  assert.equal(saved.polishing.returnedQuantity, 3);
  assert.equal(saved.polishing.history.filter((entry) => entry.requestId === requestId).length, 1);
});

test("研ボタンは直ちに反映中を表示し別案件へ続けられ、同じ案件は二重送信しない", async () => {
  const { ui } = harness();
  const clean = id => job(id, { polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] } });
  ui.state.jobs = [clean("A"), clean("B")];
  const pending = [];
  ui.api.savePolishingMovement = payload => new Promise((resolve, reject) => pending.push({ payload, resolve, reject }));
  const first = ui.commitPolishingMovement("send", [{ id: "A", version: 2, quantity: 5 }]);
  assert.equal(ui.polishingCounts(ui.state.jobs[0]).outstanding, 5);
  assert.match(ui.polishingCell(ui.state.jobs[0]), /研 反映中/);
  assert.match(ui.polishingCell(ui.state.jobs[1]), /data-action="open-polishing-send"/);
  assert.doesNotMatch(ui.polishingCell(ui.state.jobs[1]), /disabled/);
  assert.equal(await ui.commitPolishingMovement("send", [{ id: "A", version: 2, quantity: 5 }]), false);
  const second = ui.commitPolishingMovement("send", [{ id: "B", version: 2, quantity: 5 }]);
  assert.equal(pending.length, 2);
  pending[1].resolve({ jobs: [{ ...ui.state.jobs[1], version: 3 }] });
  await second;
  pending[0].reject(new Error("offline"));
  assert.equal(await first, false);
  assert.equal(ui.polishingCounts(ui.state.jobs[0]).outstanding, 0);
  assert.equal(ui.polishingCounts(ui.state.jobs[1]).outstanding, 5);
  assert.equal(ui.state.polishingSaving.size, 0);
});

test("並行した研磨失敗の再試行は案件ごとに元の要求IDを維持する", async () => {
  const { ui } = harness();
  ui.state.jobs = [job("A"), job("B")];
  const pending = [];
  ui.api.savePolishingMovement = payload => new Promise((resolve, reject) => pending.push({ payload, resolve, reject }));
  const a = [{ id: "A", version: 2, quantity: 1 }], b = [{ id: "B", version: 2, quantity: 1 }];
  const first = ui.commitPolishingMovement("send", a);
  const second = ui.commitPolishingMovement("send", b);
  pending[0].reject(new Error("response lost A"));
  pending[1].reject(new Error("response lost B"));
  await Promise.all([first, second]);
  const retryA = ui.commitPolishingMovement("send", a);
  const retryB = ui.commitPolishingMovement("send", b);
  assert.equal(pending[2].payload.requestId, pending[0].payload.requestId);
  assert.equal(pending[3].payload.requestId, pending[1].payload.requestId);
  pending[2].resolve({ jobs: [{ ...ui.state.jobs[0], version: 3 }] });
  pending[3].resolve({ jobs: [{ ...ui.state.jobs[1], version: 3 }] });
  await Promise.all([retryA, retryB]);
});

test("複数案件戻りは既存メタデータを保ち、不正な一括入力では部分保存しない", async () => {
  const { ui, storage } = harness();
  storage.set("production-board-demo-v2", JSON.stringify({ jobs: [job("a"), job("b")], intake: [], settings: {} }));
  const api = ui.api;
  const before = api.read().jobs;
  await assert.rejects(api.savePolishingMovement({ action: "return", requestId: "bad-batch", items: [
    { id: "a", version: 2, quantity: 1 }, { id: "b", version: 2, quantity: 99 },
  ] }));
  assert.deepEqual(api.read().jobs, before);
  const result = await api.savePolishingMovement({ action: "return", requestId: "good-batch", items: [
    { id: "a", version: 2, quantity: 1 }, { id: "b", version: 2, quantity: 2 },
  ] });
  assert.equal(result.jobs.length, 2);
  for (const saved of result.jobs) {
    assert.equal(saved.note, "keep this");
    assert.equal(saved.distributionAssignee, "豊");
    assert.equal(saved.labelPrintStatus, "printed");
    assert.equal(saved.labelPrintedAt, "kept");
    assert.equal(saved.polishing.history.length, 1);
  }
});

function returnedFixture(id = "undo") {
  return job(id, {version:4, stages:{finish:{status:"done",assignee:"幹"}}, shippingStatus:"waiting", polishing:{sentQuantity:5,returnedQuantity:5,history:[
    {requestId:"s1",action:"send",quantity:5,at:"2026-09-01T00:00:00Z"},
    {requestId:"r1",action:"return",quantity:2,at:"2026-09-30T00:00:00Z"},
    {requestId:"r2",action:"return",quantity:3,at:"2026-10-07T00:00:00Z"},
  ]}});
}

test("履歴の戻り取消は編集者だけに表示し、作業員・閲覧者・出荷済み・戻りなしでは表示しない", () => {
  const {ui} = harness();
  const tracked = returnedFixture();
  assert.match(ui.polishingHistoryMarkup(tracked), /data-action="undo-polishing-return"/);
  assert.match(ui.polishingHistoryMarkup(tracked), />研磨状態に戻す<\/button>/);
  assert.match(ui.polishingHistoryMarkup(tracked), /直前の戻り3丁/);
  assert.match(ui.polishingHistoryMarkup(tracked, true), /data-action="undo-polishing-return"[^>]* disabled/);
  ui.state.access = {role:"worker"};
  assert.doesNotMatch(ui.polishingHistoryMarkup(tracked), /data-action="undo-polishing-return"/);
  ui.state.access = {role:"viewer"};
  assert.doesNotMatch(ui.polishingHistoryMarkup(tracked), /data-action="undo-polishing-return"/);
  ui.state.access = {role:"editor",canEdit:true};
  assert.doesNotMatch(ui.polishingHistoryMarkup({...tracked,shippingStatus:"shipped"}), /data-action="undo-polishing-return"/);
  assert.doesNotMatch(ui.polishingHistoryMarkup(job("no-return")), /data-action="undo-polishing-return"/);
});

test("直前の戻りを取り消し、前の戻りと発送日は保って工程一覧の研磨中・保存結果に反映する", async () => {
  const {ui,storage} = harness();
  const tracked = returnedFixture();
  storage.set("production-board-demo-v2", JSON.stringify({jobs:[tracked],intake:[],settings:{}}));
  ui.state.jobs = [tracked];
  const sentDate = ui.polishingSentDateMarkup(tracked);
  assert.equal(await ui.undoPolishingReturn(tracked.id), true);
  const saved = ui.state.jobs[0];
  assert.equal(saved.polishing.sentQuantity, 5);
  assert.equal(saved.polishing.returnedQuantity, 2);
  assert.equal(saved.stages.finish.status, "not_started");
  assert.equal(saved.stages.finish.assignee, "幹");
  assert.equal(saved.shippingStatus, "not_ready");
  assert.equal(saved.version, 5);
  for (const key of ["note","distributionAssignee","labelPrintStatus","labelPrintedAt"]) assert.equal(saved[key],tracked[key],key);
  const correction = saved.polishing.history.at(-1);
  assert.equal(correction.action,"undo-return");
  assert.equal(correction.returnRequestId,"r2");
  assert.equal(correction.quantity,3);
  assert.deepEqual(Array.from(ui.activePolishingReturns(saved),event=>event.requestId),["r1"]);
  assert.equal(ui.polishingSentDateMarkup(saved),sentDate);
  assert.match(ui.polishingCell(saved), />研磨中<\/button>/);
  assert.match(ui.polishingHistoryMarkup(saved), /戻り 3丁（取消済み）/);
  assert.match(ui.polishingHistoryMarkup(saved), /戻り取消 3丁/);
  assert.match(ui.state.polishingSaveMessage,/3丁の戻りを取り消し、研磨状態に戻しました/);
  assert.deepEqual(Array.from(ui.polishingJobs({filter:"vendor"}),j=>j.id),[tracked.id]);
});

test("取り消した戻りと同じ要求IDの再送は二重修正せず、異なる参照先や数量・再取消は拒否する", async () => {
  const {ui,storage} = harness();
  const tracked=returnedFixture();
  storage.set("production-board-demo-v2",JSON.stringify({jobs:[tracked],intake:[],settings:{}}));
  const payload={action:"undo-return",requestId:"undo-1",items:[{id:tracked.id,version:4,quantity:3,returnRequestId:"r2"}]};
  await ui.api.savePolishingMovement(payload);
  await ui.api.savePolishingMovement(payload);
  assert.equal(ui.api.read().jobs[0].polishing.returnedQuantity,2);
  assert.equal(ui.api.read().jobs[0].polishing.history.filter(event=>event.requestId==="undo-1").length,1);
  await assert.rejects(ui.api.savePolishingMovement({...payload,items:[{...payload.items[0],returnRequestId:"r1"}]}),/再試行/);
  await assert.rejects(ui.api.savePolishingMovement({...payload,requestId:"undo-2",items:[{...payload.items[0],version:5}]}),/履歴/);
  await assert.rejects(ui.api.savePolishingMovement({...payload,requestId:"bad-count",items:[{...payload.items[0],version:5,quantity:1,returnRequestId:"r1"}]}),/履歴/);
});

test("応答不明の戻り取消は同じ要求ID・戻り参照で再試行し、処理済み履歴から確認できる", async () => {
  const {ui,storage} = harness();
  const tracked=returnedFixture();
  storage.set("production-board-demo-v2",JSON.stringify({jobs:[tracked],intake:[],settings:{}}));
  ui.state.jobs=[tracked];
  const realSave=ui.api.savePolishingMovement.bind(ui.api);
  let calls=0;
  ui.api.savePolishingMovement=async payload=>{const result=await realSave(payload); if(++calls===1) throw new Error("response lost"); return result;};
  assert.equal(await ui.undoPolishingReturn(tracked.id),false);
  const attempt=ui.state.polishingRetry;
  assert.equal(attempt.items[0].returnRequestId,"r2");
  assert.equal(await ui.undoPolishingReturn(tracked.id),true);
  assert.equal(ui.state.jobs[0].polishing.returnedQuantity,2);
  assert.equal(ui.state.jobs[0].polishing.history.filter(event=>event.requestId===attempt.requestId).length,1);
  ui.state.polishingRetry={...attempt,confirmed:false};
  ui.reconcilePolishingRetry();
  assert.equal(ui.state.polishingRetry,null);
  const wrong={...attempt,items:[{...attempt.items[0],returnRequestId:"r1"}]};
  ui.state.polishingRetry=wrong;
  ui.reconcilePolishingRetry();
  assert.equal(ui.state.polishingRetry,wrong,"異なる戻り参照は処理済みと判定しない");
});

test("MockApi quantity correction matches the historical shipped exception and preserves shipment evidence", async () => {
  const h = harness(), { ui, storage, context } = h;
  context.delay = async () => {};
  const completedAt = "2026-10-20T01:02:03.000Z";
  const legacy = job("legacy-blank", {
    quantity: "", shippingStatus: "shipped", completedAt,
    stages: { finish: { status: "done", assignee: "幹" } },
    polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] },
  });
  storage.set("production-board-demo-v2", JSON.stringify({ jobs: [legacy], intake: [], settings: {} }));
  ui.state.jobs = [legacy];
  const saved = await ui.api.saveJob({ ...legacy, quantity: 4 });
  assert.equal(saved.quantity, 4);
  assert.equal(saved.shippingStatus, "shipped");
  assert.equal(saved.completedAt, completedAt);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.polishing)), { sentQuantity: 0, returnedQuantity: 0, history: [] });
  assert.equal(ui.api.read().jobs[0].completedAt, completedAt);

  const sameQuantity = { ...legacy, quantity: "", version: saved.version };
  storage.set("production-board-demo-v2", JSON.stringify({ jobs: [sameQuantity], intake: [], settings: {} }));
  const unchanged = await ui.api.saveJob({ ...sameQuantity });
  assert.equal(unchanged.shippingStatus, "shipped");
  assert.equal(unchanged.completedAt, completedAt);

  const full = { ...legacy, id: "full-return", quantity: 5, version: 2, polishing: { sentQuantity: 5, returnedQuantity: 5, history: [
    { requestId: "s", action: "send", quantity: 5, at: "2026-10-01T00:00:00Z" },
    { requestId: "r", action: "return", quantity: 5, at: "2026-10-02T00:00:00Z" },
  ] } };
  const partial = { ...legacy, id: "partial", quantity: 5, version: 2, polishing: { sentQuantity: 5, returnedQuantity: 2, history: [
    { requestId: "s", action: "send", quantity: 5, at: "2026-10-01T00:00:00Z" },
    { requestId: "r", action: "return", quantity: 2, at: "2026-10-02T00:00:00Z" },
  ] } };
  const canceled = { ...legacy, id: "canceled", quantity: 5, version: 2, polishing: { sentQuantity: 0, returnedQuantity: 0, history: [
    { requestId: "s", action: "send", quantity: 5, at: "2026-10-01T00:00:00Z" },
    { requestId: "c", action: "cancel", quantity: 5, at: "2026-10-02T00:00:00Z" },
  ] } };
  for (const previous of [full, partial, canceled]) {
    storage.set("production-board-demo-v2", JSON.stringify({ jobs: [previous], intake: [], settings: {} }));
    assert.equal(ui.invalidFinalFinishing({ ...previous, quantity: 6 }, previous), true, previous.id);
    await assert.rejects(ui.api.saveJob({ ...previous, quantity: 6 }), /研磨から全数戻るまで/, previous.id);
    assert.equal(ui.api.read().jobs[0].quantity, 5, `${previous.id} remains unchanged`);
  }

  const waiting = { ...legacy, id: "waiting", quantity: 5, version: 1, shippingStatus: "waiting" };
  storage.set("production-board-demo-v2", JSON.stringify({ jobs: [waiting], intake: [], settings: {} }));
  assert.equal(ui.invalidFinalFinishing({ ...waiting, shippingStatus: "shipped" }, waiting), true);
  await assert.rejects(ui.api.saveJob({ ...waiting, shippingStatus: "shipped" }), /研磨から全数戻るまで/);

  const fresh = { ...legacy, id: "new-shipped", version: undefined, shippingStatus: "shipped" };
  storage.set("production-board-demo-v2", JSON.stringify({ jobs: [], intake: [], settings: {} }));
  assert.equal(ui.invalidFinalFinishing(fresh, null), true);
  await assert.rejects(ui.api.saveJob(fresh), /研磨から全数戻るまで/);
});
