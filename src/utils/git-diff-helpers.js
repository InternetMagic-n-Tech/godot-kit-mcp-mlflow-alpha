const fs = require('node:fs');
const path = require('node:path');
const { collectStream } = require('./cli-parse-utils');
const nodeUtils = require('./node-utils');
const { muteTSpawn, transparentSpawn } = require('./spawn-helper');

const ROOT_DIR = path.join(__dirname, '../..');
// Noise Godot/the test harness generates. Git pathspecs, relative to the project root.
const DEFAULT_EXCLUDES = ['.godot/', 'coverage*', '*.uid', '*.import'];
const GIT_IGNORE_FILE = '.gitignore';
const GIT_ATTRIBUTES_FILE = '.gitattributes';
const INIT_INCLUDES = ['addons', 'scenes', 'scenes', 'screenshots', 'scripts', 'sounds', 'sprites', 'tests', '.editorconfig', GIT_ATTRIBUTES_FILE, GIT_IGNORE_FILE, '.gutconfig.json', 'icon.png', 'LICENSE', 'project.godot', 'README.md', 'splash-screen.png'];
const ADD_INCLUDES = [...INIT_INCLUDES, '*.gd', '*.cs', '*.import', '*.uuid'];
// Run git through transparentSpawn, capturing stdout instead of echoing it.
async function git(cwd, args) {
  const spawnedGit = transparentSpawn(
    'git',
    ['-c', 'core.quotepath=false', ...args],
    undefined,
    cwd,
    undefined,
    muteTSpawn,
  );
  const gitOut = collectStream(spawnedGit.child.stdout);
  const gitErr = collectStream(spawnedGit.child.stderr);

  await spawnedGit.promise;
  await Promise.all([gitOut.done, gitErr.done]);

  const spawnStdout = gitOut.text();
  const spawnStderr = gitErr.text();

  if ((spawnStderr || '').trim()) {
    throw new Error(`Got an error\n${spawnStderr}`);
  }

  return spawnStdout;
}

/**
 * @param {string} projectAbs absolute path to a project that has a .git folder
 * @param {{ exclude?: string[] }} [opts] extra pathspecs to leave out of the diff
 * @returns {Promise<null | { patch: string, numstat: Array<{file: string, added: number, removed: number}>,
 *   files: number, added: number, removed: number }>} null when there is no git repo to diff
 */
async function captureDiff(projectAbs, { exclude = [] } = {}) {
  if (!fs.existsSync(path.join(projectAbs, '.git'))) return null;

  const specs = ['.', ...[...DEFAULT_EXCLUDES, ...exclude].map((p) => `:(exclude)${p}`)];

  // Diff against the ROOT commit, not HEAD: if the agent ran `git commit` itself,
  // HEAD has moved and a HEAD diff would silently hide its work.
  const roots = (await git(projectAbs, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n');
  const base = roots[roots.length - 1];

  await git(projectAbs, ['add', '-A', '--', ...specs]);   // stage so brand-new files show up
  const patch = await git(projectAbs, ['diff', '--cached', base, '--', ...specs]);
  const numstatRaw = await git(projectAbs, ['diff', '--cached', '--numstat', base, '--', ...specs]);

  const numstat = numstatRaw.trim().split('\n').filter(Boolean).map((line) => {
    const [a, r, ...file] = line.split('\t');
    return { file: file.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 }; // binary => "-"
  });

  await git(projectAbs, ['reset', '-q']);

  return {
    patch,
    numstat,
    files: numstat.length,
    added: numstat.reduce((s, r) => s + r.added, 0),
    removed: numstat.reduce((s, r) => s + r.removed, 0),
  };
}

// Capture + upload `diff.patch` and log diff_* metrics on an MLflow run.
// An empty diff.patch means "no changes"; a missing one means "not captured".
async function recordDiff(run, projectAbs, opts) {
  const d = await captureDiff(projectAbs, opts);
  if (!d) {
    console.warn(`No .git in ${projectAbs}; skipping diff capture`);
    return null;
  }
  await run.uploadArtifact('diff.patch', d.patch);
  await run.logMetrics({
    diff_files: d.files,
    diff_lines_added: d.added,
    diff_lines_removed: d.removed,
  });
  return d;
}

async function initDiff(projectDir, pathPrefix = null) {
  const prefix = nodeUtils.homePrefixToEnvHome(pathPrefix || '');
  const alteredEnv = {
    ...process.env,
    ...(prefix ? { PATH: `${prefix}:${process.env.PATH}` } : {}),
  };
  if (!fs.existsSync(`${ROOT_DIR}/${projectDir}/.git`)) {
    await transparentSpawn('git', ['init'], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise;
    await (transparentSpawn('git', ['lfs', 'install'], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise.catch((e) => {
      console.log(`Could not install \`git-lfs\`.  You may need to do the following:
 - Windows:
	 - Using Winget: \`winget install GitHub.GitLFS\`
	 - Using Chocolatey: \`choco install git-lfs\`
	 - Alternative: Download and run the installer from the official github.com website.
	 - ??? Ensure the path to \`git-lfs\` is on the PATH Environment Variables (Windows Settings) ???
 - macOS:
	 - Using Homebrew: \`brew install git-lfs\`
	 - Using Ports: \`sudo port selfupdate && sudo port install git-lfs\`
 - Linux:
   - Apt: \`sudo apt-get install git-lfs\`
   - Pacman: \`sudo pacman -S git-lfs\`
	 - \`dnf\`: \`(curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.rpm.sh | sudo bash) && sudo dnf install git-lfs \``
      );
      throw e;
    }));
    await transparentSpawn('git', ['add', GIT_IGNORE_FILE], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise;
    await transparentSpawn('git', ['add', GIT_ATTRIBUTES_FILE], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise;
    await transparentSpawn('git', ['add', ...INIT_INCLUDES], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise;
    await transparentSpawn('git', ['commit', '-m', '"Init"'], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise;
  }
}

async function commitGodotFilesDiff(projectDir, { pathPrefix = null, addPaths = [], commitMessage = null, stampLocale = null }) {
  const prefix = nodeUtils.homePrefixToEnvHome(pathPrefix || '');
  const alteredEnv = {
    ...process.env,
    ...(prefix ? { PATH: `${prefix}:${process.env.PATH}` } : {}),
  };
  await transparentSpawn('git', ['add', ...ADD_INCLUDES, ...addPaths], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise;
  await transparentSpawn('git', ['commit', '--no-verify', '-m', commitMessage || `"Changes for MCP Experiment Run at ${new Date().toLocaleString(stampLocale || 'en-GB')}"`], alteredEnv, `${ROOT_DIR}/${projectDir}`, undefined, muteTSpawn).promise;
}

module.exports = { initDiff, commitGodotFilesDiff, captureDiff, recordDiff, ADD_INCLUDES, INIT_INCLUDES, DEFAULT_EXCLUDES };
