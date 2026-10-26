import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function harness() {
  const storage = new Map();
  const elements = new Map();
  const printed = { count: 0, classes: new Set() };
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: "", value: "", checked: false, dataset: {} });
      return elements.get(selector);
    },
    body: { classList: {
      add: (name) => printed.classes.add(name),
      remove: (name) => printed.classes.delete(name),
    } },
  };
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON,
    document,
    window: { print: () => { printed.count += 1; } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    requestAnimationFrame: (callback) => callback(),
    setTimeout, clearTimeout,
  });
  const sourceWithoutStartup = appSource.slice(0, appSource.indexOf("async function init()"));
  vm.runInContext(`${sourceWithoutStartup}\nglobalThis.__test = { state, api, distributionJobs, distributionPrintMarkup, saveDistributionAssignee, printDistribution, configuredDistributionAssignees, distributionAssigneeOptions, distributionWorkloads, distributionQuantityLabel, setDistributionMonth, changeDistributionMonth, distributionPeriodLabel, distributionPrintJobs, renderDistributionWorkspace };`, context);
  context.__test.state.distributionMonth = "2026-04";
  context.__test.state.access = { email: "editor@example.com", role: "editor", canEdit: true };
  context.renderDistributionWorkspace = () => {};
  context.renderAll = () => {};
  context.showToast = (...args) => { context.lastToast = args; };
  context.refreshData = async () => {};
  return { context, ui: context.__test, elements, printed };
}

const job = (id, dueDate, overrides = {}) => ({
  id, dueDate, category: "鋭匙鉗子", product: `製品${id}`, quantity: 1, specShape: "上向", bladeWidth: "3mm",
  shippingStatus: "waiting", archived: false, distributionAssignee: "", version: 2, labelPrintStatus: "waiting",
  ...overrides,
});

test("月次候補は月境界、出荷、削除、カテゴリと担当フィルタを正しく適用して納期順に返す", () => {
  const { ui } = harness();
  ui.state.jobs = [
    job("late", "2026-04-30", { distributionAssignee: "幹" }),
    job("early", "2026-04-01", { distributionAssignee: "幹" }),
    job("middle", "2026-04-15", { distributionAssignee: "豊" }),
    job("march", "2026-03-31"),
    job("may", "2026-05-01"),
    job("shipped", "2026-04-10", { shippingStatus: "shipped" }),
    job("archived", "2026-04-12", { archived: true }),
    job("other", "2026-04-13", { category: "ケリソンパンチ" }),
  ];
  assert.deepEqual(Array.from(ui.distributionJobs(), (entry) => entry.id), ["early", "middle", "late"]);
  assert.deepEqual(Array.from(ui.distributionJobs({ includeShipped: true }), (entry) => entry.id), ["early", "shipped", "middle", "late"]);
  assert.deepEqual(Array.from(ui.distributionJobs({ assignee: "幹" }), (entry) => entry.id), ["early", "late"]);
  assert.deepEqual(Array.from(ui.distributionJobs({ month: "2026-05" }), (entry) => entry.id), ["may"]);
});

test("納期期間は両端を含み、年をまたいでもカテゴリ・出荷・削除・担当・並び順を保つ", () => {
  const { ui } = harness();
  ui.state.distributionMonth = "2026-12";
  ui.state.distributionEndMonth = "2027-01";
  ui.state.distributionFilter = "all";
  ui.state.distributionIncludeShipped = false;
  ui.state.distributionSort = "due";
  ui.state.jobs = [
    job("jan", "2027-01-31", { distributionAssignee: "豊", customer: "田中" }),
    job("dec", "2026-12-01", { distributionAssignee: "豊", customer: "得意先2" }),
    job("kan", "2027-01-10", { distributionAssignee: "幹", customer: "得意先10" }),
    job("nov", "2026-11-30", { distributionAssignee: "豊" }),
    job("feb", "2027-02-01", { distributionAssignee: "豊" }),
    job("shipped", "2026-12-15", { distributionAssignee: "豊", shippingStatus: "shipped", customer: "得意先2" }),
    job("archived", "2026-12-16", { distributionAssignee: "豊", archived: true }),
    job("other", "2026-12-17", { distributionAssignee: "豊", category: "ケリソンパンチ" }),
    job("undated", "", { distributionAssignee: "豊" }),
  ];
  assert.deepEqual(Array.from(ui.distributionJobs(), (entry) => entry.id), ["dec", "kan", "jan"]);
  ui.state.distributionFilter = "豊";
  assert.deepEqual(Array.from(ui.distributionJobs(), (entry) => entry.id), ["dec", "jan"]);
  ui.state.distributionIncludeShipped = true;
  assert.deepEqual(Array.from(ui.distributionJobs(), (entry) => entry.id), ["dec", "shipped", "jan"]);
  ui.state.distributionFilter = "all";
  ui.state.distributionSort = "customer";
  assert.deepEqual(Array.from(ui.distributionJobs(), (entry) => entry.id), ["dec", "shipped", "jan", "kan"]);
});

test("複数月の表示と印刷は月・得意先・納期の優先順で並べる", () => {
  const { ui } = harness();
  ui.state.distributionMonth = "2026-11";
  ui.state.distributionEndMonth = "2027-01";
  ui.state.jobs = [
    job("jan", "2027-01-01", { customer: "田中", distributionAssignee: "豊" }),
    job("dec-other", "2026-12-01", { customer: "松井", distributionAssignee: "幹" }),
    job("nov-stock", "2026-11-01", { customer: "在庫用" }),
    job("dec-late", "2026-12-30", { customer: "田中", distributionAssignee: "豊" }),
    job("nov-late", "2026-11-30", { customer: "田中", distributionAssignee: "豊" }),
    job("nov-other", "2026-11-02", { customer: "松井", distributionAssignee: "幹" }),
    job("nov-early", "2026-11-01", { customer: "田中", distributionAssignee: "豊" }),
    job("dec-early", "2026-12-02", { customer: "田中", distributionAssignee: "豊" }),
  ];
  const originalOrder = ui.state.jobs.map((entry) => entry.id);
  const jobs = ui.distributionJobs();
  assert.deepEqual(Array.from(jobs, (entry) => entry.id), ["nov-early", "nov-late", "nov-other", "nov-stock", "dec-early", "dec-late", "dec-other", "jan"]);
  const print = ui.distributionPrintMarkup(jobs, "2026-11", "customer", "2027-01");
  const printedProducts = [...print.matchAll(/<td>(製品[^<]+)<\/td>/g)].map((match) => match[1]);
  assert.deepEqual(printedProducts, ["製品nov-early", "製品nov-late", "製品nov-other", "製品dec-early", "製品dec-late", "製品dec-other", "製品jan"]);
  assert.match(print, /月→得意先→納期順/);
  assert.deepEqual(ui.state.jobs.map((entry) => entry.id), originalOrder);
});

test("期間初期値は単月で、範囲操作は逆転を防ぎ移動で期間長を保つ", () => {
  const { ui, elements } = harness();
  ui.state.distributionEndMonth = "";
  assert.deepEqual(Array.from(ui.distributionJobs(), (entry) => entry.id), []);
  ui.renderDistributionWorkspace();
  assert.equal(ui.state.distributionEndMonth, ui.state.distributionMonth);
  assert.equal(elements.get("#distribution-end-month").value, ui.state.distributionMonth);
  assert.equal(ui.distributionPeriodLabel("2026-04"), "2026年4月");
  assert.equal(ui.distributionPeriodLabel("2026-12", "2027-02"), "2026年12月～2027年2月");

  ui.setDistributionMonth("start", "2026-06");
  assert.equal(ui.state.distributionMonth, "2026-06");
  assert.equal(ui.state.distributionEndMonth, "2026-06");
  ui.setDistributionMonth("end", "2026-08");
  ui.setDistributionMonth("start", "2026-09");
  assert.deepEqual([ui.state.distributionMonth, ui.state.distributionEndMonth], ["2026-09", "2026-09"]);
  ui.setDistributionMonth("end", "2026-07");
  assert.deepEqual([ui.state.distributionMonth, ui.state.distributionEndMonth], ["2026-07", "2026-07"]);

  ui.setDistributionMonth("start", "2026-12");
  ui.setDistributionMonth("end", "2027-02");
  ui.changeDistributionMonth(1);
  assert.deepEqual([ui.state.distributionMonth, ui.state.distributionEndMonth], ["2027-01", "2027-03"]);
  ui.changeDistributionMonth(-1);
  assert.deepEqual([ui.state.distributionMonth, ui.state.distributionEndMonth], ["2026-12", "2027-02"]);
});

test("期間選択は不正値を無視し、端の月からはみ出す移動を拒否する", () => {
  const { ui } = harness();
  ui.state.distributionMonth = "0001-01";
  ui.state.distributionEndMonth = "0001-02";
  ui.changeDistributionMonth(-1);
  assert.deepEqual([ui.state.distributionMonth, ui.state.distributionEndMonth], ["0001-01", "0001-02"]);
  ui.setDistributionMonth("start", "0000-12");
  ui.setDistributionMonth("end", "2026-13");
  assert.deepEqual([ui.state.distributionMonth, ui.state.distributionEndMonth], ["0001-01", "0001-02"]);
  ui.state.distributionMonth = "9999-11";
  ui.state.distributionEndMonth = "9999-12";
  ui.changeDistributionMonth(1);
  assert.deepEqual([ui.state.distributionMonth, ui.state.distributionEndMonth], ["9999-11", "9999-12"]);
});

test("画面は9列で現在工程を出し、印刷は8列のまま現在工程を含めない", () => {
  const { ui, elements } = harness();
  ui.state.distributionMonth = "2026-04";
  ui.state.distributionEndMonth = "2026-04";
  ui.state.jobs = [
    job("heat", "2026-04-01", { distributionAssignee: "豊", stages: { welding: { status: "done" }, base: { status: "done" }, grinding: { status: "done" }, heat: { status: "working" } } }),
    job("polishing", "2026-04-02", { distributionAssignee: "豊", polishing: { sentQuantity: 2, returnedQuantity: 1 }, stages: { welding: { status: "working" } } }),
    job("waiting", "2026-04-03", { distributionAssignee: "豊", polishing: { sentQuantity: 1, returnedQuantity: 1 }, stages: { finish: { status: "done" } } }),
    job("shipped", "2026-04-04", { distributionAssignee: "豊", shippingStatus: "shipped", stages: { finish: { status: "done" } } }),
  ];
  ui.state.distributionIncludeShipped = true;
  ui.renderDistributionWorkspace();
  const markup = elements.get("#distribution-workspace").innerHTML;
  const headers = [...markup.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.equal(headers.length, 9);
  assert.deepEqual(headers.slice(6), ["幅", "現在の工程", "配布担当"]);
  assert.match(markup, /data-column="現在の工程">頭付け・幅取り<\/td>/);
  assert.match(markup, /data-column="現在の工程">研磨中<\/td>/);
  assert.match(markup, /data-column="現在の工程">出荷待ち<\/td>/);
  assert.match(markup, /data-column="現在の工程">出荷完了<\/td>/);
  const print = ui.distributionPrintMarkup(ui.distributionJobs({ includeShipped: true, assignee: "all" }), "2026-04");
  assert.equal((print.match(/<th scope="col">/g) || []).length, 8);
  assert.match(print, /4件 · 数量合計 4丁/);
  assert.match(print, /製品heat/);
  assert.doesNotMatch(print, /現在の工程|頭付け・幅取り|研磨中|出荷待ち|出荷完了/);
});

test("未定の案件は画面に残し、印刷対象と担当別印刷合計から除く", () => {
  const { ui, elements } = harness();
  ui.state.distributionMonth = "2026-04";
  ui.state.distributionEndMonth = "2026-04";
  ui.state.jobs = [
    job("assigned", "2026-04-01", { distributionAssignee: "豊", quantity: 4 }),
    job("blank", "2026-04-02", { distributionAssignee: "   ", quantity: 20 }),
    job("unknown", "2026-04-03", { quantity: 6 }),
  ];
  ui.renderDistributionWorkspace();
  assert.match(elements.get("#distribution-workspace").innerHTML, /製品blank/);
  assert.match(elements.get("#distribution-workspace").innerHTML, /製品unknown/);
  assert.deepEqual(Array.from(ui.distributionPrintJobs(), (entry) => entry.id), ["assigned"]);
  const print = ui.distributionPrintMarkup(ui.distributionJobs(), "2026-04");
  assert.match(print, /製品assigned/);
  assert.doesNotMatch(print, /製品blank|製品unknown|未定/);
  assert.match(print, /1件 · 数量合計 4丁/);
  assert.match(print, /担当別合計：豊：4丁/);
});

test("未定案件しかないと印刷せず、印刷時は画面の担当フィルタを使う", async () => {
  const { context, ui, elements, printed } = harness();
  context.fitDistributionToPage = () => {};
  ui.state.distributionMonth = "2026-04";
  ui.state.distributionEndMonth = "2026-04";
  ui.state.jobs = [job("unknown", "2026-04-01", { distributionAssignee: "  " })];
  ui.renderDistributionWorkspace();
  assert.equal(elements.get("#distribution-print-button").disabled, true);
  await ui.printDistribution();
  assert.equal(printed.count, 0);
  assert.equal(elements.get("#distribution-print-sheet")?.innerHTML || "", "");

  ui.state.jobs = [
    job("toyut", "2026-04-01", { distributionAssignee: "豊" }),
    job("kan", "2026-04-02", { distributionAssignee: "幹" }),
    job("unknown", "2026-04-03", { distributionAssignee: "" }),
  ];
  ui.state.distributionFilter = "幹";
  await ui.printDistribution();
  assert.equal(printed.count, 1);
  assert.match(elements.get("#distribution-print-sheet").innerHTML, /製品kan/);
  assert.doesNotMatch(elements.get("#distribution-print-sheet").innerHTML, /製品toyut|製品unknown/);
});

test("印刷表は納期順の単一表に連番を含む8列と担当別丁数を載せ、文字列をHTMLエスケープする", () => {
  const { ui } = harness();
  ui.state.distributionSort = "due";
  const jobs = [
    job("2", "2026-04-20", { product: '鉗子 <script>&"', customer: '得意先 <確認>', serialNo: '26-<2>&"', distributionAssignee: "幹" }),
    job("1", "2026-04-02", { serialNo: "26-001-01～10", distributionAssignee: "豊" }),
    job("3", "2026-04-22", { distributionAssignee: "幹" }),
  ];
  const markup = ui.distributionPrintMarkup(ui.distributionJobs({jobs, month: "2026-04"}), "2026-04");
  assert.equal((markup.match(/class="distribution-print-page"/g) || []).length, 1);
  assert.equal((markup.match(/<table>/g) || []).length, 1);
  assert.ok(markup.indexOf("製品1") < markup.indexOf("鉗子 &lt;script&gt;"));
  assert.ok(markup.indexOf("鉗子 &lt;script&gt;") < markup.indexOf("製品3"));
  assert.match(markup, /<td>豊<\/td>/);
  assert.match(markup, /<td>幹<\/td>/);
  assert.match(markup, /鉗子 &lt;script&gt;&amp;&quot;/);
  assert.match(markup, /得意先 &lt;確認&gt;/);
  assert.match(markup, /<td>製品1<\/td><td>26-001-01～10<\/td>/);
  assert.match(markup, /<td>26-&lt;2&gt;&amp;&quot;<\/td>/);
  assert.match(markup, /<td>製品3<\/td><td>—<\/td>/);
  assert.match(markup, /豊：1丁/);
  assert.match(markup, /幹：2丁/);
  assert.ok(markup.indexOf("distribution-print-totals") > markup.indexOf("</table>"));
  assert.equal((markup.match(/<th scope="col">/g) || []).length, 8);
  assert.equal((markup.match(/<col class="print-/g) || []).length, 8);
});

test("得意先順は逆順でまとめ、同じ得意先の納期順と空欄末尾を保って印刷する", () => {
  const { ui } = harness();
  ui.state.jobs = [
    job("late", "2026-04-30", { customer: "得意先2", distributionAssignee: "豊" }),
    job("blank", "2026-04-01", { customer: "", distributionAssignee: "豊" }),
    job("ten", "2026-04-10", { customer: "得意先10", distributionAssignee: "豊" }),
    job("early", "2026-04-02", { customer: "得意先2", distributionAssignee: "豊" }),
  ];
  ui.state.distributionSort = "customer";
  const jobs = ui.distributionJobs();
  assert.deepEqual(Array.from(jobs, (entry) => entry.id), ["ten", "early", "late", "blank"]);
  const markup = ui.distributionPrintMarkup(jobs, "2026-04");
  assert.match(markup, /月→得意先→納期順/);
  assert.ok(markup.indexOf("製品ten") < markup.indexOf("製品early"));
  assert.ok(markup.indexOf("製品early") < markup.indexOf("製品late"));
  assert.deepEqual(Array.from(ui.distributionJobs({sort: "due"}), (entry) => entry.id), ["blank", "early", "ten", "late"]);
});

test("配布担当候補は表示設定に従い、非表示にした既存担当は該当案件で保持する", () => {
  const { ui } = harness();
  assert.equal(ui.configuredDistributionAssignees().length, 10);
  ui.state.settings.distributionAssignees = JSON.stringify(["豊"]);
  assert.deepEqual(Array.from(ui.distributionAssigneeOptions()), ["", "豊"]);
  assert.deepEqual(Array.from(ui.distributionAssigneeOptions([job("one", "2026-04-01", {distributionAssignee: "幹"})])), ["", "豊", "幹"]);
  ui.state.settings.distributionAssignees = "[]";
  assert.deepEqual(Array.from(ui.distributionAssigneeOptions()), [""]);
  ui.state.settings.distributionAssignees = "broken JSON";
  assert.equal(ui.configuredDistributionAssignees().length, 10);
});

test("担当別丁数は件数と区別し、未定・ゼロ・数量未入力・非表示の既存担当も集計する", () => {
  const { ui } = harness();
  ui.state.settings.distributionAssignees = JSON.stringify(["豊", "幹"]);
  const jobs = [
    job("a", "2026-04-01", { distributionAssignee: "豊", quantity: 3 }),
    job("b", "2026-04-02", { distributionAssignee: "豊", quantity: 7 }),
    job("c", "2026-04-03", { distributionAssignee: "幹", quantity: 0 }),
    job("d", "2026-04-04", { distributionAssignee: "幹", quantity: "" }),
    job("e", "2026-04-05", { distributionAssignee: "鈴", quantity: 5 }),
    job("f", "2026-04-06", { quantity: null }),
  ];
  const totals = Array.from(ui.distributionWorkloads(jobs), (entry) => ({...entry}));
  assert.deepEqual(totals, [
    { assignee: "", count: 1, total: 0, unknown: 1 },
    { assignee: "豊", count: 2, total: 10, unknown: 0 },
    { assignee: "幹", count: 2, total: 0, unknown: 1 },
    { assignee: "鈴", count: 1, total: 5, unknown: 0 },
  ]);
  assert.equal(ui.distributionQuantityLabel(totals[0]), "数量未入力");
  assert.equal(ui.distributionQuantityLabel(totals[1]), "10丁");
  assert.equal(ui.distributionQuantityLabel(totals[2]), "0丁");
  assert.equal(totals.reduce((sum, item) => sum + item.total, 0), 15);
});

test("配布担当保存中は印刷せず、成功後もラベル印刷状態を維持する", async () => {
  const { context, ui, elements, printed } = harness();
  const target = job("save", "2026-04-11", { labelPrintStatus: "printed", labelPrintedAt: "2026-04-01T00:00:00.000Z" });
  ui.state.jobs = [target];
  let resolveSave;
  ui.api.setDistributionAssignee = () => new Promise((resolve) => { resolveSave = resolve; });
  const saving = ui.saveDistributionAssignee("save", "豊");
  assert.ok(ui.state.distributionSaving.has("save"));
  await ui.printDistribution();
  assert.equal(printed.count, 0);
  resolveSave({ ...target, distributionAssignee: "豊", version: 3 });
  await saving;
  assert.equal(ui.state.jobs[0].distributionAssignee, "豊");
  assert.equal(ui.state.jobs[0].labelPrintStatus, "printed");
  assert.equal(ui.state.jobs[0].labelPrintedAt, target.labelPrintedAt);
  assert.equal(elements.get("#distribution-print-sheet")?.innerHTML || "", "");
});

test("配布表の印刷は保留中のラベル確認・ラベル選択を保持する", async () => {
  const { context, ui, printed, elements } = harness();
  context.fitDistributionToPage = () => {};
  ui.state.jobs = [job("print", "2026-04-11", { distributionAssignee: "豊" })];
  ui.state.labelPrintSelection.add("print");
  ui.state.labelPrintPendingConfirmation = [{ id: "print", version: 2 }];
  await ui.printDistribution();
  assert.equal(printed.count, 1);
  assert.equal(ui.state.printMode, "distribution");
  assert.match(elements.get("#distribution-print-sheet").innerHTML, /<td>豊<\/td>/);
  assert.equal(ui.state.labelPrintSelection.has("print"), true);
  assert.equal(ui.state.labelPrintPendingConfirmation.length, 1);
  assert.equal(ui.state.jobs[0].labelPrintStatus, "waiting");
  assert.equal(printed.classes.has("is-printing-labels"), false);
  assert.equal(printed.classes.has("is-printing-distribution"), false);
});

test("担当保存の競合エラーは失敗として通知し、案件の既存ラベル状態を維持する", async () => {
  const { context, ui } = harness();
  const target = job("conflict", "2026-04-11", { distributionAssignee: "幹", labelPrintStatus: "reprint" });
  ui.state.jobs = [target];
  ui.api.setDistributionAssignee = async () => { throw new Error("別の端末で先に更新されています"); };
  await ui.saveDistributionAssignee("conflict", "豊");
  assert.equal(ui.state.jobs[0].distributionAssignee, "幹");
  assert.equal(ui.state.jobs[0].labelPrintStatus, "reprint");
  assert.match(context.lastToast[0], /別の端末で先に更新/);
  assert.equal(context.lastToast[1].sticky, true);
});
