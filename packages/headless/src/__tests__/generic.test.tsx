import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { act, render, screen } from '@testing-library/react-native';
import { host } from 'lynkeus-agent';
import { createElement } from 'react';
import { AppRegistry, Text } from 'react-native';

import { mmkv } from '../mocks/factories.js';
import { installDefaultMocks } from '../mocks/install.js';
import { registeredApp } from '../mocks/registered.js';
import { shippedMocks } from '../mocks/shipped.js';
import { entryNavigation, findContainer } from '../navigation.js';
import { hostRoot, rendererNode, textOf, type Fiber } from '../tree.js';

type Fake = { type: unknown; props: Record<string, unknown>; parent: Fake | null; children: (Fake | string)[]; _fiber: Fiber };
const fake = (type: unknown, children: (Fake | string)[] = [], props: Record<string, unknown> = {}): Fake => {
  const node: Fake = { type, props, parent: null, children, _fiber: { type, memoizedProps: props } as Fiber };
  for (const child of children) if (typeof child !== 'string') child.parent = node;
  return node;
};

describe('Testing Library 12 and 13', () => {
  it('reads react-test-renderer’s composite tree as hosts only, and hands fireEvent the instance it knows', () => {
    const Screen = () => null;
    const button = fake('View', ['Sign in'], { testID: 'submit' });
    const root = fake(Screen, [fake('View', [fake(Screen, [button]), 'loose text'])]);
    const rendered = {
      UNSAFE_root: root,
      get container(): never {
        throw new Error("'container' property has been renamed to 'UNSAFE_root'.");
      },
    };
    const tree = hostRoot(rendered);
    expect(tree.type).toBe('');
    const view = tree.children[0] as Exclude<(typeof tree.children)[0], string>;
    expect(view.type).toBe('View');
    const inner = view.children[0] as typeof view;
    expect(inner.props.testID).toBe('submit');
    expect(inner.parent).toBe(view);
    expect(view.parent).toBe(tree);
    expect(textOf(tree)).toBe('Sign inloose text');
    expect(rendererNode(inner)).toBe(button);
    // Stable: the backend keys state by node.
    expect(hostRoot(rendered).children[0]).toBe(view);
  });

  it('takes RNTL 14’s host tree as it is', () => {
    const container = { type: '', props: {}, parent: null, children: [], unstable_fiber: null };
    expect(hostRoot({ container })).toBe(container);
  });
});

describe('navigation without an adapter', () => {
  const ref = {
    isReady: () => true,
    getCurrentRoute: () => ({ name: 'Login' }),
    getRootState: () => ({ index: 0, routes: [{ name: 'Login' }] }),
    addListener: () => undefined,
    removeListener: () => undefined,
    navigate: () => undefined,
    canGoBack: () => false,
    goBack: () => undefined,
  };

  it('finds a React Navigation container in the tree', () => {
    const provider = { memoizedProps: { value: ref }, child: null, sibling: null } as unknown as Fiber;
    const root = { memoizedProps: {}, child: { memoizedProps: {}, child: provider, sibling: null }, sibling: null } as unknown as Fiber;
    expect(findContainer(root)).toBe(ref);
  });

  it('takes what an entry exports as navigation: a function, an adapter or the ref itself', () => {
    expect(entryNavigation(() => ref)?.()?.currentRoute()).toEqual({ name: 'Login' });
    expect(entryNavigation(ref)?.()?.currentRoute()).toEqual({ name: 'Login' });
    expect(entryNavigation(undefined)).toBeUndefined();
    expect(() => entryNavigation({ nope: true })).toThrow('neither an adapter');
  });
});

describe("the app's own entry", () => {
  it('runs, and the component it registers last is the App', () => {
    const Placeholder = () => null;
    const Real = () => null;
    const App = registeredApp(() => {
      AppRegistry.registerComponent('main', () => Placeholder);
      AppRegistry.registerComponent('main', () => Real);
    });
    expect(App).toBe(Real);
    expect(() => registeredApp(() => undefined)).toThrow('registered no component');
  });
});

describe('a library’s own jest mock', () => {
  it('is used for native dependencies only, and a setup file is run instead of used', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-shipped-'));
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write('package.json', JSON.stringify({ dependencies: { 'native-lib': '1', 'js-lib': '1', 'setup-lib': '1', taken: '1' } }));
    for (const name of ['native-lib', 'js-lib', 'setup-lib', 'taken']) write(`node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.js' }));
    write('node_modules/native-lib/ios/x.m', '');
    write('node_modules/native-lib/jest/index.js', 'module.exports = { mocked: true }');
    write('node_modules/js-lib/jest/index.js', 'module.exports = { mocked: true }');
    write('node_modules/setup-lib/android/x.kt', '');
    write('node_modules/setup-lib/jestSetup.js', '');
    write('node_modules/taken/ios/x.m', '');
    write('node_modules/taken/mock.js', 'module.exports = {}');
    const { factories, setups } = shippedMocks(new Set(['taken']), root);
    expect(Object.keys(factories)).toEqual(['native-lib']);
    expect(factories['native-lib']!()).toEqual({ mocked: true });
    expect(Object.keys(setups)).toEqual(['setup-lib']);
  });
});

describe('mmkv', () => {
  it('shares a store per id, and its hooks follow what is written', async () => {
    const lib = mmkv() as {
      MMKV: new (c?: { id?: string }) => { set: (k: string, v: string) => void; getString: (k: string) => string | undefined };
      useMMKVString: (key: string) => readonly [string | undefined, (v: string) => void];
    };
    const a = new lib.MMKV({ id: 'x' });
    const b = new lib.MMKV({ id: 'x' });
    a.set('token', 't1');
    expect(b.getString('token')).toBe('t1');
    const Shown = () => createElement(Text, null, lib.useMMKVString('email')[0] ?? 'none');
    await render(createElement(Shown));
    expect(screen.getByText('none')).toBeTruthy();
    await act(async () => new lib.MMKV().set('email', 'ana@example.com'));
    expect(screen.getByText('ana@example.com')).toBeTruthy();
  });
});

describe('the network fence and mocked answers', () => {
  it('lets a case answer a request to a host the fence refuses: the answer never leaves the process', async () => {
    installDefaultMocks({ network: 'real' });
    (host.get('netmock') as (p: unknown) => unknown)({ path: '/v1/api.json', status: 200, body: JSON.stringify({ status: 'ok' }) });
    const res = (await fetch('https://api.example.com/v1/api.json?rss=1')) as Response;
    expect(await res.json()).toEqual({ status: 'ok' });
    await expect(fetch('https://api.example.com/other')).rejects.toThrow('network to api.example.com is off');
  });
});
