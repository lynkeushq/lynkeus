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
- Lynkeus instalado y el agente montado en la app ([Instalación en React Native](/es/getting-started/installation-react-native/)).
- El paquete `lynkeus-headless` instalado en el proyecto, junto con Jest y `@testing-library/react-native`. El host usa la configuración de Jest y la transformación de Babel de tu propia app.
- Un backend local al que la app pueda apuntar.
- Una app con un componente raíz que se pueda exportar, o una app con expo-router (desde 0.4.0; más abajo, [Lo que el host no puede decirte](#lo-que-el-host-no-puede-decirte)).

## Pasos

### 1. Genera el archivo de entrada

```bash
npx lynkeus headless init --auto
```

Esto escribe el archivo de entrada del host. Es el único lugar que conoce tu app: instala los mocks por defecto y ejecuta la entrada propia de tu app (`registerRootComponent` o `AppRegistry`). React Navigation lo encuentra solo. El archivo queda junto a tus casos, en `<cases.dir>/headless.tsx`; si ya tienes un `qa/headless.tsx`, se respeta. `entry` en la configuración o `--entry` eligen otra ruta. Con `--auto` monta además el agente como lo hace `lynkeus init`: agrega el plugin `lynkeus-agent/babel` a `babel.config.js` y la llamada a `auto()` en `index.js`, si todavía no estaba.

El comando encuentra tu componente `App` leyendo la entrada de la app, la que lo registra. Si no lo logra, indícalo con `--component <archivo>`.

La variable de la que tu app lee la dirección de su API también se detecta en el código. Si la app no lee ninguna, no se supone ninguna. Para fijarla tú, usa `--api-env <NOMBRE>`.

Al terminar imprime qué escribió y dos recordatorios. Uno de ellos importa: si tu proyecto ya tiene configuración de Jest, tiene que dejar pasar los paquetes `lynkeus-*` en `transformIgnorePatterns`, igual que hace con `react-native`. Sin configuración propia, el host detecta qué paquetes debe transpilar Jest; no usa una lista fija.

### 2. Revisa qué falta simular

```bash
npx lynkeus headless doctor
```

`doctor` lista qué módulos nativos va a simular Lynkeus y cuáles usa tu app sin que nadie los cubra. Un módulo nativo que nadie provee recibe una respuesta vacía por defecto; cada ejecución y `doctor` los listan y dicen cómo dar una respuesta real. También comprueba la versión de React Native Testing Library (se admiten la 12, la 13 y la 14). Para los módulos sin cubrir, `--fix` escribe mocks vacíos en el archivo de entrada, que después puedes completar:

```bash
npx lynkeus headless doctor --fix
```

### 3. Levanta el host

```bash
API_URL=http://127.0.0.1:3000/ npx lynkeus headless start
```

Deberías ver, después de que Jest compile la app:

```
hosting; waiting for a driver (press Ctrl-C or call the exit command to stop)
```

Dos cosas intervienen:

- El token. Es obligatorio: sin él el host se niega a arrancar, porque una app alojada habla con un backend real, y sin token cualquier proceso local podría manejarla. `headless init` crea el token del proyecto en `.lynkeus/token` (fuera de git) y el host y el CLI lo leen de ahí, así que no hay nada que exportar. Si prefieres otro valor, `LYNKEUS_TOKEN` en el entorno gana sobre el archivo.
- `API_URL` es aquí la variable de la que tu app lee la dirección de su API. El nombre es el de tu proyecto: Lynkeus lo detecta, y puedes fijarlo con `--api-env <NOMBRE>` o con la clave `apiEnv` en `lynkeus.config.json`. Si la variable no está definida, el host usa `apiUrl` de `lynkeus.config.json`, que sirve cuando un agente de IA arranca el host y no puede exportar variables. La entrada no rechaza una dirección que no sea local: de eso se encarga la barrera de red del host, que deja a la app solo con los hosts de `networkHosts` (por defecto, los locales). Las peticiones que responde una regla de `lynkeus mock` se contestan siempre, incluso para hosts fuera de esa lista, porque no salen del proceso.

### 4. Maneja la app

En otra terminal, desde la misma carpeta del proyecto (el CLI lee el mismo token):

```bash
npx lynkeus screen
```

Deberías ver la pantalla inicial de tu app, en el mismo formato que en un simulador.

### 5. O deja que `case run` levante el host

Para ejecutar casos no necesitas los pasos 3 y 4. La opción `--host` levanta el host al empezar y lo detiene al terminar:

```bash
API_URL=http://127.0.0.1:3000/ npx lynkeus case run --host
```

Verás `host: up (its log: …)` cuando esté listo; esa ruta es el registro de todo lo que imprime el host. Si el host no arranca en 180 segundos, la ejecución termina con las últimas líneas de su salida.

Con `--jobs <n>`, `--host` levanta un host por trabajo, cada uno conectado al puerto de su trabajo (Lynkeus elige puertos libres si no pasas `--ports`). Cada host sirve a los casos de su trabajo durante toda la ejecución y escribe su registro en la carpeta temporal del sistema, con el número de puerto en el nombre.

Si el host muere a mitad de la ejecución (se queda sin memoria, un fallo), o está vivo pero su app dejó de contestar, `case run --host` arranca otro antes del caso siguiente, en lugar de dejar que todos los demás fallen con `No app attached`. Antes de cada caso también le pregunta al host cuánto heap usa y lo reinicia pasado el `--host-heap` por ciento de su límite (60 si no dices otra cosa). El caso que perdió el host sigue fallando, y sus razones dicen cómo terminó el host, con sus últimas líneas y la ruta de su registro; el host nuevo escribe un registro propio.

## El archivo de entrada

El archivo exporta `App` y, opcionalmente, un adaptador `navigation`. Su forma es esta:

```tsx title="cases/headless.tsx"
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

`installDefaultMocks` simula lo que está instalado y que de otro modo fallaría en Node: MMKV, keychain, device-info, safe-area-context, react-native-localize, expo-localization, async-storage, worklets, pager-view y webview. Si una biblioteca trae su propio mock de jest o su archivo de setup para jest, se usa solo.

Los mocks de biometría, in-app-review, vision-camera, image-picker, video, fast-image y de la parte nativa de vector-icons hay que pedirlos. Se pasan en `overrides`:

```tsx
import { installDefaultMocks, biometrics } from 'lynkeus-headless/mocks';

installDefaultMocks({ overrides: { 'react-native-biometrics': biometrics } });
```

Las pantallas de SDK nativos que jest no puede ejecutar (verificación de identidad, mensajería) se sustituyen solo si las declaras en `cases.nativeMocks`. Tampoco hace falta nada para `XMLHttpRequest`, la configuración de Expo ni la URL del script de Metro: el host los provee, y por eso axios, Reactotron y expo-linking funcionan. El archivo del host vive en `.lynkeus/host/` y nunca se ejecuta en el jest de tu app. El host recupera los mocks de tests unitarios del setup de jest de tu app, salvo que ese setup lea `LYNKEUS_HEADLESS`.

Reanimated y gesture-handler quedan intactos a propósito: su soporte para Jest es un plugin de Babel, no un `jest.mock`. Si tu app los quiere simulados, pásalos en `overrides`.

Las opciones que acepta son `skip`, `overrides`, `network`, `networkHosts`, `websocket`, `animations`, `deviceVersion` y `locale`.

**Idioma y zona horaria.** Si la ejecución arranca con `--locale es-AR` (o con `launch.locale` en `lynkeus.config.json`), la app ve ese idioma en todos los lugares donde lo consulta: expo-localization, react-native-localize y el propio `Intl`. Un `toLocaleString()` o un `new Intl.NumberFormat()` sin idioma da formato de es-AR. Los separadores, la moneda, el reloj de 12 o 24 horas y el primer día de la semana salen de lo que Intl dice que muestra un teléfono configurado así. `--time-zone` cambia a la vez la zona que informan esas bibliotecas y la zona en la que corre `Date` (el `TZ` del host). La opción `locale` de la entrada da las mismas respuestas cuando la ejecución no fija otra, pero no mueve la zona de `Date`: eso solo lo hace el entorno del host.

La ruta del archivo puede ir en `lynkeus.config.json` como `entry`, para no repetir `--entry` en cada comando.

## Controles: lo que el sistema le entregaría a la app

En el host no hay sistema operativo. Lo que un dispositivo recibiría del mundo exterior se convierte en un comando.

| Comando | Qué simula |
|---|---|
| `lynkeus os deeplink <url>` | Un enlace que abre la app. Funciona también en un dispositivo. |
| `lynkeus os appstate <active\|background\|inactive>` | El paso a segundo plano y la vuelta: lo que se recarga o se vuelve a bloquear. También funciona en un simulador o un emulador, donde lo hace el sistema de verdad (`inactive` es solo del host). |
| `lynkeus os network <off\|on>` | El modo avión: las peticiones fallan y las conexiones abiertas se caen. |
| `lynkeus os clock --now <iso>` | Lo que responde `Date`. Los temporizadores corren en tiempo real, así que una cuenta atrás sigue contando segundos de verdad. `--advance <ms>` adelanta el reloj y ejecuta los temporizadores e intervalos que vencen dentro de ese lapso, cada uno en su hora, sin esperar; `--reset` devuelve `Date` al reloj real; `--settle` da unas vueltas al bucle de eventos hasta que la pantalla deja de cambiar, sin esperar temporizadores que vencen después. |
| `lynkeus os biometrics --available <FaceID\|TouchID\|none> --next <resultados>` | El sensor y lo que responden los próximos pedidos: `success`, `fail`, `cancel`. |
| `lynkeus os scan <valor> --type <qr\|ean13\|…>` | Un código que lee el escáner de la cámara abierta. |
| `lynkeus os gallery <uri>` | Lo que devuelve el próximo selector de imágenes. Con `--cancel`, que la persona canceló. |

`os deeplink` y `os appstate` funcionan también en un dispositivo, y `os biometrics --available` en un simulador de iOS. El resto es exclusivo del host sin pantalla: en un dispositivo tienes el comportamiento real.

### La red

La red es una tabla de reglas delante de `fetch`. Con `lynkeus mock` respondes una petición antes de que llegue al backend:

```bash
npx lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000   # error lento
npx lynkeus mock '/v3/accounts' --body '[]' --times 1           # lista vacía, una sola vez
npx lynkeus mock 'GET /v3/session' --status 401 --sticky        # sobrevive a un reinicio de la app
npx lynkeus mock 'POST /v1/transfers' --lost                    # el servidor la recibe; la respuesta se pierde
npx lynkeus mock --list
npx lynkeus mock --clear
```

Una ruta sin método coincide con cualquiera. Una regla sin `--sticky` desaparece cuando la app ejecuta su comando `reset`.

Así, un estado de error, una demora o un estado vacío cuestan una línea cada uno, sin preparar nada en el backend.

`--lost` imita una conexión que se cae después de haber enviado la petición: la petición llega al backend, que la procesa, y a la app le llega un fallo de red. Es la forma de probar qué hace la app cuando cree que algo no ocurrió y en el servidor sí.

La app marca como `mocked` las peticiones que contestó una regla (o cuya respuesta perdió), y `lynkeus requests`, `lynkeus trace` y la evidencia de un caso fallido las muestran con `(mocked)`. Esa marca la pone el agente cuando contesta él (en un dispositivo), y el host sin pantalla la avisa con la cabecera `x-lynkeus-mocked` en la respuesta que arma; un host propio que tenga su `netmock` debajo del agente puede hacer lo mismo. Gracias a eso, cuando un caso falla, los motivos no culpan al backend por un 500 que puso el propio caso: las reglas sobre el backend (5xx, 401, 403, 429) leen solo lo que contestó el servidor.

En un simulador o un emulador, `lynkeus mock` también funciona: responde el agente dentro de la app, con las mismas reglas, salvo `--sticky`.

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

- `headless start` no arranca sin el token del proyecto (`.lynkeus/token` o `LYNKEUS_TOKEN`).
- Con `network: 'real'`, el host rechaza cualquier dirección fuera de `networkHosts`, que por defecto son solo las locales.
- El archivo de entrada generado comprueba, antes de renderizar la app, que la dirección de la API sea local.

## Varios hosts a la vez

Cada host y su driver se emparejan por puerto. Define `LYNKEUS_PORT` con el mismo valor en los dos, y cada pareja es independiente:

```bash
LYNKEUS_PORT=8124 npx lynkeus headless start
```

```bash
LYNKEUS_PORT=8124 npx lynkeus screen
```

Es lo que permite repartir una suite entre los núcleos de una máquina de CI. La guía [CI](/es/guides/ci/) lo desarrolla.

Dos hosts en el mismo puerto no dan error: el driver se queda con el último que se conectó, así que se turnan y un paso puede caer en la app equivocada (un comando que una tiene y la otra no falla como `this host has no …`). La CLI lo avisa una vez con `Another app attached on port …` y nombra las dos. Detén el host que quedó corriendo o dale a cada uno su propio `LYNKEUS_PORT`.

## Problemas frecuentes

### Las pantallas nunca cargan y el host dice `did not answer (ECONNREFUSED)`

El backend no está levantado en esa dirección, o la app no usa la que esperabas: lee la base de su API de la variable que nombra `apiEnv`, y si esa variable no está definida en la terminal donde corriste `headless start`, usa la suya por defecto.

### La app no pasa de la pantalla de carga

Casi siempre es un módulo nativo que Lynkeus no conoce. Ejecuta `lynkeus headless doctor` y simula lo que falte en el archivo de entrada.

La otra causa habitual: Node resuelve `localhost` a IPv6 mientras tu backend escucha en IPv4. Usa `127.0.0.1`.

### El host se cayó con un error de Jest que no reconoces

Cuando el host se cae, lo último que imprime es qué suele significar el error y cómo arreglarlo. Para un error que tengas copiado, pégale la primera línea a `doctor`:

```bash
npx lynkeus headless doctor --explain "<primera línea del error>"
```

Pega la primera línea, no la traza completa.

### Cambiar una variable de entorno no tiene efecto

Si tu configuración de Babel sustituye variables de entorno al compilar, la caché de transformaciones de Jest conserva el primer valor que vio. `headless start` guarda una caché por cada valor de la variable que nombra `apiEnv` (en `.lynkeus/jest-cache/`), así que cambiar la dirección de la API surte efecto, con un primer arranque más lento para cada dirección nueva. Para cualquier otra variable sustituida, borra `.lynkeus/jest-cache/`.

### Una pantalla nunca se estabiliza

Una pantalla que cambia sola (una cuenta regresiva, un indicador que se vuelve a renderizar) nunca queda en reposo, y `lynkeus idle` lo dice con `idle: false`. Es información, no un defecto del host.

### El host no usa `React.StrictMode`

El host renderiza sin `React.StrictMode`, porque en producción no existe y sus renders dobles duplican cada petición y cada medición. Si lo necesitas, `"strictMode": true` en `lynkeus.config.json` lo conserva.

### La memoria crece en ejecuciones largas

Cada `jest.fn()` de los mocks de la app guarda con qué se lo llamó, para que un test lo lea. Bajo el host nadie lo lee, así que el host borra ese registro cada 10 segundos y los mocks siguen haciendo lo mismo. Sin eso crecía unos 20 MB por inicio de sesión y pantalla en una app grande, y agotaba un heap de 4 GB en unos 30 casos. Lo que queda crece despacio. `lynkeus call memory` lee el heap después de una recolección de basura (sin necesitar `--expose-gc`, que `NODE_OPTIONS` no admite) y dice dónde se detiene el heap (`heapLimitMb`), de modo que un ejecutor puede comparar una lectura con la del caso siguiente y con el límite. `case run --host` ya hace esa comprobación por ti antes de cada caso y reinicia el host pasado el `--host-heap` por ciento del límite.

## Próximos pasos

- [CI](/es/guides/ci/): la suite en integración continua, con el host sin pantalla.
- [Escribir casos](/es/guides/writing-cases/): `on:` y los pasos que dependen del host.
- [Referencia del CLI](/es/reference/cli/): todas las opciones de `headless` y de `os`.
