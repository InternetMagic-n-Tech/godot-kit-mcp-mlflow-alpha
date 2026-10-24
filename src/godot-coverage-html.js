#!/usr/bin/env node
/**
 * Generates a browsable HTML coverage report from a Godot coverage.json
 * (as produced by addons/coverage/coverage.gd -> save_coverage_file()).
 *
 * Usage:
 *   node godot-coverage-html.js <coverage.json> <project-dir> [output-dir]
 *
 * Example:
 *   node godot-coverage-html.js \
 *     Starter-Kit-Match-3-org/coverage.json \
 *     Starter-Kit-Match-3-org \
 *     coverage-html
 *
 * coverage.json format (per coverage.gd):
 *   { "res://scripts/main.gd": { "12": 3, "13": 0, ... }, ... }
 * Keys are line numbers (0-based, as strings); values are hit counts.
 * Lines that were instrumented but never hit are present with count 0.
 * Lines absent from the dict were not instrumented (blank/comment/etc).
 */

require('./utils/dot-env');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { godotCoverageYargsOptions, mcpConfigAndGodotDirsYargsOptions } = require('./utils/cli-parse-utils');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.join(SCRIPT_DIR, '..');

const argv = godotCoverageYargsOptions(
  mcpConfigAndGodotDirsYargsOptions(
    yargs(hideBin(process.argv))
      .usage('Usage: $0 [options]'),
      'Path to the Godot project the coverage.json was generated from'
    )
  )
  .help()
  .alias('help', 'h')
  .argv;

const projectDir = path.resolve(`${ROOT_DIR}/${argv.projectDir}`);
const coverageOutputDir = path.resolve(`${projectDir}/${argv.coverageOutputDir}`);
const coverageJsonPath = path.resolve(`${projectDir}/${argv.coverageFile}`);

if (!fs.existsSync(coverageJsonPath)) {
  console.error(`Coverage file not found: ${coverageJsonPath}`);
  process.exit(1);
}

const coverage = JSON.parse(fs.readFileSync(coverageJsonPath, 'utf8'));

fs.mkdirSync(coverageOutputDir, { recursive: true });

function resToDisk(resPath) {
  // "res://scripts/main.gd" -> "<projectDir>/scripts/main.gd"
  return path.join(projectDir, resPath.replace(/^res:\/\//, ''));
}

function safeFileName(resPath) {
  return resPath.replace(/^res:\/\//, '').replace(/[\/\\]/g, '__') + '.html';
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pctColor(pct) {
  if (pct >= 80) return '#2e7d32';
  if (pct >= 50) return '#f9a825';
  return '#c62828';
}

const fileSummaries = [];

for (const resPath of Object.keys(coverage).sort()) {
  const diskPath = resToDisk(resPath);
  const lineHits = coverage[resPath]; // { "0": count, "1": count, ... }

  let sourceLines;
  try {
    sourceLines = fs.readFileSync(diskPath, 'utf8').split('\n');
  } catch (err) {
    console.warn(`Skipping ${resPath}: could not read source at ${diskPath}`);
    continue;
  }

  const instrumentedCount = Object.keys(lineHits).length;
  const coveredCount = Object.values(lineHits).filter((c) => c > 0).length;
  const pct = instrumentedCount > 0 ? (coveredCount / instrumentedCount) * 100 : 100;

  fileSummaries.push({
    resPath,
    fileName: safeFileName(resPath),
    instrumentedCount,
    coveredCount,
    pct,
  });

  const rows = sourceLines
    .map((line, i) => {
      const hit = lineHits[String(i)];
      const isInstrumented = hit !== undefined;
      const cls = isInstrumented ? (hit > 0 ? 'hit' : 'miss') : 'plain';
      const hitLabel = isInstrumented ? `${hit}x` : '';
      return `<tr class="${cls}"><td class="ln">${i}</td><td class="hits">${hitLabel}</td><td class="src"><pre>${escapeHtml(line)}</pre></td></tr>`;
    })
    .join('\n');

  const fileHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(resPath)} - Coverage</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 0; background: #1e1e1e; color: #ddd; }
  header { padding: 12px 20px; background: #262626; border-bottom: 1px solid #3a3a3a; position: sticky; top: 0; }
  header a { color: #8ab4f8; text-decoration: none; }
  header .pct { font-weight: bold; margin-left: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td { vertical-align: top; padding: 0 8px; }
  td.ln { color: #6a6a6a; text-align: right; user-select: none; width: 40px; }
  td.hits { color: #6a6a6a; text-align: right; width: 50px; user-select: none; }
  td.src pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: "SF Mono", Consolas, monospace; }
  tr.hit { background: rgba(46, 125, 50, 0.25); }
  tr.miss { background: rgba(198, 40, 40, 0.3); }
  tr.plain { background: transparent; }
  tr:hover { outline: 1px solid #444; }
</style>
</head>
<body>
<header>
  <a href="index.html">&larr; back to summary</a>
  <strong>${escapeHtml(resPath)}</strong>
  <span class="pct" style="color: ${pctColor(pct)}">${pct.toFixed(1)}% (${coveredCount}/${instrumentedCount} lines)</span>
</header>
<table>
${rows}
</table>
</body>
</html>`;

  fs.writeFileSync(path.join(coverageOutputDir, safeFileName(resPath)), fileHtml);
}

const totalInstrumented = fileSummaries.reduce((a, f) => a + f.instrumentedCount, 0);
const totalCovered = fileSummaries.reduce((a, f) => a + f.coveredCount, 0);
const totalPct = totalInstrumented > 0 ? (totalCovered / totalInstrumented) * 100 : 100;

const indexRows = fileSummaries
  .map(
    (f) => `<tr>
      <td><a href="${f.fileName}">${escapeHtml(f.resPath)}</a></td>
      <td style="color: ${pctColor(f.pct)}">${f.pct.toFixed(1)}%</td>
      <td>${f.coveredCount}/${f.instrumentedCount}</td>
    </tr>`
  )
  .join('\n');

const indexHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Coverage Summary</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 20px; background: #1e1e1e; color: #ddd; }
  h1 { font-size: 18px; }
  h1 .pct { color: ${pctColor(totalPct)}; }
  table { border-collapse: collapse; width: 100%; max-width: 800px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #333; }
  a { color: #8ab4f8; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>Coverage Summary: <span class="pct">${totalPct.toFixed(1)}%</span> (${totalCovered}/${totalInstrumented} lines)</h1>
<table>
  <tr><th>File</th><th>Coverage</th><th>Lines</th></tr>
${indexRows}
</table>
</body>
</html>`;

fs.writeFileSync(path.join(coverageOutputDir, 'index.html'), indexHtml);

console.log(`Coverage report written to: ${path.join(coverageOutputDir, 'index.html')}`);
console.log(`Total: ${totalPct.toFixed(1)}% (${totalCovered}/${totalInstrumented} lines)`);
