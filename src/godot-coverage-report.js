#!/usr/bin/env node

require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { godotCoverageYargsOptions, commonYargsOptions } = require('./utils/cli-parse-utils');
const { transparentSpawn } = require('./utils/spawn-helper');
const { getGodotExecFromConfig } = require('./utils/godot-helpers');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.join(SCRIPT_DIR, '..');

const argv = commonYargsOptions(godotCoverageYargsOptions(yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
  ))
  .option('target', {
    describe: 'Coverage target percentage',
    type: 'number',
    default: 0,
  })
  .option('file-target', {
    describe: 'Per-file coverage target percentage',
    type: 'number',
    default: 0,
  })
  .option('verbosity', {
    describe: 'Verbosity level (0=none, 1=filenames, 3=failing files, 4=partial, 5=all files)',
    type: 'number',
    default: 3,
  })
  .help()
  .alias('help', 'h')
  .argv;

async function main() {
  const mcpConfig = argv.mcpConfig;
  const godot = fs.existsSync(mcpConfig)
    ? getGodotExecFromConfig(mcpConfig)
    : null;
  const verbosity = argv.verbosity;
  const target = argv.target;
  const fileTarget = argv.fileTarget;
  const coverageFile = argv.coverageFile;
  const projectDir = path.resolve(`${ROOT_DIR}/${argv.projectDir}`);
  const coverageJsonPath = path.resolve(`${projectDir}/${coverageFile}`);

  const baseArgs = argv.godotHeadless ? ['--headless'] : [];

  await transparentSpawn(
    godot,
    [...baseArgs, '-s', 'addons/gut/gut_cmdln.gd', '-gconfig=res://.gutconfig.json', '-gexit'],
    { ...process.env, COVERAGE_FILE: coverageFile },
    projectDir,
  ).promise;

  console.log('\nCOVERAGE REPORT:');

  if (!fs.existsSync(coverageJsonPath)) {
    console.error(`Expected coverage file not found at ${coverageJsonPath}.`);
    console.error('Check that post_run_hook.gd calls coverage.save_coverage_file("' + coverageJsonPath + '").');
    process.exit(1);
  }

  await transparentSpawn(
    godot,
    [
      ...baseArgs,
      '-s', 'addons/coverage/merge_coverage.gd',
      '--verbosity', String(verbosity),
      '--target', String(target),
      '--file-target', String(fileTarget),
      coverageFile,
    ],
    process.env,
    projectDir,
  ).promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
