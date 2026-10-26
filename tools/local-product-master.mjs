import { readFile } from "node:fs/promises";
import vm from "node:vm";

let runtime;
async function getRuntime() {
  if (!runtime) runtime = Promise.all(["Config.gs", "Parser.gs", "ProductMaster.gs"].map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"))).then((sources) => {
    const context = vm.createContext({ Date, Number, String, Math, JSON, Object, Array, RegExp, isFinite });
    vm.runInContext(sources.join("\n"), context);
    return context;
  });
  return runtime;
}

export async function localProductMetadata(input) {
  if (!input || !Array.isArray(input.jobs) || input.jobs.length > 10000) throw new Error("案件の形式が不正です。");
  const context = await getRuntime();
  const settings = { ...input.settings };
  let labelRule;
  if (input.labelRuleRequest) {
    context.readSettings_ = () => settings;
    labelRule = context.prepareProductLabelRule_(input.labelRuleRequest, input.jobs[0], input.existingJob || null);
    if (labelRule) settings.productLabelRules = labelRule.value;
  }
  return { jobs: context.decorateProductJobs_(input.jobs, settings), productMasterStatus: context.getProductMasterStatus_(), ...(labelRule ? {productLabelRules:labelRule.value,labelRuleChanged:labelRule.changed} : {}) };
}
