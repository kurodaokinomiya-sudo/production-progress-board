import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const read = (relative) => readFile(path.join(root, relative), "utf8");

await mkdir(dist, { recursive: true });

const [htmlSource, tokens, stylesSource, script, intakeDuplicates, intakeLearning, finishedStock, finishedStockOrders, finishedStockUi, materials, materialsUi, accessSession, accessBootstrap, pdfJsSource, pdfWorkerSource] = await Promise.all([
  read("src/index.html"),
  read("tokens.css"),
  read("src/styles.css"),
  read("src/app.js"),
  read("src/intake-duplicates.js"),
  read("src/intake-learning.js"),
  read("src/finished-stock.js"),
  read("src/finished-stock-orders.js"),
  read("src/finished-stock-ui.js"),
  read("src/materials.js"),
  read("src/materials-ui.js"),
  read("src/access-session.js"),
  read("src/access-bootstrap.js"),
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
  .replace('<script src="intake-duplicates.js" defer data-inline="intake-duplicates"></script>', () => `<script data-bundle="intake-duplicates">\n${intakeDuplicates}\n</script>`)
  .replace('<script src="intake-learning.js" defer data-inline="intake-learning"></script>', () => `<script data-bundle="intake-learning">\n${intakeLearning}\n</script>`)
  .replace('<script src="materials.js" defer data-inline="materials"></script>', () => `<script data-bundle="materials">\n${materials}\n</script>`)
  .replace('<script src="finished-stock.js" defer data-inline="finished-stock"></script>', () => `<script data-bundle="finished-stock">\n${finishedStock}\n</script>`)
  .replace('<script src="finished-stock-orders.js" defer data-inline="finished-stock-orders"></script>', () => `<script data-bundle="finished-stock-orders">\n${finishedStockOrders}\n</script>`)
  .replace('<script src="finished-stock-ui.js" defer data-inline="finished-stock-ui"></script>', () => `<script data-bundle="finished-stock-ui">\n${finishedStockUi}\n</script>`)
  .replace('<script src="materials-ui.js" defer data-inline="materials-ui"></script>', () => `<script data-bundle="materials-ui">\n${materialsUi}\n</script>`)
  .replace('<script src="access-session.js" defer data-inline="access-session"></script>', () => `<script data-bundle="access-session">\n${accessSession}\n</script>`)
  .replace(
    '<script src="app.js" defer data-inline="script"></script>',
    () => `${pdfJsBootstrap}\n<script data-bundle="app">\n${script}\n</script>`,
  );

await writeFile(path.join(dist, "Index.html"), html, "utf8");

const [accessHtml, accessStyles, accessScript] = await Promise.all([
  read("src/access.html"), read("src/access.css"), read("src/access.js"),
]);
const accessBundle = accessHtml
  .replace('<link rel="stylesheet" href="../tokens.css" data-inline="tokens">', () => `<style>${tokens}</style>`)
  .replace('<link rel="stylesheet" href="access.css" data-inline="styles" data-access-shell>', () => `<style data-access-shell>${accessStyles}</style>`)
  .replace('<script src="access-session.js" defer data-inline="access-session"></script>', () => `<script data-bundle="access-session">\n${accessSession}\n</script>`)
  .replace('<script src="access-bootstrap.js" defer data-inline="access-bootstrap"></script>', () => `<script data-bundle="access-bootstrap">\n${accessBootstrap}\n</script>`)
  .replace('<script src="access.js" defer data-inline="script"></script>', () => `<script>${accessScript}</script>`);
await writeFile(path.join(dist, "Access.html"), accessBundle, "utf8");

const backendDir = path.join(root, "apps-script");
const backendFiles = (await readdir(backendDir)).filter((name) => name.endsWith(".gs") || name === "appsscript.json");
await Promise.all(backendFiles.map(async (name) => {
  await writeFile(path.join(dist, name), await readFile(path.join(backendDir, name), "utf8"), "utf8");
}));
await writeFile(path.join(dist, "IntakeDuplicates.gs"), intakeDuplicates, "utf8");
await writeFile(path.join(dist, "IntakeLearningLogic.gs"), intakeLearning, "utf8");
await writeFile(path.join(dist, "MaterialLogic.gs"), materials, "utf8");
await writeFile(path.join(dist, "FinishedStockLogic.gs"), `${finishedStockOrders}\n${finishedStock}`, "utf8");

console.log(`Apps Script bundle: dist/Index.html + dist/Access.html + ${backendFiles.length + 4} backend files`);
