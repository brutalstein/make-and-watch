import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildWindowsCmdCommand,
  discoverProviderExecutable,
  guardProviderStdio,
  providerLaunchSummary,
  spawnProviderExecutable,
} from './provider-executable.mjs';

const temp = await mkdtemp(join(tmpdir(), 'makewatch-provider-discovery-'));
try {
  const windowsBin = join(temp, 'windows bin');
  await mkdir(windowsBin, { recursive: true });
  await writeFile(join(windowsBin, 'codex.cmd'), '@echo off\r\n', 'utf8');
  await writeFile(join(windowsBin, 'claude.exe'), '', 'utf8');

  const codex = discoverProviderExecutable('codex', {
    platform: 'win32',
    env: { PATH: windowsBin, PATHEXT: '.EXE;.CMD;.BAT', USERPROFILE: temp },
  });
  assert.ok(codex, 'Windows npm codex.cmd shim must be discovered');
  assert.equal(codex.name.toLowerCase(), 'codex.cmd');
  assert.equal(codex.discovery, 'path');
  assert.equal(codex.commandShellRequired, true, '.cmd must be launched through cmd.exe');
  assert.match(providerLaunchSummary(codex), /via cmd\.exe/);

  const versionCommand = buildWindowsCmdCommand(codex, ['--version']);
  assert.ok(versionCommand.startsWith('""'), 'cmd /S /C command must contain an outer quote before the quoted shim path');
  assert.ok(versionCommand.endsWith('""'), 'cmd /S /C command must close the outer quote after arguments');
  assert.ok(versionCommand.includes('codex.cmd" "--version"'), 'shim path and generated argument must both be quoted');

  const claude = discoverProviderExecutable('claude', {
    platform: 'win32',
    env: { PATH: windowsBin, PATHEXT: '.EXE;.CMD;.BAT', USERPROFILE: temp },
  });
  assert.ok(claude, 'Windows native claude.exe must be discovered');
  assert.equal(claude.name.toLowerCase(), 'claude.exe');
  assert.equal(claude.commandShellRequired, false, '.exe must be launched directly');
  assert.match(providerLaunchSummary(claude), /direct/);

  const userBin = join(temp, '.local', 'bin');
  await mkdir(userBin, { recursive: true });
  await writeFile(join(userBin, 'claude.exe'), '', 'utf8');
  const fallbackClaude = discoverProviderExecutable('claude', {
    platform: 'win32',
    env: { PATH: '', PATHEXT: '.EXE;.CMD', USERPROFILE: temp },
  });
  assert.ok(fallbackClaude, 'common per-user .local/bin install must be discovered even when absent from PATH');
  assert.equal(fallbackClaude.discovery, 'known-user-bin');

  const overridePath = join(windowsBin, 'custom-codex.exe');
  await writeFile(overridePath, '', 'utf8');
  const overridden = discoverProviderExecutable('codex', {
    platform: 'win32',
    env: { PATH: '', MAKEWATCH_CODEX_BIN: overridePath },
  });
  assert.equal(overridden?.discovery, 'override');
  assert.equal(overridden?.path, overridePath);

  const fakeChild = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  guardProviderStdio(fakeChild);

  const spawnError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
  assert.doesNotThrow(() => fakeChild.emit('error', spawnError), 'provider process errors must not terminate the owning bridge');
  assert.deepEqual(fakeChild.makewatchLastProcessError, {
    code: 'ENOENT',
    message: 'spawn failed',
  });

  const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
  assert.doesNotThrow(() => fakeChild.stdin.emit('error', epipe), 'provider EPIPE must not terminate the owning bridge process');
  assert.deepEqual(fakeChild.makewatchLastPipeError, {
    stream: 'stdin',
    code: 'EPIPE',
    message: 'broken pipe',
  });

  if (process.platform !== 'win32') {
    const nodeExecutable = {
      path: process.execPath,
      name: 'node',
      discovery: 'test',
      commandShellRequired: false,
    };
    const child = spawnProviderExecutable(
      nodeExecutable,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    assert.equal(child.makewatchOwnProcessGroup, true, 'POSIX provider process should own a dedicated process group');
    const closed = once(child, 'close');
    assert.equal(child.kill('SIGTERM'), true, 'owned provider process group should accept termination');
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('POSIX provider group did not terminate')), 3000)),
    ]);
  }

  console.log('director provider-executable check: passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
