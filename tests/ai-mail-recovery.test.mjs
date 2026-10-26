import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sheetsFixture } from "./helpers/sheets-fixture.mjs";

const results = () => [1, 2, 3].map(row => ({ itemNumber: row, parsed: {
  customer: "合成テスト", product: `検証製品${row}`, quantity: row, note: "=1+1",
  _ai: { document: 1, page: 1, row: String(row), evidence: "合成fixture", warnings: [] },
}, confidence: 0 }));
const envelope = { receivedAt: "2026-10-23T00:00:00.000Z", sender: "fixture@example.invalid", subject: "=合成注文" };

async function harness() {
  const h = await sheetsFixture(["apps-script/Import.gs", "apps-script/AiImport.gs"]), c = h.context;
  c.Utilities.DigestAlgorithm = { SHA_256: "sha256" };
  c.Utilities.Charset = { UTF_8: "utf8" };
  c.Utilities.computeDigest = (_algorithm, value) => [...createHash("sha256").update(value).digest()];
  c.runAiImport_ = () => { assert.equal(h.state.locked, false); h.aiCalls += 1; return h.results; };
  h.aiCalls = 0;
  h.results = results();
  const message = id => ({
    getId: () => id, getSubject: () => envelope.subject, getFrom: () => envelope.sender,
    getDate: () => new Date(envelope.receivedAt), getPlainBody: () => "合成fixtureのみ",
    getAttachments: () => [],
  });
  h.messages = [message("synthetic-mail")];
  h.message = message;
  c.GmailApp = { search() { assert.equal(h.state.locked, false); return [{ getMessages: () => h.messages }]; } };
  h.scan = () => c.scanOrderEmailsWithAi_({});
  h.rows = () => c.readIntake_();
  h.batch = () => c.prepareAiMailBatch_("gmail:synthetic-mail", h.results, envelope);
  return h;
}

for (const failure of ["before", "partial", "after-write", "after-flush"]) {
  test(`a three-line mail recovers exactly once after ${failure} failure`, async () => {
    const h = await harness(), c = h.context;
    if (failure === "before" || failure === "partial") h.state.beforeWrite = operation => {
      if (operation.name !== c.APP.SHEETS.INTAKE) return;
      h.state.beforeWrite = null;
      if (failure === "partial") h.sheet(operation.name).getRange(operation.row, operation.column, 1, operation.rows[0].length).setValues(operation.rows.slice(0, 1));
      throw new Error("synthetic storage failure");
    };
    if (failure === "after-write") h.state.afterWrite = operation => {
      if (operation.name !== c.APP.SHEETS.INTAKE) return;
      h.state.afterWrite = null;
      throw new Error("synthetic lost write response");
    };
    if (failure === "after-flush") h.state.afterFlush = () => { h.state.afterFlush = null; throw new Error("synthetic lost flush response"); };
    assert.throws(h.scan, /synthetic/);
    assert.equal(h.state.locked, false);
    const retried = h.scan();
    assert.equal(h.rows().length, 3);
    assert.equal(new Set(h.rows().map(row => row.sourceRef)).size, 3);
    assert.equal(c.aiMailBatchState_("gmail:synthetic-mail", h.rows(), []).kind, "complete");
    assert.equal(h.scan().added, 0);
    assert.equal(h.rows().length, 3);
    assert.equal(h.formulas.size, 0);
    if (failure === "partial") assert.equal(retried.added, 2);
  });
}

test("recovery preserves approved/rejected lines and their linked jobs; reordered AI output is the same batch", async () => {
  const h = await harness(), c = h.context, batch = h.batch();
  c.withDocumentLock_(() => c.appendIntakes_(batch.items.slice(0, 2)));
  const rows = h.rows();
  c.updateIntakeStatus_(rows[0].id, "approved");
  c.updateIntakeStatus_(rows[1].id, "rejected");
  c.saveJob({ customer: "合成テスト", product: "承認済み", quantity: 1, sourceRef: rows[0].sourceRef });
  h.results.reverse();
  assert.equal(h.scan().added, 1);
  assert.equal(h.rows().find(row => row.id === rows[0].id).status, "approved");
  assert.equal(h.rows().find(row => row.id === rows[1].id).status, "rejected");
  assert.equal(c.readJobs_().length, 1);
  assert.equal(h.rows().length, 3);
});

test("changed AI contents during partial recovery stop before writing and remain visibly incomplete", async () => {
  const h = await harness(), c = h.context;
  c.withDocumentLock_(() => c.appendIntakes_(h.batch().items.slice(0, 1)));
  const writes = h.state.writes;
  h.results[2].parsed.quantity = 999;
  assert.throws(h.scan, /AI_MAIL_REVIEW_REQUIRED/);
  assert.equal(h.state.writes, writes);
  assert.equal(c.aiMailBatchState_("gmail:synthetic-mail", h.rows(), []).kind, "partial");
});

test("another import can complete while AI runs; the later writer rechecks under lock without duplicates", async () => {
  const h = await harness(), c = h.context, original = c.runAiImport_;
  c.runAiImport_ = () => { c.runAiImport_ = original; assert.equal(h.scan().added, 3); return h.results; };
  assert.equal(h.scan().skipped, 1);
  assert.equal(h.rows().length, 3);
});

test("legacy partial mail is reported for review, while an independent new mail can continue", async () => {
  const h = await harness(), c = h.context;
  c.appendIntake_({ sourceType: "email", sourceRef: "gmail:synthetic-mail:item:1", parsed: results()[0].parsed, status: "approved" });
  let report = h.scan();
  assert.deepEqual(Array.from(report.reviewRequired), ["gmail:synthetic-mail"]);
  assert.ok(report.warnings.every(warning => !warning.includes("未取込メールはありません")));
  assert.equal(h.aiCalls, 0);
  h.messages.push(h.message("independent"));
  report = h.scan();
  assert.equal(report.added, 3);
  assert.equal(h.rows().length, 4);
  assert.equal(h.rows()[0].status, "approved");
});

test("batch serialization failure validates all candidates before any row is saved", async () => {
  const h = await harness();
  h.results[2].parsed.note = "長".repeat(46000);
  assert.throws(h.scan, /保存文字数/);
  assert.equal(h.rows().length, 0);
});
