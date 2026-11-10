// Runs the exact code that ships inside an n8n Code node, outside n8n.
// It supplies the small part of the Code-node API these nodes use:
//   $input.first() / $input.all(), $json, $env, and $('Node Name').first() / .item
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function runNode(file, { input = [{}], env = {}, nodes = {} } = {}) {
  const code = readFileSync(join(root, 'src', 'nodes', file + '.js'), 'utf8');
  const items = input.map((json) => ({ json }));
  const $input = { first: () => items[0], all: () => items };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`test did not provide output for node "${name}"`);
    const item = { json: nodes[name] };
    return { first: () => item, item, all: () => [item] };
  };
  const fn = new Function('$input', '$json', '$env', '$', code);
  const out = fn($input, items[0].json, env, $);
  return out.map((o) => o.json);
}

export const fixture = (name) =>
  JSON.parse(readFileSync(join(root, 'test', 'fixtures', name), 'utf8'));
