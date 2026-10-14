/**
 * Babel plugin: writes the project's token into the bundle where the app reads
 * `process.env.LYNKEUS_TOKEN`: the environment's, or the one in `.lynkeus/token`. React Native gives the app no environment, so
 * without it the token the app passes to the agent is undefined.
 *
 *   plugins: ['lynkeus-agent/babel']
 *
 * A production transform is left alone: the secret of a developer's machine
 * has no place in a release bundle.
 */
const fs = require('node:fs');
const nodePath = require('node:path');

/** The token `lynkeus init` wrote for the project, when the environment has none. */
const fromFile = (root) => {
  try {
    return fs.readFileSync(nodePath.join(root, '.lynkeus', 'token'), 'utf8').trim();
  } catch {
    return '';
  }
};

module.exports = ({ types: t, env }) => {
  const production = env('production');
  return {
    name: 'lynkeus-token',
    visitor: {
      MemberExpression(path, state) {
        if (production || !path.matchesPattern('process.env.LYNKEUS_TOKEN')) return;
        const token = process.env.LYNKEUS_TOKEN || fromFile(state.file.opts.root || process.cwd());
        if (token) path.replaceWith(t.stringLiteral(token));
      },
    },
  };
};
