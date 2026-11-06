import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const HOST = '127.0.0.1';
const MAXIMUM_BODY_BYTES = 16 * 1024;
const PAGE_PATH = fileURLToPath(new URL('./page.html', import.meta.url));
const PORT_ATTEMPTS = 10;

/**
 * Read a small JSON request body.
 */

async function readJsonBody(request) {
  let body = '';

  for await (const chunk of request) {
    body += chunk;

    if (body.length > MAXIMUM_BODY_BYTES) {
      throw new Error('Request body too large');
    }
  }

  return body ? JSON.parse(body) : {};
}

/**
 * Send a JSON response.
 */

function sendJson(response, status, value) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/**
 * Listen on the first free port starting at the preferred one.
 */

function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;

    server.on('error', error => {
      if (error.code === 'EADDRINUSE' && port < preferredPort + PORT_ATTEMPTS) {
        port += 1;
        server.listen(port, HOST);

        return;
      }

      reject(error);
    });
    server.on('listening', () => resolve(port));
    server.listen(port, HOST);
  });
}

/**
 * Start the local dashboard server and return its port.
 * Every API call must carry the session token, and the host header must be local, to block other websites.
 */

export async function startServer({ getState, onAction, onMute, onRefresh, preferredPort, token }) {
  let port = preferredPort;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    const isLocalHost = [`${HOST}:${port}`, `localhost:${port}`].includes(request.headers.host);

    try {
      if (!isLocalHost) {
        return sendJson(response, 403, { error: 'Forbidden' });
      }

      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' });

        return response.end(await readFile(PAGE_PATH));
      }

      if (request.headers['x-dashboard-token'] !== token) {
        return sendJson(response, 401, { error: 'Unauthorized' });
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(response, 200, getState());
      }

      if (request.method === 'POST' && url.pathname === '/api/action') {
        const { action, url: pullRequestUrl } = await readJsonBody(request);

        return sendJson(response, 200, await onAction(String(action), String(pullRequestUrl)));
      }

      if (request.method === 'POST' && url.pathname === '/api/mute') {
        const { muted, url: pullRequestUrl } = await readJsonBody(request);

        return sendJson(response, 200, await onMute(String(pullRequestUrl), Boolean(muted)));
      }

      if (request.method === 'POST' && url.pathname === '/api/refresh') {
        return sendJson(response, 200, await onRefresh());
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });

  port = await listen(server, preferredPort);

  return { close: () => server.close(), port };
}
