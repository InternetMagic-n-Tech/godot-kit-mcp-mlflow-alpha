#!/usr/bin/env node
// src/one-shot-1.js
//
// Runs one Kit one-shot prompt against the Godot MCP and records it as a
// single MLflow run (params, metrics, artifacts).
//
// Usage:
//   node src/one-shot-1.js
//   node src/one-shot-1.js --prompt-file docs/prompts/OTHER.md --temperature 0.2 --max-steps 150

require('./utils/dot-env');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { transparentSpawn } = require('./utils/spawn-helper');
const { mcpConfigAndGodotDirsYargsOptions, pick3GodotExperimentYargsOptions, ollamaYargsOptions, godotCoverageYargsOptions, commonYargsOptions, docsAndPromptsYargsOptions, collectStream, parseBool } = require('./utils/cli-parse-utils');
const { logTrace, startRun } = require('./utils/mlflow');
const jsUtils = require('./utils/js-utils');
const identHelpers = require('./utils/ident-helpers');
const { resetMatch3Project, godotHeadlessProjectTouch, getGodotExecFromConfig } = require('./utils/godot-helpers');
const { runGodotChecks } = require('./utils/coverage-helpers');
const { cleanKitOutputArtifact } = require('./utils/kit-helpers');
const { initDiff, recordDiff } = require('./utils/git-diff-helpers');

const ROOT_DIR = path.join(__dirname, '..');
const IS_VERBOSE_CAPTURE = true;
// const IS_VERBOSE_CAPTURE = false;
const IS_VERBOSE_TOOL_CAPTURE = true;
// const PROCESS_TIMEOUT = 10 * 60 * 60 * 1000;//10 MINS?

function parseArgs() {
  return mcpConfigAndGodotDirsYargsOptions(pick3GodotExperimentYargsOptions(ollamaYargsOptions( godotCoverageYargsOptions(commonYargsOptions(docsAndPromptsYargsOptions(
    yargs(hideBin(process.argv))
      .usage('$0', 'Run one Kit one-shot and record it in MLflow')
  ))))))
    .option('max-steps', {
      describe: `Kit's 'max-steps' param`,
      type: 'number',
      default: 300
    })
    .help()
    .alias('help', 'h')
    .parseSync();
}

const clean = (n) => String(n || 'unknown').replace(/[^\w.\- /]/g, '_');

async function logTraceForRun({ run, times, prompt, cleanModelName, result }) {
  return logTrace({
    experimentId: run.experimentId,
    name: cleanModelName,
    startTimeMs: times.t0,
    endTimeMs: times.te || Date.now(),
    inputs: { prompt: identHelpers.streamlineLogStrings(prompt) },
    outputs: { response: identHelpers.streamlineLogStrings(typeof result === 'object' ? (result?.response || '') : (result || '')) },
  })
  .catch((e) => {
    console.error('Log-Trace() failed', e);
    return Promise.resolve();
  });
}
function classifyError(text) {
  if (/is required|invalid (argument|input|json)|unexpected (field|property)/i.test(text)) return 'schema';
  if (/could not find old_text|old_text|matches multiple/i.test(text)) return 'edit_match';
  if (/unknown tool|no such tool/i.test(text)) return 'unknown_tool';
  if (/exit code/i.test(text)) return 'shell_exit';
  return 'other';
}

function summarize(result) {
  const out = {};
  const usage = result?.usage || {};
  out.input_tokens = usage.input_tokens;
  out.output_tokens = usage.output_tokens;
  out.total_tokens = usage.total_tokens;

  const names = new Map();
  const keys = new Map();
  const seen = new Map();
  const perTool = {};
  const perToolError = {};
  const classes = {};
  let calls = 0;
  let errors = 0;
  let streak = 0;
  let maxStreak = 0;
  let repeats = 0;

  for (const msg of result?.messages || []) {
    for (const part of msg.parts || []) {
      const d = part.data || {};
      if (part.type === 'tool_call') {
        calls++;
        const name = clean(d.name);
        const key = name + d.input;
        names.set(d.id, name); keys.set(d.id, key);
        perTool[name] = (perTool[name] || 0) + 1;
        if (seen.get(key) === 'error') repeats++;   // identical retry after a failure
        seen.set(key, 'pending');
      } else if (part.type === 'tool_result') {
        const key = keys.get(d.tool_call_id);
        if (!d.is_error) { streak = 0; seen.set(key, 'ok'); continue; }
        errors++; streak++; maxStreak = Math.max(maxStreak, streak);
        seen.set(key, 'error');
        const name = names.get(d.tool_call_id) || 'unknown';
        perToolError[name] = (perToolError[name] || 0) + 1;
        const kind = classifyError(String(d.content || ''));
        classes[kind] = (classes[kind] || 0) + 1;
      }
    }
  }
  Object.assign(out, {
    tool_calls: calls,
    truncated: result?.stop_reason === 'length' ? 1 : 0,
    tool_errors: errors,
    ...(IS_VERBOSE_CAPTURE ? {
      tool_error_rate: calls ? errors / calls : 0,
      tool_repeat_after_error: repeats,
      tool_max_error_streak: maxStreak,
    } : {}),
  });
  if (IS_VERBOSE_TOOL_CAPTURE) {
    for (const [n, c] of Object.entries(perTool)) out[`tool.${n}`] = c;
  }
  if (IS_VERBOSE_CAPTURE) {
    for (const [n, c] of Object.entries(perToolError)) out[`tool_error.${n}`] = c;
    for (const [k, c] of Object.entries(classes)) out[`tool_error_class.${k}`] = c;
  }
  return out;
}

async function main() {
  const argv = parseArgs();
  if (argv.mcpSystemPrompt && !fs.existsSync(argv.mcpSystemPrompt)) {
    throw new Error(`MCP System Prompt Path (for kit) was passed but does not exist.  Is the path '${argv.mcpSystemPrompt}' correct?`);
  }
  const mcpConfig = argv.mcpConfig;
  const godotExecFromConfig = fs.existsSync(mcpConfig)
    ? getGodotExecFromConfig(mcpConfig)
    : null;
  const projectDir = argv.projectDir;
  if (!fs.existsSync(projectDir)) {
    await resetMatch3Project({
      orgDir: argv.orgDir,
      targetDir: projectDir,
      godotExec: godotExecFromConfig
    });
  } else {
    await godotHeadlessProjectTouch({
      orgDir: argv.orgDir,
      targetDir: projectDir,
      godotExec: godotExecFromConfig,
    });
  }
  const promptsPath = path.join(ROOT_DIR, argv.docsDir, argv.promptsDir);
  const dirMod = jsUtils.checkLTrim(path.resolve(promptsPath), ROOT_DIR);
  const promptFile = path.resolve(ROOT_DIR, jsUtils.checkLTrim(dirMod, '/'), argv.promptFile);
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt file not found: ${promptFile}`);
  }
  await initDiff(projectDir, argv.pathPrefix);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const relPromptFile = jsUtils.checkLTrim(promptFile, `${ROOT_DIR}/${argv.docsDir}/`);
  const promptHash = identHelpers.makeSha(relPromptFile);

  // One source of truth: these feed both the Kit CLI and the MLflow params.
  const cfg = {
    config: mcpConfig,
    ...(argv.session ? { session: argv.session, } : {}),
    model: argv.model,
    provider_url: argv.providerUrl,
    max_steps: Math.min(Math.max(argv.maxSteps, 1), 2000),
    // temperature: argv.temperature,
    // auto_compact: true,
    json: true,
    stream: false,
  };
  const parsedConfigFile = JSON.parse(fs.readFileSync(path.resolve(cfg.config), 'utf8'));
  const mcpSystemPrompt = argv.mcpSystemPrompt ? argv.mcpSystemPrompt : '';
  const kitArgs = [
    // '--config', cfg.config,
    '--config', path.resolve(cfg.config),
    ...(cfg.session ? ['--session', cfg.session] : ['--no-session']),
    ...(cfg.json ? ['--json'] : []),
    ...(typeof cfg.stream === 'boolean' ? [`--stream=${cfg.stream.toString()}`] : []),
    ...(cfg.auto_compact ? ['--auto-compact'] : []),
    '--model', cfg.model,
    '--provider-url', cfg.provider_url,
    '--max-steps', String(cfg.max_steps),
    ...(mcpSystemPrompt  ? ['--system-prompt', mcpSystemPrompt] : []), // kit doesn't use model's system-prompt
    // '--temperature', String(cfg.temperature),
    prompt, // positional prompt last => non-interactive one-shot
  ];

  const cleanModelName = identHelpers.modelNameClean(cfg.model);
  const modelHash = identHelpers.makeSha(cfg.model);
  const isGodotRag = 'godot-docs-rag' in parsedConfigFile.mcpServers;
  const isFetchTool = 'fetch' in parsedConfigFile.mcpServers;
  const configSlug = `${isGodotRag && isGodotRag ? 'fetch+godot-rag' : ''}${!isGodotRag ? 'no-godot-ragdb':''}${!isGodotRag && !isFetchTool ? '+' : ''}${!isFetchTool ? 'no-fetch':''}`;
  const run = await startRun({
    experiment: argv.experiment,
    // runName: `${path.basename(promptFile, path.extname(promptFile))}-M:${modelHash}-P:${promptHash}`,
    runName: `${cleanModelName} ${!isGodotRag ? 'No-' : 'With-'}Godot-RAGDB-${!isFetchTool ? 'No-' : 'With-'}Fetch ${path.basename(promptFile, path.extname(promptFile))}`,
    params: {
      ...cfg,
      ...(IS_VERBOSE_CAPTURE ? {
        prompt_file: relPromptFile,
        prompt_basename: path.basename(promptFile, path.extname(promptFile)),
        prompt_sha256: promptHash,
        prompt_contents_sha256: identHelpers.readFileUtf8Sha(promptFile),
        model_sha256: modelHash,
        model_raw: cfg.model,
        ...(mcpSystemPrompt ? {
          system_prompt: path.basename(mcpSystemPrompt, path.extname(mcpSystemPrompt)),
          system_prompt_contents_sha256: identHelpers.readFileUtf8Sha(mcpSystemPrompt),
          system_prompt_sha256: identHelpers.makeSha(jsUtils.checkLTrim(mcpSystemPrompt, `${ROOT_DIR}/${argv.docsDir}/`)),
        } : {}),
      } : {}),
      model: cleanModelName,
      config_slug: configSlug,
    },
    tags: { source: 'godot-kit-mcp-loop' },
  });
  console.log(`MLflow run ${run.id} started`);

  let status = 'FAILED';
  let finished = false;
  let child = null;

  let result;
  let resultUploadPromise = Promise.resolve();
  const times = { t0: Date.now() };

  // Don't leave Kit running or the MLflow run stuck on RUNNING if we're interrupted.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      if (child) child.kill('SIGTERM');
      if (!finished) {
        logTraceForRun({ run, times, prompt, cleanModelName, result });
        run.end('KILLED').catch(() => { });
      }
      process.exit(130);
    });
  }

  try {
    await run.uploadArtifact(argv.promptFile, prompt);
    const kitEnv = {
      ...process.env,
      // can remove - model monitoring was suppose to work with this but creates experiments incorrectly
      ...(argv.experiment ? { MLFLOW_EXPERIMENT_NAME: argv.experiment } : {})
    };
    const t0 = Date.now();
    times.t0 = t0;
    const spawned = transparentSpawn('kit', kitArgs, kitEnv, `${ROOT_DIR}/${projectDir}`);
    let timeoutId = null;
    if (typeof PROCESS_TIMEOUT !== 'undefined') {
      timeoutId = setTimeout(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        spawned.kill();
        process.exit(124);
      }, PROCESS_TIMEOUT);
    }
    const out = collectStream(spawned.child.stdout);
    const err = collectStream(spawned.child.stderr);
    const onKitFinish = async () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      await Promise.all([out.done, err.done]);
      const stdout = out.text();
      const stderr = err.text();
      let promiseUploadOutput = Promise.resolve();
      let promiseUploadError = Promise.resolve();
      try {
        promiseUploadOutput = run.uploadArtifact('kit-output.json', cleanKitOutputArtifact(stdout));
      } catch (error) {
        console.log('Failed to initalize Upload Artifact: \n', error);
      }

      promiseUploadError = run.uploadArtifact('kit-stderr.log', identHelpers.streamlineLogStrings(stderr));
      return { stdout, stderr, promise: { stdout: promiseUploadOutput, stderr: promiseUploadError } };
    };
    const onProcessExit = () => {
      onKitFinish();
      spawned.kill();
    };
    process.on('SIGINT', onProcessExit);
    process.on('SIGTERM', onProcessExit);

    let exitError = null;
    try {
      await spawned.promise;
    } catch (e) {
      exitError = e; // non-zero exit; still record what we got
    }
    const te = Date.now();
    times.te = te;
    const seconds = (te - t0) / 1000;
    process.off('SIGINT', onProcessExit);
    process.off('SIGTERM', onProcessExit);

    const { stdout, promise } = await onKitFinish();
    const notesMdPath = path.join(ROOT_DIR, argv.projectDir, 'NOTES.md');
    const progressMdPath = path.join(ROOT_DIR, argv.projectDir, 'PROGRESS.md');
    let notesMdUploadPromise = Promise.resolve();
    let progressMdUploadPromise = Promise.resolve();

    try {
      result = cfg.json ? JSON.parse(stdout) : stdout;
    } catch (error) {
      console.log(`Could not convert to JSON\n`, error);
    }

    if (cfg.json && result?.response) {
      resultUploadPromise = run.uploadArtifact('RESPONSE.md', result.response);
    } else if (typeof result === 'string' && result) {
      resultUploadPromise = run.uploadArtifact('KIT-OUTPUT.txt', result);
    }
    if (fs.existsSync(notesMdPath)) {
      notesMdUploadPromise = run.uploadArtifact('NOTES.md', fs.readFileSync(notesMdPath, 'utf8'));
    }
    if (fs.existsSync(progressMdPath)) {
      progressMdUploadPromise = run.uploadArtifact('PROGRESS.md', fs.readFileSync(progressMdPath, 'utf8'));
    }
    await Promise.all([
      promise.stdout,
      promise.stderr,
      resultUploadPromise,
      notesMdUploadPromise,
      progressMdUploadPromise,
      run.logMetrics({
        response_length: (result?.response || '').length,
        duration_s: seconds,
        exit_ok: exitError ? 0 : 1,
        parsed_ok: result ? 1 : 0,
        ...summarize(result),
      })
    ]);

    await Promise.allSettled([
      runGodotChecks({
          run,
          projectDir: argv.projectDir,
          mcpConfig: argv.mcpConfig,
          coverageFile: argv.coverageFile,
          coverageOutputDir: argv.coverageOutputDir,
          isVerboseCapture: IS_VERBOSE_CAPTURE,
      })
        .catch((e) => console.error('Godot checks failed:', e.message || e)),
      recordDiff(run, path.resolve(ROOT_DIR, projectDir))
        .catch((e) => console.error('Diff capture failed:', e.message || e))]
    );
      // transparentSpawn treats a signal-kill (code null) as success,
    // so also require that Kit actually produced parseable JSON.
    status = !exitError && result ? 'FINISHED' : 'FAILED';
  } finally {
    finished = true;

    await logTraceForRun({ run, times, prompt, cleanModelName, result });

    // lock the experiment
    await run.end(status).catch(console.error.bind(console, 'Run.end() failed'));

    console.log(`MLflow run ${run.id} ${status}`);
    if (parseBool(process.env.IS_OLLAMA_PROXY)) {
      process.exit(status === 'FAILED' ? 1 : 0);
    }
  }
}
function startMain() {
  console.log('startMain');
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
if (parseBool(process.env.IS_OLLAMA_PROXY)) {
  // debugging kit to ensure no params are changing our results will not work if you have a custom
  // env variable `OLLAMA_URL` (using any non-defaults with 'ollama-url' yarg param)
  const ollmam_url_obj = new URL(process.env.OLLAMA_URL || 'http://localhost:11434');
  const TARGET = {
    host: ollmam_url_obj.host === 'localhost' ? '127.0.0.1' : ollmam_url_obj.host,
    port: ollmam_url_obj.port
  };
  http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        const { messages, tools, ...rest } = JSON.parse(body.toString());
        console.log('[OLLAMA PROXY]', req.method, req.url,
          JSON.stringify({ ...rest, messages: messages?.length, tools: tools?.length }, null, 1));
        console.log((messages ?? []).map((m, i) =>
          `${i} ${m.role}` + (typeof m.content === 'string' ? ' ' + JSON.stringify(m.content.slice(0, 60)) : ' [non-string]')
        ).join('\n'));
      } catch { console.log('[OLLAMA PROXY]', req.method, req.url, '(non-JSON body)'); }
      const up = http.request({ ...TARGET, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => { res.statusCode = 502; res.end(String(e)); });
      up.end(body);
    });
  })
  .on('error', (err) => {
    console.error('Server failed to start. Error code:', err.code);
    console.error(err);
  })
  .listen(11435, startMain);
} else {
  startMain();
}
