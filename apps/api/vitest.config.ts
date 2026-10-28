import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emite metadatos de decoradores (necesarios para la inyección de dependencias de Nest).
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, target: 'es2022' },
      module: { type: 'es6' },
    }),
  ],
  test: {
    globalSetup: './test/global-setup.ts',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
