(() => {
  "use strict";

  const STORAGE_KEY = "production-board-remembered-access-v1";
  const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
  let rememberInFlight = null;
  let rememberedResult = null;
  const restoreInFlight = new Map();

  function storage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function readToken() {
    try {
      const value = storage()?.getItem(STORAGE_KEY) || "";
      return TOKEN_PATTERN.test(value) ? value : "";
    } catch {
      return "";
    }
  }

  function save(token) {
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
    try {
      const target = storage();
      if (!target) return false;
      target.setItem(STORAGE_KEY, token);
      return true;
    } catch {
      return false;
    }
  }

  function clear() {
    try {
      storage()?.removeItem(STORAGE_KEY);
    } catch {
      // Storage can be disabled by browser policy; the caller can still continue.
    }
  }

  function hasCredential() {
    return Boolean(readToken());
  }

  function call(method, payload) {
    return new Promise((resolve, reject) => {
      const runner = window.google?.script?.run;
      if (!runner || typeof runner.withSuccessHandler !== "function" || typeof runner.withFailureHandler !== "function" || typeof runner[method] !== "function") {
        reject(new Error("service-unavailable"));
        return;
      }
      try {
        runner.withSuccessHandler(resolve).withFailureHandler(() => reject(new Error("service-unavailable")))[method](payload);
      } catch {
        reject(new Error("service-unavailable"));
      }
    });
  }

  function remember() {
    if (rememberedResult) return Promise.resolve(rememberedResult);
    if (rememberInFlight) return rememberInFlight;

    const priorToken = readToken();
    const operation = call("rememberAccessDevice", { deviceToken: priorToken }).then((result) => {
      const token = result && typeof result.deviceToken === "string" ? result.deviceToken : "";
      const saved = token ? save(token) : Boolean(priorToken);
      if (token && !saved) {
        return { ...result, remembered: false, storageUnavailable: true };
      }
      if (result?.remembered === true && !saved) {
        return { ...result, remembered: false, storageUnavailable: true };
      }
      if (result?.remembered === true) rememberedResult = result;
      return result;
    });
    rememberInFlight = operation;
    const clearFlight = () => {
      if (rememberInFlight === operation) rememberInFlight = null;
    };
    operation.then(clearFlight, clearFlight);
    return operation;
  }

  function restore({ openApp = false } = {}) {
    const shouldOpenApp = openApp === true;
    if (restoreInFlight.has(shouldOpenApp)) return restoreInFlight.get(shouldOpenApp);

    const deviceToken = readToken();
    if (!deviceToken) return Promise.resolve({ ok: false });

    const operation = call("restoreAccessSession", { deviceToken, openApp: shouldOpenApp }).then((result) => {
      if (result?.ok === false) clear();
      return result;
    });
    restoreInFlight.set(shouldOpenApp, operation);
    const clearFlight = () => {
      if (restoreInFlight.get(shouldOpenApp) === operation) restoreInFlight.delete(shouldOpenApp);
    };
    operation.then(clearFlight, clearFlight);
    return operation;
  }

  globalThis.AppAccessSession = { save, clear, hasCredential, remember, restore };
})();
