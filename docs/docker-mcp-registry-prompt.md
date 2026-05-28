# Prompt: Set up Docker MCP Registry submission + auto-update workflow

Paste the block below into a Claude session inside the target MCP project.

---

```
I want to do three things for this MCP server project:

1. Containerise it with Docker so it runs as a stdio MCP server
2. Generate the submission files for the Docker MCP Registry (github.com/docker/mcp-registry)
3. Add a GitHub Actions workflow that automatically updates the registry entry on every push to main

---

## Step 1 — Docker

Create a two-stage Dockerfile at the repo root:
- Stage 1 (builder): install all deps, compile TypeScript with `npm run build`
- Stage 2 (runtime): prod deps only, copy dist/, run as non-root `node` user, CMD ["node", "dist/index.js"]

Create a .dockerignore excluding: node_modules/, dist/, .env, .env.*, .git/, tests/, docs/, *.md, *.zip, .DS_Store

Build the image locally as `<project-slug>-mcp` (derive the slug from the package.json name) and smoke-test it:
  echo "" | docker run --rm -i <image> && echo "exit: $?"
It should exit 0.

Update .mcp.json to launch via:
  docker run --rm -i --env-file /absolute/path/to/.env <image>
instead of calling node directly.

---

## Step 2 — catalog/server.yaml and catalog/tools.json

Read every tool file in src/tools/ to get the exact tool names, descriptions, and input arguments.

Create catalog/tools.json — an array with one entry per tool:
  [
    {
      "name": "<tool name from the tool export>",
      "description": "<tool description from the tool export>",
      "arguments": [
        { "name": "<arg>", "type": "<string|boolean|integer|object>", "desc": "<zod .describe() text>" }
      ]
    }
  ]
Include every argument from the Zod schema. Use type "object" for z.record() fields.

Create catalog/server.yaml:
  name: <project-slug>-mcp
  image: mcp/<project-slug>-mcp
  type: server
  meta:
    category: developer-tools
    tags: [<2-4 relevant tags>]
  about:
    title: <Human title>
    description: >
      <2-3 sentence description of what the server manages>
    icon: https://avatars.githubusercontent.com/u/<github-org-id>?v=4
  source:
    project: https://github.com/<org>/<repo>
    commit: <current HEAD sha from git rev-parse HEAD>
  config:
    description: >
      <How to connect — what credentials are needed>
    secrets:
      - name: <project-slug>-mcp.<secret_env_var_lowercase>
        env: <SECRET_ENV_VAR>
        example: your-password-here
    env:
      - name: <ENV_VAR>
        example: <example value>
      # repeat for each non-secret env var

Identify which env vars are secrets (passwords, tokens, API keys) vs plain config (URLs, usernames, flags).

---

## Step 3 — GitHub Actions workflow

Create .github/workflows/update-mcp-registry.yml:

  name: Update Docker MCP Registry

  on:
    push:
      branches: [main]
    workflow_dispatch:

  jobs:
    update-registry:
      runs-on: ubuntu-latest
      permissions:
        contents: read

      steps:
        - name: Checkout
          uses: actions/checkout@v4

        - name: Push update to mcp-registry fork and open PR
          env:
            GH_TOKEN: ${{ secrets.MCP_REGISTRY_TOKEN }}
            COMMIT_SHA: ${{ github.sha }}
            COMMIT_MSG: ${{ github.event.head_commit.message }}
          run: |
            SHORT_SHA="${COMMIT_SHA:0:7}"

            git clone "https://x-access-token:${GH_TOKEN}@github.com/<github-username>/mcp-registry.git" /tmp/mcp-registry
            cd /tmp/mcp-registry

            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"

            git remote add upstream https://github.com/docker/mcp-registry.git
            git fetch upstream
            git checkout main
            git reset --hard upstream/main
            git push origin main --force

            git checkout -B update-<project-slug>-mcp

            mkdir -p servers/<project-slug>-mcp
            cp "$GITHUB_WORKSPACE/catalog/server.yaml" servers/<project-slug>-mcp/
            cp "$GITHUB_WORKSPACE/catalog/tools.json" servers/<project-slug>-mcp/
            sed -i "s/  commit: .*/  commit: ${COMMIT_SHA}/" servers/<project-slug>-mcp/server.yaml

            git add servers/<project-slug>-mcp/

            if git diff --staged --quiet; then
              echo "No changes — skipping."
              exit 0
            fi

            git commit -m "Update <project-slug>-mcp to ${SHORT_SHA}

            ${COMMIT_MSG}"

            git push origin update-<project-slug>-mcp --force

            EXISTING_PR=$(gh pr list \
              --repo docker/mcp-registry \
              --head "<github-username>:update-<project-slug>-mcp" \
              --json number \
              --jq '.[0].number' 2>/dev/null)

            if [ -z "$EXISTING_PR" ]; then
              gh pr create \
                --repo docker/mcp-registry \
                --head "<github-username>:update-<project-slug>-mcp" \
                --base main \
                --title "Update <Human title> MCP to ${SHORT_SHA}" \
                --body "Automated update from [\`${SHORT_SHA}\`](https://github.com/<org>/<repo>/commit/${COMMIT_SHA}).

            **Commit:** ${COMMIT_MSG}

            ---
            *Opened automatically by the [update-mcp-registry workflow](https://github.com/<org>/<repo>/actions/workflows/update-mcp-registry.yml).*"
            else
              echo "PR #${EXISTING_PR} already open — updated via force push."
            fi

Fill in all <placeholders> with real values derived from the project (package.json, git remote, GitHub org).

---

## Step 4 — Submit to the registry

Prerequisites (install if missing):
  brew install go-task

Fork docker/mcp-registry if not already done:
  gh repo fork docker/mcp-registry --clone=false

Clone the fork, create the submission branch, run the build validator, and open the PR:
  git clone https://github.com/<github-username>/mcp-registry.git /tmp/mcp-registry
  cd /tmp/mcp-registry
  git checkout -b add-<project-slug>-mcp
  mkdir -p servers/<project-slug>-mcp
  cp /path/to/project/catalog/server.yaml servers/<project-slug>-mcp/
  cp /path/to/project/catalog/tools.json  servers/<project-slug>-mcp/
  task build -- --tools <project-slug>-mcp
  task catalog -- <project-slug>-mcp
  git add servers/<project-slug>-mcp/
  git commit -m "Add <Human title> MCP server"
  git push origin add-<project-slug>-mcp
  gh pr create \
    --repo docker/mcp-registry \
    --head "<github-username>:add-<project-slug>-mcp" \
    --title "Add <Human title> MCP server" \
    --body "..."

The `task build -- --tools <project-slug>-mcp` step reads tools.json instead of running the server live,
so no credentials are needed at submission time.

---

## Step 5 — Secret setup (tell the user)

After the workflow is committed, tell the user:

1. Create a GitHub fine-grained PAT at https://github.com/settings/personal-access-tokens/new
   - Repository access: only `<github-username>/mcp-registry`
   - Permissions: Contents (read/write), Pull requests (read/write)

2. Add it as a secret named `MCP_REGISTRY_TOKEN` at:
   https://github.com/<org>/<repo>/settings/secrets/actions/new

3. Re-run the first failed workflow run to verify everything works end-to-end.

---

Commit all new files (Dockerfile, .dockerignore, catalog/, .github/workflows/, updated .mcp.json)
in logical groups with clear commit messages, then push.
```
