const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const jsUtils = require('./js-utils');

const ROOT_DIR = path.join(__dirname, '../..');

function readFileUtf8Sha(promptFile) {
  return makeSha(fs.readFileSync(promptFile, 'utf8'));
}

function modelNameClean(modelName) {
  return jsUtils.checkRTrim(modelName.slice(modelName.lastIndexOf('/') + 1), ':latest');
}

function makeSha(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
}

function streamlineLogStrings(str) {
  return str
    .replaceAll(process.env.HOME, '~')
    .replaceAll(ROOT_DIR, '<PROJECT>')
    .replaceAll(process.env.USERNAME, '<USER>');
}

module.exports = { streamlineLogStrings, modelNameClean, makeSha, readFileUtf8Sha };
