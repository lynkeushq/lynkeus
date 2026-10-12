---
title: Agent API
description: Everything lynkeus-agent exports — auto, the Lynkeus component and its props, qa.register, qa.observe, qa.event and navigation adapters.
---

The **agent** is the part of lynkeus that lives inside your app: the `lynkeus-agent` package. It reads the screen, synthesizes touches and answers the driver. This page documents what the package exports and what each option does. It is for the developer who mounts the agent and exposes app commands to tests.

For a step-by-step installation, see [Install in a React Native app](/getting-started/installation-react-native/) or [Install in an Expo app](/getting-started/installation-expo/).

## Two ways to mount

The agent has to be mounted once. There are two ways, and they can coexist: the first one to start owns the connection and the second stays quiet.

| | `auto()` | `<Lynkeus>` |
|---|---|---|
| Where it goes | One line in the entry file, before `registerComponent`. | A component under your navigation container. |
| Navigation | Finds a React Navigation container by itself. | You pass an adapter. |
| Traces a person's touches (for `lynkeus record`) | Yes | No |
| Measures render time (for `lynkeus profile`) | Yes | No |
| Use it when | You use React Navigation, or no router. | You need an adapter for another router. |

## `auto(options)`

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

auto({ token: process.env.LYNKEUS_TOKEN, enabled: __DEV__ });
```

`auto` is imported from `lynkeus-agent/auto`, not from the package root. Call it before `AppRegistry.registerComponent`. It renders nothing on any screen.

It wraps the app's root through `AppRegistry` and looks for a React Navigation container in the tree, so no ref has to be passed around. If the app or another library already installed a root wrapper, `auto` keeps it and nests inside it.

Calling `auto` a second time does nothing. Calling it with `enabled` false does nothing at all.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `__DEV__` | Whether the agent runs at all. |
| `token` | string | none | The shared secret. When set, the driver must present it before any command is served. |
| `host` | string | `localhost`, or `10.0.2.2` on Android | Where the driver listens. |
| `port` | number | `8123` | The driver's port. |
| `app` | object | none | A free-form description of the app, sent to the driver when the app attaches: name, version, environment. |
| `reconnectMs` | number (ms) | `1500` | The longest wait between two attempts to reach the driver. |
| `discoverEveryMs` | number (ms) | `250` | How often to look for the navigation container until it is found. The search stops after 20 seconds. |
| `onError` | `(error, context) => void` | none | Called when something fails inside the connection. The app itself stays quiet. |

`auto` takes every prop of `<Lynkeus>` except `navigation`, which it finds by itself, plus `discoverEveryMs`.

## `<Lynkeus>`

```tsx title="App.tsx"
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { Lynkeus, reactNavigationAdapter } from 'lynkeus-agent';

const App = () => {
  const ref = useNavigationContainerRef();
  return (
    <NavigationContainer ref={ref}>
      <RootNavigator />
      <Lynkeus
        navigation={reactNavigationAdapter(ref)}
        enabled={__DEV__ && config.ENV !== 'prod'}
        token={process.env.LYNKEUS_TOKEN}
        app={{ name: 'myapp', env: config.ENV }}
      />
    </NavigationContainer>
  );
};
```

Mount it once, anywhere under your navigation container. It renders nothing. The code that talks to the driver is loaded only when `enabled` is true, so a release bundle never evaluates it.

The options are read once, when the component mounts. Changing `host`, `port` or `token` on a later render has no effect; changing `enabled` or `navigation` restarts the connection.

### Props

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `__DEV__` | Whether the agent runs at all. Gate it further on your environment: a debug build that talks to production is not a test surface. |
| `navigation` | `NavigationAdapter` | none | How the agent reads and drives your router. Without one you still get the screen, touches and waits, but no routes. |
| `host` | string | `localhost`, or `10.0.2.2` on Android | Where the driver listens. |
| `port` | number | `8123` | The driver's port. Change it on both ends to run several apps on one machine. |
| `token` | string | none | The shared secret. When set, the driver must present it before any command is served, which keeps other local processes from driving the app. The CLI reads its copy from `LYNKEUS_TOKEN`. |
| `app` | object | none | A free-form description sent when the app attaches. `lynkeus hello` prints it. |
| `reconnectMs` | number (ms) | `1500` | The longest wait between two attempts to reach the driver. For 3 seconds after the app starts or a connection drops, it retries every 100 ms; after that each wait doubles, up to this value. |
| `onError` | `(error, context) => void` | none | Called when something fails inside the connection. |
| `backend` | `Backend` | the device backend | Where the app runs and how it is touched. For hosts; an app does not set it. |
| `createSocket` | `(url) => Socket` | the global `WebSocket` | How to open the connection. For hosts; an app does not set it. |

## `qa`

`qa` is how your app adds to the agent: commands only the app can run, stores worth watching, and analytics events.

```ts
import { qa } from 'lynkeus-agent';
```

Call these at module level or during startup. They work whether or not the agent is enabled, so you do not need to guard them.

### `qa.register(name, handler)`

Exposes something the app can do to whoever drives it.

```ts
qa.register('reset', async () => {
  await session.logout();
  await cache.clear();
});
qa.register('busy', () => queryClient.isFetching() > 0);
qa.register('setFlag', ({ name, on }) => flags.override(name, on));
```

| Parameter | Type | Meaning |
|---|---|---|
| `name` | string | The command's name. It must start with a letter and may contain letters, digits, `_`, `.` and `-`. Any other name throws `Invalid command name "<name>"`. |
| `handler` | `(params) => unknown \| Promise<unknown>` | What runs. It receives the params the driver sent and its return value is the answer. |

It returns a function that removes the command again. Registering a name twice replaces the earlier handler.

A registered command is reachable three ways:

```bash
lynkeus call setFlag '{"name":"new-checkout","on":true}'
```

```yaml
- app.call: { command: setFlag, params: { name: new-checkout, on: true } }
```

and, from your own driver, as a protocol method of that name. `lynkeus hello` lists what the app registered.

#### Two names that mean something

Drivers look for two command names. Neither is required.

| Command | Contract | Why |
|---|---|---|
| `reset` | Leave the app as freshly installed: log out, clear storage and caches. | A driver calls it before each test, and `lynkeus launch --clean` calls it too. A stale query cache is the most common bug between tests. After your handler runs, the agent also sends the navigation back to its initial route. |
| `busy` | Return `true` while the app's data layer has work in flight. | It lets a driver wait for data instead of for a timer. The agent already counts HTTP requests in flight; `busy` adds what it cannot see. |

#### Commands every app answers

The agent registers four commands of its own. Registering the same name in your app replaces the built-in one.

| Command | Params | Answer |
|---|---|---|
| `events` | `{ clear?: boolean }` | The analytics events recorded with `qa.event`, oldest first. `clear` empties the buffer after reading. |
| `stores` | `{ name?: string }` | Without a name, `{ stores: [...] }`: the names observed with `qa.observe`. With a name, that store's state. |
| `profile` | `{ action?: 'start' \| 'stop' }` | Render time per route. See `lynkeus profile`. |
| `traceContext` | `{ traceparent: string \| null }` | Sets the W3C trace context the agent adds to the app's requests. `lynkeus case run --traces` uses it. |

### `qa.unregister(name)`

Removes a command by name.

### `qa.commands()`

Returns the names of every command the app answers, sorted: your own and the built-in ones.

### `qa.observe(name, store)`

Puts a store in the trace, so that a failure report says what the app believed at that moment, not only what it painted.

```ts
qa.observe('session', useSessionStore);
```

| Parameter | Type | Meaning |
|---|---|---|
| `name` | string | What the store is called in the trace and in the `stores` command. |
| `store` | `{ getState(), subscribe(listener) }` | Anything with these two methods. `subscribe` must call the listener with the new state on every change, and return an unsubscribe function. |

It returns a function that stops observing.

Two things follow from observing a store:

- Every change adds a line to the trace with the top-level keys that changed. Values are reduced before they are recorded: an object becomes its number of keys and an array its length, so secrets and payloads never land in the trace.
- `lynkeus call stores '{"name":"session"}'` reads the store's state. The state is cut to four levels deep and 50 items per array, and functions are left out.

:::tip
Call `qa.observe` before your app subscribes to the store itself. Stores notify listeners in the order they subscribed and stop at the first one that throws, so an app listener that fails would otherwise hide the change from the trace.
:::

### `qa.event(name, props, route)`

Records an analytics event. Call it from wherever your app reports to its analytics.

```ts
export const track = (name: string, props?: Record<string, unknown>) => {
  analytics.track(name, props);
  qa.event(name, props);
};
```

| Parameter | Type | Meaning |
|---|---|---|
| `name` | string | The event's name. |
| `props` | object | Optional. The event's properties. |
| `route` | string | Optional. The route the event belongs to. |

The event goes into the trace and into a buffer of the last 500 events. Tests read the buffer with `app.event` steps, and `lynkeus call events` prints it. See [Analytics events](/guides/analytics-events/).

An app that already keeps its own buffer of events can register an `events` command that returns it, in place of calling `qa.event`.

### `qa.setNavigation(adapter)`

Remembers a navigation adapter. `<Lynkeus>` calls it for you; an app does not need to.

## Navigation adapters

A **navigation adapter** tells the agent how to read and drive your router. Routes in `lynkeus screen`, `lynkeus wait <Route>`, `lynkeus nav` and `lynkeus back` all go through it. Without an adapter the agent still reads the screen and touches it, but there are no routes.

### `reactNavigationAdapter(ref)`

The adapter for React Navigation. Pass it the ref of your `NavigationContainer`.

```tsx
const ref = useNavigationContainerRef();
<Lynkeus navigation={reactNavigationAdapter(ref)} />
```

`auto()` builds this adapter by itself. In an Expo app that uses expo-router, `auto()` recognizes the router's routes too.

### `noNavigation`

The adapter used when you pass none. It reports no route, and `navigate` and `back` fail with `No navigation adapter configured`.

### Writing an adapter

For another router, pass an object with this shape:

```ts
type NavigationAdapter = {
  isReady(): boolean;
  currentRoute(): { name: string; params?: unknown } | undefined;
  path(): string[];
  navigate(name: string, params?: object): void;
  canGoBack(): boolean;
  goBack(): void;
  resetToRoot?(): void;
  resetTo?(name: string, params?: object): void;
  subscribe(listener: () => void): () => void;
};
```

| Member | Meaning |
|---|---|
| `isReady()` | Whether the router can answer yet. |
| `currentRoute()` | The focused route and its params, or `undefined`. |
| `path()` | Route names from the root navigator down to the focused screen. |
| `navigate(name, params)` | Go to a route. `lynkeus nav` calls it. |
| `canGoBack()`, `goBack()` | `lynkeus back` calls them. |
| `resetToRoot()` | Optional. Go back to the initial route. Called on `reset`, so that a host that does not relaunch the app starts each test clean. |
| `resetTo(name, params)` | Optional. Replace the whole stack with one route, as an app does after login. |
| `subscribe(listener)` | Call `listener` whenever the focused route may have changed. Return an unsubscribe function. |

## What the agent keeps in memory

The agent records three things as the app runs, each in a buffer that drops its oldest entry when full.

| Buffer | Size | Holds |
|---|---|---|
| Trace | 500 entries | Routes, requests, store changes, analytics events, commands, touches. |
| Requests | 200 entries | Method, URL, status and duration of each HTTP request. |
| Events | 500 entries | What `qa.event` recorded. |

Requests are recorded without headers and without bodies, and sensitive query values are redacted. See [Security](/security/).

## Other exports

These exist for people who host the app themselves or write tooling on top of the agent. An app does not need them.

| Export | From | Purpose |
|---|---|---|
| `start(options)` | `lynkeus-agent` | Starts the connection without a component. Returns a stop function. |
| `host` | `lynkeus-agent` | For whatever speaks for the app instead of the agent's own connection, such as the headless host: claim the connection, hook into `reset`. |
| `createHandlers`, `dispatch` | `lynkeus-agent` | The handlers behind each protocol method. |
| `traceRecord` | `lynkeus-agent` | Adds an entry to the trace. |
| `PROTOCOL_VERSION` | `lynkeus-agent` | The protocol version the agent speaks. |
| `autoWrapper()` | `lynkeus-agent/auto` | The root component `auto()` installed, if any. |

The package also exports the protocol's TypeScript types: `Screen`, `Element`, `Target`, `HelloEvent` and the rest. They are described in the [Protocol reference](/reference/protocol/).
