import assert from "node:assert/strict";
import test from "node:test";
import { validateQaUrl } from "../tools/browser-runtime.mjs";

test("browser QA accepts only an explicitly ported loopback HTTP target", () => {
  for (const value of ["http://127.0.0.1:4173/src/index.html", "http://localhost:43123/dist/Index.html"]) assert.equal(validateQaUrl(value).protocol, "http:");
  for (const value of ["https://script.google.com/macros/s/production/exec", "http://127.0.0.1.evil.example:4173", "http://127.0.0.1", "https://localhost:4173", "http://user:password@localhost:4173", "file:///tmp/index.html", "http://192.168.1.10:4173"]) {
    assert.throws(() => validateQaUrl(value), /QA_LOCAL_URL_REQUIRED/);
  }
});
