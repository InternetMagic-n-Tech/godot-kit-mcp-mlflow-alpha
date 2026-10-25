// src/utils/mlflow.js
//
// Tiny MLflow REST client (Node 18+, global fetch, no dependencies).
// Works against a server started with --serve-artifacts, so artifact
// uploads go through the MLflow server over HTTP (no S3 creds needed).
//
//   const { startRun } = require('./utils/mlflow');
//   const run = await startRun({ experiment: 'My Exp', runName: 'x', params: {a: 1} });
//   await run.logMetrics({ score: 3 });
//   await run.uploadArtifact('notes.md', '# hi');
//   await run.end('FINISHED');

const BASE = (`${process.env.ML_FLOW_ORIGIN || 'http://localhost:5000'}`).replace(/\/$/, '');
const API = `${BASE}/api/2.0/mlflow`;
const ARTIFACTS_API = `${BASE}/api/2.0/mlflow-artifacts/artifacts`;

// Older MLflow servers cap param values at 500 chars. Put long text in artifacts.
const MAX_PARAM_LEN = 500;

async function api(method, route, { query, body } = {}) {
  const url = new URL(API + route);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(`MLflow ${method} ${route} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.code = json.error_code;
    throw err;
  }
  return json;
}

// Returns the experiment id, or null when it doesn't exist (never creates).
async function findExperimentId(name) {
  try {
    const r = await api('GET', '/experiments/get-by-name', { query: { experiment_name: name } });
    return r.experiment.experiment_id;
  } catch (e) {
    if (e.code === 'RESOURCE_DOES_NOT_EXIST') return null;
    throw e;
  }
}

async function getOrCreateExperiment(name) {
  try {
    const r = await api('GET', '/experiments/get-by-name', { query: { experiment_name: name } });
    return r.experiment.experiment_id;
  } catch (e) {
    if (e.code !== 'RESOURCE_DOES_NOT_EXIST') throw e;
  }
  const r = await api('POST', '/experiments/create', { body: { name } });
  return r.experiment_id;
}

class Run {
  constructor(experimentId, info) {
    this.experimentId = experimentId;
    this.id = info.run_id;
    // e.g. "mlflow-artifacts:/1/<run_id>/artifacts" -> "1/<run_id>/artifacts"
    this.artifactPath = info.artifact_uri.replace(/^mlflow-artifacts:\//, '');
  }

  async _batch({ params = [], metrics = [], tags = [] }) {
    await api('POST', '/runs/log-batch', {
      body: { run_id: this.id, params, metrics, tags },
    });
  }

  async logParams(obj) {
    const params = Object.entries(obj).map(([key, value]) => ({
      key,
      value: String(value).slice(0, MAX_PARAM_LEN),
    }));
    await this._batch({ params });
  }

  async setTags(obj) {
    const tags = Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
    await this._batch({ tags });
  }

  async logMetrics(obj, step = 0) {
    const timestamp = Date.now();
    const metrics = Object.entries(obj)
      .filter(([, v]) => Number.isFinite(v))
      .map(([key, value]) => ({ key, value, timestamp, step }));
    if (metrics.length) await this._batch({ metrics });
  }

  // data: string | Buffer. relPath may contain subfolders, e.g. "logs/kit.json".
  async uploadArtifact(relPath, data) {
    const res = await fetch(`${ARTIFACTS_API}/${this.artifactPath}/${relPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    });
    if (!res.ok) {
      throw new Error(`Artifact upload ${relPath} -> ${res.status}: ${await res.text()}`);
    }
  }

  // status: FINISHED | FAILED | KILLED
  async end(status = 'FINISHED') {
    await api('POST', '/runs/update', {
      body: { run_id: this.id, status, end_time: Date.now() },
    });
  }
}

// Flatten MLflow's [{key, value}] arrays into plain objects.
const keyValueMap = (list = []) => Object.fromEntries(list.map(({ key, value }) => [key, value]));

function summarizeRun(raw) {
  return {
    id: raw.info.run_id,
    name: raw.info.run_name || '',
    status: raw.info.status,
    startTime: Number(raw.info.start_time) || 0,
    params: keyValueMap(raw.data?.params),
    metrics: keyValueMap(raw.data?.metrics), // latest value per key
    tags: keyValueMap(raw.data?.tags),
  };
}

// Newest first. Plain summaries, not Run objects (use getRun to write to one).
async function searchRuns(experimentId, maxResults = 100) {
  const r = await api('POST', '/runs/search', {
    body: { experiment_ids: [String(experimentId)], max_results: maxResults, order_by: ['attributes.start_time DESC'] },
  });
  return (r.runs || []).map(summarizeRun);
}

// Re-attach to an existing run. Throws with err.code === 'RESOURCE_DOES_NOT_EXIST' if it's unknown.
async function getRun(runId) {
  const { run: raw } = await api('GET', '/runs/get', { query: { run_id: runId } });
  return { run: new Run(raw.info.experiment_id, raw.info), summary: summarizeRun(raw) };
}

async function startRun({ experiment, runName, params, tags }) {
  const experimentId = await getOrCreateExperiment(experiment);
  const { run } = await api('POST', '/runs/create', {
    body: { experiment_id: experimentId, start_time: Date.now(), run_name: runName },
  });
  // const logger = new MLflowLogger();
  // logger.experimentName = experiment;
  // logger.experimentId = experimentId;
  // logger.runId = run.info.run_id;
  const r = new Run(experimentId, run.info);
  if (params) await r.logParams(params);
  if (tags) await r.setTags(tags);
  return r;
}
const MLFLOW_URI = process.env.MLFLOW_TRACKING_URI || "http://127.0.0.1:5000";

// Helper to interact with MLflow REST API v2.0
class MLflowLogger {
  constructor(experimentName) {
    this.experimentName = experimentName;
    this.experimentId = null;
    this.runId = null;
  }

  async init() {
    // 1. Get or Create Experiment
    const expRes = await fetch(`${MLFLOW_URI}/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(this.experimentName)}`);
    if (expRes.ok) {
      const data = await expRes.json();
      this.experimentId = data.experiment.experiment_id;
    } else {
      const createRes = await fetch(`${MLFLOW_URI}/api/2.0/mlflow/experiments/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.experimentName })
      });
      const createData = await createRes.json();
      this.experimentId = createData.experiment_id;
    }

    // 2. Start a Run
    const runRes = await fetch(`${MLFLOW_URI}/api/2.0/mlflow/runs/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experiment_id: this.experimentId, start_time: Date.now() })
    });
    const runData = await runRes.json();
    this.runId = runData.run.info.run_id;
  }

  // 3. Log step-based metrics (creates trend charts in UI)
  async logMetric(key, value, step = 0) {
    await fetch(`${MLFLOW_URI}/api/2.0/mlflow/runs/log-metric`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: this.runId,
        key: key,
        value: value,
        timestamp: Date.now(),
        step: step
      })
    });
  }

  // 4. End Run
  async endRun() {
    await fetch(`${MLFLOW_URI}/api/2.0/mlflow/runs/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: this.runId, status: "FINISHED", end_time: Date.now() })
    });
  }
}

// // Example usage in JS model / agent processing:
// (async () => {
//   const logger = new MLflowLogger("Local_JS_Model_Activity");
//   // await logger.init();
//   logger.experimentName = experimentName;
//   logger.experimentId = null;
//   logger.runId = null;
//
//   // Simulate logging model steps (e.g. latency, accuracy, token loss)
//   for (let epoch = 1; epoch <= 5; epoch++) {
//     const simulatedLoss = 1 / epoch;
//     const simulatedAccuracy = 0.7 + epoch * 0.05;
//
//     await logger.logMetric("loss", simulatedLoss, epoch);
//     await logger.logMetric("accuracy", simulatedAccuracy, epoch);
//   }
//
//   await logger.endRun();
//   console.log("Activity logged successfully to MLflow experiment!");
// })();

// Add this inside mlflow.js

// Logs a GenAI trace span so MLflow populates the Overview Dashboard (Latency, Tool Calls, Errors)
async function logTrace({ experimentId, name, startTimeMs, endTimeMs, inputs, outputs, error, tags = {} }) {
  const traceData = {
    tracer_metadata: {
      trace_id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    },
    span: {
      name: name || "model_execution",
      span_id: `sp-${Date.now()}`,
      start_time_ns: String(BigInt(startTimeMs || Date.now()) * 1000000n),
      end_time_ns: String(BigInt(endTimeMs || Date.now()) * 1000000n),
      status: {
        status_code: error ? "ERROR" : "OK",
        description: error ? String(error) : ""
      },
      attributes: {
        "mlflow.traceInputs": JSON.stringify(inputs || {}),
        "mlflow.traceOutputs": JSON.stringify(outputs || {}),
        "mlflow.experimentId": String(experimentId),
        ...tags
      }
    }
  };

  await api('POST', '/traces', { body: traceData });
}

module.exports = { BASE, logTrace, MLflowLogger, startRun, getRun, searchRuns, findExperimentId, getOrCreateExperiment };
