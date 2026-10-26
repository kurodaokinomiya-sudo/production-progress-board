import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Synthetic Sheets boundary: text escape consumption and formula interpretation
// are intentionally separate from the app's encoder. This is not a live Sheets test.
export async function sheetsFixture(extraFiles = []) {
  const files = ["apps-script/Config.gs", "apps-script/Parser.gs", "apps-script/Repository.gs", ...extraFiles];
  const source = (await Promise.all(files.map(file => readFile(new URL(`../../${file}`, import.meta.url), "utf8")))).join("\n");
  const grids = new Map(), formulas = new Set(), properties = new Map();
  const state = { locked: false, writes: 0, beforeWrite: null, afterWrite: null, afterFlush: null };
  let uuid = 0;
  function sheet(name) {
    const grid = grids.get(name);
    if (!grid) return null;
    const result = {
      getLastRow: () => grid.length,
      getLastColumn: () => Math.max(0, ...grid.map(row => row.length)),
      getRange(row, column, height = 1, width = 1) {
        const values = () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => grid[row + r - 1]?.[column + c - 1] ?? ""));
        const range = {
          getValues: values, getDisplayValues: () => values().map(row => row.map(String)),
          setValues(rows) {
            state.beforeWrite?.({ name, row, column, rows });
            rows.forEach((cells, r) => {
              grid[row + r - 1] ||= [];
              cells.forEach((value, c) => {
                const key = `${name}:${row + r}:${column + c}`;
                formulas.delete(key);
                if (typeof value === "string" && value.startsWith("'")) value = value.slice(1);
                else if (typeof value === "string" && value.startsWith("=")) {
                  formulas.add(key);
                  value = value === "=1+1" ? 2 : "#ERROR!";
                }
                grid[row + r - 1][column + c - 1] = value;
              });
            });
            state.writes += 1;
            state.afterWrite?.({ name, row, column, rows });
            return range;
          },
          setValue(value) { return range.setValues([[value]]); },
          setFontWeight() { return range; }, setBackground() { return range; }, setFontColor() { return range; },
        };
        return range;
      },
      getDataRange() { return result.getRange(1, 1, grid.length, result.getLastColumn()); },
      appendRow(row) { result.getRange(grid.length + 1, 1, 1, row.length).setValues([row]); },
      setFrozenRows() {}, autoResizeColumns() {},
    };
    return result;
  }
  const spreadsheet = { getSheetByName: sheet, insertSheet(name) { grids.set(name, []); return sheet(name); } };
  const access = () => ({ role: "owner", email: "synthetic@example.com", canEdit: true, canWork: true, isOwner: true, isAdmin: true });
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, Array, JSON, Error,
    requireAppAccess_: access, requireEditorAccess_: access, requireWorkerAccess_: access, requireOwnerAccess_: access, requireAdminAccess_: access,
    Session: { getActiveUser: () => ({ getEmail: () => "synthetic@example.com" }) },
    SpreadsheetApp: { flush() { state.afterFlush?.(); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null, setProperty: (key, value) => properties.set(key, value), deleteProperty: key => properties.delete(key) }) },
    Utilities: { getUuid: () => `fixture-${++uuid}`, formatDate: date => new Date(+date + 9 * 3600000).toISOString().slice(0, 10) },
    LockService: { getDocumentLock: () => null, getScriptLock: () => ({ waitLock() { assert.equal(state.locked, false); state.locked = true; }, releaseLock() { state.locked = false; } }) },
  });
  vm.runInContext(source, context);
  context.getSpreadsheet_ = () => spreadsheet;
  context.ensureSystem_ = () => {};
  for (const [sheetKey, headerKey] of [["JOBS", "JOB_HEADERS"], ["INTAKE", "INTAKE_HEADERS"], ["SETTINGS", "SETTING_HEADERS"], ["LOG", "LOG_HEADERS"], ["LEARNING", "LEARNING_HEADERS"]]) {
    grids.set(context.APP.SHEETS[sheetKey], [[...context.APP[headerKey]]]);
  }
  return { context, grids, formulas, state, properties, sheet };
}
