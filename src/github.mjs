import { runJsonCommand } from './commands.mjs';

const PULL_REQUESTS_QUERY = `
query {
  viewer { login }
  search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        baseRefName
        headRefName
        isDraft
        mergeable
        number
        reviewDecision
        title
        updatedAt
        url
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        repository { nameWithOwner }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { ... on Team { name } ... on User { login } } }
        }
        reviewThreads(first: 100) {
          nodes { isResolved comments(last: 1) { nodes { author { login } } } }
        }
      }
    }
  }
}`;

export const Checks = { Failing: 'failing', None: 'none', Passing: 'passing', Pending: 'pending' };
export const Owner = { Checks: 'checks', Reviewers: 'reviewers', You: 'you' };

/**
 * Map a GitHub status check rollup state to a checks status.
 */

function toChecks(state) {
  if (!state) {
    return Checks.None;
  }

  if (state === 'SUCCESS') {
    return Checks.Passing;
  }

  if (state === 'FAILURE' || state === 'ERROR') {
    return Checks.Failing;
  }

  return Checks.Pending;
}

/**
 * Decide who owns the next move on a pull request, and why.
 */

export function deriveNextMove(pullRequest) {
  if (pullRequest.isDraft) {
    return { owner: Owner.You, reason: 'Finish the draft' };
  }

  if (pullRequest.hasConflicts) {
    return { owner: Owner.You, reason: 'Resolve merge conflicts' };
  }

  if (pullRequest.checks === Checks.Failing) {
    return { owner: Owner.You, reason: 'Fix failing checks' };
  }

  if (pullRequest.reviewDecision === 'CHANGES_REQUESTED') {
    return { owner: Owner.You, reason: 'Address requested changes' };
  }

  if (pullRequest.threadsAwaitingReply > 0) {
    return { owner: Owner.You, reason: `Reply to ${pullRequest.threadsAwaitingReply} open thread(s)` };
  }

  if (pullRequest.checks === Checks.Pending) {
    return { owner: Owner.Checks, reason: 'Waiting for checks' };
  }

  if (pullRequest.reviewDecision === 'APPROVED') {
    return { owner: Owner.You, reason: 'Merge it' };
  }

  if (pullRequest.requestedReviewers.length > 0) {
    return { owner: Owner.Reviewers, reason: `Waiting for ${pullRequest.requestedReviewers.join(', ')}` };
  }

  return { owner: Owner.You, reason: 'Request a review' };
}

/**
 * Fetch the open pull requests authored by the signed in GitHub user.
 */

export async function fetchPullRequests() {
  const response = await runJsonCommand('gh', ['api', 'graphql', '-f', `query=${PULL_REQUESTS_QUERY}`]);
  const viewerLogin = response.data.viewer.login;

  return response.data.search.nodes
    .filter(node => node.url)
    .map(node => {
      const reviewers = node.reviewRequests.nodes
        .map(request => request.requestedReviewer?.login ?? request.requestedReviewer?.name)
        .filter(Boolean);
      const threadsAwaitingReply = node.reviewThreads.nodes.filter(thread => {
        const lastAuthor = thread.comments.nodes[0]?.author?.login;

        return !thread.isResolved && lastAuthor && lastAuthor !== viewerLogin;
      }).length;

      return {
        baseBranch: node.baseRefName,
        checks: toChecks(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
        hasConflicts: node.mergeable === 'CONFLICTING',
        headBranch: node.headRefName,
        isDraft: node.isDraft,
        number: node.number,
        repository: node.repository.nameWithOwner,
        requestedReviewers: reviewers,
        reviewDecision: node.reviewDecision,
        threadsAwaitingReply,
        title: node.title,
        updatedAt: node.updatedAt,
        url: node.url
      };
    });
}
