#!/usr/bin/env node
// src/setup-mcp-config.js
//
// Generates the Kit MCP config variants for this project, resolving every
// machine-specific path at generation time so nothing hardcoded ends up in git.
//
// Variants (file name => servers included):
//   full               mcp-config.json                       godot + fetch + godot-docs-rag
//   non-rag            mcp-config-non-rag.json               godot + fetch
//   non-rag-non-fetch  mcp-config-non-rag-non-fetch.json     godot only
//
// Where each value comes from:
//   npx path        --npx / NPX_PATH, otherwise asked in the terminal (when stdin is a TTY),
//                   otherwise the npx next to the node running this script.
//                   You can type a path to npx, to node, or to the bin dir that holds them.
//   Godot version   --godot-version / GODOT_VERSION, otherwise read from
//                   <org-dir>/project.godot (config/features), otherwise 4.6.
//                   Drives GODOT_DOCS_COLLECTION (4.6 => godot_4_6).
//   GODOT_PATH      --godot-path / GODOT_PATH (~ and $HOME are expanded), otherwise `which godot`,
//                   otherwise ~/AppImages/Godot_v<version>-stable_linux.x86_64 (with a warning).
//   Chroma DB       <project root>/godot_docs_db (what setup-rag-based-on-godot-version.js writes)
//
// Usage:
//   node src/setup-mcp-config.js                          # asks for npx path, derives the rest
//   node src/setup-mcp-config.js --no-interactive         # no questions; use flags/env/defaults
//   node src/setup-mcp-config.js --npx ~/opt/node24/bin   # skip the question
//   node src/setup-mcp-config.js --godot-path '~/AppImages/Godot_v4.6-stable_linux.x86_64'
//   node src/setup-mcp-config.js --variants full non-rag --dry-run
//
// Env vars: NPX_PATH, GODOT_PATH, GODOT_VERSION, GODOT_ORIG_PATH, MCP_CONFIG_OUTPUT_DIR,
//           OLLAMA_URL, GODOT_DOCS_EMBED_MODEL

require('./utils/dot-env');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const jsUtils = require('./utils/js-utils');
const { fail, promptText } = require('./utils/cli-parse-utils');
const nodeUtils = require('./utils/node-utils');
const { transparentSpawn } = require('./utils/spawn-helper');
const { pick3GodotExperimentYargsOptions, ollamaYargsOptions, ragYargsOptions, commonYargsOptions, collectStream, parseBool } = require('./utils/cli-parse-utils');
const mlFlowUitls = require('./utils/mlflow');

const ROOT_DIR = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Variant table: add or rename variants here, nothing else needs to change.
// ---------------------------------------------------------------------------
const VARIANTS = {
  'full': { file: 'mcp-config.json', servers: ['godot', 'fetch', 'godot-docs-rag', 'mlflow-mcp'] },
  'non-rag': { file: 'mcp-config-non-rag.json', servers: ['godot', 'fetch', 'mlflow-mcp'] },
  'non-rag-non-fetch': { file: 'mcp-config-non-rag-non-fetch.json', servers: ['godot', 'mlflow-mcp'] },
};

// ---------------------------------------------------------------------------
// Server definitions. `c` is the resolved context built in main().
// ---------------------------------------------------------------------------

const isMcpDebug = true;
// const isMcpDebug = false;
const SERVER_BUILDERS = {
  godot: (c) => ({
    type: 'local',
    command: [c.pathPrefix ? `${c.pathPrefix}/npx` : 'npx', '-y', '@beremaran/godot-agent-loop@3.0.1'],
    // command: [c.pathPrefix ? `${c.pathPrefix}/npx` : 'npx', '-y', '@beremaran/godot-agent-loop'],
    environment: {
      GODOT_PATH: c.godotPath,
      GODOT_MCP_HEADLESS: "true",
      GODOT_MCP_ALLOW_UNRESTRICTED: "true",
      ...(isMcpDebug ? { DEBUG : "true" } : { }),
    },
  }),
  fetch: (c) => ({
    type: 'local',
    command: [c.pathPrefix ? `${c.pathPrefix}/npx` : 'npx', '-y', 'fetch-mcp'],
  }),
  'godot-docs-rag': (c) => ({
    type: 'local',
    command: [c.ragPython, c.ragServer],
    environment: {
      GODOT_DOCS_DB_PATH: c.ragDbPath,
      GODOT_DOCS_COLLECTION: c.ragCollection,
      GODOT_DOCS_EMBED_MODEL: c.ragEmbedModel,
      OLLAMA_URL: c.ollamaUrl,
    },
  }),
  'mlflow-mcp': () => ({}),
  // 'mlflow-mcp': (c) => ({
  //   "command": ['uv', "run",
  //   "--with",
  //   "mlflow[mcp]>=3.5.1",
  //   "mlflow",
  //   "mcp",
  //   "run"],
  //   "env": {
  //   MLFLOW_TRACKING_URI: mlFlowUitls.BASE,
  //   MLFLOW_ENABLE_AUTOLOG: "true",
  //   MLFLOW_EXPERIMENT_NAME: c.experiment,
  //   }
  // })
};

async function parseArgs() {
  return pick3GodotExperimentYargsOptions(ollamaYargsOptions(ragYargsOptions(commonYargsOptions(yargs(hideBin(process.argv))))
    .option('variants', {
      describe: 'Which variants to generate',
      type: 'array',
      choices: Object.keys(VARIANTS),
      default: Object.keys(VARIANTS),
    })))
    .option('interactive', {
      describe: 'Ask for the npx path (default: on when stdin is a TTY; --no-interactive to skip)',
      alias: 'i',
      type: 'boolean',
    })
    .option('dry-run', {
      describe: 'Print the configs instead of writing them',
      type: 'boolean',
      default: false,
    })
    .option('godot-path', {
      describe: 'Godot executable (default: `which godot`). ~ and $HOME are expanded',
      type: 'string',
      default: process.env.GODOT_PATH,
    })
    .option('allow-unrestricted', { type: 'boolean', default: true, describe: 'GODOT_MCP_ALLOW_UNRESTRICTED' })
    .option('path-prefix', {
      describe: 'Alternate Path to a bin dir containing alternative bins (skips the question)',
      type: 'string',
      default: process.env.PATH_PREFIX,
    })
    .help()
    .alias('help', 'h')
    .parseSync();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ~, ~/x, $HOME/x and ${HOME}/x => absolute home-based path.
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir());
}

// Pure-JS `which`: first executable regular file named `cmd` on PATH, or null.
function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not here, keep looking */ }
  }
  return null;
}

// Path-like => absolute (relative paths resolve from the project root).
// Bare command name => looked up on PATH, or left as-is if not found.
function resolveExecutable(p) {
  if (!p) return p;
  const expanded = expandHome(p.trim());
  if (expanded.includes('/')) return path.resolve(ROOT_DIR, expanded);
  return which(expanded) || expanded;
}

// Accepts a path to npx, to node, or to the directory holding them; returns the npx path.
function resolveNpx(input) {
  const p = resolveExecutable(input);
  try {
    if (fs.statSync(p).isDirectory()) return path.join(p, 'npx');
  } catch (e) { console.error(e); /* not an existing dir */ }
  if (path.basename(p).startsWith('node')) return path.join(path.dirname(p), 'npx');
  return p;
}


// Reads "4.6" out of: config/features=PackedStringArray("4.6", "Forward Plus")
function readProjectVersion(projectDir) {
  const file = path.join(projectDir, 'project.godot');
  if (!fs.existsSync(file)) return { file, version: null };
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('config/features='));
  const match = line && line.match(/"(\d+\.\d+(?:\.\d+)?)"/);
  return { file, version: match ? match[1] : null };
}

const defaultCollection = (version) => `godot_${version.replace(/\./g, '_')}`;

function warnIfMissing(label, p) {
  // Only check real paths; bare command names are resolved by the OS at launch.
  if (p && path.isAbsolute(p) && !fs.existsSync(p)) {
    console.warn(`  ! ${label} not found: ${p}`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
async function main() {
  const argv = await parseArgs();
  const interactive = Boolean(process.stdin.isTTY);
  let warned = false;

  // --- Godot version (=> RAG collection) ------------------------------------
  const orgDir = path.resolve(ROOT_DIR, argv.orgDir);
  let godotVersion = argv.godotVersion;
  let versionSource = 'flag/env';
  if (!godotVersion) {
    const detected = readProjectVersion(orgDir);
    if (detected.version) {
      godotVersion = detected.version;
      versionSource = detected.file;
    }
  }
  if (!jsUtils.isSemver(godotVersion)) {
    fail(`Error: Godot version must look like 4.6 or 4.6.1, got '${godotVersion}'`);
  }

  const godotSpawn = transparentSpawn('which', ['godot']);
  await (godotSpawn.promise.catch(() => null));
  const godotSpawnOut = collectStream(godotSpawn.child.stdout);
  await (godotSpawnOut.done.catch(() => null));
  let godotPath = godotSpawnOut.text() || null;
  let altGodotPath = argv.godotPath ? nodeUtils.homePrefixToEnvHome(argv.godotPath) : null;
  if (altGodotPath && fs.existsSync(altGodotPath) && await transparentSpawn(altGodotPath, ['--headless', '--version'], process.env, ROOT_DIR).promise) {
    godotPath = altGodotPath;
  } else if (godotPath && await transparentSpawn(godotPath, ['--headless', '--version'], process.env, ROOT_DIR).promise) {
    godotPath = 'godot';
  } else {
    altGodotPath = interactive
      ? (await promptText('Path to Godot', '')) || null
      : null;
    if (!altGodotPath) {
      fail('Error: Invalid godot path passed');
    }
    altGodotPath = nodeUtils.homePrefixToEnvHome(altGodotPath);
    if (!fs.existsSync(altGodotPath)) {
      fail('Error: Invalid godot path passed: does not exist');
    }
    godotPath = altGodotPath;
  }

  const nodeSpawn = transparentSpawn('node', ['-v'], process.env, ROOT_DIR);
  const nodeOut = collectStream(nodeSpawn.child.stdout);

  let altPromise = Promise.resolve();
  let altNodeSpawn = { child: { stdout: new ReadableStream(), stderr: new ReadableStream() }, promise: Promise.resolve() };
  let altCollect = { done: Promise.resolve(), text: () => '' };
  let altCollectPromise = Promise.resolve();
  let altPathPrefix = nodeUtils.homePrefixToEnvHome(argv.pathPrefix || '');
  const testAltPrefix = async (prefix, opts = {}) => {
    const { isExitOnFailure = false } = opts || {};
    const nodeSpawn = transparentSpawn('node', ['-v'], { ...process.env, PATH: `${prefix}:${process.env.PATH}`}, ROOT_DIR);
    const promise = nodeSpawn.promise;
    const collect = collectStream(nodeSpawn.child.stdout);
    const collectPromise = collect.done;
    const collectNodeVersion = jsUtils.checkLTrim(collect.text().trim(), 'v');
    const collectNodeMajor = parseInt(collectNodeVersion.split('.'), 10);

    try {
      await Promise.all([promise, collectPromise])
    } catch (error) {
      if (isExitOnFailure) {
        process.exit(1);
      }
      throw error;
    }

    return {
      spawn: nodeSpawn,
      promise,
      collect,
      collectPromise,
      nodeMajor: collectNodeMajor,
    };
  };

  if (altPathPrefix) {
    const altNodeSpawnProcess = await testAltPrefix(altPathPrefix);
    altNodeSpawn = altNodeSpawnProcess.spawn;
    altPromise = altNodeSpawnProcess.promise;
    altCollect = altNodeSpawnProcess.collect;
    altCollectPromise = altNodeSpawnProcess.collectPromise;
  }

  await Promise.all([nodeSpawn.promise, nodeOut.done, altPromise, altCollectPromise]);

  const defaultNodeVersion = jsUtils.checkLTrim(nodeOut.text().trim(), 'v');
  const nodeMajor = parseInt(defaultNodeVersion.split('.'), 10);
  const altDefaultNodeVersion = jsUtils.checkLTrim(altCollect.text().trim(), 'v');
  const altNodeMajor = parseInt(altDefaultNodeVersion.split('.'), 10);

  let npx = null;
  let pathPrefix = null;
  if (altPathPrefix && altNodeMajor >= 22) {
    npx = resolveNpx(altPathPrefix);
    pathPrefix = altPathPrefix;
  } else if (!altPathPrefix && nodeMajor >= 22) {
    npx = 'npx';
  } else {
    altPathPrefix = interactive
      ? (await promptText('Path Prefix for alternative-bins (Node Version greater than 22)', '')) || null
      : null;
    if (!altPathPrefix) {
      fail('Error: Invalid Node & NPX version passed');
    }
    altPathPrefix = nodeUtils.homePrefixToEnvHome(altPathPrefix);
    npx = resolveNpx(altPathPrefix);
    pathPrefix = altPathPrefix;
  }


  // --- Build ------------------------------------------------------------------
  const variantKeys = argv.variants;
  if (!variantKeys.length) fail('Error: no variants selected');

  const venvDir = path.join(ROOT_DIR, 'godot-rag-venv');
  const ctx = {
    npx,
    pathPrefix: pathPrefix ? pathPrefix : undefined,
    godotPath,
    allowUnrestricted: "true",
    ragPython: path.join(venvDir, 'bin', 'python3'),
    ragServer: path.join(ROOT_DIR, 'godot_docs_mcp_server.py'),
    ragDbPath: path.join(ROOT_DIR, 'godot_docs_db'),
    ragCollection: argv.ragCollection || defaultCollection(godotVersion),
    ragEmbedModel: argv.ragEmbedModel,
    ollamaUrl: argv.ollamaUrl,
  };

  console.log(`Godot ${godotVersion} (from ${versionSource}) | collection ${ctx.ragCollection}`);
  console.log(`npx        ${ctx.npx}`);

  // Warn once per distinct dependency, based on what is actually generated.
  const needed = new Set(variantKeys.flatMap((k) => VARIANTS[k].servers));
  if (needed.has('godot')) {
    warned = warnIfMissing('Godot executable', ctx.godotPath) || warned;
    warned = warnIfMissing('npx', ctx.npx) || warned;
  }
  if (needed.has('godot-docs-rag')) {
    warned = warnIfMissing('RAG venv python', ctx.ragPython) || warned;
    warned = warnIfMissing('RAG server script', ctx.ragServer) || warned;
  }

  for (const key of variantKeys) {
    const { file, servers } = VARIANTS[key];
    const config = {
      mcpServers: Object.fromEntries(servers
        .map((name) => [name, SERVER_BUILDERS[name](ctx)])
        .filter(([_, frag]) => frag && Object.keys(frag).length > 0)
      ),
    };
    const json = `${JSON.stringify(config, null, 2)}\n`;
    // console.log('--servers:', servers,'\n - config:', config); process.exit(1);

    if (argv.dryRun) {
      console.log(`\n--- ${file} (dry run) ---\n${json}`);
    } else {
      fs.writeFileSync(path.join(ROOT_DIR, file), json);
      console.log(`Wrote ${file}  [${servers.join(', ')}]`);
    }
  }

  if (warned) {
    console.warn('\nSome values fell back to defaults or reference paths that do not exist yet.');
    console.warn('Configs were still written; fix them (e.g. --godot-path / --npx) before running Kit.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
