import { expect, test } from "@playwright/test";

test("shared scans refresh channels and only your scan shows a finish notice", async ({ page }) => {
  const createdAt = new Date().toISOString();
  const jobs = [
    { id: "mine", status: "running", percent: 20, total_targets: 1, created_by: "user-1", created_at: createdAt },
    { id: "theirs", status: "running", percent: 20, total_targets: 1, created_by: "user-2", created_by_display: "Another analyst", created_at: createdAt },
  ];
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  let poolRequests = 0;

  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/get-session") {
      return route.fulfill({ json: {
        user: { id: "user-1", email: "analyst@example.org", name: "Analyst" },
        session: { id: "session-1", userId: "user-1", expiresAt: new Date(Date.now() + 3600000).toISOString() },
      } });
    }
    if (url.pathname === "/api/auth/token") {
      return route.fulfill({ json: { token } });
    }
    if (url.pathname === "/api/jobs") {
      const active = url.searchParams.get("status") === "active";
      return route.fulfill({ json: { jobs: jobs.filter((job) => active ? job.status === "running" : job.status === "completed") } });
    }
    if (url.pathname === "/api/pool") {
      poolRequests += 1;
      return route.fulfill({ json: { domains: [], total: 0 } });
    }
    if (url.pathname === "/api/labels") {
      return route.fulfill({ json: { labels: [] } });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
  await expect(page.getByText("Scanning…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add channels", exact: true }).first().click();
  await expect(page.getByText("Your scans", { exact: true })).toBeVisible();
  await expect(page.getByText("Other analysts' scans", { exact: true })).toBeVisible();
  await expect(page.getByText("Another analyst", { exact: false })).toBeVisible();
  const before = poolRequests;

  Object.assign(jobs[1], { status: "completed", percent: 100, finished_at: new Date().toISOString() });
  await expect.poll(() => poolRequests, { timeout: 12_000 }).toBeGreaterThan(before);
  await expect(page.getByText("Scan finished", { exact: true })).toHaveCount(0);

  Object.assign(jobs[0], { status: "completed", percent: 100, finished_at: new Date().toISOString() });
  await expect(page.getByText("Scan finished", { exact: true }), { timeout: 12_000 }).toBeVisible();
});
