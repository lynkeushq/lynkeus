import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { host } from 'lynkeus-agent';
import { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';

import { installControls } from '../mocks/controls.js';

const clock = (params: unknown) => (host.get('clock') as (p: unknown) => Promise<{ advancedMs: number; nextDueMs: number | null }>)(params);

// The timer, the interval and the frame loop of the example app's Probe screen.
const Probe = ({ stamps }: { stamps: string[] }) => {
  const [timer, setTimer] = useState('idle');
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      stamps.push(new Date().toISOString());
      setTicks((n) => n + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [stamps]);
  return (
    <View>
      <Button
        title="Start"
        onPress={() => {
          setTimer('waiting');
          setTimeout(() => setTimer('fired'), 5000);
        }}
      />
      <Text>{timer}</Text>
      <Text>{`ticks ${ticks}`}</Text>
    </View>
  );
};

beforeAll(() => {
  installControls();
});
beforeEach(async () => {
  await clock({ reset: true });
});

describe('clock --advance on a rendered screen', () => {
  it('fires a 5 s timer on 5000 and not on 4000', async () => {
    await render(<Probe stamps={[]} />);
    await fireEvent.press(screen.getByText('Start'));
    expect(screen.getByText('waiting')).toBeTruthy();
    await act(async () => {
      await clock({ advanceMs: 4000 });
    });
    expect(screen.getByText('waiting')).toBeTruthy();
    await act(async () => {
      await clock({ advanceMs: 1000 });
    });
    expect(screen.getByText('fired')).toBeTruthy();
  });

  it('runs an interval once for each period, each at its own due time', async () => {
    await clock({ now: '2027-01-01T00:00:00Z' });
    const stamps: string[] = [];
    await render(<Probe stamps={stamps} />);
    await act(async () => {
      await clock({ advanceMs: 3000 });
    });
    expect(screen.getByText('ticks 3')).toBeTruthy();
    const start = Date.parse('2027-01-01T00:00:00Z');
    expect(stamps.map((at) => Math.round((Date.parse(at) - start) / 1000))).toEqual([1, 2, 3]);
  });
});
