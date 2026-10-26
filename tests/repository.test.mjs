import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const [config, parser, repository] = await Promise.all([
  readFile(new URL("../apps-script/Config.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Parser.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Repository.gs", import.meta.url), "utf8"),
]);

const context = vm.createContext({ requireAppAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireAdminAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireEditorAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireWorkerAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true, canWork: true}), requireOwnerAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), getAccessSettings: () => ({emails: [], version: 1}),
  Date,
  Math,
  Number,
  Object,
  RegExp,
  String,
  Utilities: { getUuid: () => "test-uuid" },
});
vm.runInContext(`${config}\n${parser}\n${repository}`, context);

test("sheet due dates and monthly identifiers retain the Japan calendar day while timestamps remain UTC", () => {
  const localContext = vm.createContext({ Date, Math, Number, Object, RegExp, String,
    Utilities: { formatDate: (date, timeZone, pattern) => {
      assert.equal(timeZone, "Asia/Tokyo");
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(date).map((part) => [part.type, part.value]));
      if (pattern === "M-d") return `${Number(parts.month)}-${Number(parts.day)}`;
      assert.equal(pattern, "yyyy-MM-dd");
      return `${parts.year}-${parts.month}-${parts.day}`;
    } },
  });
  vm.runInContext(`${config}\n${parser}\n${repository}`, localContext);
  const headers = ["dueDate", "createdAt", "updatedAt", "serialNo"];
  const createdAt = new Date("2026-10-13T00:44:55.000Z");
  const values = [
    [new Date("2026-10-30T15:00:00.000Z"), createdAt, createdAt, new Date("2026-09-30T15:00:00.000Z")],
    [new Date("2027-01-30T15:00:00.000Z"), createdAt, createdAt, new Date("2026-11-02T15:00:00.000Z")],
    ["2026-12-24", createdAt, createdAt, "26-1552-6"],
  ];
  localContext.getSpreadsheet_ = () => ({ getSheetByName: () => ({
    getLastRow: () => values.length + 1,
    getRange: () => ({ getValues: () => values }),
  }) });
  const rows = localContext.readRows_("工程管理_案件", headers);
  assert.deepEqual(Array.from(rows, (row) => row.dueDate), ["2026-10-31", "2027-01-31", "2026-12-24"]);
  assert.deepEqual(Array.from(rows, (row) => row.serialNo), ["10-1", "11-3", "26-1552-6"]);
  for (const row of rows) {
    assert.equal(row.createdAt, createdAt.toISOString());
    assert.equal(row.updatedAt, createdAt.toISOString());
  }
});

const stages = () => Object.fromEntries(
  ["welding", "base", "grinding", "heat", "finish"].map((key) => [key, { status: "done", assignee: "" }]),
);
const fullReturn = (quantity = 1) => ({ sentQuantity: quantity, returnedQuantity: quantity, history: [
  { requestId: "sent", action: "send", quantity, at: "2026-10-01T00:00:00.000Z" },
  { requestId: "returned", action: "return", quantity, at: "2026-10-02T00:00:00.000Z" },
] });

const baseInput = (shippingStatus = "waiting") => ({
  customer: "テスト商事",
  product: "ケリパンチ 18cm 2mm",
  category: "",
  dueDate: "",
  quantity: 1,
  specLength: "",
  specShape: "",
  bladeWidth: "",
  serialNo: "1",
  stages: { ...stages(), finish: { status: shippingStatus === "shipped" ? "done" : "working", assignee: "" } },
  shippingStatus,
  note: "",
  priority: "normal",
});

test("出荷完了は最終仕上げが未完了なら拒否する", () => {
  for (const status of ["not_started", "working", "hold"]) {
    const input = baseInput("shipped");
    input.stages.finish.status = status;
    assert.throws(
      () => context.normalizeJobInput_(input, null),
      /出荷完了にするには、最終仕上げを完了/
    );
  }
});

test("最終仕上げが完了なら途中工程を変更せず出荷し、出荷日時を保持する", () => {
  const input = baseInput("shipped");
  input.stages.welding.status = "not_started";
  input.stages.base.status = "working";
  input.stages.grinding.status = "hold";
  input.stages.heat.status = "not_started";
  const existing = { ...baseInput(), id: "RETURNED", version: 4, createdAt: "2026-10-01T00:00:00.000Z", polishing: fullReturn() };
  const saved = context.normalizeJobInput_(input, existing);
  assert.equal(saved.shippingStatus, "shipped");
  assert.ok(saved.completedAt);
  assert.equal(saved.version, 5);
  for (const [key, stage] of Object.entries(input.stages)) assert.equal(saved.stages[key].status, stage.status, key);

  const updated = context.normalizeJobInput_({ ...input, id: saved.id, version: saved.version }, saved);
  assert.equal(updated.completedAt, saved.completedAt);
  assert.equal(updated.version, 6);
});

test("最終仕上げ完了で出荷しても研磨の未返却・未送付数量を許可しない", () => {
  const input = { ...baseInput("shipped"), quantity: 2 };
  input.stages.welding.status = "not_started";
  const event = (action, quantity) => ({ requestId: action, action, quantity, at: "2026-10-13T00:00:00.000Z" });
  const existing = { id: "JOB-POLISH", version: 4, createdAt: "2026-10-01T00:00:00.000Z" };
  for (const [sent, returned] of [[2, 1], [1, 1]]) {
    const polishing = { sentQuantity: sent, returnedQuantity: returned, history: [event("send", sent), event("return", returned)] };
    assert.throws(() => context.normalizeJobInput_(input, { ...existing, polishing }), /研磨の全数発送と全数の戻り/);
  }
  const polishing = { sentQuantity: 2, returnedQuantity: 2, history: [event("send", 2), event("return", 2)] };
  assert.equal(context.normalizeJobInput_(input, { ...existing, polishing }).shippingStatus, "shipped");
});

test("出荷待ちへ戻すと完了日時を消し、再出荷時は新しい日時を付ける", () => {
  const existing = {
    id: "JOB-001",
    version: 4,
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-20T01:02:03.000Z",
    shippingStatus: "shipped",
    stages: stages(),
    quantity: 1,
    polishing: fullReturn(),
    category: "ケリソンパンチ",
  };
  const reopened = context.normalizeJobInput_(
    { ...baseInput("waiting"), stages: stages(), id: existing.id, version: existing.version },
    existing,
  );
  assert.equal(reopened.shippingStatus, "waiting");
  assert.equal(reopened.completedAt, "");

  const reShipped = context.normalizeJobInput_(
    { ...baseInput("shipped"), id: existing.id, version: reopened.version },
    { ...existing, ...reopened },
  );
  assert.equal(reShipped.shippingStatus, "shipped");
  assert.ok(reShipped.completedAt);
  assert.notEqual(reShipped.completedAt, existing.completedAt);
});

test("最終仕上げは正しい製造数量の全数発送・全数戻りの実績だけで完了できる", () => {
  assert.equal(context.finalFinishingReady_({ quantity: 1, polishing: fullReturn() }), true);
  for (const quantity of ["", 0, -1, 0.5, null, undefined, Infinity, NaN]) {
    assert.equal(context.finalFinishingReady_({ quantity, polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] } }), false);
  }
  for (const polishing of [undefined, { sentQuantity: 0, returnedQuantity: 0, history: [] }, fullReturn(1)]) {
    const input = { ...baseInput(), quantity: 2, stages: stages() };
    const existing = { ...baseInput(), id: "BEFORE-RETURN", version: 4, polishing };
    assert.equal(context.finalFinishingReady_({ quantity: input.quantity, polishing }), false);
    assert.throws(() => context.normalizeJobInput_(input, existing), /研磨の全数発送と全数の戻り/);
  }
  assert.throws(() => context.normalizeJobInput_({ ...baseInput("shipped"), polishing: fullReturn() }, null), /研磨の全数発送と全数の戻り/, "client-supplied polishing does not create a real return");
  const completed = { ...baseInput(), stages: stages(), id: "RETURNED", version: 4, quantity: 1, polishing: fullReturn() };
  assert.throws(() => context.normalizeJobInput_({ ...completed, quantity: 2 }, completed), /研磨の全数発送と全数の戻り/, "increasing quantity cannot grandfather a once-valid completion");
});

test("旧通常仕上げの完了を維持して編集できるが、全数戻りのない出荷は許可しない", () => {
  const existing = { ...baseInput(), id: "LEGACY-ORDINARY", version: 4, stages: stages(), polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] } };
  const edited = context.normalizeJobInput_({ ...existing, note: "旧案件の確認" }, existing);
  assert.equal(edited.stages.finish.status, "done");
  assert.equal(edited.note, "旧案件の確認");
  assert.equal(edited.shippingStatus, "waiting");
  assert.throws(() => context.normalizeJobInput_({ ...edited, shippingStatus: "shipped" }, edited), /研磨の全数発送と全数の戻り/);
  const downgraded = context.normalizeJobInput_({ ...edited, stages: { ...edited.stages, finish: { status: "working", assignee: "" } } }, edited);
  assert.equal(downgraded.stages.finish.status, "working");
  assert.throws(() => context.normalizeJobInput_({ ...downgraded, stages: stages() }, downgraded), /研磨の全数発送と全数の戻り/);
});

test("研磨実績のない過去の出荷済み案件も通常編集で出荷日時や工程を作り替えない", () => {
  for (const completedAt of ["", "2024-05-06T01:02:03.000Z"]) {
    for (const finishStatus of ["done", "working"]) {
      const existing = { ...baseInput("shipped"), id: "LEGACY-SHIPPED", version: 4, completedAt,
        stages: { ...stages(), finish: { status: finishStatus, assignee: "望" } }, polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] } };
      const edited = context.normalizeJobInput_({ ...existing, note: "過去の備考だけ修正" }, existing);
      assert.equal(edited.shippingStatus, "shipped");
      assert.equal(edited.completedAt, completedAt);
      assert.equal(edited.stages.finish.status, finishStatus);
      assert.equal(edited.note, "過去の備考だけ修正");
      const corrected = context.normalizeJobInput_({ ...existing, quantity: 2 }, existing);
      assert.equal(corrected.quantity, 2);
      assert.equal(corrected.shippingStatus, "shipped");
      assert.equal(corrected.completedAt, completedAt);
      assert.equal(corrected.stages.finish.status, finishStatus);
      assert.deepEqual(JSON.parse(JSON.stringify(corrected.polishing)), existing.polishing);
      const changedFinish = { ...existing.stages, finish: { ...existing.stages.finish, status: finishStatus === "done" ? "working" : "done" } };
      assert.throws(() => context.normalizeJobInput_({ ...existing, quantity: 2, stages: changedFinish }, existing), /最終仕上げを完了|研磨の全数発送と全数の戻り/);
    }
  }
});

test("保存時の不正な明示大分類を拒否する", () => {
  const input = baseInput("waiting");
  input.category = "その他";
  assert.throws(() => context.normalizeJobInput_(input, null), /大分類の値が不正/);
});

test("担当者は固定候補または空欄だけを保存できる", () => {
  assert.equal(context.APP.ASSIGNEES.join(""), "豊幹望鈴河誠小保大順");
  const valid = baseInput("waiting");
  valid.stages.welding.assignee = "豊";
  valid.stages.base.assignee = "";
  const saved = context.normalizeJobInput_(valid, null);
  assert.equal(saved.stages.welding.assignee, "豊");
  assert.equal(saved.stages.base.assignee, "");

  const invalid = baseInput("waiting");
  invalid.stages.welding.assignee = "太郎";
  assert.throws(
    () => context.normalizeJobInput_(invalid, null),
    /工程「welding」の担当者が不正/
  );
});

test("既存行の不正担当者は読込時に消去せず、次回保存時に検証する", () => {
  const row = {
    id: "JOB-OLD",
    customer: "旧得意先",
    product: "鋭匙鉗子",
    weldingAssignee: "太郎",
    baseAssignee: "",
    grindingAssignee: "",
    heatAssignee: "",
    finishAssignee: "",
  };
  const job = context.jobFromRow_(row);
  assert.equal(job.stages.welding.assignee, "太郎");
});

test("旧案件は印刷待ちへ勝手に追加せず、印刷済みラベル項目の変更だけを再印刷待ちにする", () => {
  const legacy = context.jobFromRow_({ id: "JOB-LEGACY", customer: "旧得意先", product: "ケリパンチ" });
  assert.equal(legacy.labelPrintStatus, "not_required");

  const existing = {
    ...context.normalizeJobInput_(baseInput("waiting"), null),
    id: "JOB-LABEL",
    version: 4,
    labelPrintStatus: "printed",
    labelPrintedAt: "2026-08-27T01:02:03.000Z",
  };
  const noteOnly = context.normalizeJobInput_(
    { ...baseInput("waiting"), id: existing.id, version: existing.version, labelPrintStatus: "printed", note: "工程メモだけ変更" },
    existing,
  );
  assert.equal(noteOnly.labelPrintStatus, "printed");
  assert.equal(noteOnly.labelPrintedAt, existing.labelPrintedAt);

  const labelEdited = context.normalizeJobInput_(
    { ...baseInput("waiting"), id: existing.id, version: existing.version, labelPrintStatus: "printed", quantity: 2 },
    existing,
  );
  assert.equal(labelEdited.labelPrintStatus, "reprint");
  assert.equal(labelEdited.labelPrintedAt, "");

  const labelNoLongerNeeded = context.normalizeJobInput_(
    { ...baseInput("waiting"), id: existing.id, version: existing.version, labelPrintStatus: "not_required", quantity: 3 },
    existing,
  );
  assert.equal(labelNoLongerNeeded.labelPrintStatus, "not_required");
});

test("削除済みフラグを一貫して判定する", () => {
  assert.equal(context.isArchivedValue_(true), true);
  assert.equal(context.isArchivedValue_("TRUE"), true);
  assert.equal(context.isArchivedValue_(false), false);
  assert.equal(context.isArchivedValue_(""), false);
});

test("製品番号は品名と分けた既存列位置へ保存して再読込できる", () => {
  const input = { ...baseInput("waiting"), productCode: "06-04-08" };
  const saved = context.normalizeJobInput_(input, null);
  const row = context.jobToRow_(saved);
  const productCodeColumn = context.APP.JOB_HEADERS.indexOf("productCode");
  assert.equal(productCodeColumn, 34);
  assert.deepEqual(Array.from(context.APP.JOB_HEADERS.slice(productCodeColumn)), ["productCode", "externalOrderNo", "externalLineNo", "materialsJson", "stockPlannedQuantity", "completionKind", "processSaveJson"]);
  assert.equal(row[context.APP.JOB_HEADERS.indexOf("product")], "ケリパンチ 18cm 2mm");
  assert.equal(row[productCodeColumn], "06-04-08");
  const record = Object.fromEntries(context.APP.JOB_HEADERS.map((header, index) => [header, row[index]]));
  assert.equal(context.jobFromRow_(record).productCode, "06-04-08");
});

test("旧備考の品番は専用値へ移行し、通常編集で明示的に消せる", () => {
  const legacyRow = { id: "JOB-LEGACY-CODE", customer: "旧得意先", product: "ケリソン", note: "旧メモ / 品番: 06-07-L" };
  const loaded = context.jobFromRow_(legacyRow);
  assert.equal(loaded.productCode, "06-07-L");
  const cleared = context.normalizeJobInput_({ ...loaded, ...baseInput("waiting"), id: loaded.id, version: loaded.version, productCode: "", note: loaded.note }, loaded);
  assert.equal(cleared.productCode, "");
  assert.equal(cleared.note, "旧メモ");
  const row = context.jobToRow_(cleared);
  const record = Object.fromEntries(context.APP.JOB_HEADERS.map((header, index) => [header, row[index]]));
  assert.equal(context.jobFromRow_(record).productCode, "");
});
