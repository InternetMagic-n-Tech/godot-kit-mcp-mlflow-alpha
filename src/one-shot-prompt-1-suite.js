#!/usr/bin/env node
// src/one-shot-prompt-1-suite.js

require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { muteTSpawn, transparentSpawn } = require('./utils/spawn-helper');
const { pick3GodotExperimentYargsOptions, globalYargsOptions, ollamaYargsOptions, godotCoverageYargsOptions, commonYargsOptions, docsAndPromptsYargsOptions, parseBool } = require('./utils/cli-parse-utils');
const jsUtils = require('./utils/js-utils');
const nodeUtils = require('./utils/node-utils');
const identHelpers = require('./utils/ident-helpers');
const { resetMatch3Project, getGodotExecFromConfig } = require('./utils/godot-helpers');

const ROOT_DIR = path.join(__dirname, '..');
// for now we don't need to rebuild project
const IS_REBUILD_DOCS_ON_RUN = false;

async function main() {
  const argv = pick3GodotExperimentYargsOptions(globalYargsOptions(ollamaYargsOptions(godotCoverageYargsOptions(commonYargsOptions(docsAndPromptsYargsOptions(
    yargs(hideBin(process.argv))
      .usage('$0', 'Run Kit one-shot as suite')
    ))))))
    .option('is-single-config', {
      describe: 'Prefered `ollama` over `llama-cli`',
      // alias: 'single-config',
      type: 'boolean',
      default: 'IS_SINGLE_CONFIG' in process.env ? parseBool(process.env.IS_SINGLE_CONFIG) : false,
    })
    .help()
    .alias('help', 'h')
    .parseSync();

  const tSpawnMute = argv.verbose ? muteTSpawn : undefined;
  const MODELS = [...new Set([
      argv.model,
    // gemma4:e2b models
      `ollama/${process.env.COMPARE_KIT_ALT_1}`, `ollama/${process.env.COMPARE_KIT_TERSE_ALT_1}`,
      `ollama/${process.env.COMPARE_KIT_LOW_TEMP_ALT_1}`, `ollama/${process.env.COMPARE_KIT_HIGH_TEMP_ALT_1}`,
    // qwen2.5 models
      `ollama/${process.env.COMPARE_KIT_ALT_2}`, `ollama/${process.env.COMPARE_KIT_TERSE_ALT_2}`,
      `ollama/${process.env.COMPARE_KIT_LOW_TEMP_ALT_2}`, `ollama/${process.env.COMPARE_KIT_HIGH_TEMP_ALT_2}`,
    // qwen-2.5-coder models
      `ollama/${process.env.COMPARE_KIT_ALT_3}`, `ollama/${process.env.COMPARE_KIT_TERSE_ALT_3}`,
      `ollama/${process.env.COMPARE_KIT_LOW_TEMP_ALT_3}`, `ollama/${process.env.COMPARE_KIT_HIGH_TEMP_ALT_3}`,
  ])].filter(s => !!s);
  const CONFIGS = [...new Set([
    argv.mcpConfig,
    ...(!argv.isSingleConfig
      ? ['mcp-config.json', 'mcp-config-non-rag.json', 'mcp-config-non-rag-non-fetch.json']
      : []
    ),
  ])].filter(s => !!s);

  const orgDir = argv.orgDir;
  const projectDir = argv.projectDir;
  const runsDir = argv.runDir || 'runs';
  const prefix = nodeUtils.homePrefixToEnvHome(argv.pathPrefix || '');
  const alteredEnv = {
    ...process.env,
    ...(prefix ? { PATH: `${prefix}:${process.env.PATH}` } : {}),
  };

  fs.mkdirSync(`${ROOT_DIR}/${runsDir}`, { recursive: true, force: true });

  const promptsPath = path.join(ROOT_DIR, argv.promptsDir);
  const dirMod = jsUtils.checkLTrim(path.resolve(promptsPath), ROOT_DIR);
  const promptFile = path.resolve(ROOT_DIR, argv.docsDir, jsUtils.checkLTrim(dirMod, '/'), argv.promptFile);
  const relPromptFile = jsUtils.checkLTrim(promptFile, `${ROOT_DIR}/`);

  for (const model of MODELS) {
    await fetch(`${argv.ollamaUrl}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: model })
    });
    for (const config of CONFIGS) {
      const projectParam = `${projectDir}--M-${identHelpers.modelNameClean(identHelpers.makeSha(model))}--C-${identHelpers.makeSha(config)}--P-${identHelpers.makeSha(relPromptFile)}`;
      const params = [
        ...(model ? ['--model', model] : []),
        '--mcp-config', config,
        '--project-dir', projectParam,
        '--prompts-dir', argv.promptsDir,
        '--prompt-file', argv.promptFile,
        '--org-dir', argv.orgDir,
      ];
      const godotExecFromConfig = getGodotExecFromConfig(config);
      if (fs.existsSync(`${ROOT_DIR}/${projectParam}`)) {
        fs.rmdirSync(`${ROOT_DIR}/${projectParam}`, { recursive: true, force: true });
      }
      fs.mkdirSync(`${ROOT_DIR}/${projectParam}`, { recursive: true, force: true });
      await resetMatch3Project({
        orgDir,
        targetDir: projectParam,
        godotExec: godotExecFromConfig,
      });
      // if (!fs.existsSync(`${ROOT_DIR}/${projectParam}/.git`)) {
      //   await initDiff(projectParam, argv.pathPrefix);
      // }
      if (IS_REBUILD_DOCS_ON_RUN) {
        await transparentSpawn('node', ['src/build-static-docs.js', ...params], alteredEnv, ROOT_DIR, undefined, tSpawnMute).promise;
      }
      await transparentSpawn('node', ['src/one-shot-1.js', ...params], alteredEnv, ROOT_DIR).promise;

      await fs.promises.rename(`${ROOT_DIR}/${projectParam}`, `${ROOT_DIR}/${runsDir}/${projectParam}`);
      await fs.promises.cp(`${ROOT_DIR}/${argv.docsDir}/${argv.promptsDir}`, `${ROOT_DIR}/${runsDir}/${projectParam}/${argv.docsDir}/${argv.promptsDir}`, { recursive: true });
      fs.rmSync(`${ROOT_DIR}/${runsDir}/${projectParam}/.godot`, { recursive: true, force: true });
      for (const fileGlob of ['"docs/*.md"', '"docs/*.Modelfile"', '"docs/*.toml"']) {
        await (transparentSpawn('git', ['add', fileGlob], alteredEnv, `${ROOT_DIR}/${runsDir}/${projectParam}`, undefined, tSpawnMute).promise
          .catch((e) => {
            if (!IS_REBUILD_DOCS_ON_RUN) { return; }
            console.log(`Could not add to git '${fileGlob}'\n`, e);
          }));
      }
      await transparentSpawn('git', ['commit', '-m', '"Adding docs files"'], alteredEnv,`${ROOT_DIR}/${runsDir}/${projectParam}`, undefined, tSpawnMute).promise;
    }
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
