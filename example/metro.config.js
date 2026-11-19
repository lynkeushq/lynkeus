const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config');
const { withMetroConfig } = require('react-native-monorepo-config');

const root = path.resolve(__dirname, '..');
const agentRoot = path.resolve(__dirname, '../packages/agent');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = withMetroConfig(getDefaultConfig(__dirname), {
  root,
  dirname: __dirname,
  // pnpm keeps the workspaces in pnpm-workspace.yaml, not in package.json.
  workspaces: ['packages/*'],
  conditions: ['lynkeus-agent-source'],
});

// The agent's source sits outside this folder; under pnpm it finds the app's dependencies only through this path.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

module.exports = config;
