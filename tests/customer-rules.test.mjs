import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const sourceNames = ["Config.gs", "Parser.gs", "Repository.gs", "AiImport.gs", "Code.gs"];
const sources = await Promise.all(sourceNames.map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")));

function makeSheet(initialRows = []) {
  const rows = [["key", "value", "description"], ...initialRows.map((row) => row.slice())];
  const range = (row, column, count) => ({
    getValues: () => rows.slice(row - 1, row - 1 + count).map((entry) => entry.slice(column - 1, column - 1 + 3)),
    getDisplayValues: () => rows.slice(row - 1, row - 1 + count).map((entry) => entry.slice(column - 1, column - 1 + 3).map((value) => String(value ?? ""))),
    setValue: (value) => { rows[row - 1][column - 1] = value; },
    setValues: (values) => values.forEach((valuesRow, index) => { rows[row - 1 + index].splice(column - 1, valuesRow.length, ...valuesRow); }),
  });
  return {
    rows,
    getLastRow: () => rows.length,
    getSheetValues: () => rows.map((row) => row.slice()),
    getRange: (row, column, rowCount) => range(row, column, rowCount),
    appendRow: (row) => rows.push(row.slice()),
  };
}

function harness(initialRows = []) {
  const sheet = makeSheet(initialRows);
  const spreadsheet = { getSheetByName: () => sheet };
  const context = vm.createContext({ Date, Math, Number, Object, String, JSON, RegExp, Array });
  vm.runInContext(sources.join("\n"), context);
  Object.assign(context, {
    getSpreadsheet_: () => spreadsheet,
    ensureSystem_: () => {},
    withDocumentLock_: (callback) => callback(),
    appendLog_: () => {},
    SpreadsheetApp: { flush: () => {} },
  });
  return { context, sheet };
}

const rules = (overrides = {}) => ({
  ownCompanyNames: ["有限会社 興之宮医科工業"],
  aliases: [{ issuer: "ミズホ株式会社", customer: "ミズホ" }],
  ...overrides,
});

const item = (customer) => ({
  customer,
  product: "ケリソン 18cm 上向 3.5mm",
  quantity: 1,
  dueDate: "2026-11-30",
  serialNo: "TEST-01",
  specLength: "",
  specShape: "",
  bladeWidth: "",
  note: "",
  sourceDocument: 0,
  sourcePage: 1,
  sourceRow: "1",
  evidence: "発注元と明細",
  warnings: [],
});

const response = (items) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ complete: true, documentItemCount: items.length, printedQuantityTotal: null, warnings: [], items }) }] } }] });

test("customerRulesの未保存時はversion 0の初期値を返す", () => {
  const { context } = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(context.getCustomerRules())), {
    version: 0,
    ownCompanyNames: ["有限会社 興之宮医科工業"],
    aliases: [
      { issuer: "ミズホ株式会社", customer: "ミズホ" },
      { issuer: "ミズホ株式会社 五泉工場", customer: "ミズホ" },
      { issuer: "田中医科器械製作所", customer: "田中" },
    ],
  });
});

test("customerRulesは単一JSONセルだけを更新し、別設定を保持する", () => {
  const { context, sheet } = harness([["gmailQuery", "subject:注文", "既存設定"]]);
  const saved = context.saveCustomerRules({ expectedVersion: 0, rules: rules() });
  assert.equal(saved.version, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.getCustomerRules())), JSON.parse(JSON.stringify(saved)));
  const values = sheet.getSheetValues();
  assert.equal(values.filter((row) => row[0] === "customerRules").length, 1);
  assert.equal(values.find((row) => row[0] === "gmailQuery")[1], "subject:注文");
  assert.deepEqual(JSON.parse(values.find((row) => row[0] === "customerRules")[1]), JSON.parse(JSON.stringify(saved)));
});

test("customerRulesは保存時にversion競合を拒否する", () => {
  const { context, sheet } = harness();
  const saved = context.saveCustomerRules({ expectedVersion: 0, rules: rules() });
  assert.throws(() => context.saveCustomerRules({ expectedVersion: 0, rules: rules({ aliases: [] }) }), /別の端末|更新/);
  assert.deepEqual(context.getCustomerRules(), saved);
  assert.equal(sheet.getSheetValues().filter((row) => row[0] === "customerRules").length, 1);
});

test("customerRulesは上限、重複、自社を変換先にする矛盾を拒否する", () => {
  const { context } = harness();
  assert.throws(() => context.normalizeCustomerRules_(rules({ ownCompanyNames: Array.from({ length: 21 }, (_, index) => `会社${index}`) })), /20/);
  assert.throws(() => context.normalizeCustomerRules_(rules({ aliases: Array.from({ length: 51 }, (_, index) => ({ issuer: `発注元${index}`, customer: "顧客" })) })), /50/);
  assert.throws(() => context.normalizeCustomerRules_(rules({ ownCompanyNames: ["自社", " 自社 "] })), /重複/);
  assert.throws(() => context.normalizeCustomerRules_(rules({ ownCompanyNames: ["自社"], aliases: [{ issuer: "相手", customer: "自社" }] })), /自社.*変換先/);
  assert.throws(() => context.normalizeCustomerRules_(rules({ aliases: [{ issuer: "同じ会社", customer: "同じ会社" }] })), /同じ/);
  assert.throws(() => context.normalizeCustomerRules_(rules({ aliases: [{ issuer: "相手\n会社", customer: "顧客" }] })), /制御文字/);
  assert.throws(() => context.saveCustomerRules({ expectedVersion: 0, rules: undefined }), /配列/);
});

test("保存済みの不正JSONは初期値へ黙って戻さない", () => {
  const { context } = harness([["customerRules", "{not-json", ""]]);
  assert.throws(() => context.getCustomerRules(), /JSONが不正/);
});

test("AIは発注元欄だけaliasを適用し、自社名は空欄と確認警告にする", () => {
  const { context } = harness();
  const custom = rules({ ownCompanyNames: ["有限会社 興之宮医科工業"], aliases: [{ issuer: "ミズホ株式会社", customer: "ミズホ" }] });
  const ownItem = item("有限会社　興之宮医科工業");
  ownItem.sourceRow = "2";
  const result = context.validateAiImportResponse_(response([item("ミズホ 株式会社"), ownItem]), custom);
  assert.equal(result[0].parsed.customer, "ミズホ");
  assert.equal(result[1].parsed.customer, "");
  assert.match(result[1].parsed._ai.warnings.join(" "), /自社|確認/);
  const mentionedOnly = item("検証用商事");
  mentionedOnly.evidence = "本文にミズホ株式会社が記載されているだけ";
  assert.equal(context.validateAiImportResponse_(response([mentionedOnly]), custom)[0].parsed.customer, "検証用商事");
});

test("AIのrequestは保存ルールを受け取り、client inputのrulesを参照しない", () => {
  const { context } = harness();
  const custom = rules({ ownCompanyNames: ["自社株式会社"], aliases: [{ issuer: "発注元株式会社", customer: "発注元" }] });
  const request = context.aiImportRequest_({ text: "本文", rules: rules({ aliases: [] }) }, custom);
  const prompt = request.systemInstruction.parts[0].text;
  assert.match(prompt, /自社株式会社/);
  assert.match(prompt, /発注元株式会社/);
  assert.match(prompt, /殿/);
  assert.match(prompt, /御中/);
  assert.equal(request.generationConfig.responseJsonSchema, undefined);
});

test("本番取込は保存済みルールのスナップショットを使い、実行中の更新や入力偽装に影響されない", () => {
  const { context } = harness();
  context.saveCustomerRules({ expectedVersion: 0, rules: rules({ aliases: [{ issuer: "検証会社", customer: "保存した名前" }] }) });
  let prompt;
  context.sendAiRequest_ = (request) => {
    prompt = request.systemInstruction.parts[0].text;
    context.saveCustomerRules({ expectedVersion: 1, rules: rules({ aliases: [{ issuer: "検証会社", customer: "後で変更した名前" }] }) });
    return response([item("検証会社")]);
  };
  const result = context.runAiImport_({ text: "注文", customerRules: rules({ aliases: [{ issuer: "検証会社", customer: "入力に混ぜた名前" }] }) });
  assert.match(prompt, /保存した名前/);
  assert.doesNotMatch(prompt, /入力に混ぜた名前/);
  assert.equal(result[0].parsed.customer, "保存した名前");
});

test("削除した対応は固定プロンプトにも残さず、殿や御中つきの自社名を除外する", () => {
  const { context } = harness();
  const custom = rules({ aliases: [] });
  const request = context.aiImportRequest_({ text: "注文" }, custom);
  assert.doesNotMatch(request.systemInstruction.parts[0].text, /田中医科器械製作所は田中/);
  assert.equal(context.validateAiImportResponse_(response([item("田中医科器械製作所")]), custom)[0].parsed.customer, "田中医科器械製作所");
  for (const name of ["有限会社 興之宮医科工業 殿", "興之宮医科工業御中"]) {
    assert.equal(context.validateAiImportResponse_(response([item(name)]), custom)[0].parsed.customer, "");
  }
});
