import { createServer } from "node:http";

import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";

import { auth, mattermostEnabled, pool } from "./auth.mjs";
import { installFirstAdmin } from "./first-admin.mjs";

// Keep auth tables separate from the intelligence tables. Better Auth's pg
// connection uses search_path=auth for all of its queries and migrations.
await pool.query("CREATE SCHEMA IF NOT EXISTS auth");
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
const { promotedExistingUser } = await installFirstAdmin(pool);
if (promotedExistingUser) {
  console.log("Promoted the first verified account to admin; its sessions were ended.");
}

const handler = toNodeHandler(auth);
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", mattermost_enabled: mattermostEnabled }));
    return;
  }
  if (request.url === "/api/auth/config" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ mattermostEnabled }));
    return;
  }
  handler(request, response);
});

server.listen(3000, "0.0.0.0", () => {
  console.log("IP Intel auth listening on port 3000");
});
