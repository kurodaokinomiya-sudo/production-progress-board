import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const names = ["Config.gs", "Repository.gs", "Code.gs"];
const sources = await Promise.all(names.map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")));
const allAssignees = ["豊", "幹", "望", "鈴", "河", "誠", "小", "保", "大", "順"];

function harness(initialRows = []) {
  const rows = [["key", "value", "description"], ...initialRows.map((row) => row.slice())];
  const sheet = {
    getDataRange: () => ({ getValues: () => rows.map((row) => row.slice()) }),
    getLastRow: () => rows.length,
    getRange: (row, column, count) => ({
      setValue: (value) => { rows[row - 1][column - 1] = value; },
      getDisplayValues: () => rows.slice(row - 1, row - 1 + count).map((entry) => entry.slice(column - 1, column - 1 + 3).map((value) => String(value ?? ""))),
    }),
    appendRow: (row) => rows.push(row.slice()),
  };
  const context = vm.createContext({ requireAppAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireAdminAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireEditorAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireOwnerAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), getAccessSettings: () => ({emails: [], version: 1}), Date, Math, Number, Object, String, JSON, RegExp, Array });
  vm.runInContext(sources.join("\n"), context);
  Object.assign(context, {
    getSpreadsheet_: () => ({ getSheetByName: () => sheet }),
    ensureSystem_: () => {},
    withDocumentLock_: (callback) => callback(),
    appendLog_: () => {},
  });
  return { context, rows };
}

test("distribution assignees are validated, de-duplicated, and saved in fixed order", () => {
  const { context, rows } = harness([["gmailQuery", "subject:注文", "既存設定"]]);
  const saved = context.saveSettings({ distributionAssignees: JSON.stringify(["順", "豊", "順", "幹"]) });
  const expected = JSON.stringify(["豊", "幹", "順"]);
  assert.equal(saved.distributionAssignees, expected);
  assert.equal(saved.gmailQuery, "subject:注文");
  assert.equal(rows.filter((row) => row[0] === "distributionAssignees").length, 1);
  assert.equal(rows.find((row) => row[0] === "distributionAssignees")[1], expected);
});

test("invalid distribution assignee settings reject before any setting is changed", () => {
  const { context, rows } = harness([["gmailQuery", "subject:注文", "既存設定"]]);
  const before = rows.map((row) => row.slice());
  for (const value of ["{", JSON.stringify({ names: ["豊"] }), JSON.stringify(["架空"])]) {
    assert.throws(() => context.saveSettings({ gmailQuery: "subject:発注", distributionAssignees: value }));
    assert.deepEqual(rows, before);
  }
});

test("an explicit empty list persists, repeated saves keep one row, and unrelated settings survive", () => {
  const { context, rows } = harness([
    ["gmailQuery", "subject:注文", "検索式"],
    ["stageAssignees", JSON.stringify({ base: [] }), "工程担当"],
  ]);
  const empty = context.saveSettings({ distributionAssignees: JSON.stringify([]) });
  assert.equal(empty.distributionAssignees, "[]");
  const saved = context.saveSettings({ distributionAssignees: JSON.stringify(["幹", "豊", "幹"]) });
  assert.equal(saved.distributionAssignees, JSON.stringify(["豊", "幹"]));
  assert.equal(saved.gmailQuery, "subject:注文");
  assert.equal(saved.stageAssignees, JSON.stringify({ base: [] }));
  assert.equal(rows.filter((row) => row[0] === "distributionAssignees").length, 1);
});
