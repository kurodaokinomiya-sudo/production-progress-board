// Minimal PDF fixture with a Unicode text map and an optional embedded image.
export function makeOrderPdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const add = (body) => objects.push(body);
  const stream = (content, dictionary = "") =>
    `<< /Length ${content.length} ${dictionary} >>\nstream\n${content}\nendstream`;
  const mappings = [];
  const items = pages.map(({ lines = [], image = false, outlines = false }) => ({
    image, outlines, glyphs: lines.map((line) => {
      const glyph = (65 + mappings.length).toString(16).padStart(2, "0");
      const unicode = line.split("").map(character => character.charCodeAt(0).toString(16).padStart(4, "0")).join("");
      mappings.push(`<${glyph}> <${unicode}>`);
      return glyph;
    }),
  }));
  const cmap = add(stream(`begincmap
/CMapName /OrderFixture def
/CMapType 2 def
1 begincodespacerange
<00> <ff>
endcodespacerange
${mappings.length} beginbfchar
${mappings.join("\n")}
endbfchar
endcmap`));
  const font = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${cmap} 0 R >>`);
  const imageId = add(stream("003C3C00003C3C00>", "/Type /XObject /Subtype /Image /Width 4 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode"));
  const pageIds = items.map(({ image, outlines, glyphs }) => {
    const content = [];
    if (glyphs.length) content.push("BT /F1 12 Tf 40 740 Td", ...glyphs.map(glyph => `<${glyph}> Tj 0 -22 Td`), "ET");
    if (image) content.push("q 300 0 0 150 40 400 cm /I1 Do Q");
    if (outlines) content.push("40 400 300 150 re f");
    const contentsId = add(stream(content.join("\n")));
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentsId} 0 R /Resources << /Font << /F1 ${font} 0 R >> /XObject << /I1 ${imageId} 0 R >> >> >>`);
  });
  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`;
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  return Buffer.from(`${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`, "ascii");
}
