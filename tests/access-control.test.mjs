import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../apps-script/AccessControl.gs", import.meta.url), "utf8");

function harness({ active = "owner@example.com", effective = "owner@example.com", session = "session-a", now = 1_800_000_000_000 } = {}) {
  const properties = new Map();
  const sent = [];
  let uuid = 0;
  let remainingQuota = 100;
  const context = vm.createContext({ Date: class extends Date { static now() { return now; } }, Math, Number, Object, String, JSON, RegExp, Array, parseInt });
  Object.assign(context, {
    Session: {
      getActiveUser: () => ({ getEmail: () => active }),
      getEffectiveUser: () => ({ getEmail: () => effective }),
      getTemporaryActiveUserKey: () => session
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.has(key) ? properties.get(key) : null,
      getProperties: () => Object.fromEntries(properties),
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: (key) => properties.delete(key)
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA-256" }, Charset: { UTF_8: "UTF-8" },
      computeDigest: (_algorithm, value) => [...createHash("sha256").update(String(value), "utf8").digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString("base64url"),
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`
    },
    MailApp: { sendEmail: (to, subject, body) => sent.push({ to, subject, body }), getRemainingDailyQuota: () => remainingQuota }
  });
  vm.runInContext(source, context);
  return {
    context, properties, sent,
    setActive(value) { active = value; }, setSession(value) { session = value; }, setNow(value) { now = value; },
    setRemainingQuota(value) { remainingQuota = value; },
    call(name, arg) { return context[name](arg); }
  };
}

test("remembered device storage is bounded and evicted credentials invalidate their session grants", () => {
  const h = harness({ active: "minnanookinomiyaika@gmail.com" });
  const first = h.call("rememberAccessDevice", {});
  h.setActive("");
  assert.equal(h.call("restoreAccessSession", { deviceToken: first.deviceToken }).ok, true);
  h.setActive("minnanookinomiyaika@gmail.com");
  for (let index = 0; index < 20; index += 1) {
    h.setNow(1_800_000_000_001 + index);
    h.call("rememberAccessDevice", {});
  }
  assert.equal([...h.properties.keys()].filter((key) => key.startsWith("APP_ACCESS_DEVICE_")).length, 20);
  h.setActive("");
  assert.equal(h.call("restoreAccessSession", { deviceToken: first.deviceToken }).ok, false);
  assert.throws(() => h.call("requireAppAccess_"), /ACCESS_DENIED/);
});

function verifyByEmailCode(h, email, session = "remembered-session") {
  h.setActive("");
  h.setSession(session);
  h.call("requestAccessCode", { email });
  const code = h.sent.at(-1).body.match(/確認コード: (\d{8})/)[1];
  return h.call("verifyAccessCode", { email, code });
}

function saveUsersAsOwner(h, users) {
  h.setActive("owner@example.com");
  const current = h.call("getAccessSettings");
  return h.call("saveAccessSettings", { version: current.version, users });
}

test("owner and exact allowlisted active Google account pass, unknown and blank fail closed", () => {
  const h = harness();
  const owner = h.call("requireAppAccess_");
  assert.equal(owner.email, "owner@example.com");
  assert.equal(owner.role, "owner");
  assert.equal(owner.isOwner, true);
  assert.equal(owner.isAdmin, true);
  assert.equal(owner.canEdit, true);
  h.call("requireOwnerAccess_");
  assert.equal(h.call("requireAdminAccess_").isAdmin, true);
  h.setActive("minnanookinomiyaika@gmail.com");
  assert.equal(h.call("requireAppAccess_").email, "minnanookinomiyaika@gmail.com");
  assert.throws(() => h.call("requireAdminAccess_"), /ADMIN_REQUIRED/);
  h.setActive("outsider@example.com");
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  h.setActive(" OWNER@example.com ");
  assert.equal(h.call("requireAdminAccess_").isAdmin, true);
  h.setActive("");
  h.setSession("");
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
});

test("worker role persists and resolves for direct and OTP identities with work-only capability", () => {
  const h = harness();
  const initial = h.call("getAccessSettings");
  const saved = h.call("saveAccessSettings", { version: initial.version, users: [{ email: "worker@example.com", role: "worker" }] });
  assert.equal(saved.users[0].role, "worker");
  h.setActive("worker@example.com");
  const direct = h.call("requireAppAccess_");
  assert.equal(direct.role, "worker");
  assert.equal(direct.canWork, true);
  assert.equal(direct.canEdit, false);
  assert.throws(() => h.call("requireEditorAccess_"), /EDITOR_REQUIRED/);
  h.setActive("");
  const response = h.call("requestAccessCode", { email: "worker@example.com" });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
  const code = h.sent.at(-1).body.match(/確認コード: (\d{8})/)[1];
  h.call("verifyAccessCode", { email: "worker@example.com", code });
  const otp = h.call("requireAppAccess_");
  assert.equal(otp.role, "worker");
  assert.equal(otp.canWork, true);
  assert.equal(otp.canEdit, false);
});

test("unknown email gets generic response without mail; allowlisted code grants only its bound session and email", () => {
  const h = harness();
  h.setActive("");
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("requestAccessCode", { email: "nope@example.com" }))), { ok: true });
  assert.equal(h.sent.length, 0);
  const response = h.call("requestAccessCode", { email: " MINNANOOKINOMIYAika@gmail.com " });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true });
  assert.equal(h.sent.length, 1);
  const code = h.sent[0].body.match(/確認コード: (\d{8})/)[1];
  h.setSession("session-b");
  assert.throws(() => h.call("verifyAccessCode", { email: "minnanookinomiyaika@gmail.com", code }), /無効/);
  h.setSession("session-a");
  assert.throws(() => h.call("verifyAccessCode", { email: "other@example.com", code }), /無効/);
  assert.equal(h.call("verifyAccessCode", { email: "minnanookinomiyaika@gmail.com", code }).ok, true);
  assert.equal(h.call("requireAppAccess_").email, "minnanookinomiyaika@gmail.com");
  assert.throws(() => h.call("verifyAccessCode", { email: "minnanookinomiyaika@gmail.com", code }), /無効/);
});

test("code expiry and five wrong attempts remove the challenge", () => {
  const h = harness();
  h.setActive("");
  h.call("requestAccessCode", { email: "minnanookinomiyaika@gmail.com" });
  const code = h.sent[0].body.match(/確認コード: (\d{8})/)[1];
  h.setNow(1_800_000_000_000 + 10 * 60_000);
  assert.throws(() => h.call("verifyAccessCode", { email: "minnanookinomiyaika@gmail.com", code }), /無効/);
  h.setNow(1_800_000_000_000 + 11 * 60_000);
  h.call("requestAccessCode", { email: "minnanookinomiyaika@gmail.com" });
  for (let i = 0; i < 5; i += 1) assert.throws(() => h.call("verifyAccessCode", { email: "minnanookinomiyaika@gmail.com", code: "99999999" }), /無効/);
  const challengeKey = [...h.properties.keys()].find((key) => key.startsWith("APP_ACCESS_CHALLENGE_"));
  assert.equal(h.properties.has(challengeKey), false);
});

test("resend cooldown and per-email hourly cap are enforced", () => {
  const h = harness();
  h.setActive("");
  const email = "minnanookinomiyaika@gmail.com";
  h.call("requestAccessCode", { email });
  assert.throws(() => h.call("requestAccessCode", { email }), /60秒/);
  for (let i = 1; i < 5; i += 1) { h.setNow(1_800_000_000_000 + i * 60_000); h.call("requestAccessCode", { email }); }
  h.setNow(1_800_000_000_000 + 5 * 60_000);
  assert.throws(() => h.call("requestAccessCode", { email }), /上限/);
  assert.equal(h.sent.length, 5);
});

test("owner and account admins manage role settings; updates normalize, version and revoke grants", () => {
  const h = harness();
  const initial = h.call("getAccessSettings");
  assert.deepEqual(JSON.parse(JSON.stringify(initial.emails)), ["minnanookinomiyaika@gmail.com"]);
  assert.deepEqual(JSON.parse(JSON.stringify(initial.users)), [{ email: "minnanookinomiyaika@gmail.com", role: "editor" }]);
  assert.equal(initial.emailVerificationReady, true);
  h.setActive("");
  h.call("requestAccessCode", { email: "minnanookinomiyaika@gmail.com" });
  const grantCode = h.sent[0].body.match(/確認コード: (\d{8})/)[1];
  h.call("verifyAccessCode", { email: "minnanookinomiyaika@gmail.com", code: grantCode });
  assert.equal(h.call("requireAppAccess_").email, "minnanookinomiyaika@gmail.com");
  h.setActive("minnanookinomiyaika@gmail.com");
  assert.throws(() => h.call("getAccessSettings"), /管理者/);
  h.setActive("owner@example.com");
  const saved = h.call("saveAccessSettings", { version: initial.version, users: [{ email: "New.User@example.com", role: "admin" }, { email: "new.user@example.com", role: "viewer" }, { email: "owner@example.com", role: "viewer" }] });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.emails)), ["new.user@example.com"]);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.users)), [{ email: "new.user@example.com", role: "admin" }]);
  assert.equal(saved.version, initial.version + 1);
  assert.throws(() => h.call("saveAccessSettings", { version: initial.version, emails: [] }), /別の端末/);
  h.setActive("");
  h.setSession("session-a");
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  h.setActive("owner@example.com");
  assert.throws(() => h.call("saveAccessSettings", { version: saved.version, users: [{ email: "invalid", role: "viewer" }] }), /形式/);
});

test("email syntax is exact and corrupt config or malformed, expired and owner grants fail closed", () => {
  const h = harness();
  for (const email of ["Name <user@example.com>", "user@example.com,other@example.com", "user..x@example.com", "user@-host.com", "user@example.c", " user@example.com "]) {
    assert.equal(h.call("accessValidEmail_", email), false, email);
  }
  assert.equal(h.call("accessValidEmail_", "first.last+tag@example-domain.com"), true);
  h.setActive("minnanookinomiyaika@gmail.com");
  h.properties.set("APP_ACCESS_CONFIG_V1", "null");
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  for (const malformed of [
    { version: 1, users: "not-an-array", emails: ["minnanookinomiyaika@gmail.com"] },
    { version: 1, users: ["minnanookinomiyaika@gmail.com"], emails: ["minnanookinomiyaika@gmail.com"] },
    { version: 1, users: [{ email: "minnanookinomiyaika@gmail.com" }] },
    { version: 1, users: [{ email: "minnanookinomiyaika@gmail.com", role: "viewer" }], emails: ["legacy@example.com"] },
    { version: 1, emails: [{ email: "minnanookinomiyaika@gmail.com", role: "editor" }] }
  ]) {
    h.properties.set("APP_ACCESS_CONFIG_V1", JSON.stringify(malformed));
    assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  }
  h.properties.delete("APP_ACCESS_CONFIG_V1");
  h.setActive("");
  const grantKey = `APP_ACCESS_GRANT_${h.call("accessSessionHash_")}`;
  h.properties.set(grantKey, JSON.stringify({ email: "minnanookinomiyaika@gmail.com", expiresAt: "forever" }));
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  h.properties.set(grantKey, JSON.stringify({ email: "owner@example.com", expiresAt: 1_800_000_000_000 + 1000 }));
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  h.properties.set(grantKey, JSON.stringify({ email: "minnanookinomiyaika@gmail.com", expiresAt: 1_800_000_000_000 - 1 }));
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
});

test("an established email grant cannot override another nonblank Google identity", () => {
  const h = harness();
  h.setActive("");
  h.call("requestAccessCode", { email: "minnanookinomiyaika@gmail.com" });
  const code = h.sent[0].body.match(/確認コード: (\d{8})/)[1];
  h.call("verifyAccessCode", { email: "minnanookinomiyaika@gmail.com", code });
  h.setActive("different@example.com");
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("requestAccessCode", { email: "minnanookinomiyaika@gmail.com" }))), { ok: true });
  assert.equal(h.sent.length, 1);
});

test("an explicit empty allowlist persists and denies access; expired temporary properties are cleaned", () => {
  const h = harness();
  const initial = h.call("getAccessSettings");
  h.properties.set("APP_ACCESS_GRANT_stale", JSON.stringify({ email: "old@example.com", expiresAt: 1 }));
  h.properties.set("APP_ACCESS_CHALLENGE_stale", JSON.stringify({ expiresAt: 1 }));
  h.properties.set("APP_ACCESS_RATE_2000-01-01", "{}");
  h.setActive("");
  h.call("requestAccessCode", { email: "minnanookinomiyaika@gmail.com" });
  assert.equal(h.properties.has("APP_ACCESS_GRANT_stale"), false);
  assert.equal(h.properties.has("APP_ACCESS_CHALLENGE_stale"), false);
  assert.equal(h.properties.has("APP_ACCESS_RATE_2000-01-01"), false);
  h.setActive("owner@example.com");
  const saved = h.call("saveAccessSettings", { version: initial.version, emails: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.emails)), []);
  assert.deepEqual(JSON.parse(h.properties.get("APP_ACCESS_CONFIG_V1")).users, []);
  h.setActive("minnanookinomiyaika@gmail.com");
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
});

test("roles are resolved from live config for direct and OTP identities, with least-privilege guards", () => {
  const h = harness();
  const initial = h.call("getAccessSettings");
  const configured = h.call("saveAccessSettings", { version: initial.version, users: [
    { email: "minnanookinomiyaika@gmail.com", role: "admin" },
    { email: "editor@example.com", role: "editor" },
    { email: "viewer@example.com", role: "viewer" }
  ] });

  h.setActive("minnanookinomiyaika@gmail.com");
  const admin = h.call("requireAppAccess_");
  assert.equal(admin.role, "admin");
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.canEdit, true);
  h.call("requireAdminAccess_");
  assert.throws(() => h.call("requireOwnerAccess_"), /OWNER_REQUIRED/);

  h.setActive("editor@example.com");
  const editor = h.call("requireAppAccess_");
  assert.equal(editor.role, "editor");
  assert.equal(editor.canEdit, true);
  assert.throws(() => h.call("requireAdminAccess_"), /ADMIN_REQUIRED/);

  h.setActive("viewer@example.com");
  const viewer = h.call("requireAppAccess_");
  assert.equal(viewer.role, "viewer");
  assert.equal(viewer.canEdit, false);
  assert.throws(() => h.call("requireEditorAccess_"), /EDITOR_REQUIRED/);

  h.setActive("");
  h.setSession("role-session");
  h.call("requestAccessCode", { email: "viewer@example.com" });
  const code = h.sent.at(-1).body.match(/確認コード: (\d{8})/)[1];
  h.call("verifyAccessCode", { email: "viewer@example.com", code });
  assert.equal(h.call("requireAppAccess_").role, "viewer");

  // Updating a role immediately changes a still-valid OTP grant.
  h.setActive("owner@example.com");
  const changed = h.call("saveAccessSettings", { version: configured.version, users: [
    { email: "minnanookinomiyaika@gmail.com", role: "admin" },
    { email: "editor@example.com", role: "editor" },
    { email: "viewer@example.com", role: "editor" }
  ] });
  h.setActive("");
  assert.equal(h.call("requireAppAccess_").role, "editor");
  assert.equal(changed.version, configured.version + 1);
});

test("legacy emails migrate to editor and admin cannot remove or downgrade itself", () => {
  const h = harness();
  h.properties.set("APP_ACCESS_CONFIG_V1", JSON.stringify({ version: 4, emails: ["admin@example.com", "legacy@example.com"] }));
  h.setActive("owner@example.com");
  const config = h.call("getAccessSettings");
  assert.deepEqual(JSON.parse(JSON.stringify(config.users)), [
    { email: "admin@example.com", role: "editor" },
    { email: "legacy@example.com", role: "editor" }
  ]);
  const saved = h.call("saveAccessSettings", { version: config.version, users: [{ email: "admin@example.com", role: "admin" }, { email: "legacy@example.com", role: "editor" }] });
  h.setActive("admin@example.com");
  assert.throws(() => h.call("saveAccessSettings", { version: saved.version, users: [{ email: "legacy@example.com", role: "editor" }] }), /自分自身/);
  assert.throws(() => h.call("saveAccessSettings", { version: saved.version, users: [{ email: "admin@example.com", role: "viewer" }] }), /自分自身/);
  assert.throws(() => h.call("saveAccessSettings", { version: saved.version, users: [{ email: "legacy@example.com", role: "superuser" }] }), /権限/);
  assert.equal(h.call("requireAdminAccess_").role, "admin");
});

test("only the owner receives the email authorization URL when mail scope is required", () => {
  const h = harness();
  const initial = h.call("getAccessSettings");
  h.call("saveAccessSettings", { version: initial.version, users: [
    { email: "minnanookinomiyaika@gmail.com", role: "admin" }
  ] });
  h.setRemainingQuota(0);
  h.context.ScriptApp = {
    AuthMode: { FULL: "FULL" },
    AuthorizationStatus: { REQUIRED: "REQUIRED", NOT_REQUIRED: "NOT_REQUIRED" },
    getAuthorizationInfo(mode, scopes) {
      assert.equal(mode, "FULL");
      assert.deepEqual(JSON.parse(JSON.stringify(scopes)), ["https://www.googleapis.com/auth/script.send_mail"]);
      return { getAuthorizationStatus: () => "REQUIRED", getAuthorizationUrl: () => "https://accounts.google.com/authorize?scope=mail" };
    }
  };
  assert.equal(h.call("getAccessSettings").emailAuthorizationUrl, "https://accounts.google.com/authorize?scope=mail");
  h.setActive("minnanookinomiyaika@gmail.com");
  assert.equal(h.call("getAccessSettings").emailAuthorizationUrl, "");
});

test("the script-wide daily mail cap applies across allowlisted addresses", () => {
  const h = harness();
  const initial = h.call("getAccessSettings");
  const emails = Array.from({ length: 11 }, (_, index) => `person${index}@example.com`);
  h.call("saveAccessSettings", { version: initial.version, emails });
  h.setActive("");
  for (let person = 0; person < 10; person += 1) {
    for (let send = 0; send < 5; send += 1) {
      h.setSession(`session-${person}-${send}`);
      h.setNow(1_800_000_000_000 + h.sent.length * 60_000);
      h.call("requestAccessCode", { email: emails[person] });
    }
  }
  assert.equal(h.sent.length, 50);
  h.setSession("global-cap");
  h.setNow(1_800_000_000_000 + 50 * 60_000);
  assert.throws(() => h.call("requestAccessCode", { email: emails[10] }), /上限/);
  assert.equal(h.sent.length, 50);
});

test("OTP returns a device credential while Script Properties store only its hash", () => {
  const h = harness();
  const result = verifyByEmailCode(h, "minnanookinomiyaika@gmail.com");
  assert.equal(result.ok, true);
  assert.equal(result.remembered, true);
  assert.match(result.deviceToken, /^[a-f0-9]{64}$/);

  const tokenHash = h.call("accessHash_", result.deviceToken);
  const deviceKey = `APP_ACCESS_DEVICE_${tokenHash}`;
  assert.equal(h.properties.has(deviceKey), true);
  assert.deepEqual(JSON.parse(h.properties.get(deviceKey)), {
    version: 1,
    email: "minnanookinomiyaika@gmail.com",
    createdAt: 1_800_000_000_000,
  });
  assert.equal([...h.properties.values()].some((value) => value.includes(result.deviceToken)), false);
  const grant = JSON.parse(h.properties.get(`APP_ACCESS_GRANT_${h.call("accessSessionHash_")}`));
  assert.equal(grant.deviceHash, tokenHash);
  assert.equal(grant.deviceToken, undefined);
});

test("remembered credentials restore after seven days and survive temporary-key rotation beyond sixty days", () => {
  const h = harness();
  const result = verifyByEmailCode(h, "minnanookinomiyaika@gmail.com", "first-session");
  const base = 1_800_000_000_000;

  h.setNow(base + 8 * 86400000);
  h.setSession("rotated-session");
  assert.equal(h.call("restoreAccessSession", { deviceToken: result.deviceToken }).ok, true);
  assert.equal(h.call("requireAppAccess_").email, "minnanookinomiyaika@gmail.com");

  h.setNow(base + 61 * 86400000);
  h.setSession("second-rotation");
  assert.equal(h.call("restoreAccessSession", { deviceToken: result.deviceToken }).ok, true);
  assert.equal(h.call("requireAppAccess_").email, "minnanookinomiyaika@gmail.com");
});

test("an existing valid legacy grant can mint a remembered credential without another email", () => {
  const h = harness({ active: "", session: "legacy-session" });
  const sessionHash = h.call("accessSessionHash_");
  h.properties.set(`APP_ACCESS_GRANT_${sessionHash}`, JSON.stringify({
    email: "minnanookinomiyaika@gmail.com",
    expiresAt: 1_800_000_000_000 + 86400000,
  }));

  const result = h.call("rememberAccessDevice", { deviceToken: "" });
  assert.equal(result.ok, true);
  assert.equal(result.remembered, true);
  assert.match(result.deviceToken, /^[a-f0-9]{64}$/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.call("requireAppAccess_").role, "editor");
});

test("remembered access uses live roles and removal revokes sessions and credentials through re-add", () => {
  const h = harness();
  saveUsersAsOwner(h, [{ email: "viewer@example.com", role: "viewer" }]);
  const verified = verifyByEmailCode(h, "viewer@example.com", "viewer-session");
  assert.equal(h.call("requireAppAccess_").role, "viewer");

  saveUsersAsOwner(h, [{ email: "viewer@example.com", role: "worker" }]);
  h.setActive("");
  assert.equal(h.call("requireAppAccess_").role, "worker");
  assert.equal(h.call("requireAppAccess_").canWork, true);
  assert.equal(h.call("requireAppAccess_").canEdit, false);

  saveUsersAsOwner(h, []);
  h.setActive("");
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
  assert.equal([...h.properties.keys()].some((key) => key.startsWith("APP_ACCESS_DEVICE_")), false);
  assert.equal([...h.properties.keys()].some((key) => key.startsWith("APP_ACCESS_GRANT_")), false);

  saveUsersAsOwner(h, [{ email: "viewer@example.com", role: "editor" }]);
  h.setActive("");
  h.setSession("re-added-session");
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("restoreAccessSession", { deviceToken: verified.deviceToken }))), { ok: false });
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);
});

test("malformed, unknown, owner, mismatched-identity and invalid-date device tokens fail closed", () => {
  const h = harness({ active: "", session: "restore-session" });
  for (const deviceToken of ["", "short", "A".repeat(64), "z".repeat(64), "a".repeat(63)]) {
    assert.deepEqual(JSON.parse(JSON.stringify(h.call("restoreAccessSession", { deviceToken }))), { ok: false });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("restoreAccessSession", { deviceToken: "c".repeat(64) }))), { ok: false });

  const verified = verifyByEmailCode(h, "minnanookinomiyaika@gmail.com", "valid-token-session");
  h.setActive("different@example.com");
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("restoreAccessSession", { deviceToken: verified.deviceToken }))), { ok: false });
  h.setActive("");

  const validHash = h.call("accessHash_", verified.deviceToken);
  h.properties.set(`APP_ACCESS_DEVICE_${validHash}`, JSON.stringify({
    version: 1, email: "minnanookinomiyaika@gmail.com", createdAt: 1_800_000_000_001,
  }));
  h.setSession("invalid-date-session");
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("restoreAccessSession", { deviceToken: verified.deviceToken }))), { ok: false });

  const ownerToken = "d".repeat(64);
  const ownerHash = h.call("accessHash_", ownerToken);
  h.properties.set(`APP_ACCESS_DEVICE_${ownerHash}`, JSON.stringify({
    version: 1, email: "owner@example.com", createdAt: 1_800_000_000_000,
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("restoreAccessSession", { deviceToken: ownerToken }))), { ok: false });
  assert.throws(() => h.call("requireAppAccess_"), /利用権限/);

  h.setActive("owner@example.com");
  assert.deepEqual(JSON.parse(JSON.stringify(h.call("rememberAccessDevice", { deviceToken: "" }))), { ok: true, remembered: false });
  assert.equal([...h.properties.keys()].filter((key) => key.startsWith("APP_ACCESS_DEVICE_") && JSON.parse(h.properties.get(key)).email === "owner@example.com").length, 1);
});

test("restore returns application HTML only when openApp is requested and the device is valid", () => {
  const h = harness({ active: "", session: "open-app-session" });
  const verified = verifyByEmailCode(h, "minnanookinomiyaika@gmail.com");
  let htmlRequests = 0;
  h.context.HtmlService = {
    createHtmlOutputFromFile(name) {
      htmlRequests += 1;
      assert.equal(name, "Index");
      return { getContent: () => "<main>app</main>" };
    },
  };

  const opened = h.call("restoreAccessSession", { deviceToken: verified.deviceToken, openApp: true });
  assert.equal(opened.ok, true);
  assert.equal(opened.appHtml, "<main>app</main>");
  assert.equal(htmlRequests, 1);

  const denied = h.call("restoreAccessSession", { deviceToken: "e".repeat(64), openApp: true });
  assert.deepEqual(JSON.parse(JSON.stringify(denied)), { ok: false });
  assert.equal(htmlRequests, 1);
});
