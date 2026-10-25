const fs = require('node:fs');
const path = require('node:path');

const { tSpawnMute, transparentSpawn } = require('./spawn-helper');

const ROOT_DIR = path.join(__dirname, '../..');

async function preSuiteRun(opts) {
  const { docsPromptsPath, isRebuildDocsOnRun = false, env, projectParam, params } = opts || {};
  if (isRebuildDocsOnRun) {
    await transparentSpawn('node', ['src/build-static-docs.js', ...params], env, ROOT_DIR, undefined, tSpawnMute).promise;
  }
  if (fs.existsSync(`${docsPromptsPath}/AGENTS.md`) && !fs.existsSync(`${ROOT_DIR}/${projectParam}/AGENTS.md`)) {
    fs.copyFileSync(`${docsPromptsPath}/AGENTS.md`, `${ROOT_DIR}/${projectParam}/AGENTS.md`);
  }
}
async function postSuiteRun(opts) {
  const { isRebuildDocsOnRun = false, env, argv, runsDir, projectParam, globs } = opts || {};

  await fs.promises.rename(`${ROOT_DIR}/${projectParam}`, `${ROOT_DIR}/${runsDir}/${projectParam}`);
  fs.rmSync(`${ROOT_DIR}/${runsDir}/${projectParam}/.godot`, { recursive: true, force: true });

  if (isRebuildDocsOnRun) {
    await fs.promises.cp(`${ROOT_DIR}/${argv.docsDir}/${argv.promptsDir}`, `${ROOT_DIR}/${runsDir}/${projectParam}/${argv.docsDir}/${argv.promptsDir}`, { recursive: true });
    let accStr = '';
    for (const fileGlob of (globs || [])) {
      accStr = `${accStr}${accStr.length > 0 ? ', ': '' }${fileGlob.includes('.') ? fileGlob.split('.').pop(): fileGlob.split('/').pop() }`;
      await (transparentSpawn('git', ['add', fileGlob], env, `${ROOT_DIR}/${runsDir}/${projectParam}`, undefined, tSpawnMute).promise
        .catch((e) => {
          console.log(`Could not add to git '${fileGlob}'\n\n`, e);
          return Promise.resolve();
        }));
    }
    await (transparentSpawn('git', ['commit', '-m', `"Adding ${accStr} files"`], env, `${ROOT_DIR}/${runsDir}/${projectParam}`, undefined, tSpawnMute).promise
      .catch((e) => {
        console.log('Could not `git-add`\n\n', e);
        return Promise.resolve();
      }));
  }
}
module.exports = { preSuiteRun, postSuiteRun };
