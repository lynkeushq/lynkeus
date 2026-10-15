---
title: Sin pantalla (headless)
description: Cómo alojar la app en Node sin simulador, qué se gana y qué se pierde, cómo se prepara el host sin pantalla y qué controles reemplazan al sistema operativo.
---

El host sin pantalla (*headless*) ejecuta tu app en Node, sin simulador ni emulador y sin compilar nada nativo. Esta página explica cuándo conviene, cómo se prepara y qué no puede decirte.

La necesitas si quieres correr tu suite en CI sin una granja de dispositivos, o si quieres probar estados que un backend real no entrega con facilidad: un error 500, una respuesta lenta, una lista vacía.

## Qué es

`lynkeus headless start` escribe un test de Jest que nunca termina. Ese test importa tu app y la renderiza con React Native Testing Library. El agente que está dentro de la app se conecta al CLI igual que en un dispositivo, así que todos los comandos y todos los casos funcionan sin cambios.

La diferencia está en qué es real:

| | Simulador o emulador | Host sin pantalla |
|---|---|---|
| JavaScript de la app | real | real |
| Backend | el que configures | el que configures |
| Capa nativa | real | reemplazada por mocks |
| Diseño de la pantalla | el de la plataforma | calculado con Yoga |
| Píxeles | sí | no |

## Qué se gana y qué se pierde

**Se gana:** no hace falta simulador ni build; el host arranca en unos 40 segundos; se pueden levantar varios a la vez, uno por puerto; y la lectura de la pantalla y los toques son los mismos que en un dispositivo, con el diseño incluido.

**Se pierde:** todo lo nativo. La cámara, la biometría y las integraciones profundas con el sistema son mocks. Un WebView se renderiza como una caja vacía. Un fallo nativo aparece como un error de Jest.

Para lo que el host no cubre, los mismos casos corren en un simulador. Lo único que cambia es cómo arranca la app.

## Antes de empezar

- Node 22 o posterior.
- lynkeus instalado y el agente montado en la app ([Instalación en React Native](/es/getting-started/installation-react-native/)).
- El paquete `lynkeus-headless` instalado en el proyecto, junto con Jest y `@testing-library/react-native`. El host usa la configuración de Jest y la transformación de Babel de tu propia app.
- Un backend local al que la app pueda apuntar.
- Una app con un componente raíz que se pueda exportar, o una app con expo-router (desde 0.4.0; más abajo, [Lo que el host no puede decirte](#lo-que-el-host-no-puede-decirte)).

## Pasos

### 1. Genera el archivo de entrada

```bash
npx lynkeus headless init --auto
```

Esto escribe `qa/headless.tsx`, el archivo de entrada del host. Es el único lugar que conoce tu app: instala los mocks por defecto, comprueba que el backend sea local e importa tu componente `App`. Con `--auto` monta además el agente como lo hace `lynkeus init`: agrega el plugin `lynkeus-agent/babel` a `babel.config.js` y la llamada a `auto()` en `index.js`, si todavía no estaba.

El comando busca tu componente `App` en los lugares habituales (`App.tsx`, `src/App.tsx`, `app/App.tsx` y sus variantes en JavaScript). Si está en otro lado, indícalo con `--component <archivo>`.

Al terminar imprime qué escribió y dos recordatorios. Uno de ellos importa: la configuración de Jest de tu proyecto tiene que dejar pasar los paquetes `lynkeus-*` en `transformIgnorePatterns`, igual que hace con `react-native`.

### 2. Revisa qué falta simular

```bash
npx lynkeus headless doctor
```

`doctor` lista qué módulos nativos va a simular lynkeus y cuáles usa tu app sin que nadie los cubra. Para estos últimos, `--fix` escribe mocks vacíos en el archivo de entrada, que después puedes completar:

```bash
npx lynkeus headless doctor --fix
```

### 3. Levanta el host

```bash
LYNKEUS_TOKEN=un-secreto-local API_URL=http://127.0.0.1:3000/ npx lynkeus headless start
```

Deberías ver, después de que Jest compile la app:

```
hosting; waiting for a driver (press Ctrl-C or call the exit command to stop)
```

Dos variables intervienen:

- `LYNKEUS_TOKEN` es obligatoria. Sin ella el host se niega a arrancar: una app alojada habla con un backend real, y sin token cualquier proceso local podría manejarla.
- `API_URL` es la variable de la que tu app lee la dirección de su API. El nombre es el de tu proyecto; se lo indicas a lynkeus con `--api-env <NOMBRE>` en el paso 1 o con la clave `apiEnv` en `lynkeus.config.json`. El archivo de entrada se niega a renderizar la app si esa dirección no es local.

### 4. Maneja la app

En otra terminal, con el mismo token:

```bash
LYNKEUS_TOKEN=un-secreto-local npx lynkeus screen
```

Deberías ver la pantalla inicial de tu app, en el mismo formato que en un simulador.

### 5. O deja que `case run` levante el host

Para ejecutar casos no necesitas los pasos 3 y 4. La opción `--host` levanta el host al empezar y lo detiene al terminar:

```bash
LYNKEUS_TOKEN=un-secreto-local API_URL=http://127.0.0.1:3000/ npx lynkeus case run --host
```

Verás `host: up` cuando esté listo. Si el host no arranca en 180 segundos, la ejecución termina con las últimas líneas de su salida.

## El archivo de entrada

El archivo exporta `App` y, opcionalmente, un adaptador `navigation`. Su forma es esta:

```tsx title="qa/headless.tsx"
import { installDefaultMocks } from 'lynkeus-headless/mocks';

// Solo lo que lynkeus no puede adivinar: tus propios módulos nativos.
jest.mock('../app/native/Updater', () => ({ /* … */ }));

installDefaultMocks({
  network: 'real',                           // la app llega a tu backend local
  networkHosts: ['127.0.0.1', 'localhost'],  // y a ningún otro lado (valor por defecto)
  locale: { country: 'DE', languageTag: 'de-DE', languageCode: 'de' },
});

const { default: App } = require('../app/App');
export { App };
```

`installDefaultMocks` simula lo que está instalado y que de otro modo fallaría en Node: MMKV, keychain, device-info, safe-area-context, localize, async-storage, worklets, pager-view, video, fast-image, biometría, in-app-review, webview, vision-camera, image-picker y la parte nativa de vector-icons (un ícono convertido en imagen recibe la ruta de un archivo).

Reanimated y gesture-handler quedan intactos a propósito: su soporte para Jest es un plugin de Babel, no un `jest.mock`. Si tu app los quiere simulados, pásalos en `overrides`.

Las opciones que acepta son `skip`, `overrides`, `network`, `networkHosts`, `websocket`, `animations`, `deviceVersion` y `locale`.

La ruta del archivo puede ir en `lynkeus.config.json` como `entry`, para no repetir `--entry` en cada comando.

## Controles: lo que el sistema le entregaría a la app

En el host no hay sistema operativo. Lo que un dispositivo recibiría del mundo exterior se convierte en un comando.

| Comando | Qué simula |
|---|---|
| `lynkeus os deeplink <url>` | Un enlace que abre la app. Funciona también en un dispositivo. |
| `lynkeus os appstate <active\|background\|inactive>` | El paso a segundo plano y la vuelta: lo que se recarga o se vuelve a bloquear. |
| `lynkeus os network <off\|on>` | El modo avión: las peticiones fallan y las conexiones abiertas se caen. |
| `lynkeus os clock --now <iso>` | Lo que responde `Date`. Los temporizadores siguen siendo reales. También `--advance <ms>` y `--reset`. |
| `lynkeus os biometrics --available <FaceID\|TouchID\|none> --next <resultados>` | El sensor y lo que responden los próximos pedidos: `success`, `fail`, `cancel`. |
| `lynkeus os scan <valor> --type <qr\|ean13\|…>` | Un código que lee el escáner de la cámara abierta. |
| `lynkeus os gallery <uri>` | Lo que devuelve el próximo selector de imágenes. Con `--cancel`, que la persona canceló. |

Salvo `os deeplink`, todos son exclusivos del host sin pantalla. En un dispositivo tienes el comportamiento real.

### La red

La red es una tabla de reglas delante de `fetch`. Con `lynkeus mock` respondes una petición antes de que llegue al backend:

```bash
npx lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000   # error lento
npx lynkeus mock '/v3/accounts' --body '[]' --times 1           # lista vacía, una sola vez
npx lynkeus mock 'GET /v3/session' --status 401 --sticky        # sobrevive a un reinicio de la app
npx lynkeus mock --list
npx lynkeus mock --clear
```

Una ruta sin método coincide con cualquiera. Una regla sin `--sticky` desaparece cuando la app ejecuta su comando `reset`.

Así, un estado de error, una demora o un estado vacío cuestan una línea cada uno, sin preparar nada en el backend.

## Lo que el host no puede decirte

El host ejecuta el JavaScript de tu app contra un backend real, con la capa nativa simulada. Eso deja afuera, a propósito:

- **La cámara real y el decodificador.** `os scan` le entrega un valor al escáner; no prueba que el escáner lea.
- **Los gestos nativos complejos.** Un deslizamiento pasa por el manejador de gestos, no por un dedo.
- **La entrega de notificaciones push.**
- **Lo que renderiza un WebView.** Sí se puede probar el borde: qué le envía la app y qué hace con los mensajes que vuelven.
- **Los fallos nativos.**
- **Los píxeles.** `lynkeus screenshot` y `lynkeus snapshot --pixels` necesitan un simulador. La comparación por árbol de `snapshot` sí funciona en el host.
- **Una película del caso.** `case run --video` filma solo donde el host ofrece un comando `record`. Este host no dibuja nada y no lo ofrece.

Para todo eso, ejecuta los mismos casos en un simulador.

Una app con expo-router no tiene un componente raíz: sus pantallas son archivos que carga el enrutador. Desde 0.4.0 corre igual en el host, porque la entrada renderiza el enrutador sobre esos archivos con `expo-router/testing-library`, la forma que Expo ofrece para usarlo en Jest. `headless init` escribe esa entrada cuando encuentra `expo-router` y una carpeta `app/` o `src/app/`, e instala `jest-expo` con el instalador de Expo. El agente se monta con `auto()` y reconoce las rutas: `lynkeus screen` imprime `index (__root > index)` y `nav` va a una ruta por su nombre de expo-router. La barra de pestañas nativa de la plantilla más reciente tampoco aparece aquí; para cambiar de pestaña, usa `nav`.

Dentro de un caso, un paso que solo tiene sentido en un lado se marca con `on:`:

```yaml
steps:
  - on: headless
    do:
      - app.mock: { route: "GET /v3/accounts", status: 500 }
  - on: device
    do:
      - app.press: "364,84"
```

Y si un caso pide algo que el host actual no puede hacer, ese paso se informa como no compatible, no como fallido.

## Seguridad

El host tiene tres protecciones, pensadas para un accidente concreto: un proceso automatizado apuntando a producción.

- `headless start` no arranca sin `LYNKEUS_TOKEN`.
- Con `network: 'real'`, el host rechaza cualquier dirección fuera de `networkHosts`, que por defecto son solo las locales.
- El archivo de entrada generado comprueba, antes de renderizar la app, que la dirección de la API sea local.

## Varios hosts a la vez

Cada host y su driver se emparejan por puerto. Define `LYNKEUS_PORT` con el mismo valor en los dos, y cada pareja es independiente:

```bash
LYNKEUS_PORT=8124 LYNKEUS_TOKEN=un-secreto-local npx lynkeus headless start
```

```bash
LYNKEUS_PORT=8124 LYNKEUS_TOKEN=un-secreto-local npx lynkeus screen
```

Es lo que permite repartir una suite entre los núcleos de una máquina de CI. La guía [CI](/es/guides/ci/) lo desarrolla.

Dos hosts en el mismo puerto no dan error: el driver se queda con el último que se conectó, así que se turnan y un paso puede caer en la app equivocada (un comando que una tiene y la otra no falla como `this host has no …`). La CLI lo avisa una vez con `Another app attached on port …` y nombra las dos. Detén el host que quedó corriendo o dale a cada uno su propio `LYNKEUS_PORT`.

## Problemas frecuentes

### Las pantallas nunca cargan y el host dice `did not answer (ECONNREFUSED)`

El backend no está levantado en esa dirección, o la app no usa la que esperabas: lee la base de su API de la variable que nombra `apiEnv`, y si esa variable no está definida en la terminal donde corriste `headless start`, usa la suya por defecto.

### La app no pasa de la pantalla de carga

Casi siempre es un módulo nativo que lynkeus no conoce. Ejecuta `lynkeus headless doctor` y simula lo que falte en el archivo de entrada.

La otra causa habitual: Node resuelve `localhost` a IPv6 mientras tu backend escucha en IPv4. Usa `127.0.0.1`.

### El host se cayó con un error de Jest que no reconoces

Cuando el host se cae, lo último que imprime es qué suele significar el error y cómo arreglarlo. Para un error que tengas copiado, pégale la primera línea a `doctor`:

```bash
npx lynkeus headless doctor --explain "<primera línea del error>"
```

Pega la primera línea, no la traza completa.

### Cambiar una variable de entorno no tiene efecto

Si tu configuración de Babel sustituye variables de entorno al compilar, la caché de transformaciones de Jest conserva el primer valor que vio. Borra el directorio de caché al que apunta tu configuración de Jest.

### Una pantalla nunca se estabiliza

Una pantalla que cambia sola (una cuenta regresiva, un indicador que se vuelve a renderizar) nunca queda en reposo, y `lynkeus idle` lo dice con `idle: false`. Es información, no un defecto del host.

### El host no usa `React.StrictMode`

El host renderiza sin `React.StrictMode`, porque en producción no existe y sus renders dobles duplican cada petición y cada medición. Si lo necesitas, `"strictMode": true` en `lynkeus.config.json` lo conserva.

### La memoria crece en ejecuciones largas

La memoria de Node crece unas decenas de MB por cada reinicio completo de la app. Un ejecutor que maneja cientos de casos debería reiniciar el host cuando `lynkeus call memory` informe demasiado.

## Próximos pasos

- [CI](/es/guides/ci/): la suite en integración continua, con el host sin pantalla.
- [Escribir casos](/es/guides/writing-cases/): `on:` y los pasos que dependen del host.
- [Referencia del CLI](/es/reference/cli/): todas las opciones de `headless` y de `os`.
