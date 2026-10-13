# Third-party components

Original adapter code is MIT licensed (see LICENSE). Dependencies retain their own licenses. The bundled Worker is not entirely MIT licensed.

This project began from the Sites Worker ESM output contract: one self-contained module exporting `default.fetch` plus its hosting manifest. Calendar adapter logic was independently written; no other calendar MCP implementation was copied.

| Package | Pinned version | License | Source |
| --- | --- | --- | --- |
| @nodable/entities | 3.1.0 | MIT | https://www.npmjs.com/package/@nodable/entities/v/3.1.0 |
| anynum | 1.0.1 | MIT | https://www.npmjs.com/package/anynum/v/1.0.1 |
| fast-xml-builder | 1.3.1 | MIT | https://www.npmjs.com/package/fast-xml-builder/v/1.3.1 |
| fast-xml-parser | 5.11.2 | MIT | https://www.npmjs.com/package/fast-xml-parser/v/5.11.2 |
| ical.js | 2.2.1 | MPL-2.0 | https://www.npmjs.com/package/ical.js/v/2.2.1 |
| is-unsafe | 2.0.2 | MIT | https://www.npmjs.com/package/is-unsafe/v/2.0.2 |
| path-expression-matcher | 1.6.2 | MIT | https://www.npmjs.com/package/path-expression-matcher/v/1.6.2 |
| strnum | 2.5.1 | MIT | https://www.npmjs.com/package/strnum/v/2.5.1 |
| xml-naming | 0.3.0 | MIT | https://www.npmjs.com/package/xml-naming/v/0.3.0 |
| esbuild (build only) | 0.28.2 | MIT | https://github.com/evanw/esbuild/tree/v0.28.2 |

Runtime license texts are retained in `third_party/` and included in the generated Worker banner. The lockfile records the exact official npm source tarball URL and integrity hash for every dependency. Preserve these notices and make the corresponding unmodified covered source available as required by each license. `ical.js` 2.2.1 is MPL-2.0: its corresponding source is https://github.com/kewisch/ical.js/tree/v2.2.1 and the pinned npm tarball. No MPL-covered source was modified.

Some dependency modules may be tree-shaken from the Worker. Their notices are conservatively retained. A dependency upgrade must refresh this table, lockfile, and license files.

The @nodable/entities 3.1.0 npm package declares MIT but omits a separate license file. Its full license was obtained from the upstream repository https://github.com/nodable/val-parsers/blob/main/LICENSE (checked 2026-10-13), retained as `third_party/nodable-entities-MIT.txt`.
