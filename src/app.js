const STAGES = [
  { key: "welding", label: "溶接", short: "溶" },
  { key: "base", label: "元作り", short: "元" },
  { key: "grinding", label: "浮き止め～立ち上がり", short: "浮" },
  { key: "heat", label: "厚みとり", short: "厚" },
  { key: "finish", label: "仕上げ", short: "仕" },
];

const STAGE_ASSIGNEE_SETTINGS = STAGES.flatMap((stage) => stage.key === "heat"
  ? [stage, { key: "heatSharp", label: "頭付け・幅取り" }]
  : [stage]);

const ASSIGNEES = ["豊", "幹", "望", "鈴", "河", "誠", "小", "保", "大", "順"];

const CATEGORY_OPTIONS = ["鋭匙鉗子", "ケリソンパンチ"];
const CATEGORY_SORT_ORDER = Object.fromEntries(CATEGORY_OPTIONS.map((name, index) => [name, index]));
const NATURAL_COLLATOR = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

const THEME_STORAGE_KEY = "production-board-theme";
const LEDGER_STORAGE_KEY = "production-board-ledger-display-v1";
const SORT_STORAGE_KEY = "production-board-sort-v1";
const JOB_SORT_KEYS = ["customer", "product", "productCode", "serial", "due", "quantity", "updated", "priority", "category"];
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
  stageAssigneeSettingsDirty: false,
  stageAssigneeSettingsSaving: false,
  mode: "loading",
  aiImport: { ready: false, configured: false },
  scriptEditorUrl: "",
  access: { email: "", isAdmin: false },
  accessSettings: null,
  accessSettingsDraft: null,
  accessSettingsDirty: false,
  accessSettingsSaving: false,
  accessSettingsRevision: 0,
  accessRevoked: false,
  lastSync: null,
  selectedFile: null,
  aiDiagnosticRunning: false,
  textImportRunning: false,
  legacyImportPreview: null,
  legacyImportBusy: false,
  labelPrintSelection: new Set(),
  labelPrintQuery: "",
  labelPrintFilter: "queue",
  labelPrintPendingConfirmation: [],
  labelPrintConfirmationVisible: false,
  labelPrintSaving: false,
  labelPrintSaveRevision: 0,
  distributionMonth: "",
  distributionEndMonth: "",
  distributionFilter: "all",
  distributionSort: "customer",
  distributionIncludeShipped: false,
  distributionAssigneeSettingsDirty: false,
  distributionAssigneeSettingsSaving: false,
  distributionSettingsSaveRevision: 0,
  distributionSaving: new Set(),
  distributionSaveRevision: 0,
  distributionSaveMessage: "担当者を選ぶと自動で保存します。",
  polishingFilter: "vendor",
  polishingQuery: "",
  polishingSelection: new Map(),
  polishingSaving: new Set(),
  polishingSaveRevision: 0,
  polishingRetry: null,
  polishingSaveMessage: "",
  productMasterStatus: null,
  materialInventory: null,
  materialInventoryRevision: 0,
  productMetadataRevision: 0,
  orderSaving: false,
  polishingRulesSaving: new Set(),
  polishingCustomRateDrafts: new Map(),
  polishingBillingMonth: "",
  polishingRatesDirty: false,
  polishingRatesSaving: false,
  polishingRatesMessage: "",
  polishingRatesBase: null,
  printMode: "",
  activeView: "orders",
  ledgerDisplay: readStoredLedgerDisplay(),
  theme: readStoredTheme(),
  filters: {
    dashboard: { query: "", stage: "all", sort: "customer" },
    orders: { query: "", stage: "all", attention: "all", ...readStoredJobSort("orders") },
    shipping: { query: "", stage: "all", ...readStoredJobSort("shipping") },
    completed: { query: "", stage: "all", period: "current", ...readStoredJobSort("completed") },
  },
};

const ROLE_OPTIONS = [
  { value: "admin", label: "管理者" },
  { value: "editor", label: "編集者" },
  { value: "worker", label: "作業員" },
  { value: "viewer", label: "閲覧のみ" },
];

function accessRole(access = state.access) {
  if (["owner", "admin", "editor", "worker", "viewer"].includes(access?.role)) return access.role;
  return access?.isOwner ? "owner" : access?.isAdmin ? "admin" : access?.canEdit ? "editor" : "viewer";
}

function isAdminUser(access = state.access) {
  return Boolean(access?.isAdmin || ["owner", "admin"].includes(accessRole(access)));
}

function isOwnerUser(access = state.access) {
  return Boolean(access?.isOwner || accessRole(access) === "owner");
}

function canEdit(access = state.access) {
  return ["owner", "admin", "editor"].includes(accessRole(access)) && access?.canEdit !== false;
}

function isWorkerUser(access = state.access) {
  return accessRole(access) === "worker";
}

function canWork(access = state.access) {
  return ["owner", "admin", "editor", "worker"].includes(accessRole(access)) && access?.canWork !== false;
}

function canWorkOnJob(job) {
  return Boolean(job && !job.archived && canWork() && (canEdit()
    || (job.shippingStatus !== "shipped" && !isDone(job))));
}

function canAccessView(view, access = state.access) {
  if (["materials", "finishedStock"].includes(view)) return canEdit(access);
  if (isWorkerUser(access)) return ["orders", "shipping", "distribution", "completed", "settings"].includes(view);
  return ["dashboard", "orders", "shipping", "distribution", "polishing", "completed", "settings"].includes(view) || (view === "intake" && canEdit(access));
}

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

const backgroundOperations = new Map();
const pendingJobMutations = new Map();
const failedOrderDrafts = new Map();
const failedPolishingAttempts = new Map();
let mutationRevision = 0;
let snapshotLoading = false;
let appliedSnapshotRevision = 0;

function renderBackgroundActivity() {
  const panel = qs("#background-activity");
  if (!panel) return;
  panel.hidden = !backgroundOperations.size || state.accessRevoked;
  const message = qs("#background-activity-message");
  if (message) message.textContent = backgroundOperations.size === 1
    ? [...backgroundOperations.values()][0]
    : `${backgroundOperations.size}件の変更を反映中…`;
}

function trackApiMutations(target) {
  const labels = {
    saveJob: "注文・工程を保存中…", saveJobProcess: "工程を保存中…", setJobArchived: "案件の削除・復元を反映中…",
    savePolishingMovement: "研磨の変更を反映中…", savePolishingEventDate: "研磨の日付を反映中…", setDistributionAssignee: "配布担当を保存中…",
    rejectIntakes: "取込候補を削除中…", rejectIntake: "取込候補を削除中…",
    approveIntake: "注文を反映中…", approveIntakes: "注文をまとめて反映中…", markLabelsPrinted: "印刷状態を保存中…",
    saveSettings: "設定を保存中…", savePolishingProductRule: "研磨設定を保存中…", savePolishingRates: "単価を保存中…",
    saveCustomerRules: "読取ルールを保存中…", saveAccessSettings: "利用者設定を保存中…",
    receiveFinishedStock: "Tezoe製品を在庫へ受入中…", shipFinishedStock: "Tezoe製品の出庫を反映中…",
    saveFinishedStockSchedule: "Tezoe製品の出荷予定を保存中…",
    openFinishedStock: "Tezoe製品の開始在庫を保存中…", reverseFinishedStock: "Tezoe製品の在庫履歴を訂正中…",
    saveMaterialOrder: "材料の発注を保存中…", receiveMaterialOrder: "材料の入庫を反映中…",
    adjustMaterialStock: "材料の在庫調整を反映中…", cancelMaterialOrder: "材料の発注残を取り消し中…",
  };
  Object.entries(labels).forEach(([method, label]) => {
    const original = target[method];
    if (typeof original !== "function") return;
    target[method] = function(...args) {
      const token = {};
      backgroundOperations.set(token, label);
      mutationRevision += 1;
      renderBackgroundActivity();
      const finish = () => {
        backgroundOperations.delete(token);
        mutationRevision += 1;
        renderBackgroundActivity();
      };
      try {
        return Promise.resolve(original.apply(this, args)).then((result) => {
          if (["saveJob", "approveIntake", "approveIntakes"].includes(method)) invalidateMaterialInventory();
          if (["saveJob", "saveJobProcess", "setJobArchived", "approveIntake", "approveIntakes", "receiveFinishedStock", "shipFinishedStock", "openFinishedStock", "reverseFinishedStock", "saveFinishedStockSchedule"].includes(method)) invalidateFinishedStock();
          return result;
        }).finally(finish);
      }
      catch (error) { finish(); throw error; }
    };
  });
  return target;
}

function jobMutationPending(id) {
  return pendingJobMutations.has(id) || pendingProcessSaves.has(id) || state.polishingSaving.has(id) || state.distributionSaving.has(id);
}

function setStartupState(error = "") {
  const panel = qs("#startup-loading");
  if (!panel) return;
  const visible = state.mode === "loading" && !state.accessRevoked;
  panel.hidden = !visible;
  panel.setAttribute?.("aria-busy", String(!error));
  document.body?.classList.toggle("is-starting", visible);
  qsa("body > header, body > main, body > footer").forEach((element) => { element.inert = visible; });
  if (!visible) return;
  qs("#startup-title").textContent = error ? "読み込みができませんでした" : "ロード中…";
  qs("#startup-message").textContent = error || "工程一覧と利用権限を確認しています。";
  qs("#startup-retry").hidden = !error;
}

class AppsScriptApi {
  call(method, payload = {}) {
    return new Promise((resolve, reject) => {
      let restored = false;
      const send = () => window.google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(async (error) => {
          const message = error?.message || String(error);
          if (message.includes("ACCESS_DENIED:") && !restored && window.AppAccessSession?.hasCredential()) {
            restored = true;
            try {
              const result = await window.AppAccessSession.restore();
              if (result?.ok) { send(); return; }
            } catch {
              reject(new Error("接続を復元できませんでした。通信状態を確認して、もう一度お試しください。"));
              return;
            }
          }
          if (message.includes("ACCESS_DENIED:")) handleAccessRequired();
          const failure = new Error(message.replace(/(?:ACCESS_DENIED|WORKER_REQUIRED|EDITOR_REQUIRED|ADMIN_REQUIRED|OWNER_REQUIRED|FINISHED_STOCK_INVALID):\s*/g, ""));
          if (message.includes("FINISHED_STOCK_INVALID:")) failure.code = "FINISHED_STOCK_INVALID";
          reject(failure);
        })
        [method](payload);
      send();
    });
  }

  getSnapshot(payload) { return this.call("getSnapshot", payload); }
  saveJob(payload) { return this.call("saveJob", payload); }
  saveJobProcess(payload) { return this.call("saveJobProcess", payload); }
  setDistributionAssignee(payload) { return this.call("setDistributionAssignee", payload); }
  savePolishingMovement(payload) { return this.call("savePolishingMovement", payload); }
  savePolishingEventDate(payload) { return this.call("savePolishingEventDate", payload); }
  savePolishingProductRule(payload) { return this.call("savePolishingProductRule", payload); }
  savePolishingRates(payload) { return this.call("savePolishingRates", payload); }
  refreshProductMaster() { return this.call("refreshProductMaster"); }
  getMaterialInventory() { return this.call("getMaterialInventory"); }
  getFinishedStock() { return this.call("getFinishedStock"); }
  receiveFinishedStock(payload) { return this.call("receiveFinishedStock", payload); }
  shipFinishedStock(payload) { return this.call("shipFinishedStock", payload); }
  openFinishedStock(payload) { return this.call("openFinishedStock", payload); }
  reverseFinishedStock(payload) { return this.call("reverseFinishedStock", payload); }
  saveFinishedStockSchedule(payload) { return this.call("saveFinishedStockSchedule", payload); }
  saveMaterialOrder(payload) { return this.call("saveMaterialOrder", payload); }
  receiveMaterialOrder(payload) { return this.call("receiveMaterialOrder", payload); }
  adjustMaterialStock(payload) { return this.call("adjustMaterialStock", payload); }
  cancelMaterialOrder(payload) { return this.call("cancelMaterialOrder", payload); }
  setJobArchived(payload) { return this.call("setJobArchived", payload); }
  createIntakeFromImage(payload) { return this.call("createIntakeFromImage", payload); }
  createIntakeFromPdfText(payload) { return this.call("createIntakeFromPdfText", payload); }
  createIntakeFromText(payload) { return this.call("createIntakeFromText", payload); }
  createIntakeWithAi(payload) { return this.call("createIntakeWithAi", payload); }
  getIntakeLearningRules() { return this.call("getIntakeLearningRules"); }
  forgetIntakeLearningRule(payload) { return this.call("forgetIntakeLearningRule", payload); }
  runAiDiagnosticStep(payload) { return this.call("runAiDiagnosticStep", payload); }
  scanOrderEmails(payload) { return this.call("scanOrderEmails", payload); }
  approveIntake(payload) { return this.call("approveIntake", payload); }
  approveIntakes(payload) { return this.call("approveIntakes", payload); }
  markLabelsPrinted(payload) { return this.call("markLabelsPrinted", payload); }
  rejectIntake(payload) { return this.call("rejectIntake", payload); }
  rejectIntakes(payload) { return this.call("rejectIntakes", payload); }
  saveSettings(payload) { return this.call("saveSettings", payload); }
  getAccessSettings() { return this.call("getAccessSettings"); }
  saveAccessSettings(payload) { return this.call("saveAccessSettings", payload); }
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
    if (globalThis.MaterialInventory) {
      const data = this.read();
      if (this.ensureMaterialEvents(data)) this.write(data);
    }
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

  ensureMaterialEvents(data) {
    if (!globalThis.MaterialInventory) return false;
    data.materialEvents ||= [];
    const missing = MaterialInventory.openingEvents({ actor: "owner@example.com" })
      .filter((event) => !data.materialEvents.some((saved) => saved.id === event.id));
    data.materialEvents.push(...missing);
    return missing.length > 0;
  }

  localMaterialSnapshot(data) {
    return globalThis.MaterialInventory
      ? MaterialInventory.snapshot({ jobs: data.jobs, events: data.materialEvents || [] }) : null;
  }

  async getFinishedStock() {
    if (!canEdit() || state.accessRevoked) throw new Error("編集権限が必要です。");
    if (!globalThis.FinishedStock) throw new Error("Tezoe製品在庫を読み込み直してください。");
    const data = this.read();
    return FinishedStock.snapshot({ jobs: data.jobs, events: data.finishedStockEvents || [] });
  }

  async mutateFinishedStock(action, payload) {
    if (!canEdit() || state.accessRevoked) throw new Error("編集権限が必要です。");
    const commit = () => {
      if (!canEdit() || state.accessRevoked) throw new Error("編集権限が必要です。");
      if (!globalThis.FinishedStock) throw new Error("Tezoe製品在庫を読み込み直してください。");
      const data = this.read();
      const events = data.finishedStockEvents || [];
      const prepared = FinishedStock.prepareMutation(action, payload, {
        jobs: data.jobs, events, at: new Date().toISOString(),
        actor: state.access.email || "owner@example.com", id: `STOCK-${crypto.randomUUID()}`,
      });
      if (prepared.event) {
        data.finishedStockEvents = [...events, prepared.event];
        data.jobs = data.jobs.map((job) => job.completionKind === "stock_fulfillment" && job.shippingStatus === "shipped" && !FinishedStock.fulfillment(job, data.finishedStockEvents)
          ? { ...job, shippingStatus: "not_ready", completionKind: "", completedAt: "", version: job.version + 1, updatedAt: new Date().toISOString() } : job);
        this.write(data);
      }
      return FinishedStock.snapshot({ jobs: data.jobs, events: data.finishedStockEvents || events });
    };
    if (globalThis.navigator?.locks) return navigator.locks.request(`${this.storageKey}:intake-approval`, commit);
    return commit();
  }

  receiveFinishedStock(payload) { return this.mutateFinishedStock("receive", payload); }
  shipFinishedStock(payload) { return this.mutateFinishedStock("ship", payload); }
  openFinishedStock(payload) { return this.mutateFinishedStock("opening", payload); }
  reverseFinishedStock(payload) { return this.mutateFinishedStock("reverse", payload); }
  saveFinishedStockSchedule(payload) { return this.mutateFinishedStock("schedule", payload); }

  async getMaterialInventory() {
    if (state.access.role && !canEdit()) throw new Error("編集権限が必要です。");
    const data = this.read();
    if (this.ensureMaterialEvents(data)) this.write(data);
    return this.localMaterialSnapshot(data);
  }

  async mutateMaterial(action, payload) {
    if (state.access.role && !canEdit()) throw new Error("編集権限が必要です。");
    const commit = () => {
      if (!globalThis.MaterialInventory) throw new Error("材料管理を読み込み直してください。");
      const data = this.read();
      this.ensureMaterialEvents(data);
      const prepared = MaterialInventory.prepareMutation(action, payload, {
        events: data.materialEvents, at: new Date().toISOString(),
        actor: state.access.email || "owner@example.com", id: `MAT-${crypto.randomUUID()}`,
      });
      if (prepared.event) data.materialEvents.push(prepared.event);
      this.write(data);
      return this.localMaterialSnapshot(data);
    };
    if (globalThis.navigator?.locks) return navigator.locks.request(`${this.storageKey}:intake-approval`, commit);
    return commit();
  }

  saveMaterialOrder(payload) { return this.mutateMaterial("order", payload); }
  receiveMaterialOrder(payload) { return this.mutateMaterial("receive", payload); }
  adjustMaterialStock(payload) { return this.mutateMaterial("adjust", payload); }
  cancelMaterialOrder(payload) { return this.mutateMaterial("cancel", payload); }

  async getSnapshot() {
    await delay(120);
    const data = this.read();
    const aiImport = await fetch("/api/local/ai-status").then((response) => response.ok ? response.json() : { ready: false }).catch(() => ({ ready: false }));
    const metadata = await this.productMetadata(data);
    data.jobs = metadata.jobs;
    data.productMasterStatus = metadata.productMasterStatus;
    const projectInfo = await fetch("/api/local/project-info").then((response) => response.ok ? response.json() : {}).catch(() => ({}));
    delete data.finishedStockEvents;
    return { ...data, materialInventory: this.localMaterialSnapshot(data), aiImport, access: { email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true }, accessSettings: await this.getAccessSettings(), scriptEditorUrl: projectInfo.scriptEditorUrl || "", mode: "demo", serverTime: new Date().toISOString(), setupRequired: false };
  }

  async productMetadata(data) {
    const response = await fetch("/api/local/product-metadata", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jobs:data.jobs,settings:data.settings,labelRuleRequest:data.labelRuleRequest,existingJob:data.existingJob})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "製品マスタを読み込めませんでした。");
    return result;
  }

  async refreshProductMaster() { return this.productMetadata(this.read()); }

  async savePolishingProductRule(payload) {
    const data = this.read(), metadata = await this.productMetadata(data);
    const job = metadata.jobs.find((entry) => entry.id === payload.id);
    if (!job || Number(job.version) !== Number(payload.version)) throw new Error("案件が更新されています。再読み込みしてください。");
    const rules = parsePolishingSetting(data.settings.polishingProductRules), key = job.productMaster.key;
    const existing = rules[key] || null;
    if (JSON.stringify(existing) !== JSON.stringify(payload.expectedRule)) throw new Error("研磨設定が更新されています。再読み込みしてください。");
    const rule = { ...(existing || {}) };
    delete rule.wheelLever;
    delete rule.meniscus;
    if (!["", ...POLISHING_CLASSES].includes(payload.classCode)) throw new Error("研磨区分が不正です。");
    if (Object.hasOwn(payload, "customRates")) {
      if (payload.customRates === undefined) throw new Error("自由設定の単価形式が不正です。");
      rule.customRates = normalizeCustomPolishingRates(payload.customRates);
    }
    if (payload.classCode) rule.classCode = payload.classCode;
    else delete rule.classCode;
    if (rule.classCode === "自由設定") rule.customRates = normalizeCustomPolishingRates(rule.customRates);
    if (Object.hasOwn(rule, "classCode")) rules[key] = {...rule,updatedAt:new Date().toISOString(),productCode:job.productCode || "",product:job.product,customer:job.customer};
    else delete rules[key];
    data.settings.polishingProductRules = JSON.stringify(rules); this.write(data);
    return {...await this.productMetadata(data),settings:data.settings};
  }

  async savePolishingRates(payload) {
    const data = this.read(), all = parsePolishingSetting(data.settings.polishingRates), current = all[payload.month] || null;
    if (JSON.stringify(current) !== JSON.stringify(payload.expectedRates)) throw new Error("単価が更新されています。再読み込みしてください。");
    all[payload.month] = payload.rates;
    data.settings.polishingRates = JSON.stringify(all); this.write(data);
    return data.settings;
  }

  async getAccessSettings() {
    const saved = this.read().accessSettings || {};
    const users = saved.users || (saved.emails || []).map((email) => ({ email, role: "editor" }));
    return { emails: users.map((user) => user.email), users, version: 0, ...saved, adminEmail: "owner@example.com", emailVerificationReady: true };
  }

  async saveAccessSettings(payload) {
    const current = await this.getAccessSettings();
    if (payload.version !== current.version) throw new Error("別の画面で設定が変更されています。再読み込みしてください。");
    const users = normalizeAccessUsers(payload.users);
    const settings = { ...current, users, emails: users.map((user) => user.email), version: current.version + 1 };
    const data = this.read();
    data.accessSettings = settings;
    this.write(data);
    return settings;
  }

  async saveJob(payload) {
    if (globalThis.navigator?.locks) return navigator.locks.request(`${this.storageKey}:intake-approval`, () => this.saveJobUnlocked(payload));
    return this.saveJobUnlocked(payload);
  }

  async saveJobUnlocked(payload, { processOnly = false } = {}) {
    await delay(220);
    if (processOnly && (!canWork() || state.accessRevoked)) throw new Error("工程を更新する権限がありません。");
    const data = this.read();
    if ((payload.shippingStatus === "shipped" || data.jobs.some(job => job.id === payload.id && job.shippingStatus === "shipped")) && (!canEdit() || state.accessRevoked)) throw new Error("出荷完了・再開には編集権限が必要です。");
    const now = new Date().toISOString();
    const materialRequestHash = globalThis.MaterialInventory?.jobRequestHash(payload);
    const retried = globalThis.MaterialInventory?.findRequest(data.jobs, payload.requestId, materialRequestHash);
    if (retried) return retried;
    payload = { ...payload, ...inferOrderMetadata(payload.product, payload) };
    const index = data.jobs.findIndex((job) => job.id === payload.id);
    const previous = index >= 0 ? data.jobs[index] : null;
    if (!previous && Number(payload.version || 0) > 0) throw new Error("案件が見つかりません。画面を更新してください。");
    if (previous?.archived) throw new Error("削除済みの案件は更新できません。");
    if (previous && Number(previous.version || 0) !== Number(payload.version || 0)) throw new Error("別の端末で先に更新されています。画面を更新してください。");
    payload.stockPlannedQuantity = validateFinishedStockPlan(payload, previous, data.finishedStockEvents || []);
    if (globalThis.FinishedStock?.needsJobValidation(payload, previous) && previous?.shippingStatus !== "shipped" && payload.shippingStatus === "shipped") {
      const order = FinishedStock.snapshot({ jobs: data.jobs, events: data.finishedStockEvents || [] }).orders?.find((entry) => entry.jobId === previous?.id);
      FinishedStock.validateShipmentCompletion(order, payload);
    }
    const polishing = previous?.polishing || { sentQuantity: 0, returnedQuantity: 0, history: [] };
    const nextForPolishing = { ...payload, polishing };
    const fulfillment = previous && !previous.archived && payload.shippingStatus === "shipped"
      ? globalThis.FinishedStock?.fulfillment(nextForPolishing, data.finishedStockEvents || []) : null;
    if (Number(payload.quantity) < polishing.sentQuantity) throw new Error("数量を研磨に出した数量より少なくできません。");
    if (fulfillment) {
      if (!canEdit() || state.accessRevoked) throw new Error("受注履行完了には編集権限が必要です。");
      if (stageStatus(payload, "finish") === "done") throw new Error("製造不要の受注は最終仕上げを完了にせず、受注履行完了を記録してください。");
    } else {
      if (payload.shippingStatus === "shipped" && previous?.completionKind === "stock_fulfillment") throw new Error("有効な在庫出荷が注文数量を満たしていません。受注を再開して出荷履歴を確認してください。");
      if (invalidFinalFinishing(nextForPolishing, previous)) throw new Error("研磨から全数戻るまで最終仕上げを完了にできません。");
      if (payload.shippingStatus === "shipped" && stageStatus(payload, "finish") !== "done") throw new Error("出荷完了にするには、最終仕上げを完了にしてください。");
    }
    const completed = payload.shippingStatus === "shipped";
    const wasCompleted = previous?.shippingStatus === "shipped";
    const requestedLabelStatus = normalizeLabelPrintStatus(payload.labelPrintStatus ?? previous?.labelPrintStatus);
    const saved = {
      ...payload,
      polishing,
      id: payload.id || `DEMO-${String(Date.now()).slice(-6)}`,
      version: Number(payload.version || 0) + 1,
      createdAt: payload.createdAt || now,
      updatedAt: now,
      sourceType: payload.sourceType || "manual",
      sourceRef: payload.sourceRef || "ローカル入力",
      archived: false,
      completedAt: fulfillment ? new Date(`${fulfillment.date}T00:00:00+09:00`).toISOString() : completed ? (wasCompleted ? previous.completedAt || "" : now) : "",
      completionKind: fulfillment ? "stock_fulfillment" : "",
      labelPrintStatus: requestedLabelStatus,
      distributionAssignee: payload.distributionAssignee ?? previous?.distributionAssignee ?? "",
      labelPrintedAt: requestedLabelStatus === "printed" ? (previous?.labelPrintedAt || now) : "",
    };
    if (previous?.labelPrintStatus === "printed" && saved.labelPrintStatus !== "not_required" && labelContentChanged(previous, saved)) {
      saved.labelPrintStatus = "reprint";
      saved.labelPrintedAt = "";
    }
    let labelMetadata;
    if (typeof fetch === "function") {
      labelMetadata = await this.productMetadata({ jobs: [saved], settings: data.settings, labelRuleRequest: payload, existingJob: previous });
      if (labelMetadata.productLabelRules !== undefined) data.settings.productLabelRules = labelMetadata.productLabelRules;
      if (labelMetadata.labelRuleChanged && previous?.labelPrintStatus === "printed" && saved.labelPrintStatus !== "not_required") {
        saved.labelPrintStatus = "reprint"; saved.labelPrintedAt = "";
      }
    }
    delete saved.productLabelRule;
    delete saved.requestId;
    delete saved.materialsJson;
    delete saved.finishedStockEvents;
    if (globalThis.MaterialInventory) saved.materials = MaterialInventory.transitionJob(previous, saved, {
      at: now, actor: state.access.email || "owner@example.com", requestId: payload.requestId, requestHash: materialRequestHash,
    });
    if (index >= 0) data.jobs[index] = saved;
    else data.jobs.unshift(saved);
    this.write(data);
    return labelMetadata ? {...saved,productMaster:labelMetadata.jobs[0].productMaster,...(labelMetadata.productLabelRules !== undefined ? {productLabelRules:labelMetadata.productLabelRules} : {})} : saved;
  }

  async saveJobProcess(payload) {
    const commit = async () => {
      if (!canWork() || state.accessRevoked) throw new Error("工程を更新する権限がありません。");
      if (Object.keys(payload).some(key => !["id", "version", "stages", "shippingStatus", "requestId"].includes(key))) throw new Error("工程更新に許可されていない項目があります。");
      const previous = this.read().jobs.find(job => job.id === payload.id && !job.archived);
      if (!previous) throw new Error("案件が見つかりません。画面を更新してください。");
      const identity = processSaveIdentity(payload);
      const previousSave = previous._processSaveJsonRaw ? JSON.parse(previous._processSaveJsonRaw) : null;
      if (payload.requestId && previousSave?.requestId === payload.requestId) {
        if (previousSave.identity !== identity) throw new Error("同じリクエストIDで異なる工程を保存できません。");
        return previous;
      }
      if (Number(previous.version || 0) !== Number(payload.version || 0)) throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
      if (!canWorkOnJob(previous)) throw new Error("出荷待ち・出荷済みの案件を更新するには編集権限が必要です。");
      const shippingStatus = payload.shippingStatus || previous.shippingStatus || "not_ready";
      if (!canEdit() && shippingStatus !== (previous.shippingStatus || "not_ready")) throw new Error("出荷状態を更新するには編集権限が必要です。");
      return this.saveJobUnlocked({ ...previous, stages: { ...previous.stages, ...payload.stages }, shippingStatus, requestId: payload.requestId,
        _processSaveJsonRaw: payload.requestId ? JSON.stringify({ requestId: payload.requestId, identity }) : previous._processSaveJsonRaw || "" }, { processOnly: true });
    };
    if (globalThis.navigator?.locks) return navigator.locks.request(`${this.storageKey}:intake-approval`, commit);
    return commit();
  }

  async savePolishingMovement(payload) {
    await delay(220);
    const data = this.read();
    if (!["send", "return", "cancel", "undo-return"].includes(payload.action) || !payload.requestId || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > 100) throw new Error("研磨更新の形式が不正です。");
    if (payload.date !== undefined && !["send", "return"].includes(payload.action)) throw new Error("日付を指定できるのは発送・戻りだけです。");
    const movementAt = payload.date !== undefined ? polishingDateAt(payload.date) : "";
    const ids = new Set();
    const now = new Date().toISOString();
    const updates = payload.items.map((item) => {
      if (ids.has(item.id) || !Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("数量は1以上の整数で入力してください。");
      ids.add(item.id);
      const job = data.jobs.find((entry) => entry.id === item.id);
      if (!job) throw new Error("研磨を更新できる案件が見つかりません。");
      const polishing = structuredClone(job.polishing || { sentQuantity: 0, returnedQuantity: 0, history: [] });
      const previous = polishing.history.find((entry) => entry.requestId === payload.requestId);
      if (previous) {
        if (previous.action !== payload.action || previous.quantity !== item.quantity || (previous.requestedDate || "") !== (payload.date || "") || (previous.returnRequestId || "") !== (item.returnRequestId || "")) throw new Error("研磨更新の再試行内容が異なります。");
        return job;
      }
      if (job.archived || job.shippingStatus === "shipped") throw new Error("研磨を更新できる案件が見つかりません。");
      if (Number(job.version || 0) !== item.version) throw new Error("別の端末で先に更新されています。数量を確認して選択し直してください。");
      const counts = polishingCounts(job);
      const lastReturn = latestPolishingReturn(job);
      if (payload.action === "undo-return" && (!lastReturn || !item.returnRequestId || lastReturn.requestId !== item.returnRequestId || lastReturn.quantity !== item.quantity || item.quantity > counts.returned)) throw new Error("取り消す戻りが更新されています。履歴を確認し直してください。");
      const limit = payload.action === "send" ? counts.available : payload.action === "undo-return" ? counts.returned : counts.outstanding;
      if (item.quantity > limit) throw new Error(payload.action === "send" ? "研磨に出せる数量を超えています。" : "研磨屋にある数量を超えています。");
      if (payload.action === "send") polishing.sentQuantity += item.quantity;
      else if (payload.action === "return") polishing.returnedQuantity += item.quantity;
      else if (payload.action === "undo-return") polishing.returnedQuantity -= item.quantity;
      else polishing.sentQuantity -= item.quantity;
      polishing.history.push({ requestId: payload.requestId, action: payload.action, quantity: item.quantity, at: movementAt || now,
        ...(movementAt ? {requestedDate:payload.date,recordedAt:now} : {}), ...(payload.action === "undo-return" ? {returnRequestId:item.returnRequestId} : {}) });
      if (movementAt) validatePolishingDates(polishing.history);
      const updated = { ...job, polishing, version: Number(job.version || 0) + 1, updatedAt: now };
      if (["send", "undo-return"].includes(payload.action) || (payload.action === "return" && job.stages?.finish?.status === "done" && !polishingFinishReady(job))) {
        updated.stages = { ...job.stages, finish: { ...job.stages?.finish, status: "not_started" } };
        updated.shippingStatus = "not_ready";
      }
      return updated;
    });
    data.jobs = data.jobs.map((job) => updates.find((update) => update.id === job.id) || job);
    this.write(data);
    return typeof fetch === "function" ? this.productMetadata({jobs:updates,settings:data.settings}) : { jobs: updates };
  }

  async savePolishingEventDate(payload) {
    await delay(220);
    if (!canEdit()) throw new Error("研磨の日付を編集する権限がありません。");
    const at = polishingDateAt(payload.date), data = this.read();
    const job = data.jobs.find((entry) => entry.id === payload.id);
    if (!job) throw new Error("案件が見つかりません。画面を更新してください。");
    const polishing = structuredClone(job.polishing);
    const target = polishing.history.find((entry) => entry.requestId === payload.eventRequestId);
    const priorEvent = polishing.history.find((entry) => entry.dateEdits?.some((edit) => edit.requestId === payload.requestId));
    const prior = priorEvent?.dateEdits.find((edit) => edit.requestId === payload.requestId);
    if (prior && (priorEvent.requestId !== payload.eventRequestId || prior.date !== payload.date)) throw new Error("同じリクエストIDが異なる研磨日付の更新に使われています。");
    if (!prior) {
      if (job.archived) throw new Error("削除済みの案件は研磨日付を更新できません。");
      if (Number(job.version) !== payload.version) throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
      if (!target || !["send", "return"].includes(target.action)) throw new Error("変更する発送・戻りの履歴が見つかりません。");
      const previousAt = target.at, now = new Date().toISOString();
      target.recordedAt ||= previousAt;
      target.at = at;
      validatePolishingDates(polishing.history);
      target.dateEdits = [...(target.dateEdits || []), {requestId:payload.requestId,date:payload.date,previousAt,at:now}];
      Object.assign(job, {polishing,version:Number(job.version) + 1,updatedAt:now});
      this.write(data);
    }
    return typeof fetch === "function" ? this.productMetadata({jobs:[job],settings:data.settings}) : {jobs:[job]};
  }

  async setDistributionAssignee(payload) {
    await delay(180);
    const data = this.read();
    const job = data.jobs.find((entry) => entry.id === payload.id);
    if (!job || job.archived) throw new Error("案件が見つかりません。画面を更新してください。");
    if (Number(job.version || 0) !== Number(payload.version || 0)) throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
    if (state.access.role && !canWorkOnJob(job)) throw new Error("出荷待ち・出荷済みの配布担当を更新するには編集権限が必要です。");
    if (jobCategory(job) !== "鋭匙鉗子") throw new Error("鋭匙鉗子の案件を選んでください。");
    const assignee = String(payload.assignee ?? "").trim();
    if (assignee && !ASSIGNEES.includes(assignee)) throw new Error("配布担当を固定担当者から選択してください。");
    if ((job.distributionAssignee || "") === assignee) return job;
    Object.assign(job, { distributionAssignee: assignee, version: Number(job.version || 0) + 1, updatedAt: new Date().toISOString() });
    this.write(data);
    return job;
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
      body: JSON.stringify(useAi ? { ...payload, customerRules: await this.getCustomerRules(), learningRules: await this.getIntakeLearningRules().then((result) => result.rules || []) } : payload),
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
    const batchId = crypto.randomUUID();
    const intakeTitle = payload.name || (isText ? "貼り付けた注文メール" : "注文情報");
    const rawLearningRules = data.settings.intakeLearningRules;
    const learningRules = globalThis.IntakeLearning?.sanitizeRules(rawLearningRules === undefined ? [] : typeof rawLearningRules === "string" ? JSON.parse(rawLearningRules) : rawLearningRules) || [];
    const items = results.map((result, index) => {
      const itemNumber = result.itemNumber || index + 1;
      const product = result.parsed?.product || "品名未判定";
      const parsed = globalThis.IntakeLearning?.apply({ parsed: result.parsed || {}, rules: learningRules })?.parsed || { ...(result.parsed || {}) };
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
        parsed: { ...parsed, ...(result.purchaseNo ? { externalOrderNo: result.purchaseNo, externalLineNo: String(result.itemNumber || "") } : {}) },
        confidence: Number(result.confidence || 0),
        importFileName: payload.name,
        parserVersion: LOCAL_PDF_ENGINE_VERSION,
        status: "pending",
      };
    });
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

  async getIntakeLearningRules() {
    const raw = this.read().settings.intakeLearningRules;
    const rules = raw === undefined ? [] : typeof raw === "string" ? JSON.parse(raw) : raw;
    return { rules: globalThis.IntakeLearning?.sanitizeRules(rules) || [] };
  }

  async forgetIntakeLearningRule({ key, intakeId }) {
    const data = this.read();
    const current = await this.getIntakeLearningRules();
    const evidence = current.rules.find((rule) => rule.key === key);
    if (!evidence) throw new Error("この補完は既に解除されています。補完一覧を更新してください。");
    if (intakeId && evidence.intakeId !== intakeId) throw new Error("製品補完が別の画面で更新されています。補完一覧を読み直してください。");
    data.settings.intakeLearningRules = JSON.stringify(globalThis.IntakeLearning?.remove({ rules: current.rules, key }) || current.rules.filter((rule) => rule.key !== key));
    this.write(data);
    return { rules: JSON.parse(data.settings.intakeLearningRules) };
  }

  async approveIntake(payload) {
    const result = await this.approveIntakes({ items: [payload] });
    if (result.errors.length) {
      if (result.errors[0].code === "INTAKE_DUPLICATE") return result.errors[0];
      throw new Error(result.errors[0].message);
    }
    const job = result.items[0].job;
    if (result.items[0].learningNotice) job.importLearningNotice = result.items[0].learningNotice;
    return job;
  }

  async approveIntakes(payload) {
    await delay(220);
    if (globalThis.navigator?.locks) return navigator.locks.request(`${this.storageKey}:intake-approval`, () => this.approveIntakesUnlocked(payload));
    return this.approveIntakesUnlocked(payload);
  }

  approveIntakesUnlocked(payload) {
    const data = this.read();
    const requests = payload?.items;
    if (!Array.isArray(requests) || !requests.length || requests.length > 100) throw new Error("1〜100件を選択してください。");
    const errors = [];
    const seen = new Set();
    const prepared = requests.map(({ intakeId, order: inputOrder, duplicateDecision, learnProduct, learnNote }) => {
      const candidate = data.intake.find((item) => item.id === intakeId);
      const sibling = candidate?.sourceRef && data.intake.some((item) => item.id !== intakeId && item.sourceRef === candidate.sourceRef && item.sourceType === candidate.sourceType);
      const legacy = candidate?.sourceRef && data.jobs.find((job) => job.sourceType === candidate.sourceType && job.sourceRef === candidate.sourceRef);
      const existing = data.jobs.find((job) => job.sourceType === "intake" && job.sourceRef === intakeId) || (!sibling && legacy);
      const external = IntakeDuplicates.identity(candidate?.parsed || {});
      const order = { ...(inputOrder || {}), externalOrderNo: external.externalOrderNo || inputOrder?.externalOrderNo || "", externalLineNo: external.externalLineNo || inputOrder?.externalLineNo || "" };
      let message = seen.has(intakeId) ? "同じ候補が重複しています。" : "";
      seen.add(intakeId);
      if (!candidate || !["pending", "approved"].includes(candidate.status)) message ||= "この候補は処理済みか、見つかりません。";
      if (candidate?.status === "approved" && !existing) message ||= "反映済みの案件が見つかりません。";
      if (!existing && sibling && legacy) message ||= "対応する案件を特定できません。";
      if (!existing) message ||= bulkOrderError(order || {});
      if (!existing && !message) {
        try { order.stockPlannedQuantity = validateFinishedStockPlan(order, null, data.finishedStockEvents || []); }
        catch (error) { message = error.message; }
      }
      if (message) errors.push({ intakeId, message });
      return { intakeId, candidate, existing, order, duplicateDecision, learnProduct: learnProduct === true, learnNote: learnNote === true };
    });
    if (errors.length) return { items: [], errors };
    const batchItems = prepared.filter((entry) => !entry.existing).map(({ intakeId, order }) => ({ intakeId, order }));
    prepared.forEach((entry) => {
      if (entry.existing) return;
      const duplicate = IntakeDuplicates.inspect({ order: entry.order, intakeId: entry.intakeId, jobs: data.jobs, intakes: data.intake, batchItems });
      entry.duplicate = duplicate;
      if (duplicate.matches.length && !IntakeDuplicates.decisionAccepted(duplicate, entry.duplicateDecision)) errors.push({ intakeId: entry.intakeId, code: "INTAKE_DUPLICATE", ...duplicate });
    });
    if (errors.length) return { items: [], errors };
    const now = new Date().toISOString();
    const rulesRaw = data.settings.intakeLearningRules;
    let learningRules = globalThis.IntakeLearning?.sanitizeRules(rulesRaw === undefined ? [] : typeof rulesRaw === "string" ? JSON.parse(rulesRaw) : rulesRaw) || [];
    const items = prepared.map(({ intakeId, candidate, existing, order, duplicate, learnProduct, learnNote }) => {
      const job = existing || {
        ...Object.fromEntries(BULK_INTAKE_FIELDS.map(([key]) => [key, order[key] ?? ""])),
        externalOrderNo: order.externalOrderNo, externalLineNo: order.externalLineNo,
        quantity: Number(order.quantity), stockPlannedQuantity: Number(order.stockPlannedQuantity || 0), id: `JOB-${crypto.randomUUID()}`, priority: "normal",
        sourceType: "intake", sourceRef: intakeId, labelPrintStatus: "waiting", labelPrintedAt: "",
        shippingStatus: "not_ready", archived: false, completedAt: "", createdAt: now, updatedAt: now, version: 1,
        stages: Object.fromEntries(STAGES.map((stage) => [stage.key, { status: "not_started", assignee: "" }])),
      };
      if (!existing) {
        if (globalThis.MaterialInventory) job.materials = MaterialInventory.transitionJob(null, job, { at: now, actor: state.access.email || "owner@example.com", eventId: `intake:${intakeId}` });
        data.jobs.unshift(job);
      }
      if (candidate.status !== "approved") {
        data.logs ||= [];
        data.logs.push({ action: "intake.approve", entityId: intakeId, timestamp: now, detail: { jobId: job.id } });
        if (!existing && duplicate.matches.length) data.logs.push({ action: "intake.add_separate", entityId: intakeId, timestamp: now, detail: { jobId: job.id, decision: "add_separate", matches: duplicate.matches, duplicateSignature: duplicate.duplicateSignature } });
      }
      let learningNotice = "";
      if (candidate.status !== "approved" && learnProduct && globalThis.IntakeLearning?.learn) {
        const learned = globalThis.IntakeLearning.learn({ rules: learningRules, parsed: candidate.parsed || {}, order: job, intakeId, includeNote: learnNote, updatedAt: now });
        learningRules = learned.rules || learningRules;
        if (learned.changed) learningNotice = learned.message || "製品共通の補完内容を覚えました。";
      }
      candidate.status = "approved";
      return { intakeId, job, ...(learningNotice ? { learningNotice } : {}) };
    });
    if (globalThis.IntakeLearning?.sanitizeRules) data.settings.intakeLearningRules = JSON.stringify(learningRules);
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
    if (payload.distributionAssignees !== undefined) {
      let names;
      try { names = JSON.parse(payload.distributionAssignees); } catch { throw new Error("配布担当者の設定JSONが不正です。"); }
      if (!Array.isArray(names) || names.some((name) => !ASSIGNEES.includes(name))) throw new Error("配布担当を固定担当者から選択してください。");
      payload = { ...payload, distributionAssignees: JSON.stringify(ASSIGNEES.filter((name) => names.includes(name))) };
    }
    if (payload.archived && polishingCounts(job).outstanding > 0) throw new Error("研磨屋にある製品は削除できません。");
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
const api = trackApiMutations(isAppsScript ? new AppsScriptApi() : new MockApi());
let materialUi = null;
let materialRefreshPromise = null;
let finishedStockUi = null;
const stockFulfillmentAttempts = new Map();

function getFinishedStockUi() {
  if (!finishedStockUi && canEdit() && !state.accessRevoked && globalThis.FinishedStockUI && qs("[data-view-panel='finishedStock']")) {
    finishedStockUi = globalThis.FinishedStockUI.create({
      api, canEdit: () => canEdit() && !state.accessRevoked, today: todayIso,
      openDialog(dialog) { openDialog(dialog); },
      onError(message) { showToast(message, { tone: "error" }); },
      onJob(id) {
        if (!canEdit() || state.accessRevoked) return;
        const job = state.jobs.find((entry) => entry.id === id);
        if (job) openOrderDialog(job);
      },
      async onFulfill(id) {
        if (!canEdit() || state.accessRevoked) throw new Error("受注履行完了には編集権限が必要です。");
        const job = state.jobs.find((entry) => entry.id === id && !entry.archived);
        if (!job) throw new Error("案件が見つかりません。更新して確認してください。");
        const payload = stockFulfillmentAttempts.get(id) || { ...structuredClone(job), shippingStatus: "shipped", requestId: crypto.randomUUID() };
        stockFulfillmentAttempts.set(id, payload);
        try {
          await api.saveJob(payload);
          stockFulfillmentAttempts.delete(id);
        } catch (error) {
          if (/別の端末|権限|削除済み|見つかりません/.test(String(error.message))) stockFulfillmentAttempts.delete(id);
          throw error;
        } finally { await refreshData({ quiet: true }); }
      },
      onMutation() { void refreshData({ quiet: true }); },
    });
  }
  return finishedStockUi;
}

function invalidateFinishedStock({ passive = false } = {}) {
  const controller = finishedStockUi || (state.activeView === "finishedStock" ? getFinishedStockUi() : null);
  if (controller) controller.invalidate({ refresh: canEdit() && !state.accessRevoked && state.activeView === "finishedStock", passive });
}

function renderFinishedStockWorkspace() {
  if (!canEdit() || state.accessRevoked) { finishedStockUi?.clear(); return; }
  getFinishedStockUi()?.render();
}

function validateFinishedStockPlan(job, previous = null, events = []) {
  const raw = job.stockPlannedQuantity ?? previous?.stockPlannedQuantity ?? 0;
  const quantity = raw === "" ? 0 : typeof raw === "boolean" ? NaN : Number(raw);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > Number(job.quantity || 0)) throw new Error("在庫予定は製造数量以内の0以上の整数で入力してください。");
  if (globalThis.FinishedStock) {
    try { FinishedStock.validateJob({ ...job, stockPlannedQuantity: quantity }, previous, events); }
    catch (error) { throw new Error(String(error.message || error).replace(/FINISHED_STOCK_INVALID:\s*/g, "")); }
  }
  else if (quantity > 0) throw new Error("Tezoe製品在庫を読み込み直してください。");
  return quantity;
}

function finishedStockQuantitySummary(totalValue, stockValue, customer = "") {
  const total = Number(totalValue), stock = Number(stockValue || 0);
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(stock) || stock < 0 || stock > total) return "在庫予定は製造数量以内の0以上の整数で入力してください。";
  if (globalThis.FinishedStockOrders?.isStockOnly?.({ customer })) return `製造${total}丁は全数を在庫補充として扱います（得意先：${String(customer).trim()}）`;
  return `製造${total}丁 = 今回製造の注文向け${total - stock}丁 + 在庫補充${stock}丁（Tezoeのみ）`;
}

function updateFinishedStockOrderSummary(form = qs("#order-form")) {
  const helper = qs("#order-stock-summary", form) || qs("[data-stock-summary]", form);
  if (helper) helper.textContent = finishedStockQuantitySummary(form.elements.quantity?.value, form.elements.stockPlannedQuantity?.value, form.elements.customer?.value);
  const stock = form.elements.stockPlannedQuantity;
  if (stock) stock.max = form.elements.quantity?.value || "0";
}

function getMaterialUi() {
  if (!materialUi && globalThis.MaterialInventoryUI && qs("[data-view-panel='materials']")) {
    materialUi = globalThis.MaterialInventoryUI.create({
      api, canEdit, today: todayIso,
      onRefreshStart() { state.materialInventoryRevision += 1; },
      onSnapshot(snapshot) {
        if (canEdit() && !state.accessRevoked) {
          state.materialInventoryRevision += 1;
          state.materialInventory = snapshot;
        }
      },
      onError(message) { showToast(message, { tone: "error" }); },
      onJob(id) {
        if (!canEdit()) return;
        const job = state.jobs.find((entry) => entry.id === id);
        if (job) openOrderDialog(job);
      },
    });
  }
  return materialUi;
}

function refreshMaterialInventory() {
  const controller = getMaterialUi();
  if (!canEdit() || !controller || materialRefreshPromise) return materialRefreshPromise;
  materialRefreshPromise = Promise.resolve(controller.refresh()).catch((error) => {
    if (!state.accessRevoked) showToast(`碓井材料在庫を読み込めませんでした。${error.message}`, { tone: "error" });
  }).finally(() => { materialRefreshPromise = null; });
  return materialRefreshPromise;
}

function invalidateMaterialInventory() {
  state.materialInventoryRevision += 1;
  state.materialInventory = null;
  const controller = materialUi || (state.activeView === "materials" ? getMaterialUi() : null);
  if (controller) controller.invalidate({ refresh: canEdit() && !state.accessRevoked && state.activeView === "materials" });
}

function renderMaterialWorkspace() {
  const controller = getMaterialUi();
  if (!controller) return;
  controller.setSnapshot(canEdit() ? state.materialInventory : null);
  if (canEdit() && !state.materialInventory) void refreshMaterialInventory();
}

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
    const compound = compact.match(/((?:強|弱)[弯湾彎])[・/、,\-]*(上向(?:き)?|下向(?:き)?)/);
    const jawMatch = compact.match(/[<〈]([^<>〈〉]{1,20}爪)[>〉]/);
    if (compound) inferred.specShape = `${compound[1].replace(/[湾彎]/g, "弯")}・${compound[2].replace(/き$/, "")}`;
    else if (jawMatch) inferred.specShape = jawMatch[1];
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

function readStoredLedgerDisplay() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEDGER_STORAGE_KEY));
    if (saved && ["fit", "manual"].includes(saved.mode) && Number.isFinite(saved.scale)) {
      const progressOnly = saved.progressOnly === true;
      return { mode: progressOnly ? "manual" : saved.mode, scale: clampLedgerScale(saved.scale), rows: saved.rows === 23 ? 23 : 33, compact: !progressOnly && saved.compact === true, progressOnly };
    }
  } catch (error) { /* 端末保存を使えない場合も一覧を表示する */ }
  return { mode: "fit", scale: 100, rows: 33, compact: false, progressOnly: false };
}

function clampLedgerScale(scale) {
  return Math.min(160, Math.max(40, Math.round(Number.isFinite(scale) ? scale : 100)));
}

function fitLedgerScale(height, rowHeight, headerHeight, rows = 33) {
  return clampLedgerScale(Math.floor((height - 20) / (headerHeight + rowHeight * rows) * 100));
}

function stageForJob(stage, jobOrCategory) {
  if (stage.key === "finish" && typeof jobOrCategory === "object" && (polishingCounts(jobOrCategory || {}).sent > 0 || jobOrCategory?.shippingStatus === "shipped")) return { ...stage, label: "最終仕上げ" };
  const category = typeof jobOrCategory === "string" ? jobOrCategory : jobCategory(jobOrCategory || {});
  return stage.key === "heat" && category === "鋭匙鉗子"
    ? { ...stage, label: "頭付け・幅取り", short: "頭" }
    : stage;
}

function stageFilterLabel(stage) {
  return stage.key === "heat" ? "頭付け・幅取り／厚みとり" : stage.label;
}

function updateStageFilterLabels() {
  ["#dashboard-stage-filter", "#orders-stage-filter"].forEach((selector) => {
    const option = qs(`${selector} option[value="heat"]`);
    if (option) option.textContent = stageFilterLabel(STAGES.find((stage) => stage.key === "heat"));
  });
}

function persistLedgerDisplay() {
  try { localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(state.ledgerDisplay)); } catch (error) { /* 表示の変更は保存できなくても利用できる */ }
}

const ledgerSerialWidthCache = new WeakMap();

function updateLedgerSerialWidth(viewport) {
  if (typeof document.createRange !== "function" || typeof getComputedStyle !== "function") return;
  const cells = qsa(".cell-serial", viewport);
  if (!cells.length) return;
  const font = getComputedStyle(cells[0]);
  const signature = [font.fontFamily, font.fontSize, font.fontWeight, font.letterSpacing, document.fonts?.status].join(";");
  if (ledgerSerialWidthCache.get(viewport) === signature) return;
  const content = qs(".ledger-content", viewport);
  const scale = Number(getComputedStyle(content).zoom) || state.ledgerDisplay.scale / 100;
  const range = document.createRange();
  let width = 80;
  cells.forEach((cell) => {
    range.selectNodeContents(cell);
    const css = getComputedStyle(cell);
    const padding = (parseFloat(css.paddingLeft) || 0) + (parseFloat(css.paddingRight) || 0);
    width = Math.max(width, Math.ceil(range.getBoundingClientRect().width / scale + padding + 2));
  });
  viewport.style.setProperty("--ledger-serial-width", `${width}px`);
  ledgerSerialWidthCache.set(viewport, signature);
}

function updateLedgerOverflow(viewport) {
  const content = qs(".ledger-content", viewport);
  if (!content || !viewport.clientWidth) return;
  viewport.style.setProperty("--ledger-viewport-width", `${viewport.clientWidth / (state.ledgerDisplay.scale / 100)}px`);
  // Ignore the extra scrolling room when deciding whether the data itself overflows.
  const space = qs(".ledger-scroll-space", content)?.getBoundingClientRect().width || 0;
  const horizontal = content.getBoundingClientRect().width - space > viewport.clientWidth + 1;
  viewport.classList.toggle("has-horizontal-overflow", horizontal);
  if (!horizontal && viewport.scrollLeft) viewport.scrollLeft = 0;
}

function applyLedgerScale(value, { mode = "manual", persist = true, viewport = null, anchor = null } = {}) {
  const scale = clampLedgerScale(value);
  state.ledgerDisplay = { ...state.ledgerDisplay, mode, scale };
  document.body.classList.toggle("is-ledger-focus", ["orders", "shipping", "completed"].includes(state.activeView) && (state.ledgerDisplay.compact || state.ledgerDisplay.progressOnly));
  document.body.classList.toggle("is-ledger-progress", ["orders", "shipping", "completed"].includes(state.activeView) && state.ledgerDisplay.progressOnly);
  const activeViewport = viewport || qs(".ledger-view.is-active .ledger-viewport");
  const viewports = state.activeView === "completed"
    ? [...new Set([activeViewport, ...qsa(".finished-list-view.is-active .ledger-viewport")].filter(Boolean))]
    : activeViewport ? [activeViewport] : [];
  viewports.forEach((surface) => surface.style.setProperty("--ledger-scale", String(scale / 100)));
  qsa("[data-ledger-scale]").forEach((element) => { if (element !== document.activeElement) element.value = String(scale); });
  qsa("[data-ledger-zoom]").forEach((button) => {
    const action = button.dataset.ledgerZoom;
    if (action === "fit") button.setAttribute("aria-pressed", String(!state.ledgerDisplay.progressOnly && mode === "fit" && Number(button.dataset.ledgerRows) === state.ledgerDisplay.rows));
    if (action === "progress") button.setAttribute("aria-pressed", String(state.ledgerDisplay.progressOnly && scale === 160));
    button.disabled = (action === "out" && scale === 40) || (action === "in" && scale === 160);
  });
  if (viewport && anchor) {
    viewport.scrollLeft = anchor.x * scale / 100 - anchor.clientX;
    viewport.scrollTop = anchor.y * scale / 100 - anchor.clientY;
  }
  viewports.forEach(updateLedgerOverflow);
  if (persist) persistLedgerDisplay();
}

let ledgerLayoutFrame = 0;
let ledgerZoomFrame = 0;
let pendingLedgerZoom = null;
let ledgerPinch = null;
let ledgerSuppressClickUntil = 0;

function queueLedgerScale(value, options) {
  pendingLedgerZoom = { value, options };
  if (!ledgerZoomFrame) ledgerZoomFrame = requestAnimationFrame(flushLedgerScale);
}

function flushLedgerScale() {
  if (ledgerZoomFrame) cancelAnimationFrame(ledgerZoomFrame);
  ledgerZoomFrame = 0;
  if (!pendingLedgerZoom) return;
  const pending = pendingLedgerZoom;
  pendingLedgerZoom = null;
  applyLedgerScale(pending.value, pending.options);
}

function commitLedgerScaleInput(input) {
  flushLedgerScale();
  const value = input.value.trim();
  if (value && Number.isFinite(Number(value))) applyLedgerScale(Number(value));
  input.value = String(state.ledgerDisplay.scale);
}

function selectLedgerPreset(rows) {
  flushLedgerScale();
  const products = rows === 23 ? 23 : 33;
  state.ledgerDisplay = { ...state.ledgerDisplay, rows: products, compact: products === 23, progressOnly: false };
  applyLedgerScale(state.ledgerDisplay.scale, { mode: "fit", persist: false });
  renderActiveView();
  layoutLedger();
  persistLedgerDisplay();
}

function selectLedgerProgressView() {
  flushLedgerScale();
  state.ledgerDisplay = { ...state.ledgerDisplay, compact: false, progressOnly: true };
  applyLedgerScale(160, { persist: false });
  renderActiveView();
  layoutLedger();
  persistLedgerDisplay();
}

function layoutLedger() {
  if (state.activeView === "completed") {
    layoutFinishedList();
    return;
  }
  const viewport = qs(".ledger-view.is-active .ledger-viewport");
  if (!viewport) return;
  updateLedgerSerialWidth(viewport);
  const top = viewport.getBoundingClientRect().top;
  const footer = qs(".status-footer");
  const footerHeight = footer ? footer.getBoundingClientRect().height : 30;
  const height = Math.max(180, window.innerHeight - Math.max(0, top) - footerHeight - 8);
  viewport.style.height = `${height}px`;
  if (state.ledgerDisplay.mode === "fit") {
    const factor = state.ledgerDisplay.scale / 100;
    const rows = qsa("tbody > tr[data-order-id]", viewport).slice(0, state.ledgerDisplay.rows);
    const boxes = rows.map((row) => row.getBoundingClientRect());
    const totalRowsHeight = boxes.reduce((total, box) => total + box.height / factor, 0);
    const rowHeight = boxes.length ? totalRowsHeight / boxes.length : 26;
    const content = qs(".ledger-content", viewport);
    const headerHeight = boxes.length && content ? Math.max(0, (boxes.at(-1).bottom - content.getBoundingClientRect().top) / factor - totalRowsHeight) : 28;
    if (rowHeight > 0) applyLedgerScale(fitLedgerScale(height, rowHeight, headerHeight, state.ledgerDisplay.rows), { mode: "fit", persist: false });
  }
  updateLedgerOverflow(viewport);
}

function layoutFinishedList() {
  const scroller = qs(".finished-list-view.is-active .finished-list-scroll");
  if (!scroller) return;
  const viewports = qsa(".ledger-viewport", scroller);
  const footerHeight = qs(".status-footer")?.getBoundingClientRect().height || 0;
  const height = Math.max(180, window.innerHeight - Math.max(0, scroller.getBoundingClientRect().top) - footerHeight - 8);
  scroller.style.height = `${height}px`;
  viewports.forEach((viewport) => {
    viewport.style.height = "auto";
    updateLedgerSerialWidth(viewport);
  });
  if (state.ledgerDisplay.mode === "fit") {
    const reference = viewports.find((viewport) => qs("tr[data-order-id]", viewport));
    if (reference) {
      const factor = state.ledgerDisplay.scale / 100;
      const boxes = qsa("tbody > tr[data-order-id]", reference).slice(0, state.ledgerDisplay.rows).map((row) => row.getBoundingClientRect());
      const rowsHeight = boxes.reduce((total, box) => total + box.height / factor, 0);
      const rowHeight = rowsHeight / boxes.length;
      const headerHeight = Math.max(0, (boxes.at(-1).bottom - qs(".ledger-content", reference).getBoundingClientRect().top) / factor - rowsHeight);
      const headingsHeight = qsa(".finished-list-heading, .finished-list-section > .ledger-filters, .ledger-filter-summary:not([hidden])", scroller)
        .reduce((total, element) => total + element.getBoundingClientRect().height, 0);
      if (rowHeight > 0) applyLedgerScale(fitLedgerScale(height - headingsHeight - 24, rowHeight, headerHeight, state.ledgerDisplay.rows), { mode: "fit", persist: false });
    }
  }
  viewports.forEach(updateLedgerOverflow);
}

function scheduleLedgerLayout() {
  if (ledgerLayoutFrame) cancelAnimationFrame(ledgerLayoutFrame);
  ledgerLayoutFrame = requestAnimationFrame(() => { ledgerLayoutFrame = 0; layoutLedger(); });
}

function ledgerAnchor(viewport, clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const factor = state.ledgerDisplay.scale / 100;
  return { x: (viewport.scrollLeft + x) / factor, y: (viewport.scrollTop + y) / factor, clientX: x, clientY: y };
}

function handleLedgerWheel(event) {
  const viewport = event.target.closest(".ledger-viewport");
  const controls = event.target.closest(".ledger-zoom");
  if ((!viewport || (!event.ctrlKey && !event.metaKey)) && !controls) return;
  if (!event.cancelable || !event.deltaY) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
  const anchor = viewport ? ledgerAnchor(viewport, event.clientX, event.clientY) : null;
  queueLedgerScale((pendingLedgerZoom?.value ?? state.ledgerDisplay.scale) * Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.0015), { viewport, anchor });
}

function ledgerTouchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function handleLedgerTouchStart(event) {
  if (event.touches.length !== 2) return;
  const viewport = event.target.closest(".ledger-viewport");
  if (!viewport || !Array.from(event.touches).every((touch) => viewport.contains(touch.target))) return;
  const distance = ledgerTouchDistance(event.touches);
  if (!distance || !event.cancelable) return;
  event.preventDefault();
  const [first, second] = event.touches;
  const moveTarget = event.currentTarget || viewport;
  moveTarget.addEventListener("touchmove", handleLedgerTouchMove, { passive: false });
  ledgerPinch = { viewport, moveTarget, distance, scale: state.ledgerDisplay.scale,
    anchor: ledgerAnchor(viewport, (first.clientX + second.clientX) / 2, (first.clientY + second.clientY) / 2) };
  ledgerSuppressClickUntil = Date.now() + 800;
}

function handleLedgerTouchMove(event) {
  if (!ledgerPinch || event.touches.length !== 2) return;
  if (event.cancelable) event.preventDefault();
  ledgerSuppressClickUntil = Date.now() + 800;
  queueLedgerScale(ledgerPinch.scale * ledgerTouchDistance(event.touches) / ledgerPinch.distance,
    { viewport: ledgerPinch.viewport, anchor: ledgerPinch.anchor, persist: false });
}

function handleLedgerTouchEnd(event) {
  if (!ledgerPinch) return;
  if (event.touches.length < 2) {
    flushLedgerScale();
    ledgerPinch.moveTarget.removeEventListener("touchmove", handleLedgerTouchMove);
    ledgerPinch = null;
    ledgerSuppressClickUntil = Date.now() + 800;
    persistLedgerDisplay();
  }
}

function bindLedgerDisplay() {
  qsa("[data-ledger-scale]").forEach((input) => {
    input.addEventListener("change", () => commitLedgerScaleInput(input));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitLedgerScaleInput(input);
        input.blur();
      } else if (event.key === "Escape") {
        input.value = String(state.ledgerDisplay.scale);
        input.blur();
      }
    });
  });
  qsa(".ledger-view").forEach((view) => {
    view.addEventListener("wheel", handleLedgerWheel, { passive: false });
    view.addEventListener("touchstart", handleLedgerTouchStart, { passive: false });
    view.addEventListener("touchend", handleLedgerTouchEnd, { passive: true });
    view.addEventListener("touchcancel", handleLedgerTouchEnd, { passive: true });
    view.addEventListener("click", (event) => {
      if (event.detail && Date.now() < ledgerSuppressClickUntil && event.target.closest(".ledger-viewport")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });
  window.addEventListener("resize", scheduleLedgerLayout);
  document.fonts?.ready.then(scheduleLedgerLayout);
  document.fonts?.addEventListener?.("loadingdone", () => {
    qsa(".ledger-viewport").forEach((viewport) => ledgerSerialWidthCache.delete(viewport));
    scheduleLedgerLayout();
  });
  applyLedgerScale(state.ledgerDisplay.scale, { mode: state.ledgerDisplay.mode, persist: false });
}

const ledgerRenderCache = new WeakMap();

function renderLedgerTable(workspace, jobs, completed = false, shipping = false) {
  const previous = qs(".ledger-viewport", workspace);
  const compact = state.ledgerDisplay.compact;
  const progressOnly = state.ledgerDisplay.progressOnly;
  const layout = progressOnly ? "progress" : compact ? "compact" : "full";
  const signature = JSON.stringify([jobs, completed, shipping, compact, progressOnly, canEdit(), canWork(), todayIso(), jobs.map((job) => jobMutationPending(job.id))]);
  if (previous && ledgerRenderCache.get(workspace) === signature) return;
  ledgerRenderCache.set(workspace, signature);
  const changedLayout = previous?.dataset?.ledgerLayout && previous.dataset.ledgerLayout !== layout;
  const scroll = { top: previous?.scrollTop || 0, left: changedLayout ? 0 : previous?.scrollLeft || 0 };
  const buckets = ledgerJobGroups(jobs);
  const label = completed ? "出荷済み" : shipping ? "出荷待ち" : "工程一覧";
  const headingTag = completed || shipping ? "h3" : "h2";
  workspace.innerHTML = `<div class="ledger-viewport${shipping ? " shipping-ledger" : ""}" data-ledger-layout="${layout}" tabindex="0" role="region" aria-label="${label}。表をピンチして拡大縮小できます。" style="--ledger-scale:${state.ledgerDisplay.scale / 100}"><div class="ledger-content">${buckets.map(([category, groupJobs]) => `<section class="ledger-category-group" aria-label="${escapeHtml(category)}"><${headingTag} class="ledger-category-heading">${escapeHtml(category)} <span>(${groupJobs.length})</span></${headingTag}><div class="order-table-wrap"><table class="order-table ledger-category-table${completed ? " completed-table" : ""}" aria-label="${escapeHtml(category)}・${label}">${orderTableHeader({ completed, shipping, category, compact, ledger: true, progressOnly })}<tbody>${orderTableRows(groupJobs, { completed, shipping, compact, ledger: true, progressOnly })}</tbody></table></div><p class="ledger-category-total">${escapeHtml(category)} 合計 <strong>${ledgerTotalsText(groupJobs)}</strong></p></section>`).join("")}<p class="ledger-grand-total">表示中の総合計 <strong>${ledgerTotalsText(jobs)}</strong></p></div></div>`;
  const viewport = qs(".ledger-viewport", workspace);
  if (workspace.isConnected) {
    layoutLedger();
    viewport.scrollTop = scroll.top;
    viewport.scrollLeft = scroll.left;
    scheduleLedgerLayout();
  }
}

function ledgerJobGroups(jobs) {
  const categories = ["ケリソンパンチ", "鋭匙鉗子"];
  const known = new Set(categories);
  const groups = categories.map((category) => [category, jobs.filter((job) => jobCategory(job) === category)]);
  const otherJobs = jobs.filter((job) => !known.has(jobCategory(job)));
  if (otherJobs.length) groups.push(["その他", otherJobs]);
  return groups;
}

function ledgerTotals(jobs) {
  return jobs.reduce((total, job) => {
    const value = job.quantity;
    const quantity = Number(value);
    if (value == null || String(value).trim() === "" || !Number.isFinite(quantity) || quantity < 0) total.unknownQuantity += 1;
    else total.quantity += quantity;
    return total;
  }, { count: jobs.length, quantity: 0, unknownQuantity: 0 });
}

function ledgerTotalsText(jobs) {
  const total = ledgerTotals(jobs);
  return `${total.count.toLocaleString("ja-JP")}件・${total.quantity.toLocaleString("ja-JP")}丁${total.unknownQuantity ? `（数量未設定 ${total.unknownQuantity}件）` : ""}`;
}

function openLedgerDetails(job) {
  qs("#ledger-detail-title").textContent = productDisplayName(job);
  const values = [["得意先", job.customer], ["大分類", jobCategory(job)], ["納期", job.dueDate], ["数量", job.quantity], ["全長", job.specLength], ["型", job.specShape], ["刃幅", job.bladeWidth], ["連番", job.serialNo], ...STAGES.map((stage) => [stageForJob(stage, job).label, `${stageAssignee(job, stage.key) || "担当未定"}・${statusLabel(stageStatus(job, stage.key))}`]), ["出荷", job.shippingStatus === "shipped" ? "出荷完了" : "未出荷"], ["備考", job.note]];
  if (job.shippingStatus === "shipped") values.splice(values.length - 1, 0, ["出荷完了日時", shipmentDateLabel(job, true)]);
  qs("#ledger-detail-body").innerHTML = `<dl class="ledger-detail-fields">${values.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "") || "—"}</dd></div>`).join("")}</dl>${canWorkOnJob(job) ? `<button class="button button-primary" type="button" data-work-only data-action="open-process" data-order-id="${escapeHtml(job.id)}">工程と担当を編集</button>` : ""}`;
  openDialog(qs("#ledger-detail-dialog"));
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

function shipmentDateKey(job) {
  return job.completedAt ? businessDateKey(job.completedAt) : "";
}

function shipmentDateLabel(job, includeTime = false) {
  if (!shipmentDateKey(job)) return "未記録";
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}), timeZone: BUSINESS_TIME_ZONE }).format(new Date(job.completedAt));
}

function completedPeriodLabel(period) {
  if (period === "current") return "今月";
  if (period === "all") return "全期間";
  if (period === "undated") return "出荷日未記録";
  const match = String(period).match(/^(\d{4})(?:-(0[1-9]|1[0-2]))?$/);
  return match ? `${match[1]}年${match[2] ? `${Number(match[2])}月` : ""}` : "全期間";
}

function matchesCompletedPeriod(job, period) {
  if (period === "all") return true;
  const date = shipmentDateKey(job);
  if (period === "undated") return !date;
  if (period === "current") return date.startsWith(todayIso().slice(0, 7));
  return /^\d{4}(?:-(0[1-9]|1[0-2]))?$/.test(period) && Boolean(date) && date.startsWith(period);
}

function renderCompletedPeriods() {
  const yearSelect = qs("#completed-year");
  const monthSelect = qs("#completed-month");
  if (!yearSelect || !monthSelect) return;
  const period = state.filters.completed.period;
  const selected = String(period === "current" ? todayIso().slice(0, 7) : period).match(/^(\d{4})(?:-(0[1-9]|1[0-2]))?$/);
  const shipped = state.jobs.filter((job) => !job.archived && job.shippingStatus === "shipped");
  const dates = shipped.map(shipmentDateKey).filter(Boolean);
  const years = new Set([todayIso().slice(0, 4), ...dates.map((date) => date.slice(0, 4))]);
  if (selected) years.add(selected[1]);
  const yearMarkup = '<option value="all">すべての年</option>'
    + [...years].sort().reverse().map((year) => `<option value="${year}">${year}年</option>`).join("")
    + (shipped.some((job) => !shipmentDateKey(job)) || period === "undated" ? '<option value="undated">出荷日未記録</option>' : "");
  const monthMarkup = '<option value="all">すべての月</option>' + Array.from({ length: 12 }, (_, index) => `<option value="${String(index + 1).padStart(2, "0")}">${index + 1}月</option>`).join("");
  if (yearSelect.innerHTML !== yearMarkup) yearSelect.innerHTML = yearMarkup;
  if (monthSelect.innerHTML !== monthMarkup) monthSelect.innerHTML = monthMarkup;
  yearSelect.value = selected ? selected[1] : period === "undated" ? "undated" : "all";
  monthSelect.value = selected?.[2] || "all";
  monthSelect.disabled = !selected;
}

function setCompletedPeriodFromControls() {
  const year = qs("#completed-year").value;
  const month = qs("#completed-month").value;
  state.filters.completed.period = /^\d{4}$/.test(year)
    ? `${year}${/^(0[1-9]|1[0-2])$/.test(month) ? `-${month}` : ""}`
    : year === "undated" ? "undated" : "all";
  renderCompletedWorkspace();
  announce(`${filteredJobs("completed").length}件に絞り込みました`);
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
  const status = job.stages?.[key]?.status || "not_started";
  return key === "finish" && status === "done" && job.shippingStatus !== "shipped" && !polishingFinishReady(job) ? "working" : status;
}

function stageAssignee(job, key) {
  return String(job.stages?.[key]?.assignee || "").trim();
}

function isDone(job) {
  return polishingFinishReady(job) && stageStatus(job, "finish") === "done";
}

function matchesJobScope(job, scope) {
  if (job.archived) return false;
  if (scope === "completed") return job.shippingStatus === "shipped";
  if (job.shippingStatus === "shipped") return false;
  if (scope === "shipping") return isDone(job);
  return scope !== "orders" || !isDone(job);
}

function progress(job) {
  if (job.shippingStatus === "shipped") return 100;
  const completed = STAGES.filter((stage) => stageStatus(job, stage.key) === "done").length;
  const shipped = job.shippingStatus === "shipped" ? 1 : 0;
  return Math.round(((completed + shipped) / (STAGES.length + 1)) * 100);
}

function currentStage(job) {
  if (job.shippingStatus === "shipped") return { key: "complete", label: job.completionKind === "stock_fulfillment" ? "受注履行完了" : "出荷完了", status: "done", assignee: "" };
  if (polishingCounts(job).outstanding > 0) return { key: "polishing", label: "研磨中", status: "working", assignee: "" };
  if (isDone(job)) return { key: "shipping", label: "出荷待ち", status: "waiting", assignee: "" };
  const current = STAGES.find((stage) => stageStatus(job, stage.key) !== "done");
  if (current) return { ...stageForJob(current, job), status: stageStatus(job, current.key), assignee: stageAssignee(job, current.key) };
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
  return `<span class="assignment-strip" aria-label="工程ごとの担当者">${STAGES.map((baseStage) => {
    const stage = stageForJob(baseStage, job);
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
  return ["customer", "product", "productCode", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo"]
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

function customerSortGroup(name) {
  if (/^在庫/.test(name)) return 3;
  if (!name) return 2;
  return /^田中(?:医科|$)/.test(name) ? 0 : 1;
}

function compareCustomer(left, right) {
  const a = normalizeProductText(left);
  const b = normalizeProductText(right);
  return customerSortGroup(a) - customerSortGroup(b) || NATURAL_COLLATOR.compare(b, a);
}

function normalizeJobSort(value, scope = "orders") {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowed = JOB_SORT_KEYS.filter((key) => scope !== "completed" || key !== "priority");
  const result = {};
  const used = new Set();
  ["sort", "sort2", "sort3"].forEach((field, index) => {
    const fallback = ["customer", "serial", "none"][index];
    const requested = input[field] === undefined ? fallback : input[field];
    const key = allowed.includes(requested) ? requested : index ? "none" : "customer";
    result[field] = used.has(key) ? "none" : key;
    if (key !== "none") used.add(key);
    const direction = input[`${field}Direction`];
    result[`${field}Direction`] = ["asc", "desc"].includes(direction) ? direction : ["customer", "updated"].includes(key) ? "desc" : "asc";
  });
  return result;
}

function readStoredJobSort(scope) {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || "{}");
    return normalizeJobSort(saved?.[scope], scope);
  } catch { return normalizeJobSort(null, scope); }
}

function setWorkspaceSort(scope, changes = {}) {
  if (!["orders", "shipping", "completed"].includes(scope)) return;
  const next = { ...normalizeJobSort(state.filters[scope], scope), ...changes };
  ["sort", "sort2", "sort3"].forEach((field) => {
    if (changes[field] !== undefined && changes[`${field}Direction`] === undefined) delete next[`${field}Direction`];
  });
  const preferences = normalizeJobSort(next, scope);
  Object.assign(state.filters[scope], preferences);
  try {
    const saved = { orders: readStoredJobSort("orders"), shipping: readStoredJobSort("shipping"), completed: readStoredJobSort("completed"), [scope]: preferences };
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(saved));
  } catch { /* Sorting remains usable when device storage is unavailable. */ }
  return preferences;
}

function sortCriteriaFor(scope) {
  if (!["orders", "shipping", "completed"].includes(scope)) {
    const key = state.filters[scope]?.sort || "customer";
    return [{ key, direction: ["customer", "updated"].includes(key) ? "desc" : "asc" }];
  }
  const preferences = normalizeJobSort(state.filters[scope], scope);
  return ["sort", "sort2", "sort3"].filter((field) => preferences[field] !== "none")
    .map((field) => ({ key: preferences[field], direction: preferences[`${field}Direction`] }));
}

function compareSortValue(left, right, direction = "asc", numeric = false) {
  const a = numeric ? left : String(left ?? "").trim();
  const b = numeric ? right : String(right ?? "").trim();
  const aBlank = a == null || a === "" || (numeric && !Number.isFinite(a));
  const bBlank = b == null || b === "" || (numeric && !Number.isFinite(b));
  if (aBlank || bBlank) return Number(aBlank) - Number(bBlank);
  return (numeric ? a - b : NATURAL_COLLATOR.compare(a, b)) * (direction === "desc" ? -1 : 1);
}

function displayedProductCode(job) {
  return String(job.productMaster?.productCode || "").trim() || String(job.productCode || "").trim();
}

function compareJobsByCriterion(a, b, { key, direction }, scope) {
  if (key === "customer") {
    const left = normalizeProductText(a.customer), right = normalizeProductText(b.customer);
    return customerSortGroup(left) - customerSortGroup(right) || compareSortValue(left, right, direction);
  }
  if (key === "priority") return compareSortValue(priorityScore(a), priorityScore(b), direction, true);
  if (key === "updated") {
    const stamp = (job) => Date.parse(scope === "completed" ? job.completedAt || "" : job.updatedAt || "");
    return compareSortValue(stamp(a), stamp(b), direction, true);
  }
  if (key === "quantity") {
    const amount = (job) => job.quantity === "" || job.quantity == null ? null : Number(job.quantity);
    return compareSortValue(amount(a), amount(b), direction, true);
  }
  if (key === "category") return compareCategory(a, b) * (direction === "desc" ? -1 : 1);
  const value = (job) => {
    if (key === "product") return normalizeProductText(job.productMaster?.displayProduct ?? job.product) ? productDisplayName(job) : "";
    if (key === "productCode") return displayedProductCode(job);
    return key === "serial" ? job.serialNo : job.dueDate;
  };
  return compareSortValue(value(a), value(b), direction);
}

function sortedJobs(scope) {
  const criteria = sortCriteriaFor(scope);
  const jobs = [...filteredJobs(scope)];
  return jobs.sort((a, b) => {
    for (const criterion of criteria) {
      const compared = compareJobsByCriterion(a, b, criterion, scope);
      if (compared) return compared;
    }
    return compareTextBlankLast(a.serialNo, b.serialNo) || compareTextBlankLast(a.id, b.id);
  });
}

function filteredJobs(scope) {
  const { query, stage, attention = "all", period = "all" } = state.filters[scope] || { query: "", stage: "all" };
  const normalized = query.trim().toLocaleLowerCase("ja");
  return state.jobs.filter((job) => {
    if (!matchesJobScope(job, scope)) return false;
    const completedScope = scope === "completed";
    const matchesQuery = !normalized || [job.customer, productDisplayName(job), jobCategory(job), job.serialNo, job.specLength, job.specShape, job.bladeWidth, job.note, ...STAGES.map((item) => stageAssignee(job, item.key))]
      .some((value) => String(value || "").toLocaleLowerCase("ja").includes(normalized));
    const current = currentStage(job);
    const matchesStage = stage === "all" || current.key === stage;
    const matchesAttention = attention === "all"
      || (attention === "production" && !isDone(job))
      || (attention === "due" && daysUntil(job.dueDate) <= 2)
      || (attention === "shipping" && isDone(job));
    const matchesPeriod = !completedScope || matchesCompletedPeriod(job, period);
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
  if (state.accessRevoked) return;
  if (snapshotLoading || (quiet && backgroundOperations.size)) return;
  if (quiet && ledgerPinch) return;
  snapshotLoading = true;
  const writeRevision = mutationRevision;
  const processRevision = processSaveRevision;
  const accessRevision = state.accessSettingsRevision;
  const printRevision = state.labelPrintSaveRevision;
  const distributionRevision = state.distributionSaveRevision;
  const distributionSettingsRevision = state.distributionSettingsSaveRevision;
  const polishingRevision = state.polishingSaveRevision;
  const metadataRevision = state.productMetadataRevision;
  const materialRevision = state.materialInventoryRevision;
  if (!quiet) setConnection("loading", "データを読み込んでいます");
  if (state.mode === "loading") setStartupState();
  const slowTimer = state.mode === "loading" ? setTimeout(() => {
    if (snapshotLoading && state.mode === "loading" && !state.accessRevoked) qs("#startup-message").textContent = "接続に時間がかかっています。読み込みを続けています…";
  }, 8000) : null;
  try {
    const snapshot = await api.getSnapshot({ since: state.lastSync });
    if (state.accessRevoked) return;
    if (quiet && ledgerPinch) return;
    const unchanged = !backgroundOperations.size && writeRevision === mutationRevision;
    if (unchanged && !pendingJobMutations.size && !state.orderSaving && !pendingProcessSaves.size && processRevision === processSaveRevision
      && !state.labelPrintSaving && printRevision === state.labelPrintSaveRevision
      && !state.distributionSaving.size && distributionRevision === state.distributionSaveRevision
      && !state.polishingSaving.size && polishingRevision === state.polishingSaveRevision
      && !state.polishingRulesSaving.size && metadataRevision === state.productMetadataRevision) {
      state.jobs = snapshot.jobs || [];
      appliedSnapshotRevision += 1;
      reconcilePolishingRetry();
    }
    if (unchanged && !intakeDeleteBusy && !intakeApproveBusy && !bulkIntakeBusy) state.intake = (snapshot.intake || []).filter((item) => item.status === "pending");
    if (unchanged && !state.stageAssigneeSettingsSaving && !state.orderSaving && !state.distributionAssigneeSettingsSaving && distributionSettingsRevision === state.distributionSettingsSaveRevision && !state.polishingRatesSaving && !state.polishingRulesSaving.size && metadataRevision === state.productMetadataRevision) state.settings = snapshot.settings || {};
    if (metadataRevision === state.productMetadataRevision) state.productMasterStatus = snapshot.productMasterStatus || null;
    state.mode = snapshot.mode || (isAppsScript ? "live" : "demo");
    state.aiImport = snapshot.aiImport || { ready: false, configured: false };
    state.scriptEditorUrl = snapshot.scriptEditorUrl || "";
    const previousAccess = state.access;
    state.access = snapshot.access || { email: "", isAdmin: false };
    if (!canEdit()) state.materialInventory = null;
    else if (unchanged && materialRevision === state.materialInventoryRevision) state.materialInventory = snapshot.materialInventory || null;
    const roleRank = { viewer: 0, worker: 1, editor: 2, admin: 3, owner: 4 };
    if ((roleRank[accessRole(state.access)] ?? 0) < (roleRank[accessRole(previousAccess)] ?? 0)) closeMutationDialogs();
    if (isOwnerUser(previousAccess) && !isOwnerUser(state.access) && qs("#import-dialog")?.open) closeDialog(qs("#import-dialog"));
    if (!state.accessSettingsDirty && !state.accessSettingsSaving && accessRevision === state.accessSettingsRevision) state.accessSettings = snapshot.accessSettings || null;
    if (!canEdit()) finishedStockUi?.clear();
    else if (unchanged && state.activeView === "finishedStock") invalidateFinishedStock({ passive: true });
    state.lastSync = snapshot.serverTime || new Date().toISOString();
    setStartupState();
    renderAll();
    setConnection("online", state.mode === "demo" ? "ローカル確認用データ" : "スプレッドシートと同期中");
  } catch (error) {
    setConnection("error", "同期できませんでした");
    if (state.mode === "loading") setStartupState(`通信状態を確認して、もう一度お試しください。${error.message}`);
    if (!quiet) showToast(`データを読み込めませんでした。${error.message}`, { tone: "error" });
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
    snapshotLoading = false;
  }
}

function renderAll() {
  renderHeader();
  renderActiveView();
  const engine = qs("#import-engine");
  if (!engine.dataset.chosen) engine.value = state.aiImport.ready ? "ai" : "legacy";
  qs("#ai-import-status").textContent = state.aiImport.ready
    ? "AI設定済み。Googleの設定に従って利用します。上限時は停止し、自動再試行しません。"
    : "AIは未設定です。APIキーをサーバーに設定すると使えます。現在は従来の読取を利用できます。";
  if (qs("#label-dialog")?.open) renderLabelPrintDialog();
  qs("#last-sync").textContent = `最終同期 ${formatDateTime(state.lastSync)}`;
  applyAccessVisibility();
}

function renderActiveView() {
  if (state.mode === "loading") return;
  const renderers = {
    dashboard() { renderMetrics(); renderDashboardOrders(); },
    orders: renderOrdersWorkspace,
    shipping: renderFinishedWorkspace,
    completed: renderFinishedWorkspace,
    distribution: renderDistributionWorkspace,
    polishing: renderPolishingWorkspace,
    materials: renderMaterialWorkspace,
    finishedStock: renderFinishedStockWorkspace,
    intake: renderIntake,
    settings: renderSettings,
  };
  renderers[state.activeView]?.();
}

function closeMutationDialogs() {
  pendingDiscardDialog = null;
  if (qs("#discard-dialog")?.open) qs("#discard-dialog").close();
  ["#order-dialog", "#process-dialog", "#polishing-dialog", "#material-dialog", "#import-dialog", "#intake-dialog", "#bulk-intake-dialog", "#customer-rules-dialog", "#intake-learning-dialog"].forEach((selector) => {
    const dialog = qs(selector);
    if (dialog?.open) dialog.close();
  });
  pendingCustomerCorrection = null;
  if (qs("#customer-command-preview")) qs("#customer-command-preview").hidden = true;
  clearLabelPrintConfirmation();
}

function applyAccessVisibility() {
  const editor = canEdit();
  const worker = canWork();
  if (!canAccessView(state.activeView)) switchView(isWorkerUser() ? "orders" : "dashboard");
  qsa("[data-admin-only]").forEach((element) => { element.hidden = !isAdminUser(); });
  qsa("[data-owner-only]").forEach((element) => { element.hidden = !isOwnerUser(); });
  qsa("[data-edit-only]").forEach((element) => { element.hidden = !editor; });
  qsa("[data-work-only]").forEach((element) => { element.hidden = !worker; });
  qsa("[data-action='open-process'], [data-distribution-assignee]").forEach((element) => {
    const job = state.jobs.find((entry) => entry.id === (element.dataset.orderId || element.dataset.distributionId));
    element.hidden = element.dataset.stageKey === "shipping" ? !editor : !canWorkOnJob(job);
  });
  qsa("[data-action='edit-order'], [data-action='open-import'], [data-intake-id]").forEach((element) => { element.hidden = !editor; });
  qsa("[data-non-worker]").forEach((element) => { element.hidden = isWorkerUser(); });
  qsa("[data-view]").forEach((element) => { element.hidden = !canAccessView(element.dataset.view); });
  qsa("[data-view-panel]").forEach((element) => { element.hidden = !canAccessView(element.dataset.viewPanel) || state.activeView !== element.dataset.viewPanel; });
  if (isWorkerUser() && qs("#label-dialog")?.open) closeDialog(qs("#label-dialog"));
  if (!editor && qs("#polishing-dialog")?.open) closeDialog(qs("#polishing-dialog"), { force: true });
  if (qs("#process-dialog")?.open && !canWorkOnJob(state.jobs.find((job) => job.id === qs("#process-form").elements.id.value))) {
    closeDialog(qs("#process-dialog"), { force: true });
  }
  if (!editor) {
    state.materialInventory = null;
    materialUi?.setSnapshot(null);
    finishedStockUi?.clear();
    if (qs("#material-dialog")?.open) qs("#material-dialog").close();
  }
  const intakeView = qs("[data-view-panel='intake']");
  if (intakeView) intakeView.hidden = !editor || state.activeView !== "intake";
  const intakeBulkEntry = qs("#intake-bulk-entry");
  if (intakeBulkEntry && !editor) intakeBulkEntry.hidden = true;
  const markButton = qs("#mark-selected-labels-button");
  if (markButton) markButton.hidden = !editor || state.labelPrintPendingConfirmation.length > 0;
  const result = qs("#label-print-result");
  if (result && !editor) result.hidden = true;
  const remember = qs("#customer-command-remember");
  const rememberLabel = remember?.closest("label");
  if (rememberLabel) rememberLabel.hidden = !isAdminUser();
  if (remember && !isAdminUser()) remember.checked = false;
  const learningButton = qs("[data-action='open-intake-learning']");
  if (learningButton) learningButton.hidden = !editor;
  if (!editor && qs("#intake-learning-dialog")?.open) closeDialog(qs("#intake-learning-dialog"), { force: true });
}


const POLISHING_CLASSES = ["A", "B", "B(メニスカス)", "C", "D", "特殊", "江部電解", "江部磨き", "自由設定", "未分類"];
const POLISHING_DEFAULT_RATES = { "江部": 840, "江部電解": 540, "江部磨き": 2400, A: 2000, B: 2500, "B(メニスカス)": 3300, C: 3000, D: 3500, "特殊": 4500 };
const KAYO_POLISHING_CLASSES = ["A", "B", "B(メニスカス)", "C", "D", "特殊", "未分類"];

function isEbeOnlyPolishing(job) { return ["江部電解", "江部磨き"].includes(polishingClass(job)); }

function polishingClass(job) {
  const code = job.productMaster?.classCode;
  return POLISHING_CLASSES.includes(code) ? code : "未分類";
}

function normalizeCustomPolishingRates(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["江部", "嘉代"].includes(key))) throw new Error("自由設定の単価形式が不正です。");
  return Object.fromEntries(["江部", "嘉代"].map((vendor) => {
    const rate = value[vendor];
    if (rate == null || typeof rate === "string" && rate.trim() === "") return [vendor, null];
    if (!["number", "string"].includes(typeof rate) || !/^\d+(?:\.\d{1,2})?$/.test(String(rate).trim()) || !Number.isFinite(Number(rate)) || Number(rate) > 1000000) throw new Error(`${vendor}の単価は0〜1000000円、小数2桁までで入力してください。`);
    return [vendor, Number(rate)];
  }));
}

function customPolishingRateControl(job, busy) {
  if (polishingClass(job) !== "自由設定") return "";
  const saved = normalizeCustomPolishingRates(job.productMaster?.customRates);
  if (!canEdit()) return `<div class="polishing-custom-rates">${["江部", "嘉代"].map((vendor) => `<small>${vendor} ${saved[vendor] == null ? "未設定" : `¥${saved[vendor].toLocaleString("ja-JP")} / 丁`}</small>`).join("")}</div>`;
  const draft = state.polishingCustomRateDrafts.get(job.id);
  const values = draft?.values || saved;
  const disabled = busy || state.polishingRulesSaving.size || state.polishingSaving.size || pendingProcessSaves.size;
  return `<div class="polishing-custom-rates" role="group" aria-label="${escapeHtml(productDisplayName(job))}の自由設定単価">${["江部", "嘉代"].map((vendor) => `<label><span>${vendor}（円 / 丁）</span><input type="number" min="0" max="1000000" step="0.01" inputmode="decimal" data-polishing-custom-id="${escapeHtml(job.id)}" data-polishing-custom-vendor="${vendor}" aria-label="${escapeHtml(productDisplayName(job))}の${vendor}自由設定単価" value="${escapeHtml(values[vendor] ?? "")}" placeholder="未設定" ${disabled ? "disabled" : ""}></label>`).join("")}<button type="button" class="button button-quiet" data-action="save-polishing-custom-rates" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(productDisplayName(job))}の自由設定単価を保存" ${disabled ? "disabled" : ""}>単価を保存</button><button type="button" class="button button-quiet" data-action="reset-polishing-custom-rates" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(productDisplayName(job))}の単価入力を戻す" ${disabled ? "disabled" : ""}>入力を戻す</button>${draft?.error ? `<small class="polishing-error" role="status">${escapeHtml(draft.error)}</small>` : ""}</div>`;
}

function polishingClassControl(job, busy = false) {
  const master = job.productMaster || {};
  const code = polishingClass(job);
  const manual = master.source === "manual";
  const label = code === "未分類" ? "未分類・要確認" : code;
  const warningClass = code === "未分類" ? ' class="polishing-class-unclassified"' : "";
  const control = canEdit() ? `<select${warningClass} data-polishing-class-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(productDisplayName(job))}の研磨区分（同じ製品にも反映）" ${busy || state.polishingRulesSaving.size || state.polishingSaving.size ? "disabled" : ""}><option value="" ${!manual ? "selected" : ""}>自動判定${!manual ? `（${label}）` : "に戻す"}</option>${POLISHING_CLASSES.map((value) => `<option value="${value}" ${manual && code === value ? "selected" : ""}>${value === "未分類" ? "未分類・要確認" : value}</option>`).join("")}</select>` : `<strong${warningClass}>${label}</strong>`;
  return `${control}${customPolishingRateControl(job, busy)}${isEbeOnlyPolishing(job) ? "<small>江部のみ・通常840円は除外</small>" : ""}<details><summary>${manual ? "保存した区分" : "判定の詳細"}</summary><p>${escapeHtml(master.message || "マスタの該当製品を確認してください。")}</p>${master.product ? `<p>${escapeHtml(master.product)}</p>` : ""}<p>使用材料：${escapeHtml(master.material || "未登録")}</p>${canEdit() ? '<p>変更は同じ製品と月別集計に反映します。</p>' : ""}</details>`;
}

function parsePolishingSetting(value) {
  if (!value) return {};
  return typeof value === "string" ? JSON.parse(value) : value;
}

function polishingMonth(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {year:"numeric",month:"2-digit",timeZone:BUSINESS_TIME_ZONE}).formatToParts(date);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

function polishingRatesForMonth(settings, month) {
  const stored = parsePolishingSetting(settings.polishingRates)[month] || {};
  return Object.fromEntries(Object.entries(POLISHING_DEFAULT_RATES).map(([key, fallback]) => {
    const value = Object.hasOwn(stored, key) ? stored[key] : fallback;
    return [key, typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000 ? value : null];
  }));
}

function polishingMonthlySummary(jobs, settings, month) {
  const prices = polishingRatesForMonth(settings, month);
  const round = (value) => Math.round(value * 100) / 100;
  const rows = [
    ...["江部", "江部電解", "江部磨き"].map((classCode) => ({ vendor: "江部", classCode })),
    ...KAYO_POLISHING_CLASSES.map((classCode) => ({ vendor: "嘉代", classCode })),
  ].map((row) => ({...row, quantity: 0, unitPrice: prices[row.classCode] ?? null, knownAmount: 0, missingQuantity: 0, amount: 0}));
  const customRows = new Map();
  let quantity = 0, missingQuantity = 0;
  for (const job of jobs) {
    const returned = activePolishingReturns(job).filter((event) => polishingMonth(event.at) === month).reduce((sum, event) => sum + (Number.isFinite(Number(event.quantity)) && Number(event.quantity) > 0 ? Number(event.quantity) : 0), 0);
    if (!returned) continue;
    quantity += returned;
    const code = polishingClass(job), ebeOnly = isEbeOnlyPolishing(job);
    if (code === "自由設定") {
      const customRates = normalizeCustomPolishingRates(job.productMaster?.customRates);
      for (const vendor of ["江部", "嘉代"]) {
        const unitPrice = customRates[vendor], key = `${vendor}:${unitPrice ?? "unknown"}`;
        if (!customRows.has(key)) {
          const row = {vendor, classCode: "自由設定", unitPrice, productNames: [], quantity: 0, knownAmount: 0, missingQuantity: 0, amount: 0};
          rows.push(row); customRows.set(key, row);
        }
        const row = customRows.get(key), name = productDisplayName(job);
        row.quantity += returned;
        if (name && !row.productNames.includes(name)) row.productNames.push(name);
      }
      if (Object.values(customRates).some((value) => value == null)) missingQuantity += returned;
      continue;
    }
    const ebe = rows.find((row) => row.vendor === "江部" && row.classCode === (ebeOnly ? code : "江部"));
    ebe.quantity += returned;
    let missing = ebe.unitPrice == null;
    if (!ebeOnly) {
      const kayo = rows.find((row) => row.vendor === "嘉代" && row.classCode === code);
      kayo.quantity += returned;
      missing ||= kayo.unitPrice == null;
    }
    if (missing) missingQuantity += returned;
  }
  for (const row of rows) {
    row.knownAmount = round(row.quantity * (row.unitPrice || 0));
    row.missingQuantity = row.quantity && row.unitPrice == null ? row.quantity : 0;
    row.amount = row.missingQuantity ? null : row.knownAmount;
  }
  const vendorTotals = ["江部", "嘉代"].map((vendor) => {
    const lines = rows.filter((row) => row.vendor === vendor);
    const knownAmount = round(lines.reduce((sum, row) => sum + row.knownAmount, 0));
    const missingQuantity = lines.reduce((sum, row) => sum + row.missingQuantity, 0);
    return {vendor, quantity: lines.reduce((sum, row) => sum + row.quantity, 0), knownAmount, missingQuantity, totalAmount: missingQuantity ? null : knownAmount};
  });
  const knownAmount = round(vendorTotals.reduce((sum, entry) => sum + entry.knownAmount, 0));
  return { rows, vendorTotals, quantity, missingQuantity, knownAmount, totalAmount: missingQuantity ? null : knownAmount };
}

function renderPolishingBilling() {
  const month = state.polishingBillingMonth || polishingMonth(new Date().toISOString());
  state.polishingBillingMonth = month;
  qs("#polishing-billing-month").value = month;
  const summary = polishingMonthlySummary(state.jobs, state.settings, month);
  const yen = (value) => value == null ? "未設定" : `¥${value.toLocaleString("ja-JP", {maximumFractionDigits:2})}`;
  const totalLabel = (total) => total.totalAmount == null ? `未確定（要確認 ${total.missingQuantity}丁）・計算済み ${yen(total.knownAmount)}` : yen(total.totalAmount);
  qs("#polishing-billing-summary").innerHTML = `<div class="polishing-vendor-totals">${summary.vendorTotals.map((total) => `<p><span>${total.vendor} ${total.quantity}丁</span><strong>${totalLabel(total)}</strong></p>`).join("")}</div><div class="polishing-billing-table-wrap" tabindex="0" role="region" aria-label="研磨先別の月別研磨代"><table><caption>${escapeHtml(month)} の戻り ${summary.quantity}丁</caption><thead><tr><th scope="col">研磨先</th><th scope="col">区分</th><th scope="col">戻り数量</th><th scope="col">単価（円 / 丁）</th><th scope="col">金額</th></tr></thead><tbody>${summary.rows.filter((row) => row.classCode !== "未分類").map((row) => `<tr><td>${row.vendor}</td><th scope="row">${row.classCode === "江部" ? "通常" : row.classCode}${row.productNames?.length ? `<small class="polishing-billing-products">${row.productNames.map(escapeHtml).join("・")}</small>` : ""}</th><td>${row.quantity}丁</td><td>${yen(row.unitPrice)}</td><td>${row.amount == null ? "未確定" : yen(row.amount)}</td></tr>`).join("")}</tbody></table></div><p class="polishing-billing-total">支払額合計：${totalLabel(summary)}</p>`;
  if (!state.polishingRatesDirty && !state.polishingRatesSaving) {
    const rates = polishingRatesForMonth(state.settings, month);
    state.polishingRatesBase = parsePolishingSetting(state.settings.polishingRates)[month] || null;
    state.polishingRatesBase = state.polishingRatesBase ? structuredClone(state.polishingRatesBase) : null;
    qs("#polishing-rate-fields").innerHTML = [["江部", ["江部", "江部電解", "江部磨き"]], ["嘉代", ["A", "B", "B(メニスカス)", "C", "D", "特殊"]]].map(([vendor, codes]) => `<fieldset><legend>${vendor}</legend><div class="polishing-rate-group">${codes.map((code) => `<label class="field"><span>${code === "江部" ? "通常" : code}</span><input data-polishing-rate="${code}" aria-label="${vendor} ${code === "江部" ? "通常" : code}の単価" type="number" min="0" max="1000000" step="0.01" inputmode="decimal" value="${rates[code] ?? ""}" placeholder="未設定"></label>`).join("")}</div></fieldset>`).join("");
  }
  qs("#polishing-rates-save").disabled = state.polishingRatesSaving;
  qs("#polishing-rate-settings").hidden = !isAdminUser();
  qs("#polishing-rates-status").textContent = state.polishingRatesMessage;
}

function renderProductMasterStatus() {
  const info = state.productMasterStatus;
  const node = qs("#polishing-master-status");
  if (!info) { node.textContent = "製品構成マスタの読込状態は未確認です。"; return; }
  node.textContent = `製品構成マスタ：${info.status === "snapshot" ? "保存済みデータ" : "参照済み"}${info.asOf ? `（${formatDateTime(info.asOf)}）` : ""}${info.warning ? ` · ${info.warning}` : ""}`;
}

function mergeProductMetadata(jobs) {
  const metadata = new Map((jobs || []).map((entry) => [entry.id, entry]));
  state.jobs = state.jobs.map((entry) => {
    const next = metadata.get(entry.id);
    return next && !jobMutationPending(entry.id) && Number(next.version) === Number(entry.version) ? {...entry,productMaster:next.productMaster} : entry;
  });
}

async function savePolishingRule(select, patch, draft = null) {
  if (!canEdit() || state.polishingRulesSaving.size || state.polishingSaving.size || pendingProcessSaves.size) { renderPolishingWorkspace(); return false; }
  const job = state.jobs.find((entry) => entry.id === select.dataset.polishingClassId);
  if (!job) return false;
  const rules = parsePolishingSetting(state.settings.polishingProductRules);
  const expectedRule = draft ? draft.expectedRule : rules[job.productMaster?.key] ? structuredClone(rules[job.productMaster.key]) : null;
  state.polishingRulesSaving.add(job.id);
  state.productMetadataRevision += 1;
  select.disabled = true;
  qsa("[data-polishing-class-id], [data-polishing-custom-id], [data-action='save-polishing-custom-rates'], [data-action='reset-polishing-custom-rates']").forEach((control) => { control.disabled = true; });
  try {
    const result = await api.savePolishingProductRule({ id: job.id, version: job.version, ...patch, expectedRule });
    mergeProductMetadata(result.jobs);
    state.settings.polishingProductRules = result.settings?.polishingProductRules || "{}";
    state.productMasterStatus = result.productMasterStatus || state.productMasterStatus;
    state.polishingCustomRateDrafts.delete(job.id);
    showToast(`研磨設定を保存しました。同じ製品と月別集計に反映します。${result.mirrorWarning || ""}`);
    return true;
  } catch (error) { if (draft) draft.error = error.message; showToast(error.message, {tone:"error",sticky:true}); return false; }
  finally { state.polishingRulesSaving.delete(job.id); state.productMetadataRevision += 1; polishingRenderSignature = ""; renderAll(); }
}

function savePolishingClassification(select) { return savePolishingRule(select, {classCode: select.value}); }

function polishingCustomRateDraft(job) {
  if (!state.polishingCustomRateDrafts.has(job.id)) {
    const rules = parsePolishingSetting(state.settings.polishingProductRules);
    const key = job.productMaster?.key;
    state.polishingCustomRateDrafts.set(job.id, {key, values: normalizeCustomPolishingRates(job.productMaster?.customRates), expectedRule: rules[key] ? structuredClone(rules[key]) : null, error: ""});
  }
  return state.polishingCustomRateDrafts.get(job.id);
}

function editPolishingCustomRate(input) {
  if (!canEdit() || state.polishingRulesSaving.size || state.polishingSaving.size) return;
  const job = state.jobs.find((entry) => entry.id === input.dataset.polishingCustomId);
  const vendor = input.dataset.polishingCustomVendor;
  if (!job || polishingClass(job) !== "自由設定" || !["江部", "嘉代"].includes(vendor)) return;
  const draft = polishingCustomRateDraft(job);
  draft.values[vendor] = input.value;
  draft.error = "";
  input.closest?.(".polishing-custom-rates")?.querySelector("[role='status']")?.remove();
}

function savePolishingCustomRates(button) {
  if (!canEdit() || state.polishingRulesSaving.size || state.polishingSaving.size || pendingProcessSaves.size) return;
  const job = state.jobs.find((entry) => entry.id === button.dataset.orderId);
  if (!job || polishingClass(job) !== "自由設定") return;
  const draft = polishingCustomRateDraft(job);
  try {
    if (draft.key !== job.productMaster?.key) throw new Error("製品情報が変更されています。入力を戻してから再度設定してください。");
    const customRates = normalizeCustomPolishingRates(draft.values);
    return savePolishingRule({dataset: {polishingClassId: job.id}}, {classCode: "自由設定", customRates}, draft);
  } catch (error) {
    draft.error = error.message;
    showToast(error.message, {tone:"error",sticky:true});
    polishingRenderSignature = "";
    renderPolishingWorkspace();
  }
}

function resetPolishingCustomRates(id) {
  if (!canEdit() || state.polishingRulesSaving.size || state.polishingSaving.size) return;
  state.polishingCustomRateDrafts.delete(id);
  polishingRenderSignature = "";
  renderPolishingWorkspace();
}

async function savePolishingRateForm(event) {
  event.preventDefault();
  if (!isAdminUser() || state.polishingRatesSaving) return;
  const rates = {};
  for (const input of qsa("[data-polishing-rate]")) {
    const value = input.value.trim();
    if (value && (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > 1000000)) { showToast("単価は0〜1000000円、小数2桁までで入力してください。", {tone:"error"}); input.focus(); return; }
    rates[input.dataset.polishingRate] = value ? Number(value) : null;
  }
  const month = state.polishingBillingMonth;
  const expectedRates = state.polishingRatesBase;
  state.polishingRatesSaving = true;
  state.productMetadataRevision += 1;
  state.polishingRatesMessage = "単価を保存しています…";
  renderPolishingBilling();
  qsa("[data-polishing-rate], [data-action='copy-polishing-rates']").forEach((input) => { input.disabled = true; });
  try {
    const settings = await api.savePolishingRates({ month, rates, expectedRates });
    state.settings.polishingRates = settings.polishingRates;
    state.polishingRatesDirty = false;
    state.polishingRatesMessage = `${month} の単価を保存しました。`;
  } catch (error) { state.polishingRatesMessage = `保存できませんでした。${error.message}`; showToast(state.polishingRatesMessage, {tone:"error",sticky:true}); }
  finally {
    state.polishingRatesSaving = false; state.productMetadataRevision += 1;
    qsa("[data-polishing-rate], [data-action='copy-polishing-rates']").forEach((input) => { input.disabled = false; });
    renderPolishingBilling();
  }
}

function copyPreviousPolishingRates() {
  if (!isAdminUser() || state.polishingRatesSaving) return;
  const date = new Date(`${state.polishingBillingMonth}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  const month = date.toISOString().slice(0, 7);
  const previous = polishingRatesForMonth(state.settings, month);
  qsa("[data-polishing-rate]").forEach((input) => { input.value = previous[input.dataset.polishingRate] ?? ""; });
  state.polishingRatesDirty = true; state.polishingRatesMessage = `${month} の単価を入力しました。保存すると反映されます。`;
  qs("#polishing-rates-status").textContent = state.polishingRatesMessage;
}

async function refreshProductMaster(button) {
  if (!isAdminUser() || state.polishingRulesSaving.size) return;
  setButtonState(button, "loading"); state.productMetadataRevision += 1;
  try {
    const result = await api.refreshProductMaster();
    mergeProductMetadata(result.jobs);
    state.productMasterStatus = result.productMasterStatus;
    showToast(result.productMasterStatus?.warning || `製品構成マスタを更新しました。${result.mirrorWarning || ""}`);
  } catch (error) { showToast(error.message, {tone:"error",sticky:true}); }
  finally { state.productMetadataRevision += 1; setButtonState(button, null); renderAll(); }
}

function polishingCounts(job) {
  const sent = Number(job.polishing?.sentQuantity || 0);
  const returned = Number(job.polishing?.returnedQuantity || 0);
  return { sent, returned, outstanding: Math.max(0, sent - returned), available: Math.max(0, Number(job.quantity || 0) - sent) };
}

function activePolishingReturns(job) {
  const history = job.polishing?.history || [];
  const undone = new Set(history.filter((event) => event.action === "undo-return").map((event) => event.returnRequestId));
  return history.filter((event) => event.action === "return" && !undone.has(event.requestId));
}

function latestPolishingReturn(job) { return activePolishingReturns(job).at(-1); }

function polishingDateAt(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("研磨の日付を正しく入力してください。");
  const at = new Date(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(at.getTime()) || businessDateKey(at) !== date) throw new Error("研磨の日付を正しく入力してください。");
  if (date > todayIso()) throw new Error("研磨の日付に未来の日付は指定できません。");
  return at.toISOString();
}

function validatePolishingDates(history) {
  const daily = new Map();
  for (const entry of history) {
    const day = businessDateKey(entry.at);
    daily.set(day, (daily.get(day) || 0) + (["send", "undo-return"].includes(entry.action) ? entry.quantity : -entry.quantity));
  }
  let balance = 0;
  for (const [, quantity] of [...daily].sort(([a], [b]) => a.localeCompare(b))) {
    balance += quantity;
    if (balance < 0) throw new Error("戻り日・取消日が発送日より前になる日付は指定できません。研磨履歴の日付を確認してください。");
  }
}

function polishingEventDateLabel(entry) {
  return entry.recordedAt ? formatDate(businessDateKey(entry.at), {year:"numeric",month:"numeric",day:"numeric"}) : formatDateTime(entry.at);
}

function polishingHistoryMarkup(job, busy = false) {
  const history = job.polishing?.history || [];
  const activeReturns = activePolishingReturns(job);
  const activeIds = new Set(activeReturns.map((event) => event.requestId));
  const lastReturn = activeReturns.at(-1);
  const editable = canEdit() && !job.archived && job.shippingStatus !== "shipped";
  const disabled = busy || state.polishingSaving.size || state.polishingRulesSaving.size || state.distributionSaving.has(job.id);
  const actionLabels = {send:"発送", return:"戻り", cancel:"発送取消", "undo-return":"戻り取消"};
  const undo = editable && lastReturn ? `<button class="button button-quiet" type="button" data-edit-only data-action="undo-polishing-return" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(productDisplayName(job))}の直前の戻り${escapeHtml(lastReturn.quantity)}丁を取り消し、研磨状態に戻す" ${disabled ? "disabled" : ""}>研磨状態に戻す</button>` : "";
  const cancel = editable && polishingCounts(job).outstanding ? `<button class="button button-quiet" type="button" data-edit-only data-action="cancel-polishing-send" data-order-id="${escapeHtml(job.id)}" ${disabled ? "disabled" : ""}>発送を取り消す</button>` : "";
  return `<details class="polishing-history"><summary>${history.length}回</summary><ol>${[...history].reverse().map((entry) => {
    const dateEdit = canEdit() && !job.archived && ["send", "return"].includes(entry.action) ? `<button class="button button-quiet polishing-date-edit" type="button" data-edit-only data-action="edit-polishing-date" data-order-id="${escapeHtml(job.id)}" data-event-request-id="${escapeHtml(entry.requestId)}" aria-label="${escapeHtml(productDisplayName(job))}の${actionLabels[entry.action]}日 ${escapeHtml(polishingEventDateLabel(entry))}を編集" ${disabled ? "disabled" : ""}>日付を編集</button>` : "";
    const edits = entry.dateEdits?.length ? `<small title="${escapeHtml(entry.dateEdits.map((edit) => `${formatDateTime(edit.at)}：${businessDateKey(edit.previousAt)} → ${edit.date}`).join("\n"))}">（日付訂正済み）</small>` : "";
    return `<li>${escapeHtml(polishingEventDateLabel(entry))} · ${actionLabels[entry.action] || "更新"} ${escapeHtml(entry.quantity)}丁${entry.action === "return" && !activeIds.has(entry.requestId) ? "（取消済み）" : ""}${edits}${dateEdit}</li>`;
  }).join("")}</ol>${undo || cancel ? `<div class="polishing-history-actions">${undo}${cancel}</div>` : ""}</details>`;
}

function polishingFinishReady(job) {
  const counts = polishingCounts(job);
  const quantity = Number(job.quantity);
  return Number.isSafeInteger(quantity) && quantity > 0 && counts.sent === quantity && counts.returned === quantity;
}

function invalidFinalFinishing(next, previous = null) {
  if (polishingFinishReady(next)) return false;
  const finish = next.stages?.finish?.status;
  const previousFinish = previous?.stages?.finish?.status;
  const noRecordedPolishing = Boolean(previous) && [previous, next].every((job) => {
    const counts = polishingCounts(job);
    return counts.sent === 0 && counts.returned === 0 && !job?.polishing?.history?.length;
  });
  const unchangedShipment = previous?.shippingStatus === "shipped" && next.shippingStatus === "shipped"
    && previousFinish === finish && (Number(previous.quantity || 0) === Number(next.quantity || 0) || noRecordedPolishing);
  const legacyFinish = previous && previousFinish === "done" && finish === "done" && !polishingFinishReady(previous);
  return !unchangedShipment && (next.shippingStatus === "shipped" || (finish === "done" && !legacyFinish));
}

function stageStatusOptions(job, key) {
  return STATUS_OPTIONS.filter((option) => key !== "finish" || option.value !== "done" || polishingFinishReady(job)
    || (job.shippingStatus === "shipped" && job.stages?.finish?.status === "done"));
}

function polishingFinishLabel(job) {
  const counts = polishingCounts(job);
  if (!counts.returned) return "—";
  const status = stageStatus(job, "finish");
  return status === "done" ? "最終仕上げ完了" : status === "working" ? "最終仕上げ中" : status === "hold" ? "最終仕上げ保留" : "最終仕上げ待ち";
}

function polishingJobs({ jobs = state.jobs, filter = state.polishingFilter, query = state.polishingQuery } = {}) {
  const normalized = query.trim().toLocaleLowerCase("ja");
  return jobs.filter((job) => {
    if (job.archived) return false;
    const counts = polishingCounts(job);
    const matches = filter === "vendor" ? counts.outstanding > 0
      : filter === "finishing" ? counts.returned > 0 && stageStatus(job, "finish") !== "done" && job.shippingStatus !== "shipped"
        : counts.sent > 0 || Boolean(job.polishing?.history?.length);
    return matches && (!normalized || [job.customer, productDisplayName(job), job.productCode, job.serialNo, job.productMaster?.classCode].some((value) => String(value || "").toLocaleLowerCase("ja").includes(normalized)));
  }).sort((a, b) => compareTextBlankLast(a.dueDate, b.dueDate) || compareTextBlankLast(a.customer, b.customer) || compareTextBlankLast(a.serialNo, b.serialNo) || compareTextBlankLast(a.id, b.id));
}

const polishingShortDateFormatter = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", timeZone: BUSINESS_TIME_ZONE });
const polishingFullDateFormatter = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE });

function polishingSentDateMarkup(job) {
  const event = [...(job.polishing?.history || [])].reverse().find((entry) => entry.action === "send");
  const date = new Date(event?.at || "");
  if (Number.isNaN(date.getTime())) return "—";
  return `<time datetime="${escapeHtml(event.at)}" title="発送 ${escapeHtml(polishingFullDateFormatter.format(date))}">${escapeHtml(polishingShortDateFormatter.format(date))}</time>`;
}

function polishingCell(job, completed = false) {
  if (state.polishingSaving.has(job.id)) return '<span class="job-pending" role="status">研 反映中…</span>';
  const counts = polishingCounts(job);
  const send = canEdit() && !completed && counts.available > 0 && Number.isInteger(Number(job.quantity));
  const saving = jobMutationPending(job.id);
  const sendButton = send ? `<button class="polishing-send-button" type="button" data-edit-only data-action="open-polishing-send" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(productDisplayName(job))}を研磨に出す" ${saving ? "disabled" : ""}>研</button>` : "";
  if (!counts.sent) return sendButton || "—";
  const label = counts.outstanding ? "研磨中" : "研磨戻り済";
  const detail = counts.returned ? `戻り ${counts.returned} · ${polishingFinishLabel(job)}` : "";
  const status = isWorkerUser()
    ? `<span title="${escapeHtml(detail || label)}">${label}</span>`
    : `<button class="polishing-state-button" type="button" data-action="show-polishing-order" data-order-id="${escapeHtml(job.id)}" title="${escapeHtml(detail || label)}">${label}</button>`;
  return `<span class="polishing-cell"><span>${status}${sendButton}</span><small class="polishing-sent-date">発 ${polishingSentDateMarkup(job)}</small></span>`;
}

let polishingRenderSignature = "";

function renderPolishingWorkspace() {
  const workspace = qs("#polishing-workspace");
  if (!workspace) return;
  renderPolishingBilling();
  renderProductMasterStatus();
  const all = polishingJobs({ filter: "all", query: "" });
  const vendor = all.filter((job) => polishingCounts(job).outstanding > 0);
  const finishing = all.filter((job) => polishingCounts(job).returned > 0 && stageStatus(job, "finish") !== "done" && job.shippingStatus !== "shipped");
  const classTotals = POLISHING_CLASSES.filter((code) => code !== "未分類").map((code) => `<span>${code}: ${vendor.filter((job) => polishingClass(job) === code).reduce((sum, job) => sum + polishingCounts(job).outstanding, 0)}丁</span>`).join("");
  const vendorQuantity = vendor.reduce((sum, job) => sum + polishingCounts(job).outstanding, 0);
  const finishingQuantity = finishing.reduce((sum, job) => sum + polishingCounts(job).returned, 0);
  qs("#polishing-totals").innerHTML = `<p><span>研磨屋にある数量</span><strong>${vendorQuantity.toLocaleString("ja-JP")} <small>丁 / ${vendor.length}件</small></strong></p><p><span>最終仕上げ待ち・仕上げ中</span><strong>${finishingQuantity.toLocaleString("ja-JP")} <small>丁 / ${finishing.length}件</small></strong></p><div class="polishing-class-summary" aria-label="研磨屋にある区分別数量">${classTotals}</div>`;
  const jobs = polishingJobs();
  for (const id of state.polishingSelection.keys()) {
    if (!jobs.some((job) => job.id === id && polishingCounts(job).outstanding > 0)) state.polishingSelection.delete(id);
  }
  const signature = JSON.stringify([jobs, [...state.polishingSelection], [...state.polishingSaving], canEdit(), canEdit(), state.polishingFilter, [...state.polishingRulesSaving], [...pendingProcessSaves.keys()], [...state.distributionSaving]]);
  if (signature !== polishingRenderSignature) {
    const active = document.activeElement;
    const focusId = active?.dataset?.polishingSelectId;
    const customFocusId = active?.dataset?.polishingCustomId;
    const customFocusVendor = active?.dataset?.polishingCustomVendor;
    const scroll = qs(".polishing-table-wrap", workspace);
    const scrollTop = scroll?.scrollTop || 0;
    const scrollLeft = scroll?.scrollLeft || 0;
    const selectable = jobs.filter((job) => polishingCounts(job).outstanding > 0);
    const selectedVisible = selectable.filter((job) => state.polishingSelection.has(job.id)).length;
    workspace.innerHTML = jobs.length ? `<div class="polishing-table-wrap" tabindex="0" role="region" aria-label="研磨管理表"><table class="polishing-table"><caption class="sr-only">研磨中の数量と戻り数量。複数案件を選択して全数の戻りを反映できます。</caption><thead><tr><th scope="col">${canEdit() ? `<input id="polishing-select-all" type="checkbox" aria-label="表示中の研磨中案件をまとめて選択（最大100件）" ${selectable.length && selectedVisible === selectable.length ? "checked" : ""} ${!selectable.length || state.polishingSaving.size ? "disabled" : ""}>` : ""}</th><th scope="col">得意先</th><th scope="col">品名・製品番号・連番</th><th scope="col">研磨区分</th><th scope="col">納期</th><th scope="col">発送日</th><th scope="col">全数</th><th scope="col">研磨屋</th><th scope="col">戻り累計</th><th scope="col">今回反映</th><th scope="col">最終仕上げ</th><th scope="col">履歴</th></tr></thead><tbody>${jobs.map((job) => {
      const counts = polishingCounts(job);
      const draft = state.polishingSelection.get(job.id);
      const busy = state.polishingSaving.has(job.id) || pendingProcessSaves.has(job.id);
      const changed = draft && draft.version !== Number(job.version);
      return `<tr data-polishing-row="${escapeHtml(job.id)}" aria-busy="${busy}"><td>${canEdit() && counts.outstanding ? `<input type="checkbox" data-polishing-select-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(productDisplayName(job))}・${escapeHtml(job.serialNo || job.id)}の戻りを選択" ${draft ? "checked" : ""} ${busy ? "disabled" : ""}>` : ""}</td><td>${escapeHtml(job.customer)}</td><td><strong>${escapeHtml(productDisplayName(job))}</strong><small>製品番号 ${escapeHtml(job.productMaster?.productCode || job.productCode || "未登録")}</small><small>${escapeHtml(job.serialNo || "連番未設定")}</small>${job.shippingStatus === "shipped" ? "<small>出荷完了</small>" : ""}</td><td class="polishing-class-cell">${polishingClassControl(job, busy)}</td><td>${escapeHtml(formatDate(job.dueDate))}</td><td class="polishing-date-cell">${polishingSentDateMarkup(job)}</td><td>${orderQuantity(job)}</td><td><strong class="polishing-outstanding">${counts.outstanding}</strong></td><td>${counts.returned}</td><td>${draft ? `<strong>${counts.outstanding}丁</strong>${changed ? '<small class="polishing-error">更新あり・選択し直す</small>' : ""}` : "—"}</td><td>${counts.returned && canEdit() && job.shippingStatus !== "shipped" ? `<button class="button button-quiet polishing-finish-button" type="button" data-action="open-process" data-order-id="${escapeHtml(job.id)}" data-stage-key="finish" ${busy ? "disabled" : ""}>${polishingFinishLabel(job)}</button>` : polishingFinishLabel(job)}</td><td>${polishingHistoryMarkup(job, busy)}</td></tr>`;
    }).join("")}</tbody></table></div>` : '<div class="empty-state"><h3>対象の製品はありません</h3></div>';
    const selectAll = qs("#polishing-select-all");
    if (selectAll) selectAll.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
    const newScroll = qs(".polishing-table-wrap", workspace);
    if (newScroll) { newScroll.scrollTop = scrollTop; newScroll.scrollLeft = scrollLeft; }
    if (focusId) qs(`[data-polishing-select-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
    if (customFocusId) qs(`[data-polishing-custom-id="${CSS.escape(customFocusId)}"][data-polishing-custom-vendor="${CSS.escape(customFocusVendor)}"]`)?.focus({ preventScroll: true });
    polishingRenderSignature = signature;
  }
  renderPolishingSelection();
  const status = qs("#polishing-save-status");
  status.textContent = state.polishingSaveMessage;
  status.hidden = !state.polishingSaveMessage;
}

function renderPolishingSelection() {
  const returnDate = qs("#polishing-return-date");
  if (!returnDate.dataset.initialized) { returnDate.value = todayIso(); returnDate.dataset.initialized = "true"; }
  returnDate.max = todayIso();
  returnDate.disabled = state.polishingSaving.size > 0;
  const selected = [...state.polishingSelection];
  const total = selected.reduce((sum, [, draft]) => sum + (Number(draft.quantity) || 0), 0);
  const valid = selected.length > 0 && selected.length <= 100 && selected.every(([id, draft]) => {
    const job = state.jobs.find((entry) => entry.id === id);
    const quantity = Number(draft.quantity);
    return job && !job.archived && Number(job.version) === draft.version && Number.isInteger(quantity) && quantity > 0 && quantity <= polishingCounts(job).outstanding && !pendingProcessSaves.has(id);
  });
  qs("#polishing-selection-summary").textContent = `${selected.length}件を選択 · 今回 ${total.toLocaleString("ja-JP")}丁`;
  qs("#polishing-return-button").disabled = !canEdit() || !valid || state.polishingSaving.size > 0;
}

function selectPolishingJob(id, selected) {
  if (!canEdit() || state.polishingSaving.size) return;
  const job = state.jobs.find((entry) => entry.id === id);
  if (!job || polishingCounts(job).outstanding <= 0) return;
  if (selected) {
    if (state.polishingSelection.size >= 100 && !state.polishingSelection.has(id)) { showToast("一度に選択できるのは100件までです。"); return; }
    state.polishingSelection.set(id, { version: Number(job.version), quantity: String(polishingCounts(job).outstanding) });
  } else state.polishingSelection.delete(id);
}

function showPolishingOrder(id) {
  if (!canAccessView("polishing")) return;
  const job = state.jobs.find((entry) => entry.id === id);
  state.polishingFilter = "all";
  state.polishingQuery = job?.serialNo || job?.product || "";
  qs("#polishing-filter").value = "all";
  qs("#polishing-search").value = state.polishingQuery;
  state.polishingSelection.clear();
  renderPolishingWorkspace();
  switchView("polishing");
}

function openPolishingDialog(id, action = "send", eventRequestId = "") {
  if (!canEdit() || !["send", "cancel", "date"].includes(action)) return;
  const job = state.jobs.find((entry) => entry.id === id);
  const editingDate = action === "date";
  if (!job || job.archived || (!editingDate && job.shippingStatus === "shipped") || jobMutationPending(id)) return;
  const entry = editingDate && job.polishing?.history.find((event) => event.requestId === eventRequestId && ["send", "return"].includes(event.action));
  if (editingDate && !entry) return;
  const counts = polishingCounts(job);
  const limit = editingDate ? entry.quantity : action === "send" ? counts.available : counts.outstanding;
  if (!Number.isInteger(limit) || limit <= 0) return;
  const form = qs("#polishing-form");
  form.reset();
  form.elements.id.value = id;
  form.elements.version.value = job.version;
  form.elements.quantity.value = limit;
  form.elements.eventRequestId.value = eventRequestId;
  form.dataset.action = action;
  delete form.dataset.requestId;
  const dateLabel = editingDate && entry.action === "return" ? "戻り日" : "発送日";
  const title = editingDate ? `${dateLabel}を変更` : action === "send" ? "研磨に出す" : "発送を取り消す";
  qs("#polishing-dialog-title").textContent = title;
  qs("#polishing-dialog-kicker").textContent = editingDate ? "研磨履歴の日付訂正" : action === "send" ? "研磨屋へ発送" : "研磨への発送取り消し";
  qs("#polishing-action-summary").textContent = editingDate ? `${polishingEventDateLabel(entry)}の${entry.action === "return" ? "戻り" : "発送"} ${entry.quantity}丁の日付を変更します。${entry.action === "return" ? "月別の研磨代にも反映されます。" : ""}` : action === "send" ? "未発送分をすべて研磨に出します。" : "研磨屋にある全数の発送を取り消します。";
  qs("#polishing-submit-button").textContent = title;
  qs("#polishing-product").textContent = `${productDisplayName(job)} · ${job.customer} · ${job.serialNo || "連番未設定"}`;
  qs("#polishing-job-summary").textContent = `全数 ${job.quantity}丁 · 研磨屋 ${counts.outstanding}丁 · 戻り ${counts.returned}丁`;
  qs("#polishing-dialog-status").hidden = true;
  qsa("input, button", form).forEach((control) => { control.disabled = false; });
  qs("#polishing-date-field").hidden = action === "cancel";
  qs("#polishing-date-label").textContent = dateLabel;
  form.elements.date.value = editingDate ? businessDateKey(entry.at) : todayIso();
  form.elements.date.max = todayIso();
  form.elements.date.required = action !== "cancel";
  form.elements.date.disabled = action === "cancel";
  openDialog(qs("#polishing-dialog"), action === "cancel" ? "#polishing-submit-button" : '[name="date"]');
}

function reconcilePolishingRetry() {
  const attempts = new Set([...failedPolishingAttempts.values(), state.polishingRetry].filter(Boolean));
  for (const attempt of attempts) {
    if (!attempt.items.every((item) => state.jobs.find((job) => job.id === item.id)?.polishing?.history?.some((entry) => entry.requestId === attempt.requestId && entry.action === attempt.action && entry.quantity === item.quantity && (entry.requestedDate || "") === (attempt.date || "") && (entry.returnRequestId || "") === (item.returnRequestId || "")))) continue;
    attempt.confirmed = true;
    failedPolishingAttempts.delete(attempt.fingerprint);
    if (state.polishingRetry === attempt) state.polishingRetry = null;
    attempt.items.forEach((item) => state.polishingSelection.delete(item.id));
    state.polishingSaveMessage = "保存済みの研磨更新を確認し、反映しました。";
    if (qs("#polishing-dialog")?.open && qs("#polishing-form").dataset.requestId === attempt.requestId) closeDialog(qs("#polishing-dialog"));
  }
}

async function commitPolishingMovement(action, items, date) {
  if (!canEdit() || state.polishingRulesSaving.size || !items.length || items.some((item) => jobMutationPending(item.id))) return false;
  const fingerprint = JSON.stringify({ action, items, date });
  const attempt = failedPolishingAttempts.get(fingerprint) || (state.polishingRetry?.fingerprint === fingerprint ? state.polishingRetry : { fingerprint, action, items, date, requestId: window.crypto.randomUUID(), confirmed: false });
  if (attempt.confirmed) return true;
  state.polishingRetry = attempt;
  failedPolishingAttempts.set(fingerprint, attempt);
  const previous = new Map();
  const optimistic = new Map();
  items.forEach((item) => state.polishingSaving.add(item.id));
  state.jobs = state.jobs.map((job) => {
    const item = items.find((entry) => entry.id === job.id);
    if (!item) return job;
    previous.set(job.id, job);
    const polishing = structuredClone(job.polishing || { sentQuantity: 0, returnedQuantity: 0, history: [] });
    if (action === "send") polishing.sentQuantity = Number(polishing.sentQuantity || 0) + item.quantity;
    else if (action === "return") polishing.returnedQuantity = Number(polishing.returnedQuantity || 0) + item.quantity;
    else if (action === "undo-return") polishing.returnedQuantity = Number(polishing.returnedQuantity || 0) - item.quantity;
    else polishing.sentQuantity = Number(polishing.sentQuantity || 0) - item.quantity;
    const next = { ...job, polishing };
    optimistic.set(job.id, next);
    return next;
  });
  state.polishingSaveRevision += 1;
  state.polishingSaveMessage = "研磨の数量を保存しています…";
  if (qs("#polishing-dialog")?.open) qs("#polishing-form").dataset.requestId = attempt.requestId;
  renderAll();
  try {
    const result = await api.savePolishingMovement({ action, items, ...(date !== undefined ? {date} : {}), requestId: attempt.requestId });
    if (state.accessRevoked) return false;
    const savedById = new Map((result.jobs || []).map((job) => [job.id, job]));
    state.jobs = state.jobs.map((job) => savedById.has(job.id) && Number(savedById.get(job.id).version) >= Number(job.version) ? savedById.get(job.id) : job);
    attempt.confirmed = true;
    failedPolishingAttempts.delete(fingerprint);
    if (state.polishingRetry === attempt) state.polishingRetry = null;
    items.forEach((item) => state.polishingSelection.delete(item.id));
    const total = items.reduce((sum, item) => sum + item.quantity, 0);
    state.polishingSaveMessage = action === "undo-return" ? `${items.length}件・${total}丁の戻りを取り消し、研磨状態に戻しました。` : `${items.length}件・${total}丁の${action === "send" ? "研磨への発送" : action === "return" ? "戻り" : "発送取消"}を反映しました。`;
    if (result.mirrorWarning) {
      state.polishingSaveMessage += ` ${result.mirrorWarning}`;
      showToast(result.mirrorWarning, { tone: "error", sticky: true });
    }
    if (qs("#polishing-dialog")?.open && qs("#polishing-form").dataset.requestId === attempt.requestId) closeDialog(qs("#polishing-dialog"));
    announce(state.polishingSaveMessage);
  } catch (error) {
    if (state.accessRevoked) return false;
    state.jobs = state.jobs.map((job) => job === optimistic.get(job.id) ? previous.get(job.id) : job);
    state.polishingSaveMessage = `保存を確認できませんでした。入力は保持しています。${error.message}`;
    showToast(state.polishingSaveMessage, { tone: "error", sticky: true,
      action: { label: "同じ内容で再試行", run: () => {
        if (!attempt.confirmed) return commitPolishingMovement(action, items, date);
        else showToast("この研磨更新は保存済みです。");
      } },
    });
  } finally {
    items.forEach((item) => state.polishingSaving.delete(item.id));
    state.polishingSaveRevision += 1;
    if (!state.accessRevoked) renderAll();
  }
  if (!attempt.confirmed) await refreshData({ quiet: true });
  return attempt.confirmed;
}

async function savePolishingForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity() || !canEdit()) return;
  const quantity = Number(form.elements.quantity.value);
  if (!Number.isInteger(quantity) || quantity < 1) return;
  const action = form.dataset.action;
  const date = action === "cancel" ? undefined : form.elements.date.value;
  if (date !== undefined) {
    try { polishingDateAt(date); } catch (error) { showToast(error.message, {tone:"error"}); return; }
  }
  const items = [{ id: form.elements.id.value, version: Number(form.elements.version.value), quantity }];
  if (items.some((item) => jobMutationPending(item.id)) || state.polishingRulesSaving.size) return;
  closeDialog(qs("#polishing-dialog"), { force: true });
  if (action === "date") await commitPolishingEventDate({id:items[0].id,version:items[0].version,eventRequestId:form.elements.eventRequestId.value,date,requestId:window.crypto.randomUUID()});
  else await commitPolishingMovement(action, items, date);
}

async function commitPolishingEventDate(payload) {
  if (!canEdit() || jobMutationPending(payload.id) || state.polishingRulesSaving.size) return;
  state.polishingSaving.add(payload.id);
  state.polishingSaveRevision += 1;
  state.polishingSaveMessage = "研磨の日付を保存しています…";
  renderAll();
  try {
    const result = await api.savePolishingEventDate(payload);
    if (state.accessRevoked) return;
    const saved = result.jobs?.find((job) => job.id === payload.id);
    if (saved) state.jobs = state.jobs.map((job) => job.id === saved.id && Number(saved.version) >= Number(job.version) ? saved : job);
    state.polishingSelection.delete(payload.id);
    state.polishingSaveMessage = `研磨の日付を${formatDate(payload.date, {year:"numeric",month:"numeric",day:"numeric"})}に変更しました。${result.mirrorWarning || ""}`;
    if (result.mirrorWarning) showToast(result.mirrorWarning, {tone:"error",sticky:true});
    announce(state.polishingSaveMessage);
  } catch (error) {
    if (state.accessRevoked) return;
    state.polishingSaveMessage = `日付の保存を確認できませんでした。入力は保持しています。${error.message}`;
    showToast(state.polishingSaveMessage, {tone:"error",sticky:true,action:{label:"同じ日付で再試行",run:() => commitPolishingEventDate(payload)}});
  } finally {
    state.polishingSaving.delete(payload.id);
    state.polishingSaveRevision += 1;
    if (!state.accessRevoked) renderAll();
  }
}

async function receiveSelectedPolishing() {
  if (qs("#polishing-return-button").disabled) return;
  const input = qs("#polishing-return-date");
  if (!input.reportValidity()) return;
  try { polishingDateAt(input.value); } catch (error) { showToast(error.message, {tone:"error"}); return; }
  const items = [...state.polishingSelection].map(([id, draft]) => ({ id, version: draft.version, quantity: Number(draft.quantity) }));
  await commitPolishingMovement("return", items, input.value);
}

async function undoPolishingReturn(id) {
  if (!canEdit() || state.polishingRulesSaving.size) return false;
  const job = state.jobs.find((entry) => entry.id === id);
  if (!job || job.archived || job.shippingStatus === "shipped" || processSavePending(job)) return false;
  const lastReturn = latestPolishingReturn(job);
  if (!lastReturn || !Number.isSafeInteger(lastReturn.quantity) || lastReturn.quantity <= 0 || !lastReturn.requestId) return false;
  return commitPolishingMovement("undo-return", [{id, version:Number(job.version), quantity:lastReturn.quantity, returnRequestId:lastReturn.requestId}]);
}

async function sendPolishingJob(id) {
  if (!canEdit() || state.polishingRulesSaving.size) return false;
  const job = state.jobs.find((entry) => entry.id === id);
  if (!job || job.archived || job.shippingStatus === "shipped" || jobMutationPending(id)) return false;
  const quantity = polishingCounts(job).available;
  if (!Number.isInteger(quantity) || quantity <= 0) return false;
  // Omitting the date records the server's current day and recording time.
  const saved = await commitPolishingMovement("send", [{id,version:Number(job.version),quantity}]);
  if (saved) showToast(`${job.product} ${quantity}丁を研磨中にしました。`, {
    action:{label:"発送を取り消す",run:() => openPolishingDialog(id,"cancel")},
  });
  return saved;
}

function distributionJobs({ month = state.distributionMonth, endMonth = month === state.distributionMonth ? state.distributionEndMonth || month : month, assignee = state.distributionFilter, includeShipped = state.distributionIncludeShipped, jobs = state.jobs, sort = state.distributionSort } = {}) {
  return jobs.filter((job) => !job.archived && jobCategory(job) === "鋭匙鉗子"
    && month && String(job.dueDate || "").slice(0, 7) >= month && String(job.dueDate || "").slice(0, 7) <= endMonth
    && (includeShipped || job.shippingStatus !== "shipped")
    && (assignee === "all" || (job.distributionAssignee || "") === assignee))
    .sort((a, b) => String(a.dueDate).slice(0, 7).localeCompare(String(b.dueDate).slice(0, 7))
      || (sort === "customer" ? compareDistributionCustomer(a, b) : 0)
      || String(a.dueDate).localeCompare(String(b.dueDate))
      || NATURAL_COLLATOR.compare(a.product || "", b.product || "")
      || NATURAL_COLLATOR.compare(a.serialNo || "", b.serialNo || "")
      || String(a.id).localeCompare(String(b.id)));
}

function compareDistributionCustomer(a, b) {
  return compareCustomer(a.customer, b.customer);
}

function distributionSortLabel(sort = state.distributionSort) {
  return sort === "customer" ? "月→得意先→納期順" : "月→納期順";
}

function configuredDistributionAssignees() {
  let names;
  try { names = JSON.parse(state.settings.distributionAssignees || "null"); } catch { names = null; }
  return Array.isArray(names) ? ASSIGNEES.filter((name) => names.includes(name)) : [...ASSIGNEES];
}

function distributionAssigneeOptions(jobs = []) {
  const names = new Set([...configuredDistributionAssignees(), ...jobs.map((job) => job.distributionAssignee || "")]);
  return ["", ...ASSIGNEES.filter((name) => names.has(name)), ...[...names].filter((name) => name && !ASSIGNEES.includes(name))];
}

function distributionQuantityStats(jobs) {
  const known = jobs.filter((job) => job.quantity !== "" && job.quantity != null && Number.isFinite(Number(job.quantity)));
  return { count: jobs.length, total: known.reduce((sum, job) => sum + Number(job.quantity), 0), unknown: jobs.length - known.length };
}

function distributionWorkloads(jobs) {
  return distributionAssigneeOptions(jobs).map((assignee) => ({ assignee, ...distributionQuantityStats(jobs.filter((job) => (job.distributionAssignee || "") === assignee)) }));
}

function distributionQuantityLabel(stats) {
  return stats.count && stats.unknown === stats.count ? "数量未入力" : `${stats.total.toLocaleString("ja-JP")}丁`;
}

function distributionMonthLabel(month) {
  const [year, value] = month.split("-");
  return `${year}年${Number(value)}月`;
}

function distributionPeriodLabel(month, endMonth = month) {
  if (month === endMonth) return distributionMonthLabel(month);
  const endLabel = month.slice(0, 4) === endMonth.slice(0, 4) ? `${Number(endMonth.slice(5))}月` : distributionMonthLabel(endMonth);
  return `${distributionMonthLabel(month)}～${endLabel}`;
}

function distributionPrintJobs(jobs = distributionJobs()) {
  return jobs.filter((job) => String(job.distributionAssignee || "").trim());
}

function distributionQuantitySummary(jobs) {
  const stats = distributionQuantityStats(jobs);
  if (stats.count && stats.unknown === stats.count) return `数量未入力 ${stats.unknown}件`;
  return `数量合計 ${distributionQuantityLabel(stats)}${stats.unknown ? `（未入力 ${stats.unknown}件）` : ""}`;
}

function distributionWorkloadText(workloads) {
  return workloads.map((item) => `${item.assignee || "未定"}：${distributionQuantityLabel(item)}${item.unknown ? (item.unknown === item.count ? ` ${item.unknown}件` : `（数量未入力 ${item.unknown}件）`) : ""}`).join(" / ");
}

function renderDistributionWorkspace() {
  if (!state.distributionMonth) state.distributionMonth = todayIso().slice(0, 7);
  if (!state.distributionEndMonth) state.distributionEndMonth = state.distributionMonth;
  const active = document.activeElement;
  const focusId = active?.dataset.distributionId;
  const focusAssignee = active?.dataset.distributionAssignee;
  const focusFilter = active?.dataset.distributionFilter;
  qs("#distribution-month").value = state.distributionMonth;
  qs("#distribution-end-month").value = state.distributionEndMonth;
  qs("#distribution-include-shipped").checked = state.distributionIncludeShipped;
  qs("#distribution-sort").value = state.distributionSort;
  renderDistributionAssigneeSettings();
  const monthly = distributionJobs({ assignee: "all" });
  const workloads = distributionWorkloads(monthly);
  if (state.distributionFilter !== "all" && !workloads.some((item) => item.assignee === state.distributionFilter)) state.distributionFilter = "all";
  const jobs = distributionJobs();
  qs("#distribution-assignee-filter").innerHTML = [{ assignee: "all", ...distributionQuantityStats(monthly) }, ...workloads].map((item) => {
    const label = item.assignee === "all" ? "全員" : item.assignee || "未定";
    return `<button class="distribution-filter-button" type="button" data-distribution-filter="${escapeHtml(item.assignee)}" aria-pressed="${state.distributionFilter === item.assignee}">${escapeHtml(label)}<span>${item.count}件</span></button>`;
  }).join("");
  qs("#distribution-result-summary").textContent = `${distributionPeriodLabel(state.distributionMonth, state.distributionEndMonth)}納期 · ${jobs.length}件 · ${distributionQuantitySummary(jobs)} · ${distributionSortLabel()}`;
  qs("#distribution-save-status").textContent = !canWork() ? "閲覧のみ：担当者の変更はできません。" : state.distributionSaving.size ? `担当者を保存中（${state.distributionSaving.size}件）…` : state.distributionSaveMessage;
  qs("#distribution-print-button").disabled = !distributionPrintJobs(jobs).length || state.distributionSaving.size > 0;
  qs("#distribution-workload-summary").textContent = `${state.distributionMonth === state.distributionEndMonth ? "月" : "表示期間"}全体の担当別合計（${state.distributionIncludeShipped ? "出荷完了を含む" : "未出荷"}）：${distributionWorkloadText(workloads)}`;
  qs("#distribution-workspace").innerHTML = jobs.length ? `<table class="distribution-table" aria-label="${distributionSortLabel()}の鋭匙鉗子と配布担当">
    <thead><tr><th scope="col">得意先</th><th scope="col">製品名</th><th scope="col">連番</th><th scope="col">納期</th><th scope="col">数量</th><th scope="col">型</th><th scope="col">幅</th><th scope="col">現在の工程</th><th scope="col">配布担当</th></tr></thead>
    <tbody>${jobs.map((job) => {
      const saving = state.distributionSaving.has(job.id);
      const current = job.distributionAssignee || "";
      return `<tr data-distribution-row="${escapeHtml(job.id)}" aria-busy="${saving}">
        <td class="distribution-customer" data-column="得意先">${escapeHtml(job.customer || "—")}</td>
        <td class="distribution-product" data-column="製品名"><strong>${escapeHtml(productDisplayName(job))}</strong>${job.shippingStatus === "shipped" ? "<small>出荷完了</small>" : ""}</td>
        <td class="distribution-serial" data-column="連番">${escapeHtml(job.serialNo || "—")}</td>
        <td data-column="納期">${escapeHtml(formatDate(job.dueDate))}</td>
        <td data-column="数量">${escapeHtml(job.quantity === "" || job.quantity == null ? "—" : String(job.quantity))}</td>
        <td data-column="型">${escapeHtml(job.specShape || "—")}</td>
        <td data-column="幅">${escapeHtml(job.bladeWidth || "—")}</td>
        <td class="distribution-current-stage" data-column="現在の工程">${escapeHtml(currentStage(job).label)}</td>
        <td class="distribution-assignment" data-column="配布担当">${canWorkOnJob(job) ? `<div class="distribution-assignees" role="group" aria-label="${escapeHtml(productDisplayName(job))}の配布担当">${distributionAssigneeOptions([job]).map((assignee) => `<button class="distribution-assignee-button" type="button" data-distribution-id="${escapeHtml(job.id)}" data-distribution-assignee="${escapeHtml(assignee)}" aria-pressed="${current === assignee}" ${saving ? "disabled" : ""}>${escapeHtml(assignee || "未定")}</button>`).join("")}</div>` : `<span>${escapeHtml(current || "未定")}</span>`}</td>
      </tr>`;
    }).join("")}</tbody></table>` : `<div class="empty-state"><h3>${state.mode === "loading" ? "データを読み込んでいます" : "条件に合う鋭匙鉗子がありません"}</h3><p>納期の期間・配布担当・出荷完了の表示を確認してください。納期が未設定の案件は月別の表に表示されません。</p></div>`;
  if (focusId) qs(`[data-distribution-id="${CSS.escape(focusId)}"][data-distribution-assignee="${CSS.escape(focusAssignee)}"]`)?.focus({ preventScroll: true });
  if (focusFilter !== undefined) qs(`[data-distribution-filter="${CSS.escape(focusFilter)}"]`)?.focus({ preventScroll: true });
}

function setDistributionMonth(boundary, month) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) > 0) {
    if (boundary === "end") {
      state.distributionEndMonth = month;
      if (state.distributionMonth > month) state.distributionMonth = month;
    } else {
      state.distributionMonth = month;
      if (!state.distributionEndMonth || state.distributionEndMonth < month) state.distributionEndMonth = month;
    }
  }
  renderDistributionWorkspace();
}

function changeDistributionMonth(offset) {
  const indices = [state.distributionMonth, state.distributionEndMonth || state.distributionMonth].map((value) => {
    const [year, month] = value.split("-").map(Number);
    return year * 12 + month - 1 + offset;
  });
  if (indices.some((index) => index < 12 || index >= 120000)) return;
  [state.distributionMonth, state.distributionEndMonth] = indices.map((index) => `${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}`);
  renderDistributionWorkspace();
}

async function saveDistributionAssignee(id, assignee) {
  if (!canWork()) return;
  const job = state.jobs.find((entry) => entry.id === id);
  if (!canWorkOnJob(job) || jobMutationPending(id) || (job.distributionAssignee || "") === assignee) return;
  const optimistic = { ...job, distributionAssignee: assignee };
  state.jobs = state.jobs.map((entry) => entry === job ? optimistic : entry);
  state.distributionSaving.add(id);
  state.distributionSaveRevision += 1;
  renderDistributionWorkspace();
  let failed = false;
  try {
    const saved = await api.setDistributionAssignee({ id, version: Number(job.version || 0), assignee });
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((entry) => entry.id === saved.id && Number(saved.version) >= Number(entry.version) ? saved : entry);
    state.distributionSaveMessage = `${saved.product}：${assignee ? `配布担当「${assignee}」` : "担当未定"}で保存しました。`;
  } catch (error) {
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((entry) => entry === optimistic ? job : entry);
    failed = true;
    state.distributionSaveMessage = `保存できませんでした。${error.message}`;
    showToast(state.distributionSaveMessage, { tone: "error", sticky: true });
  } finally {
    state.distributionSaving.delete(id);
    state.distributionSaveRevision += 1;
    if (!state.accessRevoked) renderAll();
  }
  if (failed) await refreshData({ quiet: true });
}

function distributionPrintMarkup(jobs, month, sort = state.distributionSort, endMonth = month) {
  jobs = distributionPrintJobs(jobs);
  const totals = distributionWorkloadText(distributionWorkloads(jobs).filter((item) => item.count));
  return `<div class="distribution-print-page"><header><p>鋭匙鉗子 · ${escapeHtml(distributionPeriodLabel(month, endMonth))}納期</p><h1>担当配布表</h1><p>${jobs.length}件 · ${escapeHtml(distributionQuantitySummary(jobs))} · ${distributionSortLabel(sort)}</p></header>
    <table><colgroup><col class="print-customer"><col class="print-product"><col class="print-serial"><col class="print-due"><col class="print-quantity"><col class="print-shape"><col class="print-width"><col class="print-assignee"></colgroup><thead><tr><th scope="col">得意先</th><th scope="col">製品名</th><th scope="col">連番</th><th scope="col">納期</th><th scope="col">数量</th><th scope="col">型</th><th scope="col">幅</th><th scope="col">配布担当</th></tr></thead><tbody>${jobs.map((job) => `<tr><td>${escapeHtml(job.customer || "—")}</td><td>${escapeHtml(productDisplayName(job))}</td><td>${escapeHtml(job.serialNo || "—")}</td><td>${escapeHtml(formatDate(job.dueDate))}</td><td>${escapeHtml(job.quantity === "" || job.quantity == null ? "—" : String(job.quantity))}</td><td>${escapeHtml(job.specShape || "—")}</td><td>${escapeHtml(job.bladeWidth || "—")}</td><td>${escapeHtml(job.distributionAssignee || "未定")}</td></tr>`).join("")}</tbody></table><p class="distribution-print-totals">担当別合計：${escapeHtml(totals)}</p></div>`;
}

function fitDistributionToPage() {
  const sheet = qs("#distribution-print-sheet");
  const page = qs(".distribution-print-page", sheet);
  if (!page) return;
  sheet.classList.add("is-measuring");
  // A4 minus 12 mm margins. Measure the same styled content used by print.
  const availableHeight = sheet.getBoundingClientRect().width * 273 / 186 - 2;
  const setScale = (scale) => {
    page.style.width = `${186 / scale}mm`;
    page.style.zoom = String(scale);
  };
  setScale(1);
  page.classList.remove("is-compact");
  if (page.getBoundingClientRect().height > availableHeight) page.classList.add("is-compact");
  if (page.getBoundingClientRect().height > availableHeight) {
    let lower = Math.min(1, availableHeight / page.getBoundingClientRect().height) / 2;
    let upper = 1;
    for (let step = 0; step < 16; step += 1) {
      const scale = (lower + upper) / 2;
      setScale(scale);
      if (page.getBoundingClientRect().height <= availableHeight) lower = scale;
      else upper = scale;
    }
    setScale(lower * 0.995);
  }
  sheet.classList.remove("is-measuring");
}

async function printDistribution() {
  if (state.distributionSaving.size) return;
  const jobs = distributionPrintJobs();
  if (!jobs.length) return;
  qs("#distribution-print-sheet").innerHTML = distributionPrintMarkup(jobs, state.distributionMonth, state.distributionSort, state.distributionEndMonth || state.distributionMonth);
  await document.fonts?.ready;
  fitDistributionToPage();
  state.printMode = "distribution";
  document.body.classList.remove("is-printing-labels");
  document.body.classList.add("is-printing-distribution");
  requestAnimationFrame(() => {
    try {
      window.print();
      finishDistributionPrint();
    } catch (error) {
      finishDistributionPrint();
      showToast("印刷画面を開けませんでした。ブラウザの印刷許可を確認してください。", { tone: "error" });
    }
  });
}

function finishDistributionPrint() {
  document.body.classList.remove("is-printing-distribution");
}

function renderHeader() {
  const pending = state.intake.length;
  const count = qs("#intake-nav-count");
  count.textContent = String(pending);
  count.hidden = pending === 0;
  const shipping = state.jobs.filter((job) => matchesJobScope(job, "shipping")).length;
  const completed = state.jobs.filter((job) => matchesJobScope(job, "completed")).length;
  const completedCount = qs("#completed-nav-count");
  completedCount.textContent = String(shipping + completed);
  completedCount.hidden = shipping + completed === 0;
  completedCount.setAttribute?.("aria-label", `出荷待ち${shipping}件・出荷済み${completed}件`);
  const polishingCount = state.jobs.filter((job) => !job.archived && polishingCounts(job).outstanding > 0).length;
  const polishingBadge = qs("#polishing-nav-count");
  polishingBadge.textContent = String(polishingCount);
  polishingBadge.hidden = polishingCount === 0;
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
  const due = active.filter((job) => daysUntil(job.dueDate) <= 2);
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

function stageCellButton(job, baseStage) {
  const stage = stageForJob(baseStage, job);
  const status = stageStatus(job, stage.key);
  const assignee = stageAssignee(job, stage.key);
  const label = stage.key === "finish" && polishingCounts(job).returned > 0
    ? { not_started: "最終待ち", working: "最終中", done: "最終完了", hold: "最終保留" }[status] || statusLabel(status)
    : statusLabel(status);
  if (!canWorkOnJob(job)) return `<span class="stage-cell-button" data-status="${status}" data-tone="${statusTone({ status })}"><b>${escapeHtml(assignee || "—")}</b><small>${label}</small></span>`;
  return `<button class="stage-open-button stage-cell-button" type="button" data-action="open-process" data-order-id="${escapeHtml(job.id)}" data-stage-key="${stage.key}" data-status="${status}" data-tone="${statusTone({ status })}" aria-label="${escapeHtml(job.product || "案件")}の${stage.label}：${escapeHtml(assignee || "担当未定")}・${label}を更新"><b>${escapeHtml(assignee || "—")}</b><small>${label}</small></button>`;
}

function shippingCell(job, completed = false) {
  const label = job.shippingStatus === "shipped" ? (job.completionKind === "stock_fulfillment" ? "受注履行完了" : "出荷完了") : isDone(job) ? "出荷待ち" : "未出荷";
  if (!canEdit()) return `<span class="shipping-cell"><span>${label}</span>${completed ? `<small>出荷完了 ${escapeHtml(shipmentDateLabel(job, true))}</small>` : ""}</span>`;
  return `<span class="shipping-cell"><button type="button" class="shipping-open-button" data-action="open-process" data-order-id="${escapeHtml(job.id)}" data-stage-key="shipping" aria-label="${escapeHtml(job.product || "案件")}の出荷状態を更新">${label === "出荷待ち" ? "出荷する" : label}</button>${completed ? `<small>出荷完了 ${escapeHtml(shipmentDateLabel(job, true))}</small>` : ""}</span>`;
}

function orderQuantity(job) {
  return job.quantity === "" || job.quantity == null ? "—" : escapeHtml(Number(job.quantity).toLocaleString("ja-JP"));
}

function ledgerLengthValue(job) {
  const customer = normalizeProductText(job.customer).replace(/株式会社|有限会社|合同会社|[（(]株[）)]/g, "").replace(/\s+/g, "").toLocaleLowerCase("ja");
  return ["ユフ", "松井", "tmマツイ", "tsメディカル"].includes(customer) ? displayedProductCode(job) || "—" : String(job.specLength || "—");
}

function orderTableRows(jobs, { completed = false, shipping = false, compact = false, ledger = false, progressOnly = false } = {}) {
  return jobs.map((job) => {
    const due = dueInfo(job);
    const length = ledgerLengthValue(job);
    const shippedSummary = completed && progressOnly ? `<small class="ledger-shipped-date" title="${escapeHtml(shipmentDateLabel(job, true))}">出荷 ${escapeHtml(shipmentDateLabel(job))}</small>` : "";
    const product = `<td class="cell-product"><button class="ledger-product" type="button" data-action="view-order" data-order-id="${escapeHtml(job.id)}" title="${escapeHtml(productDisplayName(job))}" aria-label="${escapeHtml(productDisplayName(job))}の詳細を表示">${escapeHtml(productDisplayName(job))}</button>${shippedSummary}</td>`;
    const serial = `<td class="cell-serial" title="${escapeHtml(job.serialNo || "—")}">${escapeHtml(job.serialNo || "—")}</td>`;
    const shippedDate = completed ? `<td class="cell-completed-date" title="${escapeHtml(shipmentDateLabel(job, true))}">${shipmentDateKey(job) ? `<time datetime="${escapeHtml(job.completedAt)}">${escapeHtml(shipmentDateLabel(job))}</time>` : "未記録"}</td>` : "";
    const scrollSpace = ledger ? '<td class="ledger-scroll-space" aria-hidden="true"></td>' : "";
    const stages = STAGES.map((stage) => `<td class="cell-stage">${stageCellButton(job, stage)}</td>`).join("");
    const shippingAction = `<td class="cell-shipping">${shippingCell(job, completed)}</td>`;
    if (progressOnly) return `<tr data-order-id="${escapeHtml(job.id)}">${product}${serial}${stages}${shipping ? shippingAction : ""}${scrollSpace}</tr>`;
    return `<tr data-order-id="${escapeHtml(job.id)}">
      ${ledger ? `${product}${serial}${shippedDate}` : shippedDate}
      <td class="cell-customer" title="${escapeHtml(job.customer || "—")}">${escapeHtml(job.customer || "—")}</td>
      ${ledger ? "" : product}
      <td class="cell-due" data-tone="${completed ? "default" : due.tone}" title="${escapeHtml(job.dueDate || "納期未設定")}">${escapeHtml(job.dueDate ? formatDate(job.dueDate) : "—")}</td>
      <td class="cell-quantity">${orderQuantity(job)}</td>
      <td class="cell-length" title="${escapeHtml(length)}">${escapeHtml(length)}</td>
      <td class="cell-shape" title="${escapeHtml(job.specShape || "—")}">${escapeHtml(job.specShape || "—")}</td>
      <td class="cell-blade" title="${escapeHtml(job.bladeWidth || "—")}">${escapeHtml(job.bladeWidth || "—")}</td>
      ${ledger ? "" : serial}
      ${stages}
      <td class="cell-polishing">${polishingCell(job, completed)}</td>
      ${compact ? "" : `<td class="cell-note" title="${escapeHtml(job.note || "—")}"><button class="ledger-note" type="button" data-action="view-order" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(productDisplayName(job))}の備考と詳細を表示">${escapeHtml(job.note || "—")}</button></td>
      <td class="cell-shipping">${shippingCell(job, completed)}</td>
      <td>${canEdit() ? `<button class="row-action" type="button" data-action="edit-order" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(job.product || "案件")}の注文情報を編集">${icon("edit")}</button>` : ""}</td>`}
      ${compact && shipping ? shippingAction : ""}${scrollSpace}
    </tr>`;
  }).join("");
}

function orderCards(jobs, { completed = false } = {}) {
  return jobs.map((job) => {
    const due = dueInfo(job);
    const category = jobCategory(job);
    return `<article class="order-card" data-order-id="${escapeHtml(job.id)}">
      <span class="order-main"><span class="order-copy"><strong>${escapeHtml(productDisplayName(job))}</strong><span>${escapeHtml(job.customer || "得意先未設定")}</span></span><span class="status-chip" data-tone="${due.tone}">${escapeHtml(due.label)}</span></span>
      <span class="order-meta"><span class="category-chip" data-category="${escapeHtml(category || "unclassified")}">${escapeHtml(category || "未分類")}</span><span>連番 ${escapeHtml(job.serialNo || "—")}</span></span>
      <dl class="order-specs">${[["数量", orderQuantity(job)], ["全長／製品番号", escapeHtml(ledgerLengthValue(job))], ["型", escapeHtml(job.specShape || "—")], ["刃幅", escapeHtml(job.bladeWidth || "—")], ["納期", escapeHtml(job.dueDate ? formatDate(job.dueDate) : "—")]].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>
      <div class="order-stage-grid">${STAGES.map((stage) => `<div><span class="stage-column-label">${stageForJob(stage, job).label}</span>${stageCellButton(job, stage)}</div>`).join("")}</div>
      <div class="order-polishing-line"><span>研磨</span>${polishingCell(job, completed)}</div>
      ${job.note ? `<p class="order-note"><span>備考</span> ${escapeHtml(job.note)}</p>` : ""}
      <div class="order-card-actions">${shippingCell(job, completed)}${canEdit() ? `<button class="row-action" type="button" data-action="edit-order" data-order-id="${escapeHtml(job.id)}" aria-label="${escapeHtml(job.product || "案件")}の注文情報を編集">${icon("edit")}</button>` : ""}</div>
    </article>`;
  }).join("");
}

function orderTableHeader({ completed = false, shipping = false, category = "", compact = false, ledger = false, progressOnly = false } = {}) {
  let columns = [["customer", "得意先", "customer"], ["product", "品名", "product"], ["due", "納期", "due"], ["quantity", "数量", "quantity"], ["length", "全長／製品番号"], ["shape", "型"], ["blade", "刃幅"], ["serial", "連番", "serial"], ...STAGES.map((stage) => ["stage", stageForJob(stage, category).label]), ["polishing", "研磨"], ["note", "備考"], ["shipping", completed ? "出荷完了" : "出荷"], ["edit", "編集"]];
  if (ledger || progressOnly) columns = [columns.find(([key]) => key === "product"), columns.find(([key]) => key === "serial"), ...columns.filter(([key]) => !["product", "serial"].includes(key))];
  if (progressOnly) columns = columns.filter(([key]) => ["product", "serial", "stage", ...(shipping ? ["shipping"] : [])].includes(key));
  else if (compact) columns = columns.filter(([key]) => !["note", "edit", ...(shipping ? [] : ["shipping"])].includes(key));
  if (completed && !progressOnly) columns.splice(ledger ? 2 : 0, 0, ["completed-date", "出荷日", "updated"]);
  const scrollSpace = ledger ? '<th class="ledger-scroll-space" aria-hidden="true"></th>' : "";
  const stageHint = canWork() && (canEdit() || (!completed && !shipping)) ? "工程の担当・状態を押すと更新できます。" : "工程の担当・状態を確認できます。";
  return `<caption class="sr-only">${escapeHtml(category || "仕様と全工程")}の一覧。${stageHint}並び順は一覧上部で変更できます。</caption><colgroup>${columns.map(([key]) => `<col class="col-${key}">`).join("")}${ledger ? '<col class="col-scroll-space">' : ""}</colgroup><thead><tr>${columns.map(([key, label, sort]) => `<th scope="col" class="cell-${key}"${sort ? ` data-sort-key="${sort}"` : ""}>${label}</th>`).join("")}${scrollSpace}</tr></thead>`;
}

function renderSortState(root, scope) {
  const criteria = sortCriteriaFor(scope);
  qsa("th[data-sort-key]", root).forEach((header) => {
    header.removeAttribute("aria-sort");
    header.removeAttribute("data-sort-priority");
    const priority = criteria.findIndex(({ key }) => key === header.dataset.sortKey);
    if (priority < 0) return;
    header.setAttribute("data-sort-priority", String(priority + 1));
    if (!priority) header.setAttribute("aria-sort", criteria[0].direction === "desc" ? "descending" : "ascending");
  });
}

function workspaceSortLabels(scope) {
  return { customer: "得意先", product: "品名", productCode: "製品番号", serial: "連番", due: "納期", quantity: "数量", updated: scope === "completed" ? "出荷完了日" : "更新日", priority: "優先・納期・残工程順", category: "大分類" };
}

function renderWorkspaceSortControls(scope) {
  const preferences = normalizeJobSort(state.filters[scope], scope);
  const labels = workspaceSortLabels(scope);
  ["sort", "sort2", "sort3"].forEach((field, index) => {
    const select = qs(`#${scope}-${field}`);
    if (select) {
      if (index && !select._sortChoicesReady && "innerHTML" in select) {
        select.innerHTML = '<option value="none">なし</option>' + JOB_SORT_KEYS.filter((key) => scope !== "completed" || key !== "priority").map((key) => `<option value="${key}">${labels[key]}</option>`).join("");
        select._sortChoicesReady = true;
      }
      select.value = preferences[field];
    }
    const direction = qs(`#${scope}-${field}-direction`);
    if (direction) { direction.value = preferences[`${field}Direction`]; direction.disabled = preferences[field] === "none"; }
  });
}

function renderDashboardOrders() {
  updateStageFilterLabels();
  const allJobs = sortedJobs("dashboard");
  const jobs = allJobs.slice(0, 8);
  qs("#dashboard-order-rows").closest("table").innerHTML = `${orderTableHeader()}<tbody id="dashboard-order-rows">${orderTableRows(jobs)}</tbody>`;
  qs("#dashboard-order-cards").innerHTML = orderCards(jobs);
  qs("#dashboard-empty").hidden = jobs.length > 0;
  const prefix = state.filters.dashboard.sort === "priority" ? "優先" : "先頭";
  qs("#result-summary").textContent = allJobs.length > jobs.length ? `${prefix}${jobs.length}件／全${allJobs.length}件` : `${allJobs.length}件を表示`;
  renderSortState(qs("#dashboard-order-rows").closest("table"), "dashboard");
}

function ledgerFilterSummary(scope, visibleCount) {
  const filters = state.filters[scope] || {};
  const conditions = [];
  const query = String(filters.query || "").trim();
  if (query) conditions.push(`検索「${query}」`);
  if (filters.stage && filters.stage !== "all") {
    const stage = STAGES.find((item) => item.key === filters.stage);
    conditions.push(`工程：${stage ? stageFilterLabel(stage) : filters.stage === "shipping" ? "出荷待ち" : filters.stage}`);
  }
  if (filters.attention && filters.attention !== "all") {
    const labels = { production: "製作中", due: "納期注意", shipping: "出荷待ち" };
    conditions.push(`状況：${labels[filters.attention] || filters.attention}`);
  }
  if (scope === "completed" && filters.period && filters.period !== "all") conditions.push(`完了期間：${completedPeriodLabel(filters.period)}`);
  const total = state.jobs.filter((job) => matchesJobScope(job, scope)).length;
  return { active: conditions.length > 0, total, visibleCount, conditions };
}

function renderLedgerFilterSummary(scope, visibleCount) {
  const data = ledgerFilterSummary(scope, visibleCount);
  let summary = qs(`#${scope}-filter-summary`);
  if (!summary && !data.active) return;
  if (!summary) {
    summary = document.createElement("div");
    summary.id = `${scope}-filter-summary`;
    summary.className = "ledger-filter-summary";
    qs(`#${scope}-workspace`).before(summary);
  }
  const markup = data.active ? `<p class="ledger-filter-summary-copy" role="status"><strong>絞り込み中 ${data.visibleCount}/${data.total}件</strong><span class="ledger-filter-conditions">${escapeHtml(data.conditions.join("・"))}</span></p><button class="button button-quiet" type="button" data-action="clear-${scope}-filter">絞り込みを解除</button>` : "";
  const changed = summary.hidden !== !data.active || summary.innerHTML !== markup;
  summary.hidden = !data.active;
  if (summary.innerHTML !== markup) summary.innerHTML = markup;
  if (changed) scheduleLedgerLayout();
}

function clearWorkspaceFilters(scope) {
  const filters = state.filters[scope];
  if (!filters) return;
  filters.query = "";
  filters.stage = "all";
  if (scope === "orders") filters.attention = "all";
  if (scope === "completed") filters.period = "all";
  const controls = [[`#${scope}-search`, "query"], [`#${scope}-stage-filter`, "stage"]];
  if (scope === "orders") controls.push(["#orders-attention-filter", "attention"]);
  controls.forEach(([selector, key]) => {
    const control = qs(selector);
    if (control) control.value = filters[key];
  });
  ({ dashboard: renderDashboardOrders, orders: renderOrdersWorkspace, shipping: renderShippingWorkspace, completed: renderCompletedWorkspace })[scope]?.();
  announce("絞り込みを解除しました");
}

function renderOrdersWorkspace() {
  renderWorkspaceSortControls("orders");
  updateStageFilterLabels();
  const jobs = sortedJobs("orders");
  const count = qs("#orders-result-count");
  if (count) count.textContent = ledgerTotalsText(jobs);
  renderLedgerFilterSummary("orders", jobs.length);
  const workspace = qs("#orders-workspace");
  if (!jobs.length) {
    workspace.innerHTML = `<div class="empty-state">${icon("search")}<h3>条件に合う案件がありません</h3><p>検索語か工程を変更してください。</p><button class="button button-secondary" type="button" data-action="clear-orders-filter">絞り込みを解除</button></div>`;
    return;
  }
  renderLedgerTable(workspace, jobs);
  renderSortState(workspace, "orders");
}

function renderFinishedWorkspace() {
  renderShippingWorkspace();
  renderCompletedWorkspace();
  scheduleLedgerLayout();
}

function renderShippingWorkspace() {
  renderWorkspaceSortControls("shipping");
  const jobs = sortedJobs("shipping");
  qs("#shipping-result-count").textContent = ledgerTotalsText(jobs);
  renderLedgerFilterSummary("shipping", jobs.length);
  const workspace = qs("#shipping-workspace");
  if (!jobs.length) {
    const filtered = Boolean(state.filters.shipping.query.trim());
    workspace.innerHTML = `<div class="empty-state">${icon(filtered ? "search" : "package")}<h3>${filtered ? "条件に合う出荷待ち案件がありません" : "出荷待ちの案件はありません"}</h3><p>${filtered ? "検索語を変更するか、検索を解除してください。" : "最終仕上げを完了して保存した案件が、ここに表示されます。"}</p>${filtered ? '<button class="button button-secondary" type="button" data-action="clear-shipping-filter">検索を解除</button>' : ""}</div>`;
    return;
  }
  renderLedgerTable(workspace, jobs, false, true);
  renderSortState(workspace, "shipping");
}

function renderCompletedWorkspace() {
  renderWorkspaceSortControls("completed");
  renderCompletedPeriods();
  updateStageFilterLabels();
  const jobs = sortedJobs("completed");
  const period = state.filters.completed.period;
  qs("#completed-result-summary").textContent = `${completedPeriodLabel(period)} ${ledgerTotalsText(jobs)}`;
  renderLedgerFilterSummary("completed", jobs.length);
  const workspace = qs("#completed-workspace");
  if (!jobs.length) {
    const hasQuery = Boolean(state.filters.completed.query.trim());
    const limitedPeriod = period !== "all";
    const title = hasQuery ? "条件に合う出荷済み案件がありません" : limitedPeriod ? `${completedPeriodLabel(period)}の出荷済み案件はありません` : "出荷済みの案件はまだありません";
    const copy = hasQuery ? "検索語を変更するか、検索を解除してください。" : limitedPeriod ? "出荷年月を変更するか、「すべて」にすると過去の出荷済み案件も確認できます。" : "上の出荷待ちを出荷完了にすると、ここへ移動します。";
    const action = hasQuery || limitedPeriod ? "clear-completed-filter" : "show-active-orders";
    const actionLabel = hasQuery ? "検索を解除" : limitedPeriod ? "すべての出荷済み案件を見る" : "進行中の案件を見る";
    workspace.innerHTML = `<div class="empty-state">${icon(hasQuery ? "search" : "check")}<h3>${title}</h3><p>${copy}</p><button class="button button-secondary" type="button" data-action="${action}">${actionLabel}</button></div>`;
    return;
  }
  renderLedgerTable(workspace, jobs, true);
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

function productDisplayName(job) {
  let product = normalizeProductText(job.productMaster?.displayProduct ?? job.product) || "品名未設定";
  if (job.productMaster?.labelKeywordSource === "manual") product = product.replace(/アリジ|白銅|ウスイ/g, "").replace(/\s*[・/]\s*$/g, "").replace(/\s+/g, " ").trim() || "品名未設定";
  const keywords = (job.productMaster?.labelKeywords || []).filter((keyword) => !product.normalize("NFKC").toLowerCase().includes(String(keyword).normalize("NFKC").toLowerCase()));
  return keywords.length ? `${product} ${keywords.join("・")}` : product;
}

function productLabelKeywords(value) {
  const text = normalizeProductText(value);
  return [["ｱﾘｼﾞ", "アリジ"], ["白銅", "白銅"], ["ｳｽｲ", "ウスイ"]].filter(([, term]) => text.includes(term)).map(([keyword]) => keyword);
}

function labelTitle(job) {
  const product = productDisplayName(job);
  const shape = normalizeProductText(job.specShape);
  return shape && !normalizeProductText(product).includes(shape) ? `${product} ${shape}` : product;
}

function applyClientProductLabelRules() {
  const rules = parsePolishingSetting(state.settings.productLabelRules);
  state.jobs = state.jobs.map((job) => {
    const master = job.productMaster;
    if (!master?.key || jobMutationPending(job.id)) return job;
    const rule = rules[master.key];
    return {...job,productMaster:{...master,labelKeywords:rule ? rule.keywords : master.automaticLabelKeywords || master.labelKeywords || [],labelKeywordSource:rule ? "manual" : master.labelKeywordAutoSource || "master"}};
  });
}

function labelTextSizeClass(value) {
  const length = [...String(value || "")].length;
  if (length > 26) return "is-very-long";
  if (length > 17) return "is-long";
  return "";
}

function labelDueMonth(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value.slice(5, 7) : "";
}

function productLabelMarkup(job) {
  const title = labelTitle(job);
  const customer = normalizeProductText(job.customer) || "得意先未設定";
  const dueMonth = labelDueMonth(job.dueDate);
  const quantity = Number(job.quantity);
  const specs = [
    ["全長", formatLabelLength(job.specLength)],
    ["型", normalizeProductText(job.specShape) || "—"],
    ["刃幅", normalizeProductText(job.bladeWidth) || "—"],
    ["注文番号", normalizeProductText(job.serialNo) || "—"],
    ["数量", job.quantity === "" || job.quantity == null || !Number.isFinite(quantity) ? "—" : quantity.toLocaleString("ja-JP")],
    ["納期", formatLabelDate(job.dueDate), "is-due"],
  ];
  return `<article class="product-label" data-label-month="${dueMonth}" aria-label="${escapeHtml(`${customer} ${title}の製品ラベル`)}">
    <div class="label-primary-row"><strong class="label-customer ${labelTextSizeClass(customer)}">${escapeHtml(customer)}</strong><strong class="label-product-name ${labelTextSizeClass(title)}"><span>${escapeHtml(title)}</span></strong></div>
    <div class="label-spec-grid">${specs.map(([name, value, tone = ""]) => `<div class="label-spec-cell ${tone}"><span class="label-spec-name">${name}</span><strong class="label-spec-value">${escapeHtml(value)}</strong></div>`).join("")}</div>
  </article>`;
}

function renderLabelJobList() {
  const container = qs("#label-job-list");
  const query = normalizeProductText(state.labelPrintQuery).toLocaleLowerCase("ja");
  const jobs = filteredLabelCandidateJobs().filter((job) => !query || [job.customer, productDisplayName(job), job.serialNo, job.specShape]
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
    const disabled = state.labelPrintSaving || (limitReached && !selected);
    const disabledText = state.labelPrintSaving ? "（印刷状態を保存中）" : disabled ? "（9件選択済みのため選択不可）" : "";
    const printStatus = labelPrintStatusInfo(job);
    const printedNote = printStatus.status === "printed" && job.labelPrintedAt ? ` · ${formatDateTime(job.labelPrintedAt)}` : "";
    return `<label class="label-job-option ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}">
      <input type="checkbox" data-label-job-id="${escapeHtml(job.id)}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="${escapeHtml(`${job.customer || "得意先未設定"} ${job.product || "品名未設定"}を印刷${disabledText}`)}">
      <span class="label-job-copy"><span class="label-job-title"><strong>${escapeHtml(productDisplayName(job))}</strong><span class="status-chip label-status-chip" data-tone="${printStatus.tone}">${printStatus.label}</span></span><span>${escapeHtml(job.customer || "得意先未設定")} · ${escapeHtml(job.serialNo || "連番未設定")} · 納期 ${escapeHtml(formatDate(job.dueDate))}${escapeHtml(printedNote)}</span></span>
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
  const pending = state.labelPrintPendingConfirmation.length > 0;
  printButton.hidden = pending;
  printButton.disabled = count === 0 || pending || state.labelPrintSaving;
  printButton.setAttribute("aria-disabled", String(printButton.disabled));
  qs("span", printButton).textContent = count ? `${count}枚を印刷` : "ラベルを印刷";
  qs("[data-action='clear-label-selection']").disabled = count === 0 || state.labelPrintSaving;
  const markButton = qs("#mark-selected-labels-button");
  markButton.hidden = !canEdit() || pending;
  markButton.disabled = !canEdit() || count === 0 || state.labelPrintSaving;
  qs("#label-status-filter").disabled = state.labelPrintSaving;
  qs("#label-search").disabled = state.labelPrintSaving;
  renderLabelPrintConfirmation();
}

function renderLabelPrintConfirmation() {
  const panel = qs("#label-print-result");
  const count = canEdit() && state.labelPrintConfirmationVisible ? state.labelPrintPendingConfirmation.length : 0;
  panel.hidden = count === 0;
  if (count) qs("#label-print-result-count").textContent = `直前に印刷した${count}件を確定すると、印刷待ちから外れます。`;
  qs("[data-action='confirm-label-printed']", panel).disabled = !canEdit() || state.labelPrintSaving;
  qs("[data-action='keep-label-waiting']", panel).disabled = state.labelPrintSaving;
}

function clearLabelPrintConfirmation() {
  if (state.labelPrintSaving) return;
  state.labelPrintPendingConfirmation = [];
  state.labelPrintConfirmationVisible = false;
  document.body.classList.remove("is-printing-labels");
  renderLabelSelectionState();
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
  if (isWorkerUser()) return;
  state.labelPrintQuery = "";
  state.labelPrintFilter = "queue";
  state.labelPrintSelection = new Set(labelQueueJobs().slice(0, LABEL_PRINT_LIMIT).map((job) => job.id));
  qs("#label-search").value = "";
  qs("#label-status-filter").value = "queue";
  renderLabelPrintDialog();
  openDialog(qs("#label-dialog"));
}

function updateLabelSelection(checkbox) {
  if (state.labelPrintSaving) return;
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
  renderLabelJobList();
  renderLabelSelectionState();
  qs(`[data-label-job-id='${CSS.escape(id)}']`)?.focus({ preventScroll: true });
  announce(`${state.labelPrintSelection.size}枚を選択中です`);
}

function clearLabelSelection() {
  if (state.labelPrintSaving) return;
  state.labelPrintSelection.clear();
  renderLabelPrintDialog();
  qs("#label-search").focus({ preventScroll: true });
  announce("ラベルの選択を解除しました");
}

function printSelectedLabels() {
  if (isWorkerUser()) return;
  if (state.labelPrintSaving || state.labelPrintPendingConfirmation.length) return;
  const selected = selectedLabelJobs();
  const count = selected.length;
  if (!count) {
    announce("印刷する案件を選んでください");
    return;
  }
  state.labelPrintPendingConfirmation = canEdit() ? selected.map((job) => ({ id: job.id, version: Number(job.version || 0) })) : [];
  state.labelPrintConfirmationVisible = canEdit();
  renderLabelSelectionState();
  state.printMode = "labels";
  document.body.classList.remove("is-printing-distribution");
  document.body.classList.add("is-printing-labels");
  requestAnimationFrame(() => {
    try {
      window.print();
      // Some embedded browsers omit afterprint; keep the same confirmation on return.
      finishLabelPrintPreview();
    } catch (error) {
      document.body.classList.remove("is-printing-labels");
      clearLabelPrintConfirmation();
      showToast("印刷画面を開けませんでした。ブラウザの印刷許可を確認してください。", { tone: "error" });
    }
  });
}

function finishLabelPrintPreview() {
  document.body.classList.remove("is-printing-labels");
  state.labelPrintConfirmationVisible = canEdit() && state.labelPrintPendingConfirmation.length > 0;
  renderLabelPrintConfirmation();
  if (qs("#label-dialog").open && state.labelPrintConfirmationVisible) {
    qs("[data-action='confirm-label-printed']").focus({ preventScroll: true });
  }
}

async function confirmLabelsPrinted(button, { selected = false } = {}) {
  if (!canEdit() || state.labelPrintSaving) return;
  const jobs = selected
    ? selectedLabelJobs().map((job) => ({ id: job.id, version: Number(job.version || 0) }))
    : [...state.labelPrintPendingConfirmation];
  if (!jobs.length) return;
  if (jobs.some((job) => jobMutationPending(job.id))) { showToast("選択した案件の変更を反映中です。完了後に印刷状態を確定してください。"); return; }
  const originalLabel = selected ? "選択分を印刷済みにする" : "印刷完了・待ちから外す";
  jobs.forEach((job) => pendingJobMutations.set(job.id, "印刷状態を保存中…"));
  state.labelPrintSaving = true;
  state.labelPrintSaveRevision += 1;
  renderLabelPrintDialog();
  setButtonState(button, "loading", "更新中");
  try {
    const updated = await api.markLabelsPrinted({ jobs });
    if (state.accessRevoked) return;
    const byId = new Map(updated.map((job) => [job.id, job]));
    state.jobs = state.jobs.map((job) => byId.get(job.id) || job);
    state.labelPrintSelection.clear();
    state.labelPrintPendingConfirmation = [];
    state.labelPrintConfirmationVisible = false;
    document.body.classList.remove("is-printing-labels");
    state.lastSync = new Date().toISOString();
    renderAll();
    showToast(`${updated.length}件を印刷済みにし、印刷待ちから外しました。`, { tone: "success" });
    announce(`${updated.length}件を印刷済みにし、印刷待ちから外しました`);
  } catch (error) {
    showToast(`印刷状態を更新できませんでした。${error.message}`, { tone: "error" });
  } finally {
    jobs.forEach((job) => pendingJobMutations.delete(job.id));
    state.labelPrintSaving = false;
    state.labelPrintSaveRevision += 1;
    setButtonState(button, null, originalLabel);
    renderLabelPrintDialog();
    if (qs("#label-dialog").open && !state.labelPrintPendingConfirmation.length) qs("#label-status-filter").focus({ preventScroll: true });
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
  qsa("[data-admin-only]").forEach((element) => { element.hidden = !isAdminUser(); });
  qsa("[data-owner-only]").forEach((element) => { element.hidden = !isOwnerUser(); });
  qs("#settings-context").textContent = isWorkerUser() ? "この端末の表示" : "接続と移行";
  qs("#settings-title").textContent = isWorkerUser() ? "表示設定" : "運用設定";
  renderAccessSettings();
  if (state.settings.gmailQuery) qs("#gmail-query").value = state.settings.gmailQuery;
  renderStageAssigneeSettings();
  const editorLink = qs("#script-editor-link");
  const validEditorUrl = /^https:\/\/script\.google\.com\/home\/projects\/[A-Za-z0-9_-]+\/edit$/.test(state.scriptEditorUrl);
  editorLink.hidden = !validEditorUrl;
  if (validEditorUrl) editorLink.href = state.scriptEditorUrl;
  else editorLink.removeAttribute("href");
  qs("#script-editor-unavailable").hidden = validEditorUrl;
  renderThemeSetting();
}

function handleAccessRequired() {
  state.accessRevoked = true;
  state.jobs = [];
  state.intake = [];
  state.settings = {};
  state.accessSettings = null;
  state.accessSettingsDraft = null;
  state.access = { email: "", isAdmin: false };
  state.materialInventory = null;
  materialUi?.setSnapshot(null);
  finishedStockUi?.clear();
  failedOrderDrafts.clear();
  stockFulfillmentAttempts.clear();
  failedProcessDrafts.clear();
  failedPolishingAttempts.clear();
  setStartupState();
  renderBackgroundActivity();
  qsa("dialog[open]").forEach((dialog) => dialog.close());
  document.body.classList.add("access-locked");
  qs("#access-required").hidden = false;
  qs("#access-required").focus();
}

function normalizeAccessUsers(users) {
  const normalized = (Array.isArray(users) ? users : []).map((user) => ({ email: String(user?.email || "").trim().toLowerCase(), role: String(user?.role || "editor") })).filter((user) => user.email);
  const emails = normalized.map((user) => user.email);
  if (emails.length > 50 || emails.some((email) => email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email))) {
    throw new Error("メールアドレスを1行に1つずつ、50件まで入力してください。");
  }
  if (normalized.some((user) => !ROLE_OPTIONS.some((option) => option.value === user.role)) || new Set(emails).size !== emails.length) throw new Error("権限またはメールアドレスの重複を確認してください。");
  return normalized;
}

function usersFromAccessSettings(settings = {}) {
  const users = Array.isArray(settings.users) ? settings.users : (settings.emails || []).map((email) => ({ email, role: "editor" }));
  return users.map((user) => ({ email: String(user.email || "").trim().toLowerCase(), role: ROLE_OPTIONS.some((option) => option.value === user.role) ? user.role : "editor" }));
}

function accessSettingsError(error) {
  return String(error?.message || error).replace(/EDITOR_REQUIRED:?\s*/g, "編集権限が必要です。").replace(/ADMIN_REQUIRED:?\s*/g, "管理者権限が必要です。").replace(/OWNER_REQUIRED:?\s*/g, "所有者権限が必要です。");
}

function renderAccessSettingsRows() {
  const currentEmail = String(state.access.email || "").toLowerCase();
  const protectedSelf = !isOwnerUser() && accessRole() === "admin" ? currentEmail : "";
  qs("#access-users").innerHTML = (state.accessSettingsDraft || []).map((user, index) => {
    const protectedRow = Boolean(protectedSelf && user.email === protectedSelf);
    const options = ROLE_OPTIONS.map(({ value, label }) => `<option value="${value}" ${user.role === value ? "selected" : ""}>${label}</option>`).join("");
    return `<div class="access-user-row" data-access-user-row="${index}"><label class="field"><span>Googleアカウントのメールアドレス</span><input type="email" data-access-email value="${escapeHtml(user.email)}" maxlength="254" autocomplete="off" required ${protectedRow ? "readonly" : ""}></label><label class="field"><span>権限</span><select data-access-role ${protectedRow ? "disabled" : ""}>${options}</select></label><button class="button button-quiet access-user-remove" type="button" data-action="remove-access-user" aria-label="${escapeHtml(user.email || `アカウント${index + 1}`)}を削除" ${protectedRow ? "disabled title='自分の管理者権限は変更できません'" : ""}>削除</button></div>`;
  }).join("") || `<p class="access-user-empty">許可されたアカウントはありません。</p>`;
}

function renderAccessSettings() {
  const roleLabel = { owner: "所有者・管理者", admin: "管理者", editor: "編集者", worker: "作業員", viewer: "閲覧のみ" }[accessRole()] || "";
  qs("#current-access-user").textContent = state.access.email ? `${state.access.email}（${roleLabel}）` : "";
  if (!isAdminUser() || !state.accessSettings) return;
  qs("#access-admin-email").textContent = state.accessSettings.adminEmail || state.accessSettings.ownerEmail || state.access.email;
  if (!state.accessSettingsDirty && !state.accessSettingsSaving) {
    state.accessSettingsDraft = usersFromAccessSettings(state.accessSettings);
    renderAccessSettingsRows();
  }
  qs("#access-mail-readiness").textContent = state.accessSettings.emailVerificationReady === false
    ? state.accessSettings.emailVerificationMessage || "確認コードの送信準備が必要です。管理者がApps Scriptでメール送信の権限を許可してください。"
    : "追加された人は、同じURLを開いてメールの確認コードで本人確認すると利用できます。";
  qs("#access-mail-readiness").dataset.tone = state.accessSettings.emailVerificationReady === false ? "error" : "";
  const authorizationLink = qs("#access-mail-authorization-link");
  let authorizationUrl = "";
  try {
    const parsed = new URL(state.accessSettings.emailAuthorizationUrl || "");
    if (parsed.protocol === "https:" && ["accounts.google.com", "script.google.com"].includes(parsed.hostname) && !parsed.username && !parsed.password) authorizationUrl = parsed.href;
  } catch { /* Missing or malformed links stay hidden. */ }
  authorizationLink.hidden = !isOwnerUser() || state.accessSettings.emailVerificationReady !== false || !authorizationUrl;
  if (authorizationUrl) authorizationLink.href = authorizationUrl;
  else authorizationLink.removeAttribute("href");
}

async function saveAccessSettings(event) {
  event.preventDefault();
  if (state.accessSettingsSaving || !isAdminUser() || !state.accessSettings) return;
  const form = qs("#access-settings-form");
  const status = qs("#access-settings-status");
  try {
    const users = normalizeAccessUsers(qsa("[data-access-user-row]", form).map((row) => ({ email: qs("[data-access-email]", row).value, role: qs("[data-access-role]", row).value })));
    state.accessSettingsDraft = users;
    state.accessSettingsSaving = true;
    state.accessSettingsRevision += 1;
    qsa("button, input, select", form).forEach((element) => { element.disabled = true; });
    status.textContent = "保存しています…";
    state.accessSettings = { ...state.accessSettings, ...await api.saveAccessSettings({ users, version: state.accessSettings.version }) };
    state.accessSettingsDraft = usersFromAccessSettings(state.accessSettings);
    state.accessSettingsDirty = false;
    status.textContent = "保存しました。リストから外したアカウントは次の操作から利用できなくなります。";
    announce("利用アカウントを保存しました");
  } catch (error) {
    status.textContent = accessSettingsError(error);
    showToast(accessSettingsError(error), { tone: "error" });
  } finally {
    state.accessSettingsSaving = false;
    state.accessSettingsRevision += 1;
    qsa("button, input, select", form).forEach((element) => { element.disabled = false; });
    if (isAdminUser()) renderAccessSettingsRows();
  }
}

async function reloadAccessSettings() {
  if (state.accessSettingsSaving) return;
  try {
    state.accessSettings = await api.getAccessSettings();
    state.accessSettingsDraft = usersFromAccessSettings(state.accessSettings);
    state.accessSettingsDirty = false;
    qs("#access-settings-status").textContent = "保存済みの設定を読み込みました。";
    renderAccessSettings();
  } catch (error) { showToast(accessSettingsError(error), { tone: "error" }); }
}

function renderDistributionAssigneeSettings() {
  if (state.distributionAssigneeSettingsDirty || state.distributionAssigneeSettingsSaving) return;
  const container = qs("#distribution-assignee-settings");
  const names = configuredDistributionAssignees();
  const renderedValue = JSON.stringify(names);
  if (container.dataset.renderedValue === renderedValue) return;
  container.innerHTML = ASSIGNEES.map((name) => `<label class="assignee-setting-choice"><input type="checkbox" value="${name}" ${names.includes(name) ? "checked" : ""}><span>${name}</span></label>`).join("");
  container.dataset.renderedValue = renderedValue;
}

function markDistributionAssigneeSettingsDirty() {
  state.distributionAssigneeSettingsDirty = true;
  qs("#distribution-assignee-settings-status").textContent = "未保存の変更があります。";
}

async function saveDistributionAssigneeSettings(event) {
  event.preventDefault();
  if (!isAdminUser()) return;
  if (state.distributionAssigneeSettingsSaving) return;
  const form = event.currentTarget;
  const button = qs("button[type='submit']", form);
  const names = qsa("input:checked", form).map((input) => input.value);
  state.distributionAssigneeSettingsSaving = true;
  state.distributionSettingsSaveRevision += 1;
  qsa("fieldset, button", form).forEach((control) => { control.disabled = true; });
  setButtonState(button, "loading", "保存中");
  try {
    state.settings = await api.saveSettings({ distributionAssignees: JSON.stringify(names) });
    state.distributionAssigneeSettingsDirty = false;
    qs("#distribution-assignee-settings-status").textContent = "保存しました。配布表に反映されています。";
    announce("配布表に表示する担当者を保存しました");
  } catch (error) {
    qs("#distribution-assignee-settings-status").textContent = "保存できませんでした。もう一度保存してください。";
    showToast(error.message, { tone: "error" });
  } finally {
    state.distributionAssigneeSettingsSaving = false;
    state.distributionSettingsSaveRevision += 1;
    qsa("fieldset, button", form).forEach((control) => { control.disabled = false; });
    setButtonState(button, null, "表示する担当者を保存");
    renderDistributionWorkspace();
  }
}

function configuredStageAssignees(stageKey, jobOrCategory) {
  let configured;
  try {
    configured = JSON.parse(state.settings.stageAssignees || "{}");
  } catch {
    configured = {};
  }
  const category = typeof jobOrCategory === "string" ? jobOrCategory : jobCategory(jobOrCategory || {});
  const settingKey = stageKey === "heat" && category === "鋭匙鉗子" ? "heatSharp" : stageKey;
  const names = settingKey === "heatSharp" && !Array.isArray(configured?.heatSharp) ? configured?.heat : configured?.[settingKey];
  return Array.isArray(names) ? ASSIGNEES.filter((name) => names.includes(name)) : [...ASSIGNEES];
}

function renderStageAssigneeSettings() {
  if (state.stageAssigneeSettingsDirty || state.stageAssigneeSettingsSaving) return;
  const container = qs("#stage-assignee-settings");
  const configuration = Object.fromEntries(STAGE_ASSIGNEE_SETTINGS.map((stage) => [stage.key, configuredStageAssignees(stage.key)]));
  const renderedValue = JSON.stringify(configuration);
  if (container.dataset.renderedValue === renderedValue) return;
  container.innerHTML = STAGE_ASSIGNEE_SETTINGS.map((stage) => `<fieldset class="stage-assignee-setting" data-stage-key="${stage.key}">
    <legend>${stage.label}</legend>
    <div class="stage-assignee-choices">${ASSIGNEES.map((name) => `<label class="assignee-setting-choice"><input type="checkbox" value="${name}" ${configuration[stage.key].includes(name) ? "checked" : ""}><span>${name}</span></label>`).join("")}</div>
  </fieldset>`).join("");
  container.dataset.renderedValue = renderedValue;
}

function markStageAssigneeSettingsDirty() {
  state.stageAssigneeSettingsDirty = true;
  qs("#stage-assignee-settings-status").textContent = "未保存の変更があります。";
}

async function saveStageAssigneeSettings(event) {
  event.preventDefault();
  if (!isAdminUser()) return;
  if (state.stageAssigneeSettingsSaving) return;
  const form = event.currentTarget;
  const button = qs("button[type='submit']", form);
  const configuration = Object.fromEntries(qsa(".stage-assignee-setting", form).map((row) => [
    row.dataset.stageKey, qsa("input:checked", row).map((input) => input.value),
  ]));
  state.stageAssigneeSettingsSaving = true;
  qsa("fieldset, button", form).forEach((control) => { control.disabled = true; });
  setButtonState(button, "loading", "保存中");
  try {
    state.settings = await api.saveSettings({ stageAssignees: JSON.stringify(configuration) });
    state.stageAssigneeSettingsDirty = false;
    qs("#stage-assignee-settings-status").textContent = "保存しました。次に開く工程画面から反映されます。";
    announce("工程ごとの担当候補を保存しました");
  } catch (error) {
    qs("#stage-assignee-settings-status").textContent = "保存できませんでした。内容を確認して、もう一度保存してください。";
    showToast(error.message, { tone: "error" });
  } finally {
    state.stageAssigneeSettingsSaving = false;
    qsa("fieldset, button", form).forEach((control) => { control.disabled = false; });
    setButtonState(button, null, "担当候補を保存");
    renderStageAssigneeSettings();
  }
}

function placeLedgerNavigation(view) {
  const nav = qs("#main-navigation");
  const home = qs("#navigation-home");
  const slot = qs(`[data-view-panel="${view}"] .ledger-navigation-slot`) || home;
  if (slot && nav?.parentElement !== slot && typeof slot.append === "function") slot.append(nav);
  if (home) home.hidden = slot !== home;
}

function switchView(view) {
  if (view === "shipping") view = "completed";
  if (!canAccessView(view)) view = isWorkerUser() ? "orders" : "dashboard";
  state.activeView = view;
  placeLedgerNavigation(view);
  document.body.classList.toggle("is-ledger-view", ["orders", "shipping", "completed"].includes(view));
  document.body.classList.toggle("is-ledger-focus", ["orders", "shipping", "completed"].includes(view) && (state.ledgerDisplay.compact || state.ledgerDisplay.progressOnly));
  document.body.classList.toggle("is-ledger-progress", ["orders", "shipping", "completed"].includes(view) && state.ledgerDisplay.progressOnly);
  qsa("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  qsa("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
      button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    else button.removeAttribute("aria-current");
  });
  qs(".primary-nav").classList.remove("is-open");
  qs("[data-action='toggle-nav']").setAttribute("aria-expanded", "false");
  qs("#main-content").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  renderActiveView();
  if (["orders", "shipping", "completed"].includes(view)) applyLedgerScale(state.ledgerDisplay.scale, { mode: state.ledgerDisplay.mode, persist: false });
  scheduleLedgerLayout();
}

function showOrders({ attention = "all", stage = "all" } = {}) {
  state.filters.orders = { ...state.filters.orders, query: "", stage, attention };
  qs("#orders-search").value = "";
  qs("#orders-stage-filter").value = stage;
  qs("#orders-attention-filter").value = attention;
  renderWorkspaceSortControls("orders");
  renderOrdersWorkspace();
  switchView("orders");
}

function showCompleted(period = "current") {
  state.filters.completed = { ...state.filters.completed, query: "", stage: "all", period };
  qs("#completed-search").value = "";
  renderWorkspaceSortControls("completed");
  renderCompletedWorkspace();
  switchView("completed");
}

function showShipping() {
  state.filters.shipping.query = "";
  qs("#shipping-search").value = "";
  switchView("shipping");
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

let pendingDiscardDialog = null;

function dialogEditSnapshot(dialog) {
  if (dialog.id === "process-dialog") {
    const value = processFromForm(qs("#process-form"));
    return processEditSnapshot(value);
  }
  if (dialog.id === "order-dialog") {
    return JSON.stringify(Object.entries(orderEditFields(qs("#order-form"))));
  }
  return null;
}

function processEditSnapshot(job) {
  return JSON.stringify({ stages: Object.fromEntries(STAGES.map(({ key }) => [key, {
    status: STATUS_OPTIONS.some((option) => option.value === job.stages?.[key]?.status) ? stageStatus(job, key) : "not_started",
    assignee: String(job.stages?.[key]?.assignee || "").trim(),
  }])), shippingStatus: String(job.shippingStatus || "not_ready") });
}

function dialogHasUnsavedEdits(dialog) {
  return dialog._editBaseline != null && dialogEditSnapshot(dialog) !== dialog._editBaseline;
}

function confirmDiscardEdits() {
  const target = pendingDiscardDialog;
  pendingDiscardDialog = null;
  closeDialog(qs("#discard-dialog"), { force: true });
  if (!target?.open) return;
  if (target.id === "process-dialog") failedProcessDrafts.delete(qs("#process-form").elements.id.value);
  if (target.id === "order-dialog") failedOrderDrafts.delete(qs("#order-form").elements.id.value);
  closeDialog(target, { force: true });
}

function savePendingDialogEdits() {
  const target = pendingDiscardDialog;
  if (!target?.open) return;
  let form;
  if (target.id === "process-dialog") {
    form = qs("#process-form");
    if (!canWork() || pendingProcessSaves.has(form.elements.id.value)) return;
  } else if (target.id === "order-dialog") {
    form = qs("#order-form");
    if (!canEdit() || jobMutationPending(form.elements.id.value)) return;
  } else return;
  const warning = qs("#discard-dialog");
  warning._returnFocus = null;
  closeDialog(warning, { force: true });
  form.requestSubmit();
}

function closeDialog(dialog, { force = false } = {}) {
  if (dialog.id === "finished-stock-dialog") {
    if (force) finishedStockUi?.clear();
    else finishedStockUi?.close();
    return;
  }
  if (!force && dialog.id === "order-dialog" && pendingJobMutations.has(qs("#order-form").elements.id.value)) return;
  if (dialog.id === "bulk-intake-dialog" && bulkIntakeBusy) return;
  if (dialog.id === "intake-dialog" && (intakeDeleteBusy || intakeApproveBusy)) return;
  if (dialog.id === "customer-rules-dialog" && customerRulesBusy) return;
  if (dialog.id === "intake-learning-dialog" && intakeLearningBusy) return;
  if (!force && dialog.open && dialogHasUnsavedEdits(dialog)) {
    if (pendingDiscardDialog) return;
    pendingDiscardDialog = dialog;
    openDialog(qs("#discard-dialog"), "[data-action='continue-editing']");
    return;
  }
  if (dialog.id === "discard-dialog") pendingDiscardDialog = null;
  if (dialog.open) dialog.close();
}

function restoreAfterDialogClose(dialog) {
  const pageRegions = qsa("body > header, body > main, body > footer");
  if (!dialog._returnFocus && !pageRegions.some((element) => element.inert)) return;
  pageRegions.forEach((element) => { element.inert = Boolean(qs("dialog[open]")); });
  const returnFocus = dialog._returnFocus;
  dialog._returnFocus = null;
  requestAnimationFrame(() => {
    if (state.accessRevoked) { qs("#access-required")?.focus({ preventScroll: true }); return; }
    const focusTarget = returnFocus?.isConnected && returnFocus.getClientRects().length
      ? returnFocus
      : qs("[data-view][aria-current='page']") || qs("#main-content");
    focusTarget?.focus({ preventScroll: true });
  });
}

function updateAssigneePicker(picker, assignee) {
  const value = String(assignee || "").trim();
  qs(".stage-assignee-input", picker).value = value;
  qsa(".assignee-option", picker).forEach((button) => {
    const selected = button.dataset.assignee === value;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function highlightProcessStage(stageKey) {
  qsa(".stage-edit-row", qs("#process-stage-editor")).forEach((row) => {
    const selected = row.dataset.stageKey === stageKey;
    row.classList.toggle("is-current", selected);
    qs(".stage-edit-current", row).hidden = !selected;
  });
}

function renderStageEditor(job = {}, focusStageKey = "") {
  const stages = job.stages || {};
  cancelProcessGesture();
  qs("#process-stage-editor").innerHTML = STAGES.map((baseStage, index) => {
    const stage = stageForJob(baseStage, job);
    const selected = stageStatus(job, stage.key);
    const statuses = stageStatusOptions(job, stage.key);
    const assignee = stages[stage.key]?.assignee || "";
    const expanded = stage.key === focusStageKey;
    const configured = configuredStageAssignees(stage.key, job);
    const names = assignee && !configured.includes(assignee) ? [...configured, assignee] : configured;
    return `<div class="stage-edit-row ${expanded ? "is-current" : ""}" data-stage-key="${stage.key}" role="group" aria-labelledby="process-stage-${stage.key}">
      <div class="stage-edit-head"><span class="stage-edit-number" aria-hidden="true">${index + 1}</span><div><span class="stage-edit-label" id="process-stage-${stage.key}">${stage.label}</span><span class="stage-edit-current" ${expanded ? "" : "hidden"}>選択中</span></div></div>
      <div class="stage-controls" style="--stage-status-count:${statuses.length}" role="group" aria-label="${stage.label}の状態">${statuses.map((option) => `<button class="stage-control ${selected === option.value ? "is-selected" : ""}" type="button" data-status="${option.value}" aria-pressed="${selected === option.value}"${stage.key === "finish" && option.value === "done" && !polishingFinishReady(job) ? " disabled" : ""}>${option.label}</button>`).join("")}</div>
      <div class="assignee-picker">
        <input class="stage-assignee-input" type="hidden" value="${escapeHtml(assignee)}">
        <span class="assignee-label">担当</span>
        <div class="assignee-options" role="group" aria-label="${stage.label}の担当者">
          ${names.map((name) => `<button class="assignee-option ${assignee === name ? "is-selected" : ""}" type="button" data-assignee="${escapeHtml(name)}" aria-pressed="${assignee === name}"${!configured.includes(name) ? ' title="設定の候補外ですが、登録済みの担当者です"' : ""}>${escapeHtml(name)}</button>`).join("")}
          <button class="assignee-option assignee-unassigned ${assignee ? "" : "is-selected"}" type="button" data-assignee="" aria-pressed="${!assignee}">未定</button>
        </div>
      </div>
    </div>`;
  }).join("");
  const commonNames = ASSIGNEES.filter((name) => STAGES.every((stage) => configuredStageAssignees(stage.key, job).includes(name)));
  qs("#process-form")._bulkAssignees = commonNames;
  resetBulkProcessUndo();
}

function updateStageStatus(row, status) {
  qsa(".stage-control", row).forEach((button) => {
    const selected = button.dataset.status === status;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function resetBulkProcessUndo() {
  qs("#process-form")._bulkUndo = null;
  qs("#process-bulk-undo").hidden = true;
  qs("#process-bulk-status").textContent = "";
}

function applyBulkProcessChange({ assignee, status, undo = false }) {
  if (!canWork()) return false;
  const form = qs("#process-form");
  if (undo) {
    const previous = form._bulkUndo;
    if (!previous) return;
    qsa(".stage-edit-row", form).forEach((row) => {
      const stage = previous.stages[row.dataset.stageKey];
      updateStageStatus(row, stage.status);
      updateAssigneePicker(qs(".assignee-picker", row), stage.assignee);
    });
    form.dataset.shippingStatus = previous.shippingStatus;
    form.dataset.afterSaveView = previous.afterSaveView;
    resetBulkProcessUndo();
    qs("#process-bulk-status").textContent = "直前の一括変更を戻しました。";
  } else {
    if (assignee !== undefined && assignee !== "" && !form._bulkAssignees.includes(assignee)) {
      qs("#process-bulk-status").textContent = "この担当者は全工程の表示候補に含まれていません。設定画面で担当候補を変更できます。";
      return false;
    }
    if (assignee === undefined && !STATUS_OPTIONS.some((option) => option.value === status)) return false;
    form._bulkUndo = { ...processFromForm(form), afterSaveView: form.dataset.afterSaveView || "" };
    qsa(".stage-edit-row", form).forEach((row) => {
      if (assignee !== undefined) updateAssigneePicker(qs(".assignee-picker", row), assignee);
      else if (row.dataset.stageKey !== "finish" || status !== "done" || polishingFinishReady(form._jobBase || {})) updateStageStatus(row, status);
    });
    if (status && status !== "done" && form.dataset.shippingStatus === "shipped") {
      form.dataset.shippingStatus = "waiting";
      form.dataset.afterSaveView = "orders";
    }
    qs("#process-bulk-undo").hidden = false;
    qs("#process-bulk-status").textContent = assignee !== undefined
      ? `全工程の担当を「${assignee || "未定"}」にしました。保存すると反映されます。`
      : status === "done" && !polishingFinishReady(form._jobBase || {})
        ? "仕上げを除く工程を完了にしました。最終仕上げの完了は研磨から全数戻った後に操作できます。"
        : `全工程を${STATUS_OPTIONS.find((option) => option.value === status).label}にしました。保存すると反映されます。`;
  }
  renderProcessLifecycleAction();
  if (undo) {
    const focusTarget = qs(".stage-control.is-selected", form) || qs("button[type='submit']", form);
    focusTarget.focus({ preventScroll: true });
  }
  return true;
}

let processGesture = null;
let suppressedProcessClick = null;
const PROCESS_HOLD_MS = 450;

function processChoice(button) {
  return button.dataset.assignee !== undefined
    ? { assignee: button.dataset.assignee }
    : { status: button.dataset.status };
}

function cancelProcessGesture() {
  const gesture = processGesture;
  processGesture = null;
  if (gesture) {
    clearTimeout(gesture.timer);
    if (gesture.armed) suppressedProcessClick = { button: gesture.button, until: Date.now() + 900 };
    gesture.button.classList.remove("is-long-pressed");
    if (gesture.button.hasPointerCapture?.(gesture.pointerId)) gesture.button.releasePointerCapture(gesture.pointerId);
  }
  const target = qs("#process-all-target");
  if (target) target.hidden = true;
}

function processGestureHit(x, y) {
  const rect = qs("#process-all-target").getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function armProcessGesture(gesture) {
  if (processGesture !== gesture || !gesture.button.isConnected || !qs("#process-dialog").open) return;
  gesture.armed = true;
  gesture.button.classList.add("is-long-pressed");
  const target = qs("#process-all-target");
  const buttonRect = gesture.button.getBoundingClientRect();
  const dialogRect = qs("#process-dialog").getBoundingClientRect();
  const { assignee } = processChoice(gesture.button);
  gesture.allowed = assignee === undefined || assignee === "" || qs("#process-form")._bulkAssignees.includes(assignee);
  target.style.left = `${Math.max(dialogRect.left + 6, Math.min(buttonRect.left + buttonRect.width / 2 - 40, dialogRect.right - 86))}px`;
  target.style.top = `${Math.max(dialogRect.top + 6, buttonRect.top - 78)}px`;
  target.classList.toggle("is-unavailable", !gesture.allowed);
  target.classList.remove("is-over");
  qs("span", target).textContent = gesture.allowed ? "ここで離す" : "候補設定が必要";
  target.setAttribute("aria-label", `${gesture.button.textContent.trim()}を全工程に${gesture.allowed ? "反映：ここで離す" : "反映するには全工程の担当候補に設定してください"}`);
  target.hidden = false;
}

function startProcessGesture(event) {
  if (processGesture || event.isPrimary === false) {
    cancelProcessGesture();
    return;
  }
  const button = event.target.closest(".assignee-option, .stage-control");
  if (!button || button.disabled || (event.button !== undefined && event.button !== 0) || !canWork()) return;
  suppressedProcessClick = null;
  const gesture = { button, pointerId: event.pointerId, x: event.clientX, y: event.clientY, armed: false };
  processGesture = gesture;
  button.setPointerCapture?.(event.pointerId);
  gesture.timer = setTimeout(() => armProcessGesture(gesture), PROCESS_HOLD_MS);
}

function moveProcessGesture(event) {
  const gesture = processGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  if (!gesture.armed) {
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) cancelProcessGesture();
    return;
  }
  if (event.cancelable) event.preventDefault();
  qs("#process-all-target").classList.toggle("is-over", gesture.allowed && processGestureHit(event.clientX, event.clientY));
}

function endProcessGesture(event) {
  const gesture = processGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const apply = gesture.armed && processGestureHit(event.clientX, event.clientY);
  if (gesture.armed && event.cancelable) event.preventDefault();
  cancelProcessGesture();
  if (apply) applyBulkProcessChange(processChoice(gesture.button));
}

function suppressProcessGestureClick(event) {
  const button = event.target.closest(".assignee-option, .stage-control");
  if (button && suppressedProcessClick?.button === button && Date.now() <= suppressedProcessClick.until) {
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressedProcessClick = null;
  }
}

function bindProcessGestures() {
  const editor = qs("#process-stage-editor");
  editor.addEventListener("pointerdown", startProcessGesture);
  editor.addEventListener("pointermove", moveProcessGesture);
  editor.addEventListener("pointerup", endProcessGesture);
  editor.addEventListener("pointercancel", cancelProcessGesture);
  editor.addEventListener("lostpointercapture", () => { if (processGesture) cancelProcessGesture(); });
  editor.addEventListener("click", suppressProcessGestureClick, true);
  editor.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".assignee-option, .stage-control")) event.preventDefault();
  });
  editor.addEventListener("keydown", (event) => {
    const button = event.target.closest(".assignee-option, .stage-control");
    if (button && event.altKey && event.key === "ArrowUp" && !event.repeat) {
      event.preventDefault();
      cancelProcessGesture();
      applyBulkProcessChange(processChoice(button));
    }
  });
  const dialog = qs("#process-dialog");
  dialog.addEventListener("touchmove", (event) => {
    if (processGesture?.armed && event.cancelable) event.preventDefault();
  }, { passive: false });
  dialog.addEventListener("touchstart", (event) => { if (event.touches.length > 1) cancelProcessGesture(); }, { passive: true });
  dialog.addEventListener("scroll", cancelProcessGesture, true);
  dialog.addEventListener("close", cancelProcessGesture);
  dialog.addEventListener("cancel", cancelProcessGesture);
  window.addEventListener("blur", cancelProcessGesture);
  window.addEventListener("resize", cancelProcessGesture);
}

const pendingProcessSaves = new Map();
const failedProcessDrafts = new Map();
let processSaveRevision = 0;

function processSavePending(job) {
  if (!job || !jobMutationPending(job.id)) return false;
  showToast("この案件の変更を反映中です。他の案件は続けて操作できます。");
  return true;
}

function processFormFinishDone() {
  const finish = qsa(".stage-edit-row", qs("#process-form")).find((row) => row.dataset.stageKey === "finish");
  return Boolean(finish && qs(".stage-control.is-selected", finish)?.dataset.status === "done");
}

function renderProcessLifecycleAction() {
  const form = qs("#process-form");
  const button = qs("#process-lifecycle-action");
  const note = qs("#process-lifecycle-note");
  const shipped = form.dataset.shippingStatus === "shipped";
  const ready = processFormFinishDone() && polishingFinishReady(form._jobBase || {});
  const doneCount = qsa(".stage-control[data-status='done'].is-selected", form).length;
  qs("#process-progress").textContent = `${doneCount} / ${STAGES.length}工程 完了`;
  button.hidden = !canEdit();
  button.disabled = !canEdit() || (!shipped && !ready);
  button.setAttribute("aria-disabled", String(!shipped && !ready));
  button.dataset.action = shipped ? "reopen-order" : "complete-order";
  button.dataset.tone = shipped ? "reopen" : "complete";
  qs("span", button).textContent = shipped ? "出荷待ちへ戻す" : "出荷完了・終了へ";
  note.textContent = shipped
    ? "完成品リストの出荷済みに保存済みです。戻すと上の出荷待ちへ移動します。"
    : ready ? canEdit() ? "出荷完了にすると完成品リストの出荷済みへ移動します。" : "保存すると完成品リストの出荷待ちへ移動します。出荷は編集者以上が行います。"
      : !polishingFinishReady(form._jobBase || {}) ? "最終仕上げの完了は、研磨から全数戻った後に操作できます。" : "最終仕上げを完了して保存すると、出荷待ちへ移動します。";
}

function saveFailureKind(error) {
  const message = String(error?.message || error);
  if (/削除済み|見つかりません|権限|ACCESS_DENIED/.test(message)) return "blocked";
  return /VERSION_CONFLICT|別の端末|先に更新|更新されています/.test(message) ? "conflict" : "unknown";
}

function processSaveIdentity(input) {
  return JSON.stringify({ id: input.id, version: input.version, shippingStatus: input.shippingStatus || "",
    stages: STAGES.filter(stage => Object.prototype.hasOwnProperty.call(input.stages, stage.key)).map(({ key }) => [key, input.stages[key].status, input.stages[key].assignee]) });
}

function orderEditFields(form) {
  return Object.fromEntries([...new FormData(form)].filter(([key]) => !["id", "version"].includes(key) && !key.startsWith("_recovery.")));
}

function processEditFields(job) {
  const value = JSON.parse(processEditSnapshot(job)), fields = { shippingStatus: value.shippingStatus };
  STAGES.forEach(({ key }) => ["status", "assignee"].forEach(part => { fields[`stages.${key}.${part}`] = value.stages[key][part]; }));
  return fields;
}

// Three-way merge of editable fields only. A newer version is not permission to
// resend an old form: unrelated remote changes always come from latest.
function rebaseEditFields(base, mine, latest) {
  const values = { ...latest }, conflicts = [];
  for (const key of Object.keys(mine)) {
    if (JSON.stringify(mine[key]) === JSON.stringify(base[key])) continue;
    if (JSON.stringify(latest[key]) !== JSON.stringify(base[key]) && JSON.stringify(latest[key]) !== JSON.stringify(mine[key])) {
      conflicts.push({ key, base: base[key], mine: mine[key], latest: latest[key] });
    } else values[key] = mine[key];
  }
  return { values, conflicts };
}

function recoveryFieldLabel(key) {
  const labels = { customer: "得意先", product: "品名", productCode: "製品番号", labelKeywords: "材料表示", dueDate: "納期", quantity: "数量", stockPlannedQuantity: "うち在庫予定", serialNo: "連番", category: "大分類", priority: "優先度", labelPrintStatus: "製品ラベル", specLength: "全長", specShape: "型", bladeWidth: "刃幅", note: "備考", shippingStatus: "出荷状態" };
  const [, stage, part] = key.split(".");
  return labels[key] || `${STAGES.find(item => item.key === stage)?.label || stage}・${part === "status" ? "状態" : "担当"}`;
}

function recoveryValueLabel(key, value) {
  if (key.endsWith(".status")) return statusLabel(value);
  if (key === "shippingStatus") return ({ not_ready: "未出荷", waiting: "出荷待ち", shipped: "出荷完了", hold: "保留" })[value] || value;
  return String(value ?? "") || "（空欄）";
}

function showEditRecovery(form, analysis, apply) {
  const panel = qs("[data-edit-recovery]", form);
  form._unresolvedRecovery = new Set(analysis?.conflicts.map(item => item.key) || []);
  if (!panel) return;
  panel.hidden = !analysis;
  if (!analysis) { panel.innerHTML = ""; return; }
  panel.innerHTML = `<h3>他端末の更新を確認</h3><p role="status">${analysis.conflicts.length ? "同じ項目が変更されています。使う値を選び、内容を確認して保存してください。" : "最新の保存内容に、自分が変更した項目だけを反映しました。内容を確認して保存してください。"}</p>${analysis.conflicts.map(item => `<label class="field"><span>${escapeHtml(recoveryFieldLabel(item.key))}</span><small>編集開始時：${escapeHtml(recoveryValueLabel(item.key, item.base))}</small><small>最新の保存値：${escapeHtml(recoveryValueLabel(item.key, item.latest))}</small><small>自分の入力：${escapeHtml(recoveryValueLabel(item.key, item.mine))}</small><select name="_recovery.${escapeHtml(item.key)}" data-recovery-field="${escapeHtml(item.key)}" required><option value="">使う値を選択</option><option value="latest">最新の保存値を使う</option><option value="mine"${item.mineUnavailable ? " disabled" : ""}>自分の入力を使う${item.mineUnavailable ? "（研磨の全数戻りが必要）" : ""}</option></select></label>`).join("")}`;
  qsa("[data-recovery-field]", panel).forEach(select => select.addEventListener("change", () => {
    const item = analysis.conflicts.find(entry => entry.key === select.dataset.recoveryField);
    if (!select.value) { form._unresolvedRecovery.add(item.key); return; }
    apply(item.key, item[select.value]);
    form._unresolvedRecovery.delete(item.key);
  }));
}

function recoveryHasUnresolved(form) {
  if (!form._unresolvedRecovery?.size) return false;
  qs("[data-recovery-field]", form)?.focus();
  showToast("他端末と同じ項目の変更があります。使う値を選んでください。", { tone: "error" });
  return true;
}

async function refreshFailedDraft(kind, id) {
  const drafts = kind === "order" ? failedOrderDrafts : failedProcessDrafts;
  if (qs("dialog[open]") || state.accessRevoked) return;
  const draft = drafts.get(id);
  if (!draft || (kind === "order" ? !canEdit() : !canWork())) return;
  const before = appliedSnapshotRevision;
  await refreshData();
  if (state.accessRevoked || qs("dialog[open]") || !drafts.has(id)) return;
  if (appliedSnapshotRevision === before) { showToast("最新情報を取得できませんでした。「今すぐ更新」後に入力内容を開いてください。", { tone: "error" }); return; }
  const latest = state.jobs.find(job => job.id === id);
  if (!latest || latest.archived || (kind === "process" && !canWorkOnJob(latest))) {
    showToast("案件が削除済みか、編集権限が変わっています。下書きは再保存せず、最新の案件を確認してください。", { tone: "error" });
    return;
  }
  if (draft.failureKind === "blocked") { draft.failureKind = "conflict"; draft.failedAtRevision = before; }
  if (kind === "order") openOrderDialog(latest);
  else openProcessDialog(latest);
}

function openOrderDialog(job = null) {
  if (!canEdit()) return;
  if (processSavePending(job)) return;
  const draft = failedOrderDrafts.get(job?.id);
  if (draft?.failureKind === "blocked") { void refreshFailedDraft("order", job.id); return; }
  if (draft?.failureKind === "conflict" && appliedSnapshotRevision <= draft.failedAtRevision) { void refreshFailedDraft("order", job.id); return; }
  if (job?.archived || draft?.previous && !state.jobs.some(entry => entry.id === job.id && !entry.archived)) {
    showToast("案件が削除済みか、見つかりません。下書きは保持しています。", { tone: "error" }); return;
  }
  const form = qs("#order-form");
  form.reset();
  qsa("[data-state]", form).forEach((field) => { delete field.dataset.state; });
  qsa("[data-auto-filled]", form).forEach((field) => { delete field.dataset.autoFilled; });
  qsa("[aria-invalid='true']", form).forEach((field) => field.removeAttribute("aria-invalid"));
  const baseValue = job || { stages: {}, priority: "normal", shippingStatus: "not_ready", labelPrintStatus: "not_required" };
  const productInference = inferOrderMetadata(baseValue.product);
  const value = { ...baseValue, ...inferOrderMetadata(baseValue.product, baseValue) };
  form._labelRulesBase = structuredClone(parsePolishingSetting(state.settings.productLabelRules));
  form._labelKeywordsBase = (job?.productMaster?.labelKeywords || productLabelKeywords(job?.product)).join("・");
  form._productBase = job?.product || "";
  form.elements.labelKeywords.value = form._labelKeywordsBase;
  ["id", "version", "customer", "product", "productCode", "dueDate", "quantity", "stockPlannedQuantity", "serialNo", "category", "priority", "labelPrintStatus", "specLength", "specShape", "bladeWidth", "note"].forEach((name) => {
    const field = form.elements[name];
    if (field) field.value = name === "labelPrintStatus" ? normalizeLabelPrintStatus(value[name]) : (value[name] ?? (name === "stockPlannedQuantity" ? 0 : ""));
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
  qs("#order-dialog")._editBaseline = dialogEditSnapshot(qs("#order-dialog"));
  form._baseFields = orderEditFields(form);
  form._editJob = structuredClone(baseValue);
  form._saveAttempt = draft?.saveAttempt || null;
  showEditRecovery(form, null);
  if (draft?.failureKind === "conflict") {
    const mine = Object.fromEntries(Object.keys(form._baseFields).map(key => [key, draft.values[key] ?? ""]));
    const analysis = rebaseEditFields(draft.baseFields || Object.fromEntries(JSON.parse(draft.baseline)), mine, form._baseFields);
    const apply = (key, value) => { if (form.elements[key]) form.elements[key].value = value; updateFinishedStockOrderSummary(form); };
    Object.entries(analysis.values).forEach(([key, value]) => apply(key, value));
    form._saveAttempt = null;
    showEditRecovery(form, analysis, apply);
  } else if (draft) {
    Object.entries(draft.values).forEach(([name, value]) => { if (form.elements[name]) form.elements[name].value = value; });
    form.elements.id.value = draft.order.id;
    form._labelRulesBase = structuredClone(draft.labelRulesBase);
    form._labelKeywordsBase = draft.labelKeywordsBase;
    form._productBase = draft.productBase;
    form._stages = structuredClone(draft.order.stages);
    form._baseFields = draft.baseFields || form._baseFields;
    form._editJob = structuredClone(draft.editJob || draft.previous || baseValue);
    qs("#order-dialog")._editBaseline = draft.baseline;
    qs("#spec-auto-note").textContent = "保存できなかった入力を復元しました。内容を確認して保存してください。";
  }
  updateFinishedStockOrderSummary(form);
  openDialog(qs("#order-dialog"), form._unresolvedRecovery?.size ? "[data-recovery-field]" : "[name='customer']");
  if (draft?.failureKind === "conflict") qs("[data-edit-recovery]", form)?.scrollIntoView({ block: "start" });
}

function openProcessDialog(job, requestedStageKey = "") {
  if (!canWorkOnJob(job)) return;
  if (!job) return;
  if (processSavePending(job)) return;
  const savedBaseline = processEditSnapshot(job);
  const draft = failedProcessDrafts.get(job.id);
  if (draft?.failureKind === "blocked") { void refreshFailedDraft("process", job.id); return; }
  if (draft?.failureKind === "conflict" && appliedSnapshotRevision <= draft.failedAtRevision) { void refreshFailedDraft("process", job.id); return; }
  const latest = structuredClone(job);
  let analysis = null;
  if (draft?.failureKind === "conflict") {
    analysis = rebaseEditFields(draft.baseFields || processEditFields(draft.previous), processEditFields(draft.order), processEditFields(latest));
    job = structuredClone(latest);
    Object.entries(analysis.values).forEach(([key, value]) => applyProcessFieldToJob(job, key, value));
    if (draft.order.stages.finish.status === "done" && !polishingFinishReady(latest)) {
      const key = "stages.finish.status";
      if (!analysis.conflicts.some(item => item.key === key)) analysis.conflicts.push({ key, base: draft.baseFields?.[key], mine: "done", latest: latest.stages.finish.status });
      analysis.conflicts.find(item => item.key === key).mineUnavailable = true;
      job.stages.finish.status = latest.stages.finish.status;
    }
  } else if (draft) job = draft.order;
  const form = qs("#process-form");
  form.reset();
  form._baseFields = draft && !analysis ? draft.baseFields : processEditFields(latest);
  form._editJob = draft && !analysis ? draft.editJob || latest : latest;
  form._saveAttempt = draft && !analysis ? draft.saveAttempt : null;
  form._retryOrder = draft && !analysis ? draft.order : null;
  form.elements.id.value = job.id;
  form.elements.version.value = Number(job.version || 0);
  form.dataset.shippingStatus = job.shippingStatus || "not_ready";
  form.dataset.afterSaveView = draft?.destination || "";
  form._jobBase = { ...job };
  const current = currentStage(job);
  const focusStageKey = STAGES.some((stage) => stage.key === requestedStageKey)
    ? requestedStageKey
    : STAGES.some((stage) => stage.key === current.key) ? current.key : STAGES[STAGES.length - 1].key;
  qs("#process-dialog-kicker").textContent = job.shippingStatus === "shipped" ? "終了案件の工程" : "工程と担当を更新";
  qs("#process-product").textContent = productDisplayName(job);
  qs("#process-customer").textContent = job.customer || "未設定";
  qs("#process-due").textContent = job.dueDate ? formatDate(job.dueDate, { year: "numeric", month: "numeric", day: "numeric" }) : "未設定";
  qs("#process-serial").textContent = job.serialNo || "未設定";
  qs("#process-quantity").textContent = job.quantity === "" || job.quantity == null ? "未設定" : String(job.quantity);
  qs("#process-length").textContent = job.specLength || "—";
  qs("#process-shape").textContent = job.specShape || "—";
  qs("#process-blade").textContent = job.bladeWidth || "—";
  qs("#process-note").textContent = job.note ? `備考：${job.note}` : "";
  qs("#process-note").hidden = !job.note;
  const polishingInfo = qs("#process-polishing-state");
  const polishing = polishingCounts(job);
  polishingInfo.textContent = `研磨屋 ${polishing.outstanding}丁 · 戻り ${polishing.returned}丁${polishing.returned ? ` · ${polishingFinishLabel(job)}` : ""}`;
  polishingInfo.hidden = polishing.sent === 0;
  renderStageEditor(job, focusStageKey);
  showEditRecovery(form, analysis, (key, value) => {
    if (key === "shippingStatus") form.dataset.shippingStatus = value;
    else {
      const [, stage, part] = key.split(".");
      const row = qs(`.stage-edit-row[data-stage-key='${stage}']`, form);
      if (part === "status") updateStageStatus(row, value);
      else updateAssigneePicker(qs(".assignee-picker", row), value);
    }
    renderProcessLifecycleAction();
  });
  if (draft) qs("#process-bulk-status").textContent = "前回は保存できませんでした。入力内容を復元しています。確認してもう一度保存してください。";
  renderProcessLifecycleAction();
  qs("#process-dialog")._editBaseline = draft ? savedBaseline : dialogEditSnapshot(qs("#process-dialog"));
  openDialog(qs("#process-dialog"), form._unresolvedRecovery?.size ? "[data-recovery-field]" : `.stage-edit-row[data-stage-key='${focusStageKey}'] .stage-control.is-selected`);
  const focusTarget = analysis ? qs("[data-edit-recovery]", form) : requestedStageKey === "shipping" ? qs("#process-lifecycle-note") : qs(`.stage-edit-row[data-stage-key='${focusStageKey}']`, form);
  focusTarget.scrollIntoView({ block: "nearest" });
}

function applyProcessFieldToJob(job, key, value) {
  if (key === "shippingStatus") job.shippingStatus = value;
  else {
    const [, stage, part] = key.split(".");
    job.stages[stage][part] = value;
  }
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
  const values = Object.fromEntries([...new FormData(form)].filter(([key]) => !key.startsWith("_recovery.")));
  Object.assign(values, inferOrderMetadata(values.product, values));
  const labelValue = String(values.labelKeywords || "").trim();
  delete values.labelKeywords;
  const inputKeywords = productLabelKeywords(labelValue);
  const productKeywords = productLabelKeywords(values.product);
  const productKeywordsChanged = normalizeProductText(values.product) !== normalizeProductText(form._productBase || "") && productKeywords.length > 0;
  let productLabelRule;
  if (labelValue !== (form._labelKeywordsBase || "") || productKeywordsChanged) {
    productLabelRule = {mode:labelValue !== (form._labelKeywordsBase || "") ? labelValue ? "manual" : "auto" : "manual",keywords:labelValue !== (form._labelKeywordsBase || "") ? inputKeywords : productKeywords,expectedRules:form._labelRulesBase || {}};
    values.product = normalizeProductText(values.product).replace(/アリジ|白銅|ウスイ/g, "").replace(/\s*[・/]\s*$/g, "").replace(/\s+/g, " ").trim();
  }
  return {
    ...values,
    ...(productLabelRule ? {productLabelRule} : {}),
    quantity: values.quantity ? Number(values.quantity) : "",
    stockPlannedQuantity: Number(values.stockPlannedQuantity || 0),
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
  if (!canEdit()) return;
  const form = event.currentTarget;
  if (recoveryHasUnresolved(form)) return;
  if (jobMutationPending(form.elements.id.value)) return;
  if (!validateOrderForm(form)) {
    qs("[aria-invalid='true']", form)?.focus();
    announce("入力内容を確認してください");
    return;
  }
  const order = orderFromForm(form);
  try { order.stockPlannedQuantity = validateFinishedStockPlan(order, state.jobs.find((job) => job.id === order.id)); }
  catch (error) { showToast(error.message, { tone: "error" }); form.elements.stockPlannedQuantity?.focus(); return; }
  const labelValue = form.elements.labelKeywords.value;
  if (normalizeProductText(labelValue).replace(/アリジ|白銅|ウスイ|[・,、/\s]/g, "")) {
    showToast("材料表示はｱﾘｼﾞ・白銅・ｳｽｲで入力してください。", {tone:"error"});
    form.elements.labelKeywords.focus(); return;
  }
  const previous = state.jobs.find((job) => job.id === order.id);
  if (!order.id) {
    order.id = window.crypto.randomUUID();
    order.sourceRef = order.sourceRef || `manual:${order.id}`;
    form.elements.id.value = order.id;
  }
  const fingerprint = JSON.stringify(order);
  const saveAttempt = form._saveAttempt?.fingerprint === fingerprint
    ? form._saveAttempt : { fingerprint, requestId: window.crypto.randomUUID() };
  form._saveAttempt = saveAttempt;
  order.requestId = saveAttempt.requestId;
  const draft = { order, previous, values: { id: form.elements.id.value, version: form.elements.version.value, ...orderEditFields(form) },
    baseFields: structuredClone(form._baseFields || {}), editJob: structuredClone(form._editJob || previous || {}),
    saveAttempt,
    labelRulesBase: structuredClone(form._labelRulesBase || {}), labelKeywordsBase: form._labelKeywordsBase,
    productBase: form._productBase, baseline: qs("#order-dialog")._editBaseline };
  const optimistic = { ...previous, ...order, updatedAt: new Date().toISOString() };
  pendingJobMutations.set(order.id, "注文を保存中…");
  failedOrderDrafts.delete(order.id);
  state.orderSaving = true; state.productMetadataRevision += 1;
  if (previous) state.jobs = state.jobs.map((job) => job.id === order.id ? optimistic : job);
  else state.jobs.unshift(optimistic);
  closeDialog(qs("#order-dialog"), { force: true });
  renderAll();
  try {
    const result = await api.saveJob(order);
    if (state.accessRevoked) return;
    const {productLabelRules, ...saved} = result;
    if (productLabelRules !== undefined) state.settings.productLabelRules = productLabelRules;
    const index = state.jobs.findIndex((job) => job.id === saved.id);
    if (index >= 0) {
      if (Number(saved.version) >= Number(state.jobs[index].version)) state.jobs[index] = saved;
    } else state.jobs.unshift(saved);
    if (productLabelRules !== undefined) applyClientProductLabelRules();
    state.lastSync = new Date().toISOString();
    renderAll();
    announce("注文情報を保存しました");
  } catch (error) {
    if (state.accessRevoked) return;
    state.jobs = state.jobs.flatMap((job) => job !== optimistic ? [job] : previous ? [previous] : []);
    draft.failureKind = saveFailureKind(error); draft.failedAtRevision = appliedSnapshotRevision;
    if (canEdit()) failedOrderDrafts.set(order.id, draft);
    renderAll();
    showToast(`案件を保存できませんでした。入力内容は残しています。${error.message}`, {
      tone: "error", sticky: true, action: { label: "入力内容を開く", run: () => {
        if (qs("dialog[open]")) { showToast("編集中の画面を閉じてから入力内容を開いてください。"); return; }
        if (failedOrderDrafts.has(order.id)) openOrderDialog(state.jobs.find((job) => job.id === order.id) || previous || order);
      } },
    });
  } finally {
    pendingJobMutations.delete(order.id);
    state.orderSaving = [...pendingJobMutations.values()].some((label) => label === "注文を保存中…");
    state.productMetadataRevision += 1;
    if (!state.accessRevoked) renderAll();
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
  if (!canWork()) return;
  const form = event.currentTarget;
  if (recoveryHasUnresolved(form)) return;
  let order = processFromForm(form);
  const fingerprint = processEditSnapshot(order);
  const saveAttempt = form._saveAttempt?.fingerprint === fingerprint
    ? form._saveAttempt : { fingerprint, requestId: window.crypto.randomUUID() };
  if (form._retryOrder && form._saveAttempt === saveAttempt) order = structuredClone(form._retryOrder);
  form._saveAttempt = saveAttempt;
  order.requestId = saveAttempt.requestId;
  if (jobMutationPending(order.id)) return;
  const previous = state.jobs.find((job) => job.id === order.id);
  if (!previous) {
    showToast("工程を保存できませんでした。案件が見つからないため、画面を更新してください。", { tone: "error" });
    return;
  }
  if (invalidFinalFinishing(order, previous)) {
    showToast("研磨から全数戻るまで、最終仕上げを完了にできません。", { tone: "error" });
    return;
  }
  if (!canWorkOnJob(previous) || (!canEdit() && order.shippingStatus !== (previous.shippingStatus || "not_ready"))) {
    showToast("出荷待ち・出荷状態の変更には編集権限が必要です。", { tone: "error" });
    return;
  }
  const changingList = Boolean(form.dataset.afterSaveView)
    || (isDone(order) && !isDone(previous) && order.shippingStatus !== "shipped")
    || (["shipping", "completed"].includes(state.activeView) && previous.shippingStatus !== "shipped" && !isDone(order));
  const destination = changingList ? order.shippingStatus === "shipped" ? "completed" : isDone(order) ? "shipping" : "orders" : "";
  const startingView = state.activeView;
  const draft = { order, destination, previous,
    baseFields: structuredClone(form._baseFields || processEditFields(form._editJob || previous)), editJob: structuredClone(form._editJob || previous), saveAttempt };
  pendingProcessSaves.set(order.id, order);
  processSaveRevision += 1;
  failedProcessDrafts.delete(order.id);
  cancelProcessGesture();
  closeDialog(qs("#process-dialog"), { force: true });
  const optimistic = { ...previous, ...order, updatedAt: new Date().toISOString() };
  state.jobs = state.jobs.map((job) => job.id === order.id ? optimistic : job);
  renderAll();
  announce("工程を保存しています");
  try {
    const saved = isWorkerUser()
      ? await api.saveJobProcess({ id: order.id, version: order.version, stages: order.stages, shippingStatus: order.shippingStatus, requestId: order.requestId })
      : await api.saveJob(order);
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((job) => job.id === saved.id && Number(saved.version || 0) >= Number(job.version || 0) ? saved : job);
    state.lastSync = new Date().toISOString();
    renderAll();
    if (destination && state.activeView === startingView && !qs("dialog[open]")) switchView(destination);
    announce(saved.shippingStatus === "shipped"
      ? "完成品リストの出荷済みへ移動しました"
      : destination === "shipping" ? previous.shippingStatus === "shipped" ? "案件を出荷待ちへ戻しました" : "最終仕上げを完了し、出荷待ちへ移動しました" : "工程を保存しました");
  } catch (error) {
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((job) => job === optimistic ? previous : job);
    if (canWork()) failedProcessDrafts.set(order.id, { ...draft, failureKind: saveFailureKind(error), failedAtRevision: appliedSnapshotRevision });
    renderAll();
    showToast(`工程を保存できませんでした。入力内容は残しています。${error.message}`, {
      tone: "error", sticky: true,
      action: { label: "入力内容を開く", run: () => {
        if (qs("dialog[open]")) {
          showToast("編集中の画面を閉じてから、保存できなかった案件を開いてください。入力内容を復元できます。");
          return;
        }
        if (failedProcessDrafts.has(order.id)) openProcessDialog(state.jobs.find((job) => job.id === order.id) || previous);
      } },
    });
  } finally {
    pendingProcessSaves.delete(order.id);
    processSaveRevision += 1;
    if (!state.accessRevoked) renderAll();
  }
}

async function restoreDeletedOrder(job) {
  if (!canEdit() || jobMutationPending(job.id)) return;
  const previous = state.jobs.find((entry) => entry.id === job.id);
  if (!previous) return;
  const optimistic = { ...previous, archived: false };
  pendingJobMutations.set(job.id, "復元を反映中…");
  state.jobs = state.jobs.map((entry) => entry === previous ? optimistic : entry);
  renderAll();
  try {
    const restored = await api.setJobArchived({ id: job.id, version: job.version, archived: false });
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((entry) => entry.id === restored.id ? restored : entry);
    renderAll();
    announce("削除した案件を元に戻しました");
  } catch (error) {
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((entry) => entry === optimistic ? previous : entry);
    showToast(`案件を元に戻せませんでした。${error.message}`, { tone: "error", sticky: true,
      action: { label: "再試行", run: () => restoreDeletedOrder(job) } });
  } finally {
    pendingJobMutations.delete(job.id);
    if (!state.accessRevoked) renderAll();
  }
}

async function deleteOrder(button) {
  if (!canEdit()) return;
  const form = qs("#order-form");
  const id = form.elements.id.value;
  const version = Number(form.elements.version.value || 0);
  const previous = state.jobs.find((job) => job.id === id);
  if (!previous || jobMutationPending(id)) return;
  if (polishingCounts(previous).outstanding > 0) { showToast("研磨屋にある製品は削除できません。", { tone: "error" }); return; }
  const optimistic = { ...previous, archived: true };
  pendingJobMutations.set(id, "削除を反映中…");
  state.jobs = state.jobs.map((job) => job.id === id ? optimistic : job);
  renderAll();
  closeDialog(qs("#order-dialog"), { force: true });
  try {
    const archived = await api.setJobArchived({ id, version, archived: true });
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((job) => job.id === archived.id ? archived : job);
    renderAll();
    announce("案件を削除しました");
    showToast("案件を一覧から削除しました。", {
      action: { label: "元に戻す", run: () => restoreDeletedOrder(archived) },
    });
  } catch (error) {
    if (state.accessRevoked) return;
    state.jobs = state.jobs.map((job) => job === optimistic ? previous : job);
    renderAll();
    showToast(`案件を削除できなかったため、一覧に戻しました。${error.message}`, { tone: "error", sticky: true });
  } finally {
    pendingJobMutations.delete(id);
    if (!state.accessRevoked) renderAll();
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
  if (!canEdit()) return;
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
  if (!isOwnerUser()) return;
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
  if (!canEdit()) return;
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
  if (!isOwnerUser()) return;
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
  ["customer", "得意先", "text", true], ["product", "品名", "text", true], ["productCode", "製品番号"],
  ["quantity", "数量", "number", true], ["stockPlannedQuantity", "うち在庫予定（Tezoe）", "number"], ["dueDate", "納期", "date"],
  ["serialNo", "連番"], ["category", "大分類", "select"], ["specLength", "全長"],
  ["specShape", "型"], ["bladeWidth", "刃幅"], ["note", "備考"],
];
const bulkIntakeDrafts = new Map();
let bulkIntakeBusy = false;
let intakeDeleteBusy = false;
let intakeApproveBusy = false;
let singleIntakeDuplicate = null;
let singleIntakeDecision = null;
let pendingIntakeDeletion = null;
let customerRules = null;
let customerRulesBusy = false;
let pendingCustomerCorrection = null;
let intakeLearningBusy = false;

function intakeLearningFeedback(item) {
  const learning = item?.parsed?._learning;
  const warnings = Array.isArray(item?.parsed?._parseWarnings) ? item.parsed._parseWarnings : [];
  if (!learning?.message && !warnings.length) return "";
  const tone = warnings.length || ["conflict", "ambiguous"].includes(learning?.status) ? "warning" : "";
  const fields = (learning?.fields || []).map((field) => INTAKE_LEARNING_FIELD_LABELS[field] || (field === "note" ? "備考" : field));
  return `<div class="intake-learning-feedback" data-tone="${tone}">${warnings.length ? `<strong>読取結果を確認してください</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}${learning?.message ? `<p>${escapeHtml(learning.message)}${fields.length ? ` 補完した項目：${escapeHtml(fields.join("・"))}` : ""}</p>` : ""}</div>`;
}

const INTAKE_LEARNING_FIELD_LABELS = {
  product: "品名", productCode: "製品番号", category: "大分類", specLength: "全長", specShape: "型", bladeWidth: "刃幅",
};

function renderIntakeLearningRules(rules = []) {
  const list = qs("#intake-learning-list");
  const status = qs("#intake-learning-list-status");
  if (!rules.length) {
    list.innerHTML = "";
    status.textContent = "覚えた製品の補完はありません。";
    return;
  }
  status.textContent = `覚えた補完 ${rules.length}件。解除しても案件や取込候補は変わりません。`;
  list.innerHTML = rules.map((rule) => {
    const target = rule.target || {};
    const fields = (rule.fields || []).map((key) => [INTAKE_LEARNING_FIELD_LABELS[key] || key, target[key]]).filter(([, value]) => value !== undefined && value !== "");
    if (rule.note) fields.push(["共通の備考", rule.note]);
    const evidenceId = rule.intakeId || "";
    const details = fields.length
      ? `<dl>${fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`
      : "<p>保存された補完項目はありません。</p>";
    return `<article class="intake-learning-rule"><div><h3>${escapeHtml(rule.source?.product || "品名未設定")}</h3><p>得意先: ${escapeHtml(rule.customer || "未設定")}</p></div>${details}<button class="button button-quiet" type="button" data-action="forget-intake-learning" data-learning-key="${escapeHtml(rule.key || "")}" data-intake-id="${escapeHtml(evidenceId)}" ${evidenceId ? "" : "disabled"}>この補完を忘れる</button></article>`;
  }).join("");
}

async function openIntakeLearning() {
  if (!canEdit() || intakeLearningBusy) return;
  const status = qs("#intake-learning-list-status");
  status.textContent = "補完を読み込んでいます。";
  qs("#intake-learning-list").innerHTML = "";
  openDialog(qs("#intake-learning-dialog"));
  intakeLearningBusy = true;
  try {
    const result = await api.getIntakeLearningRules();
    if (!Array.isArray(result?.rules)) throw new Error("補完一覧を確認できません。");
    renderIntakeLearningRules(globalThis.IntakeLearning?.sanitizeRules(result.rules) || result.rules);
  } catch (error) {
    status.textContent = `補完を読み込めませんでした。${error.message}`;
  } finally { intakeLearningBusy = false; }
}

async function forgetIntakeLearning(button) {
  if (!canEdit() || intakeLearningBusy) return;
  const key = button.dataset.learningKey;
  const intakeId = button.dataset.intakeId;
  if (!key || !intakeId) return;
  intakeLearningBusy = true;
  qsa("button", qs("#intake-learning-list")).forEach((control) => { control.disabled = true; });
  try {
    const result = await api.forgetIntakeLearningRule({ key, intakeId });
    if (!Array.isArray(result?.rules)) throw new Error("解除結果を確認できません。");
    renderIntakeLearningRules(globalThis.IntakeLearning?.sanitizeRules(result.rules) || result.rules);
  } catch (error) {
    qs("#intake-learning-list-status").textContent = `補完を解除できませんでした。${error.message}`;
  } finally { intakeLearningBusy = false; }
}

function updateIntakeLearningOptions(single = false) {
  const learn = qs(single ? "#intake-form [name='learnProduct']" : "#bulk-intake-learn-product");
  const note = qs(single ? "#intake-form [name='learnNote']" : "#bulk-intake-learn-note");
  if (!learn || !note) return;
  note.disabled = !learn.checked;
  if (!learn.checked) note.checked = false;
}

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
    if (remember && !isAdminUser()) throw new Error("読取ルールを保存できるのは管理者だけです。");
    const current = isAdminUser() ? await api.getCustomerRules() : (customerRules || defaultClientCustomerRules());
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
      if (!isAdminUser()) throw new Error("読取ルールを保存できるのは管理者だけです。");
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
  if (!isAdminUser()) return;
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
  const quantity = typeof order.quantity === "boolean" ? NaN : Number(order.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) return "数量を原本と確認し、1〜1,000,000の整数で入力してください。";
  try { validateFinishedStockPlan(order); } catch (error) { return error.message; }
  if (order.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(order.dueDate) || !Number.isFinite(Date.parse(order.dueDate)) || new Date(order.dueDate).toISOString().slice(0, 10) !== order.dueDate)) return "納期を有効な日付で入力してください。";
  return "";
}

function openBulkIntake() {
  if (!canEdit()) return;
  if (bulkIntakeBusy || intakeDeleteBusy) { showToast("取込候補を反映中です。他の画面は操作できます。"); return; }
  cancelIntakeDeletion();
  cancelCustomerCommand();
  const pending = new Set(state.intake.map((item) => item.id));
  for (const id of bulkIntakeDrafts.keys()) if (!pending.has(id)) bulkIntakeDrafts.delete(id);
  state.intake.forEach((item) => {
    if (bulkIntakeDrafts.has(item.id)) return;
    const parsed = item.parsed || {};
    const order = { ...parsed, ...inferOrderMetadata(parsed.product, parsed), stockPlannedQuantity: 0 };
    bulkIntakeDrafts.set(item.id, { item, order, selected: true, error: "" });
  });
  qs("#bulk-intake-result").textContent = "";
  qs("#bulk-intake-learn-product").checked = true;
  qs("#bulk-intake-learn-note").checked = false;
  updateIntakeLearningOptions();
  renderBulkIntake();
  openDialog(qs("#bulk-intake-dialog"), "#bulk-intake-all");
  api.getCustomerRules().then((rules) => { if (!customerRules || rules.version >= customerRules.version) customerRules = rules; }).catch(() => {});
}

function intakeDuplicateMarkup(duplicate, intakeId, bulk, decision = null) {
  if (!duplicate?.matches?.length) return "";
  const accepted = IntakeDuplicates.decisionAccepted(duplicate, decision);
  const attrs = `data-intake-id="${escapeHtml(intakeId)}" data-duplicate-bulk="${bulk}"`;
  return `<section class="intake-duplicate-warning" aria-label="重複候補の確認">
    <strong>${accepted ? "別注文として追加することを確認済み" : "重複する可能性があります。まだ追加していません。"}</strong>
    <p>${accepted ? "反映ボタンで追加します。確認した一致対象と追加した事実を履歴に残します。" : "一致理由と注文内容を確認し、今回の候補をどう扱うか選んでください。"}</p>
    <ul>${duplicate.matches.map((match) => {
      const type = match.kind === "job" ? match.status === "completed" ? "終了案件" : match.status === "archived" ? "削除済み案件" : "既存案件" : match.kind === "batch" ? "同じ反映内の別候補" : "確認待ちの候補";
      return `<li><strong>${type} · ${escapeHtml(match.id)}</strong><p>一致理由：${escapeHtml(match.reasons.join(" / "))}</p>
        <details><summary>${match.kind === "job" ? "既存案件を確認" : "比較候補を確認"}</summary><dl>
          <dt>得意先</dt><dd>${escapeHtml(match.customer)}</dd><dt>連番</dt><dd>${escapeHtml(match.serialNo || "空欄")}</dd>
          <dt>品名</dt><dd>${escapeHtml(match.product || "未設定")}</dd><dt>数量</dt><dd>${escapeHtml(match.quantity ?? "未設定")}</dd><dt>納期</dt><dd>${escapeHtml(match.dueDate || "未設定")}</dd>
          ${match.externalOrderNo ? `<dt>外部注文番号 / 明細番号</dt><dd>${escapeHtml(match.externalOrderNo)} / ${escapeHtml(match.externalLineNo || "空欄")}</dd>` : ""}</dl>
          ${match.kind === "job" && state.jobs.some((job) => job.id === match.id) ? `<button class="button button-secondary" type="button" data-action="review-duplicate-job" data-order-id="${escapeHtml(match.id)}">案件の工程・履歴を開く</button>` : ""}
        </details></li>`;
    }).join("")}</ul>
    <div class="dialog-actions"><button class="button button-quiet" type="button" data-action="skip-duplicate-intake" ${attrs}>今回の候補を反映しない</button>
      <button class="button ${accepted ? "button-quiet" : "button-secondary"}" type="button" data-action="${accepted ? "cancel-separate-intake" : "confirm-separate-intake"}" ${attrs}>${accepted ? "別注文の確認を取り消す" : "確認の上で別注文として追加"}</button></div>
  </section>`;
}

function setSeparateIntakeDecision(button, cancel = false) {
  if (!canEdit() || bulkIntakeBusy || intakeApproveBusy) return;
  const id = button.dataset.intakeId;
  if (button.dataset.duplicateBulk === "true") {
    const draft = bulkIntakeDrafts.get(id);
    if (!draft?.duplicate) return;
    draft.duplicateDecision = cancel ? null : { action: "add_separate", signature: draft.duplicate.duplicateSignature };
    renderBulkIntake();
  } else {
    if (!singleIntakeDuplicate || qs("#intake-form").elements.intakeId.value !== id) return;
    singleIntakeDecision = cancel ? null : { action: "add_separate", signature: singleIntakeDuplicate.duplicateSignature };
    qs("#intake-duplicate-warning").innerHTML = intakeDuplicateMarkup(singleIntakeDuplicate, id, false, singleIntakeDecision);
    if (!cancel) qs("#intake-form").requestSubmit();
  }
}

async function skipDuplicateIntake(button) {
  if (!canEdit() || bulkIntakeBusy || intakeApproveBusy || intakeDeleteBusy || pendingIntakeDeletion || pendingCustomerCorrection) return;
  const intakeId = button.dataset.intakeId;
  const bulk = button.dataset.duplicateBulk === "true";
  if (bulk) bulkIntakeBusy = true;
  else intakeApproveBusy = true;
  button.disabled = true;
  try {
    const response = await api.rejectIntakes({ intakeIds: [intakeId] });
    if (!response?.items?.some((item) => item.intakeId === intakeId)) throw new Error(response?.errors?.[0]?.message || "処理結果を確認できません。同じ候補を再試行してください。");
    state.intake = state.intake.filter((item) => item.id !== intakeId);
    bulkIntakeDrafts.delete(intakeId);
    renderAll();
    if (bulk) {
      bulkIntakeBusy = false;
      renderBulkIntake();
      if (!bulkIntakeDrafts.size) closeDialog(qs("#bulk-intake-dialog"));
    } else {
      intakeApproveBusy = false;
      closeDialog(qs("#intake-dialog"));
    }
    announce("今回の候補は反映しません。既存案件はそのままです。");
  } catch (error) {
    showToast(`候補を処理できませんでした。${error.message}`, { tone: "error" });
  } finally {
    bulkIntakeBusy = false;
    intakeApproveBusy = false;
    button.disabled = false;
    if (bulk) updateBulkIntakeSelection();
  }
}

function renderBulkIntake() {
  qs("#bulk-intake-rows").innerHTML = [...bulkIntakeDrafts].map(([id, draft], index) => {
    const fields = BULK_INTAKE_FIELDS.map(([key, label, type = "text", required]) => {
      const value = draft.order[key] ?? "";
      const attrs = `data-bulk-field="${key}" aria-label="品目${index + 1} ${label}" ${required ? "required aria-required='true'" : ""}`;
      const control = type === "select"
        ? `<select ${attrs}><option value="">未分類</option>${CATEGORY_OPTIONS.map((category) => `<option ${category === value ? "selected" : ""}>${category}</option>`).join("")}</select>`
        : key === "note" ? `<textarea ${attrs} rows="2">${escapeHtml(value)}</textarea>`
        : `<input ${attrs} type="${type}" value="${escapeHtml(value)}" ${type === "number" ? `min="${key === "stockPlannedQuantity" ? 0 : 1}" max="1000000" step="1"` : ""}>`;
      return `<label class="field bulk-field-${key}"><span>${label}${required ? " <b>必須</b>" : ""}</span>${control}${key === "product" ? `<span class="bulk-product-preview" data-bulk-product-preview ${value ? "" : "hidden"}>${escapeHtml(value)}</span>` : ""}</label>`;
    }).join("");
    return `<section class="bulk-intake-row" data-bulk-id="${escapeHtml(id)}" aria-label="品目${index + 1}">
      <div class="bulk-row-heading"><label class="bulk-check"><input type="checkbox" data-bulk-select ${draft.selected ? "checked" : ""}><strong>品目${index + 1}</strong></label><span>${escapeHtml(draft.item.subject || draft.item.sourceRef || "注文情報")}</span><button class="button button-danger" type="button" data-action="delete-intake-row" aria-label="品目${index + 1}を削除">削除</button></div>
      <div class="bulk-fields">${fields}</div>
      <p data-bulk-stock-summary>${escapeHtml(finishedStockQuantitySummary(draft.order.quantity, draft.order.stockPlannedQuantity, draft.order.customer))}</p>
      ${intakeLearningFeedback(draft.item)}
      ${intakeDuplicateMarkup(draft.duplicate, id, true, draft.duplicateDecision)}
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
  qs("#bulk-intake-learn-product").disabled = locked;
  qs("#bulk-intake-learn-note").disabled = locked || !qs("#bulk-intake-learn-product").checked;
  updateCustomerControls();
}

async function approveBulkIntake(event) {
  event.preventDefault();
  if (!canEdit()) return;
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
  qsa("button, input, select, textarea", qs("#bulk-intake-form")).forEach((input) => { input.disabled = true; });
  updateBulkIntakeSelection();
  resultLine.dataset.tone = "";
  resultLine.textContent = "選択した注文を反映しています。このままお待ちください。";
  try {
    const learnProduct = qs("#bulk-intake-learn-product").checked;
    const learnNote = learnProduct && qs("#bulk-intake-learn-note").checked;
    const response = await api.approveIntakes({ items: selected.map(([intakeId, draft]) => ({ intakeId, order: { ...draft.order, quantity: Number(draft.order.quantity), stockPlannedQuantity: Number(draft.order.stockPlannedQuantity || 0) }, duplicateDecision: draft.duplicateDecision, learnProduct, learnNote })) });
    if (!Array.isArray(response?.items) || !Array.isArray(response?.errors)) throw new Error("保存結果を確認できません。再試行して結果を確認してください。");
    const savedIds = new Set();
    const learningNotices = [];
    for (const { intakeId, job } of response.items) {
      if (!job?.id || !bulkIntakeDrafts.has(intakeId)) continue;
      savedIds.add(intakeId);
      const resultItem = response.items.find((item) => item.intakeId === intakeId);
      if (resultItem?.learningNotice) learningNotices.push(resultItem.learningNotice);
      bulkIntakeDrafts.delete(intakeId);
      state.jobs = state.jobs.filter((existing) => existing.id !== job.id);
      state.jobs.unshift(job);
    }
    state.intake = state.intake.filter((item) => !savedIds.has(item.id));
    response.errors.forEach((error) => {
      const draft = bulkIntakeDrafts.get(error.intakeId);
      if (!draft) return;
      draft.error = error.message;
      if (error.code === "INTAKE_DUPLICATE") { draft.duplicate = error; draft.duplicateDecision = null; }
    });
    renderAll();
    renderBulkIntake();
    const remaining = selected.length - savedIds.size;
    resultLine.dataset.tone = remaining ? "error" : "success";
    resultLine.textContent = (remaining
      ? `${savedIds.size}件を反映、${remaining}件は未完了です。編集内容は保持しています。下の表示を確認して再試行してください。`
      : `${savedIds.size}件を案件へ反映しました。ラベルも印刷待ちに追加しました。`) + (learningNotices.length ? ` ${[...new Set(learningNotices)].join(" ")}` : "");
    if (!bulkIntakeDrafts.size) {
      bulkIntakeBusy = false;
      closeDialog(qs("#bulk-intake-dialog"));
      switchView("orders");
      announce(`${savedIds.size}件の注文を案件へ反映しました${learningNotices.length ? `。${[...new Set(learningNotices)].join(" ")}` : ""}`);
    }
  } catch (error) {
    resultLine.dataset.tone = "error";
    resultLine.textContent = `反映結果を確認できません。${error.message} 編集内容は保持しています。再試行しても同じ候補は二重登録しません。`;
  } finally {
    bulkIntakeBusy = false;
    qs("#bulk-intake-form").setAttribute("aria-busy", "false");
    qsa("button, input, select, textarea", qs("#bulk-intake-form")).forEach((input) => { input.disabled = false; });
    updateBulkIntakeSelection();
  }
}

function openIntakeDialog(item) {
  if (!canEdit()) return;
  if (intakeDeleteBusy || intakeApproveBusy) { showToast("取込候補を反映中です。他の画面は操作できます。"); return; }
  cancelIntakeDeletion();
  singleIntakeDuplicate = null;
  singleIntakeDecision = null;
  qs("#intake-duplicate-warning").innerHTML = "";
  const feedback = intakeLearningFeedback(item);
  qs("#intake-learning-feedback").outerHTML = feedback
    ? feedback.replace('<div class="intake-learning-feedback"', '<div id="intake-learning-feedback" class="intake-learning-feedback" role="status"')
    : '<div class="intake-learning-feedback" id="intake-learning-feedback" role="status" hidden></div>';
  const form = qs("#intake-form");
  form.elements.learnProduct.checked = true;
  form.elements.learnNote.checked = false;
  updateIntakeLearningOptions(true);
  form.elements.intakeId.value = item.id;
  qs("#intake-source-preview").textContent = item.originalText || "読取テキストはありません。";
  const parsed = item.parsed || {};
  const quantityRequired = Boolean(parsed._ai) || item.sourceType === "text";
  const productInference = inferOrderMetadata(parsed.product);
  const fields = [
    ["customer", "得意先", true], ["product", "品名", true], ["productCode", "製品番号"], ["dueDate", "納期", false, "date"],
    ["quantity", "数量", quantityRequired, "number"], ["stockPlannedQuantity", "うち在庫予定（Tezoe）", false, "number"], ["serialNo", "連番"], ["category", "大分類", false, "category"], ["specLength", "全長"],
    ["specShape", "型"], ["bladeWidth", "刃幅"], ["note", "備考"],
  ];
  qs("#intake-fields").innerHTML = fields.map(([name, label, required, type = "text"]) => {
    const value = name === "stockPlannedQuantity" ? 0 : name === "category" ? (parsed.category || classifyProductCategory(parsed.product)) : (parsed[name] || "");
    const autoFilled = ["category", "specLength", "specShape", "bladeWidth"].includes(name) && value && value === productInference[name];
    const control = type === "category"
      ? `<select name="category" ${autoFilled ? "data-auto-filled='true'" : ""}><option value="">未分類（要確認）</option>${CATEGORY_OPTIONS.map((category) => `<option value="${category}" ${category === value ? "selected" : ""}>${category}</option>`).join("")}</select>`
      : `<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${name === "stockPlannedQuantity" ? 'min="0" max="1000000" step="1"' : name === "quantity" && quantityRequired ? 'min="1" max="1000000" step="1"' : ""} ${required ? "required aria-required='true'" : ""} ${autoFilled ? "data-auto-filled='true'" : ""}>`;
    return `<label class="field"><span>${label}${required ? " <b>必須</b>" : ""}</span>${control}<small>${name === "stockPlannedQuantity" ? '<span data-stock-summary></span>' : value ? "読取・推定結果。必要なら修正してください。" : "読み取れませんでした。確認して入力してください。"}</small></label>`;
  }).join("");
  updateFinishedStockOrderSummary(form);
  openDialog(qs("#intake-dialog"));
  qs(".dialog-body", qs("#intake-dialog")).scrollTop = 0;
}

async function approveIntake(event) {
  event.preventDefault();
  if (!canEdit()) return;
  if (intakeDeleteBusy || intakeApproveBusy || pendingIntakeDeletion) return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = qs("button[type='submit']", form);
  const values = Object.fromEntries(new FormData(form));
  const learnProduct = form.elements.learnProduct.checked;
  const learnNote = learnProduct && form.elements.learnNote.checked;
  const intakeId = values.intakeId;
  delete values.intakeId;
  delete values.learnProduct;
  delete values.learnNote;
  Object.assign(values, inferOrderMetadata(values.product, values));
  values.quantity = values.quantity ? Number(values.quantity) : "";
  try { values.stockPlannedQuantity = validateFinishedStockPlan(values); }
  catch (error) { showToast(error.message, { tone: "error" }); form.elements.stockPlannedQuantity?.focus(); return; }
  values.priority = "normal";
  values.shippingStatus = "not_ready";
  values.labelPrintStatus = "waiting";
  values.stages = Object.fromEntries(STAGES.map((stage) => [stage.key, { status: "not_started", assignee: "" }]));
  const parsed = state.intake.find((item) => item.id === intakeId)?.parsed || {};
  values.externalOrderNo = parsed.externalOrderNo || "";
  values.externalLineNo = parsed.externalLineNo || "";
  intakeApproveBusy = true;
  setButtonState(button, "loading", "反映中");
  qsa("input, select, textarea, button[type='button']", form).forEach((control) => { control.disabled = true; });
  try {
    const saved = await api.approveIntake({ intakeId, order: values, duplicateDecision: singleIntakeDecision, learnProduct, learnNote });
    if (saved?.code === "INTAKE_DUPLICATE") {
      singleIntakeDuplicate = saved;
      singleIntakeDecision = null;
      qs("#intake-duplicate-warning").innerHTML = intakeDuplicateMarkup(saved, intakeId, false);
      qs("#intake-duplicate-warning").scrollIntoView({ block: "nearest" });
      announce("重複する可能性のある注文があります。一致対象を確認してください。");
      return;
    }
    if (!saved?.id) throw new Error("保存結果を確認できません。同じ候補を再試行してください。");
    state.intake = state.intake.filter((item) => item.id !== intakeId);
    state.jobs = state.jobs.filter((item) => item.id !== saved.id);
    state.jobs.unshift(saved);
    renderAll();
    intakeApproveBusy = false;
    closeDialog(qs("#intake-dialog"));
    switchView("orders");
    announce(saved.importLearningNotice ? `確認した注文を案件へ反映しました。${saved.importLearningNotice}` : "確認した注文を案件へ反映しました");
  } catch (error) {
    showToast(`案件へ反映できませんでした。${error.message}`, { tone: "error" });
  } finally {
    intakeApproveBusy = false;
    qsa("input, select, textarea, button[type='button']", form).forEach((control) => { control.disabled = false; });
    setButtonState(button, null, "確認して案件へ反映");
  }
}

function requestIntakeDeletion(ids, bulk, trigger) {
  if (!canEdit()) return;
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
  if (!canEdit()) return;
  if (!pendingIntakeDeletion || intakeDeleteBusy) return;
  const pending = pendingIntakeDeletion;
  const { ids, bulk, dialog } = pending;
  const panel = qs("[data-intake-delete-confirm]", dialog);
  const resultLine = bulk ? qs("#bulk-intake-result") : qs("p", panel);
  const deleted = new Set();
  const errors = new Map();
  const previousItems = state.intake.filter((item) => ids.includes(item.id));
  intakeDeleteBusy = true;
  if (bulk) bulkIntakeBusy = true;
  qs("form", dialog).setAttribute("aria-busy", "true");
  qsa("button, input, select", dialog).forEach((input) => { input.disabled = true; });
  resultLine.dataset.tone = "";
  resultLine.textContent = `${ids.length}件を削除しています。他の画面は操作できます。`;
  state.intake = state.intake.filter((item) => !ids.includes(item.id));
  dialog.close();
  renderAll();
  try {
    // 全選択が100件を超える場合も、APIの上限に合わせて順に処理する。
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const response = await api.rejectIntakes({ intakeIds: batch });
      if (state.accessRevoked) return;
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
    if (state.accessRevoked) return;
    const currentIds = new Set(state.intake.map((item) => item.id));
    state.intake.push(...previousItems.filter((item) => !deleted.has(item.id) && !currentIds.has(item.id)));
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
    }
    showToast(message, { tone: remaining ? "error" : "success", sticky: Boolean(remaining) });
    if ((bulk && !bulkIntakeDrafts.size) || (!bulk && !remaining)) closeDialog(dialog);
    else if (dialog.open) (bulk ? qs("#bulk-intake-all") : qs("[data-action='reject-intake']", dialog)).focus();
    announce(message);
  }
}

async function saveSettings(button) {
  if (!isOwnerUser()) return;
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

function resetLegacyImportPreview() {
  state.legacyImportPreview = null;
  qs("#legacy-import-preview").hidden = true;
  qs('[data-action="migrate-sheet-apply"]').hidden = true;
}

function renderLegacyImportPreview(result) {
  const jobs = result.jobs || [];
  const quantity = jobs.reduce((sum, job) => sum + (Number(job.quantity) || 0), 0);
  const unknownQuantity = jobs.filter((job) => job.quantity === "" || job.quantity === null || job.quantity === undefined).length;
  const body = jobs.map((job) => `<tr><td>${escapeHtml(job.customer)}</td><td>${escapeHtml(job.product)}</td><td>${escapeHtml(job.serialNo || "—")}</td><td>${escapeHtml(job.dueDate || "未定")}</td><td>${escapeHtml(job.quantity === "" ? "未定" : job.quantity)}</td>${STAGES.map((stage) => `<td>${escapeHtml([job.stages?.[stage.key]?.assignee, statusLabel(job.stages?.[stage.key]?.status)].filter(Boolean).join("・"))}</td>`).join("")}</tr>`).join("");
  const preview = qs("#legacy-import-preview");
  preview.innerHTML = `<p role="status">追加予定 ${jobs.length}件・数量確定 ${quantity}丁${unknownQuantity ? `・数量未定 ${unknownQuantity}件` : ""} ／ 取込済み ${result.skipped || 0}件</p>${jobs.length ? `<div class="legacy-import-table"><table><thead><tr><th>得意先</th><th>品名</th><th>連番</th><th>納期</th><th>数量</th>${STAGES.map((stage) => `<th>${escapeHtml(stageFilterLabel(stage))}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>` : ""}`;
  preview.hidden = false;
  qs('[data-action="migrate-sheet-apply"]').hidden = !jobs.length;
}

async function migrateSheet(button, apply = false) {
  if (!isOwnerUser() || state.legacyImportBusy) return;
  const sheetName = qs("#legacy-sheet-name").value.trim();
  if (!sheetName) {
    qs("#legacy-sheet-name").setAttribute("aria-invalid", "true");
    qs("#legacy-sheet-name").focus();
    return;
  }
  qs("#legacy-sheet-name").removeAttribute("aria-invalid");
  if (apply && !state.legacyImportPreview) return;
  state.legacyImportBusy = true;
  const controls = [qs("#legacy-sheet-name"), qs("#legacy-source-url"), qs("#legacy-csv-file"), qs("#legacy-csv-text"), qs('[data-action="migrate-sheet"]'), qs('[data-action="migrate-sheet-apply"]')];
  controls.forEach((control) => { control.disabled = true; });
  setButtonState(button, "loading", apply ? "取込中" : "確認中");
  try {
    if (apply) {
      const { payload, fingerprint } = state.legacyImportPreview;
      const result = await api.migrateLegacySheet({ ...payload, dryRun: false, expectedFingerprint: fingerprint });
      resetLegacyImportPreview();
      const preview = qs("#legacy-import-preview");
      preview.textContent = `${result.imported || 0}件を取り込みました。取込済み ${result.skipped || 0}件。`;
      preview.hidden = false;
      await refreshData({ quiet: true });
      announce(preview.textContent);
    } else {
      resetLegacyImportPreview();
      const file = qs("#legacy-csv-file").files[0];
      const pastedCsv = qs("#legacy-csv-text").value.trim();
      if (file && pastedCsv) throw new Error("CSVファイルか貼り付けのどちらか一方を指定してください。");
      if (file?.size > 1000000) throw new Error("CSVは1MB以内のファイルを選んでください。");
      const payload = { sheetName, sourceUrl: qs("#legacy-source-url").value.trim() };
      if (file) payload.csvText = await file.text();
      else if (pastedCsv) payload.csvText = pastedCsv;
      if (payload.sourceUrl && !payload.csvText) throw new Error("別ファイルから読み込む場合はCSVを指定してください。");
      const result = await api.migrateLegacySheet({ ...payload, dryRun: true });
      state.legacyImportPreview = { payload, fingerprint: result.fingerprint };
      renderLegacyImportPreview(result);
      announce(`追加予定 ${result.jobs?.length || 0}件を確認しました`);
    }
  } catch (error) {
    resetLegacyImportPreview();
    showToast(error.message, { tone: "error" });
  } finally {
    state.legacyImportBusy = false;
    controls.forEach((control) => { control.disabled = false; });
    setButtonState(button, null, apply ? "この内容を取り込む" : "取込内容を確認");
  }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const zoom = event.target.closest("[data-ledger-zoom]");
    if (zoom) {
      const action = zoom.dataset.ledgerZoom;
      if (action === "fit") {
        selectLedgerPreset(Number(zoom.dataset.ledgerRows));
      } else if (action === "progress") {
        selectLedgerProgressView();
      } else applyLedgerScale(action === "reset" ? 100 : state.ledgerDisplay.scale + (action === "in" ? 10 : -10));
      return;
    }
    const details = event.target.closest("[data-action='view-order'][data-order-id]");
    if (details) {
      const job = state.jobs.find((entry) => entry.id === details.dataset.orderId);
      if (job) openLedgerDetails(job);
      return;
    }
    if (event.target.closest("[data-action='close-ledger-detail']")) {
      closeDialog(qs("#ledger-detail-dialog"));
      return;
    }
    const distributionChoice = event.target.closest("[data-distribution-id][data-distribution-assignee]");
    if (distributionChoice) {
      saveDistributionAssignee(distributionChoice.dataset.distributionId, distributionChoice.dataset.distributionAssignee);
      return;
    }
    const distributionFilter = event.target.closest("[data-distribution-filter]");
    if (distributionFilter) {
      state.distributionFilter = distributionFilter.dataset.distributionFilter;
      renderDistributionWorkspace();
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) switchView(viewButton.dataset.view);

    const themeChoice = event.target.closest("[data-theme-choice]");
    if (themeChoice) {
      applyTheme(themeChoice.dataset.themeChoice);
      announce(`${themeChoice.textContent.trim()}へ切り替えました`);
    }

    const processTarget = event.target.closest("[data-action='open-process'][data-order-id]");
    if (processTarget) {
      if (qs("#ledger-detail-dialog").open) closeDialog(qs("#ledger-detail-dialog"));
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

    const intakeTarget = event.target.closest("[data-intake-id]:not([data-action])");
    if (intakeTarget) {
      const item = state.intake.find((entry) => entry.id === intakeTarget.dataset.intakeId);
      if (item) openIntakeDialog(item);
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    const button = event.target.closest("button");
    const actions = {
      "open-polishing-send": () => sendPolishingJob(button.dataset.orderId),
      "edit-polishing-date": () => openPolishingDialog(button.dataset.orderId, "date", button.dataset.eventRequestId),
      "cancel-polishing-send": () => openPolishingDialog(button.dataset.orderId, "cancel"),
      "undo-polishing-return": () => undoPolishingReturn(button.dataset.orderId),
      "save-polishing-custom-rates": () => savePolishingCustomRates(button),
      "reset-polishing-custom-rates": () => resetPolishingCustomRates(button.dataset.orderId),
      "close-polishing-dialog": () => closeDialog(qs("#polishing-dialog")),
      "show-polishing-order": () => showPolishingOrder(button.dataset.orderId),
      "receive-polishing": () => receiveSelectedPolishing(),
      "clear-polishing-selection": () => {
        if (state.polishingSaving.size) return;
        state.polishingSelection.clear();
        renderPolishingWorkspace();
      },
      "print-distribution": () => printDistribution(),
      "distribution-previous-month": () => changeDistributionMonth(-1),
      "distribution-next-month": () => changeDistributionMonth(1),
      "toggle-nav": () => {
        const nav = qs(".primary-nav");
        nav.classList.toggle("is-open");
        button.setAttribute("aria-expanded", String(nav.classList.contains("is-open")));
      },
      "open-import": () => openDialog(qs("#import-dialog")),
      "close-import-dialog": () => closeDialog(qs("#import-dialog")),
      "open-intake-learning": () => openIntakeLearning(),
      "close-intake-learning": () => closeDialog(qs("#intake-learning-dialog")),
      "forget-intake-learning": () => forgetIntakeLearning(button),
      "open-label-print": () => openLabelPrintDialog(),
      "close-label-dialog": () => closeDialog(qs("#label-dialog")),
      "clear-label-selection": () => clearLabelSelection(),
      "print-labels": () => printSelectedLabels(),
      "keep-label-waiting": () => clearLabelPrintConfirmation(),
      "confirm-label-printed": () => confirmLabelsPrinted(button),
      "confirm-selected-labels": () => confirmLabelsPrinted(button, { selected: true }),
      "new-order": () => openOrderDialog(),
      "remove-access-user": () => {
        const row = button.closest("[data-access-user-row]");
        if (!row || !isAdminUser() || !state.accessSettingsDraft) return;
        state.accessSettingsDraft.splice(Number(row.dataset.accessUserRow), 1);
        state.accessSettingsDirty = true;
        renderAccessSettingsRows();
        qs("#access-settings-status").textContent = "未保存の変更があります。";
      },
      "close-order-dialog": () => closeDialog(qs("#order-dialog")),
      "continue-editing": () => closeDialog(qs("#discard-dialog"), { force: true }),
      "save-close-edits": savePendingDialogEdits,
      "discard-edits": confirmDiscardEdits,
      "close-process-dialog": () => closeDialog(qs("#process-dialog")),
      "delete-order": () => deleteOrder(button),
      "close-intake-dialog": () => closeDialog(qs("#intake-dialog")),
      "review-duplicate-job": () => openLedgerDetails(state.jobs.find((job) => job.id === button.dataset.orderId)),
      "confirm-separate-intake": () => setSeparateIntakeDecision(button),
      "cancel-separate-intake": () => setSeparateIntakeDecision(button, true),
      "skip-duplicate-intake": () => skipDuplicateIntake(button),
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
      "show-shipping-orders": () => showShipping(),
      "show-active-orders": () => showOrders({ attention: "production" }),
      "show-current-completed": () => showCompleted("current"),
      "show-all-completed": () => showCompleted("all"),
      "clear-orders-filter": () => clearWorkspaceFilters("orders"),
      "clear-shipping-filter": () => clearWorkspaceFilters("shipping"),
      "clear-completed-filter": () => clearWorkspaceFilters("completed"),
      "clear-filters": () => clearWorkspaceFilters("dashboard"),
      "complete-order": () => {
        const form = qs("#process-form");
        if (!processFormFinishDone() || !polishingFinishReady(form._jobBase || {})) {
          announce("研磨の全数戻りを確認し、最終仕上げを完了にしてください");
          return;
        }
        form.dataset.shippingStatus = "shipped";
        form.dataset.afterSaveView = "completed";
        form.requestSubmit();
      },
      "reopen-order": () => {
        const form = qs("#process-form");
        const stockFulfilled = form._jobBase?.completionKind === "stock_fulfillment";
        form.dataset.shippingStatus = stockFulfilled ? "not_ready" : "waiting";
        form.dataset.afterSaveView = stockFulfilled ? "finishedStock" : "shipping";
        form.requestSubmit();
      },
      "upload-image": () => uploadImage(button),
      "scan-email": () => scanEmails(button),
      "diagnose-ai": () => diagnoseAi(button),
      "reject-intake": () => requestIntakeDeletion([qs("#intake-form").elements.intakeId.value], false, button),
      "save-settings": () => saveSettings(button),
      "refresh-product-master": () => refreshProductMaster(button),
      "copy-polishing-rates": () => copyPreviousPolishingRates(),
      "discard-polishing-rates": () => { if (!state.polishingRatesSaving) { state.polishingRatesDirty = false; state.polishingRatesMessage = ""; renderPolishingBilling(); } },
      "migrate-sheet": () => migrateSheet(button),
      "migrate-sheet-apply": () => migrateSheet(button, true),
    };
    if (["new-order", "open-import", "delete-order", "open-bulk-intake", "delete-selected-intakes", "delete-intake-row", "confirm-intake-delete", "confirm-label-printed", "confirm-selected-labels"].includes(action) && !canEdit()) return;
    if (["complete-order", "reopen-order"].includes(action) && !canEdit()) return;
    if (["save-settings", "migrate-sheet", "migrate-sheet-apply", "diagnose-ai"].includes(action) && !isOwnerUser()) return;
    if (["open-customer-rules", "add-customer-rule", "remove-customer-rule", "reload-customer-rules"].includes(action) && !isAdminUser()) return;
    actions[action]?.();
  });

  qs("#order-form").addEventListener("submit", saveOrder);
  qs("#order-form").addEventListener("input", () => updateFinishedStockOrderSummary());
  qs("#access-settings-form").addEventListener("submit", saveAccessSettings);
  qs("#access-users").addEventListener("input", (event) => {
    const row = event.target.closest("[data-access-user-row]");
    if (!row || !state.accessSettingsDraft) return;
    const user = state.accessSettingsDraft[Number(row.dataset.accessUserRow)];
    if (user && event.target.matches("[data-access-email]")) user.email = event.target.value;
    state.accessSettingsDirty = true;
    qs("#access-settings-status").textContent = "未保存の変更があります。";
  });
  qs("#access-users").addEventListener("change", (event) => {
    const row = event.target.closest("[data-access-user-row]");
    if (!row || !state.accessSettingsDraft) return;
    const user = state.accessSettingsDraft[Number(row.dataset.accessUserRow)];
    if (user && event.target.matches("[data-access-role]")) user.role = event.target.value;
    state.accessSettingsDirty = true;
    qs("#access-settings-status").textContent = "未保存の変更があります。";
  });
  qs("#add-access-user").addEventListener("click", () => {
    if (!isAdminUser() || !state.accessSettingsDraft || state.accessSettingsDraft.length >= 50) return;
    state.accessSettingsDraft.push({ email: "", role: "editor" });
    state.accessSettingsDirty = true;
    renderAccessSettingsRows();
    qs("[data-access-user-row]:last-child [data-access-email]")?.focus();
    qs("#access-settings-status").textContent = "未保存の変更があります。";
  });
  qs("#reload-access-settings").addEventListener("click", reloadAccessSettings);
  qs("#process-form").addEventListener("submit", saveProcess);
  qs("#distribution-assignee-settings-form").addEventListener("submit", saveDistributionAssigneeSettings);
  qs("#distribution-assignee-settings").addEventListener("change", markDistributionAssigneeSettingsDirty);
  qs("#distribution-assignee-show-all").addEventListener("click", () => {
    qsa("#distribution-assignee-settings input").forEach((input) => { input.checked = true; });
    markDistributionAssigneeSettingsDirty();
  });
  qs("#stage-assignee-settings-form").addEventListener("submit", saveStageAssigneeSettings);
  qs("#stage-assignee-settings").addEventListener("change", markStageAssigneeSettingsDirty);
  qs("#stage-assignee-show-all").addEventListener("click", () => {
    qsa("input[type='checkbox']", qs("#stage-assignee-settings")).forEach((input) => { input.checked = true; });
    markStageAssigneeSettingsDirty();
  });
  qs("#process-bulk-undo").addEventListener("click", () => applyBulkProcessChange({ undo: true }));
  bindProcessGestures();
  qs("#intake-form").addEventListener("submit", approveIntake);
  qs("#bulk-intake-form").addEventListener("submit", approveBulkIntake);
  qs("#customer-rules-form").addEventListener("submit", saveCustomerRulesEditor);
  qs("#intake-learning-dialog").addEventListener("cancel", (event) => { if (intakeLearningBusy) event.preventDefault(); });
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
  qs("#bulk-intake-learn-product").addEventListener("change", () => updateIntakeLearningOptions());
  qs("#intake-form [name='learnProduct']").addEventListener("change", () => updateIntakeLearningOptions(true));
  qs("#bulk-intake-rows").addEventListener("input", (event) => {
    const row = event.target.closest("[data-bulk-id]");
    if (!row || bulkIntakeBusy || pendingIntakeDeletion || pendingCustomerCorrection) return;
    const draft = bulkIntakeDrafts.get(row.dataset.bulkId);
    if (event.target.matches("[data-bulk-select]")) {
      draft.selected = event.target.checked;
      updateBulkIntakeSelection();
    } else if (event.target.dataset.bulkField) {
      draft.order[event.target.dataset.bulkField] = event.target.value;
      const stockSummary = qs("[data-bulk-stock-summary]", row);
      if (stockSummary) stockSummary.textContent = finishedStockQuantitySummary(draft.order.quantity, draft.order.stockPlannedQuantity, draft.order.customer);
      draft.duplicate = null;
      draft.duplicateDecision = null;
      qs(".intake-duplicate-warning", row)?.remove();
      if (event.target.dataset.bulkField === "product") {
        const preview = qs("[data-bulk-product-preview]", row);
        preview.textContent = event.target.value;
        preview.hidden = !event.target.value;
      }
      event.target.removeAttribute("aria-invalid");
      draft.error = "";
      qs(".bulk-row-error", row).textContent = "";
    }
  });
  qs("#text-import-form").addEventListener("submit", importPastedText);
  qs("#intake-fields").addEventListener("input", () => {
    updateFinishedStockOrderSummary(qs("#intake-form"));
    singleIntakeDuplicate = null;
    singleIntakeDecision = null;
    qs("#intake-duplicate-warning").innerHTML = "";
  });
  ["#legacy-sheet-name", "#legacy-source-url", "#legacy-csv-file", "#legacy-csv-text"].forEach((selector) => {
    qs(selector).addEventListener("input", resetLegacyImportPreview);
    qs(selector).addEventListener("change", resetLegacyImportPreview);
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-label-job-id]")) updateLabelSelection(event.target);
  });

  qs("#label-search").addEventListener("input", debounce((event) => {
    state.labelPrintQuery = event.target.value;
    renderLabelJobList();
  }, 180));

  qs("#label-status-filter").addEventListener("change", (event) => {
    state.labelPrintFilter = event.target.value;
    renderLabelJobList();
    renderLabelPrintConfirmation();
    announce(`${event.target.selectedOptions[0]?.textContent || "指定範囲"}を表示しました`);
  });

  qs("#process-stage-editor").addEventListener("click", (event) => {
    const row = event.target.closest(".stage-edit-row");
    if (row && event.target.closest("button")) {
      highlightProcessStage(row.dataset.stageKey);
      resetBulkProcessUndo();
    }
    const picker = event.target.closest(".assignee-picker");
    const option = event.target.closest(".assignee-option");
    if (option && picker) {
      updateAssigneePicker(picker, option.dataset.assignee);
      return;
    }

    const control = event.target.closest(".stage-control");
    if (!control) return;
    if (row.dataset.stageKey === "finish" && control.dataset.status === "done" && !polishingFinishReady(qs("#process-form")._jobBase || {})) return;
    updateStageStatus(row, control.dataset.status);
    const processForm = qs("#process-form");
    if (processForm.dataset.shippingStatus === "shipped" && row.dataset.stageKey === "finish" && control.dataset.status !== "done") {
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
    ["#shipping-search", "shipping", "query", renderShippingWorkspace],
    ["#completed-search", "completed", "query", renderCompletedWorkspace],
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
  ["#completed-year", "#completed-month"].forEach((selector) => qs(selector).addEventListener("change", setCompletedPeriodFromControls));

  ["orders", "shipping", "completed"].forEach((scope) => {
    ["sort", "sort2", "sort3"].forEach((field) => {
      [field, `${field}-direction`].forEach((control) => {
        qs(`#${scope}-${control}`).addEventListener("change", (event) => {
          const key = control.replace("-direction", "Direction");
          setWorkspaceSort(scope, { [key]: event.target.value });
          ({ orders: renderOrdersWorkspace, shipping: renderShippingWorkspace, completed: renderCompletedWorkspace })[scope]();
          const labels = workspaceSortLabels(scope);
          announce(`${filteredJobs(scope).length}件を${sortCriteriaFor(scope).map(({ key, direction }) => `${labels[key]}${direction === "desc" ? "降順" : "昇順"}`).join("、次に")}に並べ替えました`);
        });
      });
    });
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
    if (tab.dataset.importTab === "email" && !isOwnerUser()) return;
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
    const tabs = qsa("[data-import-tab]").filter((tab) => !tab.hidden);
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

  qsa("dialog:not(#material-dialog):not(#finished-stock-dialog)").forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  }));
  qsa("dialog:not(#material-dialog):not(#finished-stock-dialog)").forEach((dialog) => dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog);
  }));
  qsa("dialog:not(#material-dialog)").forEach((dialog) => dialog.addEventListener("close", () => restoreAfterDialogClose(dialog)));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshData({ quiet: true });
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "auto") renderThemeSetting();
  });

  qs("#polishing-form").addEventListener("submit", savePolishingForm);
  qs("#polishing-workspace").addEventListener("change", (event) => {
    if (event.target.matches("[data-polishing-class-id]")) savePolishingClassification(event.target);
  });
  qs("#polishing-workspace").addEventListener("input", (event) => {
    if (event.target.matches("[data-polishing-custom-id]")) editPolishingCustomRate(event.target);
  });
  qs("#polishing-rates-form").addEventListener("submit", savePolishingRateForm);
  qs("#polishing-rate-fields").addEventListener("input", () => { state.polishingRatesDirty = true; state.polishingRatesMessage = "単価に未保存の変更があります。"; qs("#polishing-rates-status").textContent = state.polishingRatesMessage; });
  qs("#polishing-billing-month").addEventListener("change", (event) => {
    if (state.polishingRatesDirty || state.polishingRatesSaving) { event.target.value = state.polishingBillingMonth; showToast("先に単価を保存してください。"); return; }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) { event.target.value = state.polishingBillingMonth; return; }
    state.polishingBillingMonth = event.target.value;
    state.polishingRatesMessage = "";
    renderPolishingBilling();
  });
  qs("#polishing-filter").addEventListener("change", (event) => {
    state.polishingFilter = event.target.value;
    state.polishingSelection.clear();
    renderPolishingWorkspace();
  });
  qs("#polishing-search").addEventListener("input", (event) => {
    state.polishingQuery = event.target.value;
    renderPolishingWorkspace();
  });
  qs("#polishing-workspace").addEventListener("change", (event) => {
    if (!canEdit() || state.polishingSaving.size) return;
    if (event.target.id === "polishing-select-all") {
      const jobs = polishingJobs().filter((job) => polishingCounts(job).outstanding > 0);
      jobs.slice(0, 100).forEach((job) => selectPolishingJob(job.id, event.target.checked));
      if (event.target.checked && jobs.length > 100) showToast("先頭の100件を選択しました。残りは次に反映できます。");
    } else if (event.target.dataset.polishingSelectId) selectPolishingJob(event.target.dataset.polishingSelectId, event.target.checked);
    else return;
    renderPolishingWorkspace();
  });
  qs("#distribution-month").addEventListener("change", (event) => {
    setDistributionMonth("start", event.target.value);
  });
  qs("#distribution-end-month").addEventListener("change", (event) => {
    setDistributionMonth("end", event.target.value);
  });
  qs("#distribution-include-shipped").addEventListener("change", (event) => {
    state.distributionIncludeShipped = event.target.checked;
    renderDistributionWorkspace();
  });
  qs("#distribution-sort").addEventListener("change", (event) => {
    state.distributionSort = event.target.value === "customer" ? "customer" : "due";
    renderDistributionWorkspace();
  });

  window.addEventListener("beforeprint", () => {
    if (state.printMode === "distribution") {
      fitDistributionToPage();
      document.body.classList.remove("is-printing-labels");
      document.body.classList.add("is-printing-distribution");
    } else if (state.printMode === "labels") document.body.classList.add("is-printing-labels");
  });
  window.addEventListener("afterprint", () => {
    if (state.printMode === "distribution") finishDistributionPrint();
    else finishLabelPrintPreview();
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
  window.addEventListener("beforeunload", (event) => {
    if (!backgroundOperations.size) return;
    event.preventDefault();
    event.returnValue = "";
  });
  bindLedgerDisplay();
  switchView(state.activeView);
  await refreshData();
  if (isAppsScript && !state.accessRevoked && state.mode === "live" && window.AppAccessSession) {
    void window.AppAccessSession.remember().then((result) => {
      if (result?.storageUnavailable && !state.accessRevoked) showToast("このブラウザーに本人確認を保存できませんでした。ブラウザーの保存設定を確認してください。", { tone: "error" });
    }).catch(() => { /* A later reload can retry without blocking current work. */ });
  }
  setInterval(() => {
    if (document.visibilityState === "visible") refreshData({ quiet: true });
  }, 20000);
}

init();
