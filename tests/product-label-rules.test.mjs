import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await Promise.all(["Config.gs","Parser.gs","Repository.gs","ProductMaster.gs"].map((file) => readFile(new URL(`../apps-script/${file}`,import.meta.url),"utf8")))).join("\n");
const master = [{productCode:"06-01-01",product:"鋭匙鉗子 ｱﾘｼﾞ",customer:"田中医科",shape:"直",bladeWidth:"3mm",specLength:"210",material:"西端"}];

function harness() {
  let settings = {}, role = "editor";
  const records = [], writes = [];
  const ctx = vm.createContext({Date,Math,Number,Object,String,Array,JSON,RegExp,
    Utilities:{getUuid:()=>`NEW-${records.length}`},SpreadsheetApp:{flush(){}},
    requireEditorAccess_(){if (role!=="editor") throw new Error("EDITOR_REQUIRED");},
    ensureSystem_(){},withDocumentLock_:fn=>fn(),appendLog_(){},
  });
  vm.runInContext(source,ctx);
  const sheet = {getLastRow:()=>records.length+1,getRange:(row)=>({setValues(values){
    writes.push(row);
    records[row-2] = Object.fromEntries(ctx.APP.JOB_HEADERS.map((key,i)=>[key,values[0][i]]));
    records[row-2]._rowNumber=row;
  }})};
  Object.assign(ctx,{getSpreadsheet_:()=>({getSheetByName:()=>sheet}),readRows_:()=>records,
    ensureSystem_(){},withDocumentLock_:fn=>fn(),appendLog_(){},
    readSettings_:()=>({...settings}),writeProductSetting_:(key,value)=>{settings[key]=value;},
    loadProductMaster_:()=>master,
  });
  const job = ctx.normalizeJobInput_({id:"J1",customer:"田中",productCode:"06-01-01",product:"鋭匙鉗子",quantity:2,specShape:"直",bladeWidth:"3mm",specLength:"21cm",labelPrintStatus:"printed"},null);
  job.version=3;
  sheet.getRange(2).setValues([ctx.jobToRow_(job)]); writes.length=0;
  return {ctx,writes,job:()=>ctx.readJobs_()[0],settings:()=>settings,setRules:value=>{settings.productLabelRules=JSON.stringify(value);},setRole:value=>{role=value;}};
}

test("慈大式 is C and full/half-width Y and T Kerrison names are D, including code-matched jobs",()=>{
  const {ctx}=harness();
  for (const name of ["慈大式鋭匙鉗子","Yｹﾘｿﾝﾊﾟﾝﾁ","Ｔ ｹﾘｿﾝﾊﾟﾝﾁ","Yケリソン","Tケリソン"]) {
    const expected=name.includes("慈大式")?"C":"D";
    assert.equal(ctx.decorateProductJobs_([{product:name,productCode:"06-01-01",customer:"田中"}],{})[0].productMaster.classCode,expected);
    assert.equal(ctx.classifyDirectProductName_(name).classCode,expected);
  }
  assert.equal(ctx.classifyProduct_("倍力 慈大式 Yｹﾘｿﾝ",["西端"]).classCode,"特殊");
  assert.equal(ctx.classifyProduct_("慈大式",["西端"]).classCode,"C");
});

test("editing material display persists for the next same-code/customer product and queues the edited printed label",()=>{
  const h=harness();
  const saved=h.ctx.saveJob({...h.job(),productLabelRule:{mode:"manual",keywords:["ウスイ"],expectedRules:{}}});
  assert.deepEqual([...saved.productMaster.labelKeywords],["ｳｽｲ"]);
  assert.equal(saved.productMaster.labelKeywordSource,"manual");
  assert.equal(saved.labelPrintStatus,"reprint");
  const future=h.ctx.decorateProductJobs_([{productCode:"06-01-01",product:"鋭匙鉗子",customer:"株式会社田中医科器械製作所"}],h.settings())[0];
  assert.deepEqual([...future.productMaster.labelKeywords],["ｳｽｲ"]);
  const other=h.ctx.decorateProductJobs_([{productCode:"06-01-01",product:"鋭匙鉗子",customer:"他社"}],h.settings())[0];
  assert.notEqual(other.productMaster.labelKeywordSource,"manual");
});

test("material corrections reject stale settings before writing orders; unrelated order saves retain them",()=>{
  const h=harness();
  const saved=h.ctx.saveJob({...h.job(),productLabelRule:{mode:"manual",keywords:["白銅"],expectedRules:{}}});
  h.writes.length=0;
  assert.throws(()=>h.ctx.saveJob({...saved,productLabelRule:{mode:"manual",keywords:["ｱﾘｼﾞ"],expectedRules:{}}}),/別の端末/);
  assert.equal(h.writes.length,0);
  const unchanged=h.ctx.saveJob({...h.job(),note:"通常の編集"});
  assert.deepEqual([...unchanged.productMaster.labelKeywords],["白銅"]);
  h.setRole("worker");
  assert.throws(()=>h.ctx.saveJob({...h.job(),productLabelRule:{mode:"auto",expectedRules:{}}}),/EDITOR_REQUIRED/);
});

test("clearing a manual display restores master keywords and unsupported input cannot write",()=>{
  const h=harness();
  h.ctx.saveJob({...h.job(),productLabelRule:{mode:"manual",keywords:["白銅"],expectedRules:{}}});
  const reset=h.ctx.saveJob({...h.job(),productLabelRule:{mode:"auto",expectedRules:JSON.parse(h.settings().productLabelRules)}});
  assert.equal(reset.productMaster.labelKeywordSource,"master");
  assert.deepEqual([...reset.productMaster.labelKeywords],["ｱﾘｼﾞ"]);
  h.writes.length=0;
  assert.throws(()=>h.ctx.saveJob({...h.job(),productLabelRule:{mode:"manual",keywords:["別の文字"],expectedRules:{}}}),/材料表示/);
  assert.equal(h.writes.length,0);
});

test("keywords entered in a name teach missing rules without replacing an existing correction on import",()=>{
  const h=harness();
  const saved=h.ctx.saveJob({...h.job(),product:"鋭匙鉗子 白銅"});
  assert.deepEqual([...saved.productMaster.labelKeywords],["白銅"]);
  const imported=h.ctx.saveJob({customer:"田中",productCode:"06-01-01",product:"鋭匙鉗子 ｱﾘｼﾞ",quantity:1});
  assert.deepEqual([...imported.productMaster.labelKeywords],["白銅"]);
});

test("legacy Tanaka suffixes match the master and share future correction keys without changing stored names",()=>{
  const h=harness();
  const old={customer:"田中",product:"鋭匙鉗子:JS07-040-4S-J TM対象",specShape:"直",bladeWidth:"3mm",specLength:"21cm"};
  const [before,after]=h.ctx.decorateProductJobs_([old,{...old,product:"鋭匙鉗子",productCode:"06-01-01"}],{});
  assert.equal(before.productMaster.status,"matched");
  assert.equal(before.productMaster.displayProduct,"鋭匙鉗子");
  assert.equal(before.productMaster.key,after.productMaster.key);
  assert.equal(before.product,"鋭匙鉗子:JS07-040-4S-J TM対象");
});
