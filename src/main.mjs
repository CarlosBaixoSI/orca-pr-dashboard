import { applyMutes, buildDashboard } from './dashboard.mjs';
import { createDiscussWorkspace, createFixWorkspace } from './workspaces.mjs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { copyToClipboard, runCommand, runJsonCommand } from './commands.mjs';
import { startServer } from './server.mjs';

const DEFAULT_AGENT = 'claude';
const MAXIMUM_INDIVIDUAL_NOTIFICATIONS = 3;
const PANEL_ID = 'pull-requests';
const PLUGIN_ID = 'pr-dashboard';
const PREFERRED_PORT = 47213;
const PullRequestAction = { CopyLink: 'copy-link', Discuss: 'discuss', Fix: 'fix', OpenInBrowser: 'open-in-browser', OpenInOrca: 'open-in-orca' };
const REFRESH_INTERVAL_MILLISECONDS = 3 * 60 * 1000;
const RUNTIME = { dashboard: null, error: null, refreshing: null, server: null, timer: null };
const STATUS_BAR_ITEM_ID = 'attention';
const STATUS_FILE_PATH = join(homedir(), '.cache', 'orca-pr-dashboard', 'status.json');
const SettingKey = { Agent: 'agent' };
const StorageKey = { MutedUrls: 'mutedUrls', NotifiedSignatures: 'notifiedSignatures', Token: 'token' };

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
   * Rebuild the dashboard, sharing one refresh between concurrent callers.
   */

  function refresh() {
    RUNTIME.refreshing ??= (async () => {
      try {
        const mutedUrls = new Set((await storage.get(StorageKey.MutedUrls)) ?? []);

        RUNTIME.dashboard = await buildDashboard(mutedUrls);
        RUNTIME.error = null;

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
   * Run a pull request action from the page: open it, copy its link, or start a Discuss or Fix workspace.
   */

  async function runPullRequestAction(action, url) {
    const actions = {
      [PullRequestAction.CopyLink]: pullRequest => copyToClipboard(pullRequest.url),
      [PullRequestAction.Discuss]: async pullRequest => createDiscussWorkspace(pullRequest, await readAgent()),
      [PullRequestAction.Fix]: async pullRequest => createFixWorkspace(pullRequest, await readAgent()),
      [PullRequestAction.OpenInBrowser]: pullRequest => runCommand('open', [pullRequest.url]),
      [PullRequestAction.OpenInOrca]: pullRequest => openTab(pullRequest.url)
    };
    const pullRequest = RUNTIME.dashboard?.pullRequests.find(item => item.url === url);

    if (!pullRequest || !actions[action]) {
      throw new Error('Unknown pull request or action');
    }

    await actions[action](pullRequest);

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

    if (RUNTIME.dashboard) {
      applyMutes(RUNTIME.dashboard, mutedUrls);
      await writeStatusFile(RUNTIME.dashboard);
    }

    publishState();
    await updateStatusBar();

    return getState();
  }

  RUNTIME.server = await startServer({
    getState,
    onAction: runPullRequestAction,
    onMute: setMuted,
    onRefresh: refresh,
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
  context.panels.handle('pull-request.action', ({ action, url }) => runPullRequestAction(String(action), String(url)));
  context.panels.handle('dashboard.state', () => getState());
  context.panels.handle('pull-request.mute', ({ muted, url }) => setMuted(String(url), Boolean(muted)));
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
