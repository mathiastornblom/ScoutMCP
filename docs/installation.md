# Installation

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 20 or later | Native `fetch` and `undici` required |
| npm | 9 or later | Bundled with Node.js 20 |
| Scout Board server | any | Must be reachable from the host running this server |

## Steps

### 1. Clone and install dependencies

```bash
git clone <repo-url> scout-mcp-server
cd scout-mcp-server
npm install
```

### 2. Configure environment

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

See [configuration.md](configuration.md) for a full reference of every variable.

### 3. Build

```bash
npm run build
```

Output goes to `dist/`. The entry point is `dist/index.js`.

### 4. Run

**Production (compiled output):**

```bash
npm start
```

**Development (live TypeScript via tsx):**

```bash
npm run dev
```

The MCP server communicates over **stdio** — it has no HTTP port of its own.

---

## Connecting to an MCP client

### Claude Desktop

Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "scout-board": {
      "command": "node",
      "args": ["/absolute/path/to/scout-mcp-server/dist/index.js"],
      "env": {
        "SCOUT_BASE_URL": "https://your-scout-server:22160",
        "SCOUT_USERNAME": "administrator@example.com",
        "SCOUT_PASSWORD": "your-password",
        "SCOUT_DOMAIN": "",
        "SCOUT_IGNORE_TLS": "false"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

### Other MCP clients

Pass the same environment variables via whatever mechanism your client supports. The server reads them at startup.

---

## Running the test suite

Tests require a live Scout Board server and a dedicated test OU. Set `SCOUT_TEST_OU_PATH` before running:

```bash
SCOUT_TEST_OU_PATH=/MCP-Test SCOUT_ENV=test npx tsx tests/integration.ts
```

**The test suite will refuse to start if `SCOUT_TEST_OU_PATH` is not set.** All write operations during tests are confined to that OU path and cleaned up in `finally` blocks.

See [configuration.md](configuration.md) for the full variable reference.
