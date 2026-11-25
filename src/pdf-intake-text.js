(function (root) {
  "use strict";

  // Content outside these text and graphics-state operators needs a reader
  // that sees the whole rendered document, including images and outlines.
  const TEXT_OPERATORS = [
    "dependency", "save", "restore", "transform",
    "beginText", "endText", "setFont", "setCharSpacing", "setWordSpacing", "setHScale",
    "setLeading", "setTextRise", "moveText", "setLeadingMoveText", "setTextMatrix",
    "nextLine", "showText", "showSpacedText", "nextLineShowText", "nextLineSetSpacingShowText",
    "setFillGray", "setFillRGBColor", "setFillCMYKColor",
    "setStrokeGray", "setStrokeRGBColor", "setStrokeCMYKColor",
  ];

  async function extractComplete(pdfjs, data) {
    const allowed = new Set(TEXT_OPERATORS.map((name) => pdfjs.OPS[name]).filter(Number.isInteger));
    const loading = pdfjs.getDocument({ data, stopAtErrors: true });
    try {
      const pdf = await loading.promise;
      if (pdf.isPureXfa || await pdf.hasJSActions()) return null;
      const pages = [];
      let length = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => item.str || "").join("\n").trim();
        if (!text || text.includes("\uFFFD")) return null;
        const { fnArray } = await page.getOperatorList();
        if (!fnArray.every((op) => allowed.has(op))) return null;
        length += text.length + (pages.length ? 2 : 0);
        if (length > 200000) return null;
        pages.push(text);
      }
      return pages.length ? { pageCount: pdf.numPages, pages } : null;
    } finally {
      await loading.destroy();
    }
  }

  root.PdfIntakeText = { extractComplete };
})(globalThis);
