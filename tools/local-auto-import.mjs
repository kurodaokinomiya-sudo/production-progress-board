import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import "../src/pdf-intake-text.js";
import { parseLocalOrderAi } from "./local-ai-import.mjs";

const scriptNames = ["Parser.gs", "Import.gs", "AiImport.gs"];

async function loadRememberedParser() {
  const [learning, ...scripts] = await Promise.all([
    readFile(new URL("../src/intake-learning.js", import.meta.url), "utf8"),
    ...scriptNames.map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")),
  ]);
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, JSON, Array });
  vm.runInContext(`${learning}\n${scripts.join("\n")}`, context);
  return context;
}

/**
 * Apply the Apps Script remembered-product preflight to known text. A null
 * parse means the whole input is unresolved and should receive one AI call.
 */
export async function parseRememberedOrderAutomatically(input, { aiParser = parseLocalOrderAi } = {}) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  let text = input?.mimeType === "text/plain" && typeof input.text === "string" ? input.text : "";
  if (input?.mimeType !== "text/plain") {
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(input?.mimeType) ||
        typeof input.base64 !== "string" || !input.base64 || input.base64.length > 8 * 1024 * 1024 * 4 / 3 + 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length % 4 !== 0) throw new Error("PDF・JPEG・PNG・WebP（8 MB以下）を選択してください。");
  }
  if (input?.mimeType === "application/pdf") {
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("PDFは8 MB以下にしてください。");
    if (input.learningRules?.length) {
      try {
        const extraction = await globalThis.PdfIntakeText.extractComplete(pdfjs, new Uint8Array(bytes));
        if (extraction) text = extraction.pages.join("\n\n");
      } catch { /* Keep the original PDF for AI. */ }
    }
  }

  let results = null;
  if (text && Array.isArray(input?.learningRules) && input.learningRules.length) {
    try {
      const context = await loadRememberedParser();
      results = context.parseRememberedOrderItems_(text, { subject: name }, input.learningRules, input.customerRules);
      if (results) results = JSON.parse(JSON.stringify(results));
    } catch {
      results = null;
    }
  }
  if (results?.length) {
    return { engineVersion: 2, engine: "memory", text, results };
  }

  const aiInput = { ...input, name };
  delete aiInput.pdfText;
  if (input.mimeType !== "text/plain") delete aiInput.text;
  else aiInput.text = text;
  const ai = await aiParser(aiInput);
  if (!ai || !Array.isArray(ai.results) || !ai.results.length) throw new Error("AIの応答が不正です。候補は登録していません。");
  return { engineVersion: 2, engine: "ai", text: text || ai.text || "AIによる読取候補です。原本を別途開き、全明細と数量を照合してください。", results: ai.results };
}
