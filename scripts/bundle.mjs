import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
const licenseFiles = (await readdir('third_party')).filter(name => name.endsWith('.txt')).sort();
const notices = await Promise.all(licenseFiles.map(async name => `${name}\n${await readFile(`third_party/${name}`, 'utf8')}`));
const banner = `/*! Third-party license notices. See source THIRD_PARTY_NOTICES.md.\n${notices.join('\n\n').replaceAll('*/', '* /')}\n*/`;
await build({ entryPoints: ['worker/index.js'], outfile: 'dist/server/index.js', bundle: true, platform: 'browser', target: 'es2022', format: 'esm', minify: false, sourcemap: false, legalComments: 'inline', banner: { js: banner }, metafile: true });
