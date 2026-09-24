---
read_when: Changing sign-in, account permissions, API routes, Docker routing, or authentication tests.
---

# Authentication

IP Intel uses Better Auth in the `auth/` Node service. It stores users,
sessions, verification codes, and signing keys in PostgreSQL's `auth` schema.
The React app signs in through `/api/auth/*`; the FastAPI app verifies a
short-lived JWT from Better Auth's JWKS on every `/api/*` request except
`/api/health` and the auth routes. A hidden button or the Vite proxy is never
an authorization check. Direct requests to port 9000 are checked too.

## Sign-in and permissions

- Email sign-in uses a one-time code sent through SMTP. Only complete email
  domains listed in `AUTH_EMAIL_DOMAINS` may use it; the default is
  `stratc.org`. Set `AUTH_EMAIL_DOMAINS=*` to accept any email domain. The
  address is checked before sending a code and when Better
  Auth creates the account. Codes expire after five minutes, allow three
  attempts, and are stored hashed.
- Any user who successfully signs in with the configured Mattermost OAuth
  application gets an IP Intel account. Mattermost sign-in is hidden
  until all three Mattermost settings below are present. Better Auth links
  identities by Mattermost's stable user ID; a matching email alone does not
  merge accounts. A signed-in user can choose **Connect Mattermost** from the
  account menu to link the two methods.
- The first verified account becomes an admin, whether it signs in with an
  email code or Mattermost. On an existing installation with no admin, startup
  promotes the earliest verified account and ends its sessions; that person
  must sign in again. The one-time claim remains after later role changes or
  account deletion, so no subsequent sign-in gains admin automatically. On a
  fresh instance, have the intended admin sign in before sharing its URL.
- Regular users can browse, compare, start scans, and record pair verdicts.
  Admins can also use graph recompute, graph email, and export the full verdict
  history from `/api/verdicts/export`. These permissions are checked in FastAPI.
  All later accounts get the regular `user` role.

After an account has signed in once, assign or remove admin access with:

```bash
docker compose exec auth npm run set-role -- user@stratc.org admin
docker compose exec auth npm run set-role -- user@stratc.org user
```

The command ends that user's sessions; they must sign in again. Already
issued API JWTs remain valid until their 15-minute expiry. Use this command
only for a known, verified account.

## Configuration

Set these in the untracked `.env` used by the Compose stack before a
production-style start:

| Variable | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Required, high-entropy secret of at least 32 characters. |
| `BETTER_AUTH_URL` | Public app origin, such as `https://intel.example.org`. Used for OAuth callbacks and JWT issuer/audience. |
| `AUTH_EMAIL_DOMAINS` | Comma-separated exact email domains, or `*` for all domains; defaults to `stratc.org`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_STARTTLS`, `SMTP_USERNAME`, `SMTP_PASSWORD` | SMTP connection for codes; the existing alert transport uses the same settings. |
| `AUTH_MAIL_FROM` | Sender for sign-in codes; falls back to `ALERT_EMAIL_FROM`. |
| `MATTERMOST_URL` | Mattermost origin. Leave unset until its OAuth app is registered. |
| `MATTERMOST_OAUTH_CLIENT_ID`, `MATTERMOST_OAUTH_CLIENT_SECRET` | Confidential OAuth application credentials. Set all Mattermost variables together. |

In Mattermost, enable its OAuth 2.0 service provider and register a
confidential application with callback
`<BETTER_AUTH_URL>/api/auth/callback/mattermost`. The auth service uses
Mattermost's `/oauth/authorize`, `/oauth/access_token`, and
`/api/v4/users/me` endpoints. The client secret stays in the auth service;
do not put it in a `VITE_*` variable. If Mattermost uses an internal CA, mount
its public root certificate in the auth container and set `NODE_EXTRA_CA_CERTS`
to that path.

FastAPI receives `AUTH_PROXY_URL`, `AUTH_JWKS_URL`, and `AUTH_ISSUER` from
Compose. If the JWT keys cannot be retrieved, protected requests fail closed.
FastAPI trusts only Ed25519-signed tokens with the configured issuer and
audience. It does not accept a browser-supplied role header.
FastAPI also replaces caller-supplied forwarding headers before proxying to
Better Auth, so they cannot be used to evade its IP rate limits. If a trusted
reverse proxy sits in front of FastAPI, set `AUTH_TRUSTED_PROXY_CIDRS` to that
proxy's exact address or CIDR; the proxy must append the real client address
to `X-Forwarded-For`. Leave the setting empty for direct access.

## Local development and tests

The development Compose overlay starts Mailpit as a local SMTP sink. Open
`http://localhost:5173` for the app and `http://localhost:8025` to inspect
test sign-in emails. Mailpit's web port listens on loopback only because it
contains working sign-in codes. The dev auth service generates a secret on first start
and keeps it in the `auth_dev_secret` Docker volume, so restarting it
preserves sessions and signing keys. Mattermost is
optional in local development.

Run backend auth and frontend checks with:

```bash
.venv/bin/python -m pytest tests/test_case_app.py
cd auth && npm test
cd ../frontend && npm run lint && npm test && npm run test:e2e
```

The Playwright smoke tests require the development Compose stack. They use
Mailpit for a test account and mock scan/pool data so they do not trigger real
provider scans.
