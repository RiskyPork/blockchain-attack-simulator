import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the site from https://<user>.github.io/<repo>/
  base: '/blockchain-attack-simulator/',
  // The Experiments tab's worker imports the simulation modules, so it is bundled as an ES module.
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
