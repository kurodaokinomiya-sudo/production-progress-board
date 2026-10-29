import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const files = ["Config.gs", "Parser.gs", "Repository.gs", "ProductMaster.gs", "Polishing.gs"];
const sources = await Promise.all(files.map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")));
const fixtureRows = [
  { productCode: "06-04-08", product: "鋭匙鉗子 ｱﾘｼﾞ", shape: "直", bladeWidth: "8mm", specLength: "210.0", material: "道中210上", customer: "田中医科" },
  { productCode: "06-04-8", product: "鋭匙鉗子 白銅", shape: "直", bladeWidth: "8mm", specLength: "210.0", material: "グリワルド", customer: "田中医科" },
  { productCode: "H-1", product: "鋭匙鉗子 同名", shape: "直", bladeWidth: "8mm", specLength: "210", material: "西端", customer: "甲社" },
  { productCode: "H-1", product: "鋭匙鉗子 同名", shape: "曲", bladeWidth: "10mm", specLength: "230", material: "コットマン", customer: "乙社" },
  { productCode: "M-1", product: "鋭匙鉗子 混合", shape: "直", bladeWidth: "8mm", specLength: "210", material: "西端", customer: "甲社" },
  { productCode: "M-1", product: "鋭匙鉗子 混合", shape: "直", bladeWidth: "8mm", specLength: "210", material: "コットマン", customer: "甲社" },
  { productCode: "D-1", product: "倍力 Yケリソン", shape: "直", bladeWidth: "8mm", specLength: "210", material: "西端", customer: "甲社" },
];

test("注文番号に似たマスタ番号も保持し、名前で照合した区分修正は次回の製品番号にも使える", () => {
  const h = harness();
  assert.equal(h.context.legacyProductCodeFromNote_("品番: TC_26_0404 / 材料"), "TC_26_0404");
  assert.equal(h.context.storedProductCode_("TC_26_0404"), "TC_26_0404");
  assert.equal(h.context.legacyProductCodeFromNote_("品番: 06-04-08 / 材料"), "06-04-08");
  const byName = {productCode:"OLD-NOT-IN-MASTER",product:"鋭匙鉗子 同名",customer:"甲社",specShape:"直",bladeWidth:"8mm",specLength:"21cm"};
  const byCode = {...byName,productCode:"H-1"};
  const decorated = h.context.decorateProductJobs_([byName,byCode], {});
  assert.equal(decorated[0].productMaster.status, "matched");
  assert.equal(decorated[0].productMaster.key, decorated[1].productMaster.key);
});
let role = "admin";

function harness() {
  let settings = {};
  const jobs = [{ id: "J1", version: 3, productCode: "H-1", product: "鋭匙鉗子 同名", customer: "甲社", specShape: "直", bladeWidth: "8mm", specLength: "210", note: "", polishing: { history: [] } }];
  const ctx = vm.createContext({
    Date, Math, Number, Object, String, Array, JSON, RegExp, Error,
    requireAdminAccess_: () => { if (!(["admin", "owner"].includes(role))) throw new Error("ADMIN_REQUIRED:"); return { isOwner: role === "owner", canEdit: ["admin", "owner"].includes(role) }; },
    requireEditorAccess_: () => { if (!(["editor", "admin", "owner"].includes(role))) throw new Error("EDITOR_REQUIRED:"); return { isOwner: role === "owner", canEdit: ["editor", "admin", "owner"].includes(role) }; },
    requireAppAccess_: () => ({ email: "test@example.com" }),
    ensureSystem_: () => {}, withDocumentLock_: (fn) => fn(), appendLog_: () => {},
    Utilities: { formatDate: (date, zone, format) => {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return format === "yyyy-MM" ? `${values.year}-${values.month}` : `${values.year}-${values.month}-${values.day}`;
    } },
  });
  vm.runInContext(sources.join("\n"), ctx);
  const nativeLoadProductMaster = ctx.loadProductMaster_;
  ctx.withDocumentLock_ = (fn) => fn();
  ctx.loadProductMaster_ = () => fixtureRows;
  ctx.appendLog_ = () => {};
  ctx.ensureSystem_ = () => {};
  ctx.readSettings_ = () => settings;
  ctx.readJobs_ = () => jobs.map((job) => structuredClone(job));
  ctx.writeProductSetting_ = (key, value) => { settings[key] = value; };
  ctx.syncPolishingMirrorBestEffort_ = () => "";
  return { context: ctx, nativeLoadProductMaster, get settings() { return settings; }, set settings(value) { settings = value; }, jobs };
}

test("product codes match exactly and duplicate material rows aggregate while class rules respect precedence", () => {
  const h = harness();
  const [exact, similar, mixed, precedence] = h.context.decorateProductJobs_([
    { productCode: "06-04-08", product: "", customer: "田中医科" },
    { productCode: "06-04-8", product: "", customer: "田中医科" },
    { productCode: "M-1", product: "", customer: "甲社" },
    { productCode: "D-1", product: "", customer: "甲社" },
  ], {});
  assert.equal(exact.productMaster.productCode, "06-04-08");
  assert.equal(similar.productMaster.productCode, "06-04-8");
  assert.notEqual(exact.productMaster.productCode, similar.productMaster.productCode);
  assert.deepEqual([...exact.productMaster.labelKeywords], ["ｱﾘｼﾞ"]);
  assert.equal(mixed.productMaster.material, "西端 / コットマン");
  assert.equal(mixed.productMaster.classCode, "A");
  assert.equal(h.context.classifyProduct_("鋭匙鉗子", ["ヘルニア", "コットマン"]).classCode, "B");
  assert.equal(precedence.productMaster.classCode, "特殊");
  assert.equal(h.context.classifyProduct_("段付きヘルニア", []).classCode, "未分類", "unsupported name-only B/C inference stays disabled");
  const noCode = h.context.decorateProductJobs_([{ product: "倍力 Yケリソン", customer: "甲社" }], {})[0];
  const withCode = h.context.decorateProductJobs_([{ productCode: "D-1", product: "倍力 Yケリソン", customer: "甲社" }], {})[0];
  assert.equal(noCode.productMaster.key, withCode.productMaster.key, "name-matched jobs converge on the canonical code and customer key");
});

test("same-code candidates disambiguate by customer and specs; unresolved identities stay ambiguous", () => {
  const h = harness();
  const jobs = h.context.decorateProductJobs_([
    { productCode: "H-1", customer: "乙社", specShape: "曲", bladeWidth: "10 mm", specLength: "23cm" },
    { productCode: "H-1", customer: "不明", specShape: "", bladeWidth: "", specLength: "" },
  ], {});
  assert.equal(jobs[0].productMaster.status, "matched");
  assert.equal(jobs[0].productMaster.classCode, "C");
  assert.equal(jobs[1].productMaster.status, "ambiguous");
  const alias = h.context.decorateProductJobs_([{ productCode: "06-04-08", customer: "田中", specShape: "直", bladeWidth: "8.0 ㎜", specLength: "21cm" }], {})[0];
  assert.equal(alias.productMaster.status, "matched");
  assert.equal(h.context.normalizeWidth_("2.0 ㎜"), h.context.normalizeWidth_("2mm"));
  assert.equal(h.context.normalizeLength_("17.5cm"), "175");
  assert.equal(h.context.normalizeMasterCustomer_("田中医科"), h.context.normalizeMasterCustomer_("田中"));
  assert.equal(h.context.normalizeMasterCustomer_("医科器械製作所"), "医科器械製作所", "generic maker text does not collapse to 田中");
  assert.equal(h.context.normalizeMasterCustomer_("TMマツイ"), h.context.normalizeMasterCustomer_("松井"));
  const unmatched = h.context.matchProductMaster_({ product: "Yケリソン骨パンチ" }, []);
  assert.equal(unmatched.status, "unmatched");
  assert.equal(unmatched.classCode, "D");
  assert.deepEqual([...unmatched.labelKeywords], []);
});

test("name fallback drops only the approved keywords and refuses duplicate product identities", () => {
  const h = harness();
  h.context.loadProductMaster_ = () => [fixtureRows[0]];
  const [match] = h.context.decorateProductJobs_([
    { product: "鋭匙鉗子 ｱﾘｼﾞ", customer: "田中医科", specShape: "直", bladeWidth: "8", specLength: "21cm" },
    { product: "鋭匙鉗子 同名", customer: "", specShape: "", bladeWidth: "", specLength: "" },
  ], {});
  assert.equal(match.productMaster.status, "matched");
  assert.equal(match.productMaster.productCode, "06-04-08");
  assert.equal(h.context.normalizeProductName_("鋭匙鉗子 同名"), h.context.normalizeProductName_(fixtureRows[2].product));
  const unclear = h.context.matchProductMaster_({ product: "鋭匙鉗子 同名", customer: "", specShape: "", bladeWidth: "", specLength: "" }, fixtureRows);
  assert.equal(unclear.status, "ambiguous");
});

test("manual class overrides are versioned, conflict guarded, and worker writes are rejected", () => {
  const h = harness();
  const before = h.context.decorateProductJobs_(h.jobs, {})[0].productMaster;
  const saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "D", expectedClassCode: "" });
  const after = saved.jobs[0].productMaster;
  assert.equal(after.classCode, "D");
  assert.equal(after.source, "manual");
  role = "worker";
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "A", expectedClassCode: "D" }), /EDITOR_REQUIRED/);
  role = "editor";
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 2, classCode: "A", expectedClassCode: "D" }), /別の端末/);
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "A", expectedClassCode: before.classCode }), /別の端末/);
  const reset = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "", expectedClassCode: "D" });
  assert.notEqual(reset.jobs[0].productMaster.source, "manual");
  role = "admin";
});

test("monthly rates preserve blank versus zero, reject conflicts, and protect admin writes", () => {
  const h = harness();
  const empty = { A: null, B: null, C: null, D: null, "特殊": null };
  assert.throws(() => h.context.savePolishingRates({ month: "2026-10", rates: null, expectedRates: null }), /単価を指定/);
  h.context.savePolishingRates({ month: "2026-10", rates: { A: 0, B: "", C: 1.25, D: 0.29 }, expectedRates: null });
  const stored = JSON.parse(h.settings.polishingRates);
  assert.equal(stored["2026-10"].A, 0);
  assert.equal(stored["2026-10"].B, null);
  assert.equal(stored["2026-10"].C, 1.25);
  assert.equal(stored["2026-10"].D, 0.29);
  assert.equal(Object.hasOwn(stored["2026-10"], "特殊"), false, "omitted rates remain absent so their defaults apply");
  assert.throws(() => h.context.savePolishingRates({ month: "2026-10", rates: empty, expectedRates: null }), /別の端末/);
  assert.throws(() => h.context.savePolishingRates({ month: "2026-10", rates: { A: 1.234 }, expectedRates: stored["2026-10"] }), /小数2桁以内/);
  role = "editor";
  assert.throws(() => h.context.savePolishingRates({ month: "2026-10", rates: empty, expectedRates: stored["2026-10"] }), /ADMIN_REQUIRED/);
  role = "admin";
});

test("master cache publishes bounded chunks by manifest and reuses its request memo", () => {
  const h = harness();
  const values = new Map();
  let gets = 0;
  const cache = { get: (key) => { gets += 1; return values.has(key) ? values.get(key) : null; }, put: (key, value) => values.set(key, value) };
  h.context.CacheService = { getScriptCache: () => cache };
  h.context.writeProductMasterCache_(cache, h.context.PRODUCT_MASTER_SNAPSHOT_, "2026-10-06", "", "live");
  const manifest = JSON.parse(values.get("product-master-v1:manifest"));
  assert.ok(manifest.chunks > 1);
  const chunkKeys = [...values.keys()].filter((key) => key.includes(`:${manifest.generation}:`));
  assert.equal(chunkKeys.length, manifest.chunks);
  assert.ok(chunkKeys.every((key) => values.get(key).length <= 7000));
  h.context.PRODUCT_MASTER_REQUEST_ROWS_ = null;
  const restored = h.context.readProductMasterCache_(cache);
  assert.equal(restored.rows.length, 494);
  assert.equal(restored.asOf, "2026-10-06");
  h.context.loadProductMaster_ = h.nativeLoadProductMaster;
  const rows = h.context.loadProductMaster_(false);
  const reads = gets;
  h.context.loadProductMaster_(false);
  assert.equal(gets, reads, "subsequent helpers in one request reuse the memo");
  assert.equal(rows.length, 494);
  assert.equal(h.context.getProductMasterStatus_().status, "cached");
});

test("missing cache chunks are rejected and snapshot fallback reports its date and warning", () => {
  const h = harness();
  const values = new Map();
  const cache = { get: (key) => values.has(key) ? values.get(key) : null, put: (key, value) => values.set(key, value) };
  h.context.CacheService = { getScriptCache: () => cache };
  h.context.writeProductMasterCache_(cache, h.context.PRODUCT_MASTER_SNAPSHOT_, "2026-10-06", "", "live");
  const manifest = JSON.parse(values.get("product-master-v1:manifest"));
  values.delete(`product-master-v1:${manifest.generation}:0`);
  assert.equal(h.context.readProductMasterCache_(cache), null);
  h.context.PRODUCT_MASTER_REQUEST_ROWS_ = null;
  h.context.loadProductMaster_ = h.nativeLoadProductMaster;
  const rows = h.context.loadProductMaster_(true);
  const status = h.context.getProductMasterStatus_();
  assert.equal(rows.length, 494);
  assert.equal(status.status, "snapshot");
  assert.equal(status.asOf, "2026-10-06");
  assert.match(status.warning, /ライブ読込に失敗/);
  h.context.PRODUCT_MASTER_REQUEST_ROWS_ = null;
  h.context.loadProductMaster_(false);
  assert.equal(h.context.getProductMasterStatus_().status, "cached", "snapshot fallback is cached for subsequent requests");
  assert.match(h.context.getProductMasterStatus_().warning, /スナップショット/);
});

test("polishing header migration accepts known legacy tails and rejects partial or unknown columns without writes", () => {
  function migrationHarness(headers, data = []) {
    const grid = [headers.slice(), data.slice()];
    const sheet = {
      getLastRow: () => grid.length,
      getLastColumn: () => Math.max(...grid.map((row) => row.length)),
      getRange(row, column, rowCount = 1, columnCount = 1) {
        return {
          getDisplayValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => String(grid[row - 1 + r]?.[column - 1 + c] ?? ""))),
          setValues: (values) => values.forEach((valueRow, r) => { grid[row - 1 + r] ||= []; valueRow.forEach((value, c) => { grid[row - 1 + r][column - 1 + c] = value; }); }),
          clearContent() {
            for (let r = 0; r < rowCount; r += 1) {
              const values = grid[row - 1 + r];
              for (let c = 0; c < columnCount; c += 1) values[column - 1 + c] = "";
              while (values.length && values.at(-1) === "") values.pop();
            }
          },
          setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
        };
      },
    };
    const ctx = vm.createContext({ Date, Math, Number, Object, String, Array, JSON, RegExp, Error });
    vm.runInContext(sources.join("\n"), ctx);
    const spreadsheet = { getSheetByName: () => sheet, insertSheet: () => sheet };
    return { ctx, grid, spreadsheet };
  }
  const legacy = migrationHarness([
    "案件ID", "得意先", "品名", "製造番号", "納期", "総数量", "持出し数量", "戻り数量", "研磨屋の数量", "最終仕上げ状態", "最終送付日", "最終返却日",
    "製品番号", "研磨区分", "使用材料",
  ], ["J1", "顧客", "品名", "SN", "2026-10-06", "2", "1", "0", "1", "待ち", "", "", "", "", ""]);
  legacy.ctx.ensurePolishingSheet_(legacy.spreadsheet);
  assert.deepEqual(legacy.grid[0], [...legacy.ctx.POLISHING_HEADERS]);
  assert.equal(legacy.grid[1][0], "J1");
  const current15 = migrationHarness([...legacy.ctx.POLISHING_HEADERS.slice(0, 15)], ["keep", "", "", "", "", "", "", "", "", "", "", "", "product-code", "A", "輪ﾚﾊﾞｰ"]);
  current15.ctx.ensurePolishingSheet_(current15.spreadsheet);
  assert.deepEqual(current15.grid[0], [...legacy.ctx.POLISHING_HEADERS]);
  assert.equal(current15.grid[1][12], "product-code");
  assert.equal(current15.grid[1][14], "輪ﾚﾊﾞｰ");
  const formerWheel = migrationHarness([...legacy.ctx.POLISHING_HEADERS.slice(0, 15), "輪レバー加算"], [...current15.grid[1], "あり（嘉代・1丁ごと）"]);
  const repairFlags = new Map();
  formerWheel.ctx.PropertiesService = {getScriptProperties: () => ({setProperty: (key, value) => repairFlags.set(key, value)})};
  formerWheel.ctx.ensurePolishingSheet_(formerWheel.spreadsheet);
  assert.deepEqual(formerWheel.grid[0], [...legacy.ctx.POLISHING_HEADERS]);
  assert.deepEqual(formerWheel.grid[1], current15.grid[1], "only the retired derived field is cleared; all job and movement columns survive");
  const formerMeniscus = migrationHarness([...legacy.ctx.POLISHING_HEADERS.slice(0, 15), "メニスカス加算"], [...current15.grid[1], "あり（嘉代・1丁ごと）"]);
  formerMeniscus.ctx.ensurePolishingSheet_(formerMeniscus.spreadsheet);
  assert.deepEqual(formerMeniscus.grid[0], [...legacy.ctx.POLISHING_HEADERS]);
  assert.deepEqual(formerMeniscus.grid[1], current15.grid[1]);
  const legacySurcharge = migrationHarness([...legacy.ctx.POLISHING_LEGACY_HEADERS_, ...legacy.ctx.POLISHING_HEADERS.slice(12, 15), "メニスカス加算"], [...current15.grid[1], "旧加算"]);
  legacySurcharge.ctx.ensurePolishingSheet_(legacySurcharge.spreadsheet);
  assert.deepEqual(legacySurcharge.grid[0], [...legacy.ctx.POLISHING_HEADERS]);
  assert.deepEqual(legacySurcharge.grid[1], current15.grid[1]);
  const custom = migrationHarness([...legacy.ctx.POLISHING_HEADERS], [...current15.grid[1], 0, 1234.5]);
  custom.ctx.ensurePolishingSheet_(custom.spreadsheet);
  assert.deepEqual(custom.grid[1].slice(15), [0, 1234.5], "recognized custom rates survive schema checks");
  const foreignTail = migrationHarness([...legacy.ctx.POLISHING_HEADERS, "別用途"], [...current15.grid[1], 0, 1234.5, "保持"]);
  const foreignTailBefore = structuredClone(foreignTail.grid);
  assert.throws(() => foreignTail.ctx.ensurePolishingSheet_(foreignTail.spreadsheet), /見出しがアプリ形式と異なります/);
  assert.deepEqual(foreignTail.grid, foreignTailBefore, "unrecognized columns are never rewritten");
  assert.equal(repairFlags.get(formerWheel.ctx.POLISHING_MIRROR_REPAIR_PROPERTY), "true");
  const unknownSurcharge = migrationHarness([...legacy.ctx.POLISHING_HEADERS.slice(0, 15), "別の加算"]);
  const unknownSurchargeBefore = structuredClone(unknownSurcharge.grid);
  assert.throws(() => unknownSurcharge.ctx.ensurePolishingSheet_(unknownSurcharge.spreadsheet), /見出しがアプリ形式と異なります/);
  assert.deepEqual(unknownSurcharge.grid, unknownSurchargeBefore);
  const unknown = migrationHarness([...legacy.ctx.POLISHING_HEADERS.slice(0, 12), "別用途"], ["J1", "", "", "", "", "", "", "", "", "", "", "", "保持"]);
  const before = structuredClone(unknown.grid);
  assert.throws(() => unknown.ctx.ensurePolishingSheet_(unknown.spreadsheet), /見出しがアプリ形式と異なります/);
  assert.deepEqual(unknown.grid, before);
  const partial = migrationHarness(["案件ID", "得意先", "品名", "不明", ...legacy.ctx.POLISHING_HEADERS.slice(4, 12)]);
  const partialBefore = structuredClone(partial.grid);
  assert.throws(() => partial.ctx.ensurePolishingSheet_(partial.spreadsheet), /見出しがアプリ形式と異なります/);
  assert.deepEqual(partial.grid, partialBefore);
});

test("monthly summary counts JST return month, includes archived history, and leaves incomplete totals unknown", () => {
  const h = harness();
  const jobs = [
    { archived: true, productMaster: { classCode: "A" }, polishing: { sentQuantity: 2, returnedQuantity: 2, history: [
      { requestId: "s1", action: "send", quantity: 10, at: "2026-12-31T15:30:00.000Z" },
      { requestId: "r1", action: "return", quantity: 2, at: "2026-12-31T15:30:00.000Z" },
      { requestId: "c1", action: "cancel", quantity: 8, at: "2026-12-31T15:30:00.000Z" },
      { requestId: "s2", action: "send", quantity: 8, at: "2026-12-31T14:59:00.000Z" },
      { requestId: "c2", action: "cancel", quantity: 8, at: "2026-12-31T14:59:00.000Z" },
    ] } },
    { productMaster: { classCode: "未分類" }, polishing: { sentQuantity: 1, returnedQuantity: 1, history: [
      { requestId: "s3", action: "send", quantity: 1, at: "2026-12-31T15:30:00.000Z" },
      { requestId: "r3", action: "return", quantity: 1, at: "2026-12-31T15:30:00.000Z" },
    ] } },
  ];
  const summary = h.context.monthlyPolishingSummary_(jobs, { polishingRates: JSON.stringify({ "2027-01": { A: 10 } }) }, "2027-01");
  assert.equal(summary.classes.find((line) => line.classCode === "A").quantity, 2);
  assert.equal(summary.totalQuantity, 3);
  assert.equal(summary.missingQuantity, 1);
  assert.equal(summary.knownAmount, 2540, "江部 is calculated for all three returns, while only classified 嘉代 amounts are known");
  assert.equal(summary.totalAmount, null);
  assert.equal(summary.vendorTotals.find((vendor) => vendor.vendor === "江部").totalAmount, 2520);
});

function returnedJob(classCode, quantity = 1, at = "2026-10-06T00:00:00.000Z") {
  return { productMaster: { classCode }, polishing: { sentQuantity: quantity, returnedQuantity: quantity, history: [
    { requestId: `${classCode}-send`, action: "send", quantity, at },
    { requestId: `${classCode}-return`, action: "return", quantity, at },
  ] } };
}

test("undo-return removes a mistaken charge from its original month and later real returns bill in their own month", () => {
  const h = harness();
  const history = [
    { requestId: "sent", action: "send", quantity: 10, at: "2026-09-01T00:00:00.000Z" },
    { requestId: "true-return", action: "return", quantity: 2, at: "2026-09-30T14:59:00.000Z" },
    { requestId: "mistake", action: "return", quantity: 8, at: "2026-09-30T15:00:00.000Z" },
  ];
  const settings = { polishingRates: JSON.stringify({ "2026-09": { A: 10 }, "2026-10": { A: 20 }, "2026-11": { A: 30 }, "2026-12": { A: 40 } }) };
  const original = { archived: true, productMaster: { classCode: "A" }, polishing: { sentQuantity: 10, returnedQuantity: 10, history } };
  assert.equal(h.context.monthlyPolishingSummary_([original], settings, "2026-10").totalAmount, 6880);
  const corrected = { ...original, polishing: { sentQuantity: 10, returnedQuantity: 2, history: [
    ...history, { requestId: "undo", action: "undo-return", quantity: 8, at: "2026-10-31T15:00:00.000Z", returnRequestId: "mistake" },
  ] } };
  const september = h.context.monthlyPolishingSummary_([corrected], settings, "2026-09");
  assert.equal(september.totalQuantity, 2);
  assert.equal(september.totalAmount, 1700);
  assert.equal(september.classes.find(line => line.classCode === "A").quantity, 2, "earlier genuine returns stay charged");
  for (const month of ["2026-10", "2026-11"]) {
    const summary = h.context.monthlyPolishingSummary_([corrected], settings, month);
    assert.equal(summary.totalQuantity, 0, month);
    assert.equal(summary.totalAmount, 0, month);
    assert.ok(summary.classes.every(line => line.quantity === 0), "the correction removes the old charge without creating a negative charge in its own month");
  }
  const returnedAgain = { ...corrected, polishing: { sentQuantity: 10, returnedQuantity: 10, history: [
    ...corrected.polishing.history, { requestId: "real-return", action: "return", quantity: 8, at: "2026-11-30T15:00:00.000Z" },
  ] } };
  const december = h.context.monthlyPolishingSummary_([returnedAgain], settings, "2026-12");
  assert.equal(december.totalQuantity, 8);
  assert.equal(december.totalAmount, 7040);
  assert.equal(december.classes.find(line => line.classCode === "A").unitPrice, 40);
  assert.equal(december.vendorTotals.find(vendor => vendor.vendor === "江部").totalAmount, 6720);
  assert.equal(december.vendorTotals.find(vendor => vendor.vendor === "嘉代").totalAmount, 320);
  assert.equal(h.context.monthlyPolishingSummary_([returnedAgain], settings, "2026-10").totalQuantity, 0, "a later return does not reactivate the mistaken historical charge");
});

test("江部840 and 嘉代 class prices are separate accounts for the same returned products", () => {
  const h = harness();
  const jobs = ["A", "B", "B(メニスカス)", "C", "D", "特殊"].map((code) => returnedJob(code));
  const summary = h.context.monthlyPolishingSummary_(jobs, {}, "2026-10");
  assert.equal(summary.totalQuantity, 6, "actual returned quantities are counted once");
  assert.equal(summary.classes.length, 11);
  assert.equal(summary.classes.find((line) => line.classCode === "江部").quantity, 6);
  const ebe = summary.vendorTotals.find((vendor) => vendor.vendor === "江部"), kayo = summary.vendorTotals.find((vendor) => vendor.vendor === "嘉代");
  assert.equal(ebe.totalAmount, 5040);
  assert.equal(kayo.quantity, 6);
  assert.equal(kayo.totalAmount, 18800);
  assert.equal(summary.totalAmount, 23840);
  assert.equal(summary.missingQuantity, 0);
});

test("江部電解・磨きのみ2000円・磨き＋電解2800円は通常840円と嘉代を除外し、旧区分も引き継ぐ", () => {
  const h = harness();
  const jobs = [returnedJob("江部電解", 3), returnedJob("江部磨き", 4), returnedJob("江部磨きのみ", 2), returnedJob("江部磨き＋電解", 1)];
  jobs.forEach(job => { job.product = "メニスカス鉗子"; job.productMaster.meniscus = true; });
  const summary = h.context.monthlyPolishingSummary_(jobs, {}, "2026-10");
  assert.equal(summary.totalQuantity, 10);
  assert.equal(summary.classes.find((line) => line.classCode === "江部").quantity, 0);
  assert.equal(summary.classes.find((line) => line.classCode === "江部電解").amount, 1620);
  assert.equal(summary.classes.find((line) => line.classCode === "江部磨きのみ").amount, 4000);
  assert.equal(summary.classes.find((line) => line.classCode === "江部磨き＋電解").amount, 14000);
  assert.deepEqual(Array.from(summary.classes.filter(line => line.vendor === "江部"), line => line.classCode), ["江部", "江部電解", "江部磨きのみ", "江部磨き＋電解"]);
  assert.equal(summary.vendorTotals.find((vendor) => vendor.vendor === "嘉代").quantity, 0);
  assert.equal(summary.vendorTotals.find((vendor) => vendor.vendor === "嘉代").totalAmount, 0);
  assert.equal(summary.totalAmount, 19620);
});

test("江部磨きの旧月別単価を保持し、新名称での保存と競合判定を行う", () => {
  const h = harness();
  for (const value of [2400, 0, null]) {
    const rates = h.context.effectiveMonthlyPolishingRates_({"江部磨き":value});
    assert.equal(rates["江部磨き＋電解"], value);
    assert.equal(rates["江部磨きのみ"], 2000);
    assert.equal(Object.hasOwn(rates, "江部磨き"), false);
    assert.equal(h.context.effectiveMonthlyPolishingRates_({"江部磨き":2400,"江部磨き＋電解":value})["江部磨き＋電解"], value);
  }
  h.settings = {polishingRates: JSON.stringify({"2026-09":{"江部磨き":2400},"2026-10":{"江部磨き":2400}})};
  const payload = {month:"2026-10",rates:{"江部磨きのみ":2000,"江部磨き＋電解":2800},expectedRates:{"江部磨き":2400}};
  h.context.savePolishingRates(payload);
  const stored = JSON.parse(h.settings.polishingRates);
  assert.deepEqual(stored["2026-09"], {"江部磨き":2400});
  assert.deepEqual(stored["2026-10"], payload.rates);
  assert.throws(() => h.context.savePolishingRates(payload), /別の端末/);
});

test("旧江部磨きの製品設定を新名称で返し、新しい両区分を保存できる", () => {
  const h = harness();
  const metadata = h.context.decorateProductJobs_(h.jobs, {})[0].productMaster;
  const legacy = {classCode:"江部磨き",updatedAt:"2026-10-01"};
  h.settings = {polishingProductRules: JSON.stringify({[metadata.key]:legacy})};
  assert.equal(h.context.decorateProductJobs_(h.jobs, h.settings)[0].productMaster.classCode, "江部磨き＋電解");
  assert.equal(JSON.parse(h.settings.polishingProductRules)[metadata.key].classCode, "江部磨き");
  for (const code of ["江部磨きのみ", "江部磨き＋電解", "江部磨き"]) {
    const expectedRule = JSON.parse(h.settings.polishingProductRules)[metadata.key];
    const saved = h.context.savePolishingProductRule({id:"J1",version:3,classCode:code,expectedRule});
    const canonical = code === "江部磨き" ? "江部磨き＋電解" : code;
    assert.equal(saved.jobs[0].productMaster.classCode, canonical);
    assert.equal(JSON.parse(h.settings.polishingProductRules)[metadata.key].classCode, canonical);
  }
});

test("B(メニスカス) has its own3300 嘉代 rate and keeps normal B2500 and unknown totals separate", () => {
  const h = harness();
  const summary = h.context.monthlyPolishingSummary_([returnedJob("B(メニスカス)", 2), returnedJob("B", 3), returnedJob("未分類", 1)], {}, "2026-10");
  const meniscus = summary.classes.find((line) => line.classCode === "B(メニスカス)"), b = summary.classes.find((line) => line.classCode === "B");
  assert.equal(meniscus.quantity, 2);
  assert.equal(meniscus.unitPrice, 3300);
  assert.equal(meniscus.amount, 6600);
  assert.equal(Object.hasOwn(meniscus, "meniscusAmount"), false);
  assert.equal(b.amount, 7500);
  assert.equal(summary.vendorTotals.find((vendor) => vendor.vendor === "江部").totalAmount, 5040);
  assert.equal(summary.knownAmount, 19140);
  assert.equal(summary.missingQuantity, 1);
  assert.equal(summary.totalAmount, null);
});

test("monthly overrides keep historic prices, defaults, and explicit zero or null with order-independent conflict baselines", () => {
  const h = harness();
  h.settings = { polishingRates: JSON.stringify({ "2026-09": { B: 2499 }, "2026-10": { B: 0, "B(メニスカス)": null, "江部": null, "メニスカス": 800 } }) };
  const rates = h.context.effectiveMonthlyPolishingRates_(JSON.parse(h.settings.polishingRates)["2026-10"]);
  assert.equal(rates.B, 0);
  assert.equal(rates["B(メニスカス)"], null);
  assert.equal(rates.C, 3000);
  assert.equal(rates["江部電解"], 540);
  assert.equal(rates["江部"], null);
  assert.equal(Object.hasOwn(rates, "メニスカス"), false);
  const summary = h.context.monthlyPolishingSummary_([returnedJob("B(メニスカス)", 2)], h.settings, "2026-10");
  assert.equal(summary.totalQuantity, 2);
  assert.equal(summary.missingQuantity, 2, "unknown charges in both accounts do not double-count affected pieces");
  assert.equal(summary.knownAmount, 0);
  assert.equal(summary.totalAmount, null);
  const saved = h.context.savePolishingRates({ month: "2026-10", rates: { B: 2600, "江部": 800, "B(メニスカス)": 0 }, expectedRates: { "メニスカス": 800, "江部": null, "B(メニスカス)": null, B: 0 } });
  const stored = JSON.parse(saved.polishingRates);
  assert.equal(stored["2026-09"].B, 2499);
  assert.equal(stored["2026-10"]["B(メニスカス)"], 0);
  assert.equal(Object.hasOwn(stored["2026-10"], "江部電解"), false);
  assert.throws(() => h.context.savePolishingRates({ month: "2026-10", rates: { B: 2200 }, expectedRates: { B: 0, "江部": null, "B(メニスカス)": null } }), /別の端末/);
  const normalized = JSON.parse(h.context.normalizePolishingRatesSetting_({ "2026-10": { B: 2550, "江部電解": 0, "B(メニスカス)": null, "メニスカス": 800 } }));
  assert.deepEqual(normalized["2026-10"], { B: 2550, "B(メニスカス)": null, "江部電解": 0 });
  assert.equal(h.context.effectiveMonthlyPolishingRates_({B:2550,"メニスカス":800})["B(メニスカス)"], 3300, "the retired800 surcharge never becomes the new class rate");
});

test("full and half-width meniscus names auto-classify ahead of materials while manual class corrections persist and reset", () => {
  const h = harness();
  h.jobs[0].product = "ﾒﾆｽｶｽ 鋭匙鉗子 同名";
  const metadata = h.context.decorateProductJobs_(h.jobs, {})[0].productMaster;
  assert.equal(metadata.classCode, "B(メニスカス)");
  assert.equal(metadata.source, "rule");
  assert.equal(h.context.classifyProduct_("メニスカス鉗子", ["西端", "ヘルニア"]).classCode, "B(メニスカス)");
  assert.equal(h.context.classifyProduct_("倍力 メニスカス", []).classCode, "特殊", "the confirmed special-class precedence remains");
  let saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "C", expectedRule: null });
  assert.equal(saved.jobs[0].productMaster.classCode, "C");
  assert.equal(saved.jobs[0].productMaster.source, "manual");
  let rule = JSON.parse(h.settings.polishingProductRules)[metadata.key];
  const reordered = Object.fromEntries(Object.entries(rule).reverse());
  saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "B(メニスカス)", expectedRule: reordered });
  assert.equal(saved.jobs[0].productMaster.classCode, "B(メニスカス)");
  const future = h.context.decorateProductJobs_([{ ...h.jobs[0], id: "J2" }], h.settings)[0];
  assert.equal(future.productMaster.classCode, "B(メニスカス)");
  assert.equal(future.productMaster.source, "manual");
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "D", expectedRule: reordered }), /別の端末/);
  rule = JSON.parse(h.settings.polishingProductRules)[metadata.key];
  saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "", expectedRule: rule });
  assert.equal(saved.jobs[0].productMaster.classCode, "B(メニスカス)");
  assert.equal(saved.jobs[0].productMaster.source, "rule");
  assert.equal(Object.hasOwn(JSON.parse(h.settings.polishingProductRules), metadata.key), false);
});

test("new and exceptional class writes validate input and retain editor permissions and job conflict protection", () => {
  const h = harness();
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "メニスカス", expectedRule: null }), /研磨区分/);
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "A", expectedRule: [] }), /保存前/);
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, meniscus: true, expectedRule: null }), /指定/);
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 2, classCode: "B(メニスカス)", expectedRule: null }), /別の端末/);
  role = "worker";
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "B(メニスカス)", expectedRule: null }), /EDITOR_REQUIRED/);
  role = "editor";
  const saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "B(メニスカス)", expectedRule: null });
  assert.equal(saved.jobs[0].productMaster.classCode, "B(メニスカス)");
  role = "admin";
});

test("Tanaka cleanup uses the same canonical product key when saving a future polishing correction", () => {
  const h = harness();
  h.context.loadProductMaster_ = () => [fixtureRows[0]];
  h.jobs[0] = { ...h.jobs[0], productCode: "", product: "鋭匙鉗子 ｱﾘｼﾞ :JS07-040-4S-J TM対象", customer: "田中", specShape: "直", bladeWidth: "8mm", specLength: "210" };
  const first = h.context.decorateProductJobs_(h.jobs, {})[0];
  assert.equal(first.productMaster.status, "matched");
  const saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "B(メニスカス)", expectedRule: null });
  const future = h.context.decorateProductJobs_([{ ...h.jobs[0], id: "J2", productCode: "06-04-08", product: "鋭匙鉗子" }], h.settings)[0];
  assert.equal(saved.jobs[0].productMaster.key, future.productMaster.key);
  assert.equal(future.productMaster.classCode, "B(メニスカス)");
});

test("retired surcharge rules and rates are ignored without erasing class corrections; only product and master names auto-classify", () => {
  const h = harness();
  h.context.loadProductMaster_ = () => fixtureRows.map(row => row.productCode === "H-1" && row.customer === "甲社" ? {...row,material:"西端 / 輪レバー / メニスカス部品"} : row);
  const before = h.context.decorateProductJobs_(h.jobs, {})[0].productMaster;
  assert.equal(before.classCode, "A", "a material name alone cannot trigger the meniscus class");
  const oldRule = {classCode:"D",wheelLever:true,meniscus:true};
  h.settings = { polishingProductRules: JSON.stringify({[before.key]:oldRule}), polishingRates: '{"2026-10":{"輪レバー":1500,"メニスカス":800}}' };
  const metadata = h.context.decorateProductJobs_(h.jobs, h.settings)[0].productMaster;
  assert.equal(metadata.classCode, "D");
  assert.equal(Object.hasOwn(metadata, "meniscus"), false);
  const summary = h.context.monthlyPolishingSummary_([{...returnedJob("D",2),productMaster:metadata}], h.settings, "2026-10");
  assert.equal(summary.totalAmount, 8680);
  const prices = h.context.effectiveMonthlyPolishingRates_(JSON.parse(h.settings.polishingRates)["2026-10"]);
  assert.equal(prices["B(メニスカス)"], 3300);
  assert.equal(Object.hasOwn(prices, "輪レバー"), false);
  assert.equal(Object.hasOwn(prices, "メニスカス"), false);
  const saved = h.context.savePolishingProductRule({id:"J1",version:3,classCode:"D",expectedRule:oldRule});
  const rule = JSON.parse(saved.settings.polishingProductRules)[before.key];
  assert.equal(rule.classCode, "D");
  assert.equal(Object.hasOwn(rule, "wheelLever"), false);
  assert.equal(Object.hasOwn(rule, "meniscus"), false);
  h.context.loadProductMaster_ = () => fixtureRows.map(row => row.productCode === "H-1" && row.customer === "甲社" ? {...row,product:"ﾒﾆｽｶｽ鉗子",material:"西端"} : row);
  const automatic = h.context.decorateProductJobs_(h.jobs, {})[0].productMaster;
  assert.equal(automatic.classCode, "B(メニスカス)");
  assert.equal(automatic.source, "rule");
});

test("product-specific free vendor rates persist for the same future product, conflict on price-only edits, and reset with automatic classification", () => {
  const h = harness();
  const key = h.context.decorateProductJobs_(h.jobs, {})[0].productMaster.key;
  let saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "自由設定", customRates: { "江部": "1200.50", "嘉代": 5678 }, expectedRule: null });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.jobs[0].productMaster.customRates)), { "江部": 1200.5, "嘉代": 5678 });
  let rule = JSON.parse(h.settings.polishingProductRules)[key];
  const originalRule = structuredClone(rule);
  const future = h.context.decorateProductJobs_([{ ...h.jobs[0], id: "future" }, { ...h.jobs[0], id: "different-customer", customer: "乙社" }], h.settings);
  assert.equal(future[0].productMaster.classCode, "自由設定");
  assert.equal(future[0].productMaster.customRates["嘉代"], 5678);
  assert.notEqual(future[1].productMaster.classCode, "自由設定", "similar product numbers from another customer never inherit rates");
  saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "自由設定", customRates: { "江部": 0, "嘉代": "" }, expectedRule: Object.fromEntries(Object.entries(rule).reverse()) });
  assert.equal(saved.jobs[0].productMaster.customRates["江部"], 0);
  assert.equal(saved.jobs[0].productMaster.customRates["嘉代"], null);
  assert.throws(() => h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "自由設定", customRates: { "江部": 9, "嘉代": 9 }, expectedRule: originalRule }), /別の端末/);
  rule = JSON.parse(h.settings.polishingProductRules)[key];
  saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "A", expectedRule: rule });
  assert.equal(Object.hasOwn(saved.jobs[0].productMaster, "customRates"), false, "ordinary classification does not apply dormant free prices");
  rule = JSON.parse(h.settings.polishingProductRules)[key];
  assert.equal(rule.customRates["江部"], 0);
  saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "自由設定", expectedRule: rule });
  assert.equal(saved.jobs[0].productMaster.customRates["江部"], 0);
  assert.equal(saved.jobs[0].productMaster.customRates["嘉代"], null);
  rule = JSON.parse(h.settings.polishingProductRules)[key];
  saved = h.context.savePolishingProductRule({ id: "J1", version: 3, classCode: "", expectedRule: rule });
  assert.equal(saved.jobs[0].productMaster.classCode, "A");
  assert.equal(Object.hasOwn(JSON.parse(h.settings.polishingProductRules), key), false);
});

test("free-price writes reject malformed vendor objects or rates atomically and retain editor/version guards", () => {
  const h = harness();
  const input = { id: "J1", version: 3, classCode: "自由設定", expectedRule: null };
  for (const customRates of [null, undefined, [], "100", 0, true, { "江部": 1, "嘉代": 2, other: 3 }]) {
    assert.throws(() => h.context.savePolishingProductRule({ ...input, customRates }), /自由設定の研磨単価/);
    assert.deepEqual(h.settings, {});
  }
  for (const value of [-1, 1000001, 1.234, true, {}, "-1", "1e2", "NaN", "Infinity", "1.234"]) {
    for (const vendor of ["江部", "嘉代"]) {
      assert.throws(() => h.context.savePolishingProductRule({ ...input, customRates: { "江部": 1, "嘉代": 2, [vendor]: value } }), /0〜1000000円/);
      assert.deepEqual(h.settings, {});
    }
  }
  assert.throws(() => h.context.savePolishingProductRule({ ...input, version: 2, customRates: { "江部": 1, "嘉代": 2 } }), /別の端末/);
  role = "worker";
  try { assert.throws(() => h.context.savePolishingProductRule({ ...input, customRates: { "江部": 1, "嘉代": 2 } }), /EDITOR_REQUIRED/); }
  finally { role = "admin"; }
  const saved = h.context.savePolishingProductRule(input);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.jobs[0].productMaster.customRates)), { "江部": null, "嘉代": null });
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.normalizePolishingCustomRates_({ "江部": "1000000", "嘉代": "0.29" }))), { "江部": 1000000, "嘉代": 0.29 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.normalizePolishingCustomRates_({ "江部": "" }))), { "江部": null, "嘉代": null });
});

test("monthly free-price lines keep vendors and differing prices separate, while fixed classes remain unchanged", () => {
  const h = harness();
  const free = (name, quantity, ebe, kayo) => ({ ...returnedJob("自由設定", quantity), product: name, productMaster: { classCode: "自由設定", customRates: { "江部": ebe, "嘉代": kayo } } });
  const summary = h.context.monthlyPolishingSummary_([
    free("特殊製品1", 2, 100, 1200.5), free("特殊製品2", 3, 200, 1200.5), free("特殊製品3", 1, 0, 0), returnedJob("A", 1), returnedJob("江部電解", 1),
  ], { polishingRates: JSON.stringify({ "2026-10": { "江部": 900, A: 2100, "自由設定": 9999 } }) }, "2026-10");
  const custom = summary.classes.filter(line => line.classCode === "自由設定");
  assert.equal(custom.length, 5);
  assert.deepEqual(Array.from(custom.filter(line => line.vendor === "江部"), line => [line.unitPrice, line.quantity, line.amount]), [[100, 2, 200], [200, 3, 600], [0, 1, 0]]);
  const kayo = custom.find(line => line.vendor === "嘉代" && line.unitPrice === 1200.5);
  assert.equal(kayo.quantity, 5);
  assert.equal(kayo.amount, 6002.5);
  assert.deepEqual(Array.from(kayo.productNames), ["特殊製品1", "特殊製品2"]);
  assert.equal(summary.classes.find(line => line.classCode === "江部").quantity, 1, "free-price products never also receive the fixed840/default 江部 charge");
  assert.equal(summary.classes.find(line => line.classCode === "A").amount, 2100);
  assert.equal(summary.totalQuantity, 8);
  assert.equal(summary.missingQuantity, 0);
  assert.equal(summary.totalAmount, 10342.5);
  assert.equal(summary.vendorTotals.find(vendor => vendor.vendor === "江部").totalAmount, 2240);
  assert.equal(summary.vendorTotals.find(vendor => vendor.vendor === "嘉代").totalAmount, 8102.5);
});

test("missing free prices remain unknown once per physical quantity, zeros stay valid, and undo returns stay out of the original month", () => {
  const h = harness();
  const oneUnknown = { ...returnedJob("自由設定", 2), productMaster: { classCode: "自由設定", customRates: { "江部": 0.29, "嘉代": null } } };
  const bothUnknown = { ...returnedJob("自由設定", 3), productMaster: { classCode: "自由設定" } };
  const zero = { ...returnedJob("自由設定", 1), productMaster: { classCode: "自由設定", customRates: { "江部": 0, "嘉代": 0 } } };
  let summary = h.context.monthlyPolishingSummary_([oneUnknown, bothUnknown, zero], {}, "2026-10");
  assert.equal(summary.totalQuantity, 6);
  assert.equal(summary.missingQuantity, 5);
  assert.equal(summary.knownAmount, 0.58);
  assert.equal(summary.totalAmount, null);
  assert.equal(summary.vendorTotals.find(vendor => vendor.vendor === "江部").missingQuantity, 3);
  assert.equal(summary.vendorTotals.find(vendor => vendor.vendor === "嘉代").missingQuantity, 5);
  const corrected = structuredClone(oneUnknown);
  const returned = corrected.polishing.history.find(event => event.action === "return");
  corrected.polishing.history.push({ requestId: "undo", action: "undo-return", quantity: 2, at: "2026-11-01T00:00:00.000Z", returnRequestId: returned.requestId });
  corrected.polishing.returnedQuantity = 0;
  summary = h.context.monthlyPolishingSummary_([corrected], {}, "2026-10");
  assert.equal(summary.totalQuantity, 0);
  assert.equal(summary.classes.some(line => line.classCode === "自由設定"), false);
  assert.equal(summary.totalAmount, 0);
  corrected.polishing.history.push({ requestId: "real-return", action: "return", quantity: 2, at: "2026-11-02T00:00:00.000Z" });
  corrected.polishing.returnedQuantity = 2;
  corrected.productMaster.customRates["嘉代"] = 100;
  assert.equal(h.context.monthlyPolishingSummary_([corrected], {}, "2026-11").totalAmount, 200.58);
  assert.equal(h.context.monthlyPolishingSummary_([corrected], {}, "2026-10").totalQuantity, 0);
});
