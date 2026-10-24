#!/usr/bin/env node
// src/evaluation-prompt-1.js
//
// Starts a small local web server (first free port from 5001 up) that serves an
// evaluation form for a finished one-shot run. The form POSTs back to this same
// server; once validated, the values are logged onto the chosen MLflow run.
//
// Nothing already on the run is overwritten: any `eval_*` metric (or evaluator /
// notes tag) that exists is skipped and reported back, so a run can be scored
// in more than one sitting.
//
// The run dropdown is blind on purpose: runs are labelled only by their
// `M:<model sha>-C:<config sha>-P:<prompt sha>` ident (the suffix of the folder
// in `runs/`), never by model or config name. Runs that are fully evaluated are
// hidden (and tagged `is_evaluated` in MLflow). The "Launch game" button starts
// the selected run's project in Godot, running the game directly.
//
// Usage:
//   node src/evaluation-prompt-1.js
//   node src/evaluation-prompt-1.js --port 5100 --experiment "Pick 3 with 4 special"

require('./utils/dot-env');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { BASE, getRun, searchRuns, findExperimentId } = require('./utils/mlflow');
const { pick3GodotExperimentYargsOptions } = require('./utils/cli-parse-utils');
const { transparentSpawn } = require('./utils/spawn-helper');
const identHelpers = require('./utils/ident-helpers');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.join(SCRIPT_DIR, '..');
const HTML_PATH = path.join(ROOT_DIR, 'assets/static', 'evaluation-prompt-1.html');
const METRIC_PREFIX = 'eval_';
const NOTES_TAG = 'eval_notes_artifact';
const NOTES_ARTIFACT = 'evaluation/notes.md';
const EVALUATOR_TAG = 'eval_evaluator';
const EVALUATED_TAG = 'is_evaluated';
const SCORE_MIN = 1;
const SCORE_MAX = 5;
const MAX_BODY_BYTES = 100_000;
const MAX_NOTES_LEN = 20_000;
const MAX_NAME_LEN = 100;
const RUN_ID_RE = /^[0-9a-f]{32}$/;
const RUN_DIR_RE = /(--M-[0-9a-f]{12}--C-[0-9a-f]{12}--P-[0-9a-f]{12})$/;


const FIELDS = [
  { key: 'runtime_quality', group: 'Runtime quality', type: 'score', label: 'Performance & polish', help: 'Runs smoothly and feels finished.' },
  { key: 'distinct_special_sound', group: 'Runtime quality', type: 'bool', label: 'UX/UI has creative liberty such-as sounds or effects', help: 'Part of polish for this prompt.' },
  { key: 'code_quality', group: 'Code quality', type: 'score', label: 'Code quality', help: 'Readable, sensible, nothing unusual, and follows game-engine best practices.' },
  { key: 'bug_free', group: 'Behavior', type: 'score', label: 'Bug-free behavior', help: 'No crashes, glitches or broken states.' },
  { key: 'rule_compliance', group: 'Behavior', type: 'score', label: 'Strict compliance with every rule in the prompt', help: 'Every stated rule followed, not just most of them.' },
  // { key: 'used_subagent', group: 'Process', type: 'bool', label: 'Spawned a sub-agent to review its own work before finishing' },
  // { key: 'subagent_findings_addressed', group: 'Process', type: 'bool', dependsOn: 'used_subagent', label: 'Addressed what the sub-agent found' },
  // { key: 'subagent_findings_reported', group: 'Process', type: 'bool', dependsOn: 'used_subagent', label: 'Included the sub-agent\'s findings in the final report' },
  // `labels` = [text for yes/true, text for no/false]
  { key: 'recommend_pass', group: 'Verdict', type: 'bool', labels: ['Pass', 'Fail'], label: 'Recommended rating', help: 'Your overall recommendation for this run.' },
];

const metricKey = (field) => `${METRIC_PREFIX}${field.key}`;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.httpStatus = status;
    this.extra = extra;
  }
}

function parseArgs() {
  return pick3GodotExperimentYargsOptions(yargs(hideBin(process.argv))
      .usage('$0', 'Serve an evaluation form that records scores on an MLflow run')
    )
    .option('port', { type: 'number', default: 5001, describe: 'First port to try; counts up until one is free' })
    .option('host', { type: 'string', default: '127.0.0.1' })
    .option('runs-dir', { type: 'string', default: 'runs', describe: 'Folder (relative to the project root) holding the finished run projects' })
    .option('godot-exec', { type: 'string', describe: 'Godot executable for "Launch game"; defaults to GODOT_PATH from the run\'s MCP config' })
    .help()
    .alias('help', 'h')
    .parseSync();
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJsonBody(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

// Validate only the fields the run doesn't have yet. Returns what to log and what was skipped.
function validateSubmission({ body, summary, fields }) {
  const errors = {};
  const values = body.values && typeof body.values === 'object' ? body.values : {};
  const metrics = {};
  const skipped = [];

  // Is a bool field "yes" - from this submission, or already on the run?
  const isYes = (key) => (key in values ? values[key] === true : summary.metrics[`${METRIC_PREFIX}${key}`] === 1);

  for (const field of fields) {
    const mKey = metricKey(field);
    if (mKey in summary.metrics) {
      skipped.push(mKey);
      continue;
    }
    if (field.dependsOn && !isYes(field.dependsOn)) continue;

    const value = values[field.key];
    if (value === undefined || value === null || value === '') {
      errors[field.key] = 'Required';
    } else if (field.type === 'score') {
      if (!Number.isInteger(value) || value < SCORE_MIN || value > SCORE_MAX) {
        errors[field.key] = `Must be a whole number from ${SCORE_MIN} to ${SCORE_MAX}`;
      } else {
        metrics[mKey] = value;
      }
    } else if (typeof value !== 'boolean') {
      errors[field.key] = 'Must be yes or no';
    } else {
      metrics[mKey] = value ? 1 : 0;
    }
  }

  const evaluator = typeof body.evaluator === 'string' ? body.evaluator.trim() : '';
  if (evaluator.length > MAX_NAME_LEN) errors.evaluator = `At most ${MAX_NAME_LEN} characters`;

  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > MAX_NOTES_LEN) errors.notes = `At most ${MAX_NOTES_LEN} characters`;

  return { errors, metrics, skipped, evaluator, notes };
}

// A run is evaluated once every field that applies to it has a metric.
function isEvaluated(summary, fields = FIELDS) {
  return fields.every((field) => metricKey(field) in summary.metrics
    || (field.dependsOn && summary.metrics[`${METRIC_PREFIX}${field.dependsOn}`] !== 1));
}

// "M:<model>-C:<config>-P:<prompt>" => absolute project folder inside runs/
function indexRunDirs(runsDir) {
  const index = new Map();
  if (!fs.existsSync(runsDir)) return index;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    const match = entry.isDirectory() && RUN_DIR_RE.exec(entry.name);
    if (match) index.set(match[1], path.join(runsDir, entry.name));
  }
  return index;
}

// Rebuild a run's ident from what one-shot-1.js logged. Returns null if anything is missing.
function runKey(summary) {
  const { params } = summary;
  const modelSha = params.model_sha256 || (params.model_raw && identHelpers.makeSha(identHelpers.modelNameClean(params.model_raw)));
  const promptSha = params.prompt_sha256;
  const configFile = params.config && path.resolve(ROOT_DIR, params.config);
  const configSha = params.config_sha256 || (configFile && fs.existsSync(configFile) ? identHelpers.readFileUtf8Sha(params.config) : null);
  const fileSuffix = modelSha && promptSha && configSha ? `--M-${modelSha}--C-${configSha}--P-${promptSha}` : null
  return fileSuffix;
}

// Can't use getGodotExecFromConfig here: it calls process.exit() on any problem, which would kill the server.
function godotExecForRun(summary, override) {
  if (override) return override;
  try {
    const configFile = path.resolve(ROOT_DIR, summary.params.config);
    return JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers.godot.environment.GODOT_PATH || null;
  } catch {
    return null;
  }
}

async function loadRun(runId) {
  try {
    return await getRun(runId);
  } catch (e) {
    if (e.code === 'RESOURCE_DOES_NOT_EXIST') throw new HttpError(404, 'That run no longer exists in MLflow');
    throw e;
  }
}

async function handleRuns(res, { experiment, runsDir }) {
  const experimentId = await findExperimentId(experiment);
  if (experimentId === null) {
    return sendJson(res, 200, { experiment, runs: [], warning: `Experiment "${experiment}" doesn't exist in MLflow yet.` });
  }
  const dirs = indexRunDirs(runsDir);
  // Only runs with a project folder can be played, so only those are offered.
  const playable = [];
  let hidden = 0;
  for (const r of await searchRuns(experimentId)) {
    const key = runKey(r);
    if (key && dirs.has(key)) playable.push({ r, key });
    else hidden += 1;
  }
  const keyCounts = {};
  for (const { key } of playable) keyCounts[key] = (keyCounts[key] || 0) + 1;

  // Deliberately no run name / model / config name: the label is the sha ident only (blind evaluation).
  const runs = playable.map(({ r, key }) => ({
    id: r.id,
    label: keyCounts[key] > 1 ? `${key} (${r.id.slice(0, 6)})` : key,
    evaluated: isEvaluated(r),
    // Only what the page needs to lock already-scored fields.
    metrics: Object.fromEntries(Object.entries(r.metrics).filter(([k]) => k.startsWith(METRIC_PREFIX))),
    notesLogged: NOTES_TAG in r.tags,
    evaluatorLogged: EVALUATOR_TAG in r.tags,
  }));
  const warning = hidden ? `${hidden} run(s) hidden: no matching folder in ${path.basename(runsDir)}/` : undefined;
  return sendJson(res, 200, { experiment, runs, warning });
}

async function handleSubmit(req, res) {
  const body = await readJsonBody(req);
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!RUN_ID_RE.test(runId)) {
    throw new HttpError(400, 'Validation failed', { errors: { runId: 'Pick a run' } });
  }

  const { run, summary } = await loadRun(runId);

  const { errors, metrics, skipped, evaluator, notes } = validateSubmission({ body, fields: FIELDS, summary });
  if (Object.keys(errors).length) throw new HttpError(400, 'Validation failed', { errors });

  const tags = {};
  const logged = Object.keys(metrics);
  const alreadyHadEvaluator = EVALUATOR_TAG in summary.tags;
  const alreadyHadNotes = NOTES_TAG in summary.tags;
  if (evaluator && !alreadyHadEvaluator) tags[EVALUATOR_TAG] = evaluator;
  const uploadNotes = Boolean(notes) && !alreadyHadNotes;
  if (uploadNotes) tags[NOTES_TAG] = NOTES_ARTIFACT;
  if (evaluator && alreadyHadEvaluator) skipped.push(EVALUATOR_TAG);
  if (notes && alreadyHadNotes) skipped.push(NOTES_TAG);
  const evaluatedNow = isEvaluated({ metrics: { ...summary.metrics, ...metrics } });
  if (evaluatedNow && summary.tags[EVALUATED_TAG] !== 'true') tags[EVALUATED_TAG] = 'true';

  if (!logged.length && !Object.keys(tags).length) {
    throw new HttpError(409, 'Everything you submitted is already recorded on this run', { skipped });
  }

  // Artifact first: the tag only gets set once the upload worked.
  if (uploadNotes) await run.uploadArtifact(NOTES_ARTIFACT, notes);
  if (logged.length) await run.logMetrics(metrics);
  if (Object.keys(tags).length) await run.setTags(tags);
  if (uploadNotes) logged.push(NOTES_TAG);
  if (tags[EVALUATOR_TAG]) logged.push(EVALUATOR_TAG);
  if (tags[EVALUATED_TAG]) logged.push(EVALUATED_TAG);

  console.log(`Evaluation logged on run ${run.id}: ${logged.join(', ')}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`);
  return sendJson(res, 200, {
    logged,
    skipped,
    runUrl: `${BASE}/#/experiments/${run.experimentId}/runs/${run.id}`,
  });
}

const launchedGames = new Map(); // MLflow run id -> Godot child process

async function handleLaunch(req, res, { runsDir, godotExec }) {
  const body = await readJsonBody(req);
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!RUN_ID_RE.test(runId)) throw new HttpError(400, 'Pick a run first');
  if (launchedGames.has(runId)) throw new HttpError(409, 'The game for this run is already open');

  // The folder always comes from our own index, never from anything the page sends.
  const { summary } = await loadRun(runId);
  const projectDir = indexRunDirs(runsDir).get(runKey(summary) ?? '');
  if (!projectDir || !fs.existsSync(path.join(projectDir, 'project.godot'))) {
    throw new HttpError(404, `No Godot project for this run in ${path.basename(runsDir)}/`);
  }
  const exec = godotExecForRun(summary, godotExec);
  if (!exec || !fs.existsSync(exec)) {
    throw new HttpError(500, `Godot executable not found${exec ? `: ${exec}` : ''} (pass --godot-exec)`);
  }

  // `--path` without `-e` runs the game itself: it starts straight away, and because the editor /
  // project manager never opens, the project doesn't get added to Godot's project list.
  const { child, promise } = transparentSpawn(exec, ['--path', projectDir], process.env, projectDir);
  launchedGames.set(runId, child);
  child.once('error', (err) => {
    console.error(`Could not start Godot: ${err.message}`);
    launchedGames.delete(runId);
  });
  promise
    .catch((err) => console.error(`Godot for run ${runId} ended badly: ${err.message}`))
    .finally(() => launchedGames.delete(runId));

  return sendJson(res, 200, { launched: true });
}

function createServer(ctx) {
  const { experiment } = ctx;
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(HTML_PATH));
      }
      if (req.method === 'GET' && pathname === '/api/schema') {
        return sendJson(res, 200, {
          experiment,
          metricPrefix: METRIC_PREFIX,
          scoreMin: SCORE_MIN,
          scoreMax: SCORE_MAX,
          maxNotesLength: MAX_NOTES_LEN,
          maxNameLength: MAX_NAME_LEN,
          fields: FIELDS,
        });
      }
      if (req.method === 'GET' && pathname === '/api/runs') return await handleRuns(res, ctx);
      if (req.method === 'POST' && pathname === '/api/evaluations') return await handleSubmit(req, res);
      if (req.method === 'POST' && pathname === '/api/launch') return await handleLaunch(req, res, ctx);

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.httpStatus, { error: err.message, ...err.extra });
      }
      console.error(err);
      return sendJson(res, 502, { error: `MLflow request failed: ${err.message}` });
    }
  });
}

// Try startPort, startPort+1, ... until one is free. Resolves with the port used.
async function listenOnFreePort(server, startPort, host, attempts = 100) {
  for (let port = startPort; port < startPort + attempts && port <= 65535; port++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`No free port found in ${startPort}-${startPort + attempts - 1}`);
}

async function main() {
  const argv = parseArgs();
  const server = createServer({
    experiment: argv.experiment,
    runsDir: path.resolve(ROOT_DIR, argv.runsDir),
    godotExec: argv.godotExec,
  });
  const port = await listenOnFreePort(server, argv.port, argv.host);
  console.log(`Evaluation form: http://${argv.host}:${port}/`);
  console.log(`Experiment: ${argv.experiment}  |  MLflow: ${BASE}`);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      for (const game of launchedGames.values()) game.kill();
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
