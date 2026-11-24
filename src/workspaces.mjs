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
 * Return the prompt arguments for a workspace, or none when the prompt is empty.
 */

function promptArguments(prompt) {
  return prompt.trim() ? ['--prompt', prompt] : [];
}

/**
 * Open a clean workspace in the pull request project, with the given agent and prompt, named after the pull request.
 */

export async function createDiscussWorkspace(pullRequest, agent, prompt) {
  await assertAgentInstalled(agent);

  const repository = await findRepository(pullRequest);

  return runJsonCommand('orca', [
    'worktree', 'create',
    '--repo', `id:${repository.id}`,
    '--name', pullRequest.title,
    '--no-parent',
    '--agent', agent,
    ...promptArguments(prompt),
    '--reference', pullRequest.url,
    '--activate',
    '--json'
  ]);
}

/**
 * Open a workspace on the pull request head, with the given agent and prompt, named after the pull request.
 */

export async function createFixWorkspace(pullRequest, agent, prompt) {
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
    ...promptArguments(prompt),
    '--reference', pullRequest.url,
    '--activate',
    '--json'
  ]);
}

/**
 * Open the most recently active workspace linked to the pull request.
 */

export function resumeWorkspace(pullRequest) {
  const [worktree] = pullRequest.worktrees;

  if (!worktree) {
    throw new Error('No workspace linked to this pull request');
  }

  return runJsonCommand('orca', ['worktree', 'activate', '--worktree', `id:${worktree.id}`, '--json']);
}
