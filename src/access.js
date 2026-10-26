(() => {
  "use strict";

  const emailInput = document.getElementById("email");
  const codeInput = document.getElementById("code");
  const requestForm = document.getElementById("request-form");
  const verifyForm = document.getElementById("verify-form");
  const requestButton = document.getElementById("request-code");
  const verifyButton = document.getElementById("verify-code");
  const status = document.getElementById("access-status");
  const openApp = document.getElementById("open-app");
  const retryAccess = document.getElementById("retry-access");
  const title = document.getElementById("access-title");
  const intro = document.getElementById("access-intro");
  const RESEND_WAIT_MS = 60_000;
  let resendAllowedAt = 0;
  let resendTimer = null;
  let requestBusy = false;
  let verifyBusy = false;
  let verified = false;
  let restoring = false;

  function showStatus(message, tone = "") {
    status.textContent = message;
    status.setAttribute("role", tone === "error" ? "alert" : "status");
    status.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  function remainingSeconds() {
    return Math.max(0, Math.ceil((resendAllowedAt - Date.now()) / 1000));
  }

  function updateControls() {
    const busy = requestBusy || verifyBusy || restoring;
    emailInput.disabled = busy || verified;
    verifyButton.disabled = busy || verified;
    verifyButton.textContent = verifyBusy ? "確認中…" : "確認する";
    if (retryAccess) retryAccess.disabled = busy;
    const remaining = remainingSeconds();
    requestButton.disabled = busy || remaining > 0 || verified;
    requestButton.textContent = requestBusy
      ? "送信中…"
      : remaining > 0 ? `再送信まで ${remaining} 秒` : "確認コードを送信";
    if (remaining === 0 && resendTimer !== null) {
      window.clearInterval(resendTimer);
      resendTimer = null;
    }
  }

  function updateResendButton() {
    updateControls();
  }

  function startResendWait() {
    resendAllowedAt = Date.now() + RESEND_WAIT_MS;
    if (resendTimer !== null) window.clearInterval(resendTimer);
    resendTimer = window.setInterval(updateResendButton, 250);
    updateControls();
  }

  function serverCall(method, payload) {
    return new Promise((resolve, reject) => {
      const runner = window.google?.script?.run;
      if (!runner) {
        reject(new Error("service-unavailable"));
        return;
      }
      runner.withSuccessHandler(resolve).withFailureHandler(() => reject(new Error("service-unavailable")))[method](payload);
    });
  }

  requestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!emailInput.reportValidity()) return;
    if (requestBusy || verifyBusy || restoring || verified || remainingSeconds() > 0) return;
    const payload = { email: emailInput.value.trim() };
    requestBusy = true;
    updateControls();
    showStatus("送信しています…");
    try {
      await serverCall("requestAccessCode", payload);
      showStatus("入力したアドレスが対象の場合、確認コードを送信しました。", "success");
      startResendWait();
    } catch {
      showStatus("確認コードを送信できませんでした。時間をおいてからもう一度お試しください。", "error");
    } finally {
      requestBusy = false;
      updateControls();
    }
  });

  verifyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!emailInput.reportValidity() || !codeInput.reportValidity()) return;
    if (requestBusy || verifyBusy || restoring || verified) return;
    if (!/^\d{8}$/.test(codeInput.value.trim())) {
      codeInput.setCustomValidity("8桁の数字を入力してください。");
      codeInput.reportValidity();
      codeInput.setCustomValidity("");
      return;
    }
    const payload = { email: emailInput.value.trim(), code: codeInput.value.trim(), openApp: true };
    verifyBusy = true;
    updateControls();
    showStatus("確認しています…");
    try {
      const result = await serverCall("verifyAccessCode", payload);
      if (!result?.ok) throw new Error("verification-failed");
      const remembered = !result.deviceToken || window.AppAccessSession?.save(result.deviceToken);
      verified = true;
      verifyForm.hidden = true;
      requestForm.hidden = true;
      showStatus(remembered ? "確認が完了しました。アプリを開けます。" : "本人確認は完了しました。このブラウザーでは本人確認を保存できないため、ブラウザーの保存設定を確認してください。", "success");
      if (result.appHtml && window.ProductionAppBootstrap) {
        try {
          await window.ProductionAppBootstrap.open(result.appHtml);
          return;
        } catch { /* Keep the normal application link available if loading fails. */ }
      }
      openApp.hidden = false;
      openApp.focus();
    } catch {
      showStatus("確認できませんでした。コードとメールアドレスを確認して、もう一度お試しください。", "error");
    } finally {
      verifyBusy = false;
      updateControls();
    }
  });

  emailInput.addEventListener("input", () => {
    if (!verified) showStatus("");
  });
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 8);
    if (!verified) showStatus("");
  });

  async function restoreRememberedAccess() {
    if (restoring || !window.AppAccessSession?.hasCredential()) return;
    restoring = true;
    requestForm.hidden = true;
    verifyForm.hidden = true;
    if (retryAccess) retryAccess.hidden = true;
    if (title) title.textContent = "ロード中…";
    if (intro) intro.hidden = true;
    updateControls();
    showStatus("保存済みの本人確認で接続しています…");
    try {
      const result = await window.AppAccessSession.restore({ openApp: true });
      if (!result?.ok) {
        requestForm.hidden = false;
        verifyForm.hidden = false;
        if (title) title.textContent = "利用アカウントの確認";
        if (intro) intro.hidden = false;
        showStatus("");
        return;
      }
      if (result.appHtml && window.ProductionAppBootstrap) {
        await window.ProductionAppBootstrap.open(result.appHtml);
        return;
      }
      verified = true;
      showStatus("本人確認を復元しました。アプリを開けます。", "success");
      openApp.hidden = false;
      openApp.focus();
    } catch {
      showStatus("接続できませんでした。通信状態を確認して、もう一度お試しください。", "error");
      if (retryAccess) retryAccess.hidden = false;
    } finally {
      restoring = false;
      updateControls();
    }
  }

  retryAccess?.addEventListener("click", () => { void restoreRememberedAccess(); });
  void restoreRememberedAccess();
})();
