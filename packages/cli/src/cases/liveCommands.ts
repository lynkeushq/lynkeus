type Answerer = { server: { connected: boolean; call: (method: 'ping', params?: undefined, timeoutMs?: number) => Promise<{ commands: string[] }> } };

/**
 * The commands the attached app answers now. The hello lists what was registered when the app dialled in; an app
 * that dials in again (after a reload, or a slow start that registers its commands after the first hello) says
 * more in a ping, so `has:<command>` is decided against that and falls back to the hello when nothing answers.
 */
export const liveCommands = async (d: Answerer, hello: string[] | undefined): Promise<string[] | undefined> => {
  if (!d.server.connected) return hello;
  try {
    const { commands } = await d.server.call('ping', undefined, 3000);
    return Array.isArray(commands) ? commands : hello;
  } catch {
    return hello;
  }
};
