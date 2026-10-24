#!/usr/bin/env node
// setup-rag-based-on-godot-version.js
//
// Optionally resets the Starter-Kit-Match-3 project from its -org copy and
// opens it once in Godot to regenerate the .godot/ folder, then reads
// config/features from project.godot to determine the Godot version in use,
// clones the matching branch of the official godot-docs repo (raw .rst
// source, no Sphinx build), chunks the class reference docs, and indexes
// them into Chroma for local RAG use.
//
// Usage:
//   node src/setup-rag-based-on-godot-version.js /path/to/Starter-Kit-Match-3-org [output_dir]
//
// If output_dir is omitted, docs are cloned into ./godot-docs-<version>
//
// Reset behavior (deletes everything but .git in the target project dir,
// copies the -org contents in, then opens the project in Godot once):
//   --reset / --no-reset   explicit CLI flag, wins over everything else
//   RESET_MATCH3=true|false  env var, used when no CLI flag is passed
//   interactive prompt      used when neither is set and stdin is a TTY
//   default: No             used when neither is set and stdin is not a TTY

require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { transparentSpawn } = require('./utils/spawn-helper');
const { commonYargsOptions, parseBool, promptYesNo, fail } = require('./utils/cli-parse-utils.js');
const { detectVersion, resetMatch3Project, getGodotExecFromConfig } = require('./utils/godot-helpers');

const ALLOW_GIT_GODOT_DOCS_CHECKOUT = true;
const ALLOW_GIT_GUT_CHECKOUT = false;
// const ALLOW_GIT_GUT_CHECKOUT = true;
const ALLOW_GIT_GODOT_COVERAGE_CHECKOUT = false;
// const ALLOW_GIT_GODOT_COVERAGE_CHECKOUT = true;
const GODOT_DOCS_REPO_URL = 'https://github.com/godotengine/godot-docs.git';
const GUT_REPO_URL = 'https://github.com/bitwes/Gut.git';
const GODOT_COVERAGE_URL = 'https://github.com/jamie-pate/godot-code-coverage.git'
const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.join(__dirname, '..');
const PY_SCRIPT_DIR = path.join(__dirname, '..');
const GODOT_COVERAGE_DIR = `${ROOT_DIR}/_tmp_godot_coverage`;


function findPythonBin() {
  const { spawnSync } = require('node:child_process');
  for (const candidate of ['python3', 'python']) {
    const which = spawnSync('command', ['-v', candidate], { shell: '/bin/bash' });
    if (which.status !== 0) continue;

    const check = spawnSync(
      candidate,
      ['-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'],
    );
    if (check.status === 0) {
      return candidate;
    }
  }
  return null;
}

function countRstFiles(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.rst')) {
        count += 1;
      }
    }
  }
  return count;
}

async function main() {
  const argv = commonYargsOptions(
    yargs(hideBin(process.argv))
      /*
      .usage('$0 <projectDir> [outputDir]', 'Set up a Godot-docs RAG index for a project, optionally resetting the project first', (y) => {
        y
          .positional('projectDir', {
            describe: "Path to the Godot project (e.g. Starter-Kit-Match-3)",
            type: 'string',
            default: process.env.GODOT_PROJECT_PATH || 'Starter-Kit-Match-3',
          })
          .positional('outputDir', {
            describe: 'Where to clone godot-docs into (default: ./godot-docs-<version>)',
            type: 'string',
            default: process.env.OUTPUT_PATH || ROOT_DIR,
          });
      })
      .usage('$0', 'Set up a Godot-docs RAG index for a project, optionally resetting the project first')
      */
    )
    .option('godot-docs-output-dir', {
      describe: 'Where to clone godot-docs into (default: ./godot-docs-<version>)',
      type: 'string',
      default: process.env.GODOT_DOCS_OUTPUT_PATH,
    })
    .option('reset', {
      describe: "Reset the project dir from --org-dir before running (overrides RESET_MATCH3 env var and the prompt)",
      type: 'boolean',
      default: undefined,
    })
    .help()
    .alias('help', 'h')
    .parseSync();

  // const projectDir = argv.projectDir || argv._[0];
  const projectDir = argv.projectDir;
  if (!projectDir) {
    fail('Usage: node src/setup-rag-based-on-godot-version.js');
  }
  // const outputDirArg = argv.outputDir || argv._[1];
  // const godotDocsOutputDir = argv.godotDocsOutputDir || argv._[1];
  const godotDocsOutputDir = argv.godotDocsOutputDir;
  fs.mkdirSync(`${ROOT_DIR}/runs`, { recursive: true, force: true });

  // --- Reset step (top of main) ---------------------------------------
  const godotExecFromConfig = fs.existsSync(argv.mcpConfig)
    ? getGodotExecFromConfig(argv.mcpConfig)
    : null;

  let shouldReset;
  if (typeof argv.reset === 'boolean') {
    shouldReset = argv.reset;
  } else {
    const envChoice = parseBool(process.env.RESET_MATCH3);
    if (envChoice !== null) {
      shouldReset = envChoice;
    } else {
      shouldReset = await promptYesNo(
        `Reset '${projectDir}' from '${argv.orgDir}'? This deletes everything except .git`,
        false,
      );
    }
  }

  if (shouldReset) {
    await resetMatch3Project({
      orgDir: argv.orgDir,
      targetDir: projectDir,
      godotExec: godotExecFromConfig,
    });
  } else {
    console.log('Skipping project reset.');
  }
  // ----------------------------------------------------------------------

  const projectFile = path.join(projectDir, 'project.godot');
  if (!fs.existsSync(projectFile)) {
    fail(`Error: could not find project.godot at: ${projectFile}`);
  }

  const version = detectVersion(projectFile);
  console.log(`Detected Godot project version: ${version}`);

  const outputDir = godotDocsOutputDir || `godot-docs-${version}`;


  if (ALLOW_GIT_GODOT_DOCS_CHECKOUT) {
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    console.log(`Attempting to clone branch '${version}' from ${GODOT_DOCS_REPO_URL} ...`);
    try {
      const { promise } = transparentSpawn('git', [
        'clone', '--depth', '1', '--branch', version, GODOT_DOCS_REPO_URL, outputDir,
      ], process.env, ROOT_DIR);
      await promise;
      console.log(`Cloned branch ${version} into ${outputDir}`);
    } catch {
      console.log(`Branch '${version}' not found. Falling back to 'stable' branch...`);
      const { promise } = transparentSpawn('git', [
        'clone', '--depth', '1', '--branch', 'stable', GODOT_DOCS_REPO_URL, outputDir,
      ], process.env, ROOT_DIR);
      await promise;
      console.log(`Cloned 'stable' branch into ${outputDir} (note: this may not exactly match version ${version})`);
    }
  }


  const rstCount = countRstFiles(outputDir);
  console.log(`Done. Found ${rstCount} .rst source files under ${outputDir}.`);
  console.log(`Class reference lives under: ${outputDir}/classes/`);

  const pythonBin = findPythonBin();
  if (!pythonBin) {
    fail(
      "Error: no Python 3 interpreter found (checked 'python3' and 'python').\n" +
      'Install Python 3 and re-run, or run chunk_godot_docs.py manually once it\'s available.',
    );
  }
  console.log(`Using Python interpreter: ${pythonBin}`);

  const venvDir = path.join(ROOT_DIR, 'godot-rag-venv');
  const venvPython = path.join(venvDir, 'bin', 'python3');
  if (!fs.existsSync(venvPython)) {
    fail(
      `Error: venv not found at ${venvDir}\n` +
      `Create it first: python3 -m venv ${venvDir} && source ${venvDir}/bin/activate && pip install chromadb requests`,
    );
  }

  const chunker = path.join(PY_SCRIPT_DIR, 'chunk_godot_docs.py');
  const chunksOutput = `${ROOT_DIR}/chunks-${version}.json`;

  if (!fs.existsSync(chunker)) {
    fail(`Error: could not find chunk_godot_docs.py next to this script at: ${chunker}`);
  }

  if (ALLOW_GIT_GODOT_DOCS_CHECKOUT) {
    try {
      fs.unlinkSync(chunksOutput);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err; // Re-throw any error that isn't "File not found"
      }
    }
    console.log('Chunking class reference docs...');
    await transparentSpawn(venvPython, [
      chunker, outputDir, chunksOutput,
      '--include', 'classes',
      '--max-chars', '2000',
    ]).promise;
    console.log(`Wrote chunks to ${chunksOutput}`);
  }

  const indexer = path.join(PY_SCRIPT_DIR, 'index_godot_docs.py');
  const versionUnderscores = version.replace(/\./g, '_');

  if (!fs.existsSync(chunksOutput)) {
    fail(`Error: could not find ${chunksOutput} (expected it to have been written above).`);
  }
  if (!fs.existsSync(indexer)) {
    fail(`Error: could not find index_godot_docs.py next to this script at: ${indexer}`);
  }

  console.log('Embedding and indexing chunks into Chroma...');
  await transparentSpawn(venvPython, [
    indexer, chunksOutput,
    '--collection', `godot_${versionUnderscores}`,
    '--db-path', `${ROOT_DIR}/godot_docs_db`,
    '--query', "how do I get started",
  ]).promise;

  if (ALLOW_GIT_GUT_CHECKOUT) {
    const gutVersion = "v9.6.1";
    const gutOutputDir = `gut_${gutVersion}`;
    if (fs.existsSync(gutOutputDir)) {
      fs.rmSync(gutOutputDir, { recursive: true, force: true });
    }
    console.log(`Attempting to clone branch '${gutVersion}' from ${GUT_REPO_URL} ...`);
    try {
      const { promise } = transparentSpawn('git', [
        'clone', '--depth', '1', '--branch', gutVersion, GUT_REPO_URL, gutOutputDir,
      ], process.env, ROOT_DIR);
      await promise;
      console.log(`Cloned branch ${gutVersion} into ${gutOutputDir}`);
    } catch {
      console.log(`Branch '${gutVersion}' not found. Falling back to 'stable' branch...`);
      const { promise } = transparentSpawn('git', [
        'clone', '--depth', '1', '--branch', 'stable', GUT_REPO_URL, gutOutputDir,
      ], process.env, ROOT_DIR);
      await promise;
      console.log(`Cloned 'stable' branch into ${gutOutputDir} (note: this may not exactly match version ${gutVersion})`);
    }
  }
  if (ALLOW_GIT_GODOT_COVERAGE_CHECKOUT) {
    // const godotCoverageVersion = 'main';// 3c92852d0822a1a8ed3d7d0a89b489c636afe992
    const godotCoverageVersion = '3c92852d0822a1a8ed3d7d0a89b489c636afe992';
    const godotCoverageOutputDir = GODOT_COVERAGE_DIR;
    if (fs.existsSync(godotCoverageOutputDir)) {
      fs.rmSync(godotCoverageOutputDir, { recursive: true, force: true });
    }
    console.log(`Attempting to clone branch '${godotCoverageVersion}' from ${GODOT_COVERAGE_URL} ...`);
    try {
      const { promise } = transparentSpawn('git', [
        'clone', '--depth', '1', '--branch', godotCoverageVersion, GODOT_COVERAGE_URL, godotCoverageOutputDir,
      ], process.env, ROOT_DIR);
      await promise;
      console.log(`Cloned branch ${godotCoverageVersion} into ${godotCoverageOutputDir}`);
    } catch {
      console.log(`Branch '${godotCoverageVersion}' not found. Falling back to 'stable' branch...`);
      const { promise } = transparentSpawn('git', [
        'clone', '--depth', '1', '--branch', 'stable', GODOT_COVERAGE_URL, godotCoverageOutputDir,
      ], process.env, ROOT_DIR);
      await promise;
      console.log(`Cloned 'stable' branch into ${godotCoverageOutputDir} (note: this may not exactly match version ${godotCoverageVersion})`);
    }

    fs.cpSync(`${GODOT_COVERAGE_DIR}/addons/coverage`, `${GODOT_COVERAGE_DIR}/addons/coverage`, { recursive: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
