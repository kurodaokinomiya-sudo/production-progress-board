import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const names = ["Config.gs", "Repository.gs", "Code.gs"];
const sources = await Promise.all(names.map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")));

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

const defaultAssignees = ["豊", "幹", "望", "鈴", "河", "誠", "小", "保", "大", "順"];

test("stage assignee choices persist as canonical JSON and retain unrelated settings", () => {
  const { context, rows } = harness([["gmailQuery", "subject:注文", "既存設定"]]);
  const saved = context.saveSettings({
    maxEmailThreads: "12",
    stageAssignees: JSON.stringify({ welding: ["豊", "幹", "豊"], base: [], heat: ["順"] }),
  });
  const expected = { welding: ["豊", "幹"], base: [], grinding: defaultAssignees, heat: ["順"], finish: defaultAssignees, heatSharp: ["順"] };
  assert.equal(saved.stageAssignees, JSON.stringify(expected));
  assert.equal(saved.maxEmailThreads, "12");
  assert.equal(saved.gmailQuery, "subject:注文");
  assert.equal(rows.filter((row) => row[0] === "stageAssignees").length, 1);
  assert.equal(rows.find((row) => row[0] === "stageAssignees")[1], JSON.stringify(expected));
});

test("invalid stage assignee JSON or values reject before any setting is changed", () => {
  const { context, rows } = harness([["gmailQuery", "subject:注文", "既存設定"]]);
  const before = rows.map((row) => row.slice());
  for (const value of [
    "{", JSON.stringify({ unknown: [] }), JSON.stringify({ welding: "豊" }), JSON.stringify({ base: ["架空"] }),
    ...["順", null, {}, [1], ["架空"], ["順", null]].map((heatSharp) => JSON.stringify({ heatSharp })),
    JSON.stringify({ heatSharpOther: [] }),
  ]) {
    assert.throws(() => context.saveSettings({ gmailQuery: "subject:発注", stageAssignees: value }));
    assert.deepEqual(rows, before);
  }
});

test("explicit empty assignee list remains empty and omitted stages default to all candidates", () => {
  const { context } = harness();
  const saved = context.saveSettings({ stageAssignees: JSON.stringify({ finish: [], heatSharp: [] }) });
  const parsed = JSON.parse(saved.stageAssignees);
  assert.deepEqual(parsed.finish, []);
  assert.deepEqual(parsed.heatSharp, []);
  assert.deepEqual(parsed.heat, defaultAssignees);
  assert.deepEqual(parsed.welding, defaultAssignees);
});

test("sharp heat and regular heat choices round-trip independently without adding a job stage", () => {
  const { context, rows } = harness([["distributionAssignees", JSON.stringify(["幹"]), "配布担当"]]);
  const saved = context.saveSettings({ stageAssignees: JSON.stringify({ heat: ["豊", "豊", "幹"], heatSharp: ["河", "順", "河"] }) });
  const parsed = JSON.parse(saved.stageAssignees);
  assert.deepEqual(parsed.heat, ["豊", "幹"]);
  assert.deepEqual(parsed.heatSharp, ["河", "順"]);
  assert.deepEqual(Array.from(context.APP.STAGES), ["welding", "base", "grinding", "heat", "finish"]);
  const roundTripped = context.saveSettings({ stageAssignees: saved.stageAssignees });
  assert.equal(roundTripped.stageAssignees, saved.stageAssignees);
  assert.equal(roundTripped.distributionAssignees, JSON.stringify(["幹"]));
  assert.equal(rows.filter((row) => row[0] === "stageAssignees").length, 1);
});

test("legacy settings inherit normalized heat choices for sharp heat, including an empty list", () => {
  const { context } = harness();
  for (const legacy of [{ heat: ["順", "順", "河"] }, { heat: [] }, {}]) {
    const saved = context.saveSettings({ stageAssignees: JSON.stringify(legacy) });
    const parsed = JSON.parse(saved.stageAssignees);
    assert.deepEqual(parsed.heatSharp, parsed.heat);
    assert.deepEqual(parsed.heat, legacy.heat ? [...new Set(legacy.heat)] : defaultAssignees);
    assert.deepEqual(parsed.base, defaultAssignees);
  }
});
