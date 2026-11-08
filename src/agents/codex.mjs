import { basename, join } from 'node:path';
import { computeOpenAiCost } from '../pricing.mjs';
import { createSummary, listDirectory, summarizeFile, trackActivity } from '../transcripts.mjs';
import { homedir } from 'node:os';

const AGENT = 'codex';
const MAXIMUM_TITLE_LENGTH = 80;
const SESSIONS_DIRECTORY = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
const USAGE_FIELDS = ['cached_input_tokens', 'input_tokens', 'output_tokens'];

/**
 * Turn the first user message into a one line session title.
 */

function buildTitle(message) {
  const line = message.trim().split('\n')[0];

  return line.length > MAXIMUM_TITLE_LENGTH ? `${line.slice(0, MAXIMUM_TITLE_LENGTH - 1)}…` : line;
}

/**
 * List the Codex sessions on this machine.
 */

export async function listCodexSessions() {
  const sessions = [];

  for (const path of await listRolloutFiles(SESSIONS_DIRECTORY)) {
    const summary = await summarizeFile(path, summarizeRollout);

    sessions.push({ ...summary, agent: AGENT, id: summary.id ?? basename(path, '.jsonl') });
  }

  return sessions;
}

/**
 * List the rollout files in a folder and its subfolders, which Codex groups by date.
 */

async function listRolloutFiles(path) {
  const files = [];

  for (const entry of await listDirectory(path)) {
    const entryPath = join(path, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listRolloutFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }

  return files;
}

/**
 * Compute the token usage added since the previous cumulative usage.
 */

function subtractUsage(usage, previousUsage) {
  return Object.fromEntries(USAGE_FIELDS.map(field => [field, Math.max((usage[field] ?? 0) - (previousUsage?.[field] ?? 0), 0)]));
}

/**
 * Summarize one Codex rollout: id, cost, title, working directory and branch.
 * Token usage is cumulative, so each increase is priced with the model of the turn it happened in.
 */

function summarizeRollout(entries) {
  let model = null;
  let previousUsage = null;
  const summary = createSummary();

  for (const entry of entries) {
    const payload = entry.payload ?? {};
    const usage = entry.type === 'event_msg' && payload.type === 'token_count' ? payload.info?.total_token_usage : null;

    trackActivity(summary, entry.timestamp);

    if (entry.type === 'session_meta' && !summary.id) {
      summary.cwd = payload.cwd ?? null;
      summary.id = payload.id ?? payload.session_id ?? null;

      if (payload.git?.branch) {
        summary.branches.add(payload.git.branch);
      }
    }

    if (entry.type === 'turn_context' && payload.model) {
      model = payload.model;
    }

    if (entry.type === 'event_msg' && payload.type === 'user_message' && payload.message && !summary.title) {
      summary.title = buildTitle(payload.message);
    }

    if (usage) {
      summary.cost += computeOpenAiCost(model, subtractUsage(usage, previousUsage));
      previousUsage = usage;
    }
  }

  return summary;
}
