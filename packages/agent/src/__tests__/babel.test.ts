import { transformSync } from '@babel/core';
import { afterEach, describe, expect, it } from '@jest/globals';

const SOURCE = 'auto({ token: process.env.LYNKEUS_TOKEN, other: process.env.OTHER });';
const transform = (envName: string) =>
  transformSync(SOURCE, { babelrc: false, configFile: false, envName, plugins: [require.resolve('../../babel.js')] })?.code;

describe('the babel plugin', () => {
  const before = process.env.LYNKEUS_TOKEN;
  afterEach(() => {
    if (before === undefined) delete process.env.LYNKEUS_TOKEN;
    else process.env.LYNKEUS_TOKEN = before;
  });

  it('writes the token where the app reads it, and nothing else', () => {
    process.env.LYNKEUS_TOKEN = 'local-secret';
    const code = transform('development');
    expect(code).toContain('token: "local-secret"');
    expect(code).toContain('other: process.env.OTHER');
  });

  it('leaves a release bundle and an unset token alone', () => {
    process.env.LYNKEUS_TOKEN = 'local-secret';
    expect(transform('production')).toContain('process.env.LYNKEUS_TOKEN');
    delete process.env.LYNKEUS_TOKEN;
    expect(transform('development')).toContain('process.env.LYNKEUS_TOKEN');
  });
});
