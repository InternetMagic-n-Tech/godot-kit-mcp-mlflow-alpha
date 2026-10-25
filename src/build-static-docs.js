#!/usr/bin/env node
require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const pool = require('@ricokahler/pool');
const { applyPatch } = require('diff');
const jsUtils = require('./utils/js-utils');
const { globalYargsOptions, modelFilesYargsOptions, commonYargsOptions, docsAndPromptsYargsOptions, collectStream, parseBool } = require('./utils/cli-parse-utils');
const { transparentSpawn, muteTSpawn } = require('./utils/spawn-helper');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.join(SCRIPT_DIR, '..');
// const IS_VERBOSE = true;
const IS_VERBOSE = false;

async function emptyDir(dirPath) {
  try {
    // Read all items inside the directory
    const items = await fs.promises.readdir(dirPath);

    // Delete each item recursively
    await Promise.all(
      items.map(item =>
        fs.promises.rm(path.join(dirPath, item), { recursive: true, force: true })
      )
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      return;
    }
    console.error(`Could not empty the directory ${dirPath}\n`, err);
    throw err;
  }
}
async function getMarkdownFiles(dir) {
  // Pattern matches all .md files in dir and subdirectories
  const pattern = path.join(dir, '**/*.md');
  const files = [];

  // fs.promises.glob returns an AsyncIterator
  for await (const file of fs.promises.glob(pattern)) {
    files.push(file);
  }

  return files;
}
async function getModelFileFiles(dir) {
  // Pattern matches all .Modelfile files in dir and subdirectories
  const pattern = path.join(dir, '**/*.Modelfile');
  const files = [];

  // fs.promises.glob returns an AsyncIterator
  for await (const file of fs.promises.glob(pattern)) {
    files.push(file);
  }

  return files;
}
const argv = globalYargsOptions(modelFilesYargsOptions(docsAndPromptsYargsOptions(
  commonYargsOptions(
    yargs(hideBin(process.argv))
      .usage('Usage: $0 [options]')
    )
  )))
  .help()
  .alias('help', 'h')
  .argv;

if (!parseBool(process.env.IS_OLLAMA_PREFERRED) || !argv.isOllamaPrefered) {
  throw new Error('Static-Docs script is developed for `ollama` only');
}

async function main () {
  const docsPath = path.join(ROOT_DIR, argv.docsDir);
  const promptsPath = path.join(ROOT_DIR, argv.promptsDir);
  const modelFilesDir = path.join(ROOT_DIR, argv.modelFilesDir);
  const originPath = path.join(ROOT_DIR, argv.orgDir);
  const projectPath = path.join(ROOT_DIR, argv.projectDir);
  // const project = { name: 'My Super App', version: '2.0.0' };
  const project = {};

  async function processTemplateMarkdown(filePath, context, rootContext = null) {
    const fullFilePath = path.resolve(filePath);
    const fileObj = path.parse(fullFilePath);
    let content = await fs.promises.readFile(filePath, 'utf8');

    // 1. Inject template variables like ${project.name}
    content = content.replace(/\$\{([^}]+)\}/g, (_, expression) => {
      // Safely resolves nested properties like "project.name" from the context object
      return expression.split('.').reduce((obj, key) => obj?.[key], context) ?? '';
    });

    // 2. Target standard Markdown links: [Link Text](../README.md)
    // (Negative lookbehind (?<!!) ensures we skip ![Image](...))
    const linkRegex = /(?<!\!)\[.*?\]\((.+\.md)\)/g;
    const matches = [...content.matchAll(linkRegex)];
    const dirMod = jsUtils.checkLTrim(fileObj.dir, promptsPath);
    let isRoot = false;
    if (!rootContext) {
      rootContext = { filePath, context, history: {} };
      isRoot = true;
    }

    for (const match of matches) {
      const relativePath = match[1];
      const fullPath = path.join(fileObj.dir, relativePath);
      const isContinue = (!isRoot && fullPath === fullFilePath);

      if (isContinue) {
        if (fullPath in rootContext.history) {
          content = content.replace(match[0], rootContext.history[fullPath]);
        }
        continue;
      }

      if (fs.existsSync(fullPath)) {
        const embeddedContent = await processTemplateMarkdown(fullPath, context, rootContext);
        content = content.replace(match[0], embeddedContent.content);
        rootContext.history[fullPath] = content;
      }
    }

    // no HTML comments
    content = content.replace(/<!--[\s\S]*?-->/g, '');

    return { content, dirMod, docsPath: `${dirMod}/${fileObj.base}` };
  }

  const dirMod = jsUtils.checkLTrim(path.resolve(promptsPath), ROOT_DIR);
  await emptyDir(`${docsPath}${dirMod}`);
  const dirModModelFiles = jsUtils.checkLTrim(path.resolve(modelFilesDir), ROOT_DIR);
  await emptyDir(`${docsPath}${dirModModelFiles}`);
  const [mdFiles, modelFileFiles, modelFileMdFiles] = await Promise.all([
    getMarkdownFiles(promptsPath),
    getModelFileFiles(modelFilesDir),
    getMarkdownFiles(`${modelFilesDir}/system-prompts`),
  ]);

  const templateVariables = {
    ...project,
    PREFERRED_MODEL: process.env.PREFERRED_MODEL,
    COMPARE_MODEL: process.env.COMPARE_MODEL,
    ...Object.keys(process.env || {}).reduce((acc, key) => {
      if (key in process.env && typeof process.env[key] == 'string' && process.env[key].length > 0) {
        // if (key.startsWith('COMPARE_MODEL_ALT_') || key.startsWith('COMPARE_KIT_ALT_') || key.startsWith('COMPARE_KIT_TERSE_ALT_') || key.startsWith('COMPARE_KIT_LOW_TEMP_ALT_') || key.startsWith('COMPARE_KIT_HIGH_TEMP_ALT_')) {
        if (key.startsWith('COMPARE_MODEL_ALT_')) {
          acc[key] = process.env[key];
        }
      }
      return acc;
    }
      , {}),
    // if for some reason IS_REBUILD_DOCS_ON_RUN needs to be true again these
    // might be the ones to repopulate into the MD template replacements
    // PATH_TO_GODOT_MATCH_3_REPO: projectPath, // kit is now ran from godot-repo-directory
    // PATH_TO_GODOT_ORIG_PROJECT_PATH: originPath,
  };
  console.log('Processing ', jsUtils.checkLTrim(promptsPath, ROOT_DIR + '/'));

  const texts = await pool({
    collection: mdFiles,
    maxConcurrency: 1,
    task: async (mdFilePath, n) => {
      const fileObj = path.parse(path.resolve(mdFilePath));
      const dirMod = jsUtils.checkLTrim(fileObj.dir, ROOT_DIR);
      IS_VERBOSE && console.log(' - ', jsUtils.checkLTrim(dirMod + '/' + path.parse(mdFilePath).base, '/'));
      const result = await processTemplateMarkdown(mdFilePath, templateVariables);
      fs.mkdirSync(`${docsPath}${dirMod}`, { recursive: true });
      fs.writeFileSync(`${docsPath}${dirMod}/${fileObj.base}`, result.content);
      if (IS_VERBOSE && n >= mdFiles.length - 1) {
        console.log('');
      }
      return result;
    },
  });
  console.log('Completed:', ...texts.reduce((acc, item) => ([...acc, "\n - ", `${jsUtils.checkLTrim(docsPath, ROOT_DIR + '/')}/${jsUtils.checkLTrim(item.docsPath, '/')}`]), []));

  const modelFileMds = await pool({
    collection: modelFileMdFiles,
    maxConcurrency: 1,
    task: async (modelFileMdFile, n) => {
      const fileObj = path.parse(path.resolve(modelFileMdFile));
      const dirMod = jsUtils.checkLTrim(fileObj.dir, ROOT_DIR);
      IS_VERBOSE && console.log(' - ', jsUtils.checkLTrim(dirMod + '/' + path.parse(modelFileMdFile).base, '/'));
      const result = await processTemplateMarkdown(modelFileMdFile, templateVariables);
      fs.mkdirSync(`${docsPath}${dirMod}`, { recursive: true });
      fs.writeFileSync(`${docsPath}${dirMod}/${fileObj.base}`, result.content);
      if (IS_VERBOSE && n >= mdFiles.length - 1) {
        console.log('');
      }
      return result;
    },
  });
  console.log('Completed:', ...modelFileMds.reduce((acc, item) => ([...acc, "\n - ", `${jsUtils.checkLTrim(docsPath, ROOT_DIR + '/')}/${jsUtils.checkLTrim(item.docsPath, '/')}`]), []));



  const modelActualTemplateCache = {};
  const modelFiles = await pool({
    collection: modelFileFiles,
    maxConcurrency: 1,
    task: async (modelFile, n) => {
      const modelFileTemplateVariables = {
        ...templateVariables,
        TOOL_UPDATE: '',
      };
      const fileObj = path.parse(path.resolve(modelFile));
      const dirMod = jsUtils.checkLTrim(fileObj.dir, ROOT_DIR);
      IS_VERBOSE && console.log(' - ', jsUtils.checkLTrim(dirMod + '/' + path.parse(modelFile).base, '/'));
      fs.mkdirSync(`${docsPath}${dirMod}`, { recursive: true });
      const parseFromTemplateVales = async (isTempRun = false) => {
        const result = await processTemplateMarkdown(modelFile, modelFileTemplateVariables);
        const writtenFilePath = `${docsPath}${dirMod}/${fileObj.base}${isTempRun ? '.tmp' : ''}`;
        fs.writeFileSync(writtenFilePath, result.content, { encoding: 'utf8' });
        return writtenFilePath;
      }
      const baseRun = await parseFromTemplateVales(true);
      const baseRunContents = (fs.readFileSync(baseRun, { encoding: 'utf8' }) || '');
      const getModelNameFromModelFileFrom = (fileContents) => {
        const lines = fileContents.split(/\r?\n/);
        const modelFromPos = lines.findIndex((s) => s.trim().toUpperCase().startsWith('FROM ') || s.trim().toUpperCase().startsWith('FROM\t'));
        const modelNameLine = jsUtils.checkLTrim(jsUtils.checkLTrim(lines[modelFromPos].trim(), 'FROM\t'.trim()), 'FROM ').trim();
        const modelName = modelNameLine.includes('#') ? (modelNameLine.split('#').slice(0, -1)[0] || '').trim() : (modelNameLine||'').trim();
        return modelName || '';
      };
      const getTemplateFromModelTag = async (foundModelName) => {
        const modelfileTemplateSpawn = transparentSpawn('ollama', ['show', '--template', foundModelName], IS_VERBOSE ? undefined : muteTSpawn);
        const templateOut = collectStream(modelfileTemplateSpawn.child.stdout);
        const templateErr = collectStream(modelfileTemplateSpawn.child.stderr);

        await modelfileTemplateSpawn.promise;
        await Promise.all([templateOut.done, templateErr.done]);

        const modelfileTemplateSpawnStdout = templateOut.text();
        const modelfileTemplateSpawnStderr = templateErr.text();

        if (modelfileTemplateSpawnStderr) {
          throw new Error(`Couldn't process model ${foundModelName}.  Run with --verbose for details`);
        }
        return modelfileTemplateSpawnStdout;
      };
      const parsedModelName = await getModelNameFromModelFileFrom(baseRunContents);
      const useTempRun = () => {
        fs.renameSync(baseRun, jsUtils.checkRTrim(baseRun, '.tmp'));
      };
      const patchPath = `${ROOT_DIR}/model-files/patches/${parsedModelName}-tool-template.patch`;
      const isToolTemplatePatch = fs.existsSync(patchPath);
      if (parsedModelName && isToolTemplatePatch) {
        fs.rmSync(baseRun);

        const modelfileSpawn = transparentSpawn('ollama', ['show', '--modelfile', parsedModelName, '--verbose'], IS_VERBOSE ? undefined : muteTSpawn);
        const out = collectStream(modelfileSpawn.child.stdout);
        const err = collectStream(modelfileSpawn.child.stderr);

        await modelfileSpawn.promise;
        await Promise.all([out.done, err.done]);

        if (!out.text() || err.text().trim()) {
          throw new Error('Invalid ollama model');
        }

        if (!modelActualTemplateCache[parsedModelName]) {
          modelActualTemplateCache[parsedModelName] = await getTemplateFromModelTag(parsedModelName);
        }
        const updatedContent = applyPatch(
          modelActualTemplateCache[parsedModelName],
          fs.readFileSync(patchPath, 'utf8')
        );

        if (updatedContent === false) {
          throw new Error(`Could not apply patch to ${parsedModelName} tool template`);
        }

        modelFileTemplateVariables.TOOL_UPDATE = updatedContent;
        (fs.readFileSync(await parseFromTemplateVales(), { encoding: 'utf8' }) || '');
      } else {
        useTempRun();
      }

      if (IS_VERBOSE && n >= mdFiles.length - 1) {
        console.log('');
      }
      return modelFile;
    },
  });
  console.log('Completed:', ...modelFiles.reduce((acc, item) => ([...acc, "\n - ", `${jsUtils.checkLTrim(item, ROOT_DIR + '/')}`]), []));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
