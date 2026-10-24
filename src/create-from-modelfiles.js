#!/usr/bin/env node
// src/create-from-modelfiles.js
//
// Converts every Ollama Modelfile in a directory: either `ollama create`
// (if preferred) or a llama-cli TOML config written next to the others.
//
// Usage:
//   create-from-modelfiles

require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { transparentSpawn } = require('./utils/spawn-helper');
const { globalYargsOptions, modelFilesYargsOptions, godotCoverageYargsOptions, commonYargsOptions, docsAndPromptsYargsOptions } = require('./utils/cli-parse-utils');
const { modelfileToToml } = require('./utils/ollama-model-file-utils');
// const jsUtils = require('./utils/js-utils');
const nodeUtils = require('./utils/node-utils');
// ollama create gemma4-collab-coder -f ~/Labs/ollama-model-files/gemma4-collab-coder.Modelfile

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.join(SCRIPT_DIR, '..');

const MODELFILE_DIR = `${ROOT_DIR}/docs/model-files`;
const TOML_OUT_DIR = `${ROOT_DIR}/docs/llama-configs`;

const argv = globalYargsOptions(modelFilesYargsOptions(commonYargsOptions(
  yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
  )))
  .option('dir', { type: 'string', default: MODELFILE_DIR, describe: 'Modelfile directory' })
  .option('out', { type: 'string', default: TOML_OUT_DIR, describe: 'TOML output directory' })
  .help()
  .alias('help', 'h')
  .argv;

function listModelfiles(modelFileDirPath) {
  const dir = nodeUtils.homePrefixToEnvHome(modelFileDirPath);
  return fs.readdirSync(dir)
    .filter((f) => /\.Modelfile$/i.test(f))
    .map((f) => path.join(dir, f));
}

async function convert(modelFilePath) {
  const tagName = path.basename(modelFilePath).replace(/\.Modelfile$/i, '');

  if (argv.isOllamaPrefered) {
    await transparentSpawn('ollama', ['create', tagName, '-f', modelFilePath]).promise;
    return;
  }

  const outDir = nodeUtils.homePrefixToEnvHome(argv.out);
  const outPath = path.join(outDir, `${tagName}.toml`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, modelfileToToml(modelFilePath, tagName));
  console.log(`Wrote ${outPath}`);
}

async function main() {
  const files = listModelfiles(MODELFILE_DIR);
  if (!files.length) {
    console.log('No Modelfiles found.');
    return;
  }
  fs.mkdirSync(TOML_OUT_DIR, { recursive: true, force: true });

  let failed = 0;
  for (const file of files) {
    try {
      await convert(file);
    } catch (err) {
      failed++;
      console.error(`FAILED ${file}: ${err.message}`);
    }
  }
  console.log(`Done: ${files.length - failed}/${files.length} ok`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
