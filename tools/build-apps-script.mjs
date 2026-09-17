import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const read = (relative) => readFile(path.join(root, relative), "utf8");

await mkdir(dist, { recursive: true });

const [htmlSource, tokens, stylesSource, script, pdfJsSource, pdfWorkerSource] = await Promise.all([
  read("src/index.html"),
  read("tokens.css"),
  read("src/styles.css"),
  read("src/app.js"),
  read("node_modules/pdfjs-dist/build/pdf.min.mjs"),
  read("node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
]);

const styles = stylesSource.replace('@import url("../tokens.css");', "");
const pdfWorkerBase64 = Buffer.from(pdfWorkerSource, "utf8").toString("base64");
const pdfJsBootstrap = `<script type="module" data-bundle="pdfjs">
const bundledPdfWorkerBytes = Uint8Array.from(atob("${pdfWorkerBase64}"), (character) => character.charCodeAt(0));
const bundledPdfWorkerSource = new TextDecoder().decode(bundledPdfWorkerBytes);
${pdfJsSource}
globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([bundledPdfWorkerSource], { type: "text/javascript" }));
globalThis.dispatchEvent(new Event("pdfjs-ready"));
</script>`;
const html = htmlSource
  .replace('<link rel="stylesheet" href="../tokens.css" data-inline="tokens">', `<style data-bundle="tokens">\n${tokens}\n</style>`)
  .replace('<link rel="stylesheet" href="styles.css" data-inline="styles">', `<style data-bundle="styles">\n${styles}\n</style>`)
  .replace(
    '<script src="app.js" defer data-inline="script"></script>',
    () => `${pdfJsBootstrap}\n<script data-bundle="app">\n${script}\n</script>`,
  );

await writeFile(path.join(dist, "Index.html"), html, "utf8");

const backendDir = path.join(root, "apps-script");
const backendFiles = (await readdir(backendDir)).filter((name) => name.endsWith(".gs") || name === "appsscript.json");
await Promise.all(backendFiles.map(async (name) => {
  await writeFile(path.join(dist, name), await readFile(path.join(backendDir, name), "utf8"), "utf8");
}));

console.log(`Apps Script bundle: dist/Index.html + ${backendFiles.length} backend files`);
