(function (root) {
  "use strict";

  const labels = {
    use: "使用", receive: "入庫", process: "下加工", sell: "販売（未加工）", order: "発注",
    transfer: "保管場所の移動", classify: "区分確認", count: "調整",
    threshold: "発注点の変更", cancelOrder: "発注残の取消", reverse: "記録の取消",
  };
  const submitLabels = {
    use: "使用を記録", receive: "入庫を記録", process: "下加工を記録", sell: "販売を記録",
    order: "発注を記録", count: "調整を記録",
    threshold: "発注点を保存", cancelOrder: "発注残を取り消す", reverse: "記録を取り消す",
  };
  const consuming = new Set(["use", "sell", "process"]);
  const entryTypes = new Set(["use", "sell", "process", "order", "receive", "count", "threshold"]);
  const processedPhases = new Set(["processed", "colored"]);
  const unprocessedLabel = "未加工（1階）";
  const processedLabel = "加工済（2階）";
  const placeLabels = { "1F": "1階", "2F": "2階", "保土田": "保土田（旧）" };
  const presets = [1, 2, 5, 10, 20, 30, 50];
  const numbers = new Intl.NumberFormat("ja-JP");
  const dates = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeZone: "Asia/Tokyo" });
  const qty = (n) => numbers.format(n);
  const dateLabel = (value) => value ? dates.format(new Date(value)) : "—";
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const sourceHref = (url) => /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/edit(?:[?#][\w&=#-]+)?$/.test(url || "") ? url : "";
  const key = (partId, variant) => JSON.stringify([partId, variant]);
  const errorMessage = (error) => String(error?.message || "在庫を確認して、もう一度お試しください。").replace(/(?:Exception: |Error: |CASTING_STOCK_[A-Z_]+:\s*)+/g, "");
  const button = (action, title, { partId = "", id = "", type = "", variant = "", name = "", disabled = false, describedBy = "", slot = "" } = {}) =>
    '<button type="button" class="button button-secondary" data-casting-action="' + action + '" data-part-id="' + escape(partId) +
    '" data-entry-id="' + escape(id) + '" data-entry-type="' + escape(type) + '" data-variant="' + escape(variant) + '"' +
    (slot ? ' data-casting-slot="' + escape(slot) + '"' : "") + (name ? ' aria-label="' + escape(name) + '"' : "") +
    (describedBy ? ' aria-describedby="' + escape(describedBy) + '"' : "") + (disabled ? " disabled" : "") + ">" + escape(title) + "</button>";
  const numericCell = (number) => '<td class="material-number">' + (number == null ? "—" : qty(number)) + "</td>";
  const shell = (label, field) => '<label class="field"><span>' + escape(label) + "</span>" + field + "</label>";
  const option = (id, label, selected) => '<option value="' + escape(id) + '"' + (id === selected ? " selected" : "") + ">" + escape(label) + "</option>";
  const select = (label, name, values, selected) =>
    shell(label, '<select name="' + name + '" required>' + values.map(([id, title]) => option(id, title, selected)).join("") + "</select>");
  const input = (label, name, type, value, attributes = "") =>
    shell(label, '<input name="' + name + '" type="' + type + '" value="' + escape(value) + '"' + (attributes ? " " + attributes : "") + ">");

  function create(options) {
    const doc = root.document;
    const find = (id) => doc.getElementById(id);
    const panel = doc.querySelector("[data-view-panel='castingStock']");
    const dialog = find("casting-stock-dialog");
    const form = find("casting-stock-form");
    const modalContent = find("casting-dialog-content");
    const submit = find("casting-submit");
    const statusFilter = find("casting-filter");
    let snapshot = null;
    let stock = new Map();
    let read = null;
    let readFailed = false;
    let saving = false;
    let generation = 0;
    let draft = null;
    const attempts = new Map();

    const field = (name) => form.elements.namedItem(name);
    const partFor = (id) => snapshot?.items.find((item) => item.id === id);
    const variantFor = (item, id) => item?.variants.find((variant) => variant.id === id);
    const variantLabel = (item, id) => variantFor(item, id)?.label || "";
    const orderFor = (id) => snapshot?.orders.find((order) => order.id === id);
    const variantTotal = (item, variant) => stock.get(key(item.id, variant)) ?? 0;
    const pendingOrders = (item) => snapshot.orders.filter((order) => order.partId === item.id && order.remaining > 0);
    const openingOrders = () => snapshot.openingOrders || [];
    const orderRemainder = (orders) => orders.reduce((sum, order) => sum + (order.remaining ?? order.quantity), 0);
    const processed = (item) => item.variants.filter((variant) => processedPhases.has(variant.id));
    const rawVariant = (item) => variantFor(item, "raw") ? "raw" : "single";
    const rowName = (item, phase) => phase === "colored" ? "色しっぽ" + item.name : item.name;
    const rowId = (item, phase) => phase ? item.id + ":" + phase : item.id;
    const rowVariants = (item, phase) => item.variants.filter((variant) => phase ? variant.id === phase : variant.id !== "colored");
    const variantSuffix = (item, id) => processedPhases.has(id) && processed(item).length > 1
      ? (id === "colored" ? "色しっぽ" : "通常") : "";

    function phaseLabel(item, id) {
      if (id === "raw" || id === "single") return unprocessedLabel;
      if (!processedPhases.has(id)) return variantLabel(item, id);
      const suffix = variantSuffix(item, id);
      return suffix ? "加工済（2階・" + suffix + "）" : processedLabel;
    }

    function setStatus(id, message, tone = "") {
      const element = find(id);
      element.textContent = message;
      element.dataset.tone = tone;
    }

    function itemStatus(item, phase, variants) {
      const orders = phase ? [] : snapshot.initialized ? pendingOrders(item) : openingOrders().filter((order) => order.partId === item.id);
      if (item.openingUnconfirmed) return { unconfirmed: true, checks: [], orders };
      const unknown = phase ? 0 : variantTotal(item, "unclassified");
      const checks = variants.filter((variant) => variant.threshold != null &&
        variantTotal(item, variant.id) + unknown <= variant.threshold && !orders.some((order) => order.variant === variant.id));
      return { unconfirmed: unknown > 0, checks, orders };
    }

    function floorCount(item, label, variants, phase) {
      const values = variants.map((id) => {
        const suffix = phase ? "" : variantSuffix(item, id);
        return '<span class="casting-phase-count">' + (suffix ? escape(suffix) + " " : "") +
          "<strong>" + qty(variantTotal(item, id)) + "</strong></span>";
      }).join("");
      return '<td class="material-number casting-floor"><span class="casting-floor-label" aria-hidden="true">' + label + "</span>" +
        (item.openingUnconfirmed ? "—" : values || "—") + "</td>";
    }

    function rowActions(item, phase, remainder) {
      const describedBy = "casting-part-" + rowId(item, phase);
      const entryButton = (type, variant, disabled = false, slot = "") => {
        const suffix = type === "process" ? variantSuffix(item, variant) : "";
        const title = labels[type] + (suffix ? "（" + suffix + "）" : "");
        return button("entry", title, { partId: item.id, type, variant, disabled, describedBy, slot });
      };
      const raw = rawVariant(item);
      if (item.openingUnconfirmed) return entryButton("count", phase || raw);
      if (phase) return '<div class="casting-row-actions">' +
        entryButton("use", phase, variantTotal(item, phase) === 0) + entryButton("count", phase) + "</div>";
      const variants = processed(item).map((variant) => variant.id);
      const useVariant = variantFor(item, "processed") ? "processed" : raw;
      const actions = [
        ...variants.map((id) => entryButton("process", id, variantTotal(item, raw) === 0)),
        entryButton("use", useVariant, variantTotal(item, useVariant) === 0),
        entryButton(remainder > 0 ? "receive" : "order", raw, false, "procurement"),
        entryButton("count", raw),
      ];
      return '<div class="casting-row-actions">' + actions.join("") + "</div>";
    }

    function renderTable() {
      if (!snapshot) return;
      const query = normalize(find("casting-search").value);
      const filter = snapshot.initialized ? statusFilter.value : "";
      const rows = snapshot.items.flatMap((item) => (variantFor(item, "colored") ? ["", "colored"] : [""]).map((phase) => {
        const name = rowName(item, phase);
        const aliases = (item.aliases || []).filter((alias) => normalize(alias).includes("色しっぽ") === Boolean(phase));
        const variants = rowVariants(item, phase);
        return { item, phase, name, aliases, variants, status: itemStatus(item, phase, variants) };
      }))
        .filter(({ name, aliases }) => !query || [name, ...aliases].some((value) => normalize(value).includes(query)))
        .filter(({ status }) => filter !== "low" || status.checks.length)
        .filter(({ status }) => filter !== "ordered" || status.orders.length)
        .filter(({ status }) => filter !== "unconfirmed" || status.unconfirmed);
      const visibleTotal = rows.filter(({ item }) => !item.openingUnconfirmed)
        .reduce((sum, { item, variants }) => sum + variants.reduce((total, variant) => total + variantTotal(item, variant.id), 0), 0);
      find("casting-result-count").textContent = qty(rows.length) + "品目・" + qty(visibleTotal) + "個";
      const rowMarkup = rows.map(({ item, phase, name, variants, status }) => {
        const id = rowId(item, phase);
        const nameCell = '<th scope="row" class="casting-name"><button id="casting-part-' + escape(id) +
          '" type="button" class="casting-part" data-casting-action="details" data-part-id="' + escape(item.id) +
          '" data-variant="' + escape(phase) + '">' + escape(name) + "</button></th>";
        const remainder = orderRemainder(status.orders);
        const state = [
          remainder ? '<span class="casting-ordered">発注残 ' + qty(remainder) + "個</span>" : "",
          ...(snapshot.initialized ? status.checks.map((variant) => '<span class="casting-warning">' +
            (processedPhases.has(variant.id) ? "要補充 " + escape(variant.label) : "要発注") + "</span>") : []),
          status.unconfirmed ? '<span class="casting-pending">' +
            (item.openingUnconfirmed ? "数量未登録" : "区分未確認 " + qty(variantTotal(item, "unclassified")) + "個") + "</span>" : "",
        ].join("");
        return '<tr data-casting-part="' + escape(id) + '">' + nameCell +
          floorCount(item, unprocessedLabel, phase ? [] : [rawVariant(item)], phase) +
          floorCount(item, processedLabel, variants.filter((variant) => processedPhases.has(variant.id)).map((variant) => variant.id), phase) +
          '<td class="casting-statuses">' + state + "</td>" +
          (snapshot.initialized ? '<td class="casting-row-action">' + rowActions(item, phase, remainder) + "</td>" : "") + "</tr>";
      });
      const tbody = find("casting-stock-rows");
      const active = doc.activeElement;
      const returnFocus = dialog._returnFocus;
      const restoreActive = active && tbody.contains(active);
      const restoreReturn = returnFocus && tbody.contains(returnFocus);
      const columnCount = snapshot.initialized ? 5 : 4;
      tbody.innerHTML = rowMarkup.join("") ||
        '<tr><td colspan="' + columnCount + '" class="material-empty">該当する品目がありません。検索語や絞り込みを変更してください。</td></tr>';
      if (restoreActive || restoreReturn) {
        const triggers = [...tbody.querySelectorAll("[data-casting-action]")];
        const replacement = (previous) => triggers.find((element) => {
          if (element.disabled || element.dataset.partId !== previous.dataset.partId) return false;
          if (previous.dataset.castingSlot) return element.dataset.castingSlot === previous.dataset.castingSlot;
          return ["castingAction", "entryType", "entryId", "variant"].every((field) => element.dataset[field] === previous.dataset[field]);
        }) || triggers.find((element) => element.dataset.castingAction === "details" &&
          element.dataset.partId === previous.dataset.partId && element.dataset.variant === (previous.dataset.variant === "colored" &&
            previous.dataset.entryType !== "process" ? "colored" : "")) || (snapshot.initialized ? statusFilter : find("casting-search"));
        if (restoreActive) replacement(active).focus({ preventScroll: true });
        if (restoreReturn) dialog._returnFocus = replacement(returnFocus);
      }
    }

    function renderPanel() {
      const ready = Boolean(snapshot);
      const managed = snapshot?.initialized === true;
      find("casting-stock-content").hidden = !ready;
      panel.dataset.managed = String(managed);
      for (const action of ["history", "start"]) {
        panel.querySelector('[data-casting-action="' + action + '"]').hidden =
          action === "start" ? !ready || managed || !options.canStart() : !managed;
      }
      find("casting-status-filter").hidden = !managed;
      if (!ready) return;
      const link = find("casting-stock-source-link");
      link.href = sourceHref(snapshot.sourceUrl);
      link.hidden = !sourceHref(snapshot.sourceUrl);
      find("casting-stock-source-status").textContent = managed
        ? "HAKOBIでの管理開始日 " + dateLabel(snapshot.initializedAt)
        : "現行の在庫表から表示中。所有者が管理を開始すると、HAKOBIで在庫を記録できます。" +
          (openingOrders().length ? "入荷待ち " + qty(openingOrders().length) + "件を引き継ぎます。" : "");
      find("casting-stock-head").innerHTML = '<tr><th scope="col">品目</th><th scope="col" class="material-number">' + unprocessedLabel +
        '</th><th scope="col" class="material-number">' + processedLabel + '</th><th scope="col">発注残・状態</th>' +
        (managed ? '<th scope="col">操作</th>' : "") + "</tr>";
      renderTable();
    }

    function accept(next) {
      if (!next || !Array.isArray(next.items) || !Array.isArray(next.stock)) throw new Error("在庫の読み込み結果を確認できません。更新してください。");
      if (snapshot?.initialized && (!next.initialized || next.revision <= snapshot.revision)) return;
      if (snapshot && !next.initialized && snapshot.sourceRevision === next.sourceRevision) return;
      snapshot = next;
      stock = new Map();
      for (const entry of next.stock) {
        const balance = key(entry.partId, entry.variant);
        stock.set(balance, (stock.get(balance) ?? 0) + entry.quantity);
      }
      renderPanel();
      if (!saving) updateEntrySummary();
    }

    function refresh({ passive = false } = {}) {
      if (!options.canEdit() || read || saving) return read;
      const attemptGeneration = generation;
      if (!snapshot || !passive) setStatus("casting-stock-status", "鋳物の在庫を読み込み中…", "pending");
      read = options.api.getCastingInventory().then((result) => {
        if (generation !== attemptGeneration || !options.canEdit() || saving) return;
        accept(result);
        readFailed = false;
        setStatus("casting-stock-status", "");
      }).catch((error) => {
        if (generation !== attemptGeneration || !options.canEdit()) return;
        readFailed = true;
        setStatus("casting-stock-status", errorMessage(error), "error");
      }).finally(() => {
        if (generation === attemptGeneration) read = null;
      });
      return read;
    }

    function render() {
      if (!options.canEdit()) return;
      if (!snapshot && !readFailed) void refresh();
      if (snapshot && !snapshot.initialized) {
        panel.querySelector('[data-casting-action="start"]').hidden = !options.canStart();
      }
    }

    function show(title, markup, submitLabel = "", initialFocus = "") {
      find("casting-dialog-title").textContent = title;
      modalContent.innerHTML = markup;
      submit.textContent = submitLabel;
      submit.hidden = !submitLabel;
      submit.disabled = false;
      setStatus("casting-dialog-status", "");
      if (!dialog.open) options.openDialog(dialog, initialFocus);
      else {
        const target = (initialFocus && modalContent.querySelector(initialFocus)) || modalContent.querySelector("input, select, button")
          || form.querySelector("[data-casting-action='close']");
        target.focus({ preventScroll: true });
      }
      dialog._editBaseline = editSnapshot();
    }

    function detail(item, phase) {
      draft = null;
      const variants = rowVariants(item, phase).filter((variant) => variant.id !== "unclassified" || variantTotal(item, variant.id) > 0);
      const body = variants.map((variant) => '<tr><th scope="row">' + escape(phaseLabel(item, variant.id)) + "</th>" +
        numericCell(item.openingUnconfirmed ? null : variantTotal(item, variant.id)) + numericCell(variant.threshold) + "</tr>").join("");
      const orders = itemStatus(item, phase, variants).orders;
      const orderLines = orders.map((order) => '<li><div><strong>発注残 ' + qty(order.remaining ?? order.quantity) +
        "個</strong><small>発注 " + dateLabel(order.date) + " / " + qty(order.quantity) + "個" +
        (order.dueDate ? " / 入荷予定 " + dateLabel(order.dueDate) : "") + "</small>" + (order.note ? "<small>" + escape(order.note) + "</small>" : "") +
        "</div>" + (snapshot.initialized ? '<div class="casting-inline-actions">' +
          button("entry", "この発注を入庫", { partId: item.id, type: "receive", id: order.id, disabled: item.openingUnconfirmed }) +
          button("cancelOrder", "残数を取り消す", { id: order.id }) + "</div>" : "") + "</li>").join("");
      const history = snapshot.history.find((entry) => entry.type === "use" && entry.partId === item.id &&
        (entry.variant === "colored") === Boolean(phase) && !entry.reversed);
      const actions = [];
      if (snapshot.initialized) {
        actions.push(button("entry", "調整", { partId: item.id, type: "count", variant: phase }));
        if (!item.openingUnconfirmed) {
          actions.push(button("entry", "発注点を変更", { partId: item.id, type: "threshold", variant: phase }));
          if (!phase) {
            actions.push(orders.length
              ? button("entry", "追加発注", { partId: item.id, type: "order", slot: "additional" })
              : button("entry", "発注なしで入庫", { partId: item.id, type: "receive", slot: "unplanned" }));
            actions.push(button("entry", labels.sell, { partId: item.id, type: "sell", disabled: variantTotal(item, rawVariant(item)) === 0 }));
          }
        }
        actions.push(button("history", "この品目の履歴", { partId: item.id, variant: phase }));
      }
      const link = phase ? "" : sourceHref(item.legacyUrl);
      show(rowName(item, phase), '<div class="material-table-wrap casting-detail-wrap" tabindex="0" role="region" aria-label="加工区分ごとの在庫">' +
        '<table class="material-table"><thead><tr><th scope="col">加工区分</th><th scope="col" class="material-number">在庫（個）</th>' +
        '<th scope="col" class="material-number">発注点</th></tr></thead><tbody>' + body + "</tbody></table></div>" +
        (actions.length ? '<div class="casting-inline-actions">' + actions.join("") + "</div>" : "") +
        (item.openingUnconfirmed ? '<p class="casting-warning">「調整」で現物の数量を登録してください。</p>' : "") +
        (orderLines ? '<h3>入荷待ち</h3><ul class="casting-event-list">' + orderLines + "</ul>" : "") +
        (history ? "<p>最終使用日 " + dateLabel(history.date) + "</p>" : "") +
        (!phase && item.unitPrice != null ? "<p>現行表の単価 " + qty(item.unitPrice) + "円</p>" : "") +
        (!phase && item.note ? '<p class="casting-note"><strong>現行表の備考</strong><br>' + escape(item.note) + "</p>" : "") +
        (link ? '<a href="' + escape(link) + '" target="_blank" rel="noopener noreferrer">元の在庫表で確認<span class="sr-only">（別タブ）</span></a>' : ""));
    }

    function history(partId, phase) {
      draft = null;
      const entries = snapshot.history.filter((entry) => (!partId || entry.partId === partId) &&
        (!phase || entry.variant === phase || entry.toVariant === phase || entry.changes?.some((change) => change.variant === phase)));
      const lines = entries.map((entry) => {
        const item = partFor(entry.partId);
        const change = (entry.changes || []).map(({ variant, location, before, after }) =>
          escape([variantLabel(item, variant), placeLabels[location] || location].filter(Boolean).join(" ")) + " " + qty(before) +
          " → " + qty(after) + "個").join(" ／ ");
        const allocated = (entry.orderAllocations || []).reduce((sum, order) => sum + order.quantity, 0);
        const target = entry.targetId ? snapshot.history.find((event) => event.id === entry.targetId) : null;
        const heading = (labels[entry.type] || "在庫変更") + (target ? "（" + labels[target.type] + "）" : "");
        return '<li><div><strong>' + escape(heading) + "　" + escape(item && rowName(item, phase || entry.variant)) +
          (entry.quantity != null ? "　" + qty(entry.quantity) + "個" : "") + '</strong><small>' + dateLabel(entry.date) +
          (entry.reversed ? "　取り消し済み" : "") + "</small>" +
          (change ? "<small>" + change + "</small>" : "") +
          (allocated ? "<small>発注残に充当 " + qty(allocated) + "個</small>" : "") +
          (entry.note ? '<small class="casting-note">' + escape(entry.note) + "</small>" : "") +
          "</div>" + (entry.canReverse ? button("reverse", "取り消す", { id: entry.id, name: heading + "の記録を取り消す" }) : "") + "</li>";
      });
      const item = partFor(partId);
      show(item ? rowName(item, phase) + "の履歴" : "鋳物在庫の履歴",
        lines.length ? '<ol class="casting-event-list">' + lines.join("") + "</ol>" : "<p>HAKOBIでの記録はまだありません。</p>");
    }

    function entry(item, type, selection, orderId = "", slot = "") {
      if (!item || !entryTypes.has(type) || (item.openingUnconfirmed && type !== "count")) return;
      const phase = selection === "colored" && ["count", "threshold"].includes(type) ? selection : "";
      const choices = rowVariants(item, phase).filter((variant) => variant.id !== "unclassified");
      const canChoosePhase = ["count", "threshold"].includes(type) && choices.length > 1;
      const variant = type === "use" ? selection : phase || rawVariant(item);
      const destination = type === "process" ? selection : "";
      if (!variantFor(item, variant) || (type === "process" && !processed(item).some(({ id }) => id === destination))) return;
      const linked = orderId && orderFor(orderId);
      if (orderId && (!linked || linked.partId !== item.id)) {
        setStatus("casting-dialog-status", "発注残が更新されました。品目の詳細を開き直してください。", "error");
        return;
      }
      const remainder = linked ? linked.remaining : orderRemainder(pendingOrders(item));
      if (slot === "unplanned" && remainder > 0) {
        setStatus("casting-dialog-status", "発注残が更新されました。一覧で入庫を選び直してください。", "error");
        return;
      }
      if (slot === "procurement" && (type === "order") !== (remainder === 0)) {
        renderTable();
        return;
      }
      const expectedOrderRemainder = linked || ["procurement", "unplanned"].includes(slot) ? remainder : null;
      const current = variantTotal(item, variant);
      const max = consuming.has(type) ? current : type === "receive" && expectedOrderRemainder > 0 ? expectedOrderRemainder : null;
      const today = options.today();
      const numberAttrs = 'inputmode="numeric" step="1"';
      const label = type === "count" ? "調整後の数量（個）" : "数量（個）";
      const note = '<label class="field casting-note-field"><span>備考（任意）</span><textarea name="note" maxlength="500" rows="2"></textarea></label>';

      let markup = '<p id="casting-entry-summary" class="casting-entry-summary" role="status"></p>';
      if (canChoosePhase) {
        markup += select(type === "count" ? "調整する在庫" : "対象の在庫", "variant",
          choices.map(({ id }) => [id, phaseLabel(item, id)]), variant);
      }
      if (type === "threshold") {
        markup += input("発注点（個）", "threshold", "number", variantFor(item, variant)?.threshold ?? "", numberAttrs + ' min="0"');
      } else {
        if (type !== "count") {
          markup += '<fieldset class="casting-presets"><legend>数量を選ぶ</legend>' + presets.map((value) =>
            '<button type="button" class="button button-secondary" data-casting-action="preset" data-quantity="' + value +
            '" aria-pressed="false"' + (max != null && value > max ? " disabled" : "") + ">" + value + "個</button>").join("") + "</fieldset>";
        }
        markup += input(label, "quantity", "number", "", numberAttrs + ' required min="' + (type === "count" ? "0" : "1") +
          '"' + (max == null ? "" : ' max="' + max + '"'));
        if (type === "count") markup += note;
        else {
          markup += '<details class="casting-entry-options"><summary>日付・備考</summary><div class="form-grid">' +
            input(type === "order" ? "発注日" : "日付", "date", "date", today, "required") +
            (type === "order" ? input("入荷予定日（任意）", "dueDate", "date", "") : "") + note + "</div></details>";
        }
      }
      draft = {
        type, mode: "entry", partId: item.id, variant, destination, orderId, date: today, expectedOrderRemainder,
        expectedQuantity: type === "count" ? current : null,
      };
      const suffix = destination && variantSuffix(item, destination);
      const actionLabel = slot === "additional" ? "追加発注" : slot === "unplanned" ? "発注なしで入庫" : labels[type];
      const title = rowName(item, variant) + "・" + actionLabel + (suffix ? "（" + suffix + "）" : "");
      const focus = canChoosePhase ? '[name="variant"]'
        : root.matchMedia?.("(pointer: coarse)")?.matches && type !== "count" && type !== "threshold"
          ? '[data-casting-action="preset"]:not(:disabled)' : "";
      show(title, markup, submitLabels[type], focus);
      updateEntrySummary();
    }

    function balanceText(label, current, after) {
      return label + " " + qty(current) + (Number.isSafeInteger(after) && after >= 0 && after !== current ? " → " + qty(after) : "") + "個";
    }

    function updateEntrySummary() {
      const summary = find("casting-entry-summary");
      if (!summary || draft?.mode !== "entry") return;
      const item = partFor(draft.partId);
      const { type, variant, destination, orderId, expectedQuantity, expectedOrderRemainder } = draft;
      const quantityField = field("quantity");
      const quantity = quantityField?.validity.valid ? quantityField.valueAsNumber : NaN;
      for (const preset of modalContent.querySelectorAll('[data-casting-action="preset"]')) {
        preset.setAttribute("aria-pressed", String(Number(preset.dataset.quantity) === quantity));
      }
      const changes = [];
      if (Number.isSafeInteger(quantity) && type !== "count") changes.push("選択した数量 " + qty(quantity) + "個");
      if (type === "threshold") {
        changes.push("未入力で発注点を解除します。");
      } else if (type === "order" || type === "receive") {
        const remainder = orderId ? orderFor(orderId)?.remaining ?? 0 : orderRemainder(pendingOrders(item));
        if (expectedOrderRemainder != null && remainder !== expectedOrderRemainder) {
          changes.push("発注残が " + qty(remainder) + "個に更新されました。操作を選び直してください。");
          summary.textContent = changes.join(" ／ ");
          return;
        }
        changes.push(balanceText("発注残", remainder, type === "order" ? remainder + quantity : Math.max(0, remainder - quantity)));
        if (type === "receive") {
          const current = variantTotal(item, variant);
          changes.push(balanceText(phaseLabel(item, variant), current, current + quantity));
        }
      } else {
        const current = type === "count" ? expectedQuantity : variantTotal(item, variant);
        if (item.openingUnconfirmed) {
          changes.push(phaseLabel(item, variant) + " 数量未登録" + (Number.isSafeInteger(quantity) ? " → " + qty(quantity) + "個" : ""));
        } else {
          changes.push(balanceText(phaseLabel(item, variant), current, type === "count" ? quantity : current - quantity));
        }
        if (destination) {
          const completed = variantTotal(item, destination);
          changes.push(balanceText(phaseLabel(item, destination), completed, completed + quantity));
        }
      }
      summary.textContent = changes.join(" ／ ");
    }

    function showConfirmation(type, id = "") {
      draft = { mode: "confirm", type, id };
      if (type === "start") {
        if (!options.canStart() || snapshot.initialized) return;
        draft.sourceRevision = snapshot.sourceRevision;
        const total = snapshot.stock.reduce((sum, entry) => sum + entry.quantity, 0);
        const orders = openingOrders().map((order) => "<li>" + escape(partFor(order.partId)?.name) + " " + qty(order.quantity) +
          "個（入荷予定 " + dateLabel(order.dueDate) + "）</li>").join("");
        show("HAKOBIで鋳物在庫を管理する",
          "<p>現行表の " + qty(total) + "個を開始在庫として取り込みます。以後の鋳物在庫はHAKOBIで記録してください。</p>" +
          "<p>未加工の在庫は1階、加工済の在庫は2階にまとめて取り込みます。</p>" +
          (orders ? "<h3>引き継ぐ入荷待ち</h3><ul>" + orders + "</ul>" : ""),
          "開始在庫を取り込む");
      } else if (type === "cancelOrder") {
        const order = orderFor(id);
        if (!order) return;
        show("発注残を取り消す", "<p>" + escape(partFor(order.partId)?.name) + "の発注残 " + qty(order.remaining) +
          "個を取り消す記録を残します。</p>", submitLabels[type]);
      } else {
        const event = snapshot.history.find((entry) => entry.id === id && entry.canReverse);
        if (!event) return;
        show("在庫の記録を取り消す", "<p>" + escape(partFor(event.partId)?.name) + "の「" + escape(labels[event.type]) +
          "」を戻し、取り消した履歴を残します。</p>", submitLabels[type]);
      }
    }

    function editSnapshot() {
      return draft?.mode === "entry" ? JSON.stringify([...new FormData(form)]) : null;
    }

    async function save(event) {
      event.preventDefault();
      if (!draft || saving || !options.canEdit()) return;
      const { type } = draft;
      const isStart = type === "start";
      if (isStart && !options.canStart()) return;
      let request = { type, date: options.today() };
      if (draft.mode === "entry") {
        const fields = Object.fromEntries(new FormData(form));
        request = {
          ...request, date: fields.date || draft.date, note: fields.note || "",
          partId: draft.partId, variant: draft.variant,
        };
        if (draft.destination) request.toVariant = draft.destination;
        if (draft.orderId) request.orderId = draft.orderId;
        if (fields.dueDate) request.dueDate = fields.dueDate;
        if (draft.expectedOrderRemainder != null) request.expectedOrderRemainder = draft.expectedOrderRemainder;
        if (type === "threshold") request.threshold = fields.threshold === "" ? null : Number(fields.threshold);
        else request.quantity = Number(fields.quantity);
        if (type === "count") request.expectedQuantity = draft.expectedQuantity;
      } else if (type === "cancelOrder") request.orderId = draft.id;
      else if (type === "reverse") request.targetId = draft.id;

      const fingerprint = JSON.stringify(request);
      if (!isStart && !attempts.has(fingerprint)) {
        if (attempts.size >= 20) attempts.delete(attempts.keys().next().value);
        attempts.set(fingerprint, root.crypto.randomUUID());
      }
      saving = true;
      const attemptGeneration = ++generation;
      read = null;
      submit.disabled = true;
      submit.dataset.state = "loading";
      setStatus("casting-dialog-status", "保存中…", "pending");
      const controls = [...modalContent.querySelectorAll("button, input, select, textarea")].filter((control) => !control.disabled);
      controls.forEach((control) => { control.disabled = true; });
      try {
        const result = isStart ? await options.api.startCastingInventory({ sourceRevision: draft.sourceRevision })
          : await options.api.saveCastingInventoryChange({ ...request, opId: attempts.get(fingerprint) });
        if (generation !== attemptGeneration || !options.canEdit()) return;
        accept(result);
        attempts.delete(fingerprint);
        const success = type === "cancelOrder" ? "発注残を取り消しました。" : type === "reverse" ? "記録を取り消しました。"
          : isStart ? "鋳物在庫の管理を開始しました。" : submitLabels[type] + "しました。";
        setStatus("casting-stock-status", success, "success");
        options.closeDialog(dialog, { force: true });
        draft = null;
      } catch (error) {
        if (generation === attemptGeneration && options.canEdit()) {
          setStatus("casting-dialog-status", errorMessage(error), "error");
        }
      } finally {
        if (generation === attemptGeneration) {
          saving = false;
          submit.disabled = false;
          delete submit.dataset.state;
          controls.forEach((control) => { control.disabled = false; });
        }
      }
    }

    function click(event) {
      const target = event.target.closest("[data-casting-action]");
      if (!target || !options.canEdit() || saving) return;
      const { castingAction: action, partId, entryType, entryId, variant, castingSlot } = target.dataset;
      if (action === "refresh") { void refresh(); return; }
      if (action === "close") { options.closeDialog(dialog); return; }
      if (!snapshot) return;
      const item = partFor(partId);
      if (action === "details" && item) detail(item, variant);
      else if (action === "start") showConfirmation(action);
      else if (snapshot.initialized) {
        if (action === "entry") entry(item, entryType, variant, entryId, castingSlot);
        else if (action === "history") history(partId, variant);
        else if (["reverse", "cancelOrder"].includes(action)) showConfirmation(action, entryId);
        else if (action === "preset") {
          field("quantity").value = target.dataset.quantity;
          updateEntrySummary();
        }
      }
    }

    panel.addEventListener("click", click);
    dialog.addEventListener("click", click);
    dialog.addEventListener("close", () => { draft = null; });
    form.addEventListener("submit", save);
    form.addEventListener("invalid", (event) => {
      const details = event.target.closest("details");
      if (details) details.open = true;
    }, true);
    form.addEventListener("input", updateEntrySummary);
    form.addEventListener("change", (event) => {
      if (draft?.mode !== "entry" || event.target.name !== "variant") return;
      const item = partFor(draft.partId);
      draft.variant = event.target.value;
      if (draft.type === "count") draft.expectedQuantity = variantTotal(item, draft.variant);
      if (draft.type === "threshold") field("threshold").value = variantFor(item, draft.variant)?.threshold ?? "";
      updateEntrySummary();
    });
    find("casting-search").addEventListener("input", renderTable);
    statusFilter.addEventListener("change", renderTable);

    return {
      render, refresh, editSnapshot, isSaving: () => saving,
      clear() {
        generation += 1;
        snapshot = null;
        stock.clear();
        read = null;
        readFailed = false;
        saving = false;
        draft = null;
        attempts.clear();
        delete submit.dataset.state;
        dialog._editBaseline = null;
        modalContent.replaceChildren();
        find("casting-stock-rows").replaceChildren();
        find("casting-stock-source-status").textContent = "";
        find("casting-stock-source-link").removeAttribute("href");
        setStatus("casting-stock-status", "");
        if (dialog.open) options.closeDialog(dialog, { force: true });
        renderPanel();
      },
    };
  }

  root.CastingStockUI = { create };
})(globalThis);
