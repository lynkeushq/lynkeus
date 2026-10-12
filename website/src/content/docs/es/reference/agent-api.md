---
title: API del agente
description: Lo que exporta lynkeus-agent para montar el agente en tu app y ampliarlo con comandos, stores y eventos.
---

El **agente** es el código de `lynkeus-agent` que va dentro de tu app. En un build de depuración abre una conexión hacia el driver y responde lo que este le pide: qué hay en pantalla, pulsa esto, escribe aquello. Esta página describe todo lo que el paquete exporta para que lo montes y lo amplíes.

Hay dos formas de montarlo, `auto()` y el componente `<Lynkeus>`, y un objeto `qa` con el que tu app le agrega comandos propios, le muestra sus stores y le informa sus eventos de analítica. Si todavía no instalaste el agente, empieza por la [instalación en React Native](/es/getting-started/installation-react-native/) o en [Expo](/es/getting-started/installation-expo/).

## Qué se importa de dónde

| Importación | Qué trae |
|---|---|
| `lynkeus-agent/auto` | `auto`, la forma de montar el agente con una línea. |
| `lynkeus-agent` | `Lynkeus`, `qa`, `reactNavigationAdapter`, `noNavigation` y los tipos. |

```ts
import { auto } from 'lynkeus-agent/auto';
import { Lynkeus, qa, reactNavigationAdapter } from 'lynkeus-agent';
```

## `auto(options)`

`auto()` monta el agente desde el archivo de entrada de la app, sin tocar ningún componente. Es la forma recomendada cuando usas React Navigation.

```js title="index.js"
import { AppRegistry } from 'react-native';
import { auto } from 'lynkeus-agent/auto';
import App from './App';

// Antes de registerComponent
auto({ token: process.env.LYNKEUS_TOKEN });

AppRegistry.registerComponent('myapp', () => App);
```

Tiene que llamarse antes de `AppRegistry.registerComponent`, porque funciona envolviendo el componente raíz a través de `AppRegistry`. Hace cuatro cosas:

1. Envuelve la raíz de la app. Si otra biblioteca ya había instalado un envoltorio, lo conserva.
2. Busca por su cuenta el contenedor de React Navigation, así que no hay que pasarle ninguna `ref`. Lo intenta cada 250 ms durante 20 segundos.
3. Registra en la traza cada toque de una persona, resuelto al control que había bajo el dedo. Es lo que usa `lynkeus record`.
4. Rodea la app con un `Profiler` de React, que alimenta a `lynkeus profile`. No guarda nada hasta que se lo pides.

Una segunda llamada a `auto()` no hace nada. Con `enabled` en `false`, tampoco.

### Opciones

`auto()` acepta las mismas opciones que `<Lynkeus>`, salvo `navigation`, y una más:

| Opción | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `discoverEveryMs` | número (ms) | `250` | Cada cuánto busca el contenedor de navegación hasta encontrarlo. Deja de buscar a los 20 segundos. |

Las demás están en la tabla de [props de `<Lynkeus>`](#props).

## `<Lynkeus>`

El componente monta el agente de forma explícita. Úsalo cuando quieras pasarle un adaptador de navegación propio, porque tu app no usa React Navigation.

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

Se monta una sola vez, en cualquier lugar bajo el contenedor de navegación. No renderiza nada.

### Props

| Prop | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `enabled` | booleano | `__DEV__` | Si el agente corre o no. |
| `navigation` | `NavigationAdapter` | ninguno | Cómo lee y maneja el agente tu navegación. Sin adaptador hay pantalla, toques y esperas, pero no rutas. |
| `token` | texto | ninguno | El secreto compartido con el driver. Si lo defines, el agente solo atiende al driver que lo presenta. |
| `host` | texto | `localhost`; `10.0.2.2` en Android | Dónde escucha el driver. |
| `port` | número | `8123` | El puerto del driver. |
| `app` | objeto | ninguno | Una descripción libre de la app (nombre, versión, entorno). Se envía al driver al conectarse y `lynkeus hello` la muestra. |
| `reconnectMs` | número (ms) | `1500` | La espera más larga entre dos intentos de conexión. |
| `onError` | `(error, context) => void` | ninguno | Recibe los errores que ocurren dentro del agente. Por defecto, la app no los muestra. |
| `backend` | `Backend` | el de dispositivo | Dónde corre la app y cómo se la toca. Lo usan los hosts; una app no lo necesita. |
| `createSocket` | `(url) => Socket` | el `WebSocket` global | Cómo se abre la conexión. Lo usan los hosts; una app no lo necesita. |

Las opciones se leen una sola vez, al montar. Cambiarlas en un render posterior no reconecta, porque reconectar en cada render le cortaría la conexión al driver. Solo un cambio en `enabled` o en `navigation` reinicia el agente.

:::caution
`enabled` vale `__DEV__` por defecto, y eso alcanza para que el agente no corra en un build de producción. No alcanza para un build de depuración que apunta a tu backend real, con cuentas reales. Condiciónalo también a tu entorno: `enabled={__DEV__ && config.ENV !== 'prod'}`. La página de [Seguridad](/es/security/) explica por qué.
:::

### Cómo se conecta

El agente es quien llama: abre un WebSocket hacia `ws://<host>:<port>` y, si nadie escucha, reintenta en silencio. Durante los primeros 3 segundos después de arrancar o de perder la conexión reintenta cada 100 ms; después duplica la espera en cada intento, hasta el tope de `reconnectMs`.

Cuando un driver se conecta, el agente silencia `LogBox`, para que sus avisos no tapen la pantalla durante una sesión automatizada.

### Montar los dos a la vez

Una app que llama a `auto()` y además renderiza `<Lynkeus>` sigue funcionando. El primero que arranca se queda con la conexión y el segundo no abre ninguna.

## `qa`

`qa` es lo que tu app le agrega al agente. Todo lo que registres con él queda disponible para quien maneje la app.

### `qa.register(name, fn)`

Registra un **comando de la app**: una función que solo tu app puede ejecutar y que un test necesita.

```ts
import { qa } from 'lynkeus-agent';

qa.register('reset', async () => {
  await session.logout();
  await cache.clear();
});
qa.register('busy', () => queryClient.isFetching() > 0);
qa.register('setFlag', ({ name, on }) => flags.override(name, on));
```

| Parámetro | Tipo | Qué es |
|---|---|---|
| `name` | texto | El nombre del comando. Empieza con una letra y sigue con letras, dígitos, `_`, `.` o `-`. Otro nombre lanza `Invalid command name`. |
| `fn` | `(params) => valor \| Promise<valor>` | Lo que hace. Recibe los parámetros que envió el driver y lo que devuelve es la respuesta. |

Devuelve una función que quita el registro. Registrar dos veces el mismo nombre reemplaza al anterior.

Desde la terminal el comando se ejecuta con `lynkeus call <name> '<json>'`, y desde un caso con `app.call`. `lynkeus hello` lista los comandos registrados.

```bash
npx lynkeus call setFlag '{"name":"new-checkout","on":true}'
```

Registra los comandos al cargar el módulo, fuera de cualquier componente, para que existan antes de que el driver se conecte. El agente informa la lista de comandos en el momento de la conexión.

#### Dos nombres con significado propio

Cualquier nombre sirve, pero hay dos que los drivers buscan por convención:

| Comando | Qué debe hacer | Quién lo usa |
|---|---|---|
| `reset` | Dejar la app como recién instalada: cerrar la sesión, vaciar el almacenamiento y las cachés. | Un driver lo llama antes de cada test, y `lynkeus launch --clean` también. Una caché de consultas que quedó de un test anterior es la causa más común de fallos entre tests. |
| `busy` | Devolver `true` mientras la capa de datos de la app tiene trabajo en curso. | El agente lo consulta para decidir si la pantalla está ocupada. Permite esperar datos en lugar de esperar un tiempo fijo. |

`reset` recibe un trato especial. Después de ejecutar tu función, el agente hace lo que solo él puede hacer: reinicia el estado nativo simulado del host, si lo hay, y devuelve la navegación a su ruta inicial. Por eso `reset` funciona aunque tu app no lo registre; en ese caso solo ocurre la segunda parte.

`busy` se suma a lo que el agente ya sabe. Con una petición HTTP en curso la pantalla ya cuenta como ocupada, registres `busy` o no.

#### Comandos que ya vienen

El agente responde cuatro comandos sin que registres nada. Si registras uno con el mismo nombre, el tuyo reemplaza al que viene.

| Comando | Parámetros | Qué responde |
|---|---|---|
| `events` | `{ clear?: boolean }` | Los eventos informados con `qa.event`, del más viejo al más nuevo. Con `clear`, vacía el búfer después de leerlo. |
| `stores` | `{ name?: string }` | Sin `name`, los nombres de los stores observados. Con `name`, el estado de ese store. |
| `profile` | `{ action?: 'start' \| 'stop' }` | Lo que React pasó renderizando, por ruta. Es lo que usa `lynkeus profile`. |
| `traceContext` | `{ traceparent }` | Lo usa `case run --traces` para marcar las peticiones de cada paso. No hace falta llamarlo a mano. |

### `qa.unregister(name)`

Quita un comando registrado. Si había un comando por defecto con ese nombre, vuelve a responder ese.

### `qa.commands()`

Devuelve los nombres de todos los comandos disponibles, los registrados y los que vienen por defecto, en orden alfabético.

### `qa.observe(name, store)`

Le muestra un store al agente. Con eso, cuando un test falla, el reporte dice lo que la app creía en ese momento, no solo lo que dibujó.

```ts
qa.observe('session', useSessionStore);
```

| Parámetro | Tipo | Qué es |
|---|---|---|
| `name` | texto | El nombre con el que aparece en la traza y con el que se lee. |
| `store` | `{ getState(), subscribe(listener) }` | Cualquier objeto con esos dos métodos. Un store de Zustand o de Redux los tiene. |

Devuelve una función que deja de observarlo.

Observar un store tiene dos efectos:

- **En la traza.** Cada vez que el store cambia, la traza registra qué claves de primer nivel cambiaron. Los valores simples se anotan tal cual; los objetos y las listas se reducen a su tamaño, para que no lleguen cargas completas a la traza. Se ve con `lynkeus trace`.
- **En el comando `stores`.** `lynkeus call stores '{"name":"session"}'` devuelve el estado del store. Se recorta a cuatro niveles de profundidad y a 50 elementos por lista, y las funciones se omiten.

Llama a `qa.observe` antes de que tu app se suscriba al store. Un store avisa a sus suscriptores en el orden en que se suscribieron y se detiene en el primero que lanza un error. Si un suscriptor de tu app falla bajo un host, el cambio nunca llegaría a la traza.

:::caution
El estado de un store observado es legible para quien maneja la app, y los valores simples de primer nivel aparecen en la traza. No observes un store que guarda credenciales en claro si esa traza va a terminar en un reporte compartido.
:::

### `qa.event(name, props?, route?)`

Informa al agente un evento de analítica. Llámalo desde el mismo lugar donde tu app le informa a su SDK de analítica.

```ts
export const track = (name: string, props?: Record<string, unknown>) => {
  analytics.track(name, props);
  qa.event(name, props);
};
```

| Parámetro | Tipo | Qué es |
|---|---|---|
| `name` | texto | El nombre del evento. |
| `props` | objeto | Opcional. Sus propiedades. |
| `route` | texto | Opcional. La ruta en la que ocurrió. |

El evento queda en dos lugares: en la traza, y en un búfer que guarda los últimos 500. Ese búfer es el que leen `lynkeus events`, el comando `events` y los pasos `app.event` de un caso. La guía [Eventos de analítica](/es/guides/analytics-events/) muestra el recorrido completo.

Una app que ya lleva su propio búfer de eventos puede registrar un comando `events` propio, que reemplaza al que viene.

### `qa.setNavigation(adapter)`

Guarda el adaptador de navegación. `<Lynkeus>` lo llama por ti; no hace falta usarlo en una app.

## Adaptadores de navegación

Un **adaptador de navegación** le dice al agente cómo leer y manejar el router de tu app. De él salen el nombre de la ruta actual y el camino de navegadores que muestra `lynkeus screen`, y por él pasan `lynkeus nav` y `lynkeus back`.

Sin adaptador, el agente sigue leyendo y tocando la pantalla, pero no hay rutas: `lynkeus wait Settings.Main` no tiene qué esperar.

### `reactNavigationAdapter(ref)`

El adaptador para React Navigation. Recibe la `ref` del `NavigationContainer`.

```tsx
const ref = useNavigationContainerRef();
// …
<Lynkeus navigation={reactNavigationAdapter(ref)} />
```

Con `auto()` no hace falta: lo crea solo cuando encuentra el contenedor. Las rutas de expo-router también se reconocen de esta manera, sin configurar nada más.

El adaptador recuerda la ruta inicial la primera vez que el contenedor está listo. Una app suele reemplazar su pila después de iniciar sesión, y entonces la primera ruta de la pila ya no es la inicial; `reset` vuelve a la que se recordó.

### `noNavigation`

El adaptador para apps sin router. Es el que usa `<Lynkeus>` cuando no le pasas ninguno. No informa rutas, y `nav` y `back` fallan con `No navigation adapter configured`.

### Escribir un adaptador propio

Para otro router, implementa el tipo `NavigationAdapter`:

```ts
import type { NavigationAdapter } from 'lynkeus-agent';

export const myRouterAdapter = (router: MyRouter): NavigationAdapter => ({
  isReady: () => router.ready,
  currentRoute: () => ({ name: router.current.name, params: router.current.params }),
  path: () => router.stack.map((entry) => entry.name),
  navigate: (name, params) => router.push(name, params),
  canGoBack: () => router.stack.length > 1,
  goBack: () => router.pop(),
  resetToRoot: () => router.reset(),
  subscribe: (listener) => router.onChange(listener),
});
```

| Método | Obligatorio | Qué debe hacer |
|---|---|---|
| `isReady()` | sí | Devolver `true` cuando el router ya se puede usar. |
| `currentRoute()` | sí | Devolver `{ name, params? }` de la pantalla con foco, o `undefined` si todavía no hay ninguna. |
| `path()` | sí | Devolver los nombres de ruta desde el navegador raíz hasta la pantalla con foco. |
| `navigate(name, params?)` | sí | Ir a esa ruta. |
| `canGoBack()` | sí | Decir si hay adónde volver. |
| `goBack()` | sí | Volver. |
| `subscribe(listener)` | sí | Llamar a `listener` cada vez que la ruta con foco pudo haber cambiado. Devuelve una función que cancela la suscripción. |
| `resetToRoot()` | no | Volver a la ruta inicial. Se llama en `reset`, para que un host que no reabre la app empiece cada test desde el principio. |
| `resetTo(name, params?)` | no | Reemplazar toda la pila por una sola ruta, como hace una app después de iniciar sesión. |

## Lo que el agente guarda en memoria

El agente no escribe nada en disco. Guarda tres listas en memoria, y cada una descarta lo más viejo cuando se llena:

| Lista | Cuánto guarda | Qué contiene |
|---|---|---|
| Traza | 500 entradas | Rutas, peticiones, cambios de stores, eventos, comandos, toques y errores sin atrapar. |
| Peticiones | 200 | Método, URL, estado y duración. Nunca cabeceras ni cuerpos; los valores sensibles de la URL se ocultan. |
| Eventos | 500 | Lo que informaste con `qa.event`. |

## Otras exportaciones

El paquete exporta además piezas pensadas para quien escribe un host, no para una app:

| Exportación | Para qué |
|---|---|
| `host` | Lo usa quien habla por la app en lugar del agente, como el host sin pantalla o un test de jest. `host.claim()` hace que `<Lynkeus>` y `auto()` no abran conexión. |
| `start(options)` | Arranca el cliente a mano, con las mismas opciones que `<Lynkeus>`. Devuelve una función que lo detiene. |
| `createHandlers`, `dispatch` | Los métodos del protocolo, para servirlos desde otro transporte. |
| `traceRecord` | Agrega una entrada a la traza. |
| `PROTOCOL_VERSION` | La versión del protocolo que habla el agente. |

Los tipos del protocolo (`Screen`, `Element`, `Target` y los demás) también se exportan desde `lynkeus-agent`. Están descritos en [Protocolo](/es/reference/protocol/).
