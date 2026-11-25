import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const files = ["src/materials.js", "src/intake-duplicates.js", "apps-script/Config.gs", "apps-script/Parser.gs", "apps-script/Repository.gs", "apps-script/Import.gs", "apps-script/Materials.gs", "apps-script/Code.gs"];
const source = (await Promise.all(files.map(file => readFile(new URL(`../${file}`, import.meta.url), "utf8")))).join("\n");
const copy = value => JSON.parse(JSON.stringify(value));
const timestamp = "2026-10-20T00:00:00.000Z";
const order = (extra = {}) => ({ customer: "TMマツイ", product: "慈大式 彫骨器", productCode: "CK001", specShape: "直･上向", quantity: 4, dueDate: "2026-11-01", serialNo: "M-1", ...extra });

function harness() {
  let uuid = 0;
  const grids = new Map(), writes = [];
  const state = { role: "owner", locked: false, beforeLock: null, failSheet: "", failLog: false, failFlush: false };
  const access = () => ({ role: state.role, email: `${state.role}@example.com`, isOwner: state.role === "owner", isAdmin: ["owner", "admin"].includes(state.role), canEdit: ["owner", "admin", "editor"].includes(state.role), canWork: ["owner", "admin", "editor", "worker"].includes(state.role) });
  const requireRole = capability => {
    const result = access();
    if (state.role === "unauthenticated" || capability && !result[capability]) throw new Error("ACCESS_DENIED: role required");
    return result;
  };
  const getSheet = name => {
    const grid = grids.get(name);
    if (!grid) return null;
    const sheet = {
      getLastRow: () => grid.length, getLastColumn: () => Math.max(0, ...grid.map(row => row.length)),
      getRange(row, column, height = 1, width = 1) {
        const values = () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => grid[row + r - 1]?.[column + c - 1] ?? ""));
        const range = {
          getValues: values, getDisplayValues: () => values().map(cells => cells.map(String)),
          setValues(rows) {
            if (name === "工程管理_材料履歴" || name === "工程管理_材料対象外" || name === "工程管理_案件" && row > 1) assert.equal(state.locked, true, "material and job writes must hold the document lock");
            if (state.failSheet === name) { state.failSheet = ""; throw new Error("write failed before commit"); }
            writes.push({ name, row, height: rows.length });
            rows.forEach((cells, r) => { grid[row + r - 1] ||= []; cells.forEach((value, c) => { grid[row + r - 1][column + c - 1] = value; }); });
            return range;
          },
          setValue(value) { return range.setValues([[value]]); },
          setFontWeight() { return range; }, setBackground() { return range; }, setFontColor() { return range; },
        };
        return range;
      },
      getDataRange() { return sheet.getRange(1, 1, grid.length, sheet.getLastColumn()); },
      setFrozenRows() {}, autoResizeColumns() {},
    };
    return sheet;
  };
  const spreadsheet = { getId: () => "materials-book", getSheetByName: getSheet, insertSheet(name) { grids.set(name, []); return getSheet(name); } };
  const context = vm.createContext({
    Date, Math, Number, Object, RegExp, String, Array, JSON, Error,
    requireAppAccess_: () => requireRole(), requireEditorAccess_: () => requireRole("canEdit"), requireWorkerAccess_: () => requireRole("canWork"), requireAdminAccess_: () => requireRole("isAdmin"), requireOwnerAccess_: () => requireRole("isOwner"),
    getAiImportStatus: () => ({}), getAccessSettings: () => ({}), ScriptApp: { getScriptId: () => "test-script" },
    SpreadsheetApp: { flush() { if (state.failFlush) { state.failFlush = false; throw new Error("reply lost after commit"); } } },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(state.locked, false); state.locked = true; if (state.beforeLock) { const callback = state.beforeLock; state.beforeLock = null; callback(); } }, releaseLock() { state.locked = false; } }) },
    Utilities: { getUuid: () => `uuid-${++uuid}`, DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" }, computeDigest: (_algorithm, value) => [...createHash("sha256").update(value).digest()], formatDate: date => new Date(+date + 9 * 3600000).toISOString().slice(0, 10) },
  });
  vm.runInContext(source, context);
  context.getSpreadsheet_ = () => spreadsheet;
  context.appendLog_ = () => { if (state.failLog) { state.failLog = false; throw new Error("audit temporarily unavailable"); } };
  context.ensureSystem_();
  const savedOrder = (extra = {}) => context.saveJob({ ...order(), requestId: `manual-${++uuid}`, ...extra });
  const inventory = () => context.getMaterialInventory();
  const material = id => inventory().materials.find(item => item.id === id);
  const candidate = (extra = {}) => context.withDocumentLock_(() => context.appendIntake_({ sourceType: "text", sourceRef: `source-${++uuid}`, parsed: order(extra), status: "pending" }));
  const approve = item => context.approveIntake({ intakeId: item.id, order: item.parsed });
  return { context, grids, writes, state, order: savedOrder, inventory, material, candidate, approve, seed(jobs) { grids.set(context.APP.SHEETS.JOBS, [[...context.APP.JOB_HEADERS], ...jobs.map(job => context.jobToRow_(job))]); } };
}

test("portable SHA-256 signs canonical Unicode payloads with stable nested key order", () => {
  const { context } = harness(), m = context.MaterialInventory;
  for (const value of ["", "abc", { 日本語: "慈大式・Tezoe", a: [1, true, null] }]) {
    const canonical = typeof value === "object" ? '{"a":[1,true,null],"日本語":"慈大式・Tezoe"}' : JSON.stringify(value);
    assert.equal(m.hash(value), createHash("sha256").update(canonical).digest("hex"));
  }
  assert.equal(m.jobRequestHash({ product: "日本語", stages: { heat: { status: "done", assignee: "豊" } } }), m.jobRequestHash({ stages: { heat: { assignee: "豊", status: "done" } }, product: "日本語" }));
});

test("image opening balances seed exactly once and preserve exact material specifications", () => {
  const h = harness(), first = h.inventory(), second = h.inventory();
  assert.deepEqual(copy(first.materials.map(item => item.stockQuantity)), [28, 12, 42, 1, 0, 0]);
  assert.equal(second.history.length, 6);
  assert.equal(h.grids.get(h.context.APP.SHEETS.MATERIALS).length, 7);
  assert.ok(first.history.every(event => event.action === "opening" && /2026-10-20提供画像/.test(event.note)));
  assert.ok(first.materials.every(material => material.note === "" && material.noteRevision === ""));
  assert.match(first.materials.find(item => item.id === "CK022").specification, /212mm.*173mm/);
  assert.equal(first.initializedAt, second.initializedAt);
});

test("mapping requires a supported product family and exact shape, with dedicated Tezoe26002", () => {
  const { context } = harness(), resolve = input => context.MaterialInventory.resolve(input);
  for (const [productCode, specShape, materialId] of [["CK001", "直・上向", "CK001"], ["CK002", "直・下向", "CK002"], ["CK011", "弱弯・上向", "CK011"], ["CK021", "強弯・上向", "CK021"], ["CK022", "強弯・下向", "CK022"]]) {
    assert.equal(resolve(order({ customer: "在庫用", productCode, specShape })).materialId, materialId);
    const tezoe = { ...order(), product: "tezoeスタンツェ ｳｽｲ", productCode: productCode.replace("CK0", "260"), specShape };
    assert.equal(resolve(tezoe).materialId, productCode === "CK002" ? "TEZOE26002" : materialId);
  }
  assert.equal(resolve(order({ product: "彫骨器", specShape: "" })).materialId, "CK001");
  for (const input of [order({ productCode: "CK006" }), order({ productCode: "CK007" }), order({ productCode: "CK012" }), order({ specShape: "直・下向" }), order({ specShape: "直・上向/弱弯・上向" }), order({ product: "他の器具" }), order({ productCode: "26001", product: "他の器具" }), order({ product: "tezoeスタンツェ ｱﾘｼﾞ", productCode: "26012", specShape: "弱弯・下向" }), order({ product: "慈大式 彫骨器 白銅" }), order({ productCode: "", specShape: "上向" }), order({ product: "慈大式 彫骨器 CK001 CK011" })]) assert.equal(resolve(input).materialId, "", JSON.stringify(input));
});

test("弱弯・下向 variants are excluded only when family, code and shape agree", () => {
  const { context } = harness(), resolve = input => context.MaterialInventory.resolve(input);
  const excluded = [
    order({ product: "慈大式 彫骨器", productCode: "CK012", specShape: "" }),
    order({ product: "慈大式 彫骨器 弱弯・下向", productCode: "CK012", specShape: "弱弯・下向" }),
    order({ product: "Tezoe スタンツェ", productCode: "26012", specShape: "" }),
    order({ product: "Tezoe スタンツェ 弱弯・下向", productCode: "26012", specShape: "弱弯・下向" }),
    order({ product: "慈大式 彫骨器 弱弯・下向", productCode: "", specShape: "弱弯・下向" }),
    order({ product: "Tezoe スタンツェ 弱弯・下向", productCode: "", specShape: "弱弯・下向" }),
  ];
  for (const input of excluded) {
    const result = resolve(input);
    assert.equal(result.materialId, "", JSON.stringify(input));
    assert.equal(result.quantity, 0, JSON.stringify(input));
    assert.equal(result.target, false, JSON.stringify(input));
    assert.match(result.reason, /弱弯・下向.*対象外/, JSON.stringify(input));
  }

  const unresolved = [
    order({ product: "慈大式 彫骨器", productCode: "CK011", specShape: "弱弯・下向" }),
    order({ product: "Tezoe スタンツェ", productCode: "26011", specShape: "弱弯・下向" }),
    order({ product: "Tezoe スタンツェ", productCode: "CK012", specShape: "弱弯・下向" }),
    order({ product: "慈大式 彫骨器", productCode: "CK099", specShape: "弱弯・下向" }),
    order({ product: "慈大式 彫骨器 CK012 CK011", productCode: "", specShape: "弱弯・下向" }),
    order({ product: "慈大式 彫骨器", productCode: "", specShape: "弱弯・下向 / 強弯・下向" }),
    order({ product: "慈大式 彫骨器 弱弯・上向", productCode: "CK012", specShape: "弱弯・下向" }),
  ];
  for (const input of unresolved) {
    const result = resolve(input);
    assert.equal(result.materialId, "", JSON.stringify(input));
    assert.equal(result.target, true, JSON.stringify(input));
  }
});

test("excluded variants and old empty unresolved baselines never create usage or release events", () => {
  const h = harness(), m = h.context.MaterialInventory;
  for (const [serialNo, input] of [
    ["CK012", order({ product: "慈大式 彫骨器", productCode: "CK012", specShape: "", serialNo: "CK012", quantity: 4 })],
    ["26012", order({ product: "Tezoe スタンツェ", productCode: "26012", specShape: "", serialNo: "26012", quantity: 5 })],
    ["NO-CODE", order({ product: "慈大式 彫骨器 弱弯・下向", productCode: "", specShape: "弱弯・下向", serialNo: "NO-CODE", quantity: 6 })],
  ]) {
    const saved = h.order({ ...input, requestId: `excluded-${serialNo}` });
    assert.equal(saved.materials.history.length, 0, serialNo);
    assert.deepEqual(copy(saved.materials.allocation), [], serialNo);
    assert.deepEqual(copy(saved.materials.baseline.allocation), [], serialNo);
  }
  assert.deepEqual(copy(h.inventory().materials.map(item => item.stockQuantity)), [28, 12, 42, 1, 0, 0]);
  assert.deepEqual(copy(h.inventory().history.map(event => event.action)), Array(6).fill("opening"));
  assert.equal(h.inventory().unresolved.length, 0);

  const old = h.context.normalizeJobInput_(order({
    id: "old-excluded", product: "慈大式 彫骨器", productCode: "CK012", specShape: "", serialNo: "OLD-EXCLUDED", quantity: 4,
  }), null);
  // Stored by a pre-exclusion release: the target was unresolved, with no
  // allocated baseline or movements. Keep this shape explicit across resolver updates.
  old.materials = { version: 1, baseline: { allocation: [], at: timestamp, unresolvedTargetQuantity: 4 }, allocation: [], history: [], requests: [] };
  h.seed([old]);
  let saved = h.context.saveJob({ ...h.context.readJobs_()[0], requestId: "exclude-old-baseline" });
  assert.equal(saved.materials.baseline.unresolvedTargetQuantity, undefined);
  assert.deepEqual(copy(saved.materials.baseline.allocation), []);
  assert.deepEqual(copy(saved.materials.allocation), []);
  assert.deepEqual(copy(saved.materials.history), []);
  assert.deepEqual(copy(h.inventory().materials.map(item => item.stockQuantity)), [28, 12, 42, 1, 0, 0]);
  assert.equal(h.inventory().unresolved.length, 0);

  saved = h.context.saveJob({ ...saved, requestId: "exclude-old-quantity", quantity: 7 });
  assert.equal(saved.quantity, 7);
  assert.deepEqual(copy(saved.materials.history), []);
  assert.deepEqual(copy(h.inventory().materials.map(item => item.stockQuantity)), [28, 12, 42, 1, 0, 0]);
  assert.equal(h.inventory().unresolved.length, 0);
});

test("opening and usage calendar dates use Japan time around midnight", () => {
  const { context } = harness(), m = context.MaterialInventory, at = "2026-10-19T15:01:00.000Z";
  assert.equal(m.openingEvents({ at })[0].date, "2026-10-20");
  assert.equal(m.transitionJob(null, order({ id: "J" }), { at }).history[0].date, "2026-10-20");
});

test("confirmed manual orders use one set per product and shortages remain saveable", () => {
  const h = harness();
  const saved = h.order({ quantity: 30, materials: { allocation: [] } });
  assert.equal(saved.materials.history[0].quantity, 30);
  assert.equal(h.material("CK001").stockQuantity, -2);
  assert.equal(h.material("CK001").shortageQuantity, 2);
  const reopened = h.context.getSnapshot({});
  assert.equal(reopened.jobs[0].materials.history.length, 1);
  assert.equal(reopened.materialInventory.materials[0].stockQuantity, -2);
  const unmatched = h.order({ productCode: "CK006", serialNo: "UNKNOWN" });
  assert.equal(unmatched.materials.history.length, 0);
  assert.match(h.inventory().unresolved.find(item => item.id === unmatched.id).reason, /未登録/);
});

test("manual retries are idempotent and reject the same requestId with changed contents", () => {
  const h = harness(), payload = { ...order(), requestId: "stable-save" };
  const saved = h.context.saveJob(payload), writes = h.writes.length;
  assert.equal(h.context.saveJob(copy(payload)).id, saved.id);
  assert.equal(h.writes.length, writes);
  assert.equal(h.material("CK001").stockQuantity, 24);
  assert.throws(() => h.context.saveJob({ ...payload, note: "changed retry" }), /同じリクエストID/);
  h.state.failLog = true;
  const next = { ...order({ serialNo: "after-log-failure" }), requestId: "lost-reply" };
  assert.throws(() => h.context.saveJob(next), /audit temporarily/);
  const recovered = h.context.saveJob(next);
  assert.equal(recovered.materials.history.length, 1);
  assert.equal(h.material("CK001").stockQuantity, 20);
});

test("a committed job retry repairs only its failed label correction and preserves newer settings", () => {
  for (const concurrent of ["none", "settings", "job"]) {
    const h = harness();
    let rules = {}, failCommit = true, commits = 0;
    h.context.readSettings_ = () => ({ productLabelRules: JSON.stringify(rules) });
    h.context.prepareProductLabelRule_ = input => {
      if (!input.productLabelRule) return null;
      const requested = input.productLabelRule, expected = typeof requested.expectedRules === "string" ? JSON.parse(requested.expectedRules) : requested.expectedRules;
      if (JSON.stringify(rules) !== JSON.stringify(expected)) throw new Error("材料表示が別の端末で更新されています");
      const next = { keywords: [...requested.keywords] };
      return { changed: JSON.stringify(rules) !== JSON.stringify(next), value: JSON.stringify(next) };
    };
    h.context.commitProductLabelRule_ = prepared => {
      if (!prepared.changed) return;
      if (failCommit) { failCommit = false; throw new Error("label setting write failed"); }
      commits += 1; rules = JSON.parse(prepared.value);
    };
    const payload = { ...order(), requestId: "label-retry", productLabelRule: { mode: "manual", keywords: ["ウスイ"], expectedRules: {} } };
    assert.throws(() => h.context.saveJob(payload), /label setting write failed/);
    assert.equal(h.context.readJobs_()[0].materials.history.length, 1);
    const rowWrites = h.writes.filter(write => write.name === h.context.APP.SHEETS.JOBS && write.row > 1).length;
    if (concurrent === "settings") {
      rules = { keywords: ["白銅"] };
      assert.throws(() => h.context.saveJob(payload), /別の端末/);
      assert.deepEqual(rules.keywords, ["白銅"]);
      assert.equal(commits, 0);
    } else if (concurrent === "job") {
      const grid = h.grids.get(h.context.APP.SHEETS.JOBS);
      grid[1][h.context.APP.JOB_HEADERS.indexOf("version")] = 2;
      grid[1][h.context.APP.JOB_HEADERS.indexOf("customer")] = "別の得意先";
      assert.equal(h.context.saveJob(payload).customer, "別の得意先");
      assert.equal(commits, 0);
      assert.deepEqual(rules, {});
    } else {
      const recovered = h.context.saveJob(payload);
      assert.deepEqual(JSON.parse(recovered.productLabelRules).keywords, ["ウスイ"]);
      h.context.saveJob(payload);
      assert.equal(commits, 1);
    }
    assert.equal(h.writes.filter(write => write.name === h.context.APP.SHEETS.JOBS && write.row > 1).length, rowWrites);
    assert.equal(h.material("CK001").stockQuantity, 24);
  }
});

test("quantity and material edits apply only the delta and preserve history", () => {
  const h = harness();
  let saved = h.order({ quantity: 10 });
  saved = h.context.saveJob({ ...saved, requestId: "more", quantity: 13 });
  assert.equal(h.material("CK001").stockQuantity, 15);
  saved = h.context.saveJob({ ...saved, requestId: "fewer", quantity: 7 });
  assert.equal(h.material("CK001").stockQuantity, 21);
  saved = h.context.saveJob({ ...saved, requestId: "different", productCode: "CK011", specShape: "弱弯･上向" });
  assert.equal(h.material("CK001").stockQuantity, 28);
  assert.equal(h.material("CK011").stockQuantity, 5);
  assert.deepEqual(copy(saved.materials.history.map(event => [event.action, event.quantity])), [["use", 10], ["use", 3], ["release", 6], ["release", 7], ["use", 7]]);
  assert.equal(h.inventory().history.filter(event => event.jobId === saved.id).length, 5);
});

test("preexisting jobs receive a baseline with no retroactive stock movement", () => {
  const h = harness(), existing = h.context.normalizeJobInput_(order({ id: "old", quantity: 10 }), null);
  h.seed([existing]);
  assert.equal(h.material("CK001").stockQuantity, 28);
  let saved = h.context.saveJob({ ...h.context.readJobs_()[0], requestId: "baseline", note: "ordinary edit" });
  assert.equal(saved.materials.history.length, 0);
  assert.equal(saved.materials.baseline.allocation[0].quantity, 10);
  assert.equal(h.material("CK001").stockQuantity, 28);
  saved = h.context.saveJob({ ...saved, requestId: "extra", quantity: 12 });
  assert.equal(saved.materials.history[0].quantity, 2);
  assert.equal(h.material("CK001").stockQuantity, 26);
});

test("historic migration preview and commit write baselines, never new usage", () => {
  const h = harness();
  h.grids.set("旧表", [["得意先", "品名", "納期", "数量", "型", "品番", "連番"], ["TMマツイ", "慈大式 彫骨器", "2026-10-31", "8", "直・上向", "CK001", "OLD-1"]]);
  const preview = h.context.migrateLegacySheet({ sheetName: "旧表", dryRun: true });
  assert.equal(preview.jobs[0].materials.history.length, 0);
  assert.equal(h.context.readJobs_().length, 0);
  assert.equal(h.material("CK001").stockQuantity, 28);
  const result = h.context.migrateLegacySheet({ sheetName: "旧表", expectedFingerprint: preview.fingerprint });
  assert.equal(result.imported, 1);
  assert.equal(h.context.readJobs_()[0].materials.history.length, 0);
  assert.equal(h.material("CK001").stockQuantity, 28);
});

test("old unresolved targets do not warn or retroactively charge when missing specifications are clarified", () => {
  for (const quantity of [5, 7]) {
    const h = harness();
    const old = h.context.normalizeJobInput_(order({ id: "historic-unknown", product: "tezoeスタンツェ ｳｽｲ", productCode: "", specShape: "", quantity: 5 }), null);
    h.seed([old]);
    assert.equal(h.inventory().unresolved.length, 0);
    let saved = h.context.saveJob({ ...h.context.readJobs_()[0], requestId: "historic-note", note: "古い注文の仕様確認" });
    assert.equal(saved.materials.baseline.unresolvedTargetQuantity, 5);
    assert.equal(h.inventory().unresolved.length, 1);
    saved = h.context.saveJob({ ...saved, requestId: "historic-clarification", productCode: "26001", specShape: "直・上向", quantity });
    assert.equal(h.material("CK001").stockQuantity, 28 - (quantity - 5));
    assert.equal(saved.materials.baseline.allocation[0].quantity, 5);
    assert.equal(saved.materials.baseline.unresolvedTargetQuantity, undefined);
    assert.equal(h.inventory().unresolved.length, 0);
  }
});

test("new ambiguous target orders warn and charge in full on resolution; an old unrelated order also charges in full", () => {
  const h = harness();
  let saved = h.order({ product: "tezoeスタンツェ ｳｽｲ", productCode: "", specShape: "", quantity: 5 });
  assert.equal(h.inventory().unresolved.length, 1);
  assert.equal(saved.materials.baseline.unresolvedTargetQuantity, undefined);
  saved = h.context.saveJob({ ...saved, requestId: "new-clarification", productCode: "26001", specShape: "直・上向" });
  assert.equal(saved.materials.history[0].quantity, 5);
  assert.equal(h.material("CK001").stockQuantity, 23);
  const old = h.context.normalizeJobInput_(order({ id: "old-unrelated", product: "別の器具", productCode: "P-1", specShape: "", quantity: 5 }), null);
  h.seed([old]);
  saved = h.context.saveJob({ ...h.context.readJobs_()[0], ...order({ quantity: 5 }), requestId: "replace-old-unrelated" });
  assert.equal(saved.materials.history[0].quantity, 5);
  assert.equal(h.material("CK001").stockQuantity, 23);
});

test("process, shipping, print state and archive keep usage; stock returns require adjustment", () => {
  const h = harness();
  let saved = h.order({ category: "鋭匙鉗子" });
  const original = JSON.stringify(saved.materials);
  const returned = h.context.readJobs_()[0];
  returned.polishing = { sentQuantity: saved.quantity, returnedQuantity: saved.quantity, history: [
    { requestId: "sent", action: "send", quantity: saved.quantity, at: timestamp },
    { requestId: "returned", action: "return", quantity: saved.quantity, at: timestamp },
  ] };
  h.seed([returned]);
  h.state.role = "worker";
  saved = h.context.setDistributionAssignee({ id: saved.id, version: saved.version, assignee: "望" });
  assert.equal(saved.materials, undefined);
  saved = h.context.saveJobProcess({ id: saved.id, version: saved.version, stages: { finish: { status: "done", assignee: "豊" } } });
  assert.equal(saved.materials, undefined);
  assert.equal(JSON.stringify(h.context.readJobs_()[0].materials), original);
  h.state.role = "editor";
  saved = h.context.saveJobProcess({ id: saved.id, version: saved.version, stages: {}, shippingStatus: "shipped" });
  assert.equal(JSON.stringify(h.context.readJobs_()[0].materials), original);
  saved = h.context.markLabelsPrinted({ jobs: [{ id: saved.id, version: saved.version }] })[0];
  saved = h.context.setJobArchived({ id: saved.id, version: saved.version, archived: true });
  assert.equal(h.material("CK001").stockQuantity, 24);
  assert.equal(h.inventory().history.filter(event => event.action === "use").length, 1);
  h.context.adjustMaterialStock({ requestId: "returned", materialId: "CK001", date: "2026-10-20", quantity: 4, note: "削除案件の材料を現物確認して返却" });
  assert.equal(h.material("CK001").stockQuantity, 28);
  saved = h.context.setJobArchived({ id: saved.id, version: saved.version, archived: false });
  const archive = { ...saved, requestId: "archive-eligible-job", archived: true };
  const archived = h.context.saveJob(archive);
  assert.equal(archived.archived, true);
  assert.equal(h.context.saveJob(archive).version, archived.version);
  assert.equal(h.material("CK001").stockQuantity, 28);
});

test("intake previews, duplicate rejection and retries use material only on confirmed creation", () => {
  const h = harness(), first = h.candidate();
  assert.equal(h.material("CK001").stockQuantity, 28);
  const saved = h.approve(first);
  assert.equal(h.material("CK001").stockQuantity, 24);
  assert.equal(h.approve(first).id, saved.id);
  assert.equal(h.material("CK001").stockQuantity, 24);
  const duplicate = h.candidate(), blocked = h.approve(duplicate);
  assert.equal(blocked.code, "INTAKE_DUPLICATE");
  assert.equal(h.material("CK001").stockQuantity, 24);
  h.context.rejectIntake({ intakeId: duplicate.id });
  assert.equal(h.material("CK001").stockQuantity, 24);
  const candidates = [h.candidate({ serialNo: "BULK-1" }), h.candidate({ serialNo: "BULK-2" })];
  const request = { items: candidates.map(item => ({ intakeId: item.id, order: item.parsed })) };
  const result = h.context.approveIntakes(request);
  assert.equal(result.items.length, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(h.material("CK001").stockQuantity, 16);
  h.context.approveIntakes(request);
  assert.equal(h.material("CK001").stockQuantity, 16);
});

test("partial receipt changes stock and outstanding atomically; cancellation affects only remaining order", () => {
  const h = harness();
  let snapshot = h.context.saveMaterialOrder({ requestId: "po", materialId: "CK021", orderDate: "2026-10-20", quantity: 10, expectedDate: "2026-11-03", note: "碓井へ発注" });
  const id = snapshot.orders[0].id;
  assert.equal(snapshot.materials.find(item => item.id === "CK021").onOrderQuantity, 10);
  assert.equal(snapshot.materials.find(item => item.id === "CK021").nextExpectedDate, "2026-11-03");
  const receipt = { requestId: "receipt", orderId: id, date: "2026-10-22", quantity: 3, note: "分納" };
  snapshot = h.context.receiveMaterialOrder(receipt);
  assert.equal(snapshot.orders[0].remainingQuantity, 7);
  assert.equal(snapshot.orders[0].receivedQuantity, 3);
  assert.equal(snapshot.materials.find(item => item.id === "CK021").stockQuantity, 3);
  const eventCount = snapshot.history.length;
  assert.equal(h.context.receiveMaterialOrder(receipt).history.length, eventCount);
  assert.throws(() => h.context.receiveMaterialOrder({ ...receipt, quantity: 2 }), /同じリクエストID/);
  assert.throws(() => h.context.receiveMaterialOrder({ ...receipt, requestId: "zero", quantity: 0 }), /数量/);
  assert.throws(() => h.context.cancelMaterialOrder({ requestId: "cancel", orderId: id, date: "2026-10-23", note: "" }), /理由/);
  snapshot = h.context.cancelMaterialOrder({ requestId: "cancel", orderId: id, date: "2026-10-23", note: "残数不要" });
  assert.equal(snapshot.orders[0].remainingQuantity, 0);
  assert.equal(snapshot.orders[0].canceledQuantity, 7);
  assert.deepEqual(copy(snapshot.history.filter(event => event.action === "receive" && event.orderId === id).map(event => [event.materialId, event.date, event.quantity])), [["CK021", "2026-10-22", 3]]);
  assert.equal(snapshot.materials.find(item => item.id === "CK021").stockQuantity, 3);
  assert.equal(snapshot.materials.find(item => item.id === "CK021").onOrderQuantity, 0);
  assert.throws(() => h.context.receiveMaterialOrder({ ...receipt, requestId: "after-cancel" }), /取り消されています/);
  assert.throws(() => h.context.updateMaterialOrder({ requestId: "edit-canceled", orderId: id, quantity: 12, expectedDate: "2026-11-02" }), /取り消されています/);
});

test("over-receipts and late additional receipts retain full actual quantities and dates after rereading", () => {
  const h = harness();
  const placed = h.context.saveMaterialOrder({ requestId: "dated-order", materialId: "CK021", orderDate: "2026-10-20", quantity: 10, expectedDate: "2026-10-30", note: "分納の実績を確認" });
  const orderId = placed.orders[0].id;
  const first = { requestId: "dated-receipt-1", orderId, date: "2026-10-22", quantity: 3, note: "1 回目" };
  const final = { requestId: "dated-receipt-2", orderId, date: "2026-10-23", quantity: 9, note: "2 回目" };
  const late = { requestId: "dated-receipt-3", orderId, date: "2026-10-26", quantity: 2, note: "遅れて追加で入庫" };
  h.context.receiveMaterialOrder(first);
  h.context.receiveMaterialOrder(final);
  h.context.receiveMaterialOrder(final);
  h.context.receiveMaterialOrder(late);
  assert.throws(() => h.context.cancelMaterialOrder({ requestId: "cancel-fulfilled", orderId, date: "2026-10-27", note: "不要" }), /発注残/);
  const fresh = copy(h.inventory());
  assert.equal(fresh.orders.length, 1);
  assert.equal(fresh.orders[0].id, orderId);
  assert.equal(fresh.orders[0].quantity, 10);
  assert.equal(fresh.orders[0].receivedQuantity, 14);
  assert.equal(fresh.orders[0].remainingQuantity, 0);
  assert.equal(fresh.materials.find(item => item.id === "CK021").stockQuantity, 14);
  assert.equal(fresh.materials.find(item => item.id === "CK021").onOrderQuantity, 0);
  assert.equal(fresh.materials.find(item => item.id === "CK021").nextExpectedDate, "");
  const receipts = fresh.history.filter(event => event.action === "receive" && event.orderId === orderId).sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(receipts.map(event => [event.materialId, event.date, event.quantity]), [["CK021", "2026-10-22", 3], ["CK021", "2026-10-23", 9], ["CK021", "2026-10-26", 2]]);
});

test("order edits change only current quantity and expected date, retaining receipts, original order and revision history", () => {
  const h = harness(), payload = { materialId: "CK021", orderDate: "2026-10-20", expectedDate: "2026-10-30", quantity: 10, note: "元の発注備考" };
  const initial = h.context.saveMaterialOrder({ ...payload, requestId: "purchase-edit" }).orders[0];
  assert.equal(initial.revision, initial.id);
  h.context.receiveMaterialOrder({ orderId: initial.id, requestId: "prior-receipt", date: "2026-10-27", quantity: 3 });
  const edit = { orderId: initial.id, expectedRevision: initial.revision, requestId: "edit", expectedDate: "2026-11-03", quantity: 12 };
  const before = h.writes.length;
  assert.throws(() => h.context.updateMaterialOrder({ ...edit, expectedDate: "2026-10-19" }), /入庫予定日/);
  assert.throws(() => h.context.updateMaterialOrder({ ...edit, quantity: 0 }), /数量/);
  assert.equal(h.writes.length, before);
  h.state.failFlush = true;
  assert.throws(() => h.context.updateMaterialOrder(edit), /reply lost/);
  const edited = h.context.updateMaterialOrder(edit).orders[0];
  assert.notEqual(edited.revision, initial.revision);
  assert.equal(edited.id, initial.id);
  assert.equal(edited.orderDate, "2026-10-20");
  assert.equal(edited.note, "元の発注備考");
  assert.equal(edited.quantity, 12);
  assert.equal(edited.expectedDate, "2026-11-03");
  assert.equal(edited.receivedQuantity, 3);
  assert.equal(edited.remainingQuantity, 9);
  assert.equal(h.material("CK021").nextExpectedDate, "2026-11-03");
  assert.equal(h.material("CK021").onOrderQuantity, 9);
  assert.throws(() => h.context.updateMaterialOrder({ ...edit, quantity: 15 }), /同じリクエストID/);
  assert.throws(() => h.context.updateMaterialOrder({ ...edit, requestId: "stale-edit" }), /別の端末/);
  const reduced = h.context.updateMaterialOrder({ ...edit, requestId: "reduce", expectedRevision: edited.revision, quantity: 2 }).orders[0];
  assert.equal(reduced.receivedQuantity, 3);
  assert.equal(reduced.remainingQuantity, 0);
  assert.equal(h.material("CK021").stockQuantity, 3);
  assert.equal(h.material("CK021").nextExpectedDate, "");
  const reopened = h.context.updateMaterialOrder({ ...edit, requestId: "increase", expectedRevision: reduced.revision, quantity: 5 }).orders[0];
  assert.equal(reopened.remainingQuantity, 2);
  const history = h.inventory().history.filter(event => event.orderId === initial.id);
  assert.equal(history.filter(event => event.action === "editOrder").length, 3);
  const original = history.find(event => event.action === "order");
  assert.equal(original.quantity, 10);
  assert.equal(original.expectedDate, "2026-10-30");
  assert.equal(original.requestHash, h.context.MaterialInventory.hash({ action: "order", ...payload }));
  assert.deepEqual(copy(history.filter(event => event.action === "receive").map(event => event.quantity)), [3]);
});

test("material stock notes are per-row, revision checked, retryable, and independent of quantity", () => {
  const h = harness(), original = h.material("CK001");
  const note = { requestId: "note", materialId: original.id, note: "本体 12、カブセ 10\n残り2本は確認待ち", expectedRevision: original.noteRevision };
  const saved = h.context.saveMaterialStockNote(note).materials.find(item => item.id === original.id);
  assert.equal(saved.note, note.note);
  assert.ok(saved.noteRevision);
  assert.equal(h.material(original.id).note, note.note);
  assert.equal(h.material("CK011").note, "");
  assert.equal(h.material(original.id).stockQuantity, original.stockQuantity);
  assert.throws(() => h.context.saveMaterialStockNote({ ...note, note: "別の内容" }), /同じリクエストID/);
  assert.throws(() => h.context.saveMaterialStockNote({ ...note, requestId: "stale-note", note: "別の端末" }), /別の端末/);
  assert.throws(() => h.context.saveMaterialStockNote({ ...note, requestId: "long-note", note: "あ".repeat(1001) }), /1000文字/);
  const cleared = h.context.saveMaterialStockNote({ ...note, requestId: "clear-note", note: "", expectedRevision: saved.noteRevision }).materials.find(item => item.id === original.id);
  assert.notEqual(cleared.noteRevision, saved.noteRevision);
  assert.equal(h.context.saveMaterialStockNote(note).materials.find(item => item.id === original.id).note, "");
  assert.equal(h.material(original.id).note, "");
  const events = h.inventory().history.filter(event => event.action === "stockNote");
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.materialId === original.id && event.quantity === 0));
});

test("signed adjustments require reason, support retries, and preserve the audit", () => {
  const h = harness(), payload = { requestId: "loss", materialId: "CK002", date: "2026-10-20", quantity: -2, note: "棚卸で破損を確認" };
  assert.throws(() => h.context.adjustMaterialStock({ ...payload, note: "" }), /理由/);
  h.context.adjustMaterialStock(payload);
  h.context.adjustMaterialStock(payload);
  assert.equal(h.material("CK002").stockQuantity, 40);
  assert.equal(h.inventory().history.filter(item => item.action === "adjust").length, 1);
  assert.throws(() => h.context.adjustMaterialStock({ ...payload, quantity: 2 }), /同じリクエストID/);
});

test("material orders require a valid planned date no earlier than their order date before any event write", () => {
  const h = harness();
  h.inventory();
  const writes = h.writes.length;
  for (const expectedDate of ["", "2026-10-19", "2026-11-31"]) {
    assert.throws(() => h.context.saveMaterialOrder({ requestId: "invalid-expected", materialId: "CK001", orderDate: "2026-10-20", quantity: 5, expectedDate, note: "" }), /入庫予定日/);
    assert.equal(h.writes.length, writes);
    assert.equal(h.inventory().orders.length, 0);
  }
});

test("locking rereads concurrent receipt state and stale job versions", () => {
  const h = harness(), saved = h.order();
  const snapshot = h.context.saveMaterialOrder({ requestId: "po", materialId: "CK001", orderDate: "2026-10-20", quantity: 5, expectedDate: "2026-10-30", note: "" });
  const id = snapshot.orders[0].id;
  h.state.beforeLock = () => {
    const prepared = h.context.MaterialInventory.prepareMutation("receive", { requestId: "other-device", orderId: id, date: "2026-10-20", quantity: 4, note: "" }, { events: h.context.readMaterialEvents_(), id: "other-event", at: timestamp });
    h.context.appendMaterialEvents_([prepared.event]);
  };
  const received = h.context.receiveMaterialOrder({ requestId: "stale", orderId: id, date: "2026-10-20", quantity: 3, note: "" });
  assert.equal(received.orders[0].receivedQuantity, 7);
  assert.equal(received.orders[0].remainingQuantity, 0);
  assert.equal(h.material("CK001").stockQuantity, 31);
  h.state.beforeLock = () => { h.grids.get(h.context.APP.SHEETS.JOBS)[1][h.context.APP.JOB_HEADERS.indexOf("version")] = 9; };
  assert.throws(() => h.context.saveJob({ ...saved, requestId: "stale-save", quantity: 9 }), /別の端末/);
  assert.equal(h.material("CK001").stockQuantity, 31);
});

test("failed row writes cannot leave phantom usage or partially applied receipt totals", () => {
  const h = harness();
  h.inventory();
  h.state.failSheet = h.context.APP.SHEETS.JOBS;
  assert.throws(() => h.order(), /write failed/);
  assert.equal(h.material("CK001").stockQuantity, 28);
  assert.equal(h.context.readJobs_().length, 0);
  const snapshot = h.context.saveMaterialOrder({ requestId: "po", materialId: "CK001", orderDate: "2026-10-20", quantity: 5, expectedDate: "2026-10-30", note: "" });
  const payload = { requestId: "receive", orderId: snapshot.orders[0].id, date: "2026-10-20", quantity: 2, note: "" };
  h.state.failSheet = h.context.APP.SHEETS.MATERIALS;
  assert.throws(() => h.context.receiveMaterialOrder(payload), /write failed/);
  assert.equal(h.material("CK001").stockQuantity, 28);
  assert.equal(h.inventory().orders[0].remainingQuantity, 5);
  h.state.failFlush = true;
  assert.throws(() => h.context.receiveMaterialOrder(payload), /reply lost/);
  const recovered = h.context.receiveMaterialOrder(payload);
  assert.equal(recovered.materials.find(item => item.id === "CK001").stockQuantity, 30);
  assert.equal(recovered.orders[0].remainingQuantity, 3);
});

test("overflow in the prospective stock total rejects the receipt before writing a ledger row", () => {
  const h = harness();
  const placed = h.context.saveMaterialOrder({ requestId: "small-order", materialId: "CK002", orderDate: "2026-10-20", quantity: 1, expectedDate: "2026-10-30" });
  const receipt = { requestId: "excess-stock", orderId: placed.orders[0].id, date: "2026-10-30", quantity: 2 };
  const writes = h.writes.length;
  // Shrink the safe-integer range to exercise real replay overflow with a short ledger.
  function LimitedNumber(value) { return Number(value); }
  Object.setPrototypeOf(LimitedNumber, Number);
  LimitedNumber.isSafeInteger = value => Number.isSafeInteger(value) && Math.abs(value) <= 43;
  h.context.Number = LimitedNumber;
  assert.throws(() => h.context.receiveMaterialOrder(receipt), /累計数量が上限/);
  assert.equal(h.writes.length, writes);
  assert.equal(h.material("CK002").stockQuantity, 42);
  assert.equal(h.inventory().orders[0].remainingQuantity, 1);
  h.context.Number = Number;
  const accepted = h.context.receiveMaterialOrder(receipt);
  assert.equal(accepted.materials.find(item => item.id === "CK002").stockQuantity, 44);
  assert.equal(accepted.orders[0].receivedQuantity, 2);
});

test("inventory RPCs and embedded job material data are limited to editor, administrator and owner", () => {
  const h = harness();
  h.order({ category: "鋭匙鉗子" });
  for (const role of ["owner", "admin", "editor"]) { h.state.role = role; assert.equal(h.inventory().materials.length, 6); assert.ok(h.context.getSnapshot({}).jobs[0].materials); }
  for (const role of ["worker", "viewer"]) {
    h.state.role = role;
    for (const name of ["getMaterialInventory", "saveMaterialOrder", "updateMaterialOrder", "receiveMaterialOrder", "adjustMaterialStock", "saveMaterialStockNote", "cancelMaterialOrder", "saveMaterialExclusion"]) assert.throws(() => h.context[name]({}), /ACCESS_DENIED/, `${role} ${name}`);
    const snapshot = h.context.getSnapshot({});
    assert.equal(snapshot.materialInventory, null);
    assert.equal(snapshot.jobs[0].materials, undefined);
    assert.equal(snapshot.jobs[0]._materialsJsonRaw, undefined);
    assert.equal(snapshot.jobs[0].materialsJson, undefined);
  }
});

test("product-level material exclusion is exact, durable, retryable, and reversible without changing ledger", () => {
  const h = harness(), inventory = () => h.inventory();
  const first = h.order({ product: "確認対象ケリソン CK099", productCode: "CK099", specShape: "弱弯・上向", serialNo: "A-1", quantity: 4 });
  let snapshot = inventory();
  const unresolved = snapshot.unresolved.find(item => item.id === first.id);
  assert.ok(unresolved?.productKey);
  const stockBefore = copy(snapshot.materials.map(item => item.stockQuantity));
  const historyBefore = copy(snapshot.history.map(item => item.id));
  const exclusionRequest = { requestId: "exclude-product-1", action: "exclude", jobId: first.id, productKey: unresolved.productKey };
  snapshot = h.context.saveMaterialExclusion(exclusionRequest);
  assert.equal(snapshot.unresolved.some(item => item.id === first.id), false);
  assert.equal(snapshot.excludedProducts.length, 1);
  assert.deepEqual(copy(snapshot.materials.map(item => item.stockQuantity)), stockBefore);
  assert.deepEqual(copy(snapshot.history.map(item => item.id)), historyBefore);
  const exclusionRowCount = h.grids.get(h.context.APP.SHEETS.MATERIAL_EXCLUSIONS).length;
  h.context.saveMaterialExclusion(exclusionRequest);
  assert.equal(h.grids.get(h.context.APP.SHEETS.MATERIAL_EXCLUSIONS).length, exclusionRowCount, "identical request retry is idempotent");
  assert.throws(() => h.context.saveMaterialExclusion({ requestId: exclusionRequest.requestId, action: "restore", ruleId: snapshot.excludedProducts[0].id, productKey: unresolved.productKey }), /リクエストID/);

  const sameProduct = h.order({ product: first.product, productCode: first.productCode, specShape: first.specShape, serialNo: "A-2", quantity: 7 });
  assert.deepEqual(copy(sameProduct.materials.allocation), []);
  assert.deepEqual(copy(sameProduct.materials.history), []);
  assert.equal(inventory().unresolved.some(item => item.id === sameProduct.id), false);
  for (const [field, value] of [["customer", "別の得意先"], ["product", "別製品 CK099"], ["productCode", "CK098"], ["specLength", "20cm"], ["specShape", "強弯・上向"], ["bladeWidth", "4mm"]]) {
    const changed = h.order({ product: first.product, productCode: first.productCode, specShape: first.specShape, [field]: value, serialNo: `DIFFERENT-${field}`, requestId: `different-${field}` });
    assert.equal(inventory().unresolved.some(item => item.id === changed.id), true, `${field} is part of the exact product identity`);
  }
  const otherProduct = h.order({ product: first.product, productCode: first.productCode, specShape: "強弯・上向", serialNo: "A-3", quantity: 2 });
  assert.equal(inventory().unresolved.some(item => item.id === otherProduct.id), true, "a different exact specification does not inherit the exclusion");

  const activeRule = inventory().excludedProducts[0];
  const restore = { requestId: "restore-product-1", action: "restore", ruleId: activeRule.id, productKey: activeRule.key };
  snapshot = h.context.saveMaterialExclusion(restore);
  assert.equal(snapshot.excludedProducts.length, 0);
  assert.equal(snapshot.unresolved.some(item => item.id === first.id), true);
  assert.equal(snapshot.unresolved.some(item => item.id === sameProduct.id), true);
  assert.deepEqual(copy(snapshot.materials.map(item => item.stockQuantity)), stockBefore);
  assert.deepEqual(copy(snapshot.history.map(item => item.id)), historyBefore);
  assert.throws(() => h.context.saveMaterialExclusion({ ...restore, requestId: "restore-stale", ruleId: "stale-rule" }), /対象外|更新|一致/);
});

test("future intake approval honors an active product exclusion", () => {
  const h = harness();
  const first = h.order({ product: "確認対象ケリソン CK099", productCode: "CK099", specShape: "弱弯・上向", serialNo: "INITIAL", quantity: 4 });
  const unresolved = h.inventory().unresolved.find(item => item.id === first.id);
  h.context.saveMaterialExclusion({ requestId: "exclude-before-intake", action: "exclude", jobId: first.id, productKey: unresolved.productKey });
  const candidate = h.candidate({ product: first.product, productCode: first.productCode, specShape: first.specShape, serialNo: "FROM-INTAKE", quantity: 6 });
  const imported = h.approve(candidate);
  assert.deepEqual(copy(imported.materials.allocation), []);
  assert.deepEqual(copy(imported.materials.history), []);
  assert.equal(h.inventory().unresolved.some(item => item.id === imported.id), false);
  assert.deepEqual(copy(h.inventory().materials.map(item => item.stockQuantity)), [28, 12, 42, 1, 0, 0]);
});

test("exclusion append retries after a failed write or a lost flush response", () => {
  for (const failure of ["write", "flush"]) {
    const h = harness();
    const job = h.order({ product: "確認対象ケリソン CK099", productCode: "CK099", specShape: "弱弯・上向", serialNo: `FAIL-${failure}` });
    const productKey = h.inventory().unresolved.find(item => item.id === job.id).productKey;
    const request = { requestId: `retry-${failure}`, action: "exclude", jobId: job.id, productKey };
    if (failure === "write") h.state.failSheet = h.context.APP.SHEETS.MATERIAL_EXCLUSIONS;
    else h.state.failFlush = true;
    assert.throws(() => h.context.saveMaterialExclusion(request), failure === "write" ? /write failed/ : /reply lost/);
    const afterFailure = h.grids.get(h.context.APP.SHEETS.MATERIAL_EXCLUSIONS)?.length || 1;
    const snapshot = h.context.saveMaterialExclusion(request);
    assert.equal(snapshot.excludedProducts.length, 1);
    assert.equal(h.grids.get(h.context.APP.SHEETS.MATERIAL_EXCLUSIONS).length, afterFailure === 1 ? 2 : afterFailure, "retry does not append a duplicate decision");
  }
});

test("canceling a product exclusion on a legacy order keeps the original material baseline", () => {
  for (const quantity of [4, 7, 2]) {
    const h = harness();
    const legacy = h.context.normalizeJobInput_(order({ id: "legacy-excluded", productCode: "CK099", quantity: 4 }), null);
    legacy.materials = { version: 1, baseline: { allocation: [], at: timestamp, unresolvedTargetQuantity: 4 }, allocation: [], history: [], requests: [] };
    h.seed([legacy]);
    const before = h.inventory();
    const productKey = before.unresolved.find(item => item.id === legacy.id).productKey;
    const excluded = h.context.saveMaterialExclusion({ requestId: "legacy-exclude", action: "exclude", jobId: legacy.id, productKey });
    let edited = h.context.saveJob({ ...h.context.readJobs_()[0], note: "備考だけ変更", requestId: "legacy-excluded-note" });
    if (quantity !== 4) edited = h.context.saveJob({ ...edited, quantity, requestId: "legacy-excluded-quantity" });

    assert.equal(h.inventory().unresolved.some(item => item.id === legacy.id), false);
    assert.deepEqual(copy(h.inventory().materials.map(item => item.stockQuantity)), copy(before.materials.map(item => item.stockQuantity)));
    assert.deepEqual(copy(edited.materials.history), []);
    const restored = h.context.saveMaterialExclusion({ requestId: "legacy-restore", action: "restore", ruleId: excluded.excludedProducts[0].id, productKey });
    assert.equal(restored.unresolved.some(item => item.id === legacy.id), true);

    const corrected = h.context.saveJob({ ...edited, productCode: "CK001", requestId: "legacy-correct-code" });
    const change = quantity - 4;
    assert.equal(h.material("CK001").stockQuantity, 28 - change);
    assert.deepEqual(copy(corrected.materials.baseline.allocation), [{ materialId: "CK001", quantity: 4 }]);
    assert.deepEqual(copy(corrected.materials.history.map(event => [event.action, event.quantity])), change === 0 ? [] : [[change > 0 ? "use" : "release", Math.abs(change)]]);
    assert.equal(h.inventory().unresolved.some(item => item.id === legacy.id), false);
  }
});

test("a lost response for an already excluded product cannot undo a later restoration", () => {
  const h = harness();
  const job = h.order({ productCode: "CK099" });
  const productKey = h.inventory().unresolved.find(item => item.id === job.id).productKey;
  const request = { requestId: "exclude-from-first-device", action: "exclude", jobId: job.id, productKey };
  const { excludedProducts: [rule] } = h.context.saveMaterialExclusion(request);
  const duplicate = { ...request, requestId: "exclude-from-second-device" };
  assert.equal(h.context.saveMaterialExclusion(duplicate).excludedProducts[0].id, rule.id);
  h.context.saveMaterialExclusion({ requestId: "restore-from-first-device", action: "restore", ruleId: rule.id, productKey });

  const rowsBeforeRetry = h.grids.get(h.context.APP.SHEETS.MATERIAL_EXCLUSIONS).length;
  const retried = h.context.saveMaterialExclusion(duplicate);
  assert.equal(retried.excludedProducts.length, 0);
  assert.equal(retried.unresolved.some(item => item.id === job.id), true);
  assert.equal(h.grids.get(h.context.APP.SHEETS.MATERIAL_EXCLUSIONS).length, rowsBeforeRetry);
  assert.throws(() => h.context.saveMaterialExclusion({ ...duplicate, jobId: "another-job" }), /リクエストID/);
  assert.equal(h.context.saveMaterialExclusion({ ...duplicate, requestId: "new-exclusion" }).excludedProducts.length, 1);
});

test("a product exclusion cannot hide a current material allocation or accept a stale product signature", () => {
  const h = harness();
  const allocated = h.order({ product: "慈大式 彫骨器", productCode: "CK001", specShape: "直・上向" });
  const allocatedKey = h.context.MaterialInventory.productKey(allocated);
  assert.throws(() => h.context.saveMaterialExclusion({ requestId: "exclude-allocated", action: "exclude", jobId: allocated.id, productKey: allocatedKey }), /使用|割当|材料/);

  const unresolved = h.order({ product: "確認対象ケリソン CK099", productCode: "CK099", specShape: "弱弯・上向" });
  const staleKey = h.context.MaterialInventory.productKey({ ...unresolved, specLength: "old" });
  assert.throws(() => h.context.saveMaterialExclusion({ requestId: "exclude-stale", action: "exclude", jobId: unresolved.id, productKey: staleKey }), /製品|一致|更新/);
});

test("corrupt or oversized job material history is rejected before altering stock", () => {
  const h = harness(), saved = h.order(), state = copy(saved.materials);
  state.history[0].quantity = 99;
  assert.throws(() => h.context.MaterialInventory.normalizeState(state), /一致しません/);
  const large = copy(saved.materials);
  large.history[0].note = "長".repeat(45000);
  assert.throws(() => h.context.MaterialInventory.normalizeState(large), /保存上限/);
  assert.equal(h.material("CK001").stockQuantity, 24);
});
