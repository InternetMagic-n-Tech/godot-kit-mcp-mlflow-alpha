
require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');

const { transparentSpawn } = require('./utils/spawn-helper');


async function main() {
  // untested
  fs.mkdirSync('docker/volumes/postgres', { recursive: true, force: true });
  fs.mkdirSync('docker/volumes/storage', { recursive: true, force: true });
  await transparentSpawn('chown', ['-R', '777', 'docker/volumes/storage'], undefined, ROOT_DIR).promise;
  await transparentSpawn('sudo', ['chown', '-R', '1000:1000', 'docker/volumes/storage'], undefined, ROOT_DIR).promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
