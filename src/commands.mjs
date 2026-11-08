import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const EXTRA_PATHS = ['/Applications/Orca.app/Contents/Resources/bin', '/opt/homebrew/bin', '/usr/local/bin'];
const MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MILLISECONDS = 60_000;
const execFileAsync = promisify(execFile);

/**
 * Run a command line tool and return its standard output, with the usual binary folders on the path.
 */

export async function runCommand(command, commandArguments, { timeoutMilliseconds = TIMEOUT_MILLISECONDS } = {}) {
  const path = [process.env.PATH, ...EXTRA_PATHS].filter(Boolean).join(':');
  const { stdout } = await execFileAsync(command, commandArguments, {
    env: { ...process.env, PATH: path },
    maxBuffer: MAXIMUM_OUTPUT_BYTES,
    timeout: timeoutMilliseconds
  });

  return stdout;
}

/**
 * Run a command line tool and parse its standard output as JSON.
 */

export async function runJsonCommand(command, commandArguments) {
  return JSON.parse(await runCommand(command, commandArguments));
}
