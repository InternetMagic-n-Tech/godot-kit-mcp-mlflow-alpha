#!/usr/bin/env node
// src/one-shot-prompt-1-suite.js

require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { muteTSpawn, transparentSpawn } = require('./utils/spawn-helper');
const { mcpConfigAndGodotDirsYargsOptions, pick3GodotExperimentYargsOptions, globalYargsOptions, ollamaYargsOptions, godotCoverageYargsOptions, commonYargsOptions, docsAndPromptsYargsOptions, parseBool } = require('./utils/cli-parse-utils');
const jsUtils = require('./utils/js-utils');
const nodeUtils = require('./utils/node-utils');
const identHelpers = require('./utils/ident-helpers');
const { resetMatch3Project, getGodotExecFromConfig } = require('./utils/godot-helpers');
const { preSuiteRun, postSuiteRun } = require('./utils/suite-utils');
const { compareModels } = require('./utils/model-name-utils');

const ROOT_DIR = path.join(__dirname, '..');
// for now we don't need to rebuild project
const IS_REBUILD_DOCS_ON_RUN = false;

const MODEL_FILE_MAP = {
  'collab-coder': 'docs/model-files/system-prompts/COLLAB-CODER.md',
  'strict-coder': 'docs/model-files/system-prompts/STRICT-CODER.md',
  'collab-one-shot': 'docs/model-files/system-prompts/ONE-SHOT-CODER.md',
};
function mapModelNameToSystemPrompt(model) {
  const foundModelName = Object.keys(MODEL_FILE_MAP).find((m) => {
    if (!model.includes(`-${m}:`) && !model.endsWith(`-${m}`)) {
      return false;
    }
    return !!MODEL_FILE_MAP[m];
  });
  return foundModelName && MODEL_FILE_MAP[foundModelName];
}
async function main() {
  const argv = mcpConfigAndGodotDirsYargsOptions(pick3GodotExperimentYargsOptions(globalYargsOptions(ollamaYargsOptions(godotCoverageYargsOptions(commonYargsOptions(docsAndPromptsYargsOptions(
    yargs(hideBin(process.argv))
      .usage('$0', 'Run Kit one-shot as suite')
    )))))))
    .option('is-single-config', {
      describe: 'Prefered `ollama` over `llama-cli`',
      // alias: 'single-config',
      type: 'boolean',
      default: 'IS_SINGLE_CONFIG' in process.env ? parseBool(process.env.IS_SINGLE_CONFIG) : false,
    })
    .help()
    .alias('help', 'h')
    .parseSync();
  let runCount = 0;
  const MODELS = [...new Set([
    argv.model,
    // gemma4:e2b models
      `ollama/${process.env.COMPARE_KIT_ALT_1}`, `ollama/${process.env.COMPARE_KIT_TERSE_ALT_1}`,
    // qwen2.5 models
      `ollama/${process.env.COMPARE_KIT_ALT_2}`, `ollama/${process.env.COMPARE_KIT_TERSE_ALT_2}`,
    // qwen-2.5-coder models
      `ollama/${process.env.COMPARE_KIT_ALT_3}`, `ollama/${process.env.COMPARE_KIT_TERSE_ALT_3}`,
  ])]
    .filter(s => !!s)
    .sort(compareModels);
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
  const relPromptFile = jsUtils.checkLTrim(promptFile, `${ROOT_DIR}/${argv.docsDir}/`);
  const promptHash = identHelpers.makeSha(relPromptFile);
  const docsPromptRelPath = `${argv.docsDir}/${jsUtils.checkLTrim(dirMod, '/')}`;
  const docsPromptsPath = path.resolve(ROOT_DIR, docsPromptRelPath);

  for (const model of MODELS) {
    await fetch(`${argv.ollamaUrl}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: model })
    });
    for (const config of CONFIGS) {
      const altModelSystemPromptKey = mapModelNameToSystemPrompt(model);
      const mcpModelfileSystemPrompt = altModelSystemPromptKey && fs.existsSync(`${ROOT_DIR}/${altModelSystemPromptKey}`)
        ? `${ROOT_DIR}/${altModelSystemPromptKey}`
        : '';
      const mcpSystemPrompt = argv.mcpSystemPrompt && fs.existsSync(argv.mcpSystemPrompt)
        ? argv.mcpSystemPrompt
        : mcpModelfileSystemPrompt;
      const projectParam = `${projectDir}--M-${identHelpers.modelNameClean(identHelpers.makeSha(model))}--C-${identHelpers.makeSha(config)}--P-${promptHash}`;
      const params = [
        ...(model ? ['--model', model] : []),
        ...(argv.docsDir ? ['--docs-dir', argv.docsDir] : []),
        '--mcp-config', config,
        '--project-dir', projectParam,
        '--prompts-dir', argv.promptsDir,
        '--prompt-file', argv.promptFile,
        '--org-dir', argv.orgDir,
        ...(mcpSystemPrompt  ? ['--mcp-system-prompt', mcpSystemPrompt] : []),
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


      await preSuiteRun({ docsPromptsPath, projectParam, isRebuildDocsOnRun: IS_REBUILD_DOCS_ON_RUN, env: alteredEnv, params });

      runCount++;
      await transparentSpawn('node', ['src/one-shot-1.js', ...params], alteredEnv, ROOT_DIR).promise;

      await postSuiteRun({
        env: alteredEnv,
        globs: ['docs/*.md', 'docs/*.Modelfile', 'docs/*.toml'],
        argv,
        runsDir,
        projectParam,
        isRebuildDocsOnRun: IS_REBUILD_DOCS_ON_RUN,
      });
    }
  }

  console.log(`🏁🏁🏁 All Done ${runCount} run${runCount === 0 || runCount > 1 ? 's' : ''}`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
