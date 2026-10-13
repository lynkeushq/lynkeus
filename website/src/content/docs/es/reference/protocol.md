---
title: Protocolo
description: Los mensajes que intercambian la app y su driver, para quien quiera escribir un driver propio.
---

Todo lo que hace el CLI de lynkeus lo hace enviando mensajes JSON a la app por un WebSocket. Ese intercambio es el **protocolo**, y esta página lo documenta completo: la conexión, la autenticación, cada método y la forma de cada respuesta.

La necesitas si quieres manejar la app desde algo que no sea el CLI: un runner de tests propio, una herramienta en otro lenguaje, un arnés para un modelo de IA. Si escribes en Node, antes de implementar el protocolo mira [`AgentServer`](#el-driver-de-referencia-agentserver), que ya lo hace.

La versión actual del protocolo es la `1`.

## Quién se conecta a quién

Hay dos extremos. La **app**, con el agente adentro, y el **driver**, que es cualquier proceso capaz de sostener un socket.

El detalle que más sorprende es la dirección de la conexión: **la app es el cliente**. El driver abre un servidor WebSocket y espera; la app lo busca y se conecta. Dentro de la app no escucha nada.

| | Valor por defecto |
|---|---|
| Dirección a la que se conecta la app en iOS | `ws://localhost:8123` |
| Dirección a la que se conecta la app en el emulador de Android | `ws://10.0.2.2:8123` |

`10.0.2.2` es la dirección con la que el emulador de Android llega a la máquina que lo aloja. El host y el puerto se cambian con las opciones `host` y `port` al [montar el agente](/es/reference/agent-api/).

Mientras nadie escucha, la app reintenta en silencio. Durante los primeros 3 segundos después de arrancar, o de perder una conexión, lo intenta cada 100 ms. Después duplica la espera en cada intento, hasta un máximo de 1,5 segundos. Para un driver esto significa que no hay un orden de arranque obligatorio: puede empezar a escuchar antes o después que la app. El máximo se cambia con la opción `reconnectMs` del agente.

Hay un caso en que la app no se conecta nunca: cuando se montó con un token y el valor le llegó vacío. El agente queda apagado y la app lo dice en su log; no pasa a atender sin token. Para el driver se ve como una app que no está.

## El saludo

El saludo tiene un orden fijo: el driver habla primero, con `auth`, y la app le contesta con `hello`. En un socket nuevo, `auth` es siempre el primer mensaje.

**Driver → app: `auth`**

```json
{ "event": "auth", "session": "k3j9x0m1lq8z", "token": "…" }
```

| Campo | Qué es |
|---|---|
| `session` | Un texto al azar, distinto para cada proceso del driver. La app lo usa para distinguir una reconexión del mismo driver de un driver nuevo. |
| `token` | El secreto compartido. Va cuando el driver tiene uno. |

El driver tiene que enviar `auth` siempre, aunque no haya token. La app espera ese mensaje para presentarse: no envía `hello` por su cuenta al conectarse.

Una app montada con un token contesta cada petición con el error `unauthenticated` hasta que llega un `auth` con el mismo valor.

**App → driver: `hello`**

Si el token coincide, o si la app no tiene token, responde:

```json
{
  "event": "hello",
  "protocolVersion": 1,
  "agentVersion": "0.3.0",
  "platform": "ios",
  "native": true,
  "commands": ["busy", "events", "profile", "reset", "stores", "traceContext"],
  "route": "Settings.Main",
  "app": { "name": "example" }
}
```

| Campo | Qué es |
|---|---|
| `protocolVersion` | La versión del protocolo que habla la app. |
| `agentVersion` | La versión de `lynkeus-agent` en la app. Los agentes anteriores a este campo no lo envían. |
| `platform` | `ios`, `android` u otro texto. |
| `native` | `true` si los toques son toques reales sintetizados. Solo ocurre en builds de depuración, sobre un simulador o un emulador. |
| `commands` | Los comandos de la app: los que registró con `qa.register` y los que el agente trae. El driver puede llamarlos como cualquier método. Un host que puede filmar nombra aquí su comando `record`; es lo que mira `case run --video`. |
| `route` | La ruta actual, si hay un adaptador de navegación. |
| `app` | Lo que la app quiso decir de sí misma. Un host sin pantalla envía aquí `"runtime": "headless"`. |

Si el token no coincide, la app no envía `hello`. Cualquier petición que llegue antes de una autenticación correcta recibe este error:

```json
{ "id": 1, "error": { "message": "Not authenticated", "code": "unauthenticated" } }
```

**App → driver: `navigation`**

Después del saludo, la app avisa cada vez que la ruta con foco pudo haber cambiado:

```json
{ "event": "navigation", "route": "Auth.Login" }
```

Es el único mensaje que la app envía sin que se lo pidan.

## Peticiones y respuestas

A partir del saludo, el driver pide y la app responde. Cada petición lleva un `id` que el driver elige, y la respuesta lo repite.

```json
{ "id": 7, "method": "press", "params": { "testId": "next-button" } }
```

```json
{ "id": 7, "result": { "x": 201, "y": 812, "mode": "native", "element": { } } }
```

Cuando algo sale mal, en lugar de `result` llega `error`:

```json
{ "id": 8, "error": { "message": "No element matches {\"testId\":\"nope\"}" } }
```

Puede haber varias peticiones en curso a la vez. La app responde cada una cuando termina su trabajo, así que las respuestas pueden llegar en otro orden; el `id` es lo que las empareja.

### Reconexiones

Una pulsación no se puede repetir sin consecuencias. Por eso, si la conexión se corta con peticiones en curso, el driver las reenvía tal cual al reconectar, con el mismo `session` y el mismo `id`. Si la app ya había ejecutado una y solo se perdió la respuesta, contesta con la respuesta guardada en lugar de ejecutarla de nuevo. Guarda las últimas 64.

Un `session` distinto le indica a la app que es otro driver, que numera sus peticiones desde 1, y descarta lo guardado.

## Objetivos

Casi todos los métodos reciben un **objetivo**: el elemento sobre el que actúan.

```ts
type Scope = { testId: string } | { text: string };

type Target =
  | { testId: string; nth?: number; within?: Scope }
  | { text: string; nth?: number; within?: Scope }
  | { i: number }
  | { x: number; y: number };
```

| Forma | Qué encuentra |
|---|---|
| `{ testId }` | El elemento con ese `testID`. |
| `{ text }` | Un elemento por su texto o su etiqueta de accesibilidad, según las reglas de abajo. |
| `{ i }` | El elemento con ese índice en el orden del árbol. |
| `{ x, y }` | Un punto de la ventana, en puntos. No corresponde a ningún elemento. |

**Cómo coincide el texto.** La comparación no distingue mayúsculas e ignora los espacios de los extremos. Un control (botón o campo) coincide primero por etiqueta exacta y después por contener el texto. Un párrafo coincide solo por texto exacto: un fragmento dentro de un texto corrido nunca es un objetivo, porque un toque en su centro caería sobre la palabra o el enlace que haya ahí.

**Cómo se desempata.** Los elementos alcanzables ganan sobre los tapados; uno tapado se devuelve solo cuando nada alcanzable coincide. Entre iguales gana el último en el orden del árbol, porque es el que se dibuja encima. Los elementos ocultos no coinciden nunca, salvo los de motivo `inert`.

**`nth`** elige la coincidencia número `nth`, contando desde 0.

**`within`** acota la búsqueda a un ámbito. Se toma el elemento que nombra el ámbito y se busca dentro de él; si no hay coincidencias, se sube a su contenedor, y así hasta la raíz. En el primer contenedor que tenga alguna coincidencia gana la más cercana al ámbito en el orden del árbol. Es la manera de decir cuál de los cinco botones "me gusta" de una lista quieres: el que comparte fila con cierto texto.

## Métodos

| Método | Parámetros | Resultado |
|---|---|---|
| `ping` | ninguno | `{ pong: true, native, commands }` |
| `screen` | ninguno | [`Screen`](#screen) |
| `find` | `Target` | [`Element`](#element) o `null` |
| `press` | `Target & { holdMs?, mode? }` | `{ x, y, element?, mode }` |
| `type` | `{ text, target?, clear?, paste?, submit? }` | `{ typed, element? }` |
| `swipe` | `{ direction?, target?, distance?, from?, to?, durationMs? }` | `{ from, to }` |
| `navigate` | `{ name, params? }` | `{ route }` |
| `back` | ninguno | `{ route? }` |
| `waitFor` | `{ route?, target?, anyOf?, gone?, scroll?, timeoutMs? }` | `{ route?, matched?, waitedMs }` |
| `idle` | `{ quietMs?, timeoutMs?, after? }` | `{ commit, idle }` |
| `deepLink` | `{ url }` | `{ opened }` |
| `requests` | `{ since? }` | `{ inFlight, requests }` |
| `trace` | `{ since? }` | `{ last, events }` |
| `dismissKeyboard` | ninguno | `true` |
| `batch` | `{ calls: [{ method, params? }] }` | `{ results }` |
| `debug` | libre | Lo que ve el recorredor del árbol. Para diagnóstico. |
| *comando de la app* | lo que defina la app | Lo que haya devuelto la función registrada con `qa.register`. |

Un método que no es ninguno de estos ni un comando de la app responde con el error `Unknown method <nombre>`.

### `press`

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `holdMs` | `50` | Cuánto queda el dedo apoyado. Unos 600 ms son una pulsación larga. |
| `mode` | `native` | `native` sintetiza un toque. `js` llama al `onPress` del elemento directamente. |

En modo `native`, la app hace varias cosas antes de tocar:

1. Si el elemento está fuera de la ventana, se desplaza hasta traerlo. Solo en un dispositivo; en un host sin pantalla hay que pedirlo con `waitFor` y `scroll`.
2. Espera a que el elemento deje de moverse: dos mediciones iguales con 40 ms de diferencia, durante 600 ms como máximo.
3. Si el teclado está abierto y el objetivo no es un campo, lo cierra y vuelve a medir. Con el teclado arriba, un toque fuera del campo solo lo cerraría.
4. Apoya el dedo durante `holdMs`.

Un elemento que no se está presentando no se puede pulsar. El error es `<objetivo> is not presented (<motivo>)`.

En modo `js` no hay toque, ni gesto, ni espera. Aun así se niega a actuar sobre un control deshabilitado (`… is disabled`) o tapado (`… is covered`); de lo contrario, las barreras de la propia interfaz no significarían nada. Úsalo cuando te interesa el resultado y no el gesto.

### `type`

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `text` | obligatorio | Lo que se escribe. |
| `target` | el campo con foco | Se toca primero, para darle el foco. |
| `clear` | `false` | Borra el contenido actual antes de escribir. |
| `paste` | `false` | Inserta todo de una vez. |
| `submit` | `false` | Termina con la tecla de retorno. |

El texto pasa por la entrada de teclado de la plataforma, así que los formateadores y `onChange` se comportan como con un teclado real. Sin `paste`, las teclas van de a una, con 25 ms entre ellas: un campo controlado formatea en cada cambio, y teclas más rápidas que un commit le ganarían la carrera al formateador.

### `swipe`

Tiene tres formas:

| Forma | Qué hace |
|---|---|
| `{ direction }` | Un arrastre por el centro de la ventana. `up` y `down` recorren del 70 % al 30 % del alto; `left` y `right`, del 80 % al 20 % del ancho. |
| `{ target, direction?, distance? }` | Un arrastre que empieza en el centro del elemento. `direction` vale `up` por defecto, y `distance`, el 60 % de la ventana en esa dirección. |
| `{ from, to }` | Un arrastre entre dos puntos, cada uno `{ x, y }`. |

`durationMs` vale `250` por defecto. Sobre un elemento, el arrastre entero se corre hacia adentro de la ventana si hiciera falta, porque un toque que sale de la ventana se cancela.

### `waitFor`

Espera hasta que se cumplan a la vez todas las condiciones dadas.

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `route` | ninguno | La ruta actual es esta. |
| `target` | ninguno | El objetivo está en pantalla. |
| `anyOf` | ninguno | Una lista de objetivos: alcanza con que aparezca cualquiera. El resultado dice cuál en `matched`. |
| `gone` | `false` | Invierte la condición de `target`: espera a que no esté. |
| `scroll` | `false` | Desplaza el contenedor más cercano hacia el objetivo hasta que esté dentro de la ventana. |
| `timeoutMs` | `5000` | Cuánto esperar. |

La app revisa cada 40 ms y responde en el instante en que la condición se cumple. Si se agota el tiempo, el error es `Timed out waiting for <ruta> <objetivo> (on <ruta actual>)`.

### `idle`

Espera a que la app se aquiete: que pase un tiempo sin commits de React y sin peticiones en curso.

| Parámetro | Por defecto | Qué hace |
|---|---|---|
| `quietMs` | `150` | Cuánto tiempo sin actividad cuenta como quieto. |
| `timeoutMs` | `3000` | Cuánto esperar. |
| `after` | ninguno | Un número de commits anterior. La quietud solo cuenta una vez que la app lo superó. |

`idle` nunca falla. Si se agota el tiempo responde `{ idle: false }`. Una pantalla con un reloj nunca se aquieta, y eso es información, no un error.

`after` resuelve una ambigüedad: una pantalla que todavía no empezó a cargar está tan quieta como una que ya terminó. Guarda el `commit` de una lectura anterior a tu acción y pásalo aquí.

:::note
Estos son los valores por defecto del protocolo. El CLI envía los suyos: `lynkeus wait` espera 10 segundos, y `lynkeus idle` usa 300 ms de quietud y 5 segundos de espera.
:::

### `navigate` y `back`

`navigate` salta a una ruta por su nombre. `back` vuelve atrás, y si no hay adónde, responde con el error `Nothing to go back to`. Los dos necesitan un adaptador de navegación; sin él, el error es `No navigation adapter configured`.

### `requests` y `trace`

`requests` devuelve las peticiones HTTP que hizo la app, y `trace`, la línea de tiempo completa. Los dos aceptan `since` para pedir solo lo nuevo: en `requests` es el `id` de la última petición que ya viste, y en `trace`, el número de secuencia que vino en `last`.

Sus formas están más abajo, en [`RequestRecord`](#requestrecord) y [`TraceEvent`](#traceevent).

### `batch`

Ejecuta varias llamadas en un solo viaje de ida y vuelta, en orden. Se detiene en el primer error.

```json
{ "id": 12, "method": "batch", "params": { "calls": [
  { "method": "press", "params": { "testId": "next-button" } },
  { "method": "waitFor", "params": { "route": "Settings.Main" } },
  { "method": "screen" }
] } }
```

### Comandos de la app y `reset`

Cualquier nombre que figure en `commands` se llama como un método más. Los parámetros y el resultado son los que defina la app.

`reset` tiene un trato especial. La app ejecuta primero la función que registró, si registró alguna. Después el agente agrega lo que solo él alcanza: reinicia el estado nativo simulado del host y devuelve la navegación a su ruta inicial.

## Tipos

### `Screen`

```ts
type Screen = {
  route?: string;       // la ruta con foco, si hay adaptador de navegación
  params?: unknown;     // sus parámetros
  path: string[];       // del navegador raíz a la pantalla con foco
  elements: Element[];  // en el orden del árbol: lo posterior se dibuja encima
  commit: number;       // commits de React desde que arrancó el agente
  busy: boolean;        // hay peticiones en curso, o el comando `busy` de la app dijo que sí
  window: { w: number; h: number };  // en puntos
  presenting?: { i: number; modal: boolean; testId?: string };  // la capa de arriba, si hay una
  costMs: number;       // lo que tardó la app en armar esta lectura
};
```

`commit` cambia cada vez que la interfaz se vuelve a renderizar. Comparar dos lecturas dice si pasó algo entre ellas.

### `Element`

```ts
type Element = {
  i: number;            // índice en el orden del árbol
  kind: 'button' | 'input' | 'text' | 'scroll' | 'switch' | 'image' | 'view';
  frame: { x: number; y: number; w: number; h: number };  // en puntos de ventana, con las transformaciones aplicadas
  enabled: boolean;
  depth: number;        // nivel de anidamiento entre los elementos listados
  testId?: string;
  text?: string;        // el texto renderizado, o la etiqueta de un control
  accessibilityLabel?: string;
  value?: string;       // en campos; enmascarado con • si es secureTextEntry
  placeholder?: string;
  focused?: boolean;
  parent?: number;      // índice del ancestro listado más cercano
  tag?: number;         // el tag nativo de React
  covered?: boolean;    // un toque en su centro no lo alcanzaría
  hidden?: 'a11y' | 'inert' | 'behind-modal' | 'behind-overlay';
  offscreen?: boolean;  // su rectángulo queda fuera de la ventana
};
```

### De dónde sale `value`

El `value` de un campo es lo que contiene el campo nativo. Por eso refleja lo que se escribió aunque la app no controle el campo con una propiedad `value`, o aunque le haya dado un `defaultValue`.

Desde la versión 0.3.0 lo responde el módulo nativo, y la app tiene que recompilarse para tenerlo. En una app compilada antes, el agente lee el valor de las propiedades de React, como hacía hasta entonces: un campo no controlado se lee vacío después de escribir, y uno con `defaultValue` sigue mostrando ese valor.

### `covered` y `hidden` no son lo mismo

Los dos dicen que un elemento no se puede tocar, pero por razones distintas, y la diferencia importa al diagnosticar.

**`covered`** significa "un dedo caería sobre otra cosa". Sale de una prueba de toque nativa en el centro del elemento, cuando el módulo nativo está disponible. Solo cuenta aquello en lo que un toque se detendría. En Android, desde la versión 0.3.0, la respuesta viene de la búsqueda con la que React Native decide el destino de un toque; antes, la capa invisible de depuración de un build de desarrollo hacía que todos los controles se leyeran cubiertos. Requiere recompilar la app después de actualizar `lynkeus-agent`.

**`hidden`** significa "esto no está en pantalla". El elemento está montado, pero la app no lo presenta. Es la respuesta más fuerte de las dos, y dice el motivo:

| Motivo | Qué significa |
|---|---|
| `a11y` | Está oculto para las tecnologías de asistencia. |
| `inert` | Él o un ancestro tiene `pointerEvents: 'none'`: ningún toque lo alcanza. |
| `behind-modal` | Está fuera del subárbol que se declaró modal. |
| `behind-overlay` | Está fuera de la última capa a ventana completa que la app montó en su raíz. |

`hidden` se lee de la estructura del árbol (`display: 'none'`, `aria-hidden`, `accessibilityViewIsModal`, una vista absoluta a ventana completa montada en la raíz), no de la geometría. Por eso un host sin pantalla responde lo mismo que un dispositivo.

Una app tiene montado mucho más de lo que muestra: las otras pestañas, la pantalla que quedó debajo de una hoja. `hidden` es lo que separa la pantalla del árbol. Cuando hay una capa encima, `Screen.presenting` dice cuál es.

`press` rechaza un elemento oculto. `find` y `waitFor` sí encuentran uno `inert`, porque una etiqueta dentro de un botón se puede leer aunque ningún toque le llegue.

### `RequestRecord`

```ts
type RequestRecord = {
  id: number;        // crece con cada petición; sirve para `since`
  method: string;
  url: string;       // con los valores sensibles de la consulta ocultos
  status?: number;   // ausente mientras está en curso; 0 si falló la red
  startedAt: number;
  ms?: number;
  error?: string;
};
```

Nunca incluye cabeceras ni cuerpos. En la URL se ocultan los valores de los parámetros de consulta cuyo nombre contiene `token`, `key`, `secret`, `code`, `otp`, `password`, `pin`, `session` o `auth`.

### `TraceEvent`

Cada entrada de la traza tiene un número de secuencia `seq`, un instante `t` y un tipo `kind`:

| `kind` | Campos | Qué registra |
|---|---|---|
| `route` | `route?`, `path` | Un cambio de ruta. |
| `request` | `method`, `url`, `status?`, `ms?`, `error?` | Una petición que terminó. |
| `store` | `store`, `changed` | Un cambio en un store observado con `qa.observe`: por cada clave de primer nivel que cambió, `{ from, to }`. Los valores van en forma corta: un objeto como su tamaño (`{3}`), una lista como su largo (`[12]`), un texto de más de 80 caracteres cortado, y el valor de una clave con nombre de secreto (`token`, `password`, `session`…) como `…`. |
| `event` | `name`, `props?`, `route?` | Un evento de analítica informado con `qa.event`. |
| `command` | `method`, `ms`, `error?` | Un método que ejecutó el driver. Las lecturas (`screen`, `find`, `trace`, `requests`, `ping`, `idle`, `waitFor`) no se anotan, salvo cuando fallan. |
| `touch` | `x`, `y`, `testId?`, `text?`, `route?` | El dedo de una persona, resuelto al control que había debajo. Solo en builds de dispositivo montados con `auto()`. |
| `stall` | `renders`, `windowMs`, `component?` | El host cortó un ciclo de renders sin fin. |
| `crash` | `message`, `stack?`, `route?` | Algo lanzó un error que nadie atrapó. |

La app guarda las últimas 500 entradas.

## Un driver mínimo

Este ejemplo, en Node con el paquete `ws`, contiene todo lo que un driver necesita: escuchar, autenticarse, esperar el saludo y emparejar respuestas con peticiones.

```js title="driver.mjs"
import { WebSocketServer } from 'ws';

const server = new WebSocketServer({ host: '127.0.0.1', port: 8123 });
const session = Math.random().toString(36).slice(2);
const pending = new Map();
let nextId = 1;

server.on('connection', (socket) => {
  // El driver habla primero, haya token o no
  socket.send(JSON.stringify({ event: 'auth', session, token: process.env.LYNKEUS_TOKEN }));

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  socket.on('message', async (data) => {
    const message = JSON.parse(String(data));

    if (message.event === 'hello') {
      const screen = await call('screen');
      console.log(screen.route, `${screen.elements.length} elementos`);
      return;
    }
    if (message.event) return; // `navigation`

    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiting?.reject(new Error(message.error.message));
    else waiting?.resolve(message.result);
  });
});
```

Con la app corriendo y `LYNKEUS_TOKEN` definida, `node driver.mjs` imprime la ruta actual y la cantidad de elementos.

A un driver real le falta manejar dos cosas más: un tiempo límite por petición, y el reenvío de las peticiones en curso cuando la app se reconecta.

## El driver de referencia: `AgentServer`

El paquete `lynkeus-client` trae un driver completo para Node. Es el que usa el CLI.

```ts
import { AgentServer } from 'lynkeus-client';

const server = new AgentServer({ port: 8123, token: process.env.LYNKEUS_TOKEN });
await server.listen();
await server.waitForApp(); // la app se conecta al arrancar

await server.call('press', { testId: 'get-started-button' });
const screen = await server.call('screen');
```

| Opción | Por defecto | Qué es |
|---|---|---|
| `port` | `8123` | El puerto donde escucha. |
| `host` | `127.0.0.1` | La interfaz donde escucha. |
| `token` | ninguno | Tiene que coincidir con el `token` de la app. |

| Método | Qué hace |
|---|---|
| `listen()` | Abre el servidor. Si el puerto está ocupado, falla con un error de código `port-in-use`. |
| `waitForApp(timeoutMs = 15000)` | Espera el `hello` de la app y lo devuelve. |
| `call(method, params?, timeoutMs = 20000)` | Envía una petición y devuelve su resultado. Si no llega respuesta a tiempo, falla con un error de código `timeout`. |

Los tipos de esta página (`Screen`, `Element`, `Target`, `CoreMethods` y los demás) están en el paquete `lynkeus-protocol`.

## El archivo de una ejecución

`lynkeus-protocol` define también un segundo contrato, que no viaja por el socket: el directorio que escribe `lynkeus case run --out`. Lo forman `run.json` y `cases.jsonl`, con los tipos `RunManifest`, `RunCase`, `RunStep` y `RunEvent`.

Si escribes algo que lee ese directorio, como un tablero o un script, ten en cuenta dos reglas. A un campo existente nunca se le cambia el significado: solo se agregan campos. Y un cambio que sí altere un significado sube el número `schema` de `run.json` (hoy `1`); un lector debe rechazar un `schema` que no conoce.

`run.json` se escribe al empezar la ejecución y otra vez al terminar. Una ejecución que se cortó a la mitad no tiene `finishedAt` ni `totals`.

La guía de [Reportes](/es/guides/reports/) describe el contenido del directorio.
