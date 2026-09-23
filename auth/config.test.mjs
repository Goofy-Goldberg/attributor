import assert from "node:assert/strict";
import test from "node:test";

process.env.BETTER_AUTH_SECRET = "test-only-secret-with-at-least-32-characters";
process.env.BETTER_AUTH_URL = "http://localhost:5173";
process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";

const { auth } = await import("./auth.mjs");

test("same-email OAuth linking requires an explicit signed-in link", async () => {
  const context = await auth.$context;
  assert.equal(context.options.account?.accountLinking?.disableImplicitLinking, true);
});
