const path = require('node:path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: path.join(__dirname, 'electron', 'visual'),
  testMatch: '*.spec.cjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      threshold: 0.2,
      maxDiffPixelRatio: 0.005
    }
  },
  snapshotPathTemplate: '{testDir}/snapshots/{arg}{ext}',
  outputDir: path.join(__dirname, 'output', 'playwright', 'test-results'),
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: path.join(__dirname, 'output', 'playwright', 'report'), open: 'never' }]]
    : [['line']]
});
