import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT = 'gg-stacked-cli';
const MANIFEST = '.gg-install-owner.json';
const TRANSIENT_MARKER = '.gg-transient-owner.json';
const project = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const installHome = path.resolve(process.env.GG_INSTALL_HOME ?? os.homedir());
const localDirectory = path.join(installHome, '.local');
const shareDirectory = path.join(localDirectory, 'share');
const binDirectory = path.join(localDirectory, 'bin');
const prefix = path.join(shareDirectory, 'gg');
const executable = path.join(binDirectory, 'gg');
const installedExecutable = path.join(prefix, 'bin', 'gg');
const skillName = 'gg-stacked-branches';
const skillSource = path.join(project, 'skills', skillName);
const agentsDirectory = path.join(installHome, '.agents');
const agentsSkillsDirectory = path.join(agentsDirectory, 'skills');
const claudeDirectory = path.join(installHome, '.claude');
const claudeSkillsDirectory = path.join(claudeDirectory, 'skills');
const skillTargets = [
  path.join(agentsSkillsDirectory, skillName),
  path.join(claudeSkillsDirectory, skillName),
];
const lockPath = path.join(installHome, '.gg-stacked-cli-install.lock');
const eventId = randomUUID();
const action = process.argv[2];

let lockHeld = false;
let buildRoot;
let stagingPrefix;
let backupPrefix;
let executableBackup;
let finalCreated = false;
let executableCreated = false;
let installComplete = false;
let createdDirectories = [];
let recoveredDirectories = [];
let skillReplacements = [];

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanupAfterFailure();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

try {
  if (action === 'install') install();
  else if (action === 'uninstall') uninstall();
  else throw new Error('Usage: node scripts/manage-install.mjs <install|uninstall>');
} catch (error) {
  cleanupAfterFailure();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

function install() {
  requireSupportedNode();
  const skills = skillInstallationsFromSource();
  ensureInstallDirectories();
  acquireLock();
  cleanupOwnedTransients();

  const existingExecutable = pathEntry(executable);
  if (existingExecutable?.isDirectory()) {
    throw new Error(`Refusing to replace directory at executable path: ${executable}`);
  }
  if (existingExecutable && !existingExecutable.isFile() && !existingExecutable.isSymbolicLink()) {
    throw new Error(`Refusing to replace unsupported executable path: ${executable}`);
  }

  let previousManifest;
  let previousSkills = [];
  if (existsSync(prefix)) {
    previousManifest = readAndValidateManifest(prefix);
    previousSkills = validateSkillInstallations(previousManifest.skills);
    createdDirectories = mergeDirectories(
      validateCreatedDirectories(previousManifest.createdDirectories),
      createdDirectories,
    );
    persistLockDirectories();
  }
  validateSkillTargetsForInstall(previousSkills);

  process.stdout.write('Installing...\n');
  buildRoot = createOwnedTransient('.gg-build-');
  const source = path.join(buildRoot, 'source');
  copyProject(source);
  const cache = path.join(buildRoot, 'npm-cache');
  const isolatedHome = path.join(buildRoot, 'home');
  const packageDirectory = path.join(buildRoot, 'package');
  mkdirSync(cache);
  mkdirSync(isolatedHome);
  mkdirSync(packageDirectory);
  const npmrc = path.join(buildRoot, 'npmrc');
  writeFileSync(npmrc, `cache=${cache}\naudit=false\nfund=false\nupdate-notifier=false\n`, {
    mode: 0o600,
  });
  const env = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
    XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
    XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
    npm_config_cache: cache,
    npm_config_userconfig: npmrc,
    npm_config_update_notifier: 'false',
  };

  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], source, env);
  run(
    process.execPath,
    [path.join(source, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    source,
    env,
  );
  const packed = run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packageDirectory],
    source,
    env,
  );
  const packageName = JSON.parse(packed.stdout)[0]?.filename;
  if (!packageName) throw new Error('npm pack did not report a package filename.');

  stagingPrefix = createOwnedTransient('.gg-install-');
  run(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      stagingPrefix,
      '--cache',
      cache,
      '--userconfig',
      npmrc,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--omit=dev',
      path.join(packageDirectory, packageName),
    ],
    buildRoot,
    env,
  );
  verifyExecutable(path.join(stagingPrefix, 'bin', 'gg'));
  writeJson(path.join(stagingPrefix, MANIFEST), {
    schemaVersion: 2,
    product: PRODUCT,
    source: project,
    prefix,
    executable,
    createdDirectories,
    skills,
  });

  if (previousManifest) {
    backupPrefix = path.join(shareDirectory, `.gg-backup-${eventId}`);
    if (pathEntry(backupPrefix)) {
      throw new Error(`Refusing to replace unexpected backup path: ${backupPrefix}`);
    }
    renameSync(prefix, backupPrefix);
  }
  if (pathEntry(executable) && !isOwnedExecutableLink()) {
    executableBackup = path.join(buildRoot, 'previous-executable');
    renameSync(executable, executableBackup);
  }
  renameSync(stagingPrefix, prefix);
  stagingPrefix = undefined;
  finalCreated = true;
  unlinkSync(path.join(prefix, TRANSIENT_MARKER));
  if (!isOwnedExecutableLink()) {
    symlinkSync(installedExecutable, executable);
    executableCreated = true;
  }
  verifyExecutable(executable);
  replaceSkills(skills);

  if (backupPrefix) {
    removeOwnedFinal(backupPrefix);
    backupPrefix = undefined;
  }
  executableBackup = undefined;
  skillReplacements = [];

  installComplete = true;
  finalCreated = false;
  removeOwnedTransient(buildRoot);
  buildRoot = undefined;
  releaseLock();
  process.stdout.write(`Installed gg at ${executable}.\n`);
  for (const { target } of skills) process.stdout.write(`Installed agent skill at ${target}.\n`);
  if (!pathContains(binDirectory)) {
    process.stdout.write(`Add ${binDirectory} to PATH before invoking gg.\n`);
  }
}

function uninstall() {
  const link = pathEntry(executable);
  const shareEntry = pathEntry(shareDirectory);
  if (!shareEntry?.isDirectory() && !pathEntry(lockPath)) {
    if (link && isOwnedExecutableLink()) unlinkSync(executable);
    else if (link) process.stderr.write(`Preserved unrelated executable: ${executable}\n`);
    if (shareEntry) process.stderr.write(`Preserved unrelated path: ${shareDirectory}\n`);
    process.stdout.write('gg is not installed.\n');
    return;
  }

  acquireLock();
  if (pathEntry(shareDirectory)?.isDirectory()) cleanupOwnedTransients();
  let manifest;
  if (existsSync(prefix)) manifest = readAndValidateManifest(prefix);
  createdDirectories = mergeDirectories(
    recoveredDirectories,
    validateCreatedDirectories(manifest?.createdDirectories),
  );
  persistLockDirectories();
  removeInstalledSkills(validateSkillInstallations(manifest?.skills));

  if (pathEntry(executable)) {
    if (isOwnedExecutableLink()) unlinkSync(executable);
    else process.stderr.write(`Preserved unrelated executable: ${executable}\n`);
  }
  if (existsSync(prefix)) removeOwnedFinal(prefix);

  removeEmptyDirectories(createdDirectories);
  releaseLock();
  verifyUninstalled();
  installComplete = true;
  process.stdout.write('Uninstalled gg.\n');
}

function requireSupportedNode() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node 22.13 or newer is required; found ${process.versions.node}.`);
  }
}

function ensureInstallDirectories() {
  const missing = [];
  for (const directory of [
    localDirectory,
    shareDirectory,
    binDirectory,
    agentsDirectory,
    agentsSkillsDirectory,
    claudeDirectory,
    claudeSkillsDirectory,
  ]) {
    const entry = pathEntry(directory);
    if (entry) {
      let followed;
      try {
        followed = statSync(directory);
      } catch {
        throw new Error(`Expected a directory at ${directory}.`);
      }
      if (!followed.isDirectory()) throw new Error(`Expected a directory at ${directory}.`);
      continue;
    }
    missing.push(directory);
  }
  for (const directory of missing) {
    mkdirSync(directory);
    createdDirectories.push(directory);
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const value = {
        schemaVersion: 1,
        product: PRODUCT,
        pid: process.pid,
        eventId,
        source: project,
        createdDirectories,
      };
      writeFileSync(lockPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      lockHeld = true;
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const entry = pathEntry(lockPath);
      if (!entry?.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Refusing to replace unrecognized install lock: ${lockPath}`);
      }
      const owner = readJson(lockPath);
      if (owner?.product !== PRODUCT || typeof owner.pid !== 'number') {
        throw new Error(`Refusing to replace unrecognized install lock: ${lockPath}`);
      }
      if (processIsAlive(owner.pid)) {
        throw new Error(`Another gg install operation is active (pid ${owner.pid}).`);
      }
      recoveredDirectories = mergeDirectories(
        recoveredDirectories,
        validateCreatedDirectories(owner.createdDirectories),
      );
      createdDirectories = mergeDirectories(recoveredDirectories, createdDirectories);
      unlinkSync(lockPath);
    }
  }
  throw new Error('Could not acquire the gg install lock.');
}

function releaseLock() {
  if (!lockHeld) return;
  const owner = readJson(lockPath);
  if (owner?.eventId !== eventId) {
    throw new Error(`Install lock ownership changed unexpectedly: ${lockPath}`);
  }
  unlinkSync(lockPath);
  lockHeld = false;
}

function persistLockDirectories() {
  if (!lockHeld) throw new Error('Cannot update directory ownership without the install lock.');
  const owner = readJson(lockPath);
  if (owner?.eventId !== eventId) {
    throw new Error(`Install lock ownership changed unexpectedly: ${lockPath}`);
  }
  writeJson(lockPath, { ...owner, createdDirectories });
}

function cleanupOwnedTransients() {
  for (const name of readdirSync(shareDirectory)) {
    if (name.startsWith('.gg-backup-')) {
      const target = path.join(shareDirectory, name);
      if (!isOwnedFinal(target)) {
        process.stderr.write(`Preserved unrelated gg-like path: ${target}\n`);
        continue;
      }
      removeOwnedFinal(target);
      continue;
    }
    if (!name.startsWith('.gg-build-') && !name.startsWith('.gg-install-')) continue;
    const target = path.join(shareDirectory, name);
    if (!isOwnedTransient(target)) {
      process.stderr.write(`Preserved unrelated gg-like path: ${target}\n`);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
  }
}

function createOwnedTransient(prefixName) {
  const directory = mkdtempSync(path.join(shareDirectory, prefixName));
  try {
    writeJson(path.join(directory, TRANSIENT_MARKER), {
      schemaVersion: 1,
      product: PRODUCT,
      pid: process.pid,
      eventId,
      source: project,
    });
  } catch (error) {
    try {
      rmdirSync(directory);
    } catch (cleanupError) {
      throw new Error(`Could not mark or remove temporary directory: ${directory}`, {
        cause: cleanupError,
      });
    }
    throw error;
  }
  return directory;
}

function removeOwnedTransient(directory) {
  if (!directory || !existsSync(directory)) return;
  if (!pathEntry(directory)?.isDirectory()) {
    throw new Error(`Refusing to remove unowned temporary directory: ${directory}`);
  }
  const marker = readJson(path.join(directory, TRANSIENT_MARKER));
  if (marker?.product !== PRODUCT || marker.eventId !== eventId) {
    throw new Error(`Refusing to remove unowned temporary directory: ${directory}`);
  }
  rmSync(directory, { recursive: true, force: true });
}

function removeOwnedFinal(directory) {
  readAndValidateManifest(directory);
  rmSync(directory, { recursive: true, force: true });
}

function readAndValidateManifest(directory) {
  if (!pathEntry(directory)?.isDirectory()) {
    throw new Error(`Refusing to modify unrecognized installation directory: ${directory}`);
  }
  const manifest = readJson(path.join(directory, MANIFEST));
  if (
    ![1, 2].includes(manifest?.schemaVersion) ||
    manifest.product !== PRODUCT ||
    manifest.prefix !== prefix ||
    manifest.executable !== executable
  ) {
    throw new Error(`Refusing to modify unrecognized installation directory: ${directory}`);
  }
  validateCreatedDirectories(manifest.createdDirectories);
  validateSkillInstallations(manifest.skills);
  return manifest;
}

function skillInstallationsFromSource() {
  const entry = pathEntry(skillSource);
  if (!entry?.isDirectory() || !existsSync(path.join(skillSource, 'SKILL.md'))) {
    throw new Error(`Missing bundled agent skill: ${skillSource}`);
  }
  const digest = digestDirectory(skillSource);
  return skillTargets.map((target) => ({ target, digest }));
}

function validateSkillTargetsForInstall(previousSkills) {
  const previousByTarget = new Map(previousSkills.map((skill) => [skill.target, skill]));
  for (const target of skillTargets) {
    const entry = pathEntry(target);
    if (!entry) continue;
    const previous = previousByTarget.get(target);
    if (!previous) throw new Error(`Refusing to replace unrecognized agent skill: ${target}`);
    if (!entry.isDirectory() || digestDirectory(target) !== previous.digest) {
      throw new Error(`Refusing to replace modified agent skill: ${target}`);
    }
  }
}

function replaceSkills(skills) {
  for (const [index, skill] of skills.entries()) {
    const backup = pathEntry(skill.target)
      ? path.join(buildRoot, `skill-backup-${index}`)
      : undefined;
    if (backup) renameSync(skill.target, backup);
    skillReplacements.push({ target: skill.target, backup });
    cpSync(skillSource, skill.target, { recursive: true, errorOnExist: true });
    if (digestDirectory(skill.target) !== skill.digest) {
      throw new Error(`Installed agent skill failed validation: ${skill.target}`);
    }
  }
}

function removeInstalledSkills(skills) {
  for (const skill of skills) {
    const entry = pathEntry(skill.target);
    if (!entry) continue;
    if (!entry.isDirectory() || digestDirectory(skill.target) !== skill.digest) {
      process.stderr.write(`Preserved modified agent skill: ${skill.target}\n`);
      continue;
    }
    rmSync(skill.target, { recursive: true, force: true });
  }
}

function digestDirectory(directory) {
  const digest = createHash('sha256');
  const visit = (current, relative) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        digest.update(`directory\0${childRelative}\0`);
        visit(child, childRelative);
      } else if (entry.isFile()) {
        digest.update(`file\0${childRelative}\0`);
        digest.update(readFileSync(child));
        digest.update('\0');
      } else {
        throw new Error(`Agent skill contains an unsupported path: ${child}`);
      }
    }
  };
  visit(directory, '');
  return digest.digest('hex');
}

function copyProject(destination) {
  const excluded = new Set(['.git', 'node_modules', 'dist', 'coverage']);
  cpSync(project, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(project, source);
      const first = relative.split(path.sep)[0];
      return relative === '' || !excluded.has(first);
    },
  });
}

function verifyExecutable(command) {
  const result = spawnSync(command, ['--help'], {
    cwd: installHome,
    encoding: 'utf8',
    env: { ...process.env, HOME: installHome },
    timeout: 30_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.includes('stacked-branch CLI')) {
    throw new Error(`Installed executable failed validation: ${command}`);
  }
}

function verifyUninstalled() {
  if (isOwnedExecutableLink()) throw new Error(`Owned executable still exists: ${executable}`);
  if (existsSync(prefix)) throw new Error(`Installation directory still exists: ${prefix}`);
  if (existsSync(lockPath)) throw new Error(`Install lock still exists: ${lockPath}`);
  if (pathEntry(shareDirectory)?.isDirectory()) {
    for (const name of readdirSync(shareDirectory)) {
      if (
        name.startsWith('.gg-build-') ||
        name.startsWith('.gg-install-') ||
        name.startsWith('.gg-backup-')
      ) {
        const target = path.join(shareDirectory, name);
        if ((name.startsWith('.gg-backup-') && isOwnedFinal(target)) || isOwnedTransient(target)) {
          throw new Error(`Temporary install directory still exists: ${target}`);
        }
      }
    }
  }
}

function isOwnedTransient(directory) {
  if (!pathEntry(directory)?.isDirectory()) return false;
  try {
    const marker = readJson(path.join(directory, TRANSIENT_MARKER));
    return marker?.schemaVersion === 1 && marker.product === PRODUCT;
  } catch {
    return false;
  }
}

function isOwnedFinal(directory) {
  try {
    readAndValidateManifest(directory);
    return true;
  } catch {
    return false;
  }
}

function cleanupAfterFailure() {
  let ownedCleanupComplete = true;
  try {
    for (const replacement of [...skillReplacements].reverse()) {
      if (pathEntry(replacement.target)) {
        rmSync(replacement.target, { recursive: true, force: true });
      }
      if (replacement.backup && pathEntry(replacement.backup)) {
        renameSync(replacement.backup, replacement.target);
      }
    }
    skillReplacements = [];
  } catch {
    ownedCleanupComplete = false;
    // Best-effort cleanup must continue through every owned path.
  }
  try {
    if (stagingPrefix) removeOwnedTransient(stagingPrefix);
  } catch {
    ownedCleanupComplete = false;
    // Best-effort cleanup must continue through every owned path.
  }
  try {
    if (finalCreated && existsSync(prefix)) removeOwnedFinal(prefix);
  } catch {
    ownedCleanupComplete = false;
    // Best-effort cleanup must continue through every owned path.
  }
  try {
    if (backupPrefix && existsSync(backupPrefix) && !existsSync(prefix)) {
      renameSync(backupPrefix, prefix);
      backupPrefix = undefined;
    }
  } catch {
    ownedCleanupComplete = false;
    // Best-effort cleanup must continue through every owned path.
  }
  try {
    if (executableCreated && isOwnedExecutableLink()) unlinkSync(executable);
  } catch {
    ownedCleanupComplete = false;
    // Best-effort cleanup must continue through every owned path.
  }
  try {
    if (executableBackup && existsSync(executableBackup) && !pathEntry(executable)) {
      renameSync(executableBackup, executable);
      executableBackup = undefined;
    }
  } catch {
    ownedCleanupComplete = false;
    // Best-effort cleanup must continue through every owned path.
  }
  try {
    if (buildRoot && (!executableBackup || !existsSync(executableBackup))) {
      removeOwnedTransient(buildRoot);
    } else if (executableBackup && existsSync(executableBackup)) {
      ownedCleanupComplete = false;
    }
  } catch {
    ownedCleanupComplete = false;
    // Best-effort cleanup must continue through every owned path.
  }
  let directoryCleanupComplete = true;
  try {
    if (!installComplete) removeEmptyDirectories(createdDirectories);
  } catch {
    directoryCleanupComplete = false;
    // Keep the recovery lock so a later uninstall can retry owned-directory cleanup.
  }
  try {
    if (lockHeld && ownedCleanupComplete && (installComplete || directoryCleanupComplete)) {
      releaseLock();
    }
  } catch {
    // Best-effort cleanup cannot safely remove a lock it no longer owns.
  }
}

function removeEmptyDirectories(directories) {
  for (const directory of [...directories].reverse()) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
  }
}

function validateCreatedDirectories(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Installer metadata has invalid directory ownership.');
  const allowed = new Set([
    localDirectory,
    shareDirectory,
    binDirectory,
    agentsDirectory,
    agentsSkillsDirectory,
    claudeDirectory,
    claudeSkillsDirectory,
  ]);
  if (value.some((directory) => typeof directory !== 'string' || !allowed.has(directory))) {
    throw new Error('Installer metadata has invalid directory ownership.');
  }
  return [...new Set(value)];
}

function validateSkillInstallations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Installer metadata has invalid agent skills.');
  const allowed = new Set(skillTargets);
  const seen = new Set();
  for (const skill of value) {
    if (
      !skill ||
      typeof skill !== 'object' ||
      !allowed.has(skill.target) ||
      typeof skill.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(skill.digest) ||
      seen.has(skill.target)
    ) {
      throw new Error('Installer metadata has invalid agent skills.');
    }
    seen.add(skill.target);
  }
  return value.map(({ target, digest }) => ({ target, digest }));
}

function mergeDirectories(...groups) {
  return [...new Set(groups.flat())];
}

function isOwnedExecutableLink() {
  const entry = pathEntry(executable);
  return Boolean(entry?.isSymbolicLink() && readlinkSync(executable) === installedExecutable);
}

function pathContains(directory) {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((entry) => path.resolve(entry) === path.resolve(directory));
}

function pathEntry(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`Could not read installer metadata: ${file}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}
