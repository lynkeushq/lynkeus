import { useEffect, useRef, useState } from 'react';
import { Button, Text, View } from 'react-native';

const API = 'http://localhost:3999';

// Screen for checking `--epoch`, `--seed`, `clock --settle` and `mock --hold` by hand or from a case.
export const Probe = () => {
  const [timer, setTimer] = useState('idle');
  const [looping, setLooping] = useState(false);
  const [frames, setFrames] = useState(0);
  const [data, setData] = useState('not loaded');
  const [loading, setLoading] = useState(false);
  const [random] = useState(() => [Math.random(), Math.random(), Math.random()].map((n) => n.toFixed(6)).join(' '));
  const [startedAt] = useState(() => new Date().toISOString());
  const loop = useRef(0);

  useEffect(() => {
    if (!looping) return;
    const tick = () => {
      setFrames((n) => n + 1);
      loop.current = requestAnimationFrame(tick);
    };
    loop.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(loop.current);
  }, [looping]);

  const load = () => {
    setLoading(true);
    setData('loading');
    fetch(`${API}/items`)
      .then((response) => response.text())
      .then((text) => setData(text))
      .catch((error: unknown) => setData(`error ${String(error)}`))
      .finally(() => setLoading(false));
  };

  return (
    <View style={{ flex: 1, padding: 24, gap: 12, justifyContent: 'center' }}>
      <Text testID="started-at">{startedAt}</Text>
      <Text testID="random">{random}</Text>
      <Button
        testID="start-timer"
        title="Start 5 s timer"
        onPress={() => {
          setTimer('waiting');
          setTimeout(() => setTimer('fired'), 5000);
        }}
      />
      <Text testID="timer">{timer}</Text>
      <Button testID="toggle-loop" title={looping ? 'Stop frame loop' : 'Start frame loop'} onPress={() => setLooping((on) => !on)} />
      <Text testID="frames">{`frames ${frames}`}</Text>
      <Button testID="load" title="Load items" onPress={load} />
      <Text testID="loading">{loading ? 'spinner' : 'no spinner'}</Text>
      <Text testID="data">{data}</Text>
    </View>
  );
};
