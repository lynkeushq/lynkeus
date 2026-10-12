---
title: Solución de problemas
description: Los fallos más comunes al usar lynkeus, ordenados por síntoma, con su causa y su arreglo.
---

Esta página está ordenada por lo que ves, no por lo que lo causa. Busca tu síntoma o el texto del error, y encontrarás por qué ocurre y cómo se arregla. Los mensajes de error se citan tal como los imprime la herramienta, en inglés, para que puedas buscarlos.

Antes de leer más, ten presente que lynkeus ya intenta responder la pregunta por ti. Después de un `press`, `wait`, `type`, `swipe` o `nav` que falla, imprime un bloque `why:` con lo que encontró. La [primera sección](#qué-dice-lynkeus-why) explica cómo leerlo.

## Qué dice `lynkeus why`

`lynkeus why` lee tres cosas (la pantalla, las últimas peticiones y la traza) y les aplica una serie de reglas. Puedes ejecutarlo en cualquier momento, y es más preciso si le dices qué buscabas:

```bash
npx lynkeus why '#pay-button'
npx lynkeus why --route Checkout.Confirm
```

Cada línea de su respuesta corresponde a una regla. Esta tabla dice qué significa cada una y qué hacer.

| El mensaje empieza con | Qué pasó | Qué hacer |
|---|---|---|
| `the screen is empty and has no route` | Un componente lanzó un error al renderizar y se llevó todo el árbol. Si la traza registró el error, el mensaje lo incluye. | Reinicia la app con `lynkeus call reset` y busca el error de render en el log del host. |
| `every request answered 401` | La sesión ya no existe: alguien cerró sesión, hubo un `reset`, o la credencial se revocó en otro lado. | Vuelve a iniciar sesión antes de seguir. |
| `the backend refuses … with 403` | El backend rechaza la petición por el estado de la cuenta o por un permiso. No es un problema de la pantalla. | Revisa qué espera el test de ese usuario. |
| `the backend answered 5xx on …` | Un error del servidor, no de la app. | Reprodúcelo con `curl` antes de tocar el test. |
| `a request answered 429` | El backend está limitando la frecuencia de peticiones de este cliente. | Espacia las ejecuciones o sube el límite en tu entorno local. |
| `the host broke a render loop` | El host cortó un ciclo de renders sin fin: un componente cuyo efecto y cuyo store se alimentan entre sí. La pantalla queda inservible hasta un `reset`. | Corrige el componente que nombra el mensaje. |
| `… is in the tree but not presented` | El elemento está montado, pero pertenece a una pantalla que la app no está mostrando. | Cierra lo que esté abierto encima, o apunta a algo dentro de eso. |
| `… is on the screen but covered` | Hay una hoja o una capa sobre el elemento. | Ciérrala, o pulsa lo que lo tapa. |
| `… is on the screen but disabled` | Un formulario todavía no es válido, o hay en curso una petición de la que el control depende. | Completa lo que falta, o espera la petición. |
| `the text is not there, but "…" is` | El texto que buscas no está, pero hay uno parecido: difiere en la redacción, en un acento o en las mayúsculas. | Corrige el texto del objetivo, o usa un `testID`. |
| `the list shows N near matches and yours is not among them` | Los datos acumularon elementos parecidos y la lista está recortada. | Busca por algo único, o limpia los datos. |
| `the app was on X and moved to Y` | La app llegó a la ruta que esperabas y después se fue: una redirección, una barrera, un modal. | Mira el orden en `lynkeus trace`. |
| `N request(s) still in flight when the command gave up` | La pantalla no había terminado de cargar. | Dale más tiempo con `--timeout`, o espera la petición que necesita. |
| `no request left the app while this ran` | No se pidió nada. | Comprueba que el usuario tenga sesión y que la app hable con el backend correcto. |
| `N request(s) were refused by the host` | El host sin pantalla bloqueó peticiones a servidores que no están permitidos. | Si la pantalla necesita alguno, permítelo en `networkHosts` o simúlalo con `lynkeus mock`. |
| `the last command that failed was …` | Ninguna otra regla explicó el fallo; este es el último error registrado. | Parte de ese error. |
| `nothing in the evidence explains it` | La pantalla, las peticiones y la traza se ven normales. | Lee la pantalla con `lynkeus screen` y compárala con lo que esperabas. |

En `lynkeus session`, el mismo diagnóstico viaja en el campo `why` de la respuesta. En un caso, queda en el reporte bajo el paso que falló.

## El driver no se conecta con la app

### `No app attached on 127.0.0.1:8123 within 15000ms`

**Qué ves.** Cualquier comando espera unos segundos y termina con `No app attached on 127.0.0.1:8123 within 15000ms. Is a dev build running with <Lynkeus>?`

**Por qué pasa.** La app es la que se conecta al driver, no al revés. Busca al driver en `localhost:8123` en iOS y en `10.0.2.2:8123` en el emulador de Android, y reintenta mientras nadie contesta. Este error significa que en todo ese tiempo ninguna app se presentó.

**Cómo se arregla.** Revisa estas causas, en este orden:

1. **El build no es de depuración.** El agente solo existe en builds de depuración. Un build de producción no lo contiene.
2. **`enabled` es falso en este entorno.** Si condicionaste el agente a tu entorno (`enabled: __DEV__ && config.ENV !== 'prod'`), comprueba que la condición se cumpla en el build que estás corriendo.
3. **El token no coincide.** El token con el que se compiló la app tiene que ser el valor de `LYNKEUS_TOKEN` que lee el CLI. Si difieren, la app rechaza al driver en silencio, y el síntoma es exactamente este error.
4. **Los puertos no coinciden.** Si definiste `LYNKEUS_PORT` o `port` en la configuración, la app tiene que haber recibido el mismo puerto al montar el agente.
5. **La app tarda en arrancar.** Dale más tiempo con `--attach-timeout 60000`, o con `attachTimeout` en la configuración.

Para descartar que la app haya quedado en mal estado, vuelve a abrirla antes de conectar:

```bash
npx lynkeus screen --launch --app com.example.myapp
```

:::note[En Expo]
Hay dos causas propias de Expo. El agente no funciona en Expo Go, porque tiene código nativo: hace falta un development build. Y la app lee el token de `EXPO_PUBLIC_LYNKEUS_TOKEN`, no de `LYNKEUS_TOKEN`; las dos variables tienen que tener el mismo valor. Ver [Expo](/es/platforms/expo/).
:::

### `No booted simulator. Boot one first.`

**Por qué pasa.** Nombraste un dispositivo, con `--device`, `LYNKEUS_DEVICE` o `device` en la configuración, y no hay ningún simulador encendido que coincida. La variante `No booted simulator matching "<nombre>".` dice cuál buscó.

**Cómo se arregla.** Enciende el simulador, o corrige el nombre. Acepta el UDID o una parte del nombre.

### `Port 8123 is already taken`

**Qué ves.** `Port 8123 is already taken: another lynkeus run is probably still driving the app there. Stop it, or use another port (LYNKEUS_PORT, --ports).`

**Por qué pasa.** Otro proceso de lynkeus sigue escuchando en ese puerto: una sesión abierta, un `lynkeus mcp`, una ejecución anterior que no terminó. Dos drivers no pueden compartir un puerto, porque la app quedaría en manos del primero al que se conecte y los pasos de dos ejecuciones se mezclarían.

**Cómo se arregla.** Detén el otro proceso. Si de verdad necesitas dos ejecuciones a la vez, dale a cada par su propio puerto: `LYNKEUS_PORT` en el driver y en el host, o `--ports` en `case run --jobs`.

### Una advertencia sobre versiones distintas

**Qué ves.** Al conectarse, el CLI avisa: `The app runs lynkeus-agent 0.2.0, this CLI is lynkeus 0.2.1: they can misread each other without an error.`

**Por qué pasa.** La versión de `lynkeus-agent` compilada en la app no es la del CLI. Los dos pueden entenderse mal sin que aparezca ningún error; por ejemplo, escribir en un campo que no es.

**Cómo se arregla.** Instala en la app la misma versión de `lynkeus-agent` que la del CLI y vuelve a compilarla. La alternativa es usar la versión del CLI que corresponde al agente.

## Una pulsación no hace nada

**Qué ves.** `lynkeus press` termina sin error, o falla, y la app no reacciona.

**Por qué pasa.** Casi siempre el elemento no está donde un dedo lo alcanzaría. Lee la pantalla primero:

```bash
npx lynkeus screen
```

Cada línea del listado muestra el estado del elemento:

| Marca | Qué significa | Qué hacer |
|---|---|---|
| `~covered` | Un toque en su centro caería sobre otra cosa. | Cierra lo que lo tapa. |
| `!disabled` | El control no responde a toques. | Completa el formulario o espera la petición de la que depende. |
| `~inert` | Él o un ancestro tiene `pointerEvents: 'none'`. | Apunta al control que lo contiene. |

Puede ocurrir también que el elemento no esté en el listado. El encabezado cuenta lo que quedó fuera, por ejemplo `3 hidden: 3 behind-overlay`, y `lynkeus screen --all` lo muestra. Esos elementos están en el árbol, pero pertenecen a una pantalla que la app no presenta: la que quedó debajo de un modal, o la de otra pestaña.

Los errores correspondientes son:

- `No element matches {"testId":"…"}`: no hay ningún elemento así en el árbol.
- `{"testId":"…"} is not presented (behind-overlay)`: existe, pero no se está mostrando. Entre paréntesis va el motivo.

**Una comparación útil.** `--js` llama al `onPress` de React en lugar de sintetizar un toque. Si con `--js` funciona y sin él no, el control existe y algo se interpone entre el dedo y él. Es un diagnóstico, no un arreglo: un test que solo pasa con `--js` no está probando lo que haría un usuario.

## Un objetivo por texto no coincide

**Qué ves.** `lynkeus press '"Continuar"'` falla con `No element matches {"text":"Continuar"}`, y el texto está a la vista.

**Por qué pasa.** Un objetivo por texto sigue dos reglas distintas según el tipo de elemento. Un control (botón o campo) coincide por etiqueta exacta y, si no hay, por contener el texto. Un párrafo coincide solo por texto exacto. Una palabra dentro de un texto corrido nunca es un objetivo, porque un toque en el centro del párrafo caería sobre cualquier otra palabra.

**Cómo se arregla.** Pregúntale a `why`. Te dice si hay un texto parecido que difiere en la redacción, en un acento o en las mayúsculas:

```bash
npx lynkeus why '"Continuar"'
```

Si el texto cambia con el idioma o con el contenido, un `testID` es un objetivo más estable.

## Una espera se agota y la pantalla está ahí

**Qué ves.** `lynkeus wait Settings.Main` termina con `Timed out waiting for Settings.Main  (on Settings.Home)`, y la pantalla que esperabas está visible.

**Por qué pasa.** El nombre de la ruta no es el que tú crees. Sale del adaptador de navegación, y puede diferir del nombre del componente o del archivo. El final del mensaje, entre paréntesis, dice en qué ruta está la app.

**Cómo se arregla.** Lee el nombre real:

```bash
npx lynkeus screen
```

Si `screen` no muestra ninguna ruta, la app no tiene adaptador de navegación. En ese caso hay elementos, pero no rutas: espera un elemento de la pantalla en lugar de la ruta, o monta el agente con un adaptador. Los comandos `nav` y `back` fallan entonces con `No navigation adapter configured`.

## Una pantalla nunca se aquieta

**Qué ves.** `lynkeus idle` responde `idle: false` después de agotar su tiempo, y los pasos que esperan a que la app se aquiete tardan siempre lo máximo.

**Por qué pasa.** Algo en la pantalla se vuelve a renderizar todo el tiempo: una cuenta regresiva, un reloj, un indicador de carga animado desde JavaScript. Una pantalla así nunca deja de hacer commits. `idle` no lo trata como un error; lo informa.

**Cómo se arregla.** Declara esos controles en `live`, en `lynkeus.config.json`, por su `testID`. Su texto deja de contar como actividad.

```json title="lynkeus.config.json"
{ "live": ["^countdown-", "^clock$"] }
```

## No aparece el teclado en el simulador

**Qué ves.** `lynkeus type` escribe, pero el teclado del sistema no sube, y la pantalla no se acomoda como lo haría para un usuario.

**Por qué pasa.** `type` toca el campo primero, así que recibe el foco como con un dedo y el teclado debería aparecer. Cuando no aparece, el simulador está tomando las teclas del teclado de la Mac.

**Cómo se arregla.** En el simulador, desactiva I/O → Keyboard → Connect Hardware Keyboard. O desde la terminal:

```bash
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
```

## Todo va lento

**Qué ves.** Cada paso tarda más de un segundo, aunque la app responda al instante.

**Por qué pasa.** La causa habitual es lanzar un proceso del CLI por cada paso. Cada invocación paga por arrancar Node, abrir la conexión y cerrarla: alrededor de 1,5 segundos. El paso en sí cuesta unos 50 ms.

**Cómo se arregla.** Mantén una sola conexión con `lynkeus session`, o usa `lynkeus case run`, que ya lo hace.

```bash
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' | npx lynkeus session
```

Si lo lento es una espera después de iniciar sesión, quien tarda es tu backend, no el agente. `lynkeus requests` muestra la duración de cada petición.

## La app muestra algo encima de todo

**Qué ves.** Una pantalla de bloqueo, un pedido de calificación o un aviso de actualización obligatoria aparece cuando quiere y los pasos fallan porque su objetivo quedó tapado.

**Por qué pasa.** lynkeus no sabe cómo es esa pantalla en tu app, y es a propósito: no trae conocimiento de ningún producto.

**Cómo se arregla.** Depende de dónde te ocurra.

En los casos, decláralo una vez como interrupción. lynkeus la busca antes de cada paso y ejecuta los pasos que la quitan:

```json title="lynkeus.config.json"
{
  "cases": {
    "interruptions": [{ "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }]
  }
}
```

En `smoke` y `crawl`, entrégales el objetivo que la delata y el flow que la resuelve:

```bash
npx lynkeus crawl --overlay-when '#key-1' --overlay-flow flows/keypad.json
```

## Problemas con los casos

### `… is not a step`

**Qué ves.** `app.foo is not a step: lynkeus has no command foo, and the project declares no macro for it`

**Por qué pasa.** El verbo empieza con `app.`, pero no es un verbo del formato, ni un comando del CLI, ni un macro de tu proyecto. Suele ser un error de tipeo, o un macro que vive en otro archivo de configuración.

**Cómo se arregla.** Corrige el nombre, o declara el macro en `cases.macros`. Si tus casos viven en otro repositorio, comprueba que `LYNKEUS_CONFIG` apunte a su configuración. `lynkeus case run --dry-run` detecta estos errores sin ejecutar nada.

Una variante es `press has no foo`: el verbo existe, pero le pasaste un parámetro que no conoce.

### Un caso se rechaza antes de empezar

**Qué ves.** La ejecución termina de inmediato, nombra uno o más fixtures y agrega `the fixtures command answers: create_user, give_points, …`

**Por qué pasa.** Antes del primer caso, lynkeus le pregunta al servidor de fixtures qué comandos responde. Un caso que nombra uno que no está en la lista se rechaza antes de ejecutar nada. Es deliberado: la alternativa sería fallar a mitad de camino, con el backend ya modificado.

**Cómo se arregla.** Corrige el nombre del fixture en el caso, o agrégalo al servidor.

### `the fixtures command did not answer within 120000 ms`

**Por qué pasa.** El comando de fixtures recibió el paso y no escribió ninguna respuesta. O está colgado, o respondió algo que no es una línea de JSON: lynkeus ignora toda línea de salida que no empiece con `{`.

**Cómo se arregla.** Ejecuta el comando a mano y envíale una línea para ver qué contesta. Comprueba que escriba exactamente una línea de JSON por cada línea que recibe, y que los mensajes de diagnóstico vayan a la salida de error. Si el paso es legítimamente lento, sube `cases.fixtures.timeoutMs`.

### `the fixtures command ended`

**Por qué pasa.** El proceso de fixtures terminó mientras lynkeus esperaba su respuesta. El mensaje incluye las últimas líneas de su salida de error.

**Cómo se arregla.** Lee esas líneas: suelen ser una excepción sin atrapar. Un servidor de fixtures tiene que atrapar los errores de cada paso y responder `{"ok": false, "error": "…"}`, no terminar.

### `the fixtures server cannot serve: …`

**Por qué pasa.** El servidor de fixtures está corriendo, pero avisó que no puede trabajar; por ejemplo, porque su base de datos no responde. lynkeus no empieza ningún caso, porque todos fallarían en su primer fixture.

**Cómo se arregla.** Resuelve lo que dice el mensaje, que viene de tu servidor.

### `no alias 'u'` y `{{u.email}} is empty`

**Por qué pasa.** Son dos problemas distintos con las referencias `{{…}}`.

`no alias 'u' (add 'as: u' to the step that creates it)` significa que ningún paso anterior guardó su respuesta con ese nombre. `{{u.email}} is empty` significa que el alias existe, pero la respuesta no tiene ese campo, o vale `null`.

**Cómo se arregla.** En el primer caso, agrega `as: u` al paso que crea el dato. En el segundo, mira qué devuelve de verdad tu fixture: el nombre del campo puede ser otro.

### Un paso aparece como `unsupported`

**Qué ves.** El paso aparece con `this host has no <comando>`, y el caso se detiene sin contar como fallido.

**Por qué pasa.** El host donde corre el caso no puede hacer ese paso. Los dos motivos habituales son pedir una respuesta simulada con `app.mock` en un dispositivo real, y llamar a un comando que la app no registra en ese build.

**Cómo se arregla.** No es un fallo de la app. Si el paso solo tiene sentido en un tipo de host, ponlo dentro de un bloque `on:`, para que en los demás se omita y el caso continúe:

```yaml
- on: headless
  do:
    - app.mock: { route: "GET /v3/accounts", status: 500 }
```

### Un caso pasa solo al segundo intento

**Qué ves.** El resumen de la ejecución marca el caso como aprobado al reintentar.

**Por qué pasa.** Un caso que falla se ejecuta una vez más antes de darse por fallido. Que pase al reintentar quiere decir que es intermitente: hay una condición de carrera en el test o en la app.

**Cómo se arregla.** No lo ignores. Ejecuta con `--once` para ver el primer fallo sin reintento, y sigue la guía de [tests intermitentes](/es/guides/flaky-tests/).

## Problemas con los reportes

### `set LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY`

**Por qué pasa.** `--push` y los comandos `lynkeus report` necesitan saber adónde subir y con qué clave, y falta alguna de las dos variables.

**Cómo se arregla.** Define las dos. La clave se crea en el servicio y se muestra una sola vez.

### `--push uploads the run directory: add --out <dir>`

**Por qué pasa.** `--push` sube un directorio, y sin `--out` la ejecución no escribe ninguno. Lo mismo ocurre con `--screenshots` y `--video`, que avisan con `--screenshots and --video keep what they take in the run directory: add --out <dir>`.

**Cómo se arregla.** Agrega `--out <dir>`.

### `not kept on this plan: …`

**Por qué pasa.** La ejecución se subió, pero el plan de la organización no conserva algunos archivos. En el plan Free son los videos.

**Cómo se arregla.** No es un error: el reporte existe, con sus capturas de pantalla. `lynkeus report plan` muestra qué conserva tu plan.

### `--traces could not listen on port 4318`

**Por qué pasa.** Otro proceso usa ese puerto, a menudo un colector de OpenTelemetry que ya tenías corriendo.

**Cómo se arregla.** Elige otro puerto con `--traces-port` y apunta la variable `OTEL_EXPORTER_OTLP_ENDPOINT` de tu backend al mismo.

## Problemas con el mapa

### `No graph at …/.lynkeus/graph.json`

**Por qué pasa.** Los comandos `map show`, `map paths`, `map plan` y `map impact` leen un grafo que todavía no existe.

**Cómo se arregla.** Ejecuta `npx lynkeus map build` en la carpeta de la app.

### `map plan` no da indicaciones

**Por qué pasa.** El grafo estático solo conoce las navegaciones que pudo leer del código fuente. Una navegación que se arma en tiempo de ejecución no está ahí.

**Cómo se arregla.** Ejecuta `lynkeus crawl` desde la pantalla de partida, para sumar lo que se observa al recorrer la app de verdad, y vuelve a preguntar. `lynkeus map paths <Ruta>` muestra lo que se sabe hoy del destino.

### `map changes` no informa nada

**Por qué pasa.** Compara pantallas grabadas, y no hay ninguna. El mensaje es `(no recorded screen changes; record with 'lynkeus screen --record' or LYNKEUS_RECORD_SCREENS=1)`.

**Cómo se arregla.** Graba las pantallas con `lynkeus screen --record`, o define `LYNKEUS_RECORD_SCREENS=1` durante tus ejecuciones.

## Problemas del host sin pantalla

### `lynkeus headless needs LYNKEUS_TOKEN in the environment`

**Por qué pasa.** `headless start` se niega a arrancar sin token. Una app alojada habla con un backend real, y sin token cualquier proceso de la máquina podría manejarla.

**Cómo se arregla.** Define la variable, con el mismo valor que usa tu driver:

```bash
LYNKEUS_TOKEN=secreto npx lynkeus headless start
```

### `No qa/headless.tsx in …`

**Por qué pasa.** El host necesita un archivo de entrada que exporte tu componente `App`, y no lo encuentra.

**Cómo se arregla.** `npx lynkeus headless init` lo escribe. Si lo tienes en otra ruta, indícala con `--entry` o con `entry` en la configuración.

### El host se cae con un error de jest

**Qué ves.** `headless start` termina con una traza de jest de cientos de líneas.

**Por qué pasa.** Casi siempre es una de unas pocas causas conocidas. Cuando el host se cae, las últimas líneas ya dicen cuál, bajo el título `lynkeus: what this looks like`. Para un error que copiaste de otro lado:

```bash
npx lynkeus headless doctor --explain "<primera línea del error>"
```

Estas son las causas que reconoce:

| El error contiene | Causa | Arreglo |
|---|---|---|
| `TurboModuleRegistry.getEnforcing(...): 'X' could not be found` | El módulo nativo `X` no existe bajo jest. | Simula el paquete dueño de `X` en la entrada, con `jest.mock('<paquete>', () => ({ … }))`. `lynkeus headless doctor` dice dónde se usa. |
| `"X" was not found in the UIManager` | La vista nativa `X` no tiene equivalente en jest. | Simula la biblioteca que la renderiza con un `View` común. |
| `Cannot find module 'X' from 'Y'` | `Y` importa `X`, y jest no lo resuelve. | Si `X` es un alias de ruta, agrégalo a `moduleNameMapper`. Si es un paquete nativo opcional, simúlalo en la entrada. |
| `lynkeus headless only drives a local backend; API_URL is "…"` | La variable de la API no apunta a un backend local. | Exporta `API_URL=http://127.0.0.1:<puerto>/` antes de arrancar. Si la app incorpora las variables al compilar, borra también la caché de transformaciones de jest. |
| `X.y is not a function` | Un mock no implementa un método que la app llama. | Amplía el mock de `X` con `y`. Los mocks por defecto se pueden reemplazar clave por clave con `installDefaultMocks({ overrides })`. |
| `Cannot read properties of undefined (reading 'x')` | Algo que la app daba por existente no está definido. | Busca el módulo un cuadro más arriba en la traza: un mock que devuelve `{}` en lugar de la forma que la app lee, o un store sin inicializar porque un servicio falló antes. |
| `ECONNREFUSED 127.0.0.1:3000` | Nadie escucha en esa dirección. | Arranca el backend, o el driver si es la conexión del agente, y revisa el puerto. |
| `Unexpected token 'export'` o `Cannot use import statement` | jest no está transformando una dependencia. | Agrega el paquete a la lista de excepciones de `transformIgnorePatterns`. Para `lynkeus-agent` y `lynkeus-headless` hace falta `lynkeus-[^/]+`. |
| `ReferenceError: X is not defined` | `X` es un global que el entorno de jest no trae. | Defínelo en la entrada antes de cargar la app (`globalThis.X = …`), o simula el módulo que lo espera. |
| `Jest did not exit one second after the test run has completed` | Algo mantiene vivo el proceso. | En un host pensado para quedarse corriendo es inofensivo. Si no, suele ser un socket o un temporizador abierto por un mock. |

### La app no pasa de la pantalla de carga

**Por qué pasa.** Hay dos causas habituales. La primera es un módulo nativo que lynkeus no conoce y que nadie simuló. La segunda es de red: Node resuelve `localhost` como IPv6, y tu backend escucha solo en IPv4.

**Cómo se arregla.** Para la primera, ejecuta `lynkeus headless doctor` y simula lo que falte en tu entrada; `--fix` escribe los mocks vacíos. Para la segunda, usa `127.0.0.1` en lugar de `localhost` en la dirección de tu API.

### Cambiar una variable de entorno no tiene efecto

**Por qué pasa.** Si tu configuración de Babel incorpora las variables de entorno al código, la caché de transformaciones de jest se queda con el primer valor que vio.

**Cómo se arregla.** Borra el directorio de caché al que apunta tu configuración de jest.

### El host consume cada vez más memoria

**Por qué pasa.** En ejecuciones largas, el heap de Node crece unas decenas de MB con cada reinicio completo de la app.

**Cómo se arregla.** Un runner que maneja cientos de casos tiene que reiniciar el host cuando `lynkeus call memory` informe un valor demasiado alto. Una forma de hacerlo es `case run --host-command`, que arranca un host nuevo para cada caso.

## Notas por plataforma

### iOS

- **Hace falta la New Architecture.** El agente no funciona con la arquitectura anterior.
- **Solo builds de depuración.** La síntesis de toques usa una API privada de UIKit, envuelta en `#if DEBUG`. En un build de producción esos símbolos no existen.

### Android

- **La app tiene que ser depurable.** El agente se niega a correr si la app no tiene `FLAG_DEBUGGABLE`.
- **En el emulador, la app busca al driver en `10.0.2.2`.** Es la dirección con la que el emulador llega a tu máquina. Si el driver escucha en otro lado, pásale la opción `host` al montar el agente.

### Expo

- **No funciona en Expo Go.** El agente tiene código nativo. Usa un development build: `npx expo prebuild` y después `npx expo run:ios` o `npx expo run:android`.
- **No hace falta ningún config plugin.** El módulo nativo se enlaza solo.
- **Los proyectos con expo-router no tienen `index.js`.** Hay que crear uno que monte el agente y después cargue el router, y apuntar `"main"` de `package.json` a ese archivo. Los pasos están en la [instalación en Expo](/es/getting-started/installation-expo/).
- **Las pestañas nativas no aparecen como elementos.** La barra de pestañas de la plantilla más nueva de Expo la dibuja el sistema, no React Native. Sus pestañas no figuran en `lynkeus screen` y no se pueden pulsar por nombre. Navega con `lynkeus nav <ruta>`.

### Host sin pantalla

- **Requiere Node 20 o posterior**, y usa la configuración de jest y la transformación de Babel de tu propia app.
- **No hay píxeles.** `lynkeus screenshot` y `lynkeus snapshot --pixels` necesitan un simulador. La comparación por árbol de `snapshot` sí funciona.
- **Todo lo nativo está simulado.** La cámara, la biometría y las integraciones con el sistema son mocks. Un WebView se renderiza como una caja vacía. Para probar eso, los mismos casos corren en un simulador.

## Si nada de esto ayuda

Junta estas tres salidas antes de pedir ayuda. Con ellas, casi cualquier problema se puede diagnosticar:

```bash
npx lynkeus hello           # qué dijo la app de sí misma
npx lynkeus screen --all    # qué hay en pantalla, incluido lo que no se presenta
npx lynkeus trace --last 40 # qué pasó, en orden
```
