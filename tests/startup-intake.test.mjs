import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all(["Config.gs", "Parser.gs", "Repository.gs"].map(
  name => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"),
));

function harness(rows = []) {
  const grid = [], reads = [];
  let beforeValues = null;
  const sheet = {
    getLastRow: () => grid.length,
    getRange(row, column, height = 1, width = 1) {
      const getValues = kind => {
        reads.push({ row, column, height, width, kind });
        if (kind === "values") beforeValues?.({ row, column, height, width });
        return Array.from({ length: height }, (_, rowOffset) =>
          Array.from({ length: width }, (_, columnOffset) => grid[row + rowOffset - 1]?.[column + columnOffset - 1] ?? ""));
      };
      return { getValues: () => getValues("values"), getDisplayValues: () => getValues("display").map(row => row.map(String)) };
    },
  };
  grid.push([...contextHeaders()]);
  rows.forEach(row => grid.push(row));
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, Array, JSON, Error });
  vm.runInContext(sources.join("\n"), context);
  context.getSpreadsheet_ = () => ({ getSheetByName: () => sheet });
  return { context, grid, reads, setBeforeValues(callback) { beforeValues = callback; } };
}

function contextHeaders() {
  // Matches the canonical intake sheet shape without importing app internals.
  return ["id", "sourceType", "sourceRef", "receivedAt", "sender", "subject", "originalText", "parsedJson", "confidence", "status", "createdAt", "updatedAt"];
}

function row(id, status = "pending", extra = {}) {
  const item = { id, sourceType: "text", sourceRef: `source:${id}`, receivedAt: "2026-11-01T00:00:00.000Z", sender: "sender", subject: `subject ${id}`, originalText: `original ${id}`, parsedJson: JSON.stringify({ id }), confidence: 0.8, status, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...extra };
  return contextHeaders().map(key => item[key] ?? "");
}
const plain = value => JSON.parse(JSON.stringify(value));

test("pending-only intake reads scan narrow columns and fetch just the pending tail payloads", () => {
  const completed = Array.from({ length: 10_000 }, (_, index) => row(`done-${index}`, index % 2 ? "approved" : "rejected"));
  const pending = [row("pending-1"), row("pending-2"), row("pending-3")];
  const h = harness([...completed, ...pending]);

  const result = h.context.readIntake_({ pendingOnly: true });
  const fullReads = h.reads.filter(read => read.width === contextHeaders().length);
  assert.deepEqual(plain(result.map(item => item.id)), ["pending-1", "pending-2", "pending-3"]);
  assert.equal(h.reads[0].column, 10, "status is scanned first");
  assert.equal(h.reads[0].width, 1);
  assert.equal(h.reads.length, 2, "only a status scan and one payload read are needed");
  assert.deepEqual(fullReads.map(read => [read.row, read.height]), [[10_002, 3]]);
  assert.equal(fullReads.length, 1);
});

test("pending-only handles blank status, skips empty rows, and leaves default full reads unchanged", () => {
  const blankStatus = row("blank-status", "");
  blankStatus[3] = new Date("2026-11-01T00:00:00.000Z");
  const missingId = row("", "");
  missingId[0] = "";
  missingId[5] = "populated row without id or status";
  const h = harness([blankStatus, Array(contextHeaders().length).fill(""), missingId, row("approved", "approved")]);
  const pending = h.context.readIntake_({ pendingOnly: true });
  assert.deepEqual(plain(pending.map(item => [item.id, item.subject])), [["blank-status", "subject blank-status"], ["", "populated row without id or status"]]);
  assert.equal(h.reads.filter(read => read.width === contextHeaders().length).length, 1);
  assert.equal(h.reads.filter(read => read.width === 1).length, 1);

  h.reads.length = 0;
  const all = h.context.readIntake_();
  const expected = all.filter(item => !item.status || item.status === "pending");
  assert.deepEqual(JSON.stringify(plain(pending)), JSON.stringify(plain(expected)), "narrow result matches the full filtered reader, including normalized date values");
  assert.deepEqual(plain(all.map(item => [item.id, item.status])), [["blank-status", "pending"], ["", "pending"], ["approved", "approved"]]);
  assert.deepEqual(h.reads.map(read => [read.column, read.width, read.height]), [[1, contextHeaders().length, 4]]);
});

test("scattered pending rows across 10k entries are coalesced to at most eight payload reads and rechecked for approval races", () => {
  const items = [];
  for (let index = 0; index < 5_000; index += 1) items.push(row(`done-${index}`, "approved"), row(`pending-${index}`));
  const h = harness(items);
  const result = h.context.readIntake_({ pendingOnly: true });
  const payloadReads = h.reads.filter(read => read.width === contextHeaders().length);
  assert.equal(result.length, 5_000);
  assert.ok(payloadReads.length <= 8);
  assert.equal(h.reads.filter(read => read.width === 1).length, 1);

  const raced = harness([row("raced")]);
  raced.setBeforeValues(({ row: start, width }) => {
    if (width !== contextHeaders().length || start < 2) return;
    raced.grid[start - 1][9] = "approved";
  });
  assert.deepEqual(plain(raced.context.readIntake_({ pendingOnly: true})), []);
});

test("an empty intake sheet performs no range reads", () => {
  const h = harness();
  assert.deepEqual(plain(h.context.readIntake_({ pendingOnly: true })), []);
  assert.deepEqual(h.reads, []);
});

test("an all-approved queue reads only the narrow status column", () => {
  const h = harness([row("approved-1", "approved"), row("rejected-1", "rejected")]);
  assert.deepEqual(plain(h.context.readIntake_({ pendingOnly: true })), []);
  assert.deepEqual(h.reads.map(read => [read.column, read.width, read.height]), [[10, 1, 2]]);
});
