import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the site from https://<user>.github.io/<repo>/
  base: '/blockchain-attack-simulator/',
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
