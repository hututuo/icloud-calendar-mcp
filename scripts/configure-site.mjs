import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const id = process.argv[2];
if (!id || !/^[A-Za-z0-9_-]{8,200}$/.test(id) || process.argv.length !== 3) {
  throw new Error('Usage: npm run configure:site -- <project-id returned by Sites>. No credentials are accepted.');
}
const path = resolve(root, '.openai/hosting.json');
let manifest;
try { manifest = JSON.parse(await readFile(path, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  manifest = JSON.parse(await readFile(resolve(root, '.openai/hosting.example.json'), 'utf8'));
}
if (manifest.project_id && manifest.project_id !== id) throw new Error('This checkout is already bound to another Site. Use a fresh copy.');
manifest.project_id = id;
await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log('Local deployment manifest configured. Keep it out of the public repository and release ZIP.');
