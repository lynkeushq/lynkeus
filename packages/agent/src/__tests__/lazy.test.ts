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
