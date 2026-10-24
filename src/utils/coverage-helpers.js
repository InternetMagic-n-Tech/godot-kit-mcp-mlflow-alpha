
const fs = require('node:fs');
const path = require('node:path');
const { transparentSpawn } = require('./spawn-helper');
const { collectStream } = require('./cli-parse-utils');

const ROOT_DIR = path.join(__dirname, '../..');
const ANSI = /\x1b\[[0-9;]*m/g;

// GUT "Totals" block. "Failing Tests" is only printed when something failed.
function parseGutTotals(text) {
  const clean = text.replace(ANSI, '');
  const num = (re) => { const m = clean.match(re); return m ? Number(m[1]) : undefined; };
  const total = num(/^\s*Tests\s+(\d+)/m);
  return {
    tests_total: total,
    tests_passed: num(/^\s*Passing Tests\s+(\d+)/m),
    tests_failed: num(/^\s*Failing Tests\s+(\d+)/m) ?? (total === undefined ? undefined : 0),
    tests_pending: num(/^\s*Risky\/Pending\s+(\d+)/m),
  };
}

// coverage.json: { "res://x.gd": { "12": 3, "13": 0 } }; same math as godot-coverage-html.js
function summarizeCoverage(coverageJsonPath) {
  const cov = JSON.parse(fs.readFileSync(coverageJsonPath, 'utf8'));
  let total = 0, covered = 0, files = 0, minFilePct = 100;
  for (const lines of Object.values(cov)) {
    const counts = Object.values(lines);
    if (!counts.length) continue;
    const hit = counts.filter((n) => n > 0).length;
    total += counts.length;
    covered += hit;
    files += 1;
    minFilePct = Math.min(minFilePct, (hit / counts.length) * 100);
  }
  return {
    coverage_pct: total ? (covered / total) * 100 : 100,
    coverage_lines_covered: covered,
    coverage_lines_total: total,
    coverage_files: files,
    coverage_min_file_pct: minFilePct,
  };
}

async function uploadDir(run, dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.(html|json)$/.test(entry.name)) {
      await run.uploadArtifact(`${prefix}/${entry.name}`, fs.readFileSync(path.join(dir, entry.name)));
    }
  }
}

// Run one of your own node scripts, teeing to the terminal and capturing output.
async function runNodeScript(script, args) {
  const spawned = transparentSpawn('node', [script, ...args], process.env, ROOT_DIR);
  const out = collectStream(spawned.child.stdout);   // attach before awaiting
  const err = collectStream(spawned.child.stderr);
  let exitError = null;
  try { await spawned.promise; } catch (e) { exitError = e; }
  await Promise.all([out.done, err.done]);
  return { ok: !exitError, stdout: out.text(), stderr: err.text() };
}

async function runGodotChecks({ run, projectDir, mcpConfig, coverageFile, coverageOutputDir, isVerboseCapture = false }) {
  const common = [
    '--project-dir', projectDir,
    '--mcp-config', mcpConfig,
    '--coverage-file', coverageFile,
    '--coverage-output-dir', coverageOutputDir,
  ];

  // 1. GUT tests + coverage (your test:godot script)
  const t0 = Date.now();
  const tests = await runNodeScript('src/godot-coverage-report.js', [...common, '--verbosity', '3']);
  const t1 = (Date.now() - t0) / 1000;
  await run.uploadArtifact('godot/test-output.log', tests.stdout);
  await run.uploadArtifact('godot/test-stderr.log', tests.stderr);
  await run.logMetrics({
    godot_tests_ok: tests.ok ? 1 : 0,
    godot_tests_duration_s: t1,
    ...parseGutTotals(tests.stdout),
  });
  /*
  // 2. Coverage numbers + HTML report
  const projectCoverage = path.resolve(ROOT_DIR, projectDir, coverageFile);
  const outDir = path.resolve(ROOT_DIR, coverageOutputDir);
  if (!fs.existsSync(projectCoverage)) {
    await run.logMetrics({ coverage_file_found: 0 });
    return;
  }
  // The report script writes the JSON into the project; the HTML script reads it from outDir.
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(projectCoverage, path.join(outDir, coverageFile));

  await run.logMetrics({ coverage_file_found: 1, ...summarizeCoverage(projectCoverage) });

  const html = await runNodeScript('src/godot-coverage-html.js', common);
  if (html.ok) {
    await uploadDir(run, outDir, 'coverage');   // index.html + per-file pages, links stay relative
  } else {
    await run.uploadArtifact('godot/coverage-html-stderr.log', html.stderr);
  }
  await run.uploadArtifact('coverage/coverage_report.json', fs.readFileSync(projectCoverage));
  */
  const projectAbs = path.resolve(ROOT_DIR, projectDir);
  const projectCoverage = path.join(projectAbs, coverageFile);
  const outDir = path.join(projectAbs, coverageOutputDir);

  if (!fs.existsSync(projectCoverage)) {
    await run.logMetrics({ coverage_file_found: 0 });
    return;
  }

  if (isVerboseCapture) {
    await run.logMetrics({ coverage_file_found: 1, ...summarizeCoverage(projectCoverage) });
  }

  const html = await runNodeScript('src/godot-coverage-html.js', common);
  if (html.ok) {
    await uploadDir(run, outDir, 'coverage');
  } else {
    await run.uploadArtifact('godot/coverage-html-stderr.log', html.stderr);
  }
  await run.uploadArtifact('coverage/coverage_report.json', fs.readFileSync(projectCoverage));
}

module.exports = { ANSI, runGodotChecks, runNodeScript, uploadDir, summarizeCoverage, parseGutTotals };
