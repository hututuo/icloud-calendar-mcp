import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignored = new Set(['node_modules', '.git']);
const findings = [];
let count = 0;
const patterns = [
  ['Site/account identifier', /\b(?:appgprj|appdep|appver)_[a-zA-Z0-9]{12,}\b/],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API secret', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['embedded URL credentials', /https?:\/\/(?!user(?::pass)?@|hidden-user:hidden-password@)[^\s/"']+:[^\s/"']+@/],
  ['deployment checkout path', /\/(?:workspace\/(?:shared|scratch)|home\/agent|root\/\.codex)\//],
];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(dir, entry.name), name = relative(root, path);
    if (entry.isSymbolicLink()) { findings.push([name, 'symlink requires review']); continue; }
    if (entry.isDirectory()) { await walk(path); continue; }
    if (/\.(?:zip|tar\.gz)$/.test(entry.name)) continue;
    count++;
    const text = await readFile(path, 'utf8');
    for (const [category, regex] of patterns) if (regex.test(text)) findings.push([name, category]);
    if (entry.name === 'hosting.json' && /"project_id"\s*:\s*"[^"\s]+"/.test(text)) findings.push([name, 'bound deployment manifest']);
    if ((entry.name.startsWith('.env') && entry.name !== '.env.example') || entry.name.startsWith('.dev.vars')) findings.push([name, 'local runtime configuration']);
    if (/https?:\/\/[^/\s"']+\.chatgpt\.site\b/.test(text)) {
      const origins = text.match(/https?:\/\/[^/\s"']+\.chatgpt\.site\b/g) || [];
      if (origins.some(value => value !== 'https://fixture.chatgpt.site')) findings.push([name, 'non-fixture Site origin']);
    }
  }
}
await walk(root);
if (findings.length) {
  for (const [file, category] of findings) console.error(`${file}: ${category}`);
  console.error('Review flagged files before public distribution. Values are intentionally omitted.');
  process.exitCode = 1;
} else console.log(`PASS: ${count} files scanned; no configured secrets, real Site origins, deployment IDs, or checkout paths detected by these heuristics. Manual review remains required.`);
