import { expect, it, jest } from '@jest/globals';

it('importing the package evaluates neither the client nor what reads the screen', () => {
  const evaluated: string[] = [];
  jest.isolateModules(() => {
    for (const file of ['../client', '../handlers', '../tree', '../backends/fabric']) {
      jest.doMock(file, () => {
        evaluated.push(file);
        return {};
      });
    }
    require('../index');
    require('../auto');
  });
  expect(evaluated).toEqual([]);
});

it('registering a command in a release build is inert: no client, no socket, the handler not run', () => {
  const g = globalThis as { __DEV__?: boolean };
  const dev = g.__DEV__;
  g.__DEV__ = false;
  const evaluated: string[] = [];
  const handler = jest.fn(() => 'fresh');
  try {
    jest.isolateModules(() => {
      for (const file of ['../client', '../handlers', '../tree', '../backends/fabric']) {
        jest.doMock(file, () => {
          evaluated.push(file);
          return {};
        });
      }
      const { qa } = require('../index') as typeof import('../index');
      qa.register('reset', handler);
      expect(qa.commands()).toContain('reset');
    });
  } finally {
    g.__DEV__ = dev;
  }
  expect(evaluated).toEqual([]);
  expect(handler).not.toHaveBeenCalled();
});
