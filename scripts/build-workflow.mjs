// Injects src/nodes/*.js into the Code nodes of the n8n workflow.
// src/nodes is the source of truth; the workflow JSON is a build output.
// CI runs this and fails if the committed workflow differs from the result.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = join(root, 'workflows', 'call-recording-to-crm.json');

export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function build() {
  const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
  const missing = [];
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    const file = join(root, 'src', 'nodes', slug(node.name) + '.js');
    if (!existsSync(file)) { missing.push(node.name); continue; }
    node.parameters.jsCode = readFileSync(file, 'utf8').replace(/\n+$/, '');
  }
  if (missing.length) throw new Error('No source file for Code node(s): ' + missing.join(', '));
  return workflow;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(workflowPath, JSON.stringify(build(), null, 2) + '\n');
  console.log('workflow rebuilt from src/nodes');
}
