const fs = require('node:fs');
const path = require('node:path');
const ignore = require('ignore');

const ROOT_DIR = path.join(__dirname, '../..');
// Never descend into these, even if a .release pattern would match them
const ALWAYS_SKIP_DIRS = new Set(['.git']);

const toPosix = (p) => p.split(path.sep).join('/');


/**
 * Walks the project. Every `.release` file found is a gitignore-style rule set
 * scoped to the directory it lives in (just like nested .gitignore files), except
 * a MATCH means "put this in the zip". `!pattern` lines exclude again.
 * Rule sets are applied from the root down to the deepest directory; the last
 * rule set with an opinion on a path wins.
 */
function collectFileGlobsFromFile(globFile, dir = ROOT_DIR, opts = {}) {
  const { parentRules = [], ignorePaths = [], alwaysSkipPaths = [] } = opts || {};
  const rules = [...parentRules];
  const localFile = path.join(dir, globFile);
  if (fs.existsSync(localFile)) {
    rules.push({ base: toPosix(path.relative(ROOT_DIR, dir)), lines: parseRelease(fs.readFileSync(localFile, 'utf8')) });
  }

  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (![...ALWAYS_SKIP_DIRS, alwaysSkipPaths].has(entry.name)) found.push(...collectFileGlobsFromFile(full, rules));
    } else if (entry.isFile() && !full.includes(ignorePaths)) {
      if (isIncluded(full, rules)) found.push(toPosix(path.relative(ROOT_DIR, full)));
    }
  }
  return found;
}
function filesFromGlob(globs, dir = ROOT_DIR, { skipDirs = [] } = {}) {
  const skip = new Set([...ALWAYS_SKIP_DIRS, ...skipDirs]);
  const text = [].concat(globs).join('\n');          // accepts a string or an array
  const rules = [{ base: toPosix(path.relative(ROOT_DIR, dir)), lines: parseRelease(text) }];

  const found = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else if (entry.isFile() && isIncluded(full, rules)) {
        found.push(toPosix(path.relative(ROOT_DIR, full)));
      }
    }
  })(dir);
  return found;
}

// One matcher per line so `!` re-excludes even inside a directory an earlier line
// matched (plain gitignore forbids that; for an include list it's what you'd expect).
function parseRelease(text) {
  return text.split(/\r?\n/)
    .map((l) => l.replace(/(?<!\\)\s+$/, ''))
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      return { negate, ig: ignore().add(negate ? l.slice(1) : l) };
    });
}

function isIncluded(fullPath, rules) {
  const rel = toPosix(path.relative(ROOT_DIR, fullPath));
  let included = false;
  for (const { base, lines } of rules) {
    const scoped = base ? path.posix.relative(base, rel) : rel;
    if (scoped.startsWith('..')) continue;
    for (const { negate, ig } of lines) {
      if (ig.ignores(scoped)) included = !negate; // last matching line wins
    }
  }
  return included;
}


function getDepth(path, comparePath = ROOT_DIR) {
  const split = p => p.replace(/\\/g, "/").split("/").filter(Boolean);
  const a = split(path);
  const b = split(comparePath);

  // Count shared leading segments
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) {
    common++;
  }

  const up = b.length - common;   // levels to climb from comparePath
  const down = a.length - common; // levels to descend to reach path

  return up === 0 ? down : -up;
}

function sortByDepth(paths, comparePath = ROOT_DIR) {
  return paths
    .map(p => ({ p, d: getDepth(p, comparePath) }))
    .sort((x, y) => {
      const xNeg = x.d < 0;
      const yNeg = y.d < 0;

      // Non-negative group first, then negative group
      if (xNeg !== yNeg) return xNeg ? 1 : -1;

      // Within each group: closest to zero first (1, 4, 12 ... -1, -2, -100)
      const diff = Math.abs(x.d) - Math.abs(y.d);
      return diff !== 0 ? diff : x.p.localeCompare(y.p);
    })
    .map(o => o.p);
}

module.exports = { ALWAYS_SKIP_DIRS, getDepth, sortByDepth, toPosix, collectFileGlobsFromFile, filesFromGlob, parseRelease, isIncluded };
