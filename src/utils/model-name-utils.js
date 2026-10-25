
const MODEL_ORDER = [
  'gemma4', 'gemma4-e2b',
  'qwen3',
  'qwen2.5-coder', 'qwen2.5',
  'ornith1.5', 'ornith1.5-35B',   // handled last
];
const PROMPT_ORDER = ['collab-coder', 'collab-one-shot', 'strict-coder'];

// 'ollama/gemma4-temp-0.8:latest' -> { model: 'gemma4', prompt: 'temp', temp: 0.8 }
const parseModel = (name) => {
  const base = name.split('/').pop().split(':')[0];
  const match = base.match(/^(.+?)-(collab-coder|collab-one-shot|strict-coder|temp-([\d.]+))$/);
  if (!match) return { model: base, prompt: null, temp: 0 };
  const [, rawModel, prompt, temp] = match;

  // ornith names its temp kits "ornith1.5-coder-temp-0.1" / "ornith1.5-35B-coder-temp-0.1";
  // fold the "-coder" back into the family so they group with the other ornith kits
  const model = rawModel.replace(/^(ornith[\d.]+(?:-35B)?)-coder$/, '$1');

  return { model, prompt: temp ? 'temp' : prompt, temp: temp ? parseFloat(temp) : 0 };
};

const rank = (list, item) => {
  const i = list.indexOf(item);
  return i === -1 ? list.length : i; // unknowns go last
};

const compareModels = (a, b) => {
  const pa = parseModel(a);
  const pb = parseModel(b);

  return (
    rank(MODEL_ORDER, pa.model) - rank(MODEL_ORDER, pb.model) ||
    pa.model.localeCompare(pb.model) ||
    rank(PROMPT_ORDER, pa.prompt) - rank(PROMPT_ORDER, pb.prompt) ||
    pb.temp - pa.temp ||                // higher temperature first
    a.localeCompare(b)
  );
};

module.exports = { compareModels };
