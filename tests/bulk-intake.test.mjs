import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const [config, parser, repository] = await Promise.all([
  readFile(new URL("../apps-script/Config.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Parser.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Repository.gs", import.meta.url), "utf8"),
]);

const copy = (value) => JSON.parse(JSON.stringify(value));
const freshStages = () => Object.fromEntries(
  ["welding", "base", "grinding", "heat", "finish"].map((key) => [key, { status: "done", assignee: "豊" }]),
);
const validOrder = (overrides = {}) => ({
  customer: "検証用商事",
  product: "ケリソンパンチ 18cm",
  category: "",
  dueDate: "2026-09-30",
  quantity: 2,
  specLength: "",
  specShape: "",
  bladeWidth: "",
  serialNo: "BULK-01",
  note: "",
  id: "client-controlled-id",
  version: 99,
  sourceType: "client-controlled-source",
  sourceRef: "client-controlled-ref",
  labelPrintStatus: "printed",
  labelPrintedAt: "2026-01-01T00:00:00.000Z",
  shippingStatus: "shipped",
  archived: true,
  priority: "urgent",
  stages: freshStages(),
  ...overrides,
});

function harness({ intakes = [], jobs = [], saveFailure, statusFailure } = {}) {
  const rows = { intakes: copy(intakes), jobs: copy(jobs) };
  const calls = { locks: 0, saves: [], statuses: [], logs: [] };
  let saveCount = 0;
  let statusCount = 0;
  const context = vm.createContext({ Date, Math, Number, Object, String, JSON, RegExp, Error });
  vm.runInContext(`${config}\n${parser}\n${repository}`, context);
  Object.assign(context, {
    Utilities: { getUuid: () => `generated-${++saveCount}` },
    ensureSystem_: () => {},
    withDocumentLock_: (callback) => {
      calls.locks += 1;
      return callback();
    },
    readIntake_: () => copy(rows.intakes),
    readJobs_: () => copy(rows.jobs),
    saveJobUnlocked_: (input) => {
      calls.saves.push(copy(input));
      const job = context.normalizeJobInput_(input, null);
      job.id = `JOB-${rows.jobs.length + 1}`;
      if (saveFailure && saveFailure(input, job)) throw new Error("案件保存に失敗しました。");
      rows.jobs.push(copy(job));
      return job;
    },
    updateIntakeStatus_: (id, status) => {
      calls.statuses.push({ id, status });
      statusCount += 1;
      if (statusFailure && statusFailure({ id, status, count: statusCount })) throw new Error("候補状態の保存に失敗しました。");
      const item = rows.intakes.find((entry) => String(entry.id) === String(id));
      if (!item) throw new Error("取込候補が見つかりません。");
      item.status = status;
    },
    appendLog_: (action, entityType, entityId, detail) => {
      calls.logs.push({ action, entityType, entityId, detail });
    },
  });
  return { context, rows, calls };
}

const pending = (id, overrides = {}) => ({
  id,
  sourceType: "email",
  sourceRef: `gmail:${id}`,
  status: "pending",
  parsed: {},
  ...overrides,
});

test("複数候補を一度のロックで案件化し、管理用状態を上書きする", () => {
  const h = harness({ intakes: [pending("I-1"), pending("I-2")] });
  const result = h.context.approveIntakes({ items: [
    { intakeId: "I-1", order: validOrder() },
    { intakeId: "I-2", order: validOrder({ quantity: 3 }) },
  ] });

  assert.equal(h.calls.locks, 1);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(Array.from(result.items, (entry) => entry.intakeId), ["I-1", "I-2"]);
  assert.equal(h.rows.jobs.length, 2);
  assert.deepEqual(h.rows.intakes.map((entry) => entry.status), ["approved", "approved"]);
  assert.deepEqual(Array.from(result.items, (entry) => entry.job.sourceType), ["intake", "intake"]);
  for (const [index, order] of h.calls.saves.entries()) {
    assert.equal(order.id, undefined);
    assert.equal(order.version, undefined);
    assert.equal(order.sourceType, "intake");
    assert.equal(order.sourceRef, `I-${index + 1}`);
    assert.equal(order.labelPrintStatus, "waiting");
    assert.equal(order.labelPrintedAt, "");
    assert.equal(order.shippingStatus, "not_ready");
    assert.equal(order.archived, false);
    assert.equal(order.priority, "normal");
    assert.deepEqual(copy(Object.values(order.stages)), [
      { status: "not_started", assignee: "" },
      { status: "not_started", assignee: "" },
      { status: "not_started", assignee: "" },
      { status: "not_started", assignee: "" },
      { status: "not_started", assignee: "" },
    ]);
  }
});

test("検証は全候補を先に行い、1件でも不正なら案件・候補を書き込まない", () => {
  const h = harness({ intakes: [pending("I-1"), pending("I-2"), pending("I-3")] });
  const result = h.context.approveIntakes({ items: [
    { intakeId: "I-1", order: validOrder({ quantity: 0 }) },
    { intakeId: "I-2", order: validOrder({ dueDate: "2026-02-31" }) },
    { intakeId: "I-3", order: validOrder({ customer: "" }) },
  ] });

  assert.equal(h.calls.locks, 1);
  assert.equal(result.items.length, 0);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0].message, /数量を原本と確認/);
  assert.match(result.errors[1].message, /納期は正しい日付/);
  assert.match(result.errors[2].message, /得意先を入力/);
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.calls.statuses.length, 0);
  assert.equal(h.calls.logs.length, 0);
  assert.equal(h.rows.jobs.length, 0);
  assert.deepEqual(h.rows.intakes.map((entry) => entry.status), ["pending", "pending", "pending"]);
});

test("同じ候補IDの重複は全件を無書込で拒否する", () => {
  const h = harness({ intakes: [pending("I-1")] });
  const result = h.context.approveIntakes({ items: [
    { intakeId: "I-1", order: validOrder() },
    { intakeId: "I-1", order: validOrder() },
  ] });

  assert.equal(result.items.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].intakeId, "I-1");
  assert.match(result.errors[0].message, /重複/);
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.calls.statuses.length, 0);
  assert.equal(h.rows.jobs.length, 0);
});

test("承認済み候補はアーカイブ済み案件も返し、再試行で新規案件を作らない", () => {
  const archivedJob = {
    id: "JOB-ARCHIVED",
    customer: "検証用商事",
    product: "ケリソンパンチ 18cm",
    sourceType: "intake",
    sourceRef: "I-1",
    archived: true,
    version: 2,
  };
  const h = harness({ intakes: [pending("I-1", { status: "approved" })], jobs: [archivedJob] });
  const result = h.context.approveIntakes({ items: [{ intakeId: "I-1", order: {} }] });

  assert.equal(result.errors.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].job.id, "JOB-ARCHIVED");
  assert.equal(result.items[0].job.archived, true);
  assert.equal(h.calls.locks, 1);
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.calls.statuses.length, 0);
  assert.equal(h.rows.jobs.length, 1);
});

test("旧形式でsourceRefを共有する兄弟候補は1案件へ誤紐付けせず無書込にする", () => {
  const sharedRef = "gmail:shared:item-source";
  const h = harness({
    intakes: [
      pending("I-1", { status: "approved", sourceRef: sharedRef }),
      pending("I-2", { status: "approved", sourceRef: sharedRef }),
    ],
    jobs: [{
      id: "JOB-LEGACY",
      customer: "検証用商事",
      product: "ケリソンパンチ 18cm",
      sourceType: "email",
      sourceRef: sharedRef,
      archived: false,
    }],
  });
  const result = h.context.approveIntakes({ items: [
    { intakeId: "I-1", order: {} },
    { intakeId: "I-2", order: {} },
  ] });

  assert.equal(result.items.length, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(Array.from(result.errors).every((entry) => /特定できません/.test(entry.message)));
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.calls.statuses.length, 0);
  assert.equal(h.rows.jobs.length, 1);
});

test("保存後の候補状態失敗は部分結果として返し、再試行で同じ案件を確定する", () => {
  let failOnce = true;
  const h = harness({
    intakes: [pending("I-1")],
    statusFailure: () => {
      if (!failOnce) return false;
      failOnce = false;
      return true;
    },
  });
  const request = { items: [{ intakeId: "I-1", order: validOrder() }] };
  const first = h.context.approveIntakes(request);

  assert.equal(first.items.length, 0);
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0].message, /候補状態の保存/);
  assert.equal(h.rows.jobs.length, 1);
  assert.equal(h.rows.intakes[0].status, "pending");

  const second = h.context.approveIntakes({ items: [{ intakeId: "I-1", order: {} }] });
  assert.equal(second.errors.length, 0);
  assert.equal(second.items[0].job.id, h.rows.jobs[0].id);
  assert.equal(h.rows.jobs.length, 1);
  assert.equal(h.rows.intakes[0].status, "approved");
  assert.equal(h.calls.saves.length, 1);
});

test("一行の実行失敗で他行を巻き戻さず、次の再試行でも重複しない", () => {
  const h = harness({
    intakes: [pending("I-1"), pending("I-2")],
    saveFailure: (input) => input.sourceRef === "I-2",
  });
  const request = { items: [
    { intakeId: "I-1", order: validOrder() },
    { intakeId: "I-2", order: validOrder({ quantity: 4 }) },
  ] };
  const first = h.context.approveIntakes(request);

  assert.deepEqual(Array.from(first.items, (entry) => entry.intakeId), ["I-1"]);
  assert.equal(first.errors.length, 1);
  assert.equal(first.errors[0].intakeId, "I-2");
  assert.equal(h.rows.jobs.length, 1);
  assert.equal(h.rows.intakes[0].status, "approved");
  assert.equal(h.rows.intakes[1].status, "pending");

  const second = h.context.approveIntakes(request);
  assert.equal(second.errors.length, 1);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].intakeId, "I-1");
  assert.equal(h.rows.jobs.length, 1);
});

test("一括承認は1〜100件を明示的に受け付ける", () => {
  const h = harness({ intakes: [pending("I-1")] });
  assert.throws(() => h.context.approveIntakes({ items: [] }), /1〜100件/);
  assert.throws(() => h.context.approveIntakes({ items: Array.from({ length: 101 }, (_, index) => ({ intakeId: `I-${index}`, order: validOrder() })) }), /1〜100件/);
  assert.equal(h.calls.locks, 0);
  assert.equal(h.rows.jobs.length, 0);
});

test("複数候補を一度のロックでrejectedにし、候補行を物理削除しない", () => {
  const h = harness({ intakes: [pending("I-1"), pending("I-2")] });
  const result = h.context.rejectIntakes({ intakeIds: ["I-1", "I-2"] });

  assert.equal(h.calls.locks, 1);
  assert.deepEqual(copy(result), {
    items: [{ intakeId: "I-1" }, { intakeId: "I-2" }],
    errors: [],
  });
  assert.equal(h.rows.intakes.length, 2);
  assert.deepEqual(h.rows.intakes.map((entry) => entry.status), ["rejected", "rejected"]);
  assert.deepEqual(h.calls.statuses, [
    { id: "I-1", status: "rejected" },
    { id: "I-2", status: "rejected" },
  ]);
  assert.deepEqual(Array.from(h.calls.logs, (entry) => [entry.action, entry.entityId]), [
    ["intake.reject", "I-1"],
    ["intake.reject", "I-2"],
  ]);
  assert.equal(h.calls.saves.length, 0);
});

test("一括削除は重複・不正IDを全件検証してから書き込まない", () => {
  const h = harness({ intakes: [pending("I-1"), pending("I-2")] });
  const result = h.context.rejectIntakes({ intakeIds: ["I-1", "I-1", ""] });

  assert.equal(h.calls.locks, 1);
  assert.equal(result.items.length, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].message, /重複/);
  assert.match(result.errors[1].message, /不正/);
  assert.equal(h.calls.statuses.length, 0);
  assert.equal(h.calls.logs.length, 0);
  assert.deepEqual(h.rows.intakes.map((entry) => entry.status), ["pending", "pending"]);
});

test("rejected候補は再試行で成功し、承認済み候補と紐づく案件は保護する", () => {
  const h = harness({
    intakes: [
      pending("I-1", { status: "rejected" }),
      pending("I-2"),
      pending("I-3", { status: "approved" }),
    ],
    jobs: [{ id: "JOB-2", sourceType: "intake", sourceRef: "I-2", archived: true }],
  });

  const protectedResult = h.context.rejectIntakes({ intakeIds: ["I-2", "I-3"] });
  assert.equal(protectedResult.items.length, 0);
  assert.equal(protectedResult.errors.length, 2);
  assert.match(protectedResult.errors[0].message, /紐づく案件/);
  assert.match(protectedResult.errors[1].message, /承認済み/);
  assert.equal(h.calls.statuses.length, 0);
  assert.deepEqual(h.rows.intakes.map((entry) => entry.status), ["rejected", "pending", "approved"]);
  assert.equal(h.rows.jobs.length, 1);

  const retry = h.context.rejectIntakes({ intakeIds: ["I-1"] });
  assert.deepEqual(copy(retry), { items: [{ intakeId: "I-1" }], errors: [] });
  assert.equal(h.calls.locks, 2);
  assert.equal(h.calls.statuses.length, 0);
  assert.equal(h.calls.logs.length, 0);
});

test("一括削除の状態保存失敗は部分結果にし、再試行で残りを確定する", () => {
  let failOnce = true;
  const h = harness({
    intakes: [pending("I-1"), pending("I-2")],
    statusFailure: ({ id }) => {
      if (id !== "I-2" || !failOnce) return false;
      failOnce = false;
      return true;
    },
  });

  const first = h.context.rejectIntakes({ intakeIds: ["I-1", "I-2"] });
  assert.deepEqual(copy(first.items), [{ intakeId: "I-1" }]);
  assert.equal(first.errors.length, 1);
  assert.equal(first.errors[0].intakeId, "I-2");
  assert.match(first.errors[0].message, /候補状態の保存/);
  assert.deepEqual(h.rows.intakes.map((entry) => entry.status), ["rejected", "pending"]);
  assert.equal(h.rows.intakes.length, 2);

  const second = h.context.rejectIntakes({ intakeIds: ["I-1", "I-2"] });
  assert.deepEqual(copy(second), {
    items: [{ intakeId: "I-1" }, { intakeId: "I-2" }],
    errors: [],
  });
  assert.deepEqual(h.rows.intakes.map((entry) => entry.status), ["rejected", "rejected"]);
  assert.deepEqual(h.calls.statuses, [
    { id: "I-1", status: "rejected" },
    { id: "I-2", status: "rejected" },
    { id: "I-2", status: "rejected" },
  ]);
});

test("個別削除も一括APIの結果形式とロック保護に従う", () => {
  const h = harness({ intakes: [pending("I-1")] });
  const result = h.context.rejectIntake({ intakeId: "I-1" });

  assert.deepEqual(copy(result), { ok: true });
  assert.equal(h.calls.locks, 1);
  assert.equal(h.rows.intakes[0].status, "rejected");
});

test("個別削除は一括APIの保護エラーを旧形式の例外として返す", () => {
  const h = harness({
    intakes: [pending("I-1")],
    jobs: [{ id: "JOB-1", sourceType: "intake", sourceRef: "I-1", archived: true }],
  });

  assert.throws(() => h.context.rejectIntake({ intakeId: "I-1" }), /紐づく案件/);
  assert.equal(h.calls.locks, 1);
  assert.equal(h.calls.statuses.length, 0);
  assert.equal(h.rows.intakes[0].status, "pending");
});

test("一括削除は1〜100件を明示的に受け付ける", () => {
  const h = harness({ intakes: [pending("I-1")] });
  assert.throws(() => h.context.rejectIntakes({ intakeIds: [] }), /1〜100件/);
  assert.throws(() => h.context.rejectIntakes({ intakeIds: Array.from({ length: 101 }, (_, index) => `I-${index}`) }), /1〜100件/);
  assert.equal(h.calls.locks, 0);
  assert.equal(h.rows.intakes[0].status, "pending");
});
