import assert from "node:assert/strict";
import test from "node:test";

import { emailDomainAllowed, identityAllowed } from "./policy.mjs";

test("email allowlist matches only the complete domain", () => {
  assert.equal(emailDomainAllowed("Analyst@STRATC.ORG"), true);
  assert.equal(emailDomainAllowed("a@sub.stratc.org"), false);
  assert.equal(emailDomainAllowed("a@otherstratc.org"), false);
  assert.equal(emailDomainAllowed("a@example.com"), false);
});

test("Mattermost users are admitted regardless of email domain", () => {
  assert.equal(identityAllowed({ user: { email: "a@example.com" }, source: { oauth: { providerId: "mattermost" } } }), undefined);
  assert.equal(identityAllowed({ user: { email: "a@example.com" }, source: { method: "email-otp" } }).error, "email_not_allowed");
});
