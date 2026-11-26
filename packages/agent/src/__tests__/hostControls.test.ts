import { afterEach, expect, it, jest } from '@jest/globals';

import type { HostControls } from '../hostControls';

const g = globalThis as { __lynkeusHostControls?: unknown };

afterEach(() => {
  delete g.__lynkeusHostControls;
});

const fresh = () => {
  let mod: { installHostControls: () => void; registry: typeof import('../registry') } | undefined;
  jest.isolateModules(() => {
    mod = { installHostControls: (require('../hostControls') as typeof import('../hostControls')).installHostControls, registry: require('../registry') };
  });
  return mod!;
};

it('does nothing where no host defines controls', () => {
  expect(() => fresh().installHostControls()).not.toThrow();
});

it("hands the host the agent's registry once, so its commands are the app's to answer", () => {
  const { installHostControls, registry } = fresh();
  const install = jest.fn((controls: HostControls) => {
    controls.qa.register('screenshot', () => ({ path: 'x.png' }));
  });
  g.__lynkeusHostControls = install;
  installHostControls();
  installHostControls();
  expect(install).toHaveBeenCalledTimes(1);
  const given = install.mock.calls[0]![0];
  expect(given.qa).toBe(registry.qa);
  expect(given.host).toBe(registry.host);
  expect(typeof given.countHeldFrom).toBe('function');
  expect(registry.host.commands()).toContain('screenshot');
});

it('keeps the agent running when the controls throw', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  g.__lynkeusHostControls = () => {
    throw new Error('broken');
  };
  expect(() => fresh().installHostControls()).not.toThrow();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
  warn.mockRestore();
});
