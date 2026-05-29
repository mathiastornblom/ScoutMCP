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

The title in the Docker MCP Hub must follow the naming convention:
  "Citrix Unicon Management <ProductName>"
  Examples: "Citrix Unicon Management Scout", "Citrix Unicon Management ELIAS"
  Derive <ProductName> from the product this MCP server manages.

Create catalog/server.yaml:
  name: <project-slug>-mcp
  image: mcp/<project-slug>-mcp
  type: server
  meta:
    category: developer-tools
    tags: [<2-4 relevant tags>]
  about:
    title: Citrix Unicon Management <ProductName>
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

            git commit -m "Update <project-slug>-mcp to ${SHORT_SHA}: ${COMMIT_MSG}"

            git push origin update-<project-slug>-mcp --force

            {
              echo "Automated update from [<ProductName>@\`${SHORT_SHA}\`](https://github.com/<org>/<repo>/commit/${COMMIT_SHA})."
              echo ""
              echo "**Commit:** ${COMMIT_MSG}"
              echo ""
              echo "---"
              echo "*Opened automatically by the [update-mcp-registry workflow](https://github.com/<org>/<repo>/actions/workflows/update-mcp-registry.yml).*"
            } > /tmp/pr-body.md

            # Create PR — if one already exists the branch update above is sufficient
            CREATE_OUT=$(gh pr create \
              --repo docker/mcp-registry \
              --head "<github-username>:update-<project-slug>-mcp" \
              --base main \
              --title "Update Citrix Unicon Management <ProductName> to ${SHORT_SHA}" \
              --body-file /tmp/pr-body.md 2>&1) && echo "$CREATE_OUT" || {
              if echo "$CREATE_OUT" | grep -q "already exists"; then
                echo "PR already open — branch updated via force push."
              else
                echo "$CREATE_OUT" && exit 1
              fi
            }

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
  git commit -m "Add Citrix Unicon Management <ProductName> MCP server"
  git push origin add-<project-slug>-mcp
  gh pr create \
    --repo docker/mcp-registry \
    --head "<github-username>:add-<project-slug>-mcp" \
    --title "Add Citrix Unicon Management <ProductName> MCP server" \
    --body "..."

The `task build -- --tools <project-slug>-mcp` step reads tools.json instead of running the server live,
so no credentials are needed at submission time.

After opening the PR, add a comment explaining why test credentials cannot be provided:

  gh pr comment <pr-number> --repo docker/mcp-registry --body "Hi Docker team 👋

  We're unable to provide test credentials for this submission. **<ProductName>** is an
  on-premise enterprise server by Unicon/Citrix — there is no public cloud instance or
  sandbox environment. Testing requires a full on-premise installation within a
  customer's own infrastructure.

  We have included \`tools.json\` with all tools statically defined, so
  \`task build --tools <project-slug>-mcp\` completes successfully without a live server.
  The full source code is open for review at https://github.com/<org>/<repo>.

  Happy to answer any questions about the implementation or the platform."

Do NOT submit the Docker test credentials Google Form — it is intended for cloud services
with shareable API keys, not on-premise enterprise servers.

---

## Step 5 — Secret setup (tell the user)

After the workflow is committed, tell the user:

1. Create a GitHub classic PAT at https://github.com/settings/tokens/new
   - Scope: public_repo (required for cross-org PR creation to docker/mcp-registry)
   - Do NOT use a fine-grained PAT — it cannot open PRs on repos in other organisations

2. Add it as a secret named `MCP_REGISTRY_TOKEN` at:
   https://github.com/<org>/<repo>/settings/secrets/actions/new

3. Re-run the first failed workflow run to verify everything works end-to-end.

---

Commit all new files (Dockerfile, .dockerignore, catalog/, .github/workflows/, updated .mcp.json)
in logical groups with clear commit messages, then push.
```
