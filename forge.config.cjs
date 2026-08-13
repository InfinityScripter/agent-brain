const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = {
  packagerConfig: {
    appBundleId: 'dev.agentbrain.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    asar: true,
    osxUniversal: {
      x64ArchFiles: 'Contents/Resources/python-*/**'
    },
    extraResource: [
      path.join(__dirname, 'brain.py'),
      path.join(__dirname, 'defaults'),
      path.join(__dirname, 'web'),
      path.join(__dirname, 'bin', 'agent-brain-app'),
      path.join(__dirname, '.runtime-cache', 'python-arm64'),
      path.join(__dirname, '.runtime-cache', 'python-x64')
    ],
    executableName: 'Agent Brain',
    osxSign: { identity: '-' },
    icon: path.join(__dirname, 'assets', 'agent-brain.icns'),
    electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
    extendInfo: {
      CFBundleDisplayName: 'Agent Brain',
      NSHumanReadableCopyright: 'Local-first agent context control plane',
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false }
    },
    ignore: [
      /^\/\.electron-cache/,
      /^\/\.runtime-cache/,
      /^\/\.git/,
      /^\/adapters/,
      /^\/bin/,
      /^\/config/,
      /^\/core/,
      /^\/data/,
      /^\/domains/,
      /^\/projects/,
      /^\/registry/,
      /^\/views/,
      /^\/reports/,
      /^\/scripts/,
      /^\/output/,
      /^\/out/,
      /^\/tests/,
      /^\/workflows/,
      /^\/web/,
      /^\/\.playwright-cli/,
      /^\/brain\.py$/,
      /^\/AGENTS\.md$/,
      /^\/README\.md$/,
      /^\/THIRD_PARTY_NOTICES\.md$/,
      /^\/Open Agent Brain\.command$/,
      /^\/electron\/test/,
      /^\/electron\/package-smoke\.cjs$/
    ]
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'Agent Brain',
        format: 'ULFO'
      }
    }
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ],
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (process.platform !== 'darwin') return;
      for (const outputPath of packageResult.outputPaths) {
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(outputPath, 'Agent Brain.app')]);
      }
    }
  }
};
