
const fs = require('node:fs');
const { transparentSpawn } = require('./spawn-helper');
const { copyDirContents, rmrfContentsExceptGit, fail, readMcpConfig } = require('./cli-parse-utils');

async function resetMatch3Project({ orgDir, targetDir, godotExec }) {
  if (!fs.existsSync(orgDir)) {
    fail(`Error: org project dir not found at: ${orgDir}`);
  }
  if (!fs.existsSync(targetDir)) {
    fail(`Error: target project dir not found at: ${targetDir}`);
  }
  if (!godotExec) {
    fail('Error: no Godot executable path resolved; cannot regenerate .godot/ after reset.');
  }
  if (!fs.existsSync(godotExec)) {
    fail(`Error: Godot executable not found at: ${godotExec}`);
  }

  console.log(`Resetting ${targetDir} from ${orgDir} ...`);
  rmrfContentsExceptGit(targetDir);
  copyDirContents(orgDir, targetDir);
  console.log(`Copied contents of ${orgDir} into ${targetDir} (kept .git).`);
  try {
    fs.rmSync(`${targetDir}/.godot`, { recursive: true, force: true });
    fs.rmSync(`${targetDir}/coverage_report.json`, { force: true });
    fs.rmSync(`${targetDir}/coverage.json`, { force: true });
  } catch {
    console.log(`Cleaned up directory specific files failed`);
  }
  console.log(`Cleaned up directory specific files`);

  console.log('Opening project in Godot once to regenerate .godot/ (headless import + quit) ...');
  await godotHeadlessProjectTouch({ targetDir, godotExec });
  console.log('.godot/ regenerated.');
}
async function godotHeadlessProjectTouch({ targetDir, godotExec }) {
  await transparentSpawn(godotExec, [
    '--headless', '--path', targetDir, '--import', '--quit-after', '1',
  ]).promise;
}

function detectVersion(projectFile) {
  const contents = fs.readFileSync(projectFile, 'utf8');
  const line = contents.split('\n').find((l) => l.startsWith('config/features='));

  if (!line) {
    console.error(`Error: could not parse a version out of config/features in ${projectFile}`);
    console.error('Raw line found:');
    console.error('(no config/features line found)');
    process.exit(1);
  }

  const match = line.match(/"(\d+\.\d+(?:\.\d+)?)"/);
  if (!match) {
    console.error(`Error: could not parse a version out of config/features in ${projectFile}`);
    console.error('Raw line found:');
    console.error(line);
    process.exit(1);
  }

  return match[1];
}

function getGodotExecFromConfig(mcpConfigPath, serverName = 'godot') {
  const config = readMcpConfig(mcpConfigPath);
  const server = config.mcpServers && config.mcpServers[serverName];
  if (!server) {
    fail(`Error: no '${serverName}' entry under mcpServers in ${mcpConfigPath}`);
  }
  const godotPath = server.environment && server.environment.GODOT_PATH;
  if (!godotPath) {
    fail(`Error: '${serverName}' entry in ${mcpConfigPath} has no environment.GODOT_PATH set`);
  }
  return godotPath;
}

module.exports = { detectVersion, resetMatch3Project, godotHeadlessProjectTouch, getGodotExecFromConfig };
