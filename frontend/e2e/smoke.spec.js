import { expect, test } from "@playwright/test";

const POOL = {
  domains: [
    {
      domain: "alpha.example",
      connection_count: 1,
      host_count: 2,
      scan_count: 1,
      ingested: true,
      ingested_at: "2026-09-23T08:00:00.000Z",
    },
    {
      domain: "bravo.example",
      connection_count: 1,
      host_count: 1,
      scan_count: 1,
      ingested: true,
      ingested_at: "2026-09-23T08:00:00.000Z",
    },
  ],
  total: 2,
};

const PROFILE = {
  domain: "alpha.example",
  ingested: true,
  host_count: 2,
  ips: [{ value: "203.0.113.10" }],
  selectors: [{ kind: "tracking_id", value: "UA-e2e", degree: 2 }],
  hosts: [{ value: "alpha.example" }, { value: "www.alpha.example" }],
  intel: { timestamp: "2026-09-23T08:00:00.000Z" },
};

function connectionResult(domains) {
  const selected = domains.length ? domains : ["alpha.example", "bravo.example"];
  return {
    domains: selected,
    pool_links: Object.fromEntries(selected.map((domain) => [domain, []])),
    pairs:
      selected.length >= 2
        ? [
            {
              a: selected[0],
              b: selected[1],
              connected: true,
              score: 87,
              strength: "strong",
              evidence: [{ kind: "tracking_id", value: "UA-e2e" }],
            },
          ]
        : [],
  };
}

async function installRoutes(page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, options = {}) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
      ...options,
    });

    if (url.pathname.startsWith("/api/auth/")) {
      return route.continue();
    }
    if (url.pathname === "/api/pool") {
      return json(POOL);
    }
    if (url.pathname === "/api/ingest" && request.method() === "POST") {
      return json({ job_id: "job-e2e-1", accepted: 2 });
    }
    if (url.pathname === "/api/jobs/job-e2e-1") {
      return json({ id: "job-e2e-1", status: "running", progress: 20, stage: "Scanning domains" });
    }
    if (url.pathname === "/api/domain/alpha.example") {
      return json(PROFILE);
    }
    if (url.pathname === "/api/graph/links/alpha.example") {
      return json({ links: [] });
    }
    if (url.pathname.startsWith("/api/graph/related/")) {
      return json({ related: [] });
    }
    if (url.pathname === "/api/graph/connections" && request.method() === "POST") {
      const { domains = [] } = request.postDataJSON() || {};
      return json(connectionResult(domains));
    }
    return json({ detail: `Unexpected E2E route: ${request.method()} ${url.pathname}` }, { status: 404 });
  });
}

async function signInThroughMailpit(page, request, testTitle) {
  const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";
  const mailpitURL = process.env.E2E_MAILPIT_URL || "http://localhost:8025";
  if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) {
    throw new Error("The smoke suite only signs in to a local development stack.");
  }
  await expect.poll(async () => {
    try {
      return (await request.get(`${baseURL}/api/auth/config`, { timeout: 2_000 })).status();
    } catch {
      return 0;
    }
  }, { timeout: 30_000 }).toBe(200);
  const slug = testTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const email = `playwright-${slug}@stratc.org`;
  const existing = await request.get(`${mailpitURL}/api/v1/messages`);
  expect(existing.ok()).toBeTruthy();
  const knownMessages = new Set((await existing.json()).messages?.map((message) => message.ID) || []);
  const send = await page.request.post(`${baseURL}/api/auth/email-otp/send-verification-otp`, {
    data: { email, type: "sign-in" },
  });
  expect(send.ok(), await send.text()).toBeTruthy();

  let messageId = null;
  await expect.poll(async () => {
    const response = await request.get(`${mailpitURL}/api/v1/messages`);
    if (!response.ok()) {
      return null;
    }
    const inbox = await response.json();
    messageId = inbox.messages?.find((message) =>
      !knownMessages.has(message.ID) && message.To?.some((recipient) => recipient.Address?.toLowerCase() === email),
    )?.ID || null;
    return messageId;
  }, { timeout: 10_000 }).not.toBeNull();

  const message = await request.get(`${mailpitURL}/api/v1/message/${messageId}`);
  expect(message.ok()).toBeTruthy();
  const code = (await message.json()).Text.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeTruthy();
  const signedIn = await page.request.post(`${baseURL}/api/auth/sign-in/email-otp`, {
    data: { email, otp: code },
  });
  expect(signedIn.ok(), await signedIn.text()).toBeTruthy();
  expect((await page.context().cookies(baseURL)).some((cookie) => cookie.name === "better-auth.session_token")).toBeTruthy();
  const session = await page.request.get(`${baseURL}/api/auth/get-session`);
  expect(session.ok(), `get-session returned ${session.status()}`).toBeTruthy();
  expect((await session.json()).user?.email).toBe(email);
}

test.beforeEach(async ({ page, request }, testInfo) => {
  await signInThroughMailpit(page, request, testInfo.title);
  await installRoutes(page);
});

test("selecting two channels opens their comparison and verdict", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select alpha.example" }).check();
  await page.getByRole("checkbox", { name: "Select bravo.example" }).check();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Compare 2" }).click();
  await expect(page).toHaveURL(/\/compare\?d=alpha\.example&d=bravo\.example/);
  await expect(page.getByText("1 of 1 pair share evidence", { exact: true })).toBeVisible();
});

test("submitting channels keeps the running job visible", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Add channels", exact: true }).first().click();
  await page.getByLabel("Links, domains or IPs").fill("alpha.example\nbravo.example");
  await page.getByRole("button", { name: "Scan 2 targets" }).click();

  await expect(page.getByRole("heading", { name: "Recent scans" })).toBeVisible();
  await expect(page.getByText("2 targets", { exact: true })).toBeVisible();
  await expect(page.getByText("Scanning…", { exact: true })).toBeVisible();
});

test("domain tabs write the active tab into the URL", async ({ page }) => {
  await page.goto("/domain/alpha.example");

  await expect(page.getByRole("heading", { name: "alpha.example" })).toBeVisible();
  await page.getByRole("tab", { name: /Extracted evidence/ }).click();
  await expect(page).toHaveURL("/domain/alpha.example?tab=evidence");
  await page.getByRole("tab", { name: "Scan details" }).click();
  await expect(page).toHaveURL("/domain/alpha.example?tab=intel");
});

test("comparison reports channels omitted by either scoring limit", async ({ page }) => {
  await page.route("**/api/graph/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/graph/related/alpha.example") {
      return route.fulfill({
        json: { related: Array.from({ length: 36 }, (_, index) => ({ target: `related-${index}.example`, hops: 2 })) },
      });
    }
    if (url.pathname === "/api/graph/connections") {
      const { domains } = route.request().postDataJSON();
      return route.fulfill({ json: connectionResult(domains.slice(0, -1)) });
    }
    return route.fallback();
  });

  await page.goto("/compare?d=alpha.example&d=bravo.example");
  await expect(page.getByText("Showing 28 of 36 related channels.", { exact: false })).toBeVisible();
  await expect(page.getByText("The server returned 29 of 30 submitted channels", { exact: false })).toBeVisible();
});
