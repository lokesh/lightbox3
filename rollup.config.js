import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';

const input = 'src/index.ts';

const basePlugins = [
  resolve(),
  typescript({ tsconfig: './tsconfig.json' }),
  postcss({ extract: 'lightbox3.css', minimize: true }),
];

export default [
  // ESM bundle (for bundlers / npm)
  {
    input,
    output: {
      file: 'dist/lightbox3.esm.js',
      format: 'es',
      sourcemap: true,
    },
    plugins: basePlugins,
  },
  // UMD bundle (for script tags / CDN)
  {
    input,
    output: {
      file: 'dist/lightbox3.umd.js',
      format: 'umd',
      name: 'Lightbox3',
      sourcemap: true,
    },
    plugins: [
      resolve(),
      typescript({ tsconfig: './tsconfig.json' }),
      postcss({ extract: 'lightbox3.css', minimize: true }),
    ],
  },
  // Minified UMD (CDN primary)
  {
    input,
    output: {
      file: 'dist/lightbox3.min.js',
      format: 'umd',
      name: 'Lightbox3',
      sourcemap: true,
    },
    plugins: [
      resolve(),
      typescript({ tsconfig: './tsconfig.json' }),
      postcss({ extract: 'lightbox3.css', minimize: true }),
      terser(),
    ],
  },
];
