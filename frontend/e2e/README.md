# Frontend smoke tests

Start the development Compose stack before running these tests. By default it
must expose the frontend at `http://localhost:5173` and Mailpit at
`http://localhost:8025`. An isolated stack may use other local ports.
Playwright does not start or leave behind a development server.

```sh
E2E_BASE_URL=http://localhost:5174 E2E_MAILPIT_URL=http://localhost:8026 npm run test:e2e
```

The tests sign in through the real local Better Auth service and read the code
from Mailpit. They provide deterministic browser routes for channel, scan,
and domain data, so the tests do not start real provider scans.
