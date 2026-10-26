import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  // Bundled MIT dependencies require their notices to ship with the code; see THIRD-PARTY-NOTICES.md.
  legalComments: 'eof',
  logLevel: 'info',
};

const builds = [
  // Extension host: Node, CommonJS, vscode provided at runtime.
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  // Webview: browser bundle with Three.js inlined (no CDN, strict CSP).
  {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
