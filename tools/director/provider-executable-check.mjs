import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverProviderExecutable } from './provider-executable.mjs';

const temp = await mkdtemp(join(tmpdir(), 'makewatch-provider-discovery-'));
try {
  const windowsBin = join(temp, 'windows-bin');
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

  const claude = discoverProviderExecutable('claude', {
    platform: 'win32',
    env: { PATH: windowsBin, PATHEXT: '.EXE;.CMD;.BAT', USERPROFILE: temp },
  });
  assert.ok(claude, 'Windows native claude.exe must be discovered');
  assert.equal(claude.name.toLowerCase(), 'claude.exe');
  assert.equal(claude.commandShellRequired, false, '.exe must be launched directly');

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

  console.log('director provider-executable check: passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
