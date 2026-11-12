import { applyMarks, buildDashboard, getHandledSignature } from './dashboard.mjs';
import { createDiscussWorkspace, createFixWorkspace, resumeWorkspace } from './workspaces.mjs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { copyToClipboard, runCommand, runJsonCommand } from './commands.mjs';
import { DEFAULT_PROMPTS, fillPrompt } from './prompts.mjs';
import { startServer } from './server.mjs';

const DEFAULT_AGENT = 'claude';
const MAXIMUM_INDIVIDUAL_NOTIFICATIONS = 3;
const PANEL_ID = 'pull-requests';
const PLUGIN_ID = 'pr-dashboard';
const PREFERRED_PORT = 47213;
const PullRequestAction = { CopyLink: 'copy-link', Discuss: 'discuss', Fix: 'fix', OpenInBrowser: 'open-in-browser', OpenInOrca: 'open-in-orca', Resume: 'resume' };
const REFRESH_INTERVAL_MILLISECONDS = 3 * 60 * 1000;
const RUNTIME = { dashboard: null, error: null, refreshing: null, server: null, timer: null };
const STATUS_BAR_ITEM_ID = 'attention';
const STATUS_FILE_PATH = join(homedir(), '.cache', 'orca-pr-dashboard', 'status.json');
const SettingKey = { Agent: 'agent' };
const StorageKey = { HandledSignatures: 'handledSignatures', MutedUrls: 'mutedUrls', NotifiedSignatures: 'notifiedSignatures', Prompts: 'prompts', Token: 'token' };

/**
 * Find this plugin's key, which Orca derives from where it was installed from.
 */

async function findPluginKey() {
  const response = await runJsonCommand('orca', ['plugin', 'list', '--json']);
  const plugin = response.result.plugins.find(item => item.pluginKey.endsWith(`.${PLUGIN_ID}`) && item.enabled !== false);

  if (!plugin) {
    throw new Error('Pull requests plugin is not installed');
  }

  return plugin.pluginKey;
}

/**
 * Write the attention count where an agent status line can read it.
 */

async function writeStatusFile(dashboard) {
  const temporaryPath = `${STATUS_FILE_PATH}.tmp`;

  await mkdir(dirname(STATUS_FILE_PATH), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify({ attentionCount: dashboard.attentionCount, refreshedAt: dashboard.refreshedAt }));
  await rename(temporaryPath, STATUS_FILE_PATH);
}

/**
 * Start the dashboard server, the refresh loop and the commands.
 */

export default async function activate(context) {
  const storage = {
    get: async key => (await context.host.call('storage.get', { key })).value,
    set: (key, value) => context.host.call('storage.set', { key, value })
  };
  const token = (await storage.get(StorageKey.Token)) ?? randomBytes(24).toString('hex');

  await storage.set(StorageKey.Token, token);

  /**
   * Notify about pull requests that started needing attention since the last refresh.
   */

  async function notifyNewAttention(dashboard) {
    const previous = await storage.get(StorageKey.NotifiedSignatures);
    const current = dashboard.pullRequests
      .filter(pullRequest => pullRequest.needsAttention)
      .map(pullRequest => ({ pullRequest, signature: `${pullRequest.url}|${pullRequest.nextMove.reason}` }));
    const fresh = previous ? current.filter(item => !previous.includes(item.signature)) : current;

    await storage.set(StorageKey.NotifiedSignatures, current.map(item => item.signature));

    if (fresh.length === 0) {
      return;
    }

    if (!previous || fresh.length > MAXIMUM_INDIVIDUAL_NOTIFICATIONS) {
      await context.host.call('notifications.show', {
        body: 'Run "Open Pull Requests" to see them.',
        title: `${fresh.length} pull request(s) need your attention`
      });

      return;
    }

    for (const { pullRequest } of fresh) {
      await context.host.call('notifications.show', {
        body: `${pullRequest.repository}#${pullRequest.number} ${pullRequest.title}`,
        title: pullRequest.nextMove.reason
      });
    }
  }

  /**
   * Find a pull request on the dashboard by URL.
   */

  function findPullRequest(url) {
    const pullRequest = RUNTIME.dashboard?.pullRequests.find(item => item.url === url);

    if (!pullRequest) {
      throw new Error('Unknown pull request');
    }

    return pullRequest;
  }

  /**
   * Return the default and the saved Discuss and Fix prompt templates.
   */

  async function getPrompts() {
    return { defaults: DEFAULT_PROMPTS, prompts: await readPrompts() };
  }

  /**
   * Return the Discuss or Fix prompt filled in for a pull request.
   */

  async function getPullRequestPrompt(action, url) {
    const prompts = await readPrompts();

    if (!Object.hasOwn(prompts, action)) {
      throw new Error('Unknown prompt');
    }

    return { prompt: fillPrompt(prompts[action], findPullRequest(url)) };
  }

  /**
   * Read the agent that Discuss and Fix workspaces start with, or the default one when the settings cannot be read.
   */

  async function readAgent() {
    try {
      const { settings } = await context.host.call('settings.get');

      return settings?.[SettingKey.Agent] || DEFAULT_AGENT;
    } catch {
      return DEFAULT_AGENT;
    }
  }

  /**
   * Read the handled signatures and the muted pull requests.
   */

  async function readMarks() {
    return {
      handledSignatures: (await storage.get(StorageKey.HandledSignatures)) ?? {},
      mutedUrls: new Set((await storage.get(StorageKey.MutedUrls)) ?? [])
    };
  }

  /**
   * Forget the handled marks of pull requests that changed or are no longer open.
   * The saved marks are read again, so a mark saved while the dashboard was being built is kept.
   */

  async function pruneHandledSignatures(dashboard) {
    const byUrl = new Map(dashboard.pullRequests.map(pullRequest => [pullRequest.url, pullRequest]));
    const handledSignatures = (await storage.get(StorageKey.HandledSignatures)) ?? {};
    const kept = Object.fromEntries(
      Object.entries(handledSignatures).filter(([url, signature]) => byUrl.has(url) && getHandledSignature(byUrl.get(url)) === signature)
    );

    if (Object.keys(kept).length !== Object.keys(handledSignatures).length) {
      await storage.set(StorageKey.HandledSignatures, kept);
    }
  }

  /**
   * Apply the saved marks to the dashboard and show the result everywhere.
   */

  async function publishMarks() {
    if (RUNTIME.dashboard) {
      applyMarks(RUNTIME.dashboard, await readMarks());
      await writeStatusFile(RUNTIME.dashboard);
    }

    publishState();
    await updateStatusBar();

    return getState();
  }

  /**
   * Read the Discuss and Fix prompt templates, falling back to the default for any not customized.
   */

  async function readPrompts() {
    return { ...DEFAULT_PROMPTS, ...((await storage.get(StorageKey.Prompts)) ?? {}) };
  }

  /**
   * Rebuild the dashboard, sharing one refresh between concurrent callers.
   */

  function refresh() {
    RUNTIME.refreshing ??= (async () => {
      try {
        RUNTIME.dashboard = await buildDashboard(await readMarks());
        RUNTIME.error = null;

        await pruneHandledSignatures(RUNTIME.dashboard);
        await notifyNewAttention(RUNTIME.dashboard);
        await writeStatusFile(RUNTIME.dashboard);
      } catch (error) {
        RUNTIME.error = error.message;
        context.log(`Refresh failed: ${error.stack ?? error.message}`);
      } finally {
        RUNTIME.refreshing = null;
      }

      publishState();
      await updateStatusBar();

      return getState();
    })();

    return RUNTIME.refreshing;
  }

  /**
   * Return what the page shows.
   */

  function getState() {
    return { dashboard: RUNTIME.dashboard, error: RUNTIME.error, refreshing: Boolean(RUNTIME.refreshing) };
  }

  /**
   * Open a URL in an Orca browser tab.
   */

  async function openTab(url) {
    await runCommand('orca', ['tab', 'create', '--url', url]);

    return { url };
  }

  /**
   * Run a pull request action from the page: open it, copy its link, start a Discuss or Fix workspace, or resume a linked one.
   * A Discuss or Fix workspace gets the given prompt, or its template filled in when none is given.
   * A new workspace triggers a refresh, so the page can offer to resume it.
   */

  async function runPullRequestAction(action, url, prompt) {
    const resolvePrompt = async () => prompt ?? (await getPullRequestPrompt(action, url)).prompt;
    const actions = {
      [PullRequestAction.CopyLink]: pullRequest => copyToClipboard(pullRequest.url),
      [PullRequestAction.Discuss]: async pullRequest => createDiscussWorkspace(pullRequest, await readAgent(), await resolvePrompt()),
      [PullRequestAction.Fix]: async pullRequest => createFixWorkspace(pullRequest, await readAgent(), await resolvePrompt()),
      [PullRequestAction.OpenInBrowser]: pullRequest => runCommand('open', [pullRequest.url]),
      [PullRequestAction.OpenInOrca]: pullRequest => openTab(pullRequest.url),
      [PullRequestAction.Resume]: pullRequest => resumeWorkspace(pullRequest)
    };

    if (!actions[action]) {
      throw new Error('Unknown action');
    }

    await actions[action](findPullRequest(url));

    if ([PullRequestAction.Discuss, PullRequestAction.Fix].includes(action)) {
      refresh();
    }

    return { ok: true };
  }

  /**
   * Send the current state to every open sidebar panel.
   */

  function publishState() {
    context.panels.post('dashboard.changed', getState());
  }

  /**
   * Show the attention count in the Orca status bar.
   */

  async function updateStatusBar() {
    const count = RUNTIME.dashboard?.attentionCount ?? 0;
    const item = RUNTIME.error && !RUNTIME.dashboard
      ? { text: 'PRs: refresh failed', tone: 'danger', tooltip: RUNTIME.error }
      : { text: `${count} PR${count === 1 ? '' : 's'} need you`, tone: count > 0 ? 'warning' : 'neutral', tooltip: 'Pull requests that need your attention. Click to open the panel.' };

    try {
      await context.host.call('statusBar.update', { id: STATUS_BAR_ITEM_ID, ...item });
    } catch (error) {
      context.log(`Status bar update failed: ${error.message}`);
    }
  }

  /**
   * Save the Discuss and Fix prompt templates, keeping only the ones that differ from the default.
   */

  async function savePrompts(input) {
    const prompts = {};

    for (const key of Object.keys(DEFAULT_PROMPTS)) {
      const value = String(input?.[key] ?? DEFAULT_PROMPTS[key]);

      if (value !== DEFAULT_PROMPTS[key]) {
        prompts[key] = value;
      }
    }

    await storage.set(StorageKey.Prompts, prompts);

    return getPrompts();
  }

  /**
   * Mark a pull request as handled until it changes, or unmark it.
   * The pull requests are refreshed first, so the mark is taken against their latest state.
   */

  async function setHandled(url, handled) {
    if (handled) {
      await refresh();
    }

    const handledSignatures = (await storage.get(StorageKey.HandledSignatures)) ?? {};

    if (handled) {
      handledSignatures[url] = getHandledSignature(findPullRequest(url));
    } else {
      delete handledSignatures[url];
    }

    await storage.set(StorageKey.HandledSignatures, handledSignatures);

    return publishMarks();
  }

  /**
   * Mute or unmute a pull request.
   */

  async function setMuted(url, muted) {
    const mutedUrls = new Set((await storage.get(StorageKey.MutedUrls)) ?? []);

    if (muted) {
      mutedUrls.add(url);
    } else {
      mutedUrls.delete(url);
    }

    await storage.set(StorageKey.MutedUrls, [...mutedUrls]);

    return publishMarks();
  }

  RUNTIME.server = await startServer({
    getState,
    onAction: runPullRequestAction,
    onGetPrompts: getPrompts,
    onHandled: setHandled,
    onMute: setMuted,
    onPrompt: getPullRequestPrompt,
    onRefresh: refresh,
    onSavePrompts: savePrompts,
    preferredPort: PREFERRED_PORT,
    token
  });
  RUNTIME.timer = setInterval(refresh, REFRESH_INTERVAL_MILLISECONDS);

  const dashboardUrl = `http://127.0.0.1:${RUNTIME.server.port}/?token=${token}`;

  context.commands.register('open-pull-requests', () => openTab(dashboardUrl));
  context.commands.register('show-pull-requests-panel', async () => {
    await runCommand('orca', ['plugin', 'open', await findPluginKey(), '--panel', PANEL_ID, '--json']);

    return { ok: true };
  });
  context.commands.register('refresh-pull-requests', async () => {
    const state = await refresh();

    return { attentionCount: state.dashboard?.attentionCount ?? null, error: state.error };
  });
  context.panels.handle('dashboard.refresh', () => refresh());
  context.panels.handle('dashboard.state', () => getState());
  context.panels.handle('prompts.get', () => getPrompts());
  context.panels.handle('prompts.save', input => savePrompts(input));
  context.panels.handle('pull-request.action', ({ action, prompt, url }) => runPullRequestAction(String(action), String(url), typeof prompt === 'string' ? prompt : undefined));
  context.panels.handle('pull-request.handled', ({ handled, url }) => setHandled(String(url), Boolean(handled)));
  context.panels.handle('pull-request.mute', ({ muted, url }) => setMuted(String(url), Boolean(muted)));
  context.panels.handle('pull-request.prompt', ({ action, url }) => getPullRequestPrompt(String(action), String(url)));
  context.log(`Pull requests dashboard on port ${RUNTIME.server.port}`);

  refresh();
}

/**
 * Stop the refresh loop and the dashboard server.
 */

export function deactivate() {
  clearInterval(RUNTIME.timer);
  RUNTIME.server?.close();
}
