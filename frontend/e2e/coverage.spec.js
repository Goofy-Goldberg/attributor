import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

function mockAuth(route) {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/auth/get-session") {
    return route.fulfill({ json: {
      user: { id: "analyst-1", email: "analyst@example.org", name: "Analyst" },
      session: { id: "session-1", userId: "analyst-1", expiresAt: new Date(Date.now() + 3600000).toISOString() },
    } });
  }
  if (url.pathname === "/api/auth/token") {
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    return route.fulfill({ json: { token } });
  }
  return null;
}

test("domain page shows the real total and an indirect-only empty result", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    if (mockAuth(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [] } });
    if (url.pathname === "/api/domain/alpha.example") {
      return route.fulfill({ json: { domain: "alpha.example", ingested: true, hosts: [], selectors: [], ips: [] } });
    }
    if (url.pathname === "/api/graph/links/alpha.example") {
      return route.fulfill({ json: { links: [{ target: "beta.example", score: 60, confidence: 60, strength: "moderate", evidence: [] }], total: 51, limit: 50, has_more: true } });
    }
    if (url.pathname === "/api/graph/related/alpha.example") {
      expect(url.searchParams.get("min_hops")).toBe("2");
      return route.fulfill({ json: { related: [], total: 0, limit: 50, has_more: false, partial: false, stale: false } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/domain/alpha.example");
  await expect(page.getByRole("heading", { name: "alpha.example" })).toBeVisible();
  await expect(page.getByText("Showing 1 of 51 direct connections.")).toBeVisible();
  await expect(page.getByText("No indirect connections")).toBeVisible();
});

test("clearing a comparison removes its result and export control", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    if (mockAuth(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [] } });
    if (url.pathname.startsWith("/api/graph/related/")) return route.fulfill({ json: { related: [], total: 0 } });
    if (url.pathname === "/api/graph/connections") {
      return route.fulfill({ json: { domains: ["alpha.example"], pairs: [], pool_links: { "alpha.example": [] } } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/compare?d=alpha.example");
  await expect(page.getByRole("heading", { name: "Compare channels" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export" })).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("button", { name: "Export" })).toHaveCount(0);
});

test("an old response cannot replace a failed comparison for a new selection", async ({ page }) => {
  let startAlpha;
  let releaseAlpha;
  const alphaStarted = new Promise((resolve) => { startAlpha = resolve; });
  const alphaGate = new Promise((resolve) => { releaseAlpha = resolve; });

  await page.route("**/api/**", async (route) => {
    if (mockAuth(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [] } });
    if (url.pathname.startsWith("/api/graph/related/")) return route.fulfill({ json: { related: [], total: 0 } });
    if (url.pathname === "/api/search") {
      return route.fulfill({ json: { query: url.searchParams.get("q"), domains: [] } });
    }
    if (url.pathname === "/api/graph/connections") {
      const domains = route.request().postDataJSON().domains;
      if (domains.includes("alpha.example")) {
        startAlpha();
        await alphaGate;
        try {
          return await route.fulfill({ json: { domains: ["alpha.example"], pairs: [], pool_links: {} } });
        } catch {
          return;
        }
      }
      return route.fulfill({ status: 503, json: { detail: "Graph service unavailable" } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/compare?d=alpha.example");
  await alphaStarted;
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByRole("button", { name: "Add a channel" }).click();
  await page.getByPlaceholder("Search the pool…").fill("beta.example");
  await page.getByText("Add “beta.example”").click();
  await expect(page.getByText("Graph service unavailable")).toBeVisible();
  releaseAlpha();
  await expect(page.getByRole("button", { name: "Export" })).toHaveCount(0);
});

test("comparison CSV includes unique loaded pool links and states the remaining cap", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    if (mockAuth(route)) return;
    const url = new URL(route.request().url());
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [] } });
    if (url.pathname.startsWith("/api/graph/related/")) return route.fulfill({ json: { related: [], total: 0 } });
    if (url.pathname === "/api/verdicts") {
      if (route.request().method() === "PUT") {
        return route.fulfill({ json: { verdict_summary: {
          counts: { same_owner: 1, different_owner: 0, unsure: 0 },
          verdicts: [{ verdict: "same_owner", userDisplay: "Analyst", note: "Reviewed together." }],
        } } });
      }
      return route.fulfill({ json: { counts: { same_owner: 0, different_owner: 1, unsure: 0 }, verdicts: [] } });
    }
    if (url.pathname === "/api/graph/connections") {
      return route.fulfill({ json: {
        domains: ["alpha.example", "beta.example"],
        pairs: [{ a: "alpha.example", b: "beta.example", connected: true, score: 60, evidence: [] }],
        pool_links: {
          "alpha.example": [
            { target: "beta.example", score: 60, evidence: [] },
            { target: "gamma.example", score: 40, evidence: [], verdict_summary: {
              counts: { same_owner: 0, different_owner: 1, unsure: 0 },
              verdicts: [{ verdict: "different_owner", userDisplay: "Analyst", note: "Shared hosting only." }],
            } },
          ],
          "beta.example": [{ target: "alpha.example", score: 60, evidence: [] }],
        },
        pool_link_meta: {
          "alpha.example": { total: 51, limit: 50, has_more: true },
          "beta.example": { total: 1, limit: 50, has_more: false },
        },
      } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/compare?d=alpha.example&d=beta.example");
  await page.getByRole("tab", { name: "Links to the rest of the pool" }).click();
  await page.getByRole("button", { name: /40 Moderate gamma.example/ }).click();
  await page.getByRole("radio", { name: "Same owner" }).click();
  await page.getByRole("button", { name: "Save verdict" }).click();
  await expect(page.getByText("Verdict saved")).toBeVisible();
  await page.getByRole("button", { name: "Export" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Connections as CSV" }).click();
  const csv = await readFile(await (await downloadPromise).path(), "utf8");
  expect(csv).toContain("alpha.example,gamma.example");
  expect(csv.match(/alpha\.example,beta\.example/g)).toHaveLength(1);
  expect(csv.split("\n").find((row) => row.startsWith("alpha.example,gamma.example"))).toContain(",1,0,0,");
  expect(csv).toContain("more pool connections were not loaded");
});
