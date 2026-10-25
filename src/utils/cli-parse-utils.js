
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

function parseBool(value) {
  if (value == null || typeof value === 'undefined') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function promptYesNo(question, defaultValue = false) {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultValue);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`${question} [${suffix}]: `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) {
        resolve(defaultValue);
        return;
      }
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}
function promptText(question, defaultValue) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultValue);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function readMcpConfig(mcpConfigPath) {
  if (!fs.existsSync(mcpConfigPath)) {
    fail(`Error: could not find MCP config file at: ${mcpConfigPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
  } catch (err) {
    fail(`Error: could not parse MCP config file at ${mcpConfigPath}: ${err.message}`);
  }
  return parsed;
}
function rmrfContentsExceptGit(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function copyDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry === '.git') continue;
    fs.cpSync(path.join(srcDir, entry), path.join(destDir, entry), { recursive: true });
  }
}

function mcpConfigAndGodotDirsYargsOptions(yargs, describe = "Path to the Godot project (e.g. Starter-Kit-Match-3)") {
  return yargs.option('project-dir', {
    describe,
    type: 'string',
    default: process.env.GODOT_PROJECT_PATH || 'Starter-Kit-Match-3',
  })
  .option('org-dir', {
    describe: 'Path to the origin source project to reset from defaults to env-variable \'GODOT_ORIG_PATH\'',
    type: 'string',
    default: process.env.GODOT_ORIG_PATH || 'Starter-Kit-Match-3-org',
  })
  .option('mcp-config', {
    describe: 'Path to the mcp-config.json file to read GODOT_PATH from',
    type: 'string',
    default: process.env.MCP_CONFIG_PATH || 'mcp-config.json',
  })
  .option('mcp-session', {
    describe: 'Path to the mcp-config.json file to read GODOT_PATH from',
    type: 'string',
    default: process.env.MCP_SESSION || '',
  })
  .option('mcp-system-prompt', {
    describe: 'Absolute Path to the md file passed into kit',
    type: 'string',
    default: process.env.KIT_SYSTEM_PROMPT || '',
  });
}

function ragYargsOptions(yargs) {
  return yargs
    .option('rag-embed-model', {
      describe: 'Which model to use to do embedings for Godot-RAG-Service',
      type: 'string',
      default: process.env.PREFERRED_CHUNKING_MODEL || 'nomic-embed-text',
    });
}

function commonYargsOptions(yargs) {
  return mcpConfigAndGodotDirsYargsOptions(yargs)
    .option('godot-headless', {
      describe: 'Run Godot in headless mode',
      type: 'boolean',
      default: true,
    });
}

function docsAndPromptsYargsOptions(yargs) {
  return yargs
  .option('docs-dir', {
    describe: "Path to the output MD files compiled (e.g. docs/)",
    type: 'string',
    default: process.env.PROMPT_OUTPUT_PATH || 'docs',
  })
  .option('prompts-dir', {
    describe: "Path to the template MD files compiled (e.g. prompts/)",
    type: 'string',
    default: process.env.PROMPTS_PATH || 'prompts',
  })
  .option('prompt-file', {
    type: 'string',
    describe: 'Markdown prompt file (relative paths resolve from the project root)',
    default: 'kit/PROMPT-1.md',
  });
}

function globalYargsOptions(yargs) {
  return yargs
    .option('is-ollama-prefered', {
      describe: 'Prefered `ollama` over `llama-cli`',
      // alias: 'ollama',
      type: 'boolean',
      default: 'IS_OLLAMA_PREFERRED' in process.env ? parseBool(process.env.IS_OLLAMA_PREFERRED) : false,
    })
    .option('verbose', {
      describe: 'Scripts will log all information',
      type: 'boolean',
      default: 'VERBOSE' in process.env ? parseBool(process.env.VERBOSE) : false,
    })
    .option('verbose-capture', {
      describe: 'ML-Flow will capture all metrics',
      type: 'boolean',
      default: 'VERBOSE_CAPTURE' in process.env ? parseBool(process.env.VERBOSE_CAPTURE) : false,
    })
    .option('verbose-tool-capture', {
      describe: 'ML-Flow will capture all tool usage metrics',
      type: 'boolean',
      default: 'VERBOSE_TOOL_CAPTURE' in process.env ? parseBool(process.env.VERBOSE_TOOL_CAPTURE) : false,
    });
}

function pick3GodotExperimentYargsOptions(yargs) {
  return yargs
    .option('experiment', {
      type: 'string',
      default: process.env.MLFLOW_EXPERIMENT || 'Pick 3 with 4 special',
    })
    .option('run-dir', {
      describe: 'Where to move the game directory after a successful single-suite-run',
      type: 'string',
      default: process.env.RUN_DIR || 'runs',
    });
}

function ollamaYargsOptions(yargs) {
  return yargs
    .option('model', {
      describe: 'Ollama Model defaults to `ollama/gemma4:e2b:latest`',
      type: 'string',
      default: process.env.PREFERRED_KIT_MODEL ? `ollama/${process.env.PREFERRED_KIT_MODEL}` : 'ollama/gemma4:e2b:latest'
    })
    .option('ollama-url', {
      type: 'string',
      default: (parseBool(process.env.IS_OLLAMA_PROXY) ? (process.env.OLLAMA_URL || 'http://localhost:11435') : (process.env.OLLAMA_URL || 'http://localhost:11434'))
    })
    .option('provider-url', {
      describe: 'HTTP-API URL defaults to `http://localhost:11434/v1`',
      type: 'string',
      default: (parseBool(process.env.IS_OLLAMA_PROXY) ? `${(process.env.OLLAMA_URL || 'http://localhost:11435')}/v1` : `${(process.env.OLLAMA_URL || 'http://localhost:11434')}/v1`)
    });
}

function modelFilesYargsOptions(yargs) {
  return yargs
  .option('model-files-dir', {
    describe: "Path to the template MD files compiled (e.g. prompts/)",
    type: 'string',
    default: process.env.MODEL_FILES_DIR || 'model-files',
  });
}

function godotCoverageYargsOptions(yargs) {
  return yargs
  .option('coverage-file', {
    describe: 'Path to the coverage.json produced by the Godot coverage addon',
    type: 'string',
    default: 'coverage_report.json',
  })
  .option('coverage-output-dir', {
    describe: 'Directory to write the HTML report into',
    type: 'string',
    default: process.env.GODOT_PROJECT_COVERAGE_PATH || 'coverage-html',
  });
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}


function collectStream(stream) {
  const chunks = [];

  // stdio could be 'inherit'/'ignore' => no stream at all
  if (!stream) return { done: Promise.resolve(), text: () => '' };

  const done = new Promise((resolve) => {
    // 'close' never fires if the stream is already closed when we attach
    if (stream.destroyed || stream.readableEnded) return resolve();
    stream.once('close', resolve);
    stream.once('error', resolve); // don't hang on a broken pipe
  });

  stream.on('data', (d) =>
    chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'))
  );

  return { done, text: () => Buffer.concat(chunks).toString('utf8') };
}


module.exports = { globalYargsOptions, pick3GodotExperimentYargsOptions, ollamaYargsOptions, modelFilesYargsOptions, ragYargsOptions, commonYargsOptions, mcpConfigAndGodotDirsYargsOptions, copyDirContents, rmrfContentsExceptGit, readMcpConfig, fail, promptYesNo, promptText, parseBool, docsAndPromptsYargsOptions, godotCoverageYargsOptions, fail, collectStream };
