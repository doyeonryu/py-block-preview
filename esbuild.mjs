// Build script.
//   node esbuild.mjs               development build (with source maps)
//   node esbuild.mjs --production  minified build used for packaging
//   node esbuild.mjs --watch       rebuild on change
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

mkdirSync('dist', { recursive: true });
copyFileSync('node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/tree-sitter.wasm');
copyFileSync('node_modules/tree-sitter-python/tree-sitter-python.wasm', 'dist/tree-sitter-python.wasm');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'warning' };

const configs = [
  // Extension host (Node)
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  // Webview (browser)
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife' },
  { ...common, entryPoints: ['webview/style.css'], outfile: 'dist/webview.css' },
];

if (!production) {
  // Dev tools and tests (Node) — not shipped in the .vsix
  const tests = readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
  configs.push(
    { ...common, entryPoints: ['scripts/inspect.ts'], outfile: 'out/inspect.js', platform: 'node', format: 'cjs' },
    { ...common, entryPoints: tests, outdir: 'out/test', platform: 'node', format: 'cjs', external: ['jsdom'] },
  );
}

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
