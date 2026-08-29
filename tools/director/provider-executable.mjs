import { existsSync } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const PROVIDER_NAMES = Object.freeze({ codex: 'codex', claude: 'claude' });

function providerName(provider) {
  const name = PROVIDER_NAMES[provider];
  if (!name) throw new Error(`unsupported Director provider: ${provider}`);
  return name;
}

function normalizeDirectory(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^"|"$/g, '');
  return trimmed ? resolve(trimmed) : null;
}

function uniqueDirectories(values, platform) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeDirectory(value);
    if (!normalized) continue;
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function searchDirectories(env, platform) {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const pathDirectories = String(env.PATH ?? env.Path ?? env.path ?? '')
    .split(pathDelimiter)
    .filter(Boolean);

  const userProfile = env.USERPROFILE ?? env.HOME ?? '';
  const appData = env.APPDATA ?? '';
  const localAppData = env.LOCALAPPDATA ?? '';
  const pnpmHome = env.PNPM_HOME ?? '';

  const fallbacks = platform === 'win32'
    ? [
        pnpmHome,
        appData ? join(appData, 'npm') : '',
        localAppData ? join(localAppData, 'pnpm') : '',
        userProfile ? join(userProfile, '.local', 'bin') : '',
        userProfile ? join(userProfile, 'AppData', 'Roaming', 'npm') : '',
      ]
    : [
        pnpmHome,
        userProfile ? join(userProfile, '.local', 'bin') : '',
        '/usr/local/bin',
        '/usr/bin',
      ];

  return {
    pathDirectories: uniqueDirectories(pathDirectories, platform),
    allDirectories: uniqueDirectories([...pathDirectories, ...fallbacks], platform),
  };
}

function executableExtensions(env, platform) {
  if (platform !== 'win32') return [''];
  const configured = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const preferred = ['.exe', '.com', '.cmd', '.bat'];
  return [...new Set([...preferred, ...configured])];
}

function candidatePaths(directory, commandName, extensions, platform) {
  if (platform !== 'win32') return [join(directory, commandName)];
  return extensions.map((extension) => join(directory, `${commandName}${extension}`));
}

function explicitOverride(provider, env) {
  const key = provider === 'codex' ? 'MAKEWATCH_CODEX_BIN' : 'MAKEWATCH_CLAUDE_BIN';
  const value = typeof env[key] === 'string' ? env[key].trim().replace(/^"|"$/g, '') : '';
  if (!value) return null;
  const path = isAbsolute(value) ? value : resolve(value);
  if (!existsSync(path)) throw new Error(`${key} points to a file that does not exist`);
  return { path, discovery: 'override' };
}

function descriptor(path, discovery, platform) {
  const extension = extname(path).toLowerCase();
  return Object.freeze({
    path,
    name: basename(path),
    discovery,
    commandShellRequired: platform === 'win32' && (extension === '.cmd' || extension === '.bat'),
  });
}

/**
 * Resolve the actual first-party CLI executable instead of trusting CreateProcess
 * to interpret shell shims. This matters on Windows where npm commonly exposes
 * commands as .cmd files while native installers expose .exe files.
 */
export function discoverProviderExecutable(provider, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const commandName = providerName(provider);
  const override = explicitOverride(provider, env);
  if (override) return descriptor(override.path, override.discovery, platform);

  const { pathDirectories, allDirectories } = searchDirectories(env, platform);
  const pathSet = new Set(pathDirectories.map((value) => platform === 'win32' ? value.toLowerCase() : value));
  const extensions = executableExtensions(env, platform);

  for (const directory of allDirectories) {
    const discovery = pathSet.has(platform === 'win32' ? directory.toLowerCase() : directory)
      ? 'path'
      : 'known-user-bin';
    for (const candidate of candidatePaths(directory, commandName, extensions, platform)) {
      if (existsSync(candidate)) return descriptor(candidate, discovery, platform);
    }
  }
  return null;
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (!text) return '""';
  // Provider arguments are generated internally; user prompts always travel on stdin.
  // Escape cmd.exe expansion/metacharacters for npm .cmd shims.
  const escaped = text
    .replace(/\^/g, '^^')
    .replace(/%/g, '%%')
    .replace(/!/g, '^!');
  if (escaped.includes('"')) throw new Error('quoted cmd.exe provider argument is unsupported');
  return `"${escaped}"`;
}

export function buildWindowsCmdCommand(executable, args) {
  if (!executable?.path) throw new Error('provider executable is not resolved');
  const inner = [quoteCmdArgument(executable.path), ...args.map(quoteCmdArgument)].join(' ');
  // cmd.exe /S /C requires the outer quote pair when the command starts with a quoted path.
  // Example raw command line:
  //   cmd.exe /d /s /c ""C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" "--version""
  return `"${inner}"`;
}

export function providerLaunchSummary(executable) {
  if (!executable) return 'unresolved';
  return executable.commandShellRequired
    ? `${executable.name} via cmd.exe (${executable.discovery})`
    : `${executable.name} direct (${executable.discovery})`;
}

/**
 * ChildProcess and stdio `error` events terminate Node when they have no listener.
 * Director providers are optional subsystems and must never take down the native
 * project bridge. The passive guards record the latest transport failure while
 * higher-level request/exit listeners retain authority over retry/failover.
 */
export function guardProviderStdio(child) {
  if (!child) return child;

  if (typeof child.on === 'function') {
    child.on('error', (error) => {
      child.makewatchLastProcessError = {
        code: typeof error?.code === 'string' ? error.code : '',
        message: String(error?.message ?? error).slice(0, 300),
      };
    });
  }

  for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]]) {
    if (!stream || typeof stream.on !== 'function') continue;
    stream.on('error', (error) => {
      child.makewatchLastPipeError = {
        stream: name,
        code: typeof error?.code === 'string' ? error.code : '',
        message: String(error?.message ?? error).slice(0, 300),
      };
    });
  }
  return child;
}

function providerSpawnOptions(options) {
  if (process.platform === 'win32' || options.detached !== undefined) return options;
  // Put every owned provider runtime in its own POSIX process group. This makes
  // shutdown symmetrical with Windows taskkill /T: descendants cannot outlive a
  // failed/aborted provider turn merely because only the leader received SIGTERM.
  return { ...options, detached: true };
}

function markOwnedProcessGroup(child, options) {
  if (process.platform !== 'win32' && options.detached === true) {
    child.makewatchOwnProcessGroup = true;
  }
  return guardProviderStdio(child);
}

export function spawnProviderExecutable(executable, args, options = {}) {
  if (!executable) throw new Error('provider executable is not resolved');
  const launchOptions = providerSpawnOptions(options);
  if (!executable.commandShellRequired) {
    return markOwnedProcessGroup(
      spawn(executable.path, args, launchOptions),
      launchOptions,
    );
  }

  const env = launchOptions.env ?? process.env;
  const comspec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
  const command = buildWindowsCmdCommand(executable, args);

  // Critical on Windows: Node's default argument escaping would quote/escape the
  // already-composed /C command string a second time. For npm .cmd shims this can
  // make a perfectly valid PowerShell command fail only when launched by Node.
  // The command is safe to pass verbatim because every argument is internally
  // generated and quoteCmdArgument escapes cmd expansion characters; user text is
  // always supplied over stdin, never interpolated into this command line.
  return guardProviderStdio(spawn(comspec, ['/d', '/s', '/c', command], {
    ...launchOptions,
    windowsVerbatimArguments: true,
  }));
}
