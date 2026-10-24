
const { transparentSpawn, collectStream } = require('./spawn-helper');
const { streamlineLogStrings } = require('./ident-helpers');

async function askKit(prompt, cfg) {
  throw new Error("Realized didn't need this... untested");
  const kitArgs = [
    // '--config', cfg.config,
    '--config', path.resolve(cfg.config),
    '--no-session',
    '--json',
    ...(typeof cfg.stream === 'boolean' ? [`--stream=${cfg.stream.toString()}`] : []),
    '--model', cfg.model,
    '--provider-url', cfg.provider_url,
    '--max-steps', String(1),
    // '--temperature', String(cfg.temperature),
    prompt, // positional prompt last => non-interactive one-shot
  ];
  const spawned = transparentSpawn('kit', kitArgs);
  await spawned.promise;
  const out = collectStream(spawned.child.stdout);
  const err = collectStream(spawned.child.stderr);
  await Promise.all([out.done, err.done]);
  const stdOutText = out.text();
  const stdErrText = err.text();
  if (stdErrText.trim()) {
    console.log('Ask-Kit has error text:\n', stdErrText);
  }
  const result = JSON.parse(stdOutText);
  if (result?.response) { }
}

function cleanKitOutputArtifact(str) {
  const cleanStr = streamlineLogStrings(str);
  let parsedObj = {};
  try {
    parsedObj = JSON.parse(cleanStr);
  } catch (error) {
    console.log('[cleanKitOutputArtifact] Failed to parse passed string: \n', error);
    return cleanStr;
  }

  const findMatchingCallId = (part) => parsedObj.messages
    .find((msg) => ((msg.role === 'tool' || msg.role === 'assistant') &&
      msg.parts.find(p => p.data && p.data.id === part.data.tool_call_id)));
  const processUserParts = (arr) => arr.map((part) => {
    part.data.text = streamlineLogStrings(part.data.text);
    return part;
  });
  const processToolParts = (arr) => arr.map((part) => {
    if (part.type === 'tool_call') {
      if (typeof part.data.input === 'string') {
        part.data.input = JSON.parse(part.data.input);
      }
    } else if(part.type === 'tool_result') {
      part.data.tool_call_data = findMatchingCallId(part);
      if (part.data.tool_call_data && typeof part.data.tool_call_data.input === 'string') {
        part.data.tool_call_data.input = JSON.parse(part.data.tool_call_data.input);
      }
    }
    return part;
  });
  const processAssistantParts = (arr) => arr.map((part) => {
    if (part.type === 'tool_call') {
      if (typeof part.data.input === 'string') {
        part.data.input = JSON.parse(part.data.input);
      }
    } else if(part.type === 'tool_result') {
      part.data.tool_call_data = findMatchingCallId(part);
      if (part.data.tool_call_data && typeof part.data.tool_call_data.input === 'string') {
        part.data.tool_call_data.input = JSON.parse(part.data.tool_call_data.input);
      }
    }
    return part;
  });
  for (const key in parsedObj.messages) {
    if (parsedObj.messages[key].role === 'user') {
      parsedObj.messages[key].parts = processUserParts(parsedObj.messages[key].parts);
    } else if (parsedObj.messages[key].role === 'tool') {
      parsedObj.messages[key].parts = processToolParts(parsedObj.messages[key].parts);
    } else if (parsedObj.messages[key].role === 'assistant') {
      parsedObj.messages[key].parts = processAssistantParts(parsedObj.messages[key].parts);
    }
  }
  return JSON.stringify(parsedObj);

}
module.exports = { askKit, cleanKitOutputArtifact };
