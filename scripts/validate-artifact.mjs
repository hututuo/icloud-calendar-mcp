import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");

const config = JSON.parse(manifest);
assert.equal(config.d1, null, 'No database binding is required');
assert.equal(config.r2, null, 'No object storage binding is required');
assert.ok(config.capabilities?.includes('mcp'), 'MCP capability must be declared');
if (process.argv.includes('--for-deploy')) {
  assert.match(config.project_id || '', /^[A-Za-z0-9_-]{8,200}$/, 'Bind the actual Site ID before deployment');
  console.log('Deployment manifest contains a project ID. Independently verify its ownership and private access before publishing.');
}
