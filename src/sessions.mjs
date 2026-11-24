import { listClaudeSessions } from './agents/claude.mjs';
import { listCodexSessions } from './agents/codex.mjs';
import { runJsonCommand } from './commands.mjs';

const SESSION_SOURCES = [listClaudeSessions, listCodexSessions];

/**
 * List the agent sessions on this machine from every supported agent, skipping an agent whose sessions cannot be read.
 */

export async function listSessions() {
  const sessions = await Promise.all(SESSION_SOURCES.map(listSource => listSource().catch(() => [])));

  return sessions.flat();
}

/**
 * List the Orca worktrees with their repository, branch and linked pull requests.
 */

export async function listWorktrees() {
  const response = await runJsonCommand('orca', ['worktree', 'list', '--json']);
  const worktrees = Array.isArray(response.result) ? response.result : response.result.worktrees;

  return worktrees.map(worktree => ({
    branch: worktree.branch?.replace(/^refs\/heads\//, '') ?? null,
    id: worktree.id,
    isArchived: Boolean(worktree.isArchived),
    lastActivityAt: worktree.lastActivityAt ?? 0,
    linkedPullRequest: worktree.linkedPR,
    linkedPullRequestUrls: (worktree.linkedItems ?? []).filter(item => item.type === 'pr').map(item => item.url),
    name: worktree.displayName,
    path: worktree.path,
    repository: worktree.projectId?.replace(/^github:/, '') ?? null
  }));
}
