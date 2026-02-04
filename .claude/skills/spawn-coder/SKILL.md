---
name: spawn-coder
description: Add ability to spawn Modal.com cloud coding agents. The bot can create isolated Claude Code instances that clone repos, implement fixes, create branches, and open PRs. Use when user wants to add cloud coding capabilities.
---

# Spawn Coder - Modal Cloud Coding Agents

This skill adds the ability to spawn cloud-based coding agents via Modal.com. The agent can delegate coding tasks to isolated Claude Code instances that have full git access.

## What This Enables

Your assistant can:
- Spawn a cloud coding agent on demand
- Clone any git repository
- Create feature branches
- Implement fixes or features
- Commit and push changes
- Create pull requests via GitHub CLI

## Prerequisites

### 1. Modal Account & Token

**USER ACTION REQUIRED**

Tell the user:

> I need Modal.com credentials to spawn cloud coding agents.
>
> 1. Create account at https://modal.com
> 2. Go to Settings → API Tokens
> 3. Create a new token
> 4. Copy both the Token ID and Token Secret

Store the credentials in `.env`:
```
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

### 2. Create Modal Secret for Anthropic Key

The coding agents need an Anthropic API key. Create a Modal secret:

```bash
pip install modal
modal secret create anthropic-coder-secret ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
```

### 3. (Optional) GitHub Token for PRs

If you want agents to create PRs:

```bash
modal secret create github-coder-secret GITHUB_TOKEN=ghp_...
```

---

## Implementation

### Step 1: Install Modal SDK

Add Modal to the agent container:

```bash
cd container/agent-runner
npm install modal
```

### Step 2: Create Coder Spawner Module

Create `container/agent-runner/src/modal-coder.ts`:

```typescript
import { ModalClient } from 'modal';

export interface CoderTask {
  repoUrl: string;
  taskDescription: string;
  branch?: string;
  baseBranch?: string;
  createPr?: boolean;
  prTitle?: string;
}

export interface CoderResult {
  success: boolean;
  output: string;
  branch?: string;
  prUrl?: string;
  error?: string;
}

export async function spawnCoder(task: CoderTask): Promise<CoderResult> {
  const modal = new ModalClient();

  // Create or get app
  const app = await modal.apps.fromName('nanoclaw-coder', {
    createIfMissing: true,
  });

  // Define image with Claude Code and git
  const image = modal.images
    .fromRegistry('node:22-slim')
    .dockerfileCommands([
      'RUN apt-get update && apt-get install -y curl git gh ripgrep && rm -rf /var/lib/apt/lists/*',
      'RUN curl -fsSL https://claude.ai/install.sh | bash',
      'ENV PATH=/root/.local/bin:$PATH',
    ]);

  // Create sandbox
  const sb = await modal.sandboxes.create(app, image, {
    timeoutSecs: 1800, // 30 min max
  });

  console.log(`[modal-coder] Started sandbox: ${sb.sandboxId}`);

  try {
    // Clone repo
    const repoName = task.repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
    const git = await sb.exec(['git', 'clone', task.repoUrl, `/workspace/${repoName}`]);
    await git.wait();

    const workdir = `/workspace/${repoName}`;

    // Create branch if specified
    if (task.branch) {
      const baseBranch = task.baseBranch || 'main';
      const checkout = await sb.exec(
        ['git', 'checkout', '-b', task.branch, `origin/${baseBranch}`],
        { workdir }
      );
      await checkout.wait();
    }

    // Build the prompt with git instructions
    const prompt = buildCoderPrompt(task);

    // Run Claude Code
    const secrets = [
      await modal.secrets.fromName('anthropic-coder-secret', {
        requiredKeys: ['ANTHROPIC_API_KEY'],
      }),
    ];

    // Add GitHub secret if creating PR
    if (task.createPr) {
      secrets.push(
        await modal.secrets.fromName('github-coder-secret', {
          requiredKeys: ['GITHUB_TOKEN'],
        })
      );
    }

    const claude = await sb.exec(
      ['claude', '-p', prompt, '--dangerously-skip-permissions'],
      {
        pty: true,
        secrets,
        workdir,
      }
    );
    await claude.wait();

    const output = await claude.stdout.readText();
    const stderr = await claude.stderr.readText();

    // Check for PR URL in output
    const prMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);

    return {
      success: true,
      output: output + (stderr ? `\n\nStderr:\n${stderr}` : ''),
      branch: task.branch,
      prUrl: prMatch ? prMatch[0] : undefined,
    };

  } catch (err) {
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await sb.terminate();
    console.log(`[modal-coder] Sandbox terminated`);
  }
}

function buildCoderPrompt(task: CoderTask): string {
  let prompt = `You are a coding agent. Complete the following task:\n\n${task.taskDescription}\n\n`;

  prompt += `Git workflow instructions:\n`;

  if (task.branch) {
    prompt += `- You are on branch: ${task.branch}\n`;
    prompt += `- Make your changes and commit them with clear commit messages\n`;
    prompt += `- Push the branch: git push -u origin ${task.branch}\n`;
  }

  if (task.createPr && task.prTitle) {
    prompt += `- After pushing, create a PR using: gh pr create --title "${task.prTitle}" --body "Automated PR from coding agent"\n`;
  }

  prompt += `\nWhen done, output a summary of what you changed.`;

  return prompt;
}
```

### Step 3: Add MCP Tool

Edit `container/agent-runner/src/ipc-mcp.ts` and add the spawn_coder tool:

```typescript
import { spawnCoder, CoderTask } from './modal-coder.js';

// Add to tools array:
tool(
  'spawn_coder',
  'Spawn a cloud coding agent to work on a git repository. The agent will clone the repo, implement changes, and optionally create a PR.',
  {
    repo_url: z.string().describe('Git repository URL to clone'),
    task: z.string().describe('Description of what the coding agent should do'),
    branch: z.string().optional().describe('Branch name to create for changes'),
    base_branch: z.string().optional().describe('Base branch to branch from (default: main)'),
    create_pr: z.boolean().optional().describe('Whether to create a pull request'),
    pr_title: z.string().optional().describe('Title for the pull request'),
  },
  async (args) => {
    const task: CoderTask = {
      repoUrl: args.repo_url,
      taskDescription: args.task,
      branch: args.branch,
      baseBranch: args.base_branch,
      createPr: args.create_pr,
      prTitle: args.pr_title,
    };

    const result = await spawnCoder(task);

    if (result.success) {
      let response = `Coding agent completed successfully.\n\n${result.output}`;
      if (result.prUrl) {
        response += `\n\nPull Request: ${result.prUrl}`;
      }
      return response;
    } else {
      return `Coding agent failed: ${result.error}`;
    }
  }
),
```

### Step 4: Add Modal Credentials to Container

Edit `src/container-runner.ts` and add Modal tokens to the allowed environment variables:

```typescript
const allowedVars = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'LINEAR_API_KEY',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
];
```

### Step 5: Update CLAUDE.md

Add to `groups/main/CLAUDE.md`:

```markdown
## Cloud Coding Agents (Modal)

You can spawn cloud coding agents to work on repositories:

Use `mcp__nanoclaw__spawn_coder` with:
- `repo_url` - Git repository URL
- `task` - What the agent should do
- `branch` - (optional) Branch name for changes
- `base_branch` - (optional) Base branch (default: main)
- `create_pr` - (optional) Whether to create a PR
- `pr_title` - (optional) PR title

Example:
"Spawn a coder to fix the login bug in github.com/user/repo, create a branch called fix-login, and open a PR"
```

### Step 6: Rebuild

```bash
cd container/agent-runner && npm install && npm run build
cd ../.. && ./container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Usage Examples

**Simple fix:**
> @m87 spawn a coder to add input validation to the signup form in github.com/mycompany/webapp

**With branch and PR:**
> @m87 spawn a coder on github.com/mycompany/api to fix issue #42. Create branch fix/issue-42 and open a PR titled "Fix authentication timeout"

**Code review task:**
> @m87 spawn a coder to review github.com/mycompany/lib and add missing TypeScript types, branch add-types, create PR

---

## Troubleshooting

### Modal authentication failed

```bash
# Verify tokens are set
echo $MODAL_TOKEN_ID
echo $MODAL_TOKEN_SECRET

# Test Modal connection
npx modal --version
```

### Sandbox times out

Increase `timeoutSecs` in the sandbox creation, or break the task into smaller pieces.

### GitHub PR creation fails

1. Ensure `github-coder-secret` exists in Modal
2. Verify the token has `repo` scope
3. Check if the repo allows PRs from the token's user

### Claude Code not found in sandbox

The image build may have failed. Check Modal dashboard for build logs.

---

## Costs

- **Modal sandbox**: ~$0.10-0.50 per task (depends on duration)
- **Claude API tokens**: Usage-based
- **Typical task**: $0.20-1.00 total

---

## Security Notes

1. Sandboxes are isolated - they can't access your local files
2. Git credentials are passed via Modal secrets, not stored in code
3. Each sandbox is destroyed after the task completes
4. Network access can be restricted via Modal's `cidr_allowlist`
