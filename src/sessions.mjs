import { computeCost } from './pricing.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { runJsonCommand } from './commands.mjs';

const PROJECTS_DIRECTORY = join(homedir(), '.claude', 'projects');
const TRANSCRIPT_CACHE = new Map();

/**
 * List the entries of a directory, or nothing when it does not exist.
 */

async function listDirectory(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Summarize one transcript file: cost, title, working directory, branches and linked pull requests.
 */

async function summarizeTranscript(path) {
  const { mtimeMs, size } = await stat(path);
  const cached = TRANSCRIPT_CACHE.get(path);

  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.summary;
  }

  const content = await readFile(path, 'utf8');
  const messageIds = new Set();
  const summary = { branches: new Set(), cost: 0, cwd: null, lastActivityAt: null, pullRequestUrls: new Set(), title: null };

  for (const line of content.split('\n')) {
    let entry;

    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const message = entry.message;

    summary.cwd ??= entry.cwd ?? null;

    if (entry.gitBranch) {
      summary.branches.add(entry.gitBranch);
    }

    if (entry.prUrl) {
      summary.pullRequestUrls.add(entry.prUrl);
    }

    if (entry.aiTitle) {
      summary.title = entry.aiTitle;
    }

    if (entry.timestamp && (!summary.lastActivityAt || entry.timestamp > summary.lastActivityAt)) {
      summary.lastActivityAt = entry.timestamp;
    }

    if (message?.usage && !messageIds.has(message.id)) {
      messageIds.add(message.id);
      summary.cost += computeCost(message.model, message.usage);
    }
  }

  TRANSCRIPT_CACHE.set(path, { mtimeMs, size, summary });

  return summary;
}

/**
 * List the Claude Code sessions on this machine, with subagent costs added to their parent session.
 */

export async function listSessions() {
  const sessions = [];

  for (const project of await listDirectory(PROJECTS_DIRECTORY)) {
    if (!project.isDirectory()) {
      continue;
    }

    const projectPath = join(PROJECTS_DIRECTORY, project.name);

    for (const file of await listDirectory(projectPath)) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) {
        continue;
      }

      const id = file.name.replace(/\.jsonl$/, '');
      const session = { ...(await summarizeTranscript(join(projectPath, file.name))), id };
      const subagentsPath = join(projectPath, id, 'subagents');

      for (const subagent of await listDirectory(subagentsPath)) {
        if (subagent.isFile() && subagent.name.endsWith('.jsonl')) {
          session.cost += (await summarizeTranscript(join(subagentsPath, subagent.name))).cost;
        }
      }

      sessions.push(session);
    }
  }

  return sessions;
}

/**
 * List the Orca worktrees with their repository and branch.
 */

export async function listWorktrees() {
  const response = await runJsonCommand('orca', ['worktree', 'list', '--json']);
  const worktrees = Array.isArray(response.result) ? response.result : response.result.worktrees;

  return worktrees.map(worktree => ({
    branch: worktree.branch?.replace(/^refs\/heads\//, '') ?? null,
    linkedPullRequest: worktree.linkedPR,
    name: worktree.displayName,
    path: worktree.path,
    repository: worktree.projectId?.replace(/^github:/, '') ?? null
  }));
}
