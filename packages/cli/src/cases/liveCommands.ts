type Answerer = { server: { connected: boolean; call: (method: 'ping', params?: undefined, timeoutMs?: number) => Promise<{ commands: string[] }> } };

// One ping per hello: a new hello (a reload, a reconnect) is a new app to ask, the same one is not asked again.
const asked = new WeakMap<object, string[]>();

/**
 * The commands the attached app answers now. The hello lists what was registered when the app dialled in; an app
 * that registers more after it says so in a ping, so `has:<command>` is decided against that, once per hello,
 * and falls back to the hello's list when nothing answers.
 */
export const liveCommands = async (d: Answerer, hello: { commands?: string[] } | null | undefined): Promise<string[] | undefined> => {
  if (!hello) return undefined;
  const known = asked.get(hello);
  if (known) return known;
  if (!d.server.connected) return hello.commands;
  try {
    const { commands } = await d.server.call('ping', undefined, 3000);
    if (!Array.isArray(commands)) return hello.commands;
    asked.set(hello, commands);
    return commands;
  } catch {
    return hello.commands;
  }
};
