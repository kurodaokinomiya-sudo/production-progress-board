import assert from "node:assert/strict";
import test from "node:test";
import { sheetsFixture } from "./helpers/sheets-fixture.mjs";

const texts = ["=1+1", "'原文", "''引用", "'=1+1", "日本語\n明細", "=日本語\n明細"];

test("job writer/reader and unrelated updates preserve literal text without leaking escapes into the model", async () => {
  for (const text of texts) {
    const h = await sheetsFixture(), c = h.context;
    let saved = c.saveJob({ customer: "検証商事", product: "鋭匙鉗子", quantity: 3, serialNo: text, note: text });
    assert.equal(saved.note, text);
    assert.equal(saved.serialNo, text);
    for (let retry = 0; retry < 2; retry += 1) {
      const loaded = c.readJobs_()[0];
      assert.equal(loaded.note, text);
      assert.equal(loaded.serialNo, text);
      saved = c.saveJob({ ...loaded, priority: retry ? "normal" : "high" });
    }
    assert.equal(c.readJobs_()[0].note, text);
    assert.equal(h.formulas.size, 0);
    assert.equal(typeof c.readJobs_()[0].quantity, "number");
    assert.equal(c.readJobs_()[0].archived, false);
    assert.equal(c.sanitizeText_(text), text);
  }
});

test("intake subject, sender, original text and parsed JSON survive status updates and read/write round trips", async () => {
  const h = await sheetsFixture(), c = h.context;
  for (const text of texts) {
    const original = c.appendIntake_({ sourceType: "text", sourceRef: `source:${text}`, subject: text, sender: text, originalText: text, parsed: { note: text, quantity: 5, verified: false }, confidence: 0.25 });
    c.updateIntakeStatus_(original.id, "rejected");
    const loaded = c.readIntake_().find(item => item.id === original.id);
    assert.equal(loaded.subject, text);
    assert.equal(loaded.sender, text);
    assert.equal(loaded.originalText, text);
    assert.equal(loaded.parsed.note, text);
    assert.equal(loaded.parsed.quantity, 5);
    assert.equal(loaded.parsed.verified, false);
    const copied = c.appendIntake_({ ...loaded, id: undefined, sourceRef: `copy:${text}` });
    assert.equal(c.readIntake_().find(item => item.id === copied.id).originalText, text);
  }
  assert.equal(h.formulas.size, 0);
});

test("settings, material and audit writers protect text while preserving numeric, boolean, date and JSON cell types", async () => {
  const h = await sheetsFixture(["apps-script/Code.gs", "apps-script/Materials.gs"]), c = h.context;
  c.getAccessSettings = () => ({});
  c.getAiImportStatus = () => ({});
  for (const text of texts) {
    c.saveSettings({ gmailQuery: text });
    assert.equal(c.readSettings_().gmailQuery, text);
    c.appendLog_(text, text, text, { note: text });
    const audit = c.readRows_(c.APP.SHEETS.LOG, c.APP.LOG_HEADERS).at(-1);
    assert.equal(audit.action, text);
    assert.equal(JSON.parse(audit.detailJson).note, text);
  }
  h.grids.set(c.APP.SHEETS.MATERIALS, [[...c.MATERIAL_EVENT_HEADERS_]]);
  const date = new Date("2026-10-23T01:02:03.000Z");
  c.appendMaterialEvents_([{ id: "event", action: "adjust", note: "=1+1", quantity: 3, date, orderDate: "2026-10-23" }]);
  const event = c.readMaterialEvents_()[0];
  assert.equal(event.note, "=1+1");
  assert.equal(event.quantity, 3);
  assert.equal(event.date, "2026-10-23");
  const cellDate = h.grids.get(c.APP.SHEETS.MATERIALS)[1][c.MATERIAL_EVENT_FIELDS_.indexOf("date")];
  assert.equal(cellDate, date);
  assert.equal(h.formulas.size, 0);
});
