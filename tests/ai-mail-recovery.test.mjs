import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gmailMessage, gmailPartData, gmailTextPart, stubGmail } from "./helpers/gmail-fixture.mjs";
import { sheetsFixture } from "./helpers/sheets-fixture.mjs";

const results = () => [1, 2, 3].map(row => ({ itemNumber: row, parsed: {
  customer: "合成テスト", product: `検証製品${row}`, quantity: row, note: "=1+1",
  _ai: { document: 1, page: 1, row: String(row), evidence: "合成fixture", warnings: [] },
}, confidence: 0 }));
const envelope = { receivedAt: "2026-10-23T00:00:00.000Z", sender: "fixture@example.invalid", subject: "=合成注文" };

async function harness() {
  const h = await sheetsFixture(["src/intake-learning.js", "apps-script/IntakeLearning.gs", "apps-script/Import.gs", "apps-script/AiImport.gs"]), c = h.context;
  c.Utilities.DigestAlgorithm = { SHA_256: "sha256" };
  c.Utilities.Charset = { UTF_8: "utf8" };
  c.Utilities.computeDigest = (_algorithm, value) => [...createHash("sha256").update(value).digest()];
  c.runAiImport_ = () => { assert.equal(h.state.locked, false); h.aiCalls += 1; return h.results; };
  h.aiCalls = 0;
  h.results = results();
  const message = (id, text = "合成fixtureのみ", threadId = id) => gmailMessage(id, {
    ...envelope, threadId, payload: gmailTextPart(text),
  });
  h.messages = [message("synthetic-mail")];
  h.message = message;
  h.searches = [];
  h.reads = [];
  stubGmail(c, {
    list(userId, options) {
      assert.equal(h.state.locked, false);
      assert.equal(userId, "me");
      h.searches.push({ ...options });
      return { messages: h.messages.map(({ id, threadId }) => ({ id, threadId })) };
    },
    get(userId, id, options) {
      assert.equal(h.state.locked, false);
      assert.equal(userId, "me");
      assert.equal(options.format, "full");
      h.reads.push(id);
      return h.messages.find(message => message.id === id);
    },
  });
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

test("remembered Gmail rows retain their original source and recover a partial batch without AI", async () => {
  const h = await harness(), c = h.context;
  const body = "得意先: 合成テスト\n品名: ケリソン18cm上向3mm\n数量: 7\n納期: 2027-01-10\n品名: ケリソン18cm上向3mm\n数量: 9\n納期: 2027-02-15";
  const parsed = c.parsePastedOrderItems_(body, {})[0].parsed;
  const rule = c.IntakeLearning.remember({ rules: [], parsed, order: parsed, intakeId: "memory-confirmed" }).rule;
  c.withDocumentLock_(() => c.writeIntakeLearningRule_(rule));
  h.messages = [h.message("memory-mail", body)];
  h.state.beforeWrite = operation => {
    if (operation.name !== c.APP.SHEETS.INTAKE) return;
    h.state.beforeWrite = null;
    h.sheet(operation.name).getRange(operation.row, operation.column, 1, operation.rows[0].length).setValues(operation.rows.slice(0, 1));
    throw new Error("synthetic partial memory save");
  };
  assert.throws(() => c.scanOrderEmails({ engine: "auto" }), /synthetic partial memory save/);
  assert.equal(c.scanOrderEmails({ engine: "auto" }).added, 1);
  assert.equal(h.aiCalls, 0);
  assert.equal(h.rows().length, 2);
  assert.deepEqual(Array.from(h.rows(), row => row.parsed.quantity).sort((a, b) => a - b), [7, 9]);
  assert.ok(h.rows().every(row => row.originalText.includes(body) && row.parsed._memory));
  assert.equal(c.scanOrderEmails({ engine: "auto" }).added, 0);
});

test("legacy intake reads only messages returned by the active Gmail query, across pages within the thread limit", async () => {
  const h = await harness(), c = h.context;
  const query = "subject:合成";
  const order = "得意先: 合成テスト\n品名: ケリソン18cm上向3mm\n数量: 7\n納期: 2027-01-10";
  h.messages = [h.message("older-order", order, "thread-one"), h.message("newer-order", order, "thread-one")];
  c.Gmail.Users.Messages.list = (userId, options) => {
    assert.equal(userId, "me");
    assert.equal(options.q, query);
    h.searches.push(options.pageToken ?? "first");
    if (options.pageToken === "second") return { messages: [
      { id: "another-thread", threadId: "thread-two" },
      { id: "older-order", threadId: "thread-one" },
    ], nextPageToken: "past-thread-limit" };
    assert.equal(options.pageToken, undefined);
    return { messages: [{ id: "newer-order", threadId: "thread-one" }], nextPageToken: "second" };
  };
  const report = c.scanOrderEmails({ query, maxThreads: 1 });
  assert.equal(report.scannedThreads, 1);
  assert.equal(report.added, 2);
  assert.deepEqual(h.searches, ["first", "second"]);
  assert.deepEqual(h.reads, ["older-order", "newer-order"]);
  assert.deepEqual(Array.from(h.rows(), row => row.sourceRef), ["gmail:older-order", "gmail:newer-order"]);
  assert.equal(c.scanOrderEmails({ query, maxThreads: 1 }).skipped, 2);
  assert.deepEqual(h.reads, ["older-order", "newer-order"]);
});

test("all Gmail scan modes require a query and leave the queue empty when there are no matching messages", async () => {
  const h = await harness(), c = h.context;
  h.messages = [];
  for (const engine of ["legacy", "ai", "auto"]) {
    assert.throws(() => c.scanOrderEmails({ engine, query: " \n " }), /Gmail検索式を入力/);
    assert.throws(() => c.scanOrderEmails({ engine, query: `subject:${"検".repeat(1000)}` }), /1000文字以内/);
  }
  assert.equal(h.searches.length, 0);
  c.readSettings_ = () => ({ gmailQuery: "subject:確認用" });
  for (const engine of ["legacy", "ai", "auto"]) {
    assert.equal(c.scanOrderEmails({ engine }).added, 0);
  }
  assert.deepEqual(h.searches.map(options => options.q), ["subject:確認用", "subject:確認用", "subject:確認用"]);
  assert.equal(h.reads.length, 0);
  assert.equal(h.aiCalls, 0);
  assert.equal(h.rows().length, 0);
});

test("legacy Gmail intake skips unsupported attachments and reads up to three supported files", async () => {
  const h = await harness(), c = h.context;
  const attachment = (mimeType, filename) => ({ mimeType, filename, body: { attachmentId: filename, size: 1 } });
  const payload = {
    mimeType: "multipart/mixed", parts: [
      gmailTextPart("得意先: 合成テスト\n品名: ケリソン18cm上向3mm\n数量: 7\n納期: 2027-01-10"),
      attachment("text/csv", "other.csv"), attachment("application/pdf", "order.pdf"),
      attachment("image/png", "order.png"), attachment("image/bmp", "order.bmp"), attachment("image/gif", "extra.gif"),
    ],
  };
  h.messages = [gmailMessage("attachment-order", { ...envelope, payload })];
  const fetched = [], ocrFiles = [];
  c.Gmail.Users.Messages.Attachments.get = (userId, messageId, attachmentId) => {
    assert.equal(userId, "me");
    assert.equal(messageId, "attachment-order");
    fetched.push(attachmentId);
    return gmailPartData([1]);
  };
  c.ocrBlob_ = blob => { ocrFiles.push(blob.name); return "注文詳細参考資料"; };
  assert.equal(c.scanOrderEmails({ query: "subject:合成" }).added, 1);
  assert.deepEqual(fetched, ["order.pdf", "order.png", "order.bmp"]);
  assert.deepEqual(ocrFiles, fetched);
  assert.match(h.rows()[0].originalText, /添付「order\.pdf」の読取結果/);
});

test("AI Gmail intake reports unsupported or excess attachments before reading their bytes", async () => {
  const h = await harness(), c = h.context;
  for (const [types, message] of [
    [["image/gif"], /AI非対応の添付/],
    [Array(4).fill("application/pdf"), /添付が4件以上あります/],
  ]) {
    const payload = { mimeType: "multipart/mixed", parts: types.map((mimeType, index) => ({
      mimeType, filename: `file-${index}`, body: { attachmentId: `att-${index}`, size: 1 },
    })) };
    h.messages = [gmailMessage("attachment-order", { ...envelope, payload })];
    assert.throws(() => c.scanOrderEmails({ engine: "ai", query: "subject:合成" }), message);
  }
  assert.equal(h.aiCalls, 0);
  assert.equal(h.rows().length, 0);
});
