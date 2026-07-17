import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(
  path.join(process.env.GG_INSTALL_TMPDIR ?? os.tmpdir(), 'gg-install-smoke-'),
);
const marker = path.join(root, '.gg-install-smoke-owner');
writeFileSync(marker, `${process.pid}\n`, { mode: 0o600 });
let cleaned = false;

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

const pauseMs = Number.parseInt(process.env.GG_INSTALL_SMOKE_PAUSE_MS ?? '0', 10);
if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));

try {
  const isolatedHome = path.join(root, 'home');
  mkdirSync(isolatedHome);
  const env = {
    ...process.env,
    GG_INSTALL_HOME: isolatedHome,
    HOME: isolatedHome,
    XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
    XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
    XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
    PATH: `${path.join(isolatedHome, '.local', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  run('make', ['install'], { cwd: project, env });
  const reinstall = run('make', ['install'], { cwd: project, env });
  if (!reinstall.stdout.includes('Installed gg at')) {
    throw new Error('make install did not replace the existing installation');
  }
  for (const relative of [
    '.agents/skills/gg-stacked-branches/SKILL.md',
    '.claude/skills/gg-stacked-branches/SKILL.md',
  ]) {
    const installedSkill = path.join(isolatedHome, relative);
    if (!existsSync(installedSkill)) {
      throw new Error(`make install did not create agent skill: ${installedSkill}`);
    }
    if (!readFileSync(installedSkill, 'utf8').includes('name: gg-stacked-branches')) {
      throw new Error(`installed agent skill was unexpected: ${installedSkill}`);
    }
  }
  const executable = path.join(isolatedHome, '.local', 'bin', 'gg');
  if (!existsSync(executable)) throw new Error('make install did not create gg');
  const help = run(executable, ['--help'], { cwd: root, env });
  if (!help.stdout.includes('stacked-branch CLI'))
    throw new Error('gg --help output was unexpected');
  unlinkSync(path.join(isolatedHome, '.local', 'share', 'gg', 'bin', 'gg'));
  run('make', ['uninstall'], { cwd: project, env });
  run('make', ['uninstall'], { cwd: project, env });
  if (existsSync(path.join(isolatedHome, '.local')))
    throw new Error('make uninstall left installation traces behind');
  if (readdirSync(isolatedHome).length > 0) {
    throw new Error('make uninstall left files outside the installation prefix');
  }

  const conflictHome = path.join(root, 'conflict-home');
  const conflictExecutable = path.join(conflictHome, '.local', 'bin', 'gg');
  mkdirSync(path.dirname(conflictExecutable), { recursive: true });
  writeFileSync(conflictExecutable, 'user-owned\n');
  const conflictEnv = { ...process.env, GG_INSTALL_HOME: conflictHome, HOME: conflictHome };
  run('make', ['install'], { cwd: project, env: conflictEnv });
  const replacementHelp = run(conflictExecutable, ['--help'], {
    cwd: root,
    env: conflictEnv,
  });
  if (!replacementHelp.stdout.includes('stacked-branch CLI')) {
    throw new Error('make install did not replace an existing gg executable');
  }
  run('make', ['uninstall'], { cwd: project, env: conflictEnv });
  if (existsSync(conflictExecutable)) {
    throw new Error('make uninstall left the replacement gg executable behind');
  }
  if (existsSync(path.join(conflictHome, '.local', 'share'))) {
    throw new Error('make uninstall left replacement package traces behind');
  }

  const blockedHome = path.join(root, 'blocked-home');
  const blockedBin = path.join(blockedHome, '.local', 'bin');
  mkdirSync(path.dirname(blockedBin), { recursive: true });
  writeFileSync(blockedBin, 'not-a-directory\n');
  expectFailure('make', ['install'], {
    cwd: project,
    env: { ...process.env, GG_INSTALL_HOME: blockedHome, HOME: blockedHome },
  });
  if (readFileSync(blockedBin, 'utf8') !== 'not-a-directory\n') {
    throw new Error('make install changed a conflicting path');
  }
  if (existsSync(path.join(blockedHome, '.local', 'share'))) {
    throw new Error('partially initialized make install left a share directory behind');
  }

  const skillConflictHome = path.join(root, 'skill-conflict-home');
  const conflictingSkill = path.join(
    skillConflictHome,
    '.agents',
    'skills',
    'gg-stacked-branches',
    'SKILL.md',
  );
  mkdirSync(path.dirname(conflictingSkill), { recursive: true });
  writeFileSync(conflictingSkill, 'user-owned\n');
  expectFailure('make', ['install'], {
    cwd: project,
    env: { ...process.env, GG_INSTALL_HOME: skillConflictHome, HOME: skillConflictHome },
  });
  if (readFileSync(conflictingSkill, 'utf8') !== 'user-owned\n') {
    throw new Error('make install changed a conflicting agent skill');
  }
  if (readdirSync(skillConflictHome).some((name) => name !== '.agents')) {
    throw new Error('failed skill installation left unrelated traces behind');
  }

  const foreignHome = path.join(root, 'foreign-home');
  const foreignPath = path.join(foreignHome, '.local', 'share', '.gg-build-user-owned');
  mkdirSync(path.dirname(foreignPath), { recursive: true });
  writeFileSync(foreignPath, 'keep\n');
  run('make', ['uninstall'], {
    cwd: project,
    env: { ...process.env, GG_INSTALL_HOME: foreignHome, HOME: foreignHome },
  });
  if (readFileSync(foreignPath, 'utf8') !== 'keep\n') {
    throw new Error('make uninstall changed an unrelated gg-like path');
  }
  if (existsSync(path.join(foreignHome, '.gg-stacked-cli-install.lock'))) {
    throw new Error('make uninstall left its lock beside an unrelated path');
  }

  const recoveryHome = path.join(root, 'recovery-home');
  const recoveryLocal = path.join(recoveryHome, '.local');
  const recoveryShare = path.join(recoveryLocal, 'share');
  const recoveryBin = path.join(recoveryLocal, 'bin');
  mkdirSync(recoveryShare, { recursive: true });
  mkdirSync(recoveryBin);
  writeFileSync(
    path.join(recoveryHome, '.gg-stacked-cli-install.lock'),
    JSON.stringify({
      schemaVersion: 1,
      product: 'gg-stacked-cli',
      pid: 99_999_999,
      eventId: 'interrupted-uninstall',
      source: project,
      createdDirectories: [recoveryLocal, recoveryShare, recoveryBin],
    }),
  );
  run('make', ['uninstall'], {
    cwd: project,
    env: { ...process.env, GG_INSTALL_HOME: recoveryHome, HOME: recoveryHome },
  });
  if (readdirSync(recoveryHome).length > 0) {
    throw new Error('make uninstall did not recover interrupted directory cleanup');
  }
  process.stdout.write(
    'Isolated make install, agent skill copies, gg --help, and trace-free uninstall succeeded.\n',
  );
} finally {
  cleanup();
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function expectFailure(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`${command} ${args.join(' ')} unexpectedly succeeded`);
}

function cleanup() {
  if (cleaned) return;
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== `${process.pid}\n`) {
    process.stderr.write(`refusing to clean unowned smoke-test directory: ${root}\n`);
    process.exitCode = 1;
    return;
  }
  rmSync(root, { recursive: true, force: true });
  cleaned = true;
}
