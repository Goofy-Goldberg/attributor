import { expect, test } from "@playwright/test";

async function mockApi(page, { role, onImport }) {
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/get-session") {
      return route.fulfill({ json: {
        user: { id: "user-1", email: "analyst@example.org", name: "Analyst", role },
        session: { id: "session-1", userId: "user-1", expiresAt: new Date(Date.now() + 3600000).toISOString() },
      } });
    }
    if (url.pathname === "/api/auth/token") {
      return route.fulfill({ json: { token } });
    }
    if (url.pathname === "/api/ingest/opencti") {
      return onImport(route);
    }
    if (url.pathname === "/api/jobs") {
      return route.fulfill({ json: { jobs: [] } });
    }
    if (url.pathname === "/api/pool") {
      return route.fulfill({ json: { domains: [], total: 0 } });
    }
    if (url.pathname === "/api/labels") {
      return route.fulfill({ json: { labels: [] } });
    }
    return route.fulfill({ json: {} });
  });
}

test("admins can import OpenCTI website channels from the Add channels sheet", async ({ page }) => {
  let imports = 0;
  let requestedLimit;
  await mockApi(page, {
    role: "admin",
    onImport: (route) => {
      imports += 1;
      requestedLimit = route.request().postDataJSON().limit;
      return route.fulfill({ status: 202, json: {
        job_id: "job-1", job: { id: "job-1", total_targets: 3 },
        channels: 900, skipped: 400, accepted: 3, deferred: 497, batches: 1, tiers: 1, labels_refreshed: 0,
      } });
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add channels", exact: true }).first().click();
  await expect(page.getByText("Import from OpenCTI", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Import website channels from OpenCTI?")).toBeVisible();
  const limit = page.getByRole("spinbutton", { name: "New channels" });
  await limit.fill("0");
  await expect(page.getByRole("alertdialog").getByRole("button", { name: "Import", exact: true })).toBeDisabled();
  await limit.fill("3");
  await page.getByRole("alertdialog").getByRole("button", { name: "Import", exact: true }).click();

  await expect(page.getByText("OpenCTI import started", { exact: true })).toBeVisible();
  await expect(page.getByText(/Scanning 3 new channels\. 400 already in the pool were skipped\. 497 remain for a later import/)).toBeVisible();
  await expect(page.getByText("OpenCTI import", { exact: true })).toBeVisible();
  expect(imports).toBe(1);
  expect(requestedLimit).toBe(3);
});

test("the OpenCTI import is hidden from non-admins", async ({ page }) => {
  await mockApi(page, { role: "user", onImport: (route) => route.fulfill({ status: 403, json: {} }) });

  await page.goto("/");
  await page.getByRole("button", { name: "Add channels", exact: true }).first().click();
  await expect(page.getByText("Your scans", { exact: true }).or(page.getByText("Links, domains or IPs"))).toBeVisible();
  await expect(page.getByText("Import from OpenCTI", { exact: true })).toHaveCount(0);
});
