import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/panel/index.ts'],
  bundle: true,
  outfile: 'dist/panel/bundle.js',
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  external: ['uxp', 'premierepro'],
});

mkdirSync('dist/panel', { recursive: true });
copyFileSync('src/panel/index.html', 'dist/panel/index.html');
copyFileSync('src/panel/styles.css', 'dist/panel/styles.css');

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Build complete.');
}
