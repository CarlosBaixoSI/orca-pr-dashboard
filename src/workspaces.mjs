import { AGENT_NAMES } from './agents/names.mjs';
import { runCommand, runJsonCommand } from './commands.mjs';

const AGENT_CHECK_TIMEOUT_MILLISECONDS = 10_000;
const AGENT_COMMANDS = {
  claude: ['claude'],
  codex: ['codex'],
  copilot: ['copilot'],
  cursor: ['cursor-agent', 'agent'],
  gemini: ['gemini'],
  opencode: ['opencode']
};
const COMMAND_NOT_FOUND_EXIT_CODE = 1;
const DEFAULT_SHELL = '/bin/zsh';

/**
 * Refuse to start a workspace when the agent's command is missing from the login shell a new terminal uses.
 * When the shell itself fails or takes too long, the check is skipped and the launch goes ahead.
 */

async function assertAgentInstalled(agent) {
  const commands = AGENT_COMMANDS[agent];

  if (!commands) {
    return;
  }

  try {
    await runCommand(process.env.SHELL || DEFAULT_SHELL, ['-ilc', commands.map(command => `command -v ${command}`).join(' || ')], { timeoutMilliseconds: AGENT_CHECK_TIMEOUT_MILLISECONDS });
  } catch (error) {
    if (error.code === COMMAND_NOT_FOUND_EXIT_CODE) {
      throw new Error(`${AGENT_NAMES[agent]} is not installed: no ${commands.join(' or ')} command found. Install it or pick another agent in the plugin settings.`);
    }
  }
}

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
 * Open a clean workspace in the pull request project, with the given agent, named after the pull request.
 */

export async function createDiscussWorkspace(pullRequest, agent) {
  await assertAgentInstalled(agent);

  const repository = await findRepository(pullRequest);

  return runJsonCommand('orca', [
    'worktree', 'create',
    '--repo', `id:${repository.id}`,
    '--name', pullRequest.title,
    '--no-parent',
    '--agent', agent,
    '--reference', pullRequest.url,
    '--activate',
    '--json'
  ]);
}

/**
 * Open a workspace on the pull request head, with the given agent, and send it the fix prompt.
 */

export async function createFixWorkspace(pullRequest, agent) {
  await assertAgentInstalled(agent);

  const repository = await findRepository(pullRequest);

  await runCommand('git', ['-C', repository.path, 'fetch', 'origin', pullRequest.headBranch]);

  return runJsonCommand('orca', [
    'worktree', 'create',
    '--repo', `id:${repository.id}`,
    '--name', pullRequest.title,
    '--no-parent',
    '--base-branch', `origin/${pullRequest.headBranch}`,
    '--agent', agent,
    '--prompt', buildFixPrompt(pullRequest),
    '--reference', pullRequest.url,
    '--activate',
    '--json'
  ]);
}
