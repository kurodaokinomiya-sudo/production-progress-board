import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import {localProductMetadata} from "../tools/local-product-master.mjs";

const source=await readFile(new URL("../src/app.js",import.meta.url),"utf8");
function harness(){
  const storage=new Map();
  const context=vm.createContext({Date,Intl,Math,Number,Object,String,Array,RegExp,Set,Map,JSON,URL,structuredClone,setTimeout,clearTimeout,
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},window:{},document:{querySelector(){},querySelectorAll:()=>[]},
    fetch:async(url,request)=>({ok:true,json:async()=>url==="/api/local/product-metadata"?localProductMetadata(JSON.parse(request.body)):{} }),
  });
  vm.runInContext(source.slice(0,source.indexOf("async function init()"))+"\nglobalThis.ui={api,productDisplayName,labelTitle};",context);
  return context.ui;
}

test("local saving and reload retain a material correction and apply it to a subsequent matching product",async()=>{
  const ui=harness();
  const base={customer:"田中",product:"鋭匙鉗子/マイクロ",productCode:"06-58-20",specLength:"16.5cm",specShape:"直",bladeWidth:"2mm",quantity:1,labelPrintStatus:"waiting"};
  const saved=await ui.api.saveJob({...base,productLabelRule:{mode:"manual",keywords:["ｱﾘｼﾞ","ｳｽｲ"],expectedRules:{}}});
  assert.equal(ui.productDisplayName(saved),"鋭匙鉗子/マイクロ ｱﾘｼﾞ・ｳｽｲ");
  const next=await ui.api.saveJob({...base,serialNo:"NEXT"});
  assert.equal(ui.productDisplayName(next),ui.productDisplayName(saved));
  const snapshot=await ui.api.getSnapshot();
  const reloaded=snapshot.jobs.find(job=>job.id===saved.id);
  assert.equal(ui.labelTitle(reloaded),"鋭匙鉗子/マイクロ ｱﾘｼﾞ・ｳｽｲ 直");
  const currentRules=JSON.parse(snapshot.settings.productLabelRules);
  await assert.rejects(ui.api.saveJob({...reloaded,productLabelRule:{mode:"manual",keywords:["白銅"],expectedRules:{}}}),/別の端末/);
  const reset=await ui.api.saveJob({...reloaded,productLabelRule:{mode:"auto",expectedRules:currentRules}});
  assert.equal(ui.productDisplayName(reset),"鋭匙鉗子/マイクロ ｱﾘｼﾞ");
});
