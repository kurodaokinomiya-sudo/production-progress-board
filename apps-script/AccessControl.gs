// Access configuration is kept in Script Properties, separate from editable
// workbook settings. The deploying account remains the implicit owner.
var ACCESS_CONFIG_KEY = "APP_ACCESS_CONFIG_V1";
var ACCESS_CHALLENGE_PREFIX = "APP_ACCESS_CHALLENGE_";
var ACCESS_MAIL_CODE_PREFIX = "APP_ACCESS_MAIL_CODE_";
var ACCESS_GRANT_PREFIX = "APP_ACCESS_GRANT_";
var ACCESS_DEVICE_PREFIX = "APP_ACCESS_DEVICE_";
var ACCESS_RATE_PREFIX = "APP_ACCESS_RATE_";
var ACCESS_DEFAULT_EMAILS = ["minnanookinomiyaika@gmail.com"];
var ACCESS_SESSION_DAYS = 7;
var ACCESS_DEVICE_DAYS = 90;
var ACCESS_MAIL_CODE_WINDOW_MS = 86400000;
var ACCESS_MAIL_CODE_SEND_LIMIT = 2;
var ACCESS_MAIL_CODE_RETRY_MS = 60000;

function readAccessContext_() {
  try {
    var activeEmail = accessNormalizeEmail_(Session.getActiveUser().getEmail());
    var ownerEmail = accessNormalizeEmail_(Session.getEffectiveUser().getEmail());
    if (!ownerEmail) return null;
    if (activeEmail && activeEmail === ownerEmail) return accessContext_(activeEmail, "owner", true);
    if (activeEmail) return accessContextForAllowlisted_(activeEmail, true);
    var sessionHash = accessSessionHash_();
    if (!sessionHash) return null;
    var grant = accessReadJson_(ACCESS_GRANT_PREFIX + sessionHash);
    var expiry = grant && grant.expiresAt;
    if (!grant || typeof grant.email !== "string" || !accessValidEmail_(grant.email) || grant.email !== accessNormalizeEmail_(grant.email) || grant.email === ownerEmail || !Number.isFinite(expiry) || Math.floor(expiry) !== expiry || expiry <= Date.now() || expiry > Date.now() + ACCESS_SESSION_DAYS * 86400000) return null;
    if (grant.deviceHash !== undefined) {
      var device = accessReadDevice_(grant.deviceHash);
      if (!device || device.email !== grant.email) return null;
    }
    return accessContextForAllowlisted_(grant.email, false);
  } catch (error) {
    return null;
  }
}

function accessContext_(email, role, directGoogleIdentity) {
  if (["owner", "admin", "editor", "worker", "viewer"].indexOf(role) < 0) return null;
  var isOwner = role === "owner";
  var isAdmin = isOwner || role === "admin";
  return { email: email, role: role, isOwner: isOwner, isAdmin: isAdmin, canEdit: isAdmin || role === "editor", canWork: isAdmin || role === "editor" || role === "worker", directGoogleIdentity: directGoogleIdentity === true };
}

function accessContextForAllowlisted_(email, directGoogleIdentity) {
  var user = accessConfig_().users.filter(function(item) { return item.email === email; })[0];
  return user ? accessContext_(email, user.role, directGoogleIdentity) : null;
}

function requireAppAccess_() {
  var context = readAccessContext_();
  if (!context) throw new Error("ACCESS_DENIED: このGoogleアカウントには利用権限がありません。");
  return context;
}

function requireAdminAccess_() {
  var context = requireAppAccess_();
  if (!context.isAdmin) throw new Error("ADMIN_REQUIRED: 管理者だけが実行できます。");
  return context;
}

function requireEditorAccess_() {
  var context = requireAppAccess_();
  if (!context.canEdit) throw new Error("EDITOR_REQUIRED: 編集権限が必要です。");
  return context;
}

function requireWorkerAccess_() {
  var context = requireAppAccess_();
  if (!context.canWork) throw new Error("WORKER_REQUIRED: 作業権限が必要です。");
  return context;
}

function requireOwnerAccess_() {
  var context = requireAppAccess_();
  var ownerEmail = accessNormalizeEmail_(Session.getEffectiveUser().getEmail());
  if (!context.isOwner || context.email !== ownerEmail || context.directGoogleIdentity !== true) throw new Error("OWNER_REQUIRED: 所有者だけが実行できます。");
  return context;
}

function requestAccessCode(input) {
  var email = accessNormalizeEmail_(input && input.email);
  try {
    if (!accessSessionHash_() || !accessEmailCodeEligible_(email)) return { ok: true };
    var key = ACCESS_MAIL_CODE_PREFIX + accessHash_(email);
    var delivery = accessWithLock_(function() {
      if (!accessEmailCodeEligible_(email)) return null;
      var now = Date.now();
      var state = accessReadJson_(key);
      // A delivery requested by another browser remains usable by the mailbox
      // holder. Preserve it through the entire period charged to the recipient.
      if (state && (state.expiresAt > now || state.retryAt > now)) return null;
      var sent = accessRecentDeliveries_(state, now);
      if (sent.length >= ACCESS_MAIL_CODE_SEND_LIMIT) return null;
      var code = Utilities.getUuid().replace(/-/g, "").toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(code)) throw new Error("確認コードを作成できませんでした。");
      var codeHash = accessHash_(code);
      accessWriteJson_(key, { email: email, codeHash: codeHash, expiresAt: now + ACCESS_MAIL_CODE_WINDOW_MS, sent: sent.concat(now) });
      return { code: code, codeHash: codeHash, previousDeliveries: sent };
    });
    if (delivery) {
      try {
        MailApp.sendEmail(email, "HAKOBI｜生産工程管理 確認コード", "確認画面に次のコードを貼り付けてください。\n\n" + delivery.code + "\n\nこのコードは24時間以内に1回だけ使えます。心当たりがない場合は、このメールを無視してください。");
      } catch (error) {
        accessWithLock_(function() {
          var current = accessReadJson_(key);
          if (current && current.codeHash === delivery.codeHash) {
            accessWriteJson_(key, { email: email, sent: delivery.previousDeliveries, retryAt: Date.now() + ACCESS_MAIL_CODE_RETRY_MS });
          }
        });
        throw error;
      }
    }
  } catch (error) {
    console.warn("Access code delivery could not be completed.");
  }
  return { ok: true };
}

function accessEmailCodeEligible_(email) {
  var ownerEmail = accessNormalizeEmail_(Session.getEffectiveUser().getEmail());
  if (!ownerEmail || !accessValidEmail_(email) || email === ownerEmail) return false;
  var activeEmail = accessNormalizeEmail_(Session.getActiveUser().getEmail());
  return (!activeEmail || activeEmail === email) && !!accessContextForAllowlisted_(email, false);
}

function accessRecentDeliveries_(state, now) {
  return (state && Array.isArray(state.sent) ? state.sent : []).filter(function(time) {
    return Number.isFinite(time) && time <= now && now - time < ACCESS_MAIL_CODE_WINDOW_MS;
  });
}

function verifyAccessCode(input) {
  var email = accessNormalizeEmail_(input && input.email);
  var code = input && input.code !== undefined ? String(input.code).trim().toLowerCase() : "";
  var legacy = /^\d{8}$/.test(code);
  if ((!legacy && !/^[a-f0-9]{32}$/.test(code)) || !accessEmailCodeEligible_(email)) {
    throw new Error("確認コードが無効か、期限切れです。");
  }
  var sessionHash = accessSessionHash_();
  if (!sessionHash) throw new Error("確認コードが無効か、期限切れです。");
  var key = legacy ? ACCESS_CHALLENGE_PREFIX + sessionHash : ACCESS_MAIL_CODE_PREFIX + accessHash_(email);
  var digest = legacy ? "" : accessHash_(code);
  // Most invalid requests do not need the shared write lock. A correct code
  // is checked again inside the lock before it can be consumed.
  var pending = accessReadJson_(key);
  if (!accessCurrentCode_(pending, email, Date.now()) || (!legacy && !accessConstantTimeEqual_(pending.codeHash, digest))) {
    throw new Error("確認コードが無効か、期限切れです。");
  }
  var result = accessWithLock_(function() {
    var now = Date.now();
    if (!accessEmailCodeEligible_(email)) throw new Error("確認コードが無効か、期限切れです。");
    var challenge = accessReadJson_(key);
    if (!accessCurrentCode_(challenge, email, now)) {
      throw new Error("確認コードが無効か、期限切れです。");
    }
    var expectedDigest = legacy ? accessHash_(challenge.nonce + ":" + code) : digest;
    if (!accessConstantTimeEqual_(challenge.codeHash, expectedDigest)) {
      if (legacy) {
        challenge.attempts = Number(challenge.attempts || 0) + 1;
        if (challenge.attempts >= 5) accessDelete_(key);
        else accessWriteJson_(key, challenge);
      }
      throw new Error("確認コードが無効か、期限切れです。");
    }
    accessCleanup_(now);
    var deviceToken = accessCreateDevice_(email);
    if (legacy) accessDelete_(key);
    else accessWriteJson_(key, { email: email, sent: accessRecentDeliveries_(challenge, now) });
    var grant = { email: email, expiresAt: now + ACCESS_SESSION_DAYS * 86400000, deviceHash: accessHash_(deviceToken) };
    accessWriteJson_(ACCESS_GRANT_PREFIX + sessionHash, grant);
    return { ok: true, deviceToken: deviceToken, remembered: true };
  });
  return accessAppResponse_(result, input);
}

function accessCurrentCode_(record, email, now) {
  return !!(record && record.email === email && typeof record.codeHash === "string" &&
    Number.isSafeInteger(record.expiresAt) && record.expiresAt > now);
}

// A remembered browser can renew the short Google-session binding without
// another email. Only the credential hash is kept on the server; roles always
// come from the live allowlist. Removing an account revokes its credentials.
function rememberAccessDevice(input) {
  requireAppAccess_();
  return accessWithLock_(function() {
    var context = requireAppAccess_();
    if (context.isOwner) return { ok: true, remembered: false };
    var token = input && input.deviceToken;
    var device = accessValidDeviceToken_(token) ? accessReadDevice_(accessHash_(token)) : null;
    if (device && device.email === context.email) return { ok: true, remembered: true };
    return { ok: true, remembered: true, deviceToken: accessCreateDevice_(context.email) };
  });
}

function restoreAccessSession(input) {
  var token = input && input.deviceToken;
  if (!accessValidDeviceToken_(token)) return { ok: false };
  var sessionHash = accessSessionHash_();
  if (!sessionHash) return { ok: false };
  var result = accessWithLock_(function() {
    var hash = accessHash_(token);
    var device = accessReadDevice_(hash);
    var activeEmail = accessNormalizeEmail_(Session.getActiveUser().getEmail());
    var ownerEmail = accessNormalizeEmail_(Session.getEffectiveUser().getEmail());
    if (!device || !ownerEmail || device.email === ownerEmail || (activeEmail && activeEmail !== device.email) || !accessContextForAllowlisted_(device.email, false)) return { ok: false };
    var now = Date.now();
    accessCleanup_(now);
    accessWriteJson_(ACCESS_GRANT_PREFIX + sessionHash, { email: device.email, expiresAt: Math.min(now + ACCESS_SESSION_DAYS * 86400000, accessDeviceExpiry_(device)), deviceHash: hash });
    return { ok: true };
  });
  return accessAppResponse_(result, input);
}

function accessAppResponse_(result, input) {
  if (result.ok && input && input.openApp === true) {
    requireAppAccess_();
    result.appHtml = HtmlService.createHtmlOutputFromFile("Index").getContent();
  }
  return result;
}

function accessValidDeviceToken_(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function accessReadDevice_(hash) {
  if (typeof hash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(hash)) return null;
  var raw = PropertiesService.getScriptProperties().getProperty(ACCESS_DEVICE_PREFIX + hash);
  if (!raw) return null;
  var device;
  try { device = JSON.parse(raw); } catch (error) { return null; }
  var now = Date.now();
  if (!device || device.version !== 1 || !accessValidEmail_(device.email) || device.email !== accessNormalizeEmail_(device.email) || !Number.isSafeInteger(device.createdAt) || device.createdAt <= 0 || device.createdAt > now || accessDeviceExpiry_(device) <= now) return null;
  return device;
}

function accessDeviceExpiry_(device) {
  return device.createdAt + ACCESS_DEVICE_DAYS * 86400000;
}

function accessCreateDevice_(email) {
  // Bound property usage even when a browser repeatedly loses its local data.
  var properties = PropertiesService.getScriptProperties().getProperties();
  var devices = Object.keys(properties).filter(function(key) { return key.indexOf(ACCESS_DEVICE_PREFIX) === 0; }).map(function(key) {
    var device;
    try { device = JSON.parse(properties[key]); } catch (error) { return null; }
    return device && device.email === email ? { key: key, createdAt: Number(device.createdAt) || 0 } : null;
  }).filter(function(device) { return device !== null; }).sort(function(a, b) { return a.createdAt - b.createdAt; });
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "").toLowerCase();
  if (!accessValidDeviceToken_(token)) throw new Error("端末の本人確認を保存できませんでした。");
  accessWriteJson_(ACCESS_DEVICE_PREFIX + accessHash_(token), { version: 1, email: email, createdAt: Date.now() });
  while (devices.length >= 20) accessDelete_(devices.shift().key);
  return token;
}

function accessRevokeRemovedUsers_(before, after) {
  var removed = before.filter(function(user) { return !after.some(function(next) { return next.email === user.email; }); }).map(function(user) { return user.email; });
  accessRevokeCredentials_(removed, true);
}

function accessRevokeCredentials_(emails, includeCodes) {
  if (!emails.length) return;
  var prefixes = [ACCESS_DEVICE_PREFIX, ACCESS_GRANT_PREFIX];
  if (includeCodes) prefixes.push(ACCESS_CHALLENGE_PREFIX, ACCESS_MAIL_CODE_PREFIX);
  var properties = PropertiesService.getScriptProperties().getProperties();
  Object.keys(properties).forEach(function(key) {
    if (!prefixes.some(function(prefix) { return key.indexOf(prefix) === 0; })) return;
    var record;
    try { record = JSON.parse(properties[key]); } catch (error) { return; }
    if (record && emails.indexOf(record.email) >= 0) accessDelete_(key);
  });
}

function revokeRememberedAccess(input) {
  requireAdminAccess_();
  var email = accessNormalizeEmail_(input && input.email);
  return accessWithLock_(function() {
    requireAdminAccess_();
    if (!accessValidEmail_(email) || !accessContextForAllowlisted_(email, false)) throw new Error("保存済みの利用アカウントを指定してください。");
    accessRevokeCredentials_([email], false);
    return { ok: true };
  });
}

function getAccessSettings() {
  var context = requireAdminAccess_();
  var config = accessConfig_();
  var readiness = accessMailReadiness_();
  return { users: config.users.map(function(user) { return { email: user.email, role: user.role }; }), emails: config.users.map(function(user) { return user.email; }), version: config.version, adminEmail: accessNormalizeEmail_(Session.getEffectiveUser().getEmail()), currentEmail: context.email, isAdmin: true, emailVerificationReady: readiness.ready, emailVerificationMessage: readiness.message, emailAuthorizationUrl: context.isOwner && !readiness.ready ? accessEmailAuthorizationUrl_() : "" };
}

function saveAccessSettings(input) {
  var caller = requireAdminAccess_();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("利用者設定が不正です。");
  if (!Number.isInteger(input.version) || (!Array.isArray(input.users) && !Array.isArray(input.emails))) throw new Error("利用者設定の形式が不正です。");
  return accessWithLock_(function() {
    caller = requireAdminAccess_();
    var current = accessConfig_();
    if (input.version !== current.version) throw new Error("利用者設定が別の端末で更新されています。画面を更新してください。");
    var ownerEmail = accessNormalizeEmail_(Session.getEffectiveUser().getEmail());
    var sourceUsers = input.users;
    var normalized = [];
    if (Array.isArray(sourceUsers)) {
      if (sourceUsers.length > 50) throw new Error("利用者は50件以内で指定してください。");
      sourceUsers.forEach(function(value) {
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.email !== "string") throw new Error("利用者設定の形式が不正です。");
        var email = accessNormalizeEmail_(value.email);
        if (!accessValidEmail_(email)) throw new Error("メールアドレスの形式が不正です。");
        if (["admin", "editor", "worker", "viewer"].indexOf(value.role) < 0) throw new Error("利用者の権限が不正です。");
        if (email === ownerEmail) return;
        if (normalized.some(function(user) { return user.email === email; })) return;
        normalized.push({ email: email, role: value.role });
      });
    } else {
      if (input.emails.length > 50) throw new Error("利用者は50件以内で指定してください。");
      input.emails.forEach(function(value) {
        if (typeof value !== "string") throw new Error("メールアドレスは文字列で指定してください。");
        var email = accessNormalizeEmail_(value);
        if (!accessValidEmail_(email)) throw new Error("メールアドレスの形式が不正です。");
        if (email === ownerEmail || normalized.some(function(user) { return user.email === email; })) return;
        var prior = current.users.filter(function(user) { return user.email === email; })[0];
        normalized.push({ email: email, role: prior ? prior.role : "editor" });
      });
    }
    if (caller.email !== ownerEmail) {
      var previousCaller = current.users.filter(function(user) { return user.email === caller.email; })[0];
      var nextCaller = normalized.filter(function(user) { return user.email === caller.email; })[0];
      if (!previousCaller || previousCaller.role !== "admin" || !nextCaller || nextCaller.role !== "admin") throw new Error("自分自身の管理者権限は変更できません。");
    }
    var saved = { version: current.version + 1, users: normalized };
    accessRevokeRemovedUsers_(current.users, normalized);
    accessWriteJson_(ACCESS_CONFIG_KEY, saved);
    var readiness = accessMailReadiness_();
    return { users: saved.users.map(function(user) { return { email: user.email, role: user.role }; }), emails: saved.users.map(function(user) { return user.email; }), version: saved.version, adminEmail: ownerEmail, currentEmail: caller.email, isAdmin: true, emailVerificationReady: readiness.ready, emailVerificationMessage: readiness.message, emailAuthorizationUrl: caller.isOwner && !readiness.ready ? accessEmailAuthorizationUrl_() : "" };
  });
}

function accessEmailAuthorizationUrl_() {
  try {
    var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, ["https://www.googleapis.com/auth/script.send_mail"]);
    if (info.getAuthorizationStatus() !== ScriptApp.AuthorizationStatus.REQUIRED) return "";
    return info.getAuthorizationUrl() || "";
  } catch (error) {
    return "";
  }
}

function accessConfig_() {
  var raw = PropertiesService.getScriptProperties().getProperty(ACCESS_CONFIG_KEY);
  if (raw === null || raw === "") return { version: 1, users: ACCESS_DEFAULT_EMAILS.map(function(email) { return { email: email, role: "editor" }; }) };
  var stored;
  try { stored = JSON.parse(raw); } catch (error) { throw new Error("保存済み利用者設定が不正です。"); }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("保存済み利用者設定が不正です。");
  if (!Number.isInteger(stored.version) || stored.version < 1) throw new Error("保存済み利用者設定が不正です。");
  var hasUsers = Object.prototype.hasOwnProperty.call(stored, "users");
  var hasEmails = Object.prototype.hasOwnProperty.call(stored, "emails");
  if (hasUsers === hasEmails) throw new Error("保存済み利用者設定が不正です。");
  if (hasUsers && !Array.isArray(stored.users)) throw new Error("保存済み利用者設定が不正です。");
  if (hasEmails && !Array.isArray(stored.emails)) throw new Error("保存済み利用者設定が不正です。");
  var sourceUsers = hasUsers ? stored.users : stored.emails;
  if (!Array.isArray(sourceUsers) || sourceUsers.length > 50) throw new Error("保存済み利用者設定が不正です。");
  var seen = [];
  var users = sourceUsers.map(function(value) {
    var email;
    var role;
    if (hasUsers) {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.email !== "string" || !Object.prototype.hasOwnProperty.call(value, "role")) throw new Error("保存済み利用者設定が不正です。");
      email = value.email;
      role = value.role;
    } else {
      if (typeof value !== "string") throw new Error("保存済み利用者設定が不正です。");
      email = value;
      role = "editor";
    }
    if (typeof email !== "string" || !accessValidEmail_(email) || email !== accessNormalizeEmail_(email) || seen.indexOf(email) >= 0 || ["admin", "editor", "worker", "viewer"].indexOf(role) < 0) throw new Error("保存済み利用者設定が不正です。");
    seen.push(email);
    return { email: email, role: role };
  });
  return { version: stored.version, users: users };
}

function accessMailReadiness_() {
  try {
    if (MailApp.getRemainingDailyQuota() > 0) return { ready: true, message: "" };
    return { ready: false, message: "本日の確認コード送信上限に達しています。" };
  } catch (error) {
    return { ready: false, message: "確認コードの送信権限が未許可です。Apps Scriptでメール送信を許可してください。" };
  }
}

function accessEmails_() { return accessConfig_().users.map(function(user) { return user.email; }); }
function accessNormalizeEmail_(value) { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function accessValidEmail_(value) {
  if (typeof value !== "string" || value.length > 254) return false;
  var parts = value.split("@");
  if (parts.length !== 2 || parts[0].length > 64 || !/^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(parts[0])) return false;
  var labels = parts[1].split(".");
  return labels.length >= 2 && labels.every(function(label) { return label.length <= 63 && /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label); }) && /^[A-Z]{2,63}$/i.test(labels[labels.length - 1]);
}
function accessSessionHash_() {
  var key = Session.getTemporaryActiveUserKey();
  return key ? accessHash_(String(key)) : "";
}
function accessHash_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, "");
}
function accessConstantTimeEqual_(left, right) {
  left = String(left || ""); right = String(right || "");
  var difference = left.length ^ right.length;
  var length = Math.max(left.length, right.length);
  for (var i = 0; i < length; i += 1) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}
function accessReadJson_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (value === null || value === "") return null;
  try { return JSON.parse(value); } catch (error) { throw new Error("保存済みアクセス情報が不正です。"); }
}
function accessCleanup_(now) {
  var properties = PropertiesService.getScriptProperties();
  var all = properties.getProperties();
  var today = new Date(now).toISOString().slice(0, 10);
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(ACCESS_RATE_PREFIX) === 0) {
      if (key.slice(ACCESS_RATE_PREFIX.length) !== today) properties.deleteProperty(key);
      return;
    }
    if (key.indexOf(ACCESS_GRANT_PREFIX) === 0 || key.indexOf(ACCESS_CHALLENGE_PREFIX) === 0) {
      var item;
      try { item = JSON.parse(all[key]); } catch (error) { properties.deleteProperty(key); return; }
      var expiry = item && item.expiresAt;
      if (!Number.isFinite(expiry) || Math.floor(expiry) !== expiry || expiry <= now) properties.deleteProperty(key);
    } else if (key.indexOf(ACCESS_DEVICE_PREFIX) === 0) {
      var device;
      try { device = JSON.parse(all[key]); } catch (error) { properties.deleteProperty(key); return; }
      if (!device || !Number.isSafeInteger(device.createdAt) || accessDeviceExpiry_(device) <= now) properties.deleteProperty(key);
    }
  });
}
function accessWriteJson_(key, value) { PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value)); }
function accessDelete_(key) { PropertiesService.getScriptProperties().deleteProperty(key); }
function accessWithLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return callback(); } finally { lock.releaseLock(); }
}
