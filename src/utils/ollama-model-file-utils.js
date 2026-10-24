const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = path.join(__dirname, '../..');

const OLLAMA_TO_LLAMA_CPP = {
    "temperature": "--temp",
    "top_p": "--top-p",
    "top_k": "--top-k",
    "min_p": "--min-p",
    "repeat_penalty": "--repeat-penalty",
    "presence_penalty": "--presence-penalty",
    "frequency_penalty": "--frequency-penalty",
    "num_ctx": "-c",
    "seed": "--seed"
};

// Returns standard search paths for models and Ollama directories
function getModelSearchDirectories() {
    const home = os.homedir();

    // Base paths for Ollama models (honors OLLAMA_MODELS env var)
    const ollamaBase = process.env.OLLAMA_MODELS || path.join(home, '.ollama', 'models');

    return {
        // Standard .gguf search locations
        ggufDirs: [
            process.cwd(),                                                      // Current directory
            process.env.LLAMA_CACHE,                                           // Custom env var
            path.join(home, '.cache', 'llama.cpp'),                           // Linux
            path.join(home, 'Library', 'Caches', 'llama.cpp'),                // macOS
            path.join(process.env.LOCALAPPDATA || '', 'llama.cpp', 'cache'),  // Windows
            path.join(home, 'models')                                         // Common user directory
        ].filter(Boolean),

        // Ollama specific directories
        ollama: {
            manifests: path.join(ollamaBase, 'manifests', 'registry.ollama.ai'),
            blobs: path.join(ollamaBase, 'blobs')
        }
    };
}

/**
 * Resolves an input model reference to an absolute filesystem path.
 * Handles:
 * 1. Direct path to a file (.gguf)
 * 2. Loose file matches in llama.cpp cache directories
 * 3. Ollama registry tags (e.g. "gemma4:26b", "qwen3:30b", "library/qwen3:30b")
 */
function resolveModelPath(modelNameOrPath) {
    // 1. Direct hit (absolute or relative file exists)
    if (fs.existsSync(modelNameOrPath)) {
        return path.resolve(modelNameOrPath);
    }

    const searchPaths = getModelSearchDirectories();

    // 2. Check if it's an Ollama model tag (e.g., "gemma4:26b")
    const resolvedOllamaBlob = resolveOllamaTagToBlob(modelNameOrPath, searchPaths.ollama);
    if (resolvedOllamaBlob) {
        return resolvedOllamaBlob;
    }

    // 3. Search known .gguf cache directories for matching files
    const cleanSearchName = modelNameOrPath.toLowerCase().replace(/[:\/\\]/g, '_');
    for (const dir of searchPaths.ggufDirs) {
        if (!fs.existsSync(dir)) continue;

        const files = fs.readdirSync(dir);
        const matchedFile = files.find(file =>
            file.toLowerCase().includes(cleanSearchName)
        );

        if (matchedFile) {
            return path.join(dir, matchedFile);
        }
    }

    // Return original string if unresolved (lets llama-cli raise its standard error)
    return modelNameOrPath;
}

/**
 * Parses Ollama's manifest JSON to extract the SHA256 blob path for model weights
 */
function resolveOllamaTagToBlob(tag, ollamaPaths) {
    if (!fs.existsSync(ollamaPaths.manifests)) return null;

    // Parse tag: "gemma4:26b" -> namespace: "library", model: "gemma4", tag: "26b"
    let [namePart, tagPart] = tag.split(':');
    tagPart = tagPart || 'latest';

    let namespace = 'library';
    let modelName = namePart;

    if (namePart.includes('/')) {
        const parts = namePart.split('/');
        namespace = parts[0];
        modelName = parts[1];
    }

    const manifestFilePath = path.join(ollamaPaths.manifests, namespace, modelName, tagPart);

    if (fs.existsSync(manifestFilePath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestFilePath, 'utf8'));

            // Find the model weights layer (usually mediaType ending in .model or giant layer)
            const modelLayer = manifest.layers?.find(layer =>
                layer.mediaType?.endsWith('.model') || layer.mediaType?.includes('model')
            );

            if (modelLayer && modelLayer.digest) {
                // Digest string format: "sha256:abc123..." -> filename: "sha256-abc123..."
                const blobFilename = modelLayer.digest.replace(':', '-');
                const blobPath = path.join(ollamaPaths.blobs, blobFilename);

                if (fs.existsSync(blobPath)) {
                    return blobPath;
                }
            }
        } catch (e) {
            // Silently fall through on parse errors
        }
    }

    return null;
}

function parseModelfileToArgs(filePath, tagName) {
    const content = fs.readFileSync(filePath, 'utf8');
    const args = [];
    let rawModelPath = '';
    let systemPrompt = '';

    // 1. Parse SYSTEM prompt
    const systemMatchMulti = content.match(/SYSTEM\s+"""([\s\S]*?)"""/);
    if (systemMatchMulti) {
        systemPrompt = systemMatchMulti[1].trim();
    } else {
        const systemMatchSingle = content.match(/SYSTEM\s+"(.*)"/);
        if (systemMatchSingle) {
            systemPrompt = systemMatchSingle[1].trim();
        }
    }

    // 2. Parse lines for FROM and PARAMETERs
    const lines = content.split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(/\s+/);
        const instruction = parts[0].toUpperCase();

        if (instruction === 'FROM' && parts[1]) {
            rawModelPath = parts[1];
        } else if (instruction === 'PARAMETER' && parts.length >= 3) {
            const key = parts[1];
            const val = parts.slice(2).join(' ').replace(/^["']|["']$/g, '');
            if (OLLAMA_TO_LLAMA_CPP[key]) {
                args.push(OLLAMA_TO_LLAMA_CPP[key]);
                args.push(val);
            }
        }
    }

    // 3. Resolve the model path and assemble arguments
    if (rawModelPath) {
        const resolvedPath = resolveModelPath(rawModelPath);
        args.unshift(resolvedPath);
        args.unshift('-m');
    }

    if (systemPrompt) {
        args.push('--system-prompt');
        args.push(systemPrompt);
    }

        // Default interactive flag
        // args.push('-i');

    return args;
}

function modelfileToToml(filePath, tag, isSourceTraced = false) {
  // TOML basic strings accept JSON-style escapes, so JSON.stringify is enough here
  const q = (s) => JSON.stringify(String(s));
  const args = parseModelfileToArgs(filePath, tag);
  const modelIdx = args.indexOf('-m');
  const sysIdx = args.indexOf('--system-prompt');

  const lines = [
      `tag = ${q(tag)}`,
      ...(isSourceTraced? [`source = ${q(jsUtils.checkLTrim(path.resolve(filePath), ROOT_DIR))}`] : []),
      `model = ${q(modelIdx >= 0 ? args[modelIdx + 1] : '')}`,
  ];
  if (sysIdx >= 0) lines.push(`system_prompt = """\n${args[sysIdx + 1]}\n"""`);

  // Full llama-cli argv, ready to spawn
  lines.push(`args = [${args.map(q).join(', ')}]`);
  return lines.join('\n') + '\n';
}

module.exports = { getModelSearchDirectories, resolveModelPath, parseModelfileToArgs, modelfileToToml };
