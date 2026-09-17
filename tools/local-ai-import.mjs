import { readFile } from "node:fs/promises";
import vm from "node:vm";

const MODEL = "gemini-3.1-flash-lite";
let usage = { day: "", count: 0, last: 0 };

export function localAiStatus() {
  return { configured: Boolean(process.env.PROGRESS_GEMINI_API_KEY), ready: Boolean(process.env.PROGRESS_GEMINI_API_KEY) && process.env.PROGRESS_AI_FREE_TIER_CONFIRMED === "true", model: MODEL };
}

export async function parseLocalOrderAi(input, { transport = fetch } = {}) {
  const { context, decoded, customerRules } = await sendLocalAi(input, { transport });
  const results = context.validateAiImportResponse_(decoded, customerRules);
  return { engineVersion: 2, engine: "ai", text: "AIによる読取候補です。原本を別途開き、全明細と数量を照合してください。", results: JSON.parse(JSON.stringify(results)) };
}

export async function diagnoseLocalAi(input, { transport = fetch } = {}) {
  const { context, decoded } = await sendLocalAi({}, { transport, step: input?.step, diagnostic: true });
  const result = { step: input.step, model: MODEL, accepted: true };
  if (input.step === "format") {
    try { context.validateAiImportResponse_(decoded); result.outputValid = true; }
    catch { result.outputValid = false; result.message = "HTTP 200で回答形式は受理されましたが、テスト回答はアプリの内容検証を通りませんでした。"; }
  }
  return result;
}

async function sendLocalAi(input, { transport, step, diagnostic = false }) {
  if (!localAiStatus().ready) throw new Error("ローカルAIは未設定です。サーバーの環境変数に無料プロジェクトのAPIキーと無料枠確認を設定してください。");
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, JSON });
  const [parser, ai] = await Promise.all(["Parser.gs", "AiImport.gs"].map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")));
  vm.runInContext(`${parser}\n${ai}`, context);
  const customerRules = diagnostic ? undefined : context.normalizeCustomerRules_(input.customerRules || context.defaultCustomerRules_());
  const request = diagnostic ? context.aiDiagnosticRequest_(step) : context.aiImportRequest_(input, customerRules);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (usage.day !== day) usage = { day, count: 0, last: 0 };
  const limit = Math.min(100, Math.max(1, Number(process.env.PROGRESS_AI_DAILY_LIMIT) || 10));
  if (usage.count >= limit) throw new Error("ローカルAIの日次上限に達しました。AI取込を停止します。");
  if (Date.now() - usage.last < 10000) throw new Error("AI取込は10秒以上あけて実行してください。");
  usage.count += 1;
  usage.last = Date.now();
  let response;
  try {
    response = await transport(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.PROGRESS_GEMINI_API_KEY },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60000)
    });
  } catch { throw new Error("AIへ接続できませんでした。自動再試行はしません。候補は登録していません。"); }
  if (!response.ok) throw new Error(context.aiImportError_(response.status, await response.text(), [process.env.PROGRESS_GEMINI_API_KEY, input?.text, input?.name]));
  let decoded;
  try { decoded = await response.json(); } catch { throw new Error("AIの応答が不正です。"); }
  return { context, decoded, customerRules };
}
