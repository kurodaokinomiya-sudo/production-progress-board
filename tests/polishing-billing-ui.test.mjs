import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
function harness() {
  const storage = new Map(), elements = new Map();
  const inputs = [];
  const context = vm.createContext({ Date, Intl, Math, Number, Object, String, Array, RegExp, Set, Map, JSON, URL, structuredClone, setTimeout, clearTimeout,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: {}, document: { querySelector: (key) => { if (!elements.has(key)) elements.set(key, { innerHTML: "", textContent: "", value: "", dataset: {} }); return elements.get(key); }, querySelectorAll: (key) => key.includes("data-polishing-rate]") ? inputs : [] },
  });
  vm.runInContext(source.slice(0, source.indexOf("async function init()")) + "\nglobalThis.ui = {state,api,polishingMonthlySummary,polishingRatesForMonth,polishingClassControl,savePolishingClassification,renderPolishingBilling,labelTitle,productDisplayName,savePolishingRateForm,editPolishingCustomRate,savePolishingCustomRates,normalizeCustomPolishingRates,resetPolishingCustomRates};", context);
  context.renderPolishingBilling = () => {};
  context.renderAll = () => {};
  context.renderPolishingWorkspace = () => {};
  context.showToast = () => {};
  context.ui.state.access = { role: "owner", isOwner: true, isAdmin: true, canEdit: true };
  return { ui: context.ui, inputs, elements };
}

const returned = (classCode, quantity, at, archived = false) => ({ archived, productMaster: {classCode}, polishing: { history: [{action:"send",quantity,at:"2026-09-01T00:00:00Z"},{action:"return",quantity,at}] } });

test("月別研磨代は日本の戻り月で削除済み履歴も集計し、発送を除く", () => {
  const { ui } = harness();
  const jobs = [returned("A", 3, "2026-09-30T15:00:00Z", true), returned("B", 2, "2026-10-31T14:59:59Z"), returned("A", 9, "2026-10-31T15:00:00Z")];
  const summary = ui.polishingMonthlySummary(jobs, { polishingRates: JSON.stringify({"2026-10":{A:100,B:250}}) }, "2026-10");
  assert.equal(summary.quantity, 5);
  assert.equal(summary.totalAmount, 5000, "嘉代800円に、全5丁の江部840円を加算する");
  assert.equal(summary.vendorTotals.find((entry) => entry.vendor === "江部").totalAmount, 4200);
  assert.equal(summary.vendorTotals.find((entry) => entry.vendor === "嘉代").totalAmount, 800);
  assert.equal(summary.rows.find((row) => row.classCode === "A").quantity, 3);
});

test("ゼロ単価は有効、単価未設定や未分類を含む支払額は未確定", () => {
  const { ui } = harness();
  const summary = ui.polishingMonthlySummary([returned("A", 2, "2026-10-05"), returned("B", 4, "2026-10-05"), returned("未分類", 1, "2026-10-05")], {polishingRates:'{"2026-10":{"A":0,"B":null}}'}, "2026-10");
  assert.equal(summary.quantity, 7);
  assert.equal(summary.knownAmount, 5880, "未分類も含め江部840円は全7丁を計算する");
  assert.equal(summary.missingQuantity, 5);
  assert.equal(summary.totalAmount, null);
  assert.equal(summary.rows.find((row) => row.classCode === "A").amount, 0);
});

test("ラベルは照合済みの材料語を品名横へ追加し、全半角の重複を避ける", () => {
  const { ui } = harness();
  assert.equal(ui.labelTitle({product:"鋭匙鉗子",specShape:"直",productMaster:{labelKeywords:["ｱﾘｼﾞ","白銅"]}}), "鋭匙鉗子 ｱﾘｼﾞ・白銅 直");
  assert.equal(ui.labelTitle({product:"鋭匙鉗子 アリジ",productMaster:{labelKeywords:["ｱﾘｼﾞ"]}}), "鋭匙鉗子 アリジ");
  assert.equal(ui.labelTitle({product:"未照合鉗子",productMaster:{labelKeywords:[]}}), "未照合鉗子");
  const corrected={product:"鋭匙鉗子 ｱﾘｼﾞ",specShape:"直",productMaster:{labelKeywords:["ｳｽｲ"],labelKeywordSource:"manual"}};
  assert.equal(ui.productDisplayName(corrected),"鋭匙鉗子 ｳｽｲ");
  assert.equal(ui.labelTitle(corrected),"鋭匙鉗子 ｳｽｲ 直");
});

test("初月単価は未保存nullを競合条件に送り、空欄と0を区別して保存する", async () => {
  const { ui, inputs } = harness();
  ui.state.polishingBillingMonth = "2026-10";
  inputs.push({value:"0",dataset:{polishingRate:"A"}},{value:"",dataset:{polishingRate:"B"}},{value:"3300",dataset:{polishingRate:"B(メニスカス)"}});
  let sent;
  ui.api.savePolishingRates = async (payload) => { sent = payload; return {polishingRates:JSON.stringify({[payload.month]:payload.rates})}; };
  await ui.savePolishingRateForm({preventDefault(){}});
  assert.equal(sent.expectedRates, null);
  assert.equal(sent.rates.A, 0);
  assert.equal(sent.rates.B, null);
  assert.equal(sent.rates["B(メニスカス)"], 3300);
  assert.equal(ui.state.polishingRatesDirty, false);
});

test("単価編集中の同期で他端末の新しい単価を受け取っても、保存は編集開始時の値で競合を確認する", async () => {
  const { ui, inputs } = harness();
  ui.state.polishingBillingMonth = "2026-10";
  ui.state.polishingRatesBase = {A:100};
  ui.state.polishingRatesDirty = true;
  ui.state.settings.polishingRates = '{"2026-10":{"A":200}}';
  inputs.push({value:"150",dataset:{polishingRate:"A"}});
  let sent;
  ui.api.savePolishingRates = async (payload) => { sent = payload; throw new Error("別の端末で更新されています"); };
  await ui.savePolishingRateForm({preventDefault(){}});
  assert.equal(sent.expectedRates.A, 100);
  assert.equal(inputs[0].value, "150");
  assert.equal(ui.state.polishingRatesDirty, true);
});

test("嘉代の全区分に既定単価が入り、江部通常840円を別会計で計算する", () => {
  const { ui } = harness();
  const summary = ui.polishingMonthlySummary(["A", "B", "B(メニスカス)", "C", "D", "特殊"].map((code) => returned(code, 1, "2026-10-07")), {}, "2026-10");
  assert.equal(summary.quantity, 6);
  assert.equal(summary.vendorTotals.find((row) => row.vendor === "江部").totalAmount, 5040);
  assert.equal(summary.vendorTotals.find((row) => row.vendor === "嘉代").totalAmount, 18800);
  assert.equal(summary.totalAmount, 23840);
  assert.deepEqual(Array.from(summary.rows.filter((row) => row.vendor === "嘉代" && row.classCode !== "未分類"), (row) => row.unitPrice), [2000, 2500, 3300, 3000, 3500, 4500]);
});

test("B(メニスカス)は3300円、江部電解・江部磨きは江部だけで計算する", () => {
  const { ui } = harness();
  const meniscus = returned("B(メニスカス)", 10, "2026-10-07");
  const electro = returned("江部電解", 2, "2026-10-07");
  const polished = returned("江部磨き", 2, "2026-10-07");
  electro.product = polished.product = "メニスカス鉗子";
  const summary = ui.polishingMonthlySummary([meniscus, electro, polished], {}, "2026-10");
  assert.equal(summary.quantity, 14, "両研磨先の数量を重複計上しない");
  assert.equal(summary.vendorTotals.find((row) => row.vendor === "江部").totalAmount, 14280);
  assert.equal(summary.vendorTotals.find((row) => row.vendor === "嘉代").quantity, 10);
  assert.equal(summary.vendorTotals.find((row) => row.vendor === "嘉代").totalAmount, 33000);
  assert.equal(summary.rows.find((row) => row.classCode === "B(メニスカス)").amount, 33000);
  assert.equal(summary.totalAmount, 47280);
});

test("旧加算の設定は集計に使わず、通常Bの保存済み単価とB(メニスカス)を分ける", () => {
  const {ui} = harness();
  const ordinary = returned("A", 3, "2026-10-07");
  ordinary.product = "鋭匙鉗子";
  ordinary.productMaster.material = "輪レバー / メニスカス部品";
  ordinary.productMaster.wheelLever = ordinary.productMaster.meniscus = true;
  const meniscus = returned("B(メニスカス)", 2, "2026-10-07");
  meniscus.product = "ﾒﾆｽｶｽ鉗子";
  const settings = {polishingRates:'{"2026-10":{"B":1900,"輪レバー":1500,"メニスカス":800}}'};
  const summary = ui.polishingMonthlySummary([ordinary, meniscus], settings, "2026-10");
  assert.equal(summary.rows.find(row => row.classCode === "A").amount, 6000);
  assert.equal(summary.rows.find(row => row.classCode === "B(メニスカス)").amount, 6600);
  assert.equal(summary.vendorTotals.find(row => row.vendor === "江部").totalAmount, 4200);
  assert.equal(summary.vendorTotals.find(row => row.vendor === "嘉代").totalAmount, 12600);
  assert.equal(summary.totalAmount, 16800);
  const prices = ui.polishingRatesForMonth(settings, "2026-10");
  assert.equal(prices.B, 1900);
  assert.equal(prices["B(メニスカス)"], 3300);
  assert.equal(Object.hasOwn(prices, "輪レバー"), false);
  assert.equal(Object.hasOwn(prices, "メニスカス"), false);
  assert.match(ui.polishingClassControl(meniscus), /自動判定（B\(メニスカス\)）/);
  assert.doesNotMatch(ui.polishingClassControl(ordinary), /data-polishing-meniscus|メニスカス加算/);
});

test("保存済み単価は維持し、B(メニスカス)の未設定と0を既定単価で上書きしない", () => {
  const { ui } = harness();
  const settings = {polishingRates: '{"2026-10":{"A":0,"江部":null,"B(メニスカス)":null}}'};
  const rates = ui.polishingRatesForMonth(settings, "2026-10");
  assert.equal(rates.A, 0);
  assert.equal(rates["江部"], null);
  assert.equal(rates["B(メニスカス)"], null);
  assert.equal(rates.D, 3500);
  const job = returned("B(メニスカス)", 2, "2026-10-07");
  const summary = ui.polishingMonthlySummary([job], settings, "2026-10");
  assert.equal(summary.missingQuantity, 2, "江部・嘉代の両方に未設定があっても実数量で数える");
  assert.equal(summary.totalAmount, null);
  const free = ui.polishingMonthlySummary([job], {polishingRates:'{"2026-10":{"B(メニスカス)":0}}'}, "2026-10");
  assert.equal(free.rows.find(row => row.classCode === "B(メニスカス)").amount, 0);
  assert.equal(free.totalAmount, 1680);
});

test("B(メニスカス)の区分変更を保存し、設定全体の編集前値で競合を防ぐ", async () => {
  const { ui } = harness();
  const rule = {classCode: "D", meniscus:true, updatedAt: "2026-10-01", product: "鉗子"};
  const job = {id: "J1", version: 3, product: "鉗子", productMaster: {key: "code:1", classCode: "D"}};
  ui.state.jobs = [job];
  ui.state.settings.polishingProductRules = JSON.stringify({"code:1":rule});
  let sent;
  ui.api.savePolishingProductRule = async (payload) => {
    sent = payload;
    return {jobs: [], settings: {polishingProductRules: JSON.stringify({"code:1":{classCode:payload.classCode}})}};
  };
  await ui.savePolishingClassification({dataset:{polishingClassId:"J1"},value:"B(メニスカス)"});
  assert.equal(sent.classCode, "B(メニスカス)");
  assert.equal(Object.hasOwn(sent, "meniscus"), false);
  assert.equal(sent.expectedRule.classCode, "D");
  assert.equal(sent.expectedRule.meniscus, true, "退役した項目も含め編集前の設定を確認する");
  assert.equal(sent.expectedRule.updatedAt, rule.updatedAt);
  assert.equal(JSON.parse(ui.state.settings.polishingProductRules)["code:1"].classCode, "B(メニスカス)");
  assert.equal(ui.state.polishingRulesSaving.size, 0);
});

test("区分の自動判定へのリセットと、江部の追加区分を選べる", async () => {
  const { ui } = harness();
  ui.state.jobs = [{id:"J2",version:1,product:"メニスカス鉗子",productMaster:{key:"code:2",classCode:"B(メニスカス)",source:"manual",material:"西端"}}];
  const rule = {classCode:"B(メニスカス)"};
  ui.state.settings.polishingProductRules = JSON.stringify({"code:2":rule});
  let sent;
  ui.api.savePolishingProductRule = async (payload) => {sent=payload; return {jobs:[],settings:{polishingProductRules:"{}"}};};
  const control = ui.polishingClassControl(ui.state.jobs[0]);
  assert.match(control, /value="江部電解"/);
  assert.match(control, /value="江部磨き"/);
  assert.match(control, /value="B\(メニスカス\)" selected/);
  assert.match(control, /自動判定に戻す/);
  assert.doesNotMatch(control, /メニスカス加算|data-polishing-meniscus/);
  await ui.savePolishingClassification({dataset:{polishingClassId:"J2"},value:""});
  assert.equal(sent.classCode, "");
  assert.equal(sent.expectedRule.classCode, "B(メニスカス)");
});

test("月別集計と単価編集にB(メニスカス)3300円を表示し、加算項目を表示しない", () => {
  const { ui, elements } = harness();
  ui.state.jobs = [returned("B(メニスカス)", 2, "2026-10-07")];
  ui.state.polishingBillingMonth = "2026-10";
  ui.renderPolishingBilling();
  const summary = elements.get("#polishing-billing-summary").innerHTML;
  assert.match(summary, /B\(メニスカス\)/);
  assert.match(summary, /¥3,300/);
  assert.match(summary, /¥8,280/);
  assert.doesNotMatch(summary, /メニスカス加算/);
  const fields = elements.get("#polishing-rate-fields").innerHTML;
  assert.match(fields, /data-polishing-rate="B\(メニスカス\)"[^>]*value="3300"/);
  assert.doesNotMatch(fields, /data-polishing-rate="メニスカス"|メニスカス加算/);
});


test("戻り取消は元の戻り月の研磨代から除外し、再返却した月だけに計上する", () => {
  const {ui}=harness();
  const job={productMaster:{classCode:"B(メニスカス)"},polishing:{sentQuantity:4,returnedQuantity:4,history:[
    {requestId:"send",action:"send",quantity:4,at:"2026-09-01T00:00:00Z"},
    {requestId:"return-sep",action:"return",quantity:4,at:"2026-09-30T14:59:00Z"},
    {requestId:"undo-oct",action:"undo-return",quantity:4,returnRequestId:"return-sep",at:"2026-10-08T00:00:00Z"},
    {requestId:"return-oct",action:"return",quantity:4,at:"2026-10-09T00:00:00Z"},
  ]}};
  const september=ui.polishingMonthlySummary([job],{},"2026-09");
  assert.equal(september.quantity,0);
  assert.equal(september.totalAmount,0);
  const october=ui.polishingMonthlySummary([job],{},"2026-10");
  assert.equal(october.quantity,4);
  assert.equal(october.vendorTotals.find(total=>total.vendor==="江部").totalAmount,3360);
  assert.equal(october.vendorTotals.find(total=>total.vendor==="嘉代").totalAmount,13200);
  assert.equal(october.totalAmount,16560);
});

const customReturned = (product, quantity, ebe, kayo, at = "2026-10-07") => ({...returned("自由設定", quantity, at), product, productMaster: {classCode:"自由設定", customRates:{"江部":ebe,"嘉代":kayo}}});

test("自由設定は研磨先・単価ごとに集計し、製品固有の単価に通常840円や嘉代の既定料金を重ねない", () => {
  const {ui} = harness();
  const jobs = [customReturned("特注甲",2,1000,5000),customReturned("特注乙",3,1200,6000),customReturned("特注丙",1,1000,5000),returned("B",1,"2026-10-08")];
  const summary = ui.polishingMonthlySummary(jobs, {polishingRates:'{"2026-10":{"江部":999}}'}, "2026-10");
  assert.equal(summary.quantity,7);
  assert.equal(summary.vendorTotals.find(row=>row.vendor==="江部").totalAmount,7599);
  assert.equal(summary.vendorTotals.find(row=>row.vendor==="嘉代").totalAmount,35500);
  assert.equal(summary.totalAmount,43099);
  const custom = summary.rows.filter(row=>row.classCode==="自由設定");
  assert.equal(custom.length,4);
  const shared = custom.find(row=>row.vendor==="江部" && row.unitPrice===1000);
  assert.equal(shared.quantity,3);
  assert.deepEqual(Array.from(shared.productNames),["特注甲","特注丙"]);
});

test("自由設定の空欄は未確定、0円は有効で両研磨先が未設定でも数量を重複しない", () => {
  const {ui} = harness();
  const summary = ui.polishingMonthlySummary([customReturned("無料",2,0,0),customReturned("片側未設定",3,null,1200),customReturned("両側未設定",1,null,null)],{},"2026-10");
  assert.equal(summary.quantity,6);
  assert.equal(summary.missingQuantity,4);
  assert.equal(summary.knownAmount,3600);
  assert.equal(summary.totalAmount,null);
  assert.equal(summary.rows.find(row=>row.classCode==="自由設定" && row.vendor==="江部" && row.unitPrice===0).amount,0);
  assert.equal(summary.vendorTotals.find(row=>row.vendor==="江部").missingQuantity,4);
  assert.equal(summary.vendorTotals.find(row=>row.vendor==="嘉代").missingQuantity,1);
});

test("月別表に未分類の固定欄を出さず、未設定の数量と計算済み金額は合計に残す", () => {
  const {ui,elements}=harness();
  ui.state.jobs=[returned("未分類",2,"2026-10-08"),customReturned("特注",1,1000,4000)];
  ui.state.polishingBillingMonth="2026-10";
  ui.renderPolishingBilling();
  const markup=elements.get("#polishing-billing-summary").innerHTML;
  assert.doesNotMatch(markup,/<th scope="row">未分類/);
  assert.match(markup,/要確認 2丁/);
  assert.match(markup,/計算済み ¥6,680/);
  assert.match(markup,/2026-10 の戻り 3丁/);
});

test("自由設定も日本の戻り月だけに集計し、取り消された戻りを除外する", () => {
  const {ui} = harness();
  const job=customReturned("月末特注",2,1100.25,4500,"2026-09-30T15:00:00Z");
  job.polishing.history[1].requestId="r1";
  job.polishing.history.push({action:"undo-return",returnRequestId:"r1",quantity:2,at:"2026-10-08"});
  job.polishing.history.push({action:"return",requestId:"r2",quantity:2,at:"2026-10-31T15:00:00Z"});
  assert.equal(ui.polishingMonthlySummary([job],{},"2026-10").totalAmount,0);
  assert.equal(ui.polishingMonthlySummary([job],{},"2026-11").totalAmount,11200.5);
});

test("自由設定の入力と月別明細は製品名をエスケープし、作業員と閲覧者には単価編集を許可しない", () => {
  const {ui,elements}=harness();
  const job={...customReturned('<img src=x onerror="evil">',2,1234,5000),id:'J"1',productMaster:{classCode:"自由設定",source:"manual",customRates:{"江部":1234,"嘉代":5000}}};
  assert.match(ui.polishingClassControl(job),/value="自由設定" selected/);
  assert.match(ui.polishingClassControl(job),/data-polishing-custom-vendor="江部"/);
  assert.doesNotMatch(ui.polishingClassControl(job),/<img/);
  assert.match(ui.polishingClassControl(job,true),/data-polishing-custom-id="J&quot;1"[^>]*disabled/);
  ui.state.jobs=[job];ui.state.polishingBillingMonth="2026-10";
  ui.renderPolishingBilling();
  assert.match(elements.get("#polishing-billing-summary").innerHTML,/¥12,468/);
  assert.match(elements.get("#polishing-billing-summary").innerHTML,/&lt;img/);
  for(const role of ["worker","viewer"]) {
    ui.state.access={role};
    const markup=ui.polishingClassControl(job);
    assert.doesNotMatch(markup,/data-polishing-custom-id|save-polishing-custom-rates|<input/);
    assert.match(markup,/江部 ¥1,234/);
  }
});

test("自由単価の保存は編集開始時の設定で競合を確認し、失敗時に入力を残す", async () => {
  const {ui}=harness();
  const rule={classCode:"自由設定",customRates:{"江部":1000,"嘉代":4000},updatedAt:"before"};
  const job={id:"custom1",version:3,product:"特注",productMaster:{key:"custom-key",classCode:"自由設定",source:"manual",customRates:rule.customRates}};
  ui.state.jobs=[job];ui.state.settings.polishingProductRules=JSON.stringify({"custom-key":rule});
  ui.editPolishingCustomRate({dataset:{polishingCustomId:job.id,polishingCustomVendor:"江部"},value:"0"});
  ui.editPolishingCustomRate({dataset:{polishingCustomId:job.id,polishingCustomVendor:"嘉代"},value:"4567.89"});
  ui.state.settings.polishingProductRules=JSON.stringify({"custom-key":{...rule,updatedAt:"changed"}});
  let sent;
  ui.api.savePolishingProductRule=async(payload)=>{sent=payload;throw new Error("別の端末で更新されています");};
  assert.equal(await ui.savePolishingCustomRates({dataset:{orderId:job.id}}),false);
  assert.equal(sent.customRates["江部"],0);
  assert.equal(sent.customRates["嘉代"],4567.89);
  assert.equal(sent.expectedRule.updatedAt,"before");
  assert.equal(ui.state.polishingCustomRateDrafts.get(job.id).values["嘉代"],"4567.89");
  assert.match(ui.polishingClassControl(job),/別の端末で更新/);
  ui.api.savePolishingProductRule=async(payload)=>({jobs:[{...job,productMaster:{...job.productMaster,customRates:payload.customRates}}],settings:{polishingProductRules:JSON.stringify({"custom-key":{...rule,customRates:payload.customRates}})}});
  assert.equal(await ui.savePolishingCustomRates({dataset:{orderId:job.id}}),true);
  assert.equal(ui.state.polishingCustomRateDrafts.has(job.id),false);
  assert.equal(ui.state.jobs[0].productMaster.customRates["嘉代"],4567.89);
});

test("自由単価は不正値や製品の変更を保存せず、入力を戻すと最新の保存値で再編集できる", async () => {
  const {ui}=harness();
  const job={id:"J1",version:1,product:"特注",productMaster:{key:"key1",classCode:"自由設定",customRates:{"江部":840,"嘉代":null}}};
  ui.state.jobs=[job];ui.state.settings.polishingProductRules='{"key1":{"classCode":"自由設定"}}';
  let saves=0;ui.api.savePolishingProductRule=async()=>{saves++;};
  for (const value of ["-1","1.234","1000001","1e3"]) {
    ui.editPolishingCustomRate({dataset:{polishingCustomId:"J1",polishingCustomVendor:"江部"},value});
    await ui.savePolishingCustomRates({dataset:{orderId:"J1"}});
  }
  assert.equal(saves,0);
  ui.editPolishingCustomRate({dataset:{polishingCustomId:"J1",polishingCustomVendor:"江部"},value:"1000"});
  job.productMaster.key="changed-key";
  await ui.savePolishingCustomRates({dataset:{orderId:"J1"}});
  assert.equal(saves,0);
  assert.match(ui.state.polishingCustomRateDrafts.get("J1").error,/製品情報が変更/);
  ui.resetPolishingCustomRates("J1");
  assert.equal(ui.state.polishingCustomRateDrafts.size,0);
  assert.match(ui.polishingClassControl(job),/value="840"/);
  for(const invalid of [null,[],{"外部":1},{"江部":true},{"嘉代":NaN}]) assert.throws(()=>ui.normalizeCustomPolishingRates(invalid));
});
