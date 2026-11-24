import { runJsonCommand } from './commands.mjs';

const PULL_REQUEST_FIELDS = `
fragment PullRequestFields on PullRequest {
  author { login }
  baseRefName
  createdAt
  headRefName
  headRefOid
  isDraft
  mergeable
  number
  reviewDecision
  title
  updatedAt
  url
  comments(last: 20) { nodes { author { __typename login } createdAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  pushes: timelineItems(last: 5, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]) {
    nodes {
      __typename
      ... on HeadRefForcePushedEvent { actor { __typename login } createdAt }
      ... on PullRequestCommit { commit { author { user { login } } committedDate } }
    }
  }
  repository { nameWithOwner }
  reviewRequestEvents: timelineItems(last: 10, itemTypes: [REVIEW_REQUESTED_EVENT]) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
  }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { ... on Team { name } ... on User { login } } }
  }
  reviews(last: 20) { nodes { author { __typename login } state submittedAt } }
  viewerLatestReview { commit { oid } submittedAt }
}`;
const PULL_REQUESTS_QUERY = `
${PULL_REQUEST_FIELDS}
query {
  viewer { login }
  authored: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 100) { nodes { ...PullRequestFields } }
  requested: search(query: "is:pr is:open user-review-requested:@me archived:false", type: ISSUE, first: 100) { nodes { ...PullRequestFields } }
  reviewed: search(query: "is:pr is:open reviewed-by:@me archived:false", type: ISSUE, first: 100) { nodes { ...PullRequestFields } }
}`;
const VERDICT_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

export const Checks = { Failing: 'failing', None: 'none', Passing: 'passing', Pending: 'pending' };
export const Owner = { Author: 'author', Reviewers: 'reviewers', You: 'you' };

/**
 * Join the logins of the people behind some words, each once.
 */

function joinLogins(words) {
  return [...new Set(words.map(word => word.by))].join(', ');
}

/**
 * Check whether a GitHub actor is a bot, or nobody at all.
 */

function isBot(actor) {
  return !actor?.login || actor.__typename === 'Bot' || actor.login.endsWith('[bot]');
}

/**
 * Return the newest of some ISO times, or an empty string when there is none.
 */

function newest(times) {
  return times.reduce((latest, time) => (time && time > latest ? time : latest), '');
}

/**
 * Split a next move key into its head commit, the time of their newest word and the time of the newest review request.
 */

function splitKey(key) {
  return key ? key.split('|') : ['', '', ''];
}

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
 * Map a pushes timeline item to who pushed and when, or null for a force push by a bot.
 * A commit GitHub cannot tie to an account belongs to the pull request author.
 */

function toPush(node, authorLogin) {
  if (node.__typename === 'HeadRefForcePushedEvent') {
    return isBot(node.actor) ? null : { at: node.createdAt, by: node.actor.login };
  }

  return { at: node.commit.committedDate, by: node.commit.author?.user?.login ?? authorLogin };
}

/**
 * Decide whose move a pull request is at, and why, from who spoke last.
 * Your last word is the newest of your reviews, comments and pushes, the opening of your own pull request, and the last word seen before.
 * Your own pull request is your move when someone else comments, reviews or pushes after your last word.
 * Someone else's is your move when someone else comments or reviews after your last word, when it was pushed to since your review
 * (unless you approved it), or when your review is requested after your last word.
 * Bots are ignored. The key names what came round, so a new push, word or request is a new move.
 */

export function deriveNextMove(pullRequest, viewerLogin, previousLastWord = '') {
  const { activity } = pullRequest;
  const latestPush = activity.pushes.reduce((latest, push) => (!latest || push.at > latest.at ? push : latest), null);
  const latestRequest = newest(activity.requestedAt);
  const myWords = activity.words.filter(word => word.by === viewerLogin);
  const review = activity.review;
  const lastWord = newest([
    previousLastWord,
    review?.at,
    ...myWords.map(word => word.at),
    ...activity.pushes.filter(push => push.by === viewerLogin).map(push => push.at),
    pullRequest.isMine && pullRequest.createdAt
  ]);
  const waiting = pullRequest.isMine
    ? { owner: Owner.Reviewers, reason: pullRequest.requestedReviewers.length > 0 ? `Waiting for ${pullRequest.requestedReviewers.join(', ')}` : 'Waiting for reviews' }
    : { owner: Owner.Author, reason: `Waiting for ${pullRequest.author ?? 'the author'}` };
  const isRequested = !pullRequest.isMine && activity.isReviewRequested && !(latestRequest && lastWord > latestRequest);

  if (!lastWord) {
    return isRequested
      ? { key: ['', '', latestRequest || 'requested'].join('|'), lastWord, owner: Owner.You, reason: 'Review requested' }
      : { ...waiting, key: null, lastWord };
  }

  const theirWords = activity.words.filter(word => !word.isBot && word.by !== viewerLogin && word.at > lastWord);
  const verdict = myWords.filter(word => VERDICT_STATES.has(word.state)).reduce((latest, word) => (!latest || word.at > latest.at ? word : latest), null);
  const answeredSinceReview = review && lastWord > review.at ? lastWord : '';
  const isPushed = Boolean(latestPush) && latestPush.by !== viewerLogin && (pullRequest.isMine
    ? latestPush.at > lastWord
    : Boolean(review) && review.commit !== pullRequest.headCommit && verdict?.state !== 'APPROVED' && !(answeredSinceReview >= latestPush.at));

  if (!isPushed && theirWords.length === 0 && !isRequested) {
    return { ...waiting, key: null, lastWord };
  }

  const approvals = theirWords.filter(word => word.state === 'APPROVED');
  const changeRequests = theirWords.filter(word => word.state === 'CHANGES_REQUESTED');
  const comments = theirWords.filter(word => word.state !== 'APPROVED' && word.state !== 'CHANGES_REQUESTED');
  const heardAt = newest(theirWords.map(word => word.at));
  const reasons = [];

  if (isPushed) {
    reasons.push(pullRequest.isMine ? `${latestPush.by} pushed` : 'Pushed since your review');
  }

  if (approvals.length > 0) {
    reasons.push(`Approved by ${joinLogins(approvals)}`);
  }

  if (changeRequests.length > 0) {
    reasons.push(`Changes requested by ${joinLogins(changeRequests)}`);
  }

  if (comments.length > 0) {
    reasons.push(`${comments.length} comment${comments.length === 1 ? '' : 's'} from ${joinLogins(comments)}`);
  }

  if (isRequested) {
    reasons.push(review ? 'Your review requested again' : 'Review requested');
  }

  return {
    key: [isPushed ? pullRequest.headCommit : '', heardAt, isRequested ? latestRequest || 'requested' : ''].join('|'),
    lastWord,
    owner: Owner.You,
    reason: reasons.join(' · ')
  };
}

/**
 * Fetch the open pull requests the signed in GitHub user wrote, reviewed or was asked to review, each once.
 */

export async function fetchPullRequests() {
  const response = await runJsonCommand('gh', ['api', 'graphql', '-f', `query=${PULL_REQUESTS_QUERY}`]);
  const viewerLogin = response.data.viewer.login;
  const nodes = [...response.data.authored.nodes, ...response.data.requested.nodes, ...response.data.reviewed.nodes].filter(node => node.url);
  const unique = [...new Map(nodes.map(node => [node.url, node])).values()];

  return {
    pullRequests: unique.map(node => {
      const authorLogin = node.author?.login ?? null;
      const reviewers = node.reviewRequests.nodes
        .map(request => request.requestedReviewer?.login ?? request.requestedReviewer?.name)
        .filter(Boolean);
      const words = [
        ...node.comments.nodes.map(comment => ({ at: comment.createdAt, by: comment.author?.login ?? null, isBot: isBot(comment.author), state: null })),
        ...node.reviews.nodes
          .filter(review => review.submittedAt && review.state !== 'PENDING')
          .map(review => ({ at: review.submittedAt, by: review.author?.login ?? null, isBot: isBot(review.author), state: review.state }))
      ];

      return {
        activity: {
          isReviewRequested: reviewers.includes(viewerLogin),
          pushes: node.pushes.nodes.map(item => toPush(item, authorLogin)).filter(push => push?.at),
          requestedAt: node.reviewRequestEvents.nodes.filter(event => event.requestedReviewer?.login === viewerLogin).map(event => event.createdAt),
          review: node.viewerLatestReview?.submittedAt ? { at: node.viewerLatestReview.submittedAt, commit: node.viewerLatestReview.commit?.oid ?? null } : null,
          words
        },
        author: authorLogin,
        baseBranch: node.baseRefName,
        checks: toChecks(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
        createdAt: node.createdAt,
        hasConflicts: node.mergeable === 'CONFLICTING',
        headBranch: node.headRefName,
        headCommit: node.headRefOid,
        isDraft: node.isDraft,
        isMine: authorLogin === viewerLogin,
        number: node.number,
        repository: node.repository.nameWithOwner,
        requestedReviewers: reviewers,
        reviewDecision: node.reviewDecision,
        title: node.title,
        updatedAt: node.updatedAt,
        url: node.url
      };
    }),
    viewerLogin
  };
}

/**
 * Check whether a next move brings something that had not come round by the previous key: a new head commit, a newer word or a new request.
 */

export function hasNews(previousKey, key) {
  const [previousHead, previousHeardAt, previousRequest] = splitKey(previousKey);
  const [head, heardAt, request] = splitKey(key);

  return (Boolean(head) && head !== previousHead) || heardAt > previousHeardAt || (Boolean(request) && request !== previousRequest && !(request === 'requested' && previousRequest));
}
