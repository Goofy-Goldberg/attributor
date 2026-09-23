import { expect, test } from "@playwright/test";

test("channel labels filter the URL and an admin can archive the batch", async ({ page }) => {
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  let archived = false;
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/get-session") {
      return route.fulfill({ json: {
        user: { id: "admin-1", role: "admin", email: "admin@example.org" },
        session: { id: "session-1", userId: "admin-1", expiresAt: new Date(Date.now() + 3600000).toISOString() },
      } });
    }
    if (url.pathname === "/api/auth/token") return route.fulfill({ json: { token } });
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [] } });
    if (url.pathname === "/api/labels") {
      return route.fulfill({ json: { labels: archived ? [] : [{ label: "UI redesign test", channel_count: 1 }] } });
    }
    if (url.pathname === "/api/labels/archive" && route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ label: "UI redesign test" });
      archived = true;
      return route.fulfill({ json: { label: "UI redesign test", archived: 1 } });
    }
    if (url.pathname === "/api/pool") {
      const matches = !archived && (!url.searchParams.has("label") || url.searchParams.get("label") === "UI redesign test");
      return route.fulfill({ json: { total: matches ? 1 : 0, domains: matches ? [{
        domain: "example.com", labels: ["UI redesign test"], ingested: true,
      }] : [] } });
    }
    if (url.pathname === "/api/domain/example.com") {
      return route.fulfill({ json: { domain: "example.com", labels: ["UI redesign test"], hosts: [] } });
    }
    if (url.pathname === "/api/graph/links/example.com") return route.fulfill({ json: { links: [] } });
    return route.fulfill({ json: {} });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
  await expect(page.getByText("UI redesign test", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Filter by label" }).click();
  await page.getByRole("option", { name: /UI redesign test/ }).click();
  await expect(page).toHaveURL(/label=UI\+redesign\+test/);
  await page.getByRole("link", { name: "example.com" }).click();
  await expect(page.getByRole("heading", { name: "example.com" })).toBeVisible();
  await expect(page.getByText("UI redesign test", { exact: true })).toBeVisible();

  await page.goBack();
  await page.getByRole("button", { name: "Archive channels…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Their scans and evidence stay stored.");
  await page.getByRole("button", { name: "Archive channels", exact: true }).click();
  await expect(page.getByText("The pool is empty")).toBeVisible();
});
