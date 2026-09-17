import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const parserPath = fileURLToPath(new URL("../apps-script/Parser.gs", import.meta.url));
export const LOCAL_PDF_ENGINE_VERSION = 2;

async function loadParserContext() {
  const parserSource = await readFile(parserPath, "utf8");
  const parserContext = vm.createContext({ Date, Math, Number, Object, RegExp, String });
  vm.runInContext(parserSource, parserContext);
  return parserContext;
}

export async function extractPdfText(buffer) {
  const bytes = new Uint8Array(buffer);
  const loadingTask = getDocument({ data: bytes });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join("\n"));
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages.join("\n\n").trim();
}

export async function parseLocalOrderPdf(buffer, context = {}) {
  const text = await extractPdfText(buffer);
  if (!text) throw new Error("PDFから文字を検出できませんでした。画像だけのPDFはApps Script版のOCRで確認してください。");
  const parserContext = await loadParserContext();
  const results = parserContext.parseOrderItems_(text, context);
  return { engineVersion: LOCAL_PDF_ENGINE_VERSION, text, results: JSON.parse(JSON.stringify(results)) };
}
