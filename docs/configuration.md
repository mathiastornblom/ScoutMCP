# Configuration

All configuration is supplied via environment variables. In development, place them in a `.env` file at the project root. In production, inject them via the system or your MCP client's `env` block — do **not** ship a `.env` file to production hosts.

---

## Variable reference

### Required

| Variable | Example | Description |
|----------|---------|-------------|
| `SCOUT_BASE_URL` | `https://scoutsrv.example.com:22160` | Base URL of the Scout Board server. **Must start with `https://`** — the server will refuse to start otherwise. |
| `SCOUT_USERNAME` | `administrator@example.com` | Login username for the Scout Board API. |
| `SCOUT_PASSWORD` | `s3cr3t` | Login password. Never commit this value. |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `SCOUT_DOMAIN` | `""` (empty string) | Login domain. Most deployments leave this empty. |
| `SCOUT_IGNORE_TLS` | `false` | Set `true` to disable TLS certificate verification. See [TLS section](#tls) below. |
| `SCOUT_REQUEST_TIMEOUT_MS` | `30000` | HTTP request timeout in milliseconds. |
| `SCOUT_ENV` | `production` | Runtime mode. Set `test` to enable test-scope guards (see [Test mode](#test-mode)). |

### Required for tests only

| Variable | Example | Description |
|----------|---------|-------------|
| `SCOUT_TEST_OU_PATH` | `/MCP-Test` | OU path that the test suite is allowed to write to. All destructive test operations are confined here. The test runner aborts immediately if this is not set. |

---

## TLS

When the Scout Board server uses a self-signed certificate, set:

```
SCOUT_IGNORE_TLS=true
```

This disables certificate verification **only** for requests made by this MCP server. It does not set `NODE_TLS_REJECT_UNAUTHORIZED` globally and does not affect other processes or libraries in the same Node.js process.

**Do not set `SCOUT_IGNORE_TLS=true` in production** unless you fully understand the man-in-the-middle risk. In production, obtain a properly signed certificate or pin the server's certificate via a custom CA bundle.

---

## Test mode

Setting `SCOUT_ENV=test` enables test-scope guards in destructive tools (`ou_manage`, `device_manage`, `device_command`, etc.): any operation that would modify or delete a resource is rejected unless the target device or OU path is under `SCOUT_TEST_OU_PATH`.

In the default `production` mode, no automatic scope guard is applied — the MCP caller is responsible for targeting the correct resources. Every destructive tool documents this in its `description` field.

---

## Authentication details

Credentials are encoded as base64 JSON and sent to `POST /auth/v1/login`. The returned JWT is stored **in memory only** — it is never written to disk, logged, or exposed in environment variables.

If a request returns HTTP 401, the server re-authenticates once using the stored `SCOUT_USERNAME` / `SCOUT_PASSWORD` and retries the request. If the second attempt also fails, the error is surfaced to the MCP client.

JWT values are never logged in any form. In debug output, the server logs `[JWT present: true/false]` as a boolean only.

---

## Example `.env` file

```dotenv
# Required
SCOUT_BASE_URL=https://scoutsrv.example.com:22160
SCOUT_USERNAME=administrator@example.com
SCOUT_PASSWORD=CHANGE_ME

# Optional
SCOUT_DOMAIN=
SCOUT_IGNORE_TLS=false
SCOUT_REQUEST_TIMEOUT_MS=30000
SCOUT_ENV=production

# Required only when running tests
SCOUT_TEST_OU_PATH=/MCP-Test
```

The `.env.example` at the project root contains the same structure without real credentials.
