import { computeClaudeCost } from '../pricing.mjs';
import { createSummary, listDirectory, summarizeFile, trackActivity } from '../transcripts.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGENT = 'claude';
const PROJECTS_DIRECTORY = join(homedir(), '.claude', 'projects');

/**
 * List the Claude Code sessions on this machine, with subagent costs added to their parent session.
 */

export async function listClaudeSessions() {
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
      const session = { ...(await summarizeFile(join(projectPath, file.name), summarizeTranscript)), agent: AGENT, id };
      const subagentsPath = join(projectPath, id, 'subagents');

      for (const subagent of await listDirectory(subagentsPath)) {
        if (subagent.isFile() && subagent.name.endsWith('.jsonl')) {
          session.cost += (await summarizeFile(join(subagentsPath, subagent.name), summarizeTranscript)).cost;
        }
      }

      sessions.push(session);
    }
  }

  return sessions;
}

/**
 * Summarize one Claude Code transcript: cost, title, working directory, branches and linked pull requests.
 */

function summarizeTranscript(entries) {
  const messageIds = new Set();
  const summary = createSummary();

  for (const entry of entries) {
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

    trackActivity(summary, entry.timestamp);

    if (message?.usage && !messageIds.has(message.id)) {
      messageIds.add(message.id);
      summary.cost += computeClaudeCost(message.model, message.usage);
    }
  }

  return summary;
}
