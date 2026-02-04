/**
 * Modal Cloud Coder - Spawns Claude Code instances in Modal sandboxes
 * Enables cloud-based coding agents that can clone repos, implement changes, and create PRs
 */

import { ModalClient, Secret } from 'modal';

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
  sandboxId?: string;
}

function log(message: string): void {
  console.error(`[modal-coder] ${message}`);
}

function buildCoderPrompt(task: CoderTask): string {
  let prompt = `You are a coding agent. Complete the following task:\n\n${task.taskDescription}\n\n`;

  prompt += `Git workflow instructions:\n`;

  if (task.branch) {
    prompt += `- You are on branch: ${task.branch}\n`;
    prompt += `- Make your changes and commit them with clear commit messages\n`;
    prompt += `- Push the branch: git push -u origin ${task.branch}\n`;
  } else {
    prompt += `- Make changes directly on the current branch\n`;
    prompt += `- Commit with clear commit messages\n`;
  }

  if (task.createPr && task.prTitle) {
    prompt += `- After pushing, create a PR using: gh pr create --title "${task.prTitle}" --body "Automated PR from coding agent"\n`;
    prompt += `- Make sure to output the PR URL\n`;
  }

  prompt += `\nWhen done, output a clear summary of what you changed and any relevant URLs.`;

  return prompt;
}

export async function spawnCoder(task: CoderTask): Promise<CoderResult> {
  // Check for Modal credentials
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    return {
      success: false,
      output: '',
      error: 'Modal credentials not configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.',
    };
  }

  const modal = new ModalClient();

  // Create or get app
  const app = await modal.apps.fromName('nanoclaw-coder', {
    createIfMissing: true,
  });

  // Define image with Claude Code, git, and GitHub CLI
  const image = modal.images
    .fromRegistry('node:22-slim')
    .dockerfileCommands([
      'RUN apt-get update && apt-get install -y curl git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*',
      // Install GitHub CLI
      'RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg',
      'RUN echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
      'RUN apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*',
      // Install Claude Code globally via npm
      'RUN npm install -g @anthropic-ai/claude-code',
    ]);

  log('Creating Modal sandbox...');

  // Create sandbox with timeout (30 min max)
  const sb = await modal.sandboxes.create(app, image, {
    timeoutMs: 1800000,
  });

  log(`Sandbox started: ${sb.sandboxId}`);

  try {
    // Extract repo name from URL
    const repoName = task.repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
    const workdir = `/root/${repoName}`;

    // Get GitHub secret for authentication
    let gitHubSecret: Secret | undefined;
    try {
      gitHubSecret = await modal.secrets.fromName('github-coder-secret', {
        requiredKeys: ['GITHUB_TOKEN'],
      });
      log('GitHub credentials available');
    } catch (err) {
      log('No github-coder-secret found, cloning without auth (public repos only)');
    }

    // Always configure git user for the coder user (for commits)
    const gitUserConfig = await sb.exec(
      ['bash', '-c', `
        su - coder -c "git config --global user.email 'coder@nanoclaw.ai'"
        su - coder -c "git config --global user.name 'NanoClaw Coder'"
      `]
    );
    await gitUserConfig.wait();

    // Configure git credential helper if we have GitHub token (for both root and coder user)
    if (gitHubSecret) {
      log('Configuring git credentials...');
      const configCreds = await sb.exec(
        ['bash', '-c', `
          # Configure for root (used during clone)
          git config --global credential.helper 'store --file=/tmp/git-credentials'
          echo "https://x-access-token:\${GITHUB_TOKEN}@github.com" > /tmp/git-credentials
          chmod 644 /tmp/git-credentials
          git config --global url."https://x-access-token:\${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
          # Configure for coder user (used during push)
          su - coder -c "git config --global credential.helper 'store --file=/tmp/git-credentials'"
          su - coder -c "git config --global url.'https://x-access-token:\${GITHUB_TOKEN}@github.com/'.insteadOf 'https://github.com/'"
          su - coder -c "git config --global user.email 'coder@nanoclaw.ai'"
          su - coder -c "git config --global user.name 'NanoClaw Coder'"
        `],
        { secrets: [gitHubSecret] }
      );
      const configExitCode = await configCreds.wait();
      if (configExitCode !== 0) {
        log(`Git credential config failed (exit ${configExitCode}): ${await configCreds.stderr.readText()}`);
      }
    }

    // Clone repository
    log(`Cloning ${task.repoUrl}...`);
    const cloneSecrets: Secret[] = gitHubSecret ? [gitHubSecret] : [];

    const clone = await sb.exec(
      ['git', 'clone', '--depth', '50', task.repoUrl, workdir],
      cloneSecrets.length > 0 ? { secrets: cloneSecrets } : undefined
    );
    const cloneExitCode = await clone.wait();

    const cloneStdout = await clone.stdout.readText();
    const cloneStderr = await clone.stderr.readText();

    log(`Clone exit code: ${cloneExitCode}`);
    if (cloneStderr) {
      log(`Clone stderr: ${cloneStderr}`);
    }

    if (cloneExitCode !== 0) {
      return {
        success: false,
        output: '',
        error: `Git clone failed (exit ${cloneExitCode}): ${cloneStderr || cloneStdout}`,
        sandboxId: sb.sandboxId,
      };
    }

    log(`Successfully cloned to ${workdir}`);

    // Create branch if specified
    if (task.branch) {
      const baseBranch = task.baseBranch || 'main';
      log(`Creating branch ${task.branch} from ${baseBranch}...`);

      // Fetch the base branch first
      const fetch = await sb.exec(['git', 'fetch', 'origin', baseBranch], { workdir });
      await fetch.wait();

      // Create and checkout new branch
      const checkout = await sb.exec(
        ['git', 'checkout', '-b', task.branch, `origin/${baseBranch}`],
        { workdir }
      );
      await checkout.wait();
    }

    // Build prompt
    const prompt = buildCoderPrompt(task);

    log('Running Claude Code agent...');

    // Prepare secrets - always include GitHub for push operations
    const agentSecrets: Secret[] = [
      await modal.secrets.fromName('anthropic-coder-secret', {
        requiredKeys: ['ANTHROPIC_API_KEY'],
      }),
    ];

    // Add GitHub secret for push/PR operations
    if (gitHubSecret) {
      agentSecrets.push(gitHubSecret);
    }

    // Create settings.json for root user to pre-approve permissions
    const setupSettings = await sb.exec([
      'bash', '-c',
      `mkdir -p /root/.claude && echo '{"permissions":{"allow":["Bash(*)","Read(*)","Write(*)","Edit(*)","Glob(*)","Grep(*)","WebFetch(*)","WebSearch(*)"],"deny":[]}}' > /root/.claude/settings.json`
    ]);
    await setupSettings.wait();

    // Write prompt to file to avoid escaping issues
    const promptB64 = Buffer.from(prompt).toString('base64');
    const writePrompt = await sb.exec([
      'bash', '-c', `echo '${promptB64}' | base64 -d > /tmp/prompt.txt`
    ]);
    await writePrompt.wait();

    log(`Running claude with prompt (${prompt.length} chars)...`);

    // Run Claude as root with timeout, verbose output, and stdin closed
    // Combine stdout and stderr with 2>&1 for reliable capture
    const claude = await sb.exec(
      ['bash', '-c',
       `cd '${workdir}' && timeout 1200 claude -p "$(cat /tmp/prompt.txt)" --output-format text < /dev/null 2>&1`],
      {
        secrets: agentSecrets,
        timeoutMs: 1500000,
      }
    );

    const claudeExit = await claude.wait();
    const stdout = await claude.stdout.readText();
    const stderr = await claude.stderr.readText();

    log(`Agent completed with exit code ${claudeExit}, stdout: ${stdout.length} chars`);
    if (stdout.length === 0) {
      log(`No output captured, stderr: ${stderr.slice(0, 500)}`);
    }

    // Check for PR URL in output
    const prMatch = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);

    // Combine output
    let output = stdout;
    if (stderr && stderr.trim()) {
      output += `\n\n--- Agent Logs ---\n${stderr}`;
    }

    return {
      success: true,
      output,
      branch: task.branch,
      prUrl: prMatch ? prMatch[0] : undefined,
      sandboxId: sb.sandboxId,
    };

  } catch (err) {
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      sandboxId: sb.sandboxId,
    };
  } finally {
    log('Terminating sandbox...');
    await sb.terminate();
    log('Sandbox terminated');
  }
}
