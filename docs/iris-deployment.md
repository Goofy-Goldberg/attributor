---
read_when: Deploying IP Intel on iris, changing its route or authentication, or connecting it to OpenCTI.
---

# Iris deployment

The pilot runs in `/srv/attributor` on iris. Use both Compose files:

```bash
cd /srv/attributor
docker compose -f docker-compose.yml -f docker-compose.iris.yml up -d --build
```

The iris overlay publishes the web service at `http://iris:19001` on the internal
network. Port 9000 belongs to Portainer. Caddy does not route this app and the
existing `https://iris` static routes remain separate. The app joins the existing
`opencti_default` network and uses `OPENCTI_URL=http://opencti:8080` so the
OpenCTI connection stays inside Docker. The existing `shared_net` must also
exist for the base Compose file.

The HTML entry point is served with `Cache-Control: no-cache`. When a deploy
removes a lazy-loaded chunk still referenced by an open tab, the frontend
reloads once to pick up the current build. Keep the previous build's hashed
assets available during a rollout when possible, so existing tabs can finish
without reloading.

Keep `/srv/attributor/.env` on the server with mode 600. Required settings:
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://iris:19001`,
`APP_BASE_URL=http://iris:19001`,
`OPENCTI_URL`, `OPENCTI_TOKEN`, and SMTP settings for email sign-in. Set
`AUTH_EMAIL_DOMAINS=*` to accept any email domain on this server. Configure
`MATTERMOST_URL=https://mattermost.internal.net` and the confidential OAuth
client ID/secret with callback
`http://iris:19001/api/auth/callback/mattermost` for Mattermost sign-in. Use an
OpenCTI service account with read access and token API access. Do not use the
OpenCTI admin token. Compose supplies the bundled PostgreSQL `DATABASE_URL`.
The iris pilot uses the `Attributor iris` service account; its current token
expires on 24 September 2027. Renew it before then and update only the server
`.env`. Initial SMTP credentials came from the existing
`/srv/opencti-tgcc-sync/.env`; rotate this deployment's copy when those shared
credentials change. Optional provider API keys are not configured for the
initial pilot, so paid-source enrichment is unavailable until they are added.
The auth container mounts Athena's public Caddy root certificate from
`/srv/attributor/certs/athena-caddy-root.crt` and uses `NODE_EXTRA_CA_CERTS`
to trust Mattermost's internal HTTPS endpoint. Refresh that certificate if
Athena's Caddy root rotates. No private key is copied.

Before an update, record `git rev-parse HEAD`, `docker compose ls`, service
health, and the presence of `.env`, override files, and backups. Preserve the
PostgreSQL volume. Apply the update with both Compose files, then check:

```bash
docker compose -f docker-compose.yml -f docker-compose.iris.yml ps
curl -fsS http://iris:19001/api/health
docker compose -f docker-compose.yml -f docker-compose.iris.yml exec ip-intel \
  python -c 'from integrations.opencti_ingest import fetch_all_website_channel_data; print(len(fetch_all_website_channel_data()))'
```

The OpenCTI check reads Channels but does not scan them. To ingest all website
Channels, run `python -m scripts.ingest_opencti_channels` inside `ip-intel`
separately; see the README for batching and retry behavior. This scan can be
expensive and is not part of deployment.
For a small pilot, run the command with `--dry-run --limit N` first, then
`--limit N`. The limit counts new seed domains; analysis may discover more
follow-up targets. The configured iris OpenCTI account points to the local
instance. Production credentials must be supplied only to the one-shot import
process, without changing the server's `.env`.
On 24 September 2026, an admin-credential query confirmed this iris OpenCTI
instance has no Channels with `channel_types=website`; the app's read check
therefore returns zero until those Channels are added.

Rollback: restore the previous app revision, then run the same Compose `up -d
--build` command. Database schema changes may require a database-aware rollback;
do not remove the PostgreSQL volume.
