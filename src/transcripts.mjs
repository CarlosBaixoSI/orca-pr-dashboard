import { readdir, readFile, stat } from 'node:fs/promises';

const SUMMARY_CACHE = new Map();

/**
 * Create an empty session summary.
 */

export function createSummary() {
  return { branches: new Set(), cost: 0, cwd: null, id: null, lastActivityAt: null, pullRequestUrls: new Set(), title: null };
}

/**
 * List the entries of a directory, or nothing when it does not exist.
 */

export async function listDirectory(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Parse each line of a JSON lines transcript, skipping the lines that are not valid JSON.
 */

function parseLines(content) {
  const entries = [];

  for (const line of content.split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;
    }
  }

  return entries;
}

/**
 * Summarize a transcript file with the given summarizer, reusing the last summary while the file is unchanged.
 */

export async function summarizeFile(path, summarize) {
  const { mtimeMs, size } = await stat(path);
  const cached = SUMMARY_CACHE.get(path);

  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.summary;
  }

  const summary = summarize(parseLines(await readFile(path, 'utf8')));

  SUMMARY_CACHE.set(path, { mtimeMs, size, summary });

  return summary;
}

/**
 * Move the last activity of a summary forward to the given timestamp.
 */

export function trackActivity(summary, timestamp) {
  if (timestamp && (!summary.lastActivityAt || timestamp > summary.lastActivityAt)) {
    summary.lastActivityAt = timestamp;
  }
}
