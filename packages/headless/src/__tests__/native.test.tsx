import { beforeAll, describe, expect, it } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { host } from 'lynkeus-agent';
import { createElement } from 'react';
import { NativeModules } from 'react-native';

import { installNativeMocks, NativeMockScreen } from '../mocks/native.js';
import { reset } from '../runtime.js';

type Launch = () => Promise<unknown>;
const nativeMocks = (params: unknown) => (host.get('nativeMocks') as (p: unknown) => unknown)(params);

beforeAll(() => {
  installNativeMocks();
});

describe('nativeMocks', () => {
  it('stands in for Sumsub with a page whose buttons answer the launch', async () => {
    await render(createElement(NativeMockScreen));
    let launched: Promise<unknown> | undefined;
    await act(async () => {
      launched = (NativeModules.SNSMobileSDKModule!.launch as Launch)();
    });
    expect(screen.getByText('Sumsub')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('native-mock-submit'));
    });
    await expect(launched).resolves.toEqual({ success: true, status: 'Pending' });
    expect(screen.queryByTestId('native-mock')).toBeNull();
  });

  it('answers a configured result at once, and a reset brings the defaults back', async () => {
    nativeMocks({ set: { 'SNSMobileSDKModule.launch': { result: { success: false, status: 'Failed' } } } });
    await expect((NativeModules.SNSMobileSDKModule!.launch as Launch)()).resolves.toEqual({ success: false, status: 'Failed' });
    reset();
    await render(createElement(NativeMockScreen));
    await act(async () => {
      void (NativeModules.SNSMobileSDKModule!.launch as Launch)();
    });
    expect(screen.getByTestId('native-mock-close')).toBeTruthy();
  });
});
