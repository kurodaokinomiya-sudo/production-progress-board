const STAGES = [
  { key: "welding", label: "溶接", short: "溶" },
  { key: "base", label: "元作り", short: "元" },
  { key: "grinding", label: "浮き止め～立ち上がり", short: "浮" },
  { key: "heat", label: "厚みとり", short: "厚" },
  { key: "finish", label: "仕上げ", short: "仕" },
];

const ASSIGNEES = ["豊", "幹", "望", "鈴", "河", "誠", "小", "保", "大", "順"];

const CATEGORY_OPTIONS = ["鋭匙鉗子", "ケリソンパンチ"];
const CATEGORY_SORT_ORDER = Object.fromEntries(CATEGORY_OPTIONS.map((name, index) => [name, index]));
const NATURAL_COLLATOR = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

const THEME_STORAGE_KEY = "production-board-theme";
const THEME_OPTIONS = ["auto", "light", "dark"];
const BUSINESS_TIME_ZONE = "Asia/Tokyo";
const LABEL_PRINT_LIMIT = 9;
const LABEL_PRINT_STATUSES = ["waiting", "reprint", "printed", "not_required"];
const LOCAL_PDF_ENGINE_VERSION = 2;

const STATUS_OPTIONS = [
  { value: "not_started", label: "未着手" },
  { value: "working", label: "進行中" },
  { value: "done", label: "完了" },
  { value: "hold", label: "保留" },
];

const state = {
  jobs: [],
  intake: [],
  settings: {},
  mode: "loading",
  aiImport: { ready: false, configured: false },
  scriptEditorUrl: "",
  lastSync: null,
  selectedFile: null,
  aiDiagnosticRunning: false,
  textImportRunning: false,
  labelPrintSelection: new Set(),
  labelPrintQuery: "",
  labelPrintFilter: "queue",
  labelPrintPendingConfirmation: [],
  labelPrintConfirmationVisible: false,
  activeView: "dashboard",
  theme: readStoredTheme(),
  filters: {
    dashboard: { query: "", stage: "all", sort: "priority" },
    orders: { query: "", stage: "all", attention: "all", sort: "priority" },
    completed: { query: "", stage: "all", period: "current", sort: "updated" },
  },
};

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

class AppsScriptApi {
  call(method, payload = {}) {
    return new Promise((resolve, reject) => {
      window.google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler((error) => reject(new Error(error?.message || String(error))))
        [method](payload);
    });
  }

  getSnapshot(payload) { return this.call("getSnapshot", payload); }
  saveJob(payload) { return this.call("saveJob", payload); }
  setJobArchived(payload) { return this.call("setJobArchived", payload); }
  createIntakeFromImage(payload) { return this.call("createIntakeFromImage", payload); }
  createIntakeFromPdfText(payload) { return this.call("createIntakeFromPdfText", payload); }
  createIntakeFromText(payload) { return this.call("createIntakeFromText", payload); }
  createIntakeWithAi(payload) { return this.call("createIntakeWithAi", payload); }
  runAiDiagnosticStep(payload) { return this.call("runAiDiagnosticStep", payload); }
  scanOrderEmails(payload) { return this.call("scanOrderEmails", payload); }
  approveIntake(payload) { return this.call("approveIntake", payload); }
  approveIntakes(payload) { return this.call("approveIntakes", payload); }
  markLabelsPrinted(payload) { return this.call("markLabelsPrinted", payload); }
  rejectIntake(payload) { return this.call("rejectIntake", payload); }
  rejectIntakes(payload) { return this.call("rejectIntakes", payload); }
  saveSettings(payload) { return this.call("saveSettings", payload); }
  getCustomerRules() { return this.call("getCustomerRules"); }
  saveCustomerRules(payload) { return this.call("saveCustomerRules", payload); }
  migrateLegacySheet(payload) { return this.call("migrateLegacySheet", payload); }
}

class MockApi {
  async runAiDiagnosticStep(payload) {
    const response = await fetch("/api/local/diagnose-ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "接続診断に失敗しました。");
    return result;
  }
  constructor() {
    this.storageKey = "production-board-demo-v2";
    if (!localStorage.getItem(this.storageKey)) {
      localStorage.setItem(this.storageKey, JSON.stringify(this.seed()));
    }
    this.migrateLocalIntake();
    this.channel = "BroadcastChannel" in window ? new BroadcastChannel("production-board-demo") : null;
  }

  migrateLocalIntake() {
    const data = this.read();
    if (Number(data.localIntakeParserVersion || 0) >= LOCAL_PDF_ENGINE_VERSION) return;
    data.intake = (data.intake || []).filter((item) => item.status !== "pending" || Number(item.parserVersion || 0) >= LOCAL_PDF_ENGINE_VERSION);
    data.localIntakeParserVersion = LOCAL_PDF_ENGINE_VERSION;
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  seed() {
    const now = new Date();
    const iso = (offset) => {
      const [year, month, day] = todayIso(now).split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
    };
    const at = now.toISOString();
    return {
      jobs: [
        this.job("DEMO-001", "田中", "Yカーブドケリパンチ", iso(0), 10, "26-1101-1", ["done", "done", "working", "not_started", "not_started"], "normal", at),
        this.job("DEMO-002", "田中", "ケリパンチ", iso(1), 11, "26-1101-2", ["done", "done", "done", "working", "not_started"], "high", at),
        this.job("DEMO-003", "松井", "慈穴式 彫骨器", iso(-2), 10, "260605", ["done", "working", "not_started", "not_started", "not_started"], "urgent", at),
        this.job("DEMO-004", "フジタ", "下垂体マイクロ剪刀", iso(5), 3, "260514", ["done", "done", "done", "done", "working"], "normal", at),
        this.job("DEMO-005", "サージカル", "Tケリパンチ 弱弯2mm", iso(2), 1, "260424-1", ["done", "done", "done", "done", "done"], "normal", at),
        this.job("DEMO-006", "サージカル", "Tケリパンチ 強弯2mm", iso(4), 5, "260424-2", ["done", "done", "working", "not_started", "not_started"], "normal", at),
        this.job("DEMO-007", "イナミ", "ヘラクレス", iso(7), 3, "260501", ["working", "not_started", "not_started", "not_started", "not_started"], "normal", at),
        this.job("DEMO-008", "ユア", "Tezoe スタッツェ", iso(-1), 5, "260611-1", ["done", "done", "done", "done", "done"], "high", at, "waiting"),
      ],
      intake: [],
      localIntakeParserVersion: LOCAL_PDF_ENGINE_VERSION,
      settings: { gmailQuery: "newer_than:30d (subject:(注文 OR 発注 OR 依頼))" },
    };
  }

  job(id, customer, product, dueDate, quantity, serialNo, statuses, priority, updatedAt, shippingStatus = "not_ready") {
    const offset = Number(id.replace(/\D/g, "")) || 0;
    const completed = shippingStatus === "shipped";
    const inferred = inferOrderMetadata(product);
    const labelPrintStatus = id === "DEMO-001" || id === "DEMO-002" ? "waiting"
      : id === "DEMO-003" ? "reprint"
        : id === "DEMO-004" ? "printed" : "not_required";
    return {
      id, customer, product, dueDate, quantity, serialNo, priority,
      category: inferred.category, specLength: inferred.specLength, specShape: inferred.specShape, bladeWidth: inferred.bladeWidth, note: "",
      stages: Object.fromEntries(STAGES.map((stage, index) => [stage.key, { status: statuses[index], assignee: ASSIGNEES[(offset + index) % ASSIGNEES.length] }])),
      shippingStatus, sourceType: "sample", sourceRef: "ローカル確認用サンプル",
      archived: false, createdAt: updatedAt, updatedAt, version: 1, completedAt: completed ? updatedAt : "",
      labelPrintStatus, labelPrintedAt: labelPrintStatus === "printed" ? updatedAt : "",
    };
  }

  read() { return JSON.parse(localStorage.getItem(this.storageKey)); }
  write(value) {
    localStorage.setItem(this.storageKey, JSON.stringify(value));
    this.channel?.postMessage({ type: "updated", at: Date.now() });
  }

  async getSnapshot() {
    await delay(120);
    const data = this.read();
    const aiImport = await fetch("/api/local/ai-status").then((response) => response.ok ? response.json() : { ready: false }).catch(() => ({ ready: false }));
    const projectInfo = await fetch("/api/local/project-info").then((response) => response.ok ? response.json() : {}).catch(() => ({}));
    return { ...data, aiImport, scriptEditorUrl: projectInfo.scriptEditorUrl || "", mode: "demo", serverTime: new Date().toISOString(), setupRequired: false };
  }

  async saveJob(payload) {
    await delay(220);
    const data = this.read();
    const now = new Date().toISOString();
    payload = { ...payload, ...inferOrderMetadata(payload.product, payload) };
    const index = data.jobs.findIndex((job) => job.id === payload.id);
    const previous = index >= 0 ? data.jobs[index] : null;
    const completed = payload.shippingStatus === "shipped";
    const wasCompleted = previous?.shippingStatus === "shipped";
    const requestedLabelStatus = normalizeLabelPrintStatus(payload.labelPrintStatus ?? previous?.labelPrintStatus);
    const saved = {
      ...payload,
      id: payload.id || `DEMO-${String(Date.now()).slice(-6)}`,
      version: Number(payload.version || 0) + 1,
      createdAt: payload.createdAt || now,
      updatedAt: now,
      sourceType: payload.sourceType || "manual",
      sourceRef: payload.sourceRef || "ローカル入力",
      archived: false,
      completedAt: completed ? (previous?.completedAt || (wasCompleted ? "" : now)) : "",
      labelPrintStatus: requestedLabelStatus,
      labelPrintedAt: requestedLabelStatus === "printed" ? (previous?.labelPrintedAt || now) : "",
    };
    if (previous?.labelPrintStatus === "printed" && saved.labelPrintStatus !== "not_required" && labelContentChanged(previous, saved)) {
      saved.labelPrintStatus = "reprint";
      saved.labelPrintedAt = "";
    }
    if (index >= 0) data.jobs[index] = saved;
    else data.jobs.unshift(saved);
    this.write(data);
    return saved;
  }

  async setJobArchived(payload) {
    await delay(180);
    const data = this.read();
    const job = data.jobs.find((entry) => entry.id === payload.id);
    if (!job) throw new Error("案件が見つかりません。画面を更新してください。");
    if (Number(job.version || 0) !== Number(payload.version || 0)) {
      throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
    }
    Object.assign(job, {
      archived: payload.archived === true,
      updatedAt: new Date().toISOString(),
      version: Number(job.version || 0) + 1,
    });
    this.write(data);
    return { ...job };
  }

  async createIntakeFromImage(payload) {
    await delay(360);
    const data = this.read();
    const useAi = payload.engine === "ai";
    const isText = payload.sourceType === "text";
    if (!isText && !useAi && payload.mimeType !== "application/pdf") {
      throw new Error("ローカル版の文字読取は文字入りPDFに対応しています。写真はApps Script版で読み取ってください。");
    }
    const response = await fetch(isText ? "/api/local/parse-order-text" : useAi ? "/api/local/parse-order-ai" : "/api/local/parse-order-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(useAi ? { ...payload, customerRules: await this.getCustomerRules() } : payload),
    });
    const parsedResponse = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(parsedResponse.error || "ローカルPDF解析に失敗しました。npm run devで開き直してください。");
    if (Number(parsedResponse.engineVersion || 0) < LOCAL_PDF_ENGINE_VERSION) {
      throw new Error("古いローカル解析サーバーが動いています。いったん停止し、npm run devを再実行してから読み直してください。");
    }
    const results = Array.isArray(parsedResponse.results) ? parsedResponse.results : [];
    if (!results.length) throw new Error("注文内容から品目を抽出できませんでした。");
    const incomplete = results.filter((result) => {
      const quantity = result?.parsed?.quantity;
      return quantity === "" || quantity === null || quantity === undefined;
    });
    if (incomplete.length && !useAi && !isText) {
      throw new Error(`数量を読み取れない品目が${incomplete.length}件あります。不完全な候補は保存していません。`);
    }
    const now = new Date().toISOString();
    const batchId = String(Date.now());
    const intakeTitle = payload.name || (isText ? "貼り付けた注文メール" : "注文情報");
    const items = results.map((result, index) => {
      const itemNumber = result.itemNumber || index + 1;
      const product = result.parsed?.product || "品名未判定";
      return {
        id: `INTAKE-${batchId}-${itemNumber}`,
        sourceType: isText ? "text" : "image",
        sourceRef: `local:${result.purchaseNo || payload.name}:item:${itemNumber}:${batchId}`,
        receivedAt: now,
        sender: "",
        subject: results.length > 1 ? `${intakeTitle} · 品目${itemNumber}（${index + 1}/${results.length}）` : intakeTitle,
        originalText: result.parsed?._ai ? `AI読取・要確認\n文書 ${result.parsed._ai.document ?? 1} / ページ ${result.parsed._ai.page} / 明細 ${result.parsed._ai.row}\n根拠: ${result.parsed._ai.evidence}\n確認事項: ${result.parsed._ai.warnings.join(" / ")}\n${parsedResponse.text}` : results.length > 1
          ? `この確認候補: 品目${itemNumber} ${product}\n\n--- 発注書の読取全文 ---\n${parsedResponse.text || ""}`
          : (parsedResponse.text || ""),
        parsed: result.parsed || {},
        confidence: Number(result.confidence || 0),
        importFileName: payload.name,
        parserVersion: LOCAL_PDF_ENGINE_VERSION,
        status: "pending",
      };
    });
    if (!isText) data.intake = (data.intake || []).filter((item) => item.status !== "pending" || item.importFileName !== payload.name);
    data.intake.unshift(...items);
    this.write(data);
    return { added: items.length, items };
  }

  async scanOrderEmails() {
    await delay(250);
    throw new Error("ローカルプレビューではGmailへ接続しません。Apps Script版で実行してください。");
  }

  createIntakeWithAi(payload) { return this.createIntakeFromImage({ ...payload, engine: "ai" }); }
  createIntakeFromText(payload) { return this.createIntakeFromImage({ ...payload, sourceType: "text" }); }

  async approveIntake(payload) {
    const candidate = this.read().intake.find((entry) => entry.id === payload.intakeId && entry.status === "pending");
    if (!candidate) throw new Error("この取込候補は処理済みか、見つかりません。");
    if ((candidate.sourceType === "text" || candidate.parsed?._ai) && (!Number.isInteger(Number(payload.order.quantity)) || Number(payload.order.quantity) <= 0 || Number(payload.order.quantity) > 1000000)) throw new Error("数量を原本と確認し、1以上の整数で入力してください。");
    const saved = await this.saveJob({ ...payload.order, sourceType: "intake", sourceRef: payload.intakeId, labelPrintStatus: "waiting", labelPrintedAt: "" });
    const data = this.read();
    const item = data.intake.find((entry) => entry.id === payload.intakeId);
    if (item) item.status = "approved";
    this.write(data);
    return saved;
  }

  async approveIntakes(payload) {
    await delay(220);
    const data = this.read();
    const requests = payload?.items;
    if (!Array.isArray(requests) || !requests.length || requests.length > 100) throw new Error("1〜100件を選択してください。");
    const errors = [];
    const seen = new Set();
    const prepared = requests.map(({ intakeId, order }) => {
      const candidate = data.intake.find((item) => item.id === intakeId);
      const existing = data.jobs.find((job) => job.sourceType === "intake" && job.sourceRef === intakeId);
      let message = seen.has(intakeId) ? "同じ候補が重複しています。" : "";
      seen.add(intakeId);
      if (!candidate || !["pending", "approved"].includes(candidate.status)) message ||= "この候補は処理済みか、見つかりません。";
      if (candidate?.status === "approved" && !existing) message ||= "反映済みの案件が見つかりません。";
      if (!existing) message ||= bulkOrderError(order || {});
      if (message) errors.push({ intakeId, message });
      return { intakeId, candidate, existing, order };
    });
    if (errors.length) return { items: [], errors };
    const now = new Date().toISOString();
    const items = prepared.map(({ intakeId, candidate, existing, order }) => {
      const job = existing || {
        ...Object.fromEntries(BULK_INTAKE_FIELDS.map(([key]) => [key, order[key] ?? ""])),
        quantity: Number(order.quantity), id: `JOB-${crypto.randomUUID()}`, priority: "normal",
        sourceType: "intake", sourceRef: intakeId, labelPrintStatus: "waiting", labelPrintedAt: "",
        shippingStatus: "not_ready", archived: false, completedAt: "", createdAt: now, updatedAt: now, version: 1,
        stages: Object.fromEntries(STAGES.map((stage) => [stage.key, { status: "not_started", assignee: "" }])),
      };
      if (!existing) data.jobs.unshift(job);
      candidate.status = "approved";
      return { intakeId, job };
    });
    this.write(data);
    return { items, errors: [] };
  }

  async markLabelsPrinted(payload) {
    await delay(180);
    const data = this.read();
    const now = new Date().toISOString();
    const requested = Array.isArray(payload?.jobs) ? payload.jobs.slice(0, LABEL_PRINT_LIMIT) : [];
    if (!requested.length) throw new Error("印刷済みにする案件がありません。");
    const updated = requested.map((item) => {
      const job = data.jobs.find((entry) => entry.id === item.id);
      if (!job) throw new Error("印刷対象の案件が見つかりません。画面を更新してください。");
      if (Number(job.version || 0) !== Number(item.version || 0)) throw new Error("印刷対象が別の端末で更新されています。画面を更新してください。");
      Object.assign(job, { labelPrintStatus: "printed", labelPrintedAt: now, updatedAt: now, version: Number(job.version || 0) + 1 });
      return { ...job };
    });
    this.write(data);
    return updated;
  }

  async rejectIntake(payload) {
    const result = await this.rejectIntakes({ intakeIds: [payload.intakeId] });
    if (result.errors.length) throw new Error(result.errors[0].message);
    return { ok: true };
  }

  async rejectIntakes(payload) {
    await delay(120);
    const ids = payload?.intakeIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error("1〜100件を選択してください。");
    const data = this.read();
    const errors = [], seen = new Set();
    const prepared = ids.map((rawId) => {
      const intakeId = typeof rawId === "string" ? rawId.trim() : "";
      const item = data.intake.find((entry) => entry.id === intakeId);
      const existing = data.jobs.some((job) => (job.sourceType === "intake" && job.sourceRef === intakeId)
        || (item?.sourceRef && job.sourceType === item.sourceType && job.sourceRef === item.sourceRef));
      if (!intakeId || seen.has(intakeId)) {
        errors.push({ intakeId, message: "取込候補の指定が不正か、重複しています。" });
      } else if (!item || !["pending", "rejected"].includes(item.status || "pending") || existing) {
        errors.push({ intakeId, message: "この候補は反映済みか、見つからないため削除できません。" });
      }
      seen.add(intakeId);
      return { intakeId, item };
    });
    if (errors.length) return { items: [], errors };
    const items = prepared.map(({ intakeId, item }) => {
      item.status = "rejected";
      return { intakeId };
    });
    this.write(data);
    return { items, errors };
  }

  async saveSettings(payload) {
    const data = this.read();
    data.settings = { ...data.settings, ...payload };
    this.write(data);
    return data.settings;
  }

  async getCustomerRules() {
    const raw = this.read().settings.customerRules;
    const rules = raw === undefined ? defaultClientCustomerRules() : typeof raw === "string" ? JSON.parse(raw) : raw;
    return { ...validateClientCustomerRules(rules), version: rules.version || 0 };
  }

  async saveCustomerRules({ expectedVersion, rules }) {
    const checked = validateClientCustomerRules(rules);
    const data = this.read();
    const raw = data.settings.customerRules;
    const current = raw === undefined ? defaultClientCustomerRules() : typeof raw === "string" ? JSON.parse(raw) : raw;
    if (current.version !== expectedVersion) throw new Error("別の画面でルールが更新されています。読み直してから保存してください。");
    const saved = { ...checked, version: current.version + 1 };
    data.settings.customerRules = JSON.stringify(saved);
    this.write(data);
    return saved;
  }

  async migrateLegacySheet() {
    await delay(180);
    throw new Error("既存シートの読込はApps Script版で実行してください。");
  }
}

const isAppsScript = Boolean(window.google?.script?.run);
const api = isAppsScript ? new AppsScriptApi() : new MockApi();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProductText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeMeasure(value, unit) {
  const normalizedUnit = String(unit).toLowerCase().replace("センチ", "cm").replace("ミリ", "mm");
  return `${String(value).replace(",", ".")}${normalizedUnit}`;
}

function classifyProductCategory(product) {
  const name = normalizeProductText(product);
  if (/ケリソン|ケリパンチ|スタンツェ|スタンチェ|スタンツエ|スタッツェ|彫骨器/.test(name)) return "ケリソンパンチ";
  if (/鉗子/.test(name)) return "鋭匙鉗子";
  return "";
}

function inferSpecsFromProductName(product, existing = {}) {
  const name = normalizeProductText(product);
  const inferred = {
    specLength: String(existing.specLength || "").trim(),
    specShape: String(existing.specShape || "").trim(),
    bladeWidth: String(existing.bladeWidth || "").trim(),
  };
  if (!name) return inferred;

  const explicitLength = name.match(/(?:全長|長さ)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|センチ|ミリ)/i);
  const explicitBlade = name.match(/(?:刃幅|刃巾|刃の幅)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(mm|ミリ)/i);
  if (!inferred.specLength && explicitLength) inferred.specLength = normalizeMeasure(explicitLength[1], explicitLength[2]);
  if (!inferred.bladeWidth && explicitBlade) inferred.bladeWidth = normalizeMeasure(explicitBlade[1], explicitBlade[2]);

  let unlabelled = name;
  if (explicitLength) unlabelled = unlabelled.replace(explicitLength[0], " ");
  if (explicitBlade) unlabelled = unlabelled.replace(explicitBlade[0], " ");
  const centimetres = unlabelled.match(/(\d+(?:[.,]\d+)?)\s*(cm|センチ)/i);
  if (!inferred.specLength && centimetres) inferred.specLength = normalizeMeasure(centimetres[1], centimetres[2]);

  const millimetres = [...unlabelled.matchAll(/(\d+(?:[.,]\d+)?)\s*(mm|ミリ)/gi)]
    .map((match) => ({ value: Number(match[1].replace(",", ".")), text: normalizeMeasure(match[1], match[2]) }))
    .filter((item) => Number.isFinite(item.value));
  if (!inferred.specLength) {
    const lengthInMm = millimetres.find((item) => item.value >= 50);
    if (lengthInMm) inferred.specLength = lengthInMm.text;
  }
  if (!inferred.bladeWidth) {
    const blade = millimetres.find((item) => item.value > 0 && item.value <= 20);
    if (blade) inferred.bladeWidth = blade.text;
  }

  if (!inferred.specShape) {
    const compact = name.replace(/\s+/g, "");
    const jawMatch = compact.match(/[<〈]([^<>〈〉]{1,20}爪)[>〉]/);
    if (jawMatch) inferred.specShape = jawMatch[1];
    else if (/上向(?:き)?左(?:カーブ|曲)/.test(compact)) inferred.specShape = "上曲左";
    else if (/上向(?:き)?右(?:カーブ|曲)/.test(compact)) inferred.specShape = "上曲右";
    else if (/下向(?:き)?左(?:カーブ|曲)/.test(compact)) inferred.specShape = "下曲左";
    else if (/下向(?:き)?右(?:カーブ|曲)/.test(compact)) inferred.specShape = "下曲右";
  }
  if (!inferred.specShape) {
    const shapeTokens = ["斜刃上向", "斜刃下向", "直上向", "直下向", "上曲左", "上曲右", "下曲左", "下曲右", "強弯", "弱弯", "強湾", "弱湾", "強彎", "弱彎", "上曲", "下曲", "上向", "下向", "左", "右", "直"];
    const shape = shapeTokens.find((token) => name.includes(token));
    if (shape) inferred.specShape = shape.replace(/[湾彎]/g, "弯");
  }
  return inferred;
}

function inferOrderMetadata(product, existing = {}) {
  return {
    category: String(existing.category || "").trim() || classifyProductCategory(product),
    ...inferSpecsFromProductName(product, existing),
  };
}

function applyProductInference(form, { announceResult = false } = {}) {
  const product = form.elements.product?.value || "";
  const derivedFields = ["category", "specLength", "specShape", "bladeWidth"];
  const current = Object.fromEntries(derivedFields.map((name) => {
    const field = form.elements[name];
    return [name, field?.dataset.autoFilled === "true" ? "" : (field?.value || "")];
  }));
  const inferred = inferOrderMetadata(product, current);
  const updated = [];
  [["category", "大分類"], ["specLength", "全長"], ["specShape", "型"], ["bladeWidth", "刃幅"]].forEach(([name, label]) => {
    const field = form.elements[name];
    if (!field || (current[name] && field.dataset.autoFilled !== "true")) return;
    const previous = field.value;
    field.value = inferred[name];
    if (inferred[name]) {
      field.dataset.autoFilled = "true";
      field.dataset.state = "success";
    } else {
      delete field.dataset.autoFilled;
      delete field.dataset.state;
    }
    if (previous !== field.value) updated.push(label);
  });
  const note = qs("#spec-auto-note", form);
  if (note) note.textContent = updated.length
    ? `品名に合わせて${updated.join("・")}の自動補完値を更新しました。内容を確認してください。`
    : "品名に全長・型・刃幅があれば、空欄だけ自動補完します。";
  if (announceResult && updated.length) announce(`${updated.join("、")}の自動補完値を更新しました`);
  return inferred;
}

function readStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_OPTIONS.includes(saved) ? saved : "auto";
  } catch (error) {
    return "auto";
  }
}

function resolvedTheme() {
  if (state.theme === "light" || state.theme === "dark") return state.theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme, { persist = true } = {}) {
  state.theme = THEME_OPTIONS.includes(theme) ? theme : "auto";
  if (state.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, state.theme); } catch (error) { /* 端末保存を使えなくても表示は切り替える */ }
  }
  renderThemeSetting();
}

function renderThemeSetting() {
  qsa("[data-theme-choice]").forEach((button) => {
    const selected = button.dataset.themeChoice === state.theme;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const current = qs("#theme-current");
  if (current) current.textContent = `現在は${resolvedTheme() === "dark" ? "ダーク" : "ライト"}表示です`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function formatDate(value, options = { month: "numeric", day: "numeric" }) {
  if (!value) return "未設定";
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { ...options, timeZone: BUSINESS_TIME_ZONE }).format(date);
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE }).format(new Date(value));
}

function formatLabelDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit", timeZone: BUSINESS_TIME_ZONE }).format(date);
}

function formatLabelLength(value) {
  const normalized = normalizeProductText(value);
  if (!normalized) return "—";
  const measure = normalized.match(/^(\d+(?:[.,]\d+)?)\s*(cm|mm|センチ|ミリ)$/i);
  if (!measure) return normalized;
  const amount = Number(measure[1].replace(",", "."));
  if (!Number.isFinite(amount)) return normalized;
  const unit = measure[2].toLowerCase().replace("センチ", "cm").replace("ミリ", "mm");
  const millimetres = unit === "cm" ? amount * 10 : amount;
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(millimetres);
}

function businessDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function todayIso(value = new Date()) {
  return businessDateKey(value);
}

function isInCurrentMonth(value) {
  if (!value) return false;
  const dateKey = businessDateKey(value);
  return Boolean(dateKey) && dateKey.slice(0, 7) === todayIso().slice(0, 7);
}

function daysUntil(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const dueParts = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const todayParts = todayIso().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dueParts || !todayParts) return Number.POSITIVE_INFINITY;
  const toUtcDay = (parts) => Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return Math.round((toUtcDay(dueParts) - toUtcDay(todayParts)) / 86400000);
}

function stageStatus(job, key) {
  return job.stages?.[key]?.status || "not_started";
}

function stageAssignee(job, key) {
  return String(job.stages?.[key]?.assignee || "").trim();
}

function isDone(job) {
  return STAGES.every((stage) => stageStatus(job, stage.key) === "done");
}

function progress(job) {
  const completed = STAGES.filter((stage) => stageStatus(job, stage.key) === "done").length;
  const shipped = job.shippingStatus === "shipped" ? 1 : 0;
  return Math.round(((completed + shipped) / (STAGES.length + 1)) * 100);
}

function currentStage(job) {
  if (job.shippingStatus === "shipped") return { key: "complete", label: "出荷完了", status: "done", assignee: "" };
  const current = STAGES.find((stage) => stageStatus(job, stage.key) !== "done");
  if (current) return { ...current, status: stageStatus(job, current.key), assignee: stageAssignee(job, current.key) };
  return { key: "shipping", label: "出荷待ち", status: "waiting", assignee: "" };
}

function statusLabel(status) {
  return STATUS_OPTIONS.find((option) => option.value === status)?.label || "未着手";
}

function statusTone(stage) {
  if (stage.status === "done") return "success";
  if (stage.status === "hold") return "warning";
  if (stage.status === "waiting") return "warning";
  return "default";
}

function assignmentStrip(job) {
  return `<span class="assignment-strip" aria-label="工程ごとの担当者">${STAGES.map((stage) => {
    const assignee = stageAssignee(job, stage.key);
    const status = stageStatus(job, stage.key);
    const detail = `${stage.label}：${assignee || "担当未定"}（${statusLabel(status)}）`;
    return `<span class="assignment-step" data-status="${status}" title="${escapeHtml(detail)}"><b>${stage.short}</b><span>${escapeHtml(assignee || "未定")}</span></span>`;
  }).join("")}</span>`;
}

function dueInfo(job) {
  const days = daysUntil(job.dueDate);
  if (!Number.isFinite(days)) return { label: "納期未設定", tone: "default", late: false };
  if (days < 0) return { label: `${Math.abs(days)}日超過`, tone: "danger", late: true };
  if (days === 0) return { label: "本日", tone: "danger", late: false };
  if (days <= 2) return { label: `あと${days}日`, tone: "warning", late: false };
  return { label: formatDate(job.dueDate), tone: "default", late: false };
}

function priorityScore(job) {
  const priority = { urgent: -300, high: -150, normal: 0 }[job.priority] || 0;
  const due = Number.isFinite(daysUntil(job.dueDate)) ? daysUntil(job.dueDate) * 20 : 500;
  return priority + due + progress(job);
}

function pendingJobs() {
  return state.jobs.filter((job) => !job.archived && job.shippingStatus !== "shipped");
}

function normalizeLabelPrintStatus(value) {
  return LABEL_PRINT_STATUSES.includes(value) ? value : "not_required";
}

function labelPrintStatus(job) {
  return normalizeLabelPrintStatus(job?.labelPrintStatus);
}

function labelContentChanged(previous, next) {
  return ["customer", "product", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo"]
    .some((key) => String(previous?.[key] ?? "") !== String(next?.[key] ?? ""));
}

function labelQueueJobs() {
  return labelCandidateJobs().filter((job) => ["waiting", "reprint"].includes(labelPrintStatus(job)));
}

function jobCategory(job) {
  return String(job.category || "").trim() || classifyProductCategory(job.product);
}

function compareTextBlankLast(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return NATURAL_COLLATOR.compare(a, b);
}

function compareCategory(left, right) {
  const a = jobCategory(left);
  const b = jobCategory(right);
  const aOrder = a in CATEGORY_SORT_ORDER ? CATEGORY_SORT_ORDER[a] : CATEGORY_OPTIONS.length;
  const bOrder = b in CATEGORY_SORT_ORDER ? CATEGORY_SORT_ORDER[b] : CATEGORY_OPTIONS.length;
  return aOrder - bOrder || compareTextBlankLast(a, b);
}

function sortedJobs(scope) {
  const sort = state.filters[scope]?.sort || (scope === "completed" ? "updated" : "priority");
  const jobs = [...filteredJobs(scope)];
  const comparators = {
    priority: (a, b) => priorityScore(a) - priorityScore(b),
    category: compareCategory,
    serial: (a, b) => compareTextBlankLast(a.serialNo, b.serialNo),
    due: (a, b) => compareTextBlankLast(a.dueDate, b.dueDate),
    customer: (a, b) => compareTextBlankLast(a.customer, b.customer),
    updated: (a, b) => new Date(scope === "completed" ? (b.completedAt || b.updatedAt || 0) : (b.updatedAt || 0))
      - new Date(scope === "completed" ? (a.completedAt || a.updatedAt || 0) : (a.updatedAt || 0)),
  };
  const primary = comparators[sort] || comparators.priority;
  return jobs.sort((a, b) => primary(a, b)
    || compareTextBlankLast(a.serialNo, b.serialNo)
    || compareTextBlankLast(a.id, b.id));
}

function filteredJobs(scope) {
  const { query, stage, attention = "all", period = "all" } = state.filters[scope] || { query: "", stage: "all" };
  const normalized = query.trim().toLocaleLowerCase("ja");
  return state.jobs.filter((job) => {
    if (job.archived) return false;
    const completedScope = scope === "completed";
    if (completedScope !== (job.shippingStatus === "shipped")) return false;
    const matchesQuery = !normalized || [job.customer, job.product, jobCategory(job), job.serialNo, job.specLength, job.specShape, job.bladeWidth, job.note, ...STAGES.map((item) => stageAssignee(job, item.key))]
      .some((value) => String(value || "").toLocaleLowerCase("ja").includes(normalized));
    const current = currentStage(job);
    const matchesStage = stage === "all" || current.key === stage;
    const matchesAttention = attention === "all"
      || (attention === "production" && !isDone(job))
      || (attention === "due" && daysUntil(job.dueDate) <= 2)
      || (attention === "shipping" && isDone(job));
    const matchesPeriod = !completedScope || period === "all" || isInCurrentMonth(job.completedAt);
    return matchesQuery && matchesStage && matchesAttention && matchesPeriod;
  });
}

function setConnection(status, message) {
  const dot = qs("#status-dot");
  dot.classList.toggle("is-online", status === "online");
  dot.classList.toggle("is-error", status === "error");
  qs("#status-message").textContent = message;
}

function setButtonState(button, buttonState, label) {
  if (!button) return;
  if (buttonState) button.dataset.state = buttonState;
  else delete button.dataset.state;
  button.disabled = buttonState === "loading";
  if (label) {
    const span = qs("span", button);
    if (span) span.textContent = label;
    else button.textContent = label;
  }
}

function announce(message) {
  qs("#live-region").textContent = "";
  requestAnimationFrame(() => { qs("#live-region").textContent = message; });
}

function showToast(message, options = {}) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = options.tone || "info";
  toast.innerHTML = `${icon(options.tone === "error" ? "alert" : "check")}<span>${escapeHtml(message)}</span>`;
  if (options.action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = options.action.label;
    button.addEventListener("click", () => {
      options.action.run();
      toast.remove();
    });
    toast.append(button);
  }
  qs("#toast-stack").append(toast);
  const timeout = options.sticky ? null : setTimeout(() => toast.remove(), 6000);
  toast.addEventListener("mouseenter", () => timeout && clearTimeout(timeout), { once: true });
}

function renderSkeletons() {
  qs("#dashboard-order-cards").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
}

async function refreshData({ quiet = false } = {}) {
  if (!quiet) setConnection("loading", "データを読み込んでいます");
  try {
    const snapshot = await api.getSnapshot({ since: state.lastSync });
    state.jobs = snapshot.jobs || [];
    state.intake = (snapshot.intake || []).filter((item) => item.status === "pending");
    state.settings = snapshot.settings || {};
    state.mode = snapshot.mode || (isAppsScript ? "live" : "demo");
    state.aiImport = snapshot.aiImport || { ready: false, configured: false };
    state.scriptEditorUrl = snapshot.scriptEditorUrl || "";
    state.lastSync = snapshot.serverTime || new Date().toISOString();
    renderAll();
    setConnection("online", state.mode === "demo" ? "ローカル確認用データ" : "スプレッドシートと同期中");
  } catch (error) {
    setConnection("error", "同期できませんでした");
    if (!quiet) showToast(`データを読み込めませんでした。${error.message}`, { tone: "error" });
  }
}

function renderAll() {
  renderHeader();
  renderMetrics();
  renderDashboardOrders();
  renderOrdersWorkspace();
  renderCompletedWorkspace();
  renderIntake();
  renderSettings();
  const engine = qs("#import-engine");
  if (!engine.dataset.chosen) engine.value = state.aiImport.ready ? "ai" : "legacy";
  qs("#ai-import-status").textContent = state.aiImport.ready
    ? "AI設定済み。無料枠のプロジェクトを使用してください。上限時は停止し、自動再試行しません。"
    : "AIは未設定です。無料枠のAPIキーをサーバーに設定すると使えます。現在は従来の読取を利用できます。";
  if (qs("#label-dialog")?.open) renderLabelPrintDialog();
  qs("#last-sync").textContent = `最終同期 ${formatDateTime(state.lastSync)}`;
}

function renderHeader() {
  const pending = state.intake.length;
  const count = qs("#intake-nav-count");
  count.textContent = String(pending);
  count.hidden = pending === 0;
  const completed = state.jobs.filter((job) => !job.archived && job.shippingStatus === "shipped" && isInCurrentMonth(job.completedAt)).length;
  const completedCount = qs("#completed-nav-count");
  completedCount.textContent = String(completed);
  completedCount.hidden = completed === 0;
  const labelWaiting = labelQueueJobs().length;
  qsa("[data-label-queue-count]").forEach((badge) => {
    badge.textContent = String(labelWaiting);
    badge.hidden = labelWaiting === 0;
  });
  qs("#connection-label").textContent = state.mode === "demo" ? "デモ環境" : "Google Sheets共有";
  qs("#today-label").textContent = new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(new Date());
}

function renderMetrics() {
  const pending = pendingJobs();
  const active = pending.filter((job) => !isDone(job));
  const due = pending.filter((job) => daysUntil(job.dueDate) <= 2);
  const doneThisMonth = state.jobs.filter((job) => {
    return !job.archived && job.shippingStatus === "shipped" && isInCurrentMonth(job.completedAt);
  });
  const shipping = pending.filter((job) => isDone(job));
  qs("#metric-active").textContent = String(active.length);
  qs("#metric-due").textContent = String(due.length);
  qs("#metric-done").textContent = String(doneThisMonth.length);
  qs("#metric-ship").textContent = String(shipping.length);
  qs("#metric-label").textContent = String(labelQueueJobs().length);
  qs("#metric-active-note").textContent = active.length ? `未出荷${pending.length}件中・製作中` : "現在の進行案件はありません";
}

function stageCellButton(job, stage) {
  const status = stageStatus(job, stage.key);
  const assignee = stageAssignee(job, stage.key);
  return `<button class="stage-open-button stage-cell-button" type="button" data-action="open-process" data-order-id="${escapeHtml(job.id)}" data-stage-key="${stage.key}" data-status="${status}" data-tone="${statusTone({ status })}" aria-label="${escapeHtml(job.product || "案件")}の${stage.label}：${escapeHtml(assignee || "担当未定")}・${statusLabel(status)}を更新"><b>${escapeHtml(assignee || "—")}</b><small>${statusLabel(status)}</small></button>`;
}

function shippingCell(job, completed = false) {
  const label = job.shippingStatus === "shipped" ? "出荷完了" : isDone(job) ? "出荷待ち" : "未出荷";
  return `<span class="shipping-cell"><button type="button" class="shipping-open-button" data-action="open-process" data-order-id="${escapeHtml(job.id)}" data-stage-key="shipping" aria-label="${escapeHtml(job.product || "案件")}の出荷状態を更新">${label}</button>${completed ? `<small>出荷完了 ${escapeHtml(formatDateTime(job.completedAt || job.updatedAt))}</small>` : ""}</span>`;
}

function orderQuantity(job) {
  return job.quantity === "" || job.quantity == null ? "—" : escapeHtml(Number(job.quantity).toLocaleString("ja-JP"));
}

function orderTableRows(jobs, { completed = false } = {}) {
  return jobs.map((job) => {
    const due = dueInfo(job);
    const category = jobCategory(job);
    return `<tr data-order-id="${escapeHtml(job.id)}">
      <td class="cell-customer">${escapeHtml(job.customer || "—")}</td>
      <td class="cell-product"><strong>${escapeHtml(job.product || "品名未設定")}</strong></td>
      <td class="cell-category">${escapeHtml(category || "未分類")}</td>
      <td class="cell-due" data-tone="${completed ? "default" : due.tone}" title="${escapeHtml(job.dueDate || "納期未設定")}">${escapeHtml(job.dueDate ? formatDate(job.dueDate) : "—")}</td>
      <td class="cell-quantity">${orderQuantity(job)}</td>
      <td class="cell-length">${escapeHtml(job.specLength || "—")}</td>
      <td class="cell-shape">${escapeHtml(job.specShape || "—")}</td>
      <td class="cell-blade">${escapeHtml(job.bladeWidth || "—")}</td>
      <td class="cell-serial">${escapeHtml(job.serialNo || "—")}</td>
      ${STAGES.map((stage) => `<td class="cell-stage">${stageCellButton(job, stage)}</td>`).join("")}
      <td class="cell-note">${escapeHtml(job.note || "—")}</td>
      <td class="cell-shipping">${shippingCell(job, completed)}</td>
      <td><button class="row-action" type="button" data-action="edit-order" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(job.product || "案件")}の注文情報を編集">${icon("edit")}</button></td>
    </tr>`;
  }).join("");
}

function orderCards(jobs, { completed = false } = {}) {
  return jobs.map((job) => {
    const due = dueInfo(job);
    const category = jobCategory(job);
    return `<article class="order-card" data-order-id="${escapeHtml(job.id)}">
      <span class="order-main"><span class="order-copy"><strong>${escapeHtml(job.product || "品名未設定")}</strong><span>${escapeHtml(job.customer || "得意先未設定")}</span></span><span class="status-chip" data-tone="${due.tone}">${escapeHtml(due.label)}</span></span>
      <span class="order-meta"><span class="category-chip" data-category="${escapeHtml(category || "unclassified")}">${escapeHtml(category || "未分類")}</span><span>連番 ${escapeHtml(job.serialNo || "—")}</span></span>
      <dl class="order-specs">${[["数量", orderQuantity(job)], ["全長", escapeHtml(job.specLength || "—")], ["型", escapeHtml(job.specShape || "—")], ["刃幅", escapeHtml(job.bladeWidth || "—")], ["納期", escapeHtml(job.dueDate ? formatDate(job.dueDate) : "—")]].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
      <div class="order-stage-grid">${STAGES.map((stage) => `<div><span class="stage-column-label">${stage.label}</span>${stageCellButton(job, stage)}</div>`).join("")}</div>
      ${job.note ? `<p class="order-note"><span>備考</span> ${escapeHtml(job.note)}</p>` : ""}
      <div class="order-card-actions">${shippingCell(job, completed)}<button class="row-action" type="button" data-action="edit-order" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(job.product || "案件")}の注文情報を編集">${icon("edit")}</button></div>
    </article>`;
  }).join("");
}

function orderTableHeader({ completed = false } = {}) {
  const columns = [["customer", "得意先", "customer"], ["product", "品名"], ["category", "大分類", "category"], ["due", "納期", "due"], ["quantity", "数量"], ["length", "全長"], ["shape", "型"], ["blade", "刃幅"], ["serial", "連番", "serial"], ...STAGES.map((stage) => ["stage", stage.label]), ["note", "備考"], ["shipping", completed ? "出荷完了" : "出荷", completed ? "updated" : ""], ["edit", "編集"]];
  return `<caption class="sr-only">仕様と全工程の一覧。工程の担当・状態を押すと更新できます。並び順は一覧上部で変更できます。</caption><colgroup>${columns.map(([key]) => `<col class="col-${key}">`).join("")}</colgroup><thead><tr>${columns.map(([, label, sort]) => `<th scope="col"${sort ? ` data-sort-key="${sort}"` : ""}>${label}</th>`).join("")}</tr></thead>`;
}

function renderSortState(root, scope) {
  const sort = state.filters[scope]?.sort;
  qsa("th[data-sort-key]", root).forEach((header) => {
    header.removeAttribute("aria-sort");
    if (header.dataset.sortKey !== sort) return;
    header.setAttribute("aria-sort", sort === "updated" ? "descending" : "ascending");
  });
}

function renderDashboardOrders() {
  const allJobs = sortedJobs("dashboard");
  const jobs = allJobs.slice(0, 8);
  qs("#dashboard-order-rows").closest("table").innerHTML = `${orderTableHeader()}<tbody id="dashboard-order-rows">${orderTableRows(jobs)}</tbody>`;
  qs("#dashboard-order-cards").innerHTML = orderCards(jobs);
  qs("#dashboard-empty").hidden = jobs.length > 0;
  const prefix = state.filters.dashboard.sort === "priority" ? "優先" : "先頭";
  qs("#result-summary").textContent = allJobs.length > jobs.length ? `${prefix}${jobs.length}件／全${allJobs.length}件` : `${allJobs.length}件を表示`;
  renderSortState(qs("#dashboard-order-rows").closest("table"), "dashboard");
}

function renderOrdersWorkspace() {
  const jobs = sortedJobs("orders");
  const workspace = qs("#orders-workspace");
  if (!jobs.length) {
    workspace.innerHTML = `<div class="empty-state">${icon("search")}<h3>条件に合う案件がありません</h3><p>検索語か工程を変更してください。</p><button class="button button-secondary" type="button" data-action="clear-filters">絞り込みを解除</button></div>`;
    return;
  }
  workspace.innerHTML = `<div class="order-table-wrap"><table class="order-table" aria-label="未出荷案件">${orderTableHeader()}<tbody>${orderTableRows(jobs)}</tbody></table></div><div class="order-card-list">${orderCards(jobs)}</div>`;
  renderSortState(workspace, "orders");
}

function renderCompletedWorkspace() {
  const jobs = sortedJobs("completed");
  const period = state.filters.completed.period;
  qs("#completed-result-summary").textContent = `${period === "current" ? "今月" : "全期間"} ${jobs.length}件`;
  const workspace = qs("#completed-workspace");
  if (!jobs.length) {
    const hasQuery = Boolean(state.filters.completed.query.trim());
    const currentPeriod = period === "current";
    const title = hasQuery ? "条件に合う終了案件がありません" : currentPeriod ? "今月完了した案件はありません" : "終了した案件はまだありません";
    const copy = hasQuery ? "検索語を変更するか、検索を解除してください。" : currentPeriod ? "過去の完了案件は、完了期間を「すべて」にすると確認できます。" : "出荷待ちの案件を出荷完了にすると、ここへ移動します。";
    const action = hasQuery ? "clear-completed-filter" : currentPeriod ? "show-all-completed" : "show-active-orders";
    const actionLabel = hasQuery ? "検索を解除" : currentPeriod ? "すべての終了案件を見る" : "進行中の案件を見る";
    workspace.innerHTML = `<div class="empty-state">${icon(hasQuery ? "search" : "check")}<h3>${title}</h3><p>${copy}</p><button class="button button-secondary" type="button" data-action="${action}">${actionLabel}</button></div>`;
    return;
  }
  workspace.innerHTML = `<div class="order-table-wrap"><table class="order-table completed-table" aria-label="終了した案件">${orderTableHeader({ completed: true })}<tbody>${orderTableRows(jobs, { completed: true })}</tbody></table></div><div class="order-card-list">${orderCards(jobs, { completed: true })}</div>`;
  renderSortState(workspace, "completed");
}

function labelCandidateJobs() {
  const statusOrder = { reprint: 0, waiting: 1, printed: 2, not_required: 3 };
  return [...pendingJobs()].sort((a, b) => statusOrder[labelPrintStatus(a)] - statusOrder[labelPrintStatus(b)]
    || compareTextBlankLast(a.serialNo, b.serialNo)
    || compareTextBlankLast(a.dueDate, b.dueDate)
    || compareTextBlankLast(a.customer, b.customer));
}

function filteredLabelCandidateJobs() {
  const jobs = labelCandidateJobs();
  if (state.labelPrintFilter === "queue") return jobs.filter((job) => ["waiting", "reprint"].includes(labelPrintStatus(job)));
  if (state.labelPrintFilter === "printed") return jobs.filter((job) => labelPrintStatus(job) === "printed");
  return jobs;
}

function labelPrintStatusInfo(job) {
  const status = labelPrintStatus(job);
  const info = {
    waiting: { label: "印刷待ち", tone: "warning" },
    reprint: { label: "再印刷待ち", tone: "danger" },
    printed: { label: "印刷済み", tone: "success" },
    not_required: { label: "待ちに未登録", tone: "default" },
  }[status];
  return { status, ...info };
}

function selectedLabelJobs() {
  const jobsById = new Map(labelCandidateJobs().map((job) => [job.id, job]));
  return [...state.labelPrintSelection].map((id) => jobsById.get(id)).filter(Boolean);
}

function labelTitle(job) {
  const product = normalizeProductText(job.product) || "品名未設定";
  const shape = normalizeProductText(job.specShape);
  return shape && !product.includes(shape) ? `${product} ${shape}` : product;
}

function labelTextSizeClass(value) {
  const length = [...String(value || "")].length;
  if (length > 26) return "is-very-long";
  if (length > 17) return "is-long";
  return "";
}

function productLabelMarkup(job) {
  const title = labelTitle(job);
  const customer = normalizeProductText(job.customer) || "得意先未設定";
  const quantity = Number(job.quantity);
  const specs = [
    ["全長", formatLabelLength(job.specLength)],
    ["型", normalizeProductText(job.specShape) || "—"],
    ["刃幅", normalizeProductText(job.bladeWidth) || "—"],
    ["注文番号", normalizeProductText(job.serialNo) || "—"],
    ["数量", job.quantity === "" || job.quantity == null || !Number.isFinite(quantity) ? "—" : quantity.toLocaleString("ja-JP")],
    ["納期", formatLabelDate(job.dueDate), "is-due"],
  ];
  return `<article class="product-label" aria-label="${escapeHtml(`${customer} ${title}の製品ラベル`)}">
    <div class="label-primary-row"><strong class="label-customer ${labelTextSizeClass(customer)}">${escapeHtml(customer)}</strong><strong class="label-product-name ${labelTextSizeClass(title)}"><span>${escapeHtml(title)}</span></strong></div>
    <div class="label-spec-grid">${specs.map(([name, value, tone = ""]) => `<div class="label-spec-cell ${tone}"><span class="label-spec-name">${name}</span><strong class="label-spec-value">${escapeHtml(value)}</strong></div>`).join("")}</div>
  </article>`;
}

function renderLabelJobList() {
  const container = qs("#label-job-list");
  const query = normalizeProductText(state.labelPrintQuery).toLocaleLowerCase("ja");
  const jobs = filteredLabelCandidateJobs().filter((job) => !query || [job.customer, job.product, job.serialNo, job.specShape]
    .some((value) => normalizeProductText(value).toLocaleLowerCase("ja").includes(query)));
  const limitReached = state.labelPrintSelection.size >= LABEL_PRINT_LIMIT;
  if (!jobs.length) {
    const emptyCopy = state.labelPrintFilter === "queue"
      ? ["印刷待ちはありません", "取込内容を確認して案件へ反映すると、ここへ自動で追加されます。"]
      : ["条件に合う案件がありません", "表示範囲か検索語を変更してください。"];
    container.innerHTML = `<div class="label-job-empty"><strong>${emptyCopy[0]}</strong><span>${emptyCopy[1]}</span></div>`;
    return;
  }
  container.innerHTML = jobs.map((job) => {
    const selected = state.labelPrintSelection.has(job.id);
    const disabled = limitReached && !selected;
    const disabledText = disabled ? "（9件選択済みのため選択不可）" : "";
    const printStatus = labelPrintStatusInfo(job);
    const printedNote = printStatus.status === "printed" && job.labelPrintedAt ? ` · ${formatDateTime(job.labelPrintedAt)}` : "";
    return `<label class="label-job-option ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}">
      <input type="checkbox" data-label-job-id="${escapeHtml(job.id)}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="${escapeHtml(`${job.customer || "得意先未設定"} ${job.product || "品名未設定"}を印刷${disabledText}`)}">
      <span class="label-job-copy"><span class="label-job-title"><strong>${escapeHtml(job.product || "品名未設定")}</strong><span class="status-chip label-status-chip" data-tone="${printStatus.tone}">${printStatus.label}</span></span><span>${escapeHtml(job.customer || "得意先未設定")} · ${escapeHtml(job.serialNo || "連番未設定")} · 納期 ${escapeHtml(formatDate(job.dueDate))}${escapeHtml(printedNote)}</span></span>
    </label>`;
  }).join("");
}

function renderLabelSelectionState() {
  const selected = selectedLabelJobs();
  const count = selected.length;
  qs("#label-selection-count").textContent = `${count} / ${LABEL_PRINT_LIMIT}枚`;
  qs("#label-preview-list").innerHTML = count
    ? selected.map(productLabelMarkup).join("")
    : `<div class="label-preview-empty"><strong>印刷する案件を選んでください</strong><span>選択したラベルをここで確認できます。</span></div>`;
  qs("#label-print-sheet").innerHTML = selected.map(productLabelMarkup).join("");
  const printButton = qs("#print-labels-button");
  printButton.disabled = count === 0;
  printButton.setAttribute("aria-disabled", String(count === 0));
  qs("span", printButton).textContent = count ? `${count}枚を印刷` : "ラベルを印刷";
  qs("[data-action='clear-label-selection']").disabled = count === 0;
  renderLabelPrintConfirmation();
}

function renderLabelPrintConfirmation() {
  const panel = qs("#label-print-result");
  const count = state.labelPrintConfirmationVisible ? state.labelPrintPendingConfirmation.length : 0;
  panel.hidden = count === 0;
  if (count) qs("#label-print-result-count").textContent = `${count}件を印刷済みにすると、印刷待ちから外れます。`;
}

function clearLabelPrintConfirmation() {
  state.labelPrintPendingConfirmation = [];
  state.labelPrintConfirmationVisible = false;
  renderLabelPrintConfirmation();
}

function renderLabelPrintDialog() {
  const candidateIds = new Set(labelCandidateJobs().map((job) => job.id));
  state.labelPrintSelection.forEach((id) => {
    if (!candidateIds.has(id)) state.labelPrintSelection.delete(id);
  });
  renderLabelJobList();
  renderLabelSelectionState();
}

function openLabelPrintDialog() {
  state.labelPrintQuery = "";
  state.labelPrintFilter = "queue";
  state.labelPrintPendingConfirmation = [];
  state.labelPrintConfirmationVisible = false;
  state.labelPrintSelection = new Set(labelQueueJobs().slice(0, LABEL_PRINT_LIMIT).map((job) => job.id));
  qs("#label-search").value = "";
  qs("#label-status-filter").value = "queue";
  renderLabelPrintDialog();
  openDialog(qs("#label-dialog"));
}

function updateLabelSelection(checkbox) {
  const id = checkbox.dataset.labelJobId;
  if (checkbox.checked) {
    if (state.labelPrintSelection.size >= LABEL_PRINT_LIMIT) {
      checkbox.checked = false;
      announce("ラベルは一度に9枚まで選べます");
      return;
    }
    state.labelPrintSelection.add(id);
  } else {
    state.labelPrintSelection.delete(id);
  }
  state.labelPrintPendingConfirmation = [];
  state.labelPrintConfirmationVisible = false;
  renderLabelJobList();
  renderLabelSelectionState();
  qs(`[data-label-job-id='${CSS.escape(id)}']`)?.focus({ preventScroll: true });
  announce(`${state.labelPrintSelection.size}枚を選択中です`);
}

function clearLabelSelection() {
  state.labelPrintSelection.clear();
  state.labelPrintPendingConfirmation = [];
  state.labelPrintConfirmationVisible = false;
  renderLabelPrintDialog();
  qs("#label-search").focus({ preventScroll: true });
  announce("ラベルの選択を解除しました");
}

function printSelectedLabels() {
  const selected = selectedLabelJobs();
  const count = selected.length;
  if (!count) {
    announce("印刷する案件を選んでください");
    return;
  }
  state.labelPrintPendingConfirmation = selected.map((job) => ({ id: job.id, version: Number(job.version || 0) }));
  state.labelPrintConfirmationVisible = false;
  renderLabelPrintConfirmation();
  renderLabelSelectionState();
  document.body.classList.add("is-printing-labels");
  requestAnimationFrame(() => {
    try {
      window.print();
    } catch (error) {
      document.body.classList.remove("is-printing-labels");
      clearLabelPrintConfirmation();
      showToast("印刷画面を開けませんでした。ブラウザの印刷許可を確認してください。", { tone: "error" });
    }
  });
}

async function confirmLabelsPrinted(button) {
  const jobs = [...state.labelPrintPendingConfirmation];
  if (!jobs.length) return;
  setButtonState(button, "loading", "更新中");
  try {
    const updated = await api.markLabelsPrinted({ jobs });
    const byId = new Map(updated.map((job) => [job.id, job]));
    state.jobs = state.jobs.map((job) => byId.get(job.id) || job);
    state.labelPrintSelection.clear();
    state.labelPrintPendingConfirmation = [];
    state.labelPrintConfirmationVisible = false;
    state.lastSync = new Date().toISOString();
    renderAll();
    announce(`${updated.length}件を印刷済みにしました`);
  } catch (error) {
    showToast(`印刷状態を更新できませんでした。${error.message}`, { tone: "error" });
  } finally {
    setButtonState(button, null, "印刷済みにする");
  }
}

function renderIntake() {
  const container = qs("#intake-list");
  qs("#intake-bulk-entry").hidden = !state.intake.length;
  qs("#intake-pending-count").textContent = `確認待ち ${state.intake.length}件`;
  if (!state.intake.length) {
    container.innerHTML = `<div class="panel empty-state">${icon("inbox")}<h3>確認待ちはありません</h3><p>メールや画像を読み込むと、確認待ちとしてここへ追加されます。</p><button class="button button-primary" type="button" data-action="open-import">注文を取り込む</button></div>`;
    return;
  }
  container.innerHTML = state.intake.map((item) => {
    const parsed = item.parsed || {};
    const confidence = Math.round(Number(item.confidence || 0) * 100);
    return `<article class="intake-card">
      <div class="intake-card-head"><div><strong>${escapeHtml(item.subject || item.sourceRef || "注文情報")}</strong><p>${escapeHtml(item.sender || (item.sourceType === "text" ? "本文の貼り付けから取込" : "画像からの取込"))} · ${formatDateTime(item.receivedAt)}</p></div><div><span class="source-chip">${item.sourceType === "text" ? "貼り付け" : item.sourceType === "email" ? "メール" : "画像"}</span> <span class="confidence-chip" data-tone="${item.parsed?._ai ? "warning" : confidence >= 75 ? "success" : "warning"}">${item.parsed?._ai ? "AI・要確認" : `読取 ${confidence}%`}</span></div></div>
      <dl class="parsed-preview"><div><dt>得意先</dt><dd>${escapeHtml(parsed.customer || "未読取")}</dd></div><div><dt>品名</dt><dd>${escapeHtml(parsed.product || "未読取")}</dd></div><div><dt>大分類</dt><dd>${escapeHtml(parsed.category || classifyProductCategory(parsed.product) || "要確認")}</dd></div><div><dt>納期</dt><dd>${escapeHtml(parsed.dueDate || "未読取")}</dd></div><div><dt>数量</dt><dd>${escapeHtml(parsed.quantity || "未読取")}</dd></div></dl>
      <button class="button button-secondary" type="button" data-intake-id="${escapeHtml(item.id)}">内容を確認する</button>
    </article>`;
  }).join("");
}

function renderSettings() {
  if (state.settings.gmailQuery) qs("#gmail-query").value = state.settings.gmailQuery;
  const editorLink = qs("#script-editor-link");
  const validEditorUrl = /^https:\/\/script\.google\.com\/home\/projects\/[A-Za-z0-9_-]+\/edit$/.test(state.scriptEditorUrl);
  editorLink.hidden = !validEditorUrl;
  if (validEditorUrl) editorLink.href = state.scriptEditorUrl;
  else editorLink.removeAttribute("href");
  qs("#script-editor-unavailable").hidden = validEditorUrl;
  renderThemeSetting();
}

function switchView(view) {
  state.activeView = view;
  qsa("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  qsa("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  qs(".primary-nav").classList.remove("is-open");
  qs("[data-action='toggle-nav']").setAttribute("aria-expanded", "false");
  qs("#main-content").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function showOrders({ attention = "all", stage = "all" } = {}) {
  state.filters.orders = { query: "", stage, attention, sort: "priority" };
  qs("#orders-search").value = "";
  qs("#orders-stage-filter").value = stage;
  qs("#orders-attention-filter").value = attention;
  qs("#orders-sort").value = "priority";
  renderOrdersWorkspace();
  switchView("orders");
}

function showCompleted(period = "current") {
  state.filters.completed = { query: "", stage: "all", period, sort: "updated" };
  qs("#completed-search").value = "";
  qs("#completed-period").value = period;
  qs("#completed-sort").value = "updated";
  renderCompletedWorkspace();
  switchView("completed");
}

function openDialog(dialog, initialFocusSelector = "") {
  dialog._returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  qsa("body > header, body > main, body > footer").forEach((element) => { element.inert = true; });
  dialog.showModal();
  const first = (initialFocusSelector ? qs(initialFocusSelector, dialog) : null)
    || qs("input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled)", dialog)
    || qs("button:not(:disabled)", dialog);
  first?.focus({ preventScroll: true });
}

function closeDialog(dialog) {
  if (dialog.id === "bulk-intake-dialog" && bulkIntakeBusy) return;
  if (dialog.id === "intake-dialog" && intakeDeleteBusy) return;
  if (dialog.id === "customer-rules-dialog" && customerRulesBusy) return;
  if (dialog.open) dialog.close();
}

function restoreAfterDialogClose(dialog) {
  const pageRegions = qsa("body > header, body > main, body > footer");
  if (!dialog._returnFocus && !pageRegions.some((element) => element.inert)) return;
  pageRegions.forEach((element) => { element.inert = Boolean(qs("dialog[open]")); });
  const returnFocus = dialog._returnFocus;
  dialog._returnFocus = null;
  requestAnimationFrame(() => {
    const focusTarget = returnFocus?.isConnected && returnFocus.getClientRects().length
      ? returnFocus
      : qs("[data-view][aria-current='page']") || qs("#main-content");
    focusTarget?.focus({ preventScroll: true });
  });
}

function closeAssigneeMenus(except = null) {
  qsa(".assignee-picker.is-open", qs("#process-stage-editor")).forEach((picker) => {
    if (picker === except) return;
    picker.classList.remove("is-open");
    qs(".assignee-trigger", picker)?.setAttribute("aria-expanded", "false");
    const menu = qs(".assignee-menu", picker);
    if (menu) menu.hidden = true;
  });
}

function updateAssigneePicker(picker, assignee, { close = true } = {}) {
  const value = String(assignee || "").trim();
  qs(".stage-assignee-input", picker).value = value;
  qs(".assignee-trigger-label", picker).textContent = value ? `担当：${value}` : "担当を選ぶ";
  const summary = qs(".stage-edit-assignee", picker.closest(".stage-edit-row"));
  if (summary) summary.textContent = value || "担当未定";
  qsa(".assignee-option", picker).forEach((button) => {
    const selected = button.dataset.assignee === value;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (close) closeAssigneeMenus();
}

function renderStageEditor(job = {}, focusStageKey = "") {
  const stages = job.stages || {};
  qs("#process-stage-editor").innerHTML = STAGES.map((stage) => {
    const selected = stages[stage.key]?.status || "not_started";
    const assignee = stages[stage.key]?.assignee || "";
    const menuId = `assignee-menu-${stage.key}`;
    const expanded = stage.key === focusStageKey;
    return `<div class="stage-edit-row ${expanded ? "is-current" : ""}" data-stage-key="${stage.key}">
      <div class="stage-edit-head"><span class="stage-edit-label">${stage.label}</span><span class="stage-edit-assignee">${escapeHtml(assignee || "担当未定")}</span></div>
      <div class="stage-controls" role="group" aria-label="${stage.label}の状態">${STATUS_OPTIONS.map((option) => `<button class="stage-control ${selected === option.value ? "is-selected" : ""}" type="button" data-status="${option.value}" aria-pressed="${selected === option.value}">${option.label}</button>`).join("")}</div>
      <div class="assignee-picker ${expanded ? "is-open" : ""}">
        <input class="stage-assignee-input" type="hidden" value="${escapeHtml(assignee)}">
        <button class="assignee-trigger" type="button" aria-expanded="${expanded}" aria-controls="${menuId}"><span class="assignee-trigger-label">${assignee ? `担当：${escapeHtml(assignee)}` : "担当を選ぶ"}</span>${icon("chevron")}</button>
        <div class="assignee-menu" id="${menuId}" ${expanded ? "" : "hidden"}>
          <div class="assignee-menu-head"><strong>担当者</strong><span>10名をすべて表示</span></div>
          <div class="assignee-options" role="group" aria-label="${stage.label}の担当者">${ASSIGNEES.map((name) => `<button class="assignee-option ${assignee === name ? "is-selected" : ""}" type="button" data-assignee="${name}" aria-pressed="${assignee === name}">${name}</button>`).join("")}</div>
          <button class="assignee-clear" type="button">担当を未定に戻す</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function processFormAllStagesDone() {
  return qsa(".stage-edit-row", qs("#process-form")).every((row) => qs(".stage-control.is-selected", row)?.dataset.status === "done");
}

function renderProcessLifecycleAction() {
  const form = qs("#process-form");
  const button = qs("#process-lifecycle-action");
  const note = qs("#process-lifecycle-note");
  const shipped = form.dataset.shippingStatus === "shipped";
  const ready = processFormAllStagesDone();
  button.disabled = !shipped && !ready;
  button.setAttribute("aria-disabled", String(!shipped && !ready));
  button.dataset.action = shipped ? "reopen-order" : "complete-order";
  button.dataset.tone = shipped ? "reopen" : "complete";
  qs("span", button).textContent = shipped ? "進行中へ戻す" : "出荷完了・終了へ";
  note.textContent = shipped
    ? "終了リストに保存済みです。戻すと出荷待ちへ移動します。"
    : ready ? "出荷完了にすると終了リストへ移動します。" : "5工程をすべて完了すると、出荷完了にできます。";
}

function openOrderDialog(job = null) {
  const form = qs("#order-form");
  form.reset();
  qsa("[data-state]", form).forEach((field) => { delete field.dataset.state; });
  qsa("[data-auto-filled]", form).forEach((field) => { delete field.dataset.autoFilled; });
  qsa("[aria-invalid='true']", form).forEach((field) => field.removeAttribute("aria-invalid"));
  const baseValue = job || { stages: {}, priority: "normal", shippingStatus: "not_ready", labelPrintStatus: "not_required" };
  const productInference = inferOrderMetadata(baseValue.product);
  const value = { ...baseValue, ...inferOrderMetadata(baseValue.product, baseValue) };
  ["id", "version", "customer", "product", "dueDate", "quantity", "serialNo", "category", "priority", "labelPrintStatus", "specLength", "specShape", "bladeWidth", "note"].forEach((name) => {
    const field = form.elements[name];
    if (field) field.value = name === "labelPrintStatus" ? normalizeLabelPrintStatus(value[name]) : (value[name] ?? "");
  });
  ["category", "specLength", "specShape", "bladeWidth"].forEach((name) => {
    const field = form.elements[name];
    if (field && value[name] && value[name] === productInference[name]) field.dataset.autoFilled = "true";
  });
  qs("#order-dialog-title").textContent = job ? "案件を編集" : "案件を追加";
  qs("#order-dialog-kicker").textContent = job?.id || "新規案件";
  form.dataset.createdAt = job?.createdAt || "";
  form.dataset.sourceType = job?.sourceType || "manual";
  form.dataset.sourceRef = job?.sourceRef || "";
  form.dataset.shippingStatus = job?.shippingStatus || "not_ready";
  form._stages = Object.fromEntries(STAGES.map((stage) => [stage.key, {
    status: value.stages?.[stage.key]?.status || "not_started",
    assignee: value.stages?.[stage.key]?.assignee || "",
  }]));
  qs("#spec-auto-note").textContent = "品名に全長・型・刃幅があれば、空欄だけ自動補完します。";
  qs("#order-delete-action").hidden = !job;
  openDialog(qs("#order-dialog"), "[name='customer']");
}

function openProcessDialog(job, requestedStageKey = "") {
  if (!job) return;
  const form = qs("#process-form");
  form.reset();
  form.elements.id.value = job.id;
  form.elements.version.value = Number(job.version || 0);
  form.dataset.shippingStatus = job.shippingStatus || "not_ready";
  form.dataset.afterSaveView = "";
  form._jobBase = { ...job };
  const current = currentStage(job);
  const focusStageKey = STAGES.some((stage) => stage.key === requestedStageKey)
    ? requestedStageKey
    : STAGES.some((stage) => stage.key === current.key) ? current.key : STAGES[STAGES.length - 1].key;
  qs("#process-dialog-kicker").textContent = job.id || "工程更新";
  qs("#process-dialog-title").textContent = job.shippingStatus === "shipped" ? "終了案件の工程" : "工程と担当を更新";
  qs("#process-product").textContent = job.product || "品名未設定";
  qs("#process-customer").textContent = job.customer || "得意先未設定";
  qs("#process-due").textContent = job.dueDate ? formatDate(job.dueDate) : "未設定";
  qs("#process-serial").textContent = job.serialNo || "未設定";
  renderStageEditor(job, focusStageKey);
  renderProcessLifecycleAction();
  openDialog(qs("#process-dialog"), `.stage-edit-row[data-stage-key='${focusStageKey}'] .stage-control.is-selected`);
}

function validateOrderForm(form) {
  let valid = true;
  ["customer", "product"].forEach((name) => {
    const field = form.elements[name];
    const helper = qs(`[data-error-for='${name}']`, form);
    if (!field.value.trim()) {
      field.setAttribute("aria-invalid", "true");
      helper.textContent = `${name === "customer" ? "得意先" : "品名"}が未入力です。注文内容を確認して入力してください。`;
      helper.classList.add("is-error");
      valid = false;
    } else {
      field.removeAttribute("aria-invalid");
      helper.textContent = name === "customer" ? "注文元の名称" : "製作する品名";
      helper.classList.remove("is-error");
    }
  });
  return valid;
}

function orderFromForm(form) {
  applyProductInference(form);
  const values = Object.fromEntries(new FormData(form));
  Object.assign(values, inferOrderMetadata(values.product, values));
  return {
    ...values,
    quantity: values.quantity ? Number(values.quantity) : "",
    version: values.version ? Number(values.version) : 0,
    stages: form._stages || Object.fromEntries(STAGES.map((stage) => [stage.key, { status: "not_started", assignee: "" }])),
    shippingStatus: form.dataset.shippingStatus || "not_ready",
    createdAt: form.dataset.createdAt || "",
    sourceType: form.dataset.sourceType || "manual",
    sourceRef: form.dataset.sourceRef || "",
  };
}

async function saveOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!validateOrderForm(form)) {
    qs("[aria-invalid='true']", form)?.focus();
    announce("入力内容を確認してください");
    return;
  }
  const button = qs("button[type='submit']", form);
  const order = orderFromForm(form);
  const previous = state.jobs.find((job) => job.id === order.id);
  if (previous) {
    state.jobs = state.jobs.map((job) => job.id === order.id ? { ...job, ...order, updatedAt: new Date().toISOString() } : job);
    renderAll();
  }
  setButtonState(button, "loading", "保存中");
  try {
    const saved = await api.saveJob(order);
    const index = state.jobs.findIndex((job) => job.id === saved.id);
    if (index >= 0) state.jobs[index] = saved;
    else state.jobs.unshift(saved);
    state.lastSync = new Date().toISOString();
    renderAll();
    closeDialog(qs("#order-dialog"));
    announce("注文情報を保存しました");
  } catch (error) {
    if (previous) state.jobs = state.jobs.map((job) => job.id === previous.id ? previous : job);
    renderAll();
    showToast(`案件を保存できませんでした。${error.message}`, { tone: "error" });
  } finally {
    setButtonState(button, null, "注文情報を保存");
  }
}

function processFromForm(form) {
  const base = state.jobs.find((job) => job.id === form.elements.id.value) || form._jobBase;
  const stages = {};
  qsa(".stage-edit-row", form).forEach((row) => {
    const selected = qs(".stage-control.is-selected", row);
    const assignee = qs(".stage-assignee-input", row)?.value.trim() || "";
    stages[row.dataset.stageKey] = { status: selected?.dataset.status || "not_started", assignee };
  });
  return {
    ...base,
    id: form.elements.id.value,
    version: Number(form.elements.version.value || 0),
    stages,
    shippingStatus: form.dataset.shippingStatus || base?.shippingStatus || "not_ready",
  };
}

async function saveProcess(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = qs("button[type='submit']", form);
  const order = processFromForm(form);
  const previous = state.jobs.find((job) => job.id === order.id);
  if (!previous) {
    showToast("工程を保存できませんでした。案件が見つからないため、画面を更新してください。", { tone: "error" });
    return;
  }
  state.jobs = state.jobs.map((job) => job.id === order.id ? { ...job, ...order, updatedAt: new Date().toISOString() } : job);
  renderAll();
  setButtonState(button, "loading", "保存中");
  try {
    const saved = await api.saveJob(order);
    state.jobs = state.jobs.map((job) => job.id === saved.id ? saved : job);
    state.lastSync = new Date().toISOString();
    renderAll();
    closeDialog(qs("#process-dialog"));
    const destination = form.dataset.afterSaveView;
    if (destination) switchView(destination);
    announce(saved.shippingStatus === "shipped"
      ? "出荷完了として終了リストへ移動しました"
      : destination === "orders" ? "案件を出荷待ちへ戻しました" : "工程を保存しました");
  } catch (error) {
    state.jobs = state.jobs.map((job) => job.id === previous.id ? previous : job);
    renderAll();
    showToast(`工程を保存できませんでした。${error.message}`, { tone: "error" });
  } finally {
    setButtonState(button, null, "工程を保存");
  }
}

async function restoreDeletedOrder(job) {
  try {
    const restored = await api.setJobArchived({ id: job.id, version: job.version, archived: false });
    state.jobs = state.jobs.map((entry) => entry.id === restored.id ? restored : entry);
    renderAll();
    announce("削除した案件を元に戻しました");
  } catch (error) {
    showToast(`案件を元に戻せませんでした。${error.message}`, { tone: "error" });
  }
}

async function deleteOrder(button) {
  const form = qs("#order-form");
  const id = form.elements.id.value;
  const version = Number(form.elements.version.value || 0);
  const previous = state.jobs.find((job) => job.id === id);
  if (!previous) return;
  setButtonState(button, "loading", "削除中");
  state.jobs = state.jobs.map((job) => job.id === id ? { ...job, archived: true } : job);
  renderAll();
  closeDialog(qs("#order-dialog"));
  try {
    const archived = await api.setJobArchived({ id, version, archived: true });
    state.jobs = state.jobs.map((job) => job.id === archived.id ? archived : job);
    renderAll();
    announce("案件を削除しました");
    showToast("案件を一覧から削除しました。", {
      action: { label: "元に戻す", run: () => restoreDeletedOrder(archived) },
    });
  } catch (error) {
    state.jobs = state.jobs.map((job) => job.id === previous.id ? previous : job);
    renderAll();
    showToast(`案件を削除できませんでした。${error.message}`, { tone: "error" });
  } finally {
    setButtonState(button, null, "案件を削除");
  }
}

function handleSelectedFile(file) {
  qs("#file-import-error").hidden = true;
  qs("#file-import-error").textContent = "";
  state.selectedFile = file || null;
  const preview = qs("#file-preview");
  const upload = qs("[data-action='upload-image']");
  if (!file) {
    preview.hidden = true;
    preview.innerHTML = "";
    upload.disabled = true;
    return;
  }
  const size = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  preview.hidden = false;
  if (file.type.startsWith("image/")) {
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" alt="選択した注文画像のプレビュー"><p>${escapeHtml(file.name)} · ${size}</p>`;
  } else {
    preview.innerHTML = `<p>${escapeHtml(file.name)} · ${size}</p>`;
  }
  upload.disabled = false;
}

async function fileToPayload(file) {
  if (file.type === "application/pdf") {
    if (file.size > 8 * 1024 * 1024) throw new Error("PDFは8 MB以下にしてください。");
    return { name: file.name, mimeType: file.type, base64: await readAsBase64(file) };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.84));
  return { name: file.name.replace(/\.[^.]+$/, ".jpg"), mimeType: "image/jpeg", base64: await readAsBase64(blob) };
}

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("ファイルを読み込めませんでした。"));
    reader.readAsDataURL(blob);
  });
}

function waitForPdfJs(timeoutMs = 10000) {
  if (window.pdfjsLib?.getDocument) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("pdfjs-ready", handleReady);
      reject(new Error("PDF解析機能を読み込めませんでした。"));
    }, timeoutMs);
    function handleReady() {
      window.clearTimeout(timeout);
      if (window.pdfjsLib?.getDocument) resolve(window.pdfjsLib);
      else reject(new Error("PDF解析機能を初期化できませんでした。"));
    }
    window.addEventListener("pdfjs-ready", handleReady, { once: true });
  });
}

async function extractPdfTextInBrowser(file) {
  const pdfjs = await waitForPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join("\n"));
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages.join("\n\n").trim();
}

async function createIntakeFromSelectedFile(file) {
  if (qs("#import-engine").value === "ai") {
    return api.createIntakeWithAi(await fileToPayload(file));
  }
  if (isAppsScript && file.type === "application/pdf") {
    try {
      const text = await extractPdfTextInBrowser(file);
      if (text) {
        return api.createIntakeFromPdfText({ name: file.name, mimeType: file.type, text });
      }
    } catch (error) {
      console.warn("PDF内の文字を直接解析できなかったため、OCRへ切り替えます。", error);
    }
  }
  return api.createIntakeFromImage(await fileToPayload(file));
}

async function importPastedText(event) {
  event.preventDefault();
  if (state.textImportRunning || state.aiDiagnosticRunning) return;
  const form = event.currentTarget;
  const errorBox = qs("#text-import-error");
  errorBox.hidden = true;
  const text = qs("#text-import-body").value.trim();
  if (!text || text.length > 30000) {
    errorBox.textContent = "メール本文を1〜30,000文字で貼り付けてください。";
    errorBox.hidden = false;
    return;
  }
  if (!form.reportValidity()) return;
  const name = qs("#text-import-subject").value.trim();
  const engine = qs("#text-import-engine").value;
  state.textImportRunning = true;
  const controls = [...form.elements];
  const disabledStates = controls.map((control) => control.disabled);
  const button = qs("button[type='submit']", form);
  controls.forEach((control) => { control.disabled = true; });
  setButtonState(button, "loading", "本文を読取中");
  try {
    const result = await api.createIntakeFromText({ name, text, engine });
    // Clear only after successful registration; preserve pasted text on any failure.
    qs("#text-import-body").value = "";
    qs("#text-import-subject").value = "";
    closeDialog(qs("#import-dialog"));
    await refreshData({ quiet: true });
    switchView("intake");
    announce(`${result.added}件を確認待ちへ追加しました。全品目・数量・納期を確認してください。`);
  } catch (error) {
    errorBox.textContent = String(error.message || error).replace(/^Error:\s*/, "");
    errorBox.hidden = false;
    if (qs("#import-dialog").open) errorBox.scrollIntoView({ block: "nearest" });
  } finally {
    state.textImportRunning = false;
    setButtonState(button, null, "本文を読み取る");
    controls.forEach((control, index) => { control.disabled = disabledStates[index]; });
  }
}

async function diagnoseAi(button) {
  if (state.aiDiagnosticRunning || state.textImportRunning) return;
  state.aiDiagnosticRunning = true;
  const output = qs("#ai-diagnostic-result");
  output.hidden = false;
  const lines = [];
  let current = "1. 最小限の通信";
  setButtonState(button, "loading", "接続診断中");
  try {
    output.textContent = `${current}を確認中…（注文書は送信しません）`;
    const connection = await api.runAiDiagnosticStep({ step: "connection" });
    if (connection.accepted !== true) throw new Error("診断結果の形式が不正です。");
    lines.push(`${current}: HTTP 200（モデル ${connection.model}）`);
    output.textContent = lines.join("\n") + "\n10秒待って、アプリの回答形式を確認します。";
    await new Promise((resolve) => setTimeout(resolve, 10000));
    if (!qs("#import-dialog").open) {
      output.textContent = lines.join("\n") + "\n画面を閉じたため、2番目の診断は送信していません。";
      return;
    }
    current = "2. アプリの回答形式";
    output.textContent = lines.join("\n") + `\n${current}を確認中…`;
    const format = await api.runAiDiagnosticStep({ step: "format" });
    if (format.accepted !== true) throw new Error("診断結果の形式が不正です。");
    lines.push(`${current}: HTTP 200`);
    lines.push(format.outputValid ? "固定テスト文の読取も成功。PDF添付時だけの問題、または一時的な障害を次に確認します。実注文書の読取成功を保証する結果ではありません。" : format.message);
    output.textContent = lines.join("\n");
  } catch (error) {
    output.textContent = lines.concat(`${current}: 停止`, String(error.message || error).replace(/^Error:\s*/, ""), "後続テスト・自動再試行は行っていません。この診断結果を管理者へお知らせください。").join("\n");
  } finally {
    state.aiDiagnosticRunning = false;
    setButtonState(button, null, "注文書を送らず接続診断");
    if (qs("#import-dialog").open) output.scrollIntoView({ block: "nearest" });
  }
}

async function uploadImage(button) {
  if (state.aiDiagnosticRunning || state.textImportRunning) return;
  if (!state.selectedFile) return;
  qs("#file-import-error").hidden = true;
  setButtonState(button, "loading", "PDF・画像を読取中");
  try {
    const result = await createIntakeFromSelectedFile(state.selectedFile);
    closeDialog(qs("#import-dialog"));
    handleSelectedFile(null);
    await refreshData({ quiet: true });
    switchView("intake");
    announce(`${result?.added || 1}件を取込キューへ追加しました`);
  } catch (error) {
    const errorMessage = `PDF・画像を読み取れませんでした。${String(error.message || error).replace(/^Error:\s*/, "")}`;
    qs("#file-import-error").textContent = errorMessage;
    qs("#file-import-error").hidden = false;
    qs("#file-import-error").scrollIntoView({ block: "nearest" });
  } finally {
    setButtonState(button, null, "PDF・画像を読み取る");
  }
}

async function scanEmails(button) {
  if (state.aiDiagnosticRunning || state.textImportRunning) return;
  setButtonState(button, "loading", "受注メールを検索中");
  try {
    const result = await api.scanOrderEmails({ query: qs("#gmail-query").value, maxThreads: 20, engine: qs("#import-engine").value });
    closeDialog(qs("#import-dialog"));
    await refreshData({ quiet: true });
    switchView("intake");
    announce(`${result.added || 0}件を取込キューへ追加しました`);
    if (result.warnings?.length) showToast(result.warnings.join(" / "), { tone: "warning" });
  } catch (error) {
    showToast(error.message, { tone: "error" });
  } finally {
    setButtonState(button, null, "受注メールを検索");
  }
}

const BULK_INTAKE_FIELDS = [
  ["customer", "得意先", "text", true], ["product", "品名", "text", true],
  ["quantity", "数量", "number", true], ["dueDate", "納期", "date"],
  ["serialNo", "連番"], ["category", "大分類", "select"], ["specLength", "全長"],
  ["specShape", "型"], ["bladeWidth", "刃幅"], ["note", "備考"],
];
const bulkIntakeDrafts = new Map();
let bulkIntakeBusy = false;
let intakeDeleteBusy = false;
let pendingIntakeDeletion = null;
let customerRules = null;
let customerRulesBusy = false;
let pendingCustomerCorrection = null;

function defaultClientCustomerRules() {
  return { version: 0, ownCompanyNames: ["有限会社 興之宮医科工業"], aliases: [
    { issuer: "ミズホ株式会社", customer: "ミズホ" },
    { issuer: "ミズホ株式会社 五泉工場", customer: "ミズホ" },
    { issuer: "田中医科器械製作所", customer: "田中" },
  ] };
}

function customerNameKey(value) {
  return String(value).normalize("NFKC").replace(/\(株\)|\(有\)/g, "").replace(/株式会社|有限会社|合同会社|合資会社|合名会社/g, "").replace(/\s/g, "").replace(/[()（）\[\]［］{}｛｝]/g, "").replace(/(?:殿|御中)$/, "").toLowerCase();
}

function validateClientCustomerRules(rules) {
  if (!rules || !Array.isArray(rules.ownCompanyNames) || rules.ownCompanyNames.length > 20 || !Array.isArray(rules.aliases) || rules.aliases.length > 50) throw new Error("御社名は20件、発注元の対応は50件までです。");
  const name = (value) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 160 || !customerNameKey(value) || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value.trim())) throw new Error("会社名は1〜160文字で入力し、改行や制御文字を含めないでください。");
    return value.trim();
  };
  const ownCompanyNames = rules.ownCompanyNames.map(name);
  const own = new Set(ownCompanyNames.map(customerNameKey));
  if (own.size !== ownCompanyNames.length) throw new Error("御社名が重複しています。");
  const seen = new Set();
  const aliases = rules.aliases.map((rule) => {
    const issuer = name(rule?.issuer), customer = name(rule?.customer);
    const key = customerNameKey(issuer);
    if (issuer === customer) throw new Error("発注元と得意先が同じ表記です。変換後の名前を指定してください。");
    if (seen.has(key)) throw new Error("発注元が重複しています。同じ発注元の対応は1件にしてください。");
    if (own.has(key) || own.has(customerNameKey(customer))) throw new Error("御社名を発注元や得意先に指定することはできません。");
    seen.add(key);
    return { issuer, customer };
  });
  return { ownCompanyNames, aliases };
}

function parseCustomerCommand(text) {
  const match = String(text).trim().match(/^(?:選択(?:中|した)(?:の)?(?:品目)?(?:の)?)?得意先(?:名)?を\s*(.+?)\s*に(?:して(?:ください)?|変更(?:して(?:ください)?)?|統一(?:して(?:ください)?)?)[。！!]?$/);
  if (!match) throw new Error("得意先の修正に対応しています。「得意先をミズホにして」のように入力してください。対象はチェックした品目です。");
  const customer = match[1].replace(/^[「『"]|[」』"]$/g, "").trim();
  if (!customer || customer.length > 160 || /[\r\n、。！？!?;<>]|にして|に変更|に統一|数量を|納期を|品名を|削除/.test(customer)) throw new Error("一度に指定できるのは得意先の変更だけです。会社名を1つ指定してください。");
  return customer;
}

function setCustomerMessage(selector, text, tone = "") {
  const line = qs(selector);
  line.textContent = text;
  line.dataset.tone = tone;
}

function updateCustomerControls() {
  const locked = bulkIntakeBusy || Boolean(pendingIntakeDeletion?.bulk) || Boolean(pendingCustomerCorrection);
  const selected = [...bulkIntakeDrafts.values()].some((draft) => draft.selected);
  qsa(".customer-command-entry input, .customer-command-entry button, .customer-command [data-action='open-customer-rules']").forEach((el) => { el.disabled = locked; });
  qs("[data-action='preview-customer-command']").disabled = locked || !selected;
  qsa("#customer-command-preview input, #customer-command-preview button").forEach((el) => { el.disabled = bulkIntakeBusy; });
  qs("#customer-command-issuer-field").hidden = !qs("#customer-command-remember").checked;
}

function cancelCustomerCommand() {
  if (bulkIntakeBusy) return;
  pendingCustomerCorrection = null;
  qs("#customer-command-preview").hidden = true;
  updateBulkIntakeSelection();
}

function previewCustomerCommand() {
  if (bulkIntakeBusy || pendingIntakeDeletion || pendingCustomerCorrection) return;
  try {
    const customer = parseCustomerCommand(qs("#customer-command-input").value);
    const selected = [...bulkIntakeDrafts].filter(([, draft]) => draft.selected);
    if (!selected.length) throw new Error("修正する品目にチェックを付けてください。");
    if ((customerRules || defaultClientCustomerRules()).ownCompanyNames.some((name) => customerNameKey(name) === customerNameKey(customer))) throw new Error("御社名は得意先にできません。発注元を指定してください。");
    pendingCustomerCorrection = { ids: selected.map(([id]) => id), customer };
    qs("#customer-command-changes").innerHTML = selected.map(([, draft]) => `<li>${escapeHtml(draft.order.product || "品名未入力")}：${escapeHtml(draft.order.customer || "未入力")} → <strong>${escapeHtml(customer)}</strong></li>`).join("");
    qs("#customer-command-remember").checked = false;
    qs("#customer-command-issuer").value = (customerRules || defaultClientCustomerRules()).aliases.find((rule) => rule.customer === customer)?.issuer || "";
    qs("#customer-command-preview").hidden = false;
    setCustomerMessage("#customer-command-status", `選択した${selected.length}件の得意先を「${customer}」に変更します。まだ変更していません。`);
    updateBulkIntakeSelection();
    qs("[data-action='apply-customer-command']").focus();
  } catch (error) { setCustomerMessage("#customer-command-status", error.message, "error"); }
}

async function applyCustomerCommand() {
  if (!pendingCustomerCorrection || bulkIntakeBusy) return;
  const { ids, customer } = pendingCustomerCorrection;
  const remember = qs("#customer-command-remember").checked;
  bulkIntakeBusy = true;
  qs("#bulk-intake-form").setAttribute("aria-busy", "true");
  updateBulkIntakeSelection();
  try {
    const current = await api.getCustomerRules();
    if (current.ownCompanyNames.some((name) => customerNameKey(name) === customerNameKey(customer))) throw new Error("御社名は得意先にできません。発注元を指定してください。");
    if (remember) {
      const issuer = qs("#customer-command-issuer").value.trim();
      const aliases = current.aliases.filter((rule) => customerNameKey(rule.issuer) !== customerNameKey(issuer));
      aliases.push({ issuer, customer });
      const rules = validateClientCustomerRules({ ownCompanyNames: current.ownCompanyNames, aliases });
      // Compare against the rules shown when the editor opened; never silently overwrite another editor.
      const alreadyApplied = current.aliases.some((rule) => customerNameKey(rule.issuer) === customerNameKey(issuer) && rule.customer === customer);
      if (alreadyApplied) customerRules = current;
      else {
        if (customerRules && current.version !== customerRules.version) throw new Error("読取ルールが別の画面で更新されています。キャンセルして読取ルールを開き直してから再試行してください。");
        customerRules = await api.saveCustomerRules({ expectedVersion: current.version, rules });
      }
    } else customerRules = current;
    ids.forEach((id) => {
      const draft = bulkIntakeDrafts.get(id);
      if (draft) { draft.order.customer = customer; draft.error = ""; }
    });
    pendingCustomerCorrection = null;
    qs("#customer-command-preview").hidden = true;
    renderBulkIntake();
    setCustomerMessage("#customer-command-status", `${ids.length}件の得意先を「${customer}」に修正しました。${remember ? "次回のAI読取用ルールも保存しました。" : "次回の読取ルールは変更していません。"} 案件への保存は下の「案件へ反映」で行います。`, "success");
  } catch (error) {
    setCustomerMessage("#customer-command-status", `修正は未完了です。${error.message} 編集内容を保持しています。`, "error");
  } finally {
    bulkIntakeBusy = false;
    qs("#bulk-intake-form").setAttribute("aria-busy", "false");
    updateBulkIntakeSelection();
  }
}

function appendCustomerRuleRow(rule = { issuer: "", customer: "" }) {
  qs("#customer-rules-aliases").insertAdjacentHTML("beforeend", `<div class="customer-rule-row"><label class="field"><span>発注元の正式名</span><input data-rule-issuer maxlength="160" value="${escapeHtml(rule.issuer)}"></label><label class="field"><span>得意先に入れる名前</span><input data-rule-customer maxlength="160" value="${escapeHtml(rule.customer)}"></label><button class="button button-quiet" type="button" data-action="remove-customer-rule" aria-label="この発注元の対応を削除">削除</button></div>`);
}

async function loadCustomerRulesEditor() {
  if (customerRulesBusy) return;
  customerRulesBusy = true;
  const form = qs("#customer-rules-form");
  qsa("input, textarea, button", form).forEach((el) => { el.disabled = true; });
  form.dataset.loaded = "false";
  setCustomerMessage("#customer-rules-status", "読取ルールを読み込んでいます。");
  try {
    customerRules = await api.getCustomerRules();
    qs("#customer-rules-own").value = customerRules.ownCompanyNames.join("\n");
    qs("#customer-rules-aliases").innerHTML = "";
    customerRules.aliases.forEach(appendCustomerRuleRow);
    form.dataset.version = String(customerRules.version);
    form.dataset.loaded = "true";
    setCustomerMessage("#customer-rules-status", "保存すると、次回以降のAI取込に適用されます。");
  } catch (error) { setCustomerMessage("#customer-rules-status", `読取ルールを取得できません。${error.message}`, "error"); }
  finally {
    customerRulesBusy = false;
    qsa("input, textarea, button", form).forEach((el) => { el.disabled = false; });
    qs("button[type='submit']", form).disabled = form.dataset.loaded !== "true";
  }
}

function openCustomerRules() {
  if (bulkIntakeBusy || pendingIntakeDeletion || pendingCustomerCorrection) return;
  openDialog(qs("#customer-rules-dialog"));
  loadCustomerRulesEditor();
}

async function saveCustomerRulesEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (customerRulesBusy || form.dataset.loaded !== "true") return;
  try {
    const rules = validateClientCustomerRules({
      ownCompanyNames: qs("#customer-rules-own").value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean),
      aliases: qsa(".customer-rule-row").map((row) => ({ issuer: qs("[data-rule-issuer]", row).value, customer: qs("[data-rule-customer]", row).value })),
    });
    customerRulesBusy = true;
    qsa("input, textarea, button", form).forEach((el) => { el.disabled = true; });
    form.setAttribute("aria-busy", "true");
    customerRules = await api.saveCustomerRules({ expectedVersion: Number(form.dataset.version), rules });
    form.dataset.version = String(customerRules.version);
    setCustomerMessage("#customer-rules-status", "読取ルールを保存しました。次回のAI取込から適用します。", "success");
  } catch (error) { setCustomerMessage("#customer-rules-status", `保存できません。${error.message} 入力内容は保持しています。`, "error"); }
  finally {
    customerRulesBusy = false;
    form.setAttribute("aria-busy", "false");
    qsa("input, textarea, button", form).forEach((el) => { el.disabled = false; });
  }
}

function bulkOrderError(order) {
  if (!String(order.customer || "").trim()) return "得意先を入力してください。";
  if (!String(order.product || "").trim()) return "品名を入力してください。";
  const quantity = Number(order.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) return "数量を原本と確認し、1〜1,000,000の整数で入力してください。";
  if (order.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(order.dueDate) || !Number.isFinite(Date.parse(order.dueDate)) || new Date(order.dueDate).toISOString().slice(0, 10) !== order.dueDate)) return "納期を有効な日付で入力してください。";
  return "";
}

function openBulkIntake() {
  if (bulkIntakeBusy) return;
  cancelIntakeDeletion();
  cancelCustomerCommand();
  const pending = new Set(state.intake.map((item) => item.id));
  for (const id of bulkIntakeDrafts.keys()) if (!pending.has(id)) bulkIntakeDrafts.delete(id);
  state.intake.forEach((item) => {
    if (bulkIntakeDrafts.has(item.id)) return;
    const parsed = item.parsed || {};
    const order = { ...parsed, ...inferOrderMetadata(parsed.product, parsed) };
    bulkIntakeDrafts.set(item.id, { item, order, selected: true, error: "" });
  });
  qs("#bulk-intake-result").textContent = "";
  renderBulkIntake();
  openDialog(qs("#bulk-intake-dialog"), "#bulk-intake-all");
  api.getCustomerRules().then((rules) => { if (!customerRules || rules.version >= customerRules.version) customerRules = rules; }).catch(() => {});
}

function renderBulkIntake() {
  qs("#bulk-intake-rows").innerHTML = [...bulkIntakeDrafts].map(([id, draft], index) => {
    const fields = BULK_INTAKE_FIELDS.map(([key, label, type = "text", required]) => {
      const value = draft.order[key] ?? "";
      const attrs = `data-bulk-field="${key}" aria-label="品目${index + 1} ${label}" ${required ? "required aria-required='true'" : ""}`;
      const control = type === "select"
        ? `<select ${attrs}><option value="">未分類</option>${CATEGORY_OPTIONS.map((category) => `<option ${category === value ? "selected" : ""}>${category}</option>`).join("")}</select>`
        : `<input ${attrs} type="${type}" value="${escapeHtml(value)}" ${type === "number" ? 'min="1" max="1000000" step="1"' : ""}>`;
      return `<label class="field bulk-field-${key}"><span>${label}${required ? " <b>必須</b>" : ""}</span>${control}</label>`;
    }).join("");
    return `<section class="bulk-intake-row" data-bulk-id="${escapeHtml(id)}" aria-label="品目${index + 1}">
      <div class="bulk-row-heading"><label class="bulk-check"><input type="checkbox" data-bulk-select ${draft.selected ? "checked" : ""}><strong>品目${index + 1}</strong></label><span>${escapeHtml(draft.item.subject || draft.item.sourceRef || "注文情報")}</span><button class="button button-danger" type="button" data-action="delete-intake-row" aria-label="品目${index + 1}を削除">削除</button></div>
      <div class="bulk-fields">${fields}</div>
      <div class="bulk-row-bottom"><details><summary>読取元を確認</summary><pre>${escapeHtml(draft.item.originalText || "読取テキストはありません。")}</pre></details><p class="bulk-row-error" id="bulk-error-${index}" role="status">${escapeHtml(draft.error)}</p></div>
    </section>`;
  }).join("");
  updateBulkIntakeSelection();
}

function updateBulkIntakeSelection() {
  const locked = bulkIntakeBusy || Boolean(pendingIntakeDeletion?.bulk) || Boolean(pendingCustomerCorrection);
  const selected = [...bulkIntakeDrafts.values()].filter((draft) => draft.selected).length;
  const all = qs("#bulk-intake-all");
  all.disabled = locked || !bulkIntakeDrafts.size;
  all.checked = selected > 0 && selected === bulkIntakeDrafts.size;
  all.indeterminate = selected > 0 && selected < bulkIntakeDrafts.size;
  qs("#bulk-intake-count").textContent = `${bulkIntakeDrafts.size}件中 ${selected}件を選択`;
  const submit = qs("#bulk-intake-submit");
  submit.textContent = bulkIntakeBusy && !intakeDeleteBusy && !pendingCustomerCorrection ? "反映中…" : `${selected}件を案件へ反映`;
  submit.disabled = locked || selected === 0 || selected > 100;
  const deleteButton = qs("#bulk-intake-delete");
  deleteButton.textContent = intakeDeleteBusy ? "削除中…" : `選択した${selected}件を削除`;
  deleteButton.disabled = locked || selected === 0;
  qs("#bulk-intake-count").dataset.tone = selected > 100 ? "error" : "";
  qsa("[data-bulk-id]").forEach((row) => {
    const draft = bulkIntakeDrafts.get(row.dataset.bulkId);
    row.dataset.selected = String(draft.selected);
    qsa("[data-bulk-field]", row).forEach((input) => { input.disabled = locked || !draft.selected; });
    qsa("button, [data-bulk-select]", row).forEach((input) => { input.disabled = locked; });
  });
  updateCustomerControls();
}

async function approveBulkIntake(event) {
  event.preventDefault();
  if (bulkIntakeBusy || pendingIntakeDeletion || pendingCustomerCorrection) return;
  const selected = [...bulkIntakeDrafts].filter(([, draft]) => draft.selected);
  if (!selected.length || selected.length > 100) return;
  let firstInvalid = null;
  qsa("[data-bulk-id]").forEach((row) => {
    const draft = bulkIntakeDrafts.get(row.dataset.bulkId);
    draft.error = draft.selected ? bulkOrderError(draft.order) : "";
    const error = qs(".bulk-row-error", row);
    error.textContent = draft.error;
    qsa("[data-bulk-field]", row).forEach((input) => {
      const invalid = draft.selected && (!input.checkValidity() || (input.required && !input.value.trim()));
      input.setAttribute("aria-invalid", String(invalid));
      input.setAttribute("aria-describedby", error.id);
      if (invalid && !firstInvalid) firstInvalid = input;
    });
  });
  const resultLine = qs("#bulk-intake-result");
  if (selected.some(([, draft]) => draft.error) || firstInvalid) {
    resultLine.dataset.tone = "error";
    resultLine.textContent = "まだ反映していません。表示された不足・誤りを修正するか、その品目の選択を外してください。";
    firstInvalid?.focus();
    return;
  }
  bulkIntakeBusy = true;
  qs("#bulk-intake-form").setAttribute("aria-busy", "true");
  qsa("button, input[type=checkbox]", qs("#bulk-intake-form")).forEach((input) => { input.disabled = true; });
  updateBulkIntakeSelection();
  resultLine.dataset.tone = "";
  resultLine.textContent = "選択した注文を反映しています。このままお待ちください。";
  try {
    const response = await api.approveIntakes({ items: selected.map(([intakeId, draft]) => ({ intakeId, order: { ...draft.order, quantity: Number(draft.order.quantity) } })) });
    if (!Array.isArray(response?.items) || !Array.isArray(response?.errors)) throw new Error("保存結果を確認できません。再試行して結果を確認してください。");
    const savedIds = new Set();
    for (const { intakeId, job } of response.items) {
      if (!job?.id || !bulkIntakeDrafts.has(intakeId)) continue;
      savedIds.add(intakeId);
      bulkIntakeDrafts.delete(intakeId);
      state.jobs = state.jobs.filter((existing) => existing.id !== job.id);
      state.jobs.unshift(job);
    }
    state.intake = state.intake.filter((item) => !savedIds.has(item.id));
    response.errors.forEach(({ intakeId, message }) => {
      if (bulkIntakeDrafts.has(intakeId)) bulkIntakeDrafts.get(intakeId).error = message;
    });
    renderAll();
    renderBulkIntake();
    const remaining = selected.length - savedIds.size;
    resultLine.dataset.tone = remaining ? "error" : "success";
    resultLine.textContent = remaining
      ? `${savedIds.size}件を反映、${remaining}件は未完了です。編集内容は保持しています。下の表示を確認して再試行してください。`
      : `${savedIds.size}件を案件へ反映しました。ラベルも印刷待ちに追加しました。`;
    if (!bulkIntakeDrafts.size) {
      bulkIntakeBusy = false;
      closeDialog(qs("#bulk-intake-dialog"));
      switchView("orders");
      announce(`${savedIds.size}件の注文を案件へ反映しました`);
    }
  } catch (error) {
    resultLine.dataset.tone = "error";
    resultLine.textContent = `反映結果を確認できません。${error.message} 編集内容は保持しています。再試行しても同じ候補は二重登録しません。`;
  } finally {
    bulkIntakeBusy = false;
    qs("#bulk-intake-form").setAttribute("aria-busy", "false");
    qsa("button, input[type=checkbox]", qs("#bulk-intake-form")).forEach((input) => { input.disabled = false; });
    updateBulkIntakeSelection();
  }
}

function openIntakeDialog(item) {
  cancelIntakeDeletion();
  const form = qs("#intake-form");
  form.elements.intakeId.value = item.id;
  qs("#intake-source-preview").textContent = item.originalText || "読取テキストはありません。";
  const parsed = item.parsed || {};
  const quantityRequired = Boolean(parsed._ai) || item.sourceType === "text";
  const productInference = inferOrderMetadata(parsed.product);
  const fields = [
    ["customer", "得意先", true], ["product", "品名", true], ["dueDate", "納期", false, "date"],
    ["quantity", "数量", quantityRequired, "number"], ["serialNo", "連番"], ["category", "大分類", false, "category"], ["specLength", "全長"],
    ["specShape", "型"], ["bladeWidth", "刃幅"], ["note", "備考"],
  ];
  qs("#intake-fields").innerHTML = fields.map(([name, label, required, type = "text"]) => {
    const value = name === "category" ? (parsed.category || classifyProductCategory(parsed.product)) : (parsed[name] || "");
    const autoFilled = ["category", "specLength", "specShape", "bladeWidth"].includes(name) && value && value === productInference[name];
    const control = type === "category"
      ? `<select name="category" ${autoFilled ? "data-auto-filled='true'" : ""}><option value="">未分類（要確認）</option>${CATEGORY_OPTIONS.map((category) => `<option value="${category}" ${category === value ? "selected" : ""}>${category}</option>`).join("")}</select>`
      : `<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${name === "quantity" && quantityRequired ? 'min="1" max="1000000" step="1"' : ""} ${required ? "required aria-required='true'" : ""} ${autoFilled ? "data-auto-filled='true'" : ""}>`;
    return `<label class="field"><span>${label}${required ? " <b>必須</b>" : ""}</span>${control}<small>${value ? "読取・推定結果。必要なら修正してください。" : "読み取れませんでした。確認して入力してください。"}</small></label>`;
  }).join("");
  openDialog(qs("#intake-dialog"));
}

async function approveIntake(event) {
  event.preventDefault();
  if (intakeDeleteBusy || pendingIntakeDeletion) return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = qs("button[type='submit']", form);
  const values = Object.fromEntries(new FormData(form));
  const intakeId = values.intakeId;
  delete values.intakeId;
  Object.assign(values, inferOrderMetadata(values.product, values));
  values.quantity = values.quantity ? Number(values.quantity) : "";
  values.priority = "normal";
  values.shippingStatus = "not_ready";
  values.labelPrintStatus = "waiting";
  values.stages = Object.fromEntries(STAGES.map((stage) => [stage.key, { status: "not_started", assignee: "" }]));
  setButtonState(button, "loading", "反映中");
  try {
    const saved = await api.approveIntake({ intakeId, order: values });
    state.intake = state.intake.filter((item) => item.id !== intakeId);
    state.jobs.unshift(saved);
    renderAll();
    closeDialog(qs("#intake-dialog"));
    switchView("orders");
    announce("確認した注文を案件へ反映しました");
  } catch (error) {
    showToast(`案件へ反映できませんでした。${error.message}`, { tone: "error" });
  } finally {
    setButtonState(button, null, "確認して案件へ反映");
  }
}

function requestIntakeDeletion(ids, bulk, trigger) {
  if (intakeDeleteBusy || bulkIntakeBusy || pendingIntakeDeletion || pendingCustomerCorrection || !ids.length) return;
  const dialog = qs(bulk ? "#bulk-intake-dialog" : "#intake-dialog");
  const panel = qs("[data-intake-delete-confirm]", dialog);
  const product = bulk ? bulkIntakeDrafts.get(ids[0])?.order.product : qs("#intake-form").elements.product.value;
  pendingIntakeDeletion = { ids, bulk, dialog, trigger };
  if (bulk) qs("#bulk-intake-result").textContent = "";
  qs("p", panel).textContent = ids.length === 1
    ? `「${product || "品名未入力"}」を取込候補から削除しますか？削除した品目は確認待ちに戻せません。`
    : `選択した${ids.length}件を取込候補から削除しますか？削除した品目は確認待ちに戻せません。`;
  panel.hidden = false;
  if (bulk) updateBulkIntakeSelection();
  else qsa("input, select, footer button", dialog).forEach((input) => { input.disabled = true; });
  qs("[data-action='cancel-intake-delete']", panel).focus();
}

function cancelIntakeDeletion() {
  if (intakeDeleteBusy) return;
  const pending = pendingIntakeDeletion;
  pendingIntakeDeletion = null;
  qsa("[data-intake-delete-confirm]").forEach((panel) => { panel.hidden = true; });
  if (pending?.bulk) updateBulkIntakeSelection();
  else if (pending) qsa("input, select, footer button", pending.dialog).forEach((input) => { input.disabled = false; });
  if (pending?.dialog.open && pending.trigger?.isConnected) pending.trigger.focus();
}

async function confirmIntakeDeletion() {
  if (!pendingIntakeDeletion || intakeDeleteBusy) return;
  const pending = pendingIntakeDeletion;
  const { ids, bulk, dialog } = pending;
  const panel = qs("[data-intake-delete-confirm]", dialog);
  const resultLine = bulk ? qs("#bulk-intake-result") : qs("p", panel);
  const deleted = new Set();
  const errors = new Map();
  intakeDeleteBusy = true;
  if (bulk) bulkIntakeBusy = true;
  qs("form", dialog).setAttribute("aria-busy", "true");
  qsa("button, input, select", dialog).forEach((input) => { input.disabled = true; });
  resultLine.dataset.tone = "";
  resultLine.textContent = `${ids.length}件を削除しています。このままお待ちください。`;
  try {
    // 全選択が100件を超える場合も、APIの上限に合わせて順に処理する。
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const response = await api.rejectIntakes({ intakeIds: batch });
      if (!Array.isArray(response?.items) || !Array.isArray(response?.errors)) throw new Error("削除結果を確認できません。再試行してください。");
      for (const { intakeId } of response.items) {
        if (!batch.includes(intakeId)) continue;
        deleted.add(intakeId);
        bulkIntakeDrafts.delete(intakeId);
      }
      state.intake = state.intake.filter((item) => !deleted.has(item.id));
      for (const { intakeId, message } of response.errors) {
        if (batch.includes(intakeId)) errors.set(intakeId, message);
      }
      for (const intakeId of batch) {
        if (!deleted.has(intakeId) && !errors.has(intakeId)) errors.set(intakeId, "削除結果を確認できません。再試行してください。");
      }
    }
  } catch (error) {
    for (const intakeId of ids) {
      if (!deleted.has(intakeId) && !errors.has(intakeId)) errors.set(intakeId, `削除結果を確認できません。${error.message}`);
    }
  } finally {
    intakeDeleteBusy = false;
    if (bulk) bulkIntakeBusy = false;
    pendingIntakeDeletion = null;
    qs("form", dialog).setAttribute("aria-busy", "false");
    qsa("button, input, select", dialog).forEach((input) => { input.disabled = false; });
    errors.forEach((message, id) => { if (bulkIntakeDrafts.has(id)) bulkIntakeDrafts.get(id).error = message; });
    renderAll();
    if (bulk) renderBulkIntake();
    panel.hidden = true;
    const remaining = ids.length - deleted.size;
    const message = remaining
      ? `${deleted.size}件を削除、${remaining}件は未完了です。編集内容は保持しています。${errors.values().next().value || "表示を確認して再試行してください。"}`
      : `${deleted.size}件を取込候補から削除しました。`;
    if (bulk) {
      resultLine.dataset.tone = remaining ? "error" : "success";
      resultLine.textContent = message;
    } else if (remaining) showToast(message, { tone: "error" });
    if ((bulk && !bulkIntakeDrafts.size) || (!bulk && !remaining)) closeDialog(dialog);
    else if (dialog.open) (bulk ? qs("#bulk-intake-all") : qs("[data-action='reject-intake']", dialog)).focus();
    announce(message);
  }
}

async function saveSettings(button) {
  setButtonState(button, "loading", "保存中");
  try {
    state.settings = await api.saveSettings({ gmailQuery: qs("#gmail-query").value.trim() });
    setButtonState(button, "success", "保存済み");
    setTimeout(() => setButtonState(button, null, "検索条件を保存"), 1800);
  } catch (error) {
    setButtonState(button, "error", "保存できません");
    showToast(error.message, { tone: "error" });
  }
}

async function migrateSheet(button) {
  const sheetName = qs("#legacy-sheet-name").value.trim();
  if (!sheetName) {
    qs("#legacy-sheet-name").setAttribute("aria-invalid", "true");
    qs("#legacy-sheet-name").focus();
    return;
  }
  qs("#legacy-sheet-name").removeAttribute("aria-invalid");
  setButtonState(button, "loading", "読込中");
  try {
    const result = await api.migrateLegacySheet({ sheetName });
    await refreshData({ quiet: true });
    announce(`${result.imported || 0}件を読み込みました`);
    setButtonState(button, "success", `${result.imported || 0}件を読込済み`);
    setTimeout(() => setButtonState(button, null, "既存表を読み込む"), 2200);
  } catch (error) {
    setButtonState(button, "error", "読込できません");
    showToast(error.message, { tone: "error" });
  }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".assignee-picker")) closeAssigneeMenus();

    const viewButton = event.target.closest("[data-view]");
    if (viewButton) switchView(viewButton.dataset.view);

    const themeChoice = event.target.closest("[data-theme-choice]");
    if (themeChoice) {
      applyTheme(themeChoice.dataset.themeChoice);
      announce(`${themeChoice.textContent.trim()}へ切り替えました`);
    }

    const processTarget = event.target.closest("[data-action='open-process'][data-order-id]");
    if (processTarget) {
      const job = state.jobs.find((entry) => entry.id === processTarget.dataset.orderId);
      if (job) openProcessDialog(job, processTarget.dataset.stageKey);
      return;
    }

    const orderTarget = event.target.closest("[data-action='edit-order'][data-order-id]");
    if (orderTarget) {
      const job = state.jobs.find((entry) => entry.id === orderTarget.dataset.orderId);
      if (job) openOrderDialog(job);
      return;
    }

    const intakeTarget = event.target.closest("[data-intake-id]");
    if (intakeTarget) {
      const item = state.intake.find((entry) => entry.id === intakeTarget.dataset.intakeId);
      if (item) openIntakeDialog(item);
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    const button = event.target.closest("button");
    const actions = {
      "toggle-nav": () => {
        const nav = qs(".primary-nav");
        nav.classList.toggle("is-open");
        button.setAttribute("aria-expanded", String(nav.classList.contains("is-open")));
      },
      "open-import": () => openDialog(qs("#import-dialog")),
      "close-import-dialog": () => closeDialog(qs("#import-dialog")),
      "open-label-print": () => openLabelPrintDialog(),
      "close-label-dialog": () => closeDialog(qs("#label-dialog")),
      "clear-label-selection": () => clearLabelSelection(),
      "print-labels": () => printSelectedLabels(),
      "keep-label-waiting": () => clearLabelPrintConfirmation(),
      "confirm-label-printed": () => confirmLabelsPrinted(button),
      "new-order": () => openOrderDialog(),
      "close-order-dialog": () => closeDialog(qs("#order-dialog")),
      "close-process-dialog": () => closeDialog(qs("#process-dialog")),
      "delete-order": () => deleteOrder(button),
      "close-intake-dialog": () => closeDialog(qs("#intake-dialog")),
      "open-bulk-intake": () => openBulkIntake(),
      "close-bulk-intake": () => closeDialog(qs("#bulk-intake-dialog")),
      "delete-selected-intakes": () => requestIntakeDeletion([...bulkIntakeDrafts].filter(([, draft]) => draft.selected).map(([id]) => id), true, button),
      "delete-intake-row": () => requestIntakeDeletion([button.closest("[data-bulk-id]").dataset.bulkId], true, button),
      "confirm-intake-delete": () => confirmIntakeDeletion(),
      "cancel-intake-delete": () => cancelIntakeDeletion(),
      "preview-customer-command": () => previewCustomerCommand(),
      "cancel-customer-command": () => cancelCustomerCommand(),
      "apply-customer-command": () => applyCustomerCommand(),
      "open-customer-rules": () => openCustomerRules(),
      "close-customer-rules": () => closeDialog(qs("#customer-rules-dialog")),
      "reload-customer-rules": () => loadCustomerRulesEditor(),
      "add-customer-rule": () => { if (!customerRulesBusy) appendCustomerRuleRow(); },
      "remove-customer-rule": () => { if (!customerRulesBusy) button.closest(".customer-rule-row").remove(); },
      "refresh": () => refreshData(),
      "show-all-orders": () => showOrders(),
      "show-production-orders": () => showOrders({ attention: "production" }),
      "show-due-orders": () => showOrders({ attention: "due" }),
      "show-shipping-orders": () => showOrders({ attention: "shipping" }),
      "show-active-orders": () => showOrders({ attention: "production" }),
      "show-current-completed": () => showCompleted("current"),
      "show-all-completed": () => showCompleted("all"),
      "clear-completed-filter": () => {
        state.filters.completed.query = "";
        qs("#completed-search").value = "";
        renderCompletedWorkspace();
      },
      "clear-filters": () => {
        state.filters.dashboard = { query: "", stage: "all", sort: "priority" };
        state.filters.orders = { query: "", stage: "all", attention: "all", sort: "priority" };
        qs("#dashboard-search").value = "";
        qs("#orders-search").value = "";
        qs("#dashboard-stage-filter").value = "all";
        qs("#orders-stage-filter").value = "all";
        qs("#orders-attention-filter").value = "all";
        qs("#dashboard-sort").value = "priority";
        qs("#orders-sort").value = "priority";
        renderDashboardOrders();
        renderOrdersWorkspace();
      },
      "complete-order": () => {
        const form = qs("#process-form");
        if (!processFormAllStagesDone()) {
          announce("すべての工程を完了にしてください");
          return;
        }
        form.dataset.shippingStatus = "shipped";
        form.dataset.afterSaveView = "completed";
        form.requestSubmit();
      },
      "reopen-order": () => {
        const form = qs("#process-form");
        form.dataset.shippingStatus = "waiting";
        form.dataset.afterSaveView = "orders";
        form.requestSubmit();
      },
      "upload-image": () => uploadImage(button),
      "scan-email": () => scanEmails(button),
      "diagnose-ai": () => diagnoseAi(button),
      "reject-intake": () => requestIntakeDeletion([qs("#intake-form").elements.intakeId.value], false, button),
      "save-settings": () => saveSettings(button),
      "migrate-sheet": () => migrateSheet(button),
    };
    actions[action]?.();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAssigneeMenus();
  });

  qs("#order-form").addEventListener("submit", saveOrder);
  qs("#process-form").addEventListener("submit", saveProcess);
  qs("#intake-form").addEventListener("submit", approveIntake);
  qs("#bulk-intake-form").addEventListener("submit", approveBulkIntake);
  qs("#customer-rules-form").addEventListener("submit", saveCustomerRulesEditor);
  qs("#customer-rules-dialog").addEventListener("cancel", (event) => { if (customerRulesBusy) event.preventDefault(); });
  qs("#customer-command-remember").addEventListener("change", updateCustomerControls);
  qs("#customer-command-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); previewCustomerCommand(); }
  });
  qs("#customer-command-issuer").addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
  qs("#bulk-intake-dialog").addEventListener("close", cancelCustomerCommand);
  qs("#bulk-intake-dialog").addEventListener("cancel", (event) => { if (bulkIntakeBusy) event.preventDefault(); });
  qs("#intake-dialog").addEventListener("cancel", (event) => { if (intakeDeleteBusy) event.preventDefault(); });
  ["#bulk-intake-dialog", "#intake-dialog"].forEach((selector) => qs(selector).addEventListener("close", cancelIntakeDeletion));
  qs("#bulk-intake-all").addEventListener("change", (event) => {
    if (bulkIntakeBusy || pendingIntakeDeletion || pendingCustomerCorrection) return;
    bulkIntakeDrafts.forEach((draft) => { draft.selected = event.target.checked; });
    qsa("[data-bulk-select]").forEach((input) => { input.checked = event.target.checked; });
    updateBulkIntakeSelection();
  });
  qs("#bulk-intake-rows").addEventListener("input", (event) => {
    const row = event.target.closest("[data-bulk-id]");
    if (!row || bulkIntakeBusy || pendingIntakeDeletion || pendingCustomerCorrection) return;
    const draft = bulkIntakeDrafts.get(row.dataset.bulkId);
    if (event.target.matches("[data-bulk-select]")) {
      draft.selected = event.target.checked;
      updateBulkIntakeSelection();
    } else if (event.target.dataset.bulkField) {
      draft.order[event.target.dataset.bulkField] = event.target.value;
      event.target.removeAttribute("aria-invalid");
      draft.error = "";
      qs(".bulk-row-error", row).textContent = "";
    }
  });
  qs("#text-import-form").addEventListener("submit", importPastedText);

  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-label-job-id]")) updateLabelSelection(event.target);
  });

  qs("#label-search").addEventListener("input", debounce((event) => {
    state.labelPrintQuery = event.target.value;
    renderLabelJobList();
  }, 180));

  qs("#label-status-filter").addEventListener("change", (event) => {
    state.labelPrintFilter = event.target.value;
    state.labelPrintPendingConfirmation = [];
    state.labelPrintConfirmationVisible = false;
    renderLabelJobList();
    renderLabelPrintConfirmation();
    announce(`${event.target.selectedOptions[0]?.textContent || "指定範囲"}を表示しました`);
  });

  qs("#process-stage-editor").addEventListener("click", (event) => {
    const picker = event.target.closest(".assignee-picker");
    const trigger = event.target.closest(".assignee-trigger");
    if (trigger && picker) {
      const willOpen = trigger.getAttribute("aria-expanded") !== "true";
      closeAssigneeMenus(picker);
      picker.classList.toggle("is-open", willOpen);
      trigger.setAttribute("aria-expanded", String(willOpen));
      qs(".assignee-menu", picker).hidden = !willOpen;
      return;
    }

    const option = event.target.closest(".assignee-option");
    if (option && picker) {
      updateAssigneePicker(picker, option.dataset.assignee);
      return;
    }

    const clear = event.target.closest(".assignee-clear");
    if (clear && picker) {
      updateAssigneePicker(picker, "");
      return;
    }

    const control = event.target.closest(".stage-control");
    if (!control) return;
    const group = control.closest(".stage-controls");
    qsa(".stage-control", group).forEach((button) => {
      const selected = button === control;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const processForm = qs("#process-form");
    if (processForm.dataset.shippingStatus === "shipped" && control.dataset.status !== "done") {
      processForm.dataset.shippingStatus = "waiting";
      processForm.dataset.afterSaveView = "orders";
    }
    renderProcessLifecycleAction();
  });

  const filters = [
    ["#dashboard-search", "dashboard", "query", renderDashboardOrders],
    ["#dashboard-stage-filter", "dashboard", "stage", renderDashboardOrders],
    ["#dashboard-sort", "dashboard", "sort", renderDashboardOrders],
    ["#orders-search", "orders", "query", renderOrdersWorkspace],
    ["#orders-stage-filter", "orders", "stage", renderOrdersWorkspace],
    ["#orders-attention-filter", "orders", "attention", renderOrdersWorkspace],
    ["#orders-sort", "orders", "sort", renderOrdersWorkspace],
    ["#completed-search", "completed", "query", renderCompletedWorkspace],
    ["#completed-period", "completed", "period", renderCompletedWorkspace],
    ["#completed-sort", "completed", "sort", renderCompletedWorkspace],
  ];
  filters.forEach(([selector, scope, key, render]) => {
    const element = qs(selector);
    const handler = debounce(() => {
      state.filters[scope][key] = element.value;
      render();
      announce(key === "sort"
        ? `${filteredJobs(scope).length}件を${element.selectedOptions[0]?.textContent || "指定順"}に並び替えました`
        : `${filteredJobs(scope).length}件に絞り込みました`);
    }, key === "query" ? 250 : 0);
    element.addEventListener(key === "query" ? "input" : "change", handler);
  });

  [qs("#order-form"), qs("#intake-form")].forEach((form) => {
    form.addEventListener("focusout", (event) => {
      if (event.target?.name === "product") applyProductInference(form, { announceResult: true });
    });
    form.addEventListener("input", (event) => {
      if (event.target?.dataset?.state) delete event.target.dataset.state;
      if (["category", "specLength", "specShape", "bladeWidth"].includes(event.target?.name)) delete event.target.dataset.autoFilled;
    });
    form.addEventListener("change", (event) => {
      if (["category", "specLength", "specShape", "bladeWidth"].includes(event.target?.name)) delete event.target.dataset.autoFilled;
    });
  });

  qsa("[data-import-tab]").forEach((tab) => tab.addEventListener("click", () => {
    qsa("[data-import-tab]").forEach((button) => {
      const selected = button === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    qs("#import-image-panel").hidden = tab.dataset.importTab !== "image";
    qs("#import-email-panel").hidden = tab.dataset.importTab !== "email";
    qs("#import-text-panel").hidden = tab.dataset.importTab !== "text";
    qs("#file-import-engine-field").hidden = tab.dataset.importTab === "text";
    qs("#file-import-notice").hidden = tab.dataset.importTab === "text";
  }));

  qs(".import-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = qsa("[data-import-tab]");
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus({ preventScroll: true });
    tabs[next].click();
  });

  qs("#image-input").addEventListener("change", (event) => handleSelectedFile(event.target.files[0]));
  qs("#import-engine").addEventListener("change", (event) => { event.target.dataset.chosen = "true"; });
  const dropZone = qs("#drop-zone");
  ["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  }));
  dropZone.addEventListener("drop", (event) => handleSelectedFile(event.dataTransfer.files[0]));

  qsa("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  }));
  qsa("dialog").forEach((dialog) => dialog.addEventListener("cancel", (event) => { if (!event.defaultPrevented) restoreAfterDialogClose(dialog); }));
  qsa("dialog").forEach((dialog) => dialog.addEventListener("close", () => restoreAfterDialogClose(dialog)));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshData({ quiet: true });
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "auto") renderThemeSetting();
  });

  window.addEventListener("afterprint", () => {
    document.body.classList.remove("is-printing-labels");
    state.labelPrintConfirmationVisible = state.labelPrintPendingConfirmation.length > 0;
    renderLabelPrintConfirmation();
  });

  if (!isAppsScript && api.channel) {
    api.channel.addEventListener("message", () => refreshData({ quiet: true }));
  }
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function init() {
  applyTheme(state.theme, { persist: false });
  renderSkeletons();
  bindEvents();
  await refreshData();
  setInterval(() => {
    if (document.visibilityState === "visible") refreshData({ quiet: true });
  }, 20000);
}

init();
