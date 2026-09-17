import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const [config, parser, repository] = await Promise.all([
  readFile(new URL("../apps-script/Config.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Parser.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Repository.gs", import.meta.url), "utf8"),
]);

const context = vm.createContext({
  Date,
  Math,
  Number,
  Object,
  RegExp,
  String,
  Utilities: { getUuid: () => "test-uuid" },
});
vm.runInContext(`${config}\n${parser}\n${repository}`, context);

const stages = () => Object.fromEntries(
  ["welding", "base", "grinding", "heat", "finish"].map((key) => [key, { status: "done", assignee: "" }]),
);

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
  stages: stages(),
  shippingStatus,
  note: "",
  priority: "normal",
});

test("出荷完了は全工程完了でなければ拒否する", () => {
  const input = baseInput("shipped");
  input.stages.finish.status = "working";
  assert.throws(
    () => context.normalizeJobInput_(input, null),
    /出荷完了にするには、すべての工程を完了/
  );
});

test("出荷待ちへ戻すと完了日時を消し、再出荷時は新しい日時を付ける", () => {
  const existing = {
    id: "JOB-001",
    version: 4,
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-20T01:02:03.000Z",
    shippingStatus: "shipped",
    stages: stages(),
    category: "ケリソンパンチ",
  };
  const reopened = context.normalizeJobInput_(
    { ...baseInput("waiting"), id: existing.id, version: existing.version },
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
