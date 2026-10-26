import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { sheetsFixture } from "./helpers/sheets-fixture.mjs";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const { rebaseEditFields: merge, saveFailureKind } = vm.runInNewContext(`${source.slice(source.indexOf("function saveFailureKind"), source.indexOf("function recoveryFieldLabel"))}\n({rebaseEditFields, saveFailureKind})`);
const copy = value => JSON.parse(JSON.stringify(value));

test("three-way recovery retains remote untouched fields and reapplies only local edits", () => {
  const base = { note: "開始", quantity: "2", "stages.welding.status": "working", "stages.welding.assignee": "豊" };
  const mine = { ...base, note: "自分", "stages.welding.assignee": "幹" };
  const latest = { ...base, quantity: "5", "stages.welding.status": "done" };
  assert.deepEqual(copy(merge(base, mine, latest)), { values: { ...latest, note: "自分", "stages.welding.assignee": "幹" }, conflicts: [] });
  assert.deepEqual(base, { note: "開始", quantity: "2", "stages.welding.status": "working", "stages.welding.assignee": "豊" });
});

test("same-field changes require a choice, equal edits do not, and another update is compared again", () => {
  const base = { note: "開始", quantity: "2", labelKeywords: "" };
  const mine = { note: "自分", quantity: "4", labelKeywords: "白銅" };
  const latest = { note: "他端末", quantity: "4", labelKeywords: "ｱﾘｼﾞ" };
  const result = copy(merge(base, mine, latest));
  assert.deepEqual(result.conflicts.map(item => item.key), ["note", "labelKeywords"]);
  assert.equal(result.values.note, "他端末");
  assert.equal(result.values.quantity, "4");
  const chosen = { ...result.values, note: mine.note };
  assert.equal(merge(latest, chosen, { ...latest, note: "さらに更新" }).conflicts[0].key, "note");
});

test("explicit version conflicts and an uncertain network result remain distinct", () => {
  assert.equal(saveFailureKind(new Error("別の端末で先に更新されています。")), "conflict");
  assert.equal(saveFailureKind(new Error("response lost after commit")), "unknown");
});

test("worker process retry after a committed write loses no input and changes neither version nor protected order fields", async () => {
  const h = await sheetsFixture(), c = h.context;
  const job = c.saveJob({ customer: "検証用", product: "ケリソン 18cm", quantity: 2, note: "注文を保持", labelPrintStatus: "printed" });
  c.requireWorkerAccess_ = () => ({ canWork: true, canEdit: false });
  const request = { id: job.id, version: job.version, requestId: "process-retry", stages: { welding: { status: "working", assignee: "豊" } } };
  h.state.afterFlush = () => { h.state.afterFlush = null; throw new Error("lost response"); };
  assert.throws(() => c.saveJobProcess(request), /lost response/);
  const committed = c.readJobs_()[0], writes = h.state.writes;
  assert.equal(committed.stages.welding.status, "working");
  assert.equal(c.saveJobProcess(request).version, committed.version);
  assert.equal(h.state.writes, writes);
  assert.equal(c.readJobs_()[0].note, "注文を保持");
  assert.equal(c.readJobs_()[0].labelPrintStatus, "printed");
  assert.throws(() => c.saveJobProcess({ ...request, stages: { welding: { status: "hold", assignee: "豊" } } }), /同じリクエストID/);
  assert.throws(() => c.saveJobProcess({ ...request, customer: "偽造" }), /許可されていない/);
  const later = c.saveJob({ ...committed, note: "別の編集者", requestId: "later-order" });
  assert.equal(c.saveJobProcess(request).version, later.version);
  assert.equal(c.readJobs_()[0].note, "別の編集者");
  c.setJobArchived({ id: later.id, version: later.version, archived: true });
  assert.throws(() => c.saveJobProcess(request), /削除済み/);
});

test("a new process request never bypasses an old version and archived/missing order saves stay blocked", async () => {
  const h = await sheetsFixture(), c = h.context;
  const job = c.saveJob({ customer: "検証用", product: "ケリソン 18cm", quantity: 2 });
  const stages = { welding: { status: "working", assignee: "豊" } };
  const first = c.saveJobProcess({ id: job.id, version: job.version, stages, requestId: "first" });
  assert.throws(() => c.saveJobProcess({ id: job.id, version: job.version, stages, requestId: "different" }), /別の端末/);
  const archived = c.setJobArchived({ id: job.id, version: first.version, archived: true });
  assert.throws(() => c.saveJob({ ...archived, archived: false }), /削除済み/);
  assert.throws(() => c.saveJob({ ...job, id: "missing" }), /見つかりません/);
});
