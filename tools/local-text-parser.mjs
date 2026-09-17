import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseLocalOrderAi } from "./local-ai-import.mjs";

export const LOCAL_TEXT_ENGINE_VERSION = 2;
export const LOCAL_TEXT_MAX_LENGTH = 30000;
export const LOCAL_TEXT_NAME_MAX_LENGTH = 200;

const parserPath = new URL("../apps-script/Parser.gs", import.meta.url);
const importPath = new URL("../apps-script/Import.gs", import.meta.url);

export function validateLocalOrderTextInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("入力形式が不正です。");
  if (typeof input.text !== "string") throw new Error("本文は文字列で指定してください。");
  if (!input.text.trim()) throw new Error("本文を入力してください。");
  if (input.text.length > LOCAL_TEXT_MAX_LENGTH) throw new Error(`本文は${LOCAL_TEXT_MAX_LENGTH}文字以下にしてください。`);

  const name = input.name === undefined || input.name === null ? "" : input.name;
  if (typeof name !== "string") throw new Error("名前は文字列で指定してください。");
  if (name.length > LOCAL_TEXT_NAME_MAX_LENGTH) throw new Error(`名前は${LOCAL_TEXT_NAME_MAX_LENGTH}文字以下にしてください。`);

  const engine = input.engine === undefined ? "legacy" : input.engine;
  if (engine !== "legacy" && engine !== "ai") throw new Error("読取エンジンが不正です。従来の読取またはAIを選択してください。");
  return { name: name.trim(), text: input.text, engine };
}

async function loadTextParserContext() {
  const [parserSource, importSource] = await Promise.all([
    readFile(parserPath, "utf8"),
    readFile(importPath, "utf8"),
  ]);
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, JSON });
  vm.runInContext(`${parserSource}\n${importSource}`, context);
  return context;
}

/**
 * Parse pasted order text with the same Parser.gs/Import.gs contract used by
 * Apps Script. AI is injected as a dependency so tests never need a network
 * call; production uses the existing local AI adapter by default.
 */
export async function parseLocalOrderText(input, { aiParser = parseLocalOrderAi } = {}) {
  const normalized = validateLocalOrderTextInput(input);
  let results;
  if (normalized.engine === "ai") {
    const parsed = await aiParser({ name: normalized.name, text: normalized.text, ...(input.customerRules ? { customerRules: input.customerRules } : {}) });
    if (!parsed || !Array.isArray(parsed.results)) throw new Error("AIの応答が不正です。候補は登録していません。");
    results = parsed.results;
  } else {
    const parserContext = await loadTextParserContext();
    results = parserContext.parsePastedOrderItems_(normalized.text, { subject: normalized.name });
  }
  return {
    engineVersion: LOCAL_TEXT_ENGINE_VERSION,
    text: normalized.text,
    results: JSON.parse(JSON.stringify(results)),
  };
}
