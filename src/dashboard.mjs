import { AGENT_NAMES } from './agents/names.mjs';
import { deriveNextMove, fetchPullRequests, Owner } from './github.mjs';
import { listSessions, listWorktrees } from './sessions.mjs';

/**
 * Mark muted pull requests and recount the ones that need attention.
 */

export function applyMutes(dashboard, mutedUrls) {
  for (const pullRequest of dashboard.pullRequests) {
    pullRequest.isMuted = mutedUrls.has(pullRequest.url);
    pullRequest.needsAttention = pullRequest.nextMove.owner === Owner.You && !pullRequest.isDraft && !pullRequest.isMuted;
  }

  dashboard.attentionCount = dashboard.pullRequests.filter(pullRequest => pullRequest.needsAttention).length;

  return dashboard;
}

/**
 * Build the dashboard state: pull requests with next move, attention flag, worktrees, sessions and stacks.
 */

export async function buildDashboard(mutedUrls) {
  const [pullRequests, sessions, worktrees] = await Promise.all([
    fetchPullRequests(),
    listSessions(),
    listWorktrees().catch(() => [])
  ]);

  for (const pullRequest of pullRequests) {
    const linkedWorktrees = findWorktrees(pullRequest, worktrees);
    const repositoryFolders = worktrees
      .filter(worktree => worktree.repository === pullRequest.repository)
      .map(worktree => worktree.path);

    pullRequest.nextMove = deriveNextMove(pullRequest);
    pullRequest.sessions = findSessions(pullRequest, sessions, repositoryFolders);
    pullRequest.cost = pullRequest.sessions.reduce((total, session) => total + session.cost, 0);
    pullRequest.worktrees = linkedWorktrees.map(worktree => ({ id: worktree.id, name: worktree.name, path: worktree.path }));
  }

  linkStacks(pullRequests);

  return applyMutes({ pullRequests, refreshedAt: new Date().toISOString() }, mutedUrls);
}

/**
 * Find the agent sessions that created the pull request or worked on its branch.
 */

function findSessions(pullRequest, sessions, repositoryFolders) {
  return sessions
    .filter(session => {
      if (session.pullRequestUrls.has(pullRequest.url)) {
        return true;
      }

      return (
        session.branches.has(pullRequest.headBranch) &&
        Boolean(session.cwd) &&
        repositoryFolders.some(folder => isInside(session.cwd, folder))
      );
    })
    .map(session => ({
      agentName: AGENT_NAMES[session.agent] ?? session.agent,
      cost: session.cost,
      id: session.id,
      lastActivityAt: session.lastActivityAt,
      title: session.title ?? 'Untitled session'
    }))
    .sort((first, second) => (second.lastActivityAt ?? '').localeCompare(first.lastActivityAt ?? ''));
}

/**
 * Find the Orca worktrees that are not archived and are checked out on, or linked to, a pull request, most recently active first.
 */

function findWorktrees(pullRequest, worktrees) {
  return worktrees
    .filter(
      worktree =>
        !worktree.isArchived &&
        (worktree.linkedPullRequestUrls.includes(pullRequest.url) ||
          (worktree.repository === pullRequest.repository &&
            (worktree.branch === pullRequest.headBranch || worktree.linkedPullRequest === pullRequest.number)))
    )
    .sort((first, second) => second.lastActivityAt - first.lastActivityAt);
}

/**
 * Check whether a path is the given folder or lives inside it.
 */

function isInside(path, folder) {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Link each pull request to the open pull request it is stacked on, within the same repository.
 */

function linkStacks(pullRequests) {
  const byHead = new Map(pullRequests.map(pullRequest => [`${pullRequest.repository}:${pullRequest.headBranch}`, pullRequest]));

  for (const pullRequest of pullRequests) {
    pullRequest.parentUrl = byHead.get(`${pullRequest.repository}:${pullRequest.baseBranch}`)?.url ?? null;
  }
}
