import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("本番の管理リンクは実行中のスクリプトIDから作る", async () => {
  const source = await readFile(new URL("../apps-script/Code.gs", import.meta.url), "utf8");
  const context = vm.createContext({ ensureSystem_: () => {}, readJobs_: () => [], readIntake_: () => [], readSettings_: () => ({}), getAiImportStatus: () => ({}), ScriptApp: { getScriptId: () => "different-project_123" } });
  vm.runInContext(source, context);
  assert.equal(context.getSnapshot({}).scriptEditorUrl, "https://script.google.com/home/projects/different-project_123/edit");
});

test("管理リンクは別タブで開き、許可したGoogle URL以外を設定しない", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(html, /id="script-editor-link" target="_blank" rel="noopener noreferrer"/);
  assert.match(app, /editorLink\.hidden = !validEditorUrl/);
  assert.match(app, /editorLink\.removeAttribute\("href"\)/);
  assert.match(app, /state\.scriptEditorUrl = snapshot\.scriptEditorUrl \|\| ""/);
});
