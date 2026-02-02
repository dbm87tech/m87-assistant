---
name: add-linear
description: Add Linear project management integration to NanoClaw. Gives the agent access to issues, projects, and teams via the mcp-linear server with API key authentication. Works on headless servers.
---

# Add Linear Integration

This skill adds Linear project management capabilities to NanoClaw via the `mcp-linear` npm package. The agent will be able to:

- Search and query issues
- Create and update issues
- Manage projects and cycles
- View team information
- Comment on issues

## Prerequisites

### 1. Get Linear API Key

**USER ACTION REQUIRED**

Tell the user:

> I need a Linear Personal API Key. To create one:
>
> 1. Go to **Linear Settings > Security & access**
> 2. Find **Personal API keys** section
> 3. Click **New API key**
> 4. Give it a name (e.g., "NanoClaw")
> 5. Copy the token (starts with `lin_api_...`)
>
> Paste the API key here.

Store the API key securely.

---

## Implementation

### Step 1: Add API Key to Environment

Read `.env` and add the Linear API key:

```bash
# Append to .env
echo "" >> .env
echo "# Linear" >> .env
echo "LINEAR_API_KEY=THE_KEY_USER_PROVIDED" >> .env
```

Replace `THE_KEY_USER_PROVIDED` with the actual key.

### Step 2: Add Linear MCP to Agent Runner

Read `container/agent-runner/src/index.ts` and find the `mcpServers` config in the `query()` call.

Add `linear` to the `mcpServers` object:

```typescript
linear: {
  command: 'npx',
  args: ['-y', 'mcp-linear'],
  env: {
    LINEAR_API_KEY: process.env.LINEAR_API_KEY || ''
  }
}
```

Find the `allowedTools` array and add Linear tools:

```typescript
'mcp__linear__*'
```

### Step 3: Pass Linear API Key to Container

Read `src/container-runner.ts` and find the `allowedVars` array in `buildVolumeMounts`.

Add `LINEAR_API_KEY` to the allowed environment variables:

```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'LINEAR_API_KEY'];
```

This ensures the API key is passed through to the container environment.

### Step 4: Update Group Memory

Append to `groups/global/CLAUDE.md`:

```markdown

## Linear (Project Management)

You have access to Linear via MCP tools for project management:

**Query & Search:**
- `mcp__linear__list_issues` - List issues with filters
- `mcp__linear__get_issue` - Get details of a specific issue
- `mcp__linear__search_issues` - Search issues by text
- `mcp__linear__list_projects` - List all projects
- `mcp__linear__list_teams` - List all teams

**Create & Update:**
- `mcp__linear__create_issue` - Create a new issue
- `mcp__linear__update_issue` - Update an existing issue
- `mcp__linear__create_comment` - Add a comment to an issue

**Examples:**
- "What's the status on the auth refactor issue?"
- "Create a Linear issue for the bug we discussed"
- "List all my open issues"
- "Add a comment to ENG-123 saying the fix is deployed"
```

Also append similar documentation to `groups/main/CLAUDE.md`.

### Step 5: Rebuild and Restart

Rebuild the container (required since agent-runner changed):

```bash
cd container && ./build.sh
```

Wait for build to complete, then compile TypeScript:

```bash
cd .. && npm run build
```

Restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Verify it started:

```bash
sleep 2 && launchctl list | grep nanoclaw
```

### Step 6: Test Linear Integration

Tell the user:

> Linear integration is set up! Test it by sending this message in your WhatsApp or Telegram main channel:
>
> `@m87 list my Linear teams`
>
> Or:
>
> `@m87 search for open issues`

Watch the logs for any errors:

```bash
tail -f logs/nanoclaw.log
```

---

## Available Linear Tools

The `mcp-linear` package provides these tools:

| Tool | Description |
|------|-------------|
| `list_issues` | List issues with optional filters |
| `get_issue` | Get issue by ID or identifier (e.g., ENG-123) |
| `search_issues` | Search issues by text query |
| `create_issue` | Create a new issue |
| `update_issue` | Update issue title, description, status, assignee, etc. |
| `create_comment` | Add a comment to an issue |
| `list_teams` | List all teams in the workspace |
| `list_projects` | List projects |

---

## Troubleshooting

### API key invalid or expired

Regenerate the API key in Linear Settings:

1. Go to Linear Settings > Security & access > Personal API keys
2. Delete the old key
3. Create a new one
4. Update `.env` with the new key
5. Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

### Container can't access Linear

1. Verify the API key is in `.env`:
   ```bash
   grep LINEAR_API_KEY .env
   ```

2. Check if the key is in the allowed vars:
   ```bash
   grep LINEAR_API_KEY src/container-runner.ts
   ```

3. Check container logs for auth errors:
   ```bash
   tail -50 groups/main/logs/container-*.log | grep -i linear
   ```

### Linear MCP not loading

Test the MCP directly:

```bash
LINEAR_API_KEY=your_key_here npx -y mcp-linear
```

If it hangs or errors, the package may need updating:

```bash
npm cache clean --force
npx -y mcp-linear@latest
```

---

## Removing Linear Integration

To remove Linear:

1. Remove from `container/agent-runner/src/index.ts`:
   - Delete `linear` from `mcpServers`
   - Remove `mcp__linear__*` from `allowedTools`

2. Remove from `src/container-runner.ts`:
   - Remove `LINEAR_API_KEY` from `allowedVars`

3. Remove from `.env`:
   - Delete `LINEAR_API_KEY` line

4. Remove Linear sections from `groups/*/CLAUDE.md`

5. Rebuild:
   ```bash
   cd container && ./build.sh && cd ..
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
