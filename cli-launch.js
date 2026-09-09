import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function windowsNpmModules(appData) {
  return appData ? path.win32.join(appData, 'npm', 'node_modules') : null;
}

function firstWindowsCommand(bin, envPath, pathExt, existsSync) {
  const extensions = String(pathExt || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(ext => ext.trim())
    .filter(Boolean);
  for (const rawDir of String(envPath || '').split(';')) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.win32.resolve(dir, `${bin}${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function sameWindowsPath(left, right) {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

export function resolveCliLaunch(bin, args, {
  platform = process.platform,
  appData = process.env.APPDATA,
  nodePath = process.execPath,
  envPath = process.env.PATH,
  pathExt = process.env.PATHEXT,
  existsSync = fs.existsSync,
} = {}) {
  const originalArgs = [...args];
  if (platform !== 'win32') {
    return { file: bin, args: originalArgs, shell: true, direct: false };
  }

  const npmModules = windowsNpmModules(appData);
  if (!npmModules) {
    return { file: bin, args: originalArgs, shell: true, direct: false };
  }

  const npmBin = path.win32.join(appData, 'npm');
  const resolvedCommand = firstWindowsCommand(bin, envPath, pathExt, existsSync);
  const expectedShim = path.win32.join(npmBin, `${bin}.cmd`);
  if (!resolvedCommand || !sameWindowsPath(resolvedCommand, expectedShim)) {
    return { file: bin, args: originalArgs, shell: true, direct: false };
  }

  if (bin === 'codex') {
    const script = path.win32.join(npmModules, '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) {
      return {
        file: nodePath,
        args: [script, ...originalArgs],
        shell: false,
        direct: true,
      };
    }
  }

  if (bin === 'claude') {
    const executable = path.win32.join(
      npmModules,
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (existsSync(executable)) {
      return {
        file: executable,
        args: originalArgs,
        shell: false,
        direct: true,
      };
    }
  }

  return { file: bin, args: originalArgs, shell: true, direct: false };
}

export function spawnCli(bin, args, options = {}, {
  spawnImpl = spawn,
  platform = process.platform,
  appData = process.env.APPDATA,
  nodePath = process.execPath,
  envPath = process.env.PATH,
  pathExt = process.env.PATHEXT,
  existsSync = fs.existsSync,
} = {}) {
  const launch = resolveCliLaunch(bin, args, {
    platform,
    appData,
    nodePath,
    envPath,
    pathExt,
    existsSync,
  });
  // The production wrapper already owns a hidden console. Keep Windows' default
  // console inheritance so CLI grandchildren (hooks/tools) do not allocate a
  // fresh console window for every command.
  return spawnImpl(launch.file, launch.args, {
    ...options,
    shell: launch.shell,
  });
}
