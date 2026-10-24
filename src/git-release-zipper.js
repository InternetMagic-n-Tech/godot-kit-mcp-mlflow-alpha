require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const { transparentSpawn } = require('./utils/spawn-helper');
const { collectFileGlobsFromFile } = require('./utils/bulk-files-helpers');

const ROOT_DIR = path.join(__dirname, '..');
const RELEASE_FILE = '.release';
const ZIP_NAME = `${path.basename(path.resolve(ROOT_DIR))}.zip`;
const ZIP_PATH = path.join(ROOT_DIR, ZIP_NAME);

async function main() {
  if (!fs.existsSync(path.join(ROOT_DIR, RELEASE_FILE))) {
    throw new Error(`No ${RELEASE_FILE} found in ${path.resolve(ROOT_DIR)}`);
  }

  const files = collectFileGlobsFromFile(RELEASE_FILE, ROOT_DIR, { ignorePaths: [ZIP_PATH] }).sort();
  if (!files.length) throw new Error(`${RELEASE_FILE} rules matched no files`);
  console.log(`Packing ${files.length} file(s) into ${ZIP_NAME}`);
  files.forEach((f) => console.log(`  + ${f}`));

  fs.rmSync(ZIP_PATH, { force: true });

  // `zip -@` reads the list of files to add from stdin
  const { promise, child } = transparentSpawn('zip', ['-q', '-@', ZIP_NAME], undefined, ROOT_DIR);
  child.stdin.end(`${files.join('\n')}\n`);
  await promise;

  console.log(`\nCreated ${ZIP_PATH}`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
