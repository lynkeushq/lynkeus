/**
 * Babel plugin: writes LYNKEUS_TOKEN into the bundle where the app reads
 * `process.env.LYNKEUS_TOKEN`. React Native gives the app no environment, so
 * without it the token the app passes to the agent is undefined.
 *
 *   plugins: ['lynkeus-agent/babel']
 *
 * A production transform is left alone: the secret of a developer's machine
 * has no place in a release bundle.
 */
module.exports = ({ types: t, env }) => {
  const production = env('production');
  return {
    name: 'lynkeus-token',
    visitor: {
      MemberExpression(path) {
        if (production || !path.matchesPattern('process.env.LYNKEUS_TOKEN')) return;
        const token = process.env.LYNKEUS_TOKEN;
        if (token) path.replaceWith(t.stringLiteral(token));
      },
    },
  };
};
