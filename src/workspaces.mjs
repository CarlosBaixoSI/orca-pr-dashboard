import { runCommand, runJsonCommand } from './commands.mjs';

/**
 * Build the prompt that asks the agent to review the pull request state and propose fixes.
 */

function buildFixPrompt(pullRequest) {
  const reference = `${pullRequest.repository}#${pullRequest.number}`;

  return [
    `Check the current state of pull request ${pullRequest.url} (${reference}: "${pullRequest.title}").`,
    `This workspace starts from the pull request head (\`${pullRequest.headBranch}\`) on a new local branch.`,
    `Use \`gh pr view ${pullRequest.number} --repo ${pullRequest.repository} --comments\`, \`gh pr checks ${pullRequest.number} --repo ${pullRequest.repository}\` and the unresolved review threads to find what is blocking it: failing checks, merge conflicts with \`${pullRequest.baseBranch}\`, requested changes and unanswered review comments.`,
    'Then report what needs fixing and propose the concrete fix for each item.',
    `Do not commit or push until I approve. When I do, push to the pull request branch with \`git push origin HEAD:${pullRequest.headBranch}\`.`
  ].join('\n\n');
}

/**
 * Find the Orca project that is a checkout of the pull request repository.
 */

async function findRepository(pullRequest) {
  const response = await runJsonCommand('orca', ['repo', 'list', '--json']);
  const repositories = response.result?.repos ?? response.result ?? [];
  const repository = repositories.find(item => item.gitRemoteIdentity?.canonicalKey?.toLowerCase() === `github.com/${pullRequest.repository}`.toLowerCase());

  if (!repository) {
    throw new Error(`No Orca project for ${pullRequest.repository}`);
  }

  return repository;
}

/**
 * Open a clean workspace in the pull request project, with Claude, named after the pull request.
 */

export async function createDiscussWorkspace(pullRequest) {
  const repository = await findRepository(pullRequest);

  return runJsonCommand('orca', [
    'worktree', 'create',
    '--repo', `id:${repository.id}`,
    '--name', pullRequest.title,
    '--no-parent',
    '--agent', 'claude',
    '--reference', pullRequest.url,
    '--activate',
    '--json'
  ]);
}

/**
 * Open a workspace on the pull request head, with Claude, and send it the fix prompt.
 */

export async function createFixWorkspace(pullRequest) {
  const repository = await findRepository(pullRequest);

  await runCommand('git', ['-C', repository.path, 'fetch', 'origin', pullRequest.headBranch]);

  return runJsonCommand('orca', [
    'worktree', 'create',
    '--repo', `id:${repository.id}`,
    '--name', pullRequest.title,
    '--no-parent',
    '--base-branch', `origin/${pullRequest.headBranch}`,
    '--agent', 'claude',
    '--prompt', buildFixPrompt(pullRequest),
    '--reference', pullRequest.url,
    '--activate',
    '--json'
  ]);
}
