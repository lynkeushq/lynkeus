---
title: Referencia del CLI
description: Todos los comandos de lynkeus y todas sus opciones, agrupados por lo que hacen.
---

Esta página lista cada comando del CLI `lynkeus` con sus argumentos y opciones. Sirve para consultar: si todavía no has usado la herramienta, empieza por [Tu primer test](/es/getting-started/first-test/) y vuelve aquí cuando necesites el nombre exacto de una opción.

Los comandos están agrupados igual que en `lynkeus help`: manejar la app, el sistema operativo, el mapa, las ejecuciones y el host sin pantalla. Al final están los modos de larga duración (`session`, `mcp`) y las opciones globales, que acepta cualquier comando.

## Cómo leer esta página

Un argumento entre `<…>` es obligatorio y uno entre `[…]` es opcional. Una opción que lleva valor lo muestra como `--timeout <ms>`; una que no lo lleva es un interruptor y se puede negar con `--no-<opción>`.

Muchos comandos reciben un **objetivo**: el elemento sobre el que actúan. Se escribe de cuatro formas.

| Forma | Qué encuentra |
|---|---|
| `#next-button` | El elemento con ese `testID`. |
| `"Continuar"` | Un control (botón o campo) cuya etiqueta es exactamente ese texto y, si no hay, uno que lo contenga. Un párrafo solo coincide por texto exacto. |
| `12` | El elemento con ese índice en el último listado de `lynkeus screen`. |
| `100,200` | Un punto de la ventana, en puntos. |

En la terminal, las comillas del texto forman parte del objetivo, así que hay que protegerlas del shell: `lynkeus press '"Continuar"'`. Lo mismo vale para `#`, que algunos shells tratan como comentario: `lynkeus press '#next-button'`.

Todos los comandos terminan con código de salida `0` si salieron bien. Cuando un `press`, `wait`, `type`, `swipe` o `nav` falla, lynkeus imprime además el diagnóstico de [`lynkeus why`](#lynkeus-why).

## Manejar la app

Estos comandos hablan con la app que está corriendo, a través del agente que lleva dentro. Necesitan una app conectada: un build de depuración en un simulador, un emulador o un dispositivo, o el host sin pantalla.

### `lynkeus screen`

```bash
lynkeus screen [--tree] [--record] [--all] [--frames] [--verbose]
```

Muestra la ruta, el camino de navegadores y todos los elementos que hay en pantalla. Es el primer comando que conviene ejecutar cuando algo no se comporta como esperabas.

Imprime una línea por elemento: índice, tipo, `#testId`, etiqueta, valor y estado (`!disabled`, `~covered`, `~inert`). Lo que la plataforma no está presentando queda fuera del listado y se cuenta en el encabezado.

| Opción | Qué hace |
|---|---|
| `--tree` | Imprime la pantalla como árbol de significado, sin geometría. Es la forma adecuada para comparar con `diff`. |
| `--record` | Guarda la estructura en `.lynkeus/screens/` y avisa de lo que cambió desde la última lectura. Equivale a definir `LYNKEUS_RECORD_SCREENS=1`. |
| `--all` | Lista también lo que no se está presentando. |
| `--frames` | Añade el centro de cada elemento, en puntos. |
| `--verbose` | Añade al encabezado el número de commits de React y lo que costó la lectura. |

### `lynkeus press`

```bash
lynkeus press <target> [--in <target>] [--nth <n>] [--hold <ms>] [--js] [--settle]
```

Pone un dedo sobre un elemento.

| Argumento | Qué es |
|---|---|
| `target` | El objetivo: `#testId`, `"texto"`, `12` (índice) o `100,200`. |

| Opción | Qué hace |
|---|---|
| `--in <target>` | Entre varias coincidencias, elige la más cercana a este otro objetivo. |
| `--nth <n>` | Elige la coincidencia número `n`, contando desde 0. |
| `--hold <ms>` | Mantiene el dedo ese tiempo. Unos 600 ms son una pulsación larga. |
| `--js` | Llama a `onPress` directamente en lugar de sintetizar un toque. Sirve para comparar, no para arreglar un test. |
| `--settle` | Espera a que la app deje de hacer commits y luego imprime la pantalla. |

```bash
# El botón "like" que pertenece al mensaje de Ana, no el primero de la lista
lynkeus press '#like-message-button' --in '"hi from Ana"'
```

### `lynkeus type`

```bash
lynkeus type <text> [target] [--in <target>] [--nth <n>] [--paste] [--submit] [--clear]
```

Escribe en el campo que tiene el foco. Si le das un objetivo, lo toca primero.

| Argumento | Qué es |
|---|---|
| `text` | Lo que se escribe. |
| `target` | Opcional. El campo que se toca antes de escribir. |

| Opción | Qué hace |
|---|---|
| `--in <target>` | Entre varias coincidencias, elige la más cercana a este otro objetivo. |
| `--nth <n>` | Elige la coincidencia número `n`, contando desde 0. |
| `--paste` | Inserta el texto de una vez, en lugar de tecla por tecla. |
| `--submit` | Al terminar pulsa la tecla de retorno (`onSubmitEditing`). |
| `--clear` | Vacía el campo antes de escribir. |

```bash
lynkeus type "1124888418" '#phone-input' --clear --submit
```

### `lynkeus swipe`

```bash
lynkeus swipe [direction] [target] [--distance <pt>] [--from <x,y>] [--to <x,y>] [--duration <ms>]
```

Arrastra el dedo. Sobre un objetivo, mueve el gesto de ese elemento: un deslizador, una hoja inferior.

Sobre un objetivo, el arrastre empieza en su centro, y un control ancho no siempre da para eso: un deslizador que necesita recorrer el 80 % de su ancho terminaría fuera de la pantalla, y un toque que sale de la pantalla se cancela. En ese caso usa `--from` y `--to` para fijar los dos extremos.

| Argumento | Qué es |
|---|---|
| `direction` | Opcional. `up`, `down`, `left` o `right`. Se omite si das `--from` y `--to`. |
| `target` | Opcional. El elemento sobre el que se arrastra. |

| Opción | Qué hace |
|---|---|
| `--distance <pt>` | Cuánto se mueve el dedo, en puntos. |
| `--from <x,y>` | Dónde se apoya el dedo. |
| `--to <x,y>` | Dónde se levanta. |
| `--duration <ms>` | Cuánto dura el arrastre. |

### `lynkeus back`

Vuelve a la pantalla anterior, sacando la ruta actual de la pila. No tiene argumentos ni opciones.

### `lynkeus nav`

```bash
lynkeus nav <route> [params]
```

Salta directamente a una ruta. Es un atajo, no una acción de usuario: úsalo para llegar al punto donde empieza un test, no para probar la navegación.

| Argumento | Qué es |
|---|---|
| `route` | El nombre de la ruta, por ejemplo `Settings.Main`. |
| `params` | Opcional. Los parámetros de la ruta, en JSON. |

```bash
lynkeus nav Checkout.Confirm '{"id":"abc"}'
```

### `lynkeus wait`

```bash
lynkeus wait <what> [--in <target>] [--nth <n>] [--gone] [--scroll] [--timeout <ms>]
```

Espera hasta que aparezca una ruta o un elemento, hasta que se vaya, o una cantidad fija de milisegundos.

| Argumento | Qué es |
|---|---|
| `what` | Una ruta, un objetivo, o un número de milisegundos (`800`). |

| Opción | Qué hace |
|---|---|
| `--in <target>` | Entre varias coincidencias, elige la más cercana a este otro objetivo. |
| `--nth <n>` | Elige la coincidencia número `n`, contando desde 0. |
| `--gone` | Espera a que el elemento deje de estar en pantalla. |
| `--scroll` | Desplaza la lista más cercana hasta que el elemento esté dentro de la ventana. |
| `--timeout <ms>` | Cuánto espera antes de rendirse. Por defecto `10000`. |

```bash
lynkeus wait Settings.Main
lynkeus wait '#row-25' --scroll
lynkeus wait '#spinner' --gone --timeout 20000
```

### `lynkeus screenshot`

```bash
lynkeus screenshot <file>
```

Guarda en un archivo PNG cómo se ve la pantalla en este momento. Solo funciona en un dispositivo o un simulador: el host sin pantalla no dibuja nada que capturar.

| Argumento | Qué es |
|---|---|
| `file` | Dónde se escribe el PNG. |

### `lynkeus see`

```bash
lynkeus see <what> [--absent] [--within <ms>]
```

Comprueba que una ruta o un elemento está en pantalla ahora. Si no lo está, termina con código de salida `1`, así que sirve como aserción en un script.

| Argumento | Qué es |
|---|---|
| `what` | Una ruta o un objetivo. |

| Opción | Qué hace |
|---|---|
| `--absent` | Comprueba lo contrario: que no está. |
| `--within <ms>` | Le da ese tiempo para aparecer. Por defecto `0`. |

### `lynkeus idle`

```bash
lynkeus idle [--quiet <ms>] [--timeout <ms>] [--after <commit>]
```

Espera hasta que la app deje de hacer commits: los datos llegaron y las animaciones terminaron.

Una pantalla que todavía no empezó a cargar se ve igual que una que ya terminó: las dos están quietas. `--after <commit>` resuelve esa ambigüedad. Le das el número de commits que había antes de lo que esperas que ocurra, y la quietud solo cuenta cuando la app ya pasó de ese número.

| Opción | Qué hace |
|---|---|
| `--quiet <ms>` | Cuánto tiempo sin commits cuenta como quieto. Por defecto `300`. |
| `--timeout <ms>` | Cuánto espera antes de rendirse. La respuesta dice si se aquietó o no. Por defecto `5000`. |
| `--after <commit>` | Un número de commits anterior: la quietud solo cuenta cuando la app lo superó. |

Una pantalla con un reloj o una cuenta regresiva nunca se aquieta, y `idle` lo dice en su respuesta. Eso es información, no un error. Si tu app tiene controles así, decláralos en [`live`](/es/reference/configuration/).

### `lynkeus requests`

```bash
lynkeus requests [--last <n>]
```

Lista las peticiones HTTP que hizo la app: método, ruta, estado y duración en milisegundos. Nunca incluye cabeceras ni cuerpos.

| Opción | Qué hace |
|---|---|
| `--last <n>` | Cuántas mostrar. Por defecto `30`. |

### `lynkeus trace`

```bash
lynkeus trace [--since <seq>] [--last <n>]
```

Muestra lo que pasó en la app, en orden: rutas, peticiones, cambios en los stores, toques y comandos.

| Opción | Qué hace |
|---|---|
| `--since <seq>` | Solo lo posterior a ese número de secuencia, tomado de un `trace` anterior. |
| `--last <n>` | Cuántos eventos mostrar. Por defecto `60`. |

### `lynkeus call`

```bash
lynkeus call <command> [params]
```

Ejecuta un comando que la app registró con `qa.register`, como `reset` o `busy`. La [API del agente](/es/reference/agent-api/) explica cómo registrarlos.

| Argumento | Qué es |
|---|---|
| `command` | El nombre del comando. |
| `params` | Opcional. Sus parámetros, en JSON. |

```bash
lynkeus call reset
lynkeus call stores '{"name":"session"}'
lynkeus call events '{"clear":true}'
```

### `lynkeus hello`

Muestra lo que la app dijo de sí misma al conectarse: plataforma, si tiene toques nativos y qué comandos registró. No tiene argumentos ni opciones.

### `lynkeus launch`

```bash
lynkeus launch [bundleId] [--clean]
```

Vuelve a abrir la app y espera a que el agente se conecte.

| Argumento | Qué es |
|---|---|
| `bundleId` | Opcional. El identificador de la app. También se puede dar con `--app` o en la configuración. |

| Opción | Qué hace |
|---|---|
| `--clean` | Ejecuta antes el comando `reset` de la app, si está conectada. |

### `lynkeus why`

```bash
lynkeus why [target] [--route <Route>]
```

Explica por qué falló lo último que intentaste. Lee la pantalla, las últimas peticiones y la traza, y les aplica una serie de reglas: el objetivo está tapado, la sesión venció, el backend respondió 500.

Se ejecuta solo después de un `press`, `wait`, `type`, `swipe` o `nav` que falla. Si le dices qué buscabas, la respuesta es más precisa.

| Argumento | Qué es |
|---|---|
| `target` | Opcional. Lo que esperabas encontrar: una ruta o un objetivo. |

| Opción | Qué hace |
|---|---|
| `--route <Route>` | La ruta que esperabas. |

Las reglas que aplica están en [Solución de problemas](/es/troubleshooting/).

### `lynkeus lint`

```bash
lynkeus lint [--strict] [--no-contrast] [--save <file>] [--baseline <file>]
```

Revisa la pantalla actual y avisa de controles sin etiqueta, objetivos táctiles pequeños, texto con poco contraste, claves de traducción sin traducir y elementos tapados o recortados. La guía [Lint y contraste](/es/guides/lint-and-contrast/) explica cada regla.

| Opción | Qué hace |
|---|---|
| `--strict` | Termina con código `1` ante cualquier advertencia. |
| `--no-contrast` | Desde 0.3.0. Omite la medición del contraste del texto contra su fondo, que requiere tomar una captura de pantalla. |
| `--save <file>` | Guarda los hallazgos de esta pantalla en un archivo de referencia. |
| `--baseline <file>` | Imprime solo lo que es nuevo respecto de un archivo de referencia. Si no la das, se usa `lintBaseline` de la configuración. |

### `lynkeus perf`

```bash
lynkeus perf [--since <seq>] [--last <n>]
```

Resume el rendimiento por pantalla: peticiones al llegar, tiempo hasta aquietarse, errores, bloqueos y la llamada más lenta.

| Opción | Qué hace |
|---|---|
| `--since <seq>` | Solo lo posterior a ese número de secuencia de la traza. |
| `--last <n>` | Solo los últimos `n` eventos de la traza. |

### `lynkeus profile`

```bash
lynkeus profile [action]
```

Muestra cuánto tiempo pasó React renderizando, por ruta. Lo mide el `Profiler` que monta `auto()`.

| Argumento | Qué es |
|---|---|
| `action` | Opcional. `start` borra lo anterior y empieza a grabar; `stop` informa y detiene. Sin argumento, informa lo grabado hasta ahora. |

La grabación está apagada hasta que la inicias, así que una app que nunca la pide no paga nada.

## Sistema operativo (`os`)

Estos comandos entregan a la app lo que normalmente viene de afuera: enlaces, el reloj, los sensores, la red. Algunos solo funcionan en el host sin pantalla, donde la capa nativa está simulada; otros solo en un simulador, donde lynkeus actúa desde afuera de la app. Cada uno lo indica.

Varios aceptan también una forma corta sin `os`, que se señala en cada comando.

### `lynkeus os deeplink`

```bash
lynkeus os deeplink <url>
```

Abre una URL en la app, tal como se la entregaría el sistema. Funciona en el host sin pantalla y en un dispositivo. Forma corta: `lynkeus deeplink`.

| Argumento | Qué es |
|---|---|
| `url` | Por ejemplo `myapp://pay/abc` o `https://…`. |

### `lynkeus os appstate`

```bash
lynkeus os appstate <state>
```

Solo sin pantalla. Cambia el estado de la app, y quienes escuchan `AppState` se enteran. Pasar a `background` y luego a `active` muestra qué se vuelve a pedir o qué se bloquea al volver. Forma corta: `lynkeus appstate`.

| Argumento | Qué es |
|---|---|
| `state` | `active`, `background` o `inactive`. |

### `lynkeus os network`

```bash
lynkeus os network <state>
```

Solo sin pantalla. Simula el modo avión: las peticiones fallan, los sockets abiertos se cortan y quienes escuchan `NetInfo` se enteran. Forma corta: `lynkeus network`.

| Argumento | Qué es |
|---|---|
| `state` | `off` u `on`. |

### `lynkeus os clock`

```bash
lynkeus os clock [--now <iso>] [--advance <ms>] [--reset]
```

Solo sin pantalla. Cambia lo que responde `Date`. Los temporizadores siguen siendo reales. Forma corta: `lynkeus clock`.

| Opción | Qué hace |
|---|---|
| `--now <iso>` | Fija la hora. |
| `--advance <ms>` | Adelanta el reloj. |
| `--reset` | Vuelve al reloj real. |

```bash
lynkeus os clock --now 2027-01-01T00:00:00Z
```

### `lynkeus os biometrics`

```bash
lynkeus os biometrics [--available <kind>] [--next <success,fail,cancel>] [--fallback <outcome>]
```

Solo sin pantalla. Define qué sensor hay y qué responden las próximas solicitudes de autenticación. Forma corta: `lynkeus biometrics`.

| Opción | Qué hace |
|---|---|
| `--available <kind>` | `FaceID`, `TouchID` o `none`. |
| `--next <success,fail,cancel>` | Los resultados de las próximas solicitudes, en orden y separados por comas. |
| `--fallback <outcome>` | Qué responde una solicitud de respaldo. |

```bash
lynkeus os biometrics --available FaceID --next fail,success
```

### `lynkeus os scan`

```bash
lynkeus os scan <value> [--type <qr|ean13|…>]
```

Solo sin pantalla. Entrega un valor al lector de códigos de la cámara que esté abierta. Forma corta: `lynkeus scan`.

| Argumento | Qué es |
|---|---|
| `value` | Lo que contiene el código. |

| Opción | Qué hace |
|---|---|
| `--type <qr\|ean13\|…>` | El tipo de código. Por defecto `qr`. |

### `lynkeus os gallery`

```bash
lynkeus os gallery [uri] [--cancel] [--name <name>] [--mime <type>]
```

Solo sin pantalla. Define qué responde el próximo selector de imágenes. Forma corta: `lynkeus gallery`.

| Argumento | Qué es |
|---|---|
| `uri` | Opcional. El archivo que devuelve el selector. |

| Opción | Qué hace |
|---|---|
| `--cancel` | El usuario canceló. |
| `--name <name>` | El nombre de archivo que se informa. |
| `--mime <type>` | El tipo MIME que se informa. |

### `lynkeus mock`

```bash
lynkeus mock [route] [--status <code>] [--body <json>] [--delay <ms>] [--times <n>] [--sticky] [--lost] [--clear] [--list]
```

Solo sin pantalla. Responde una petición antes de que llegue a la red. Con esto, un estado de error, una espera larga o una lista vacía se consiguen con una línea, sin preparar nada en el backend.

| Argumento | Qué es |
|---|---|
| `route` | Opcional. `'GET /path'`. Una ruta sin método coincide con cualquier método. |

| Opción | Qué hace |
|---|---|
| `--status <code>` | El estado HTTP de la respuesta. Por defecto `200`. |
| `--body <json>` | El cuerpo, en JSON. |
| `--delay <ms>` | Responde después de ese tiempo. |
| `--times <n>` | Aplica la regla solo esa cantidad de veces. |
| `--sticky` | Conserva la regla cuando la app se reinicia con `reset`. Sin esta opción, `reset` la borra. |
| `--lost` | Deja que la petición llegue al servidor y hace que falle en el camino de vuelta. |
| `--clear` | Borra todas las reglas. |
| `--list` | Muestra las reglas vigentes. |

```bash
lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000
lynkeus mock '/v3/accounts' --body '[]' --times 1
lynkeus mock --list
```

### `lynkeus os permissions`

```bash
lynkeus os permissions <action> <service>
```

Solo simulador. Concede, revoca o restablece un permiso de la app.

| Argumento | Qué es |
|---|---|
| `action` | `grant`, `revoke` o `reset`. |
| `service` | `camera`, `photos`, `location`, `microphone`, `contacts`, … |

### `lynkeus os push`

```bash
lynkeus os push <payload>
```

Solo simulador. Entrega una notificación push a la app.

| Argumento | Qué es |
|---|---|
| `payload` | Un JSON como `'{"alert":"…"}'`, o la ruta a un archivo `.json`. |

### `lynkeus os appearance`

```bash
lynkeus os appearance <mode>
```

Solo simulador. Cambia entre modo claro y oscuro.

| Argumento | Qué es |
|---|---|
| `mode` | `light` o `dark`. |

### `lynkeus os location`

```bash
lynkeus os location <where>
```

Solo simulador. Define dónde está el dispositivo.

| Argumento | Qué es |
|---|---|
| `where` | `<lat>,<lon>`, o `clear` para quitar la ubicación simulada. |

### `lynkeus os language`

```bash
lynkeus os language [tag]
```

Solo simulador. Vuelve a abrir la app en otro idioma.

| Argumento | Qué es |
|---|---|
| `tag` | Opcional. `de-DE`, `en-US`, … Si lo omites, se usa el idioma declarado en `lynkeus.config.json`. |

## Mapa (`map`)

El mapa es lo que lynkeus sabe de la app antes de tocarla. Tiene dos fuentes: el código fuente, que se lee una vez con `map build`, y los recorridos reales, que dejan `crawl` y las ejecuciones. Ninguno de estos comandos necesita la app corriendo, salvo que se indique.

### `lynkeus map build`

```bash
lynkeus map build [--as-base]
```

Lee el código fuente una vez y escribe en `.lynkeus/graph.json` las rutas, los `testID` y las navegaciones que encuentra.

| Opción | Qué hace |
|---|---|
| `--as-base` | Guarda además una copia como `graph.base.json`, contra la que compara `map check`. |

### `lynkeus map screens`

Lista todas las rutas del grafo y todas las que alguna ejecución abrió de verdad. No tiene argumentos ni opciones.

### `lynkeus map show`

```bash
lynkeus map show <route>
```

Muestra los `testID` y las navegaciones que una pantalla probablemente tiene, según el código fuente.

| Argumento | Qué es |
|---|---|
| `route` | Por ejemplo `Settings.Main`. |

### `lynkeus map paths`

```bash
lynkeus map paths <route>
```

Muestra qué lleva a una ruta: primero lo observado en recorridos reales, después lo deducido del código.

| Argumento | Qué es |
|---|---|
| `route` | Por ejemplo `Checkout.Confirm`. |

### `lynkeus map plan`

```bash
lynkeus map plan [--from <Route>] [--to <Route>]
```

Da indicaciones para ir de una ruta a otra: qué botón pulsar en cada pantalla. Forma corta: `lynkeus plan`.

| Opción | Qué hace |
|---|---|
| `--from <Route>` | La ruta de partida. |
| `--to <Route>` | La ruta de destino. |

### `lynkeus map impact`

```bash
lynkeus map impact <file>… [--depth <n>] [--direct]
```

Lista las pantallas a las que puede llegar un cambio en el código, de la más cercana a la más lejana.

| Argumento | Qué es |
|---|---|
| `file` | Uno o más archivos fuente modificados. |

| Opción | Qué hace |
|---|---|
| `--depth <n>` | A cuántas importaciones de distancia se busca. Por defecto `4`. |
| `--direct` | Solo la pantalla y quienes la importan directamente. |

### `lynkeus map ci`

```bash
lynkeus map ci [--force] [--depth <n>]
```

Escribe un workflow de GitHub que comenta en cada pull request qué pantallas alcanza su diff.

El archivo queda en `.github/workflows/lynkeus-map-check.yml`. En cada pull request construye el mapa desde el código (sin app ni dispositivo), ejecuta `map check` contra la rama base y mantiene un único comentario actualizado.

| Opción | Qué hace |
|---|---|
| `--force` | Sobrescribe el workflow si ya existe. |
| `--depth <n>` | A cuántas importaciones de distancia busca la comprobación. Por defecto `2`. |

### `lynkeus map check`

```bash
lynkeus map check [--base <ref>] [--graph-base <file>] [--depth <n>]
```

Describe una rama desde el punto de vista de la app: qué pantallas alcanza su diff y qué rutas, navegaciones o `testID` cambiaron.

| Opción | Qué hace |
|---|---|
| `--base <ref>` | La referencia de git contra la que se compara. Por defecto `main`. |
| `--graph-base <file>` | El grafo contra el que se compara. Por defecto `.lynkeus/graph.base.json`. |
| `--depth <n>` | A cuántas importaciones de distancia se busca. Por defecto `4`. |

### `lynkeus map changes`

```bash
lynkeus map changes [--last <n>]
```

Lista los `testID` que aparecieron, desaparecieron o se movieron en una pantalla grabada desde la última vez que se leyó. Solo tiene datos si antes grabaste pantallas con `lynkeus screen --record` o con `LYNKEUS_RECORD_SCREENS=1`.

| Opción | Qué hace |
|---|---|
| `--last <n>` | Cuántos cambios mostrar. Por defecto `30`. |

## Ejecuciones

Este grupo reúne todo lo que recorre la app de principio a fin: flows, casos, recorridos automáticos, grabaciones y los reportes que dejan.

Un **flow** es un archivo JSON con un nombre, las variables que necesita y una lista de pasos. Un **caso** es un archivo Markdown con `setup`, `steps` y `expected`; su formato está en [Formato de un caso](/es/reference/case-format/).

### `lynkeus run`

```bash
lynkeus run <flow.json> [--var <k=v>] [--screenshots] [--diff] [--events]
```

Reproduce un flow con sus variables. Informa por cada paso la duración, la ruta y los errores.

| Argumento | Qué es |
|---|---|
| `flow.json` | El archivo del flow. |

| Opción | Qué hace |
|---|---|
| `--var <k=v>` | Una variable del flow. Se puede repetir. |
| `--screenshots` | Toma una captura de pantalla por paso. |
| `--diff` | Imprime qué cambió en pantalla después de cada paso. |
| `--events` | Guarda los eventos de analítica de la app por paso, en `runs/…/events.jsonl`. Vacía el búfer de eventos de la app. |

```bash
lynkeus run flows/login.json --var phone=1124888418 --diff --screenshots
```

### `lynkeus events`

```bash
lynkeus events [--run <dir>] [--name <regex>]
```

Muestra lo que la app envió a su analítica. Sin `--run`, lo que lleva registrado hasta ahora, sin vaciarlo. Con `--run`, los eventos que guardó un `run --events`, cada uno con el paso y la ruta en que ocurrió.

| Opción | Qué hace |
|---|---|
| `--run <dir>` | La carpeta de una ejecución, o `last` para la más reciente. |
| `--name <regex>` | Solo los eventos cuyo nombre coincide. |

### `lynkeus events diff`

```bash
lynkeus events diff <before> <after>
```

Compara el mismo flow en dos builds: qué eventos aparecieron, desaparecieron o cambiaron de forma.

| Argumento | Qué es |
|---|---|
| `before` | La carpeta de la ejecución de referencia (la de `main`). |
| `after` | La carpeta de la ejecución de la rama, o `last`. |

### `lynkeus funnel check`

```bash
lynkeus funnel check <name> [--run <dir>]
```

Comprueba que una ejecución produjo un embudo: cada evento, en orden y con las propiedades que necesita. Termina con código `1` si falta un paso, está fuera de orden o tiene la forma equivocada.

Un embudo se declara en `.lynkeus/funnels/<name>.json`:

```json title=".lynkeus/funnels/signup.json"
{
  "steps": [
    { "event": "signup_started", "props": { "source": "string", "step": "number" } },
    { "event": "signup_completed" }
  ]
}
```

En `props`, cada propiedad nombra el tipo que necesita el tablero de analítica, o un valor concreto por el que filtra.

| Argumento | Qué es |
|---|---|
| `name` | El nombre del embudo. |

| Opción | Qué hace |
|---|---|
| `--run <dir>` | La carpeta de una ejecución, o `last`. Por defecto `last`. |

### `lynkeus funnel report`

```bash
lynkeus funnel report [--last <n>]
```

Recorre las ejecuciones guardadas y dice qué pasos de cada embudo produce alguna, y cuáles no produce ninguna.

| Opción | Qué hace |
|---|---|
| `--last <n>` | Cuántas ejecuciones recientes revisar. Por defecto `50`. |

### `lynkeus flake`

```bash
lynkeus flake <flow.json> [--times <n>] [--var <k=v>]
```

Ejecuta el mismo flow varias veces y dice cuántas pasó, y en qué paso y con qué error falló las demás. Convierte un test intermitente en un número y un paso.

| Argumento | Qué es |
|---|---|
| `flow.json` | El archivo del flow. |

| Opción | Qué hace |
|---|---|
| `--times <n>` | Cuántas ejecuciones. Por defecto `5`. |
| `--var <k=v>` | Una variable del flow. Se puede repetir. |

### `lynkeus smoke`

```bash
lynkeus smoke [Route.Prefix]… [--params <file>] [--screenshots] [--overlay-when <target>] [--overlay-flow <flow.json>]
```

Abre todas las rutas que no necesitan parámetros, o solo las que empiezan con los prefijos dados, y registra qué se renderiza en cada una.

| Argumento | Qué es |
|---|---|
| `Route.Prefix` | Opcional, repetible. Solo las rutas bajo estos prefijos. |

| Opción | Qué hace |
|---|---|
| `--params <file>` | El mapa de tipos de los parámetros de ruta, relativo a la carpeta de la app. |
| `--screenshots` | Toma una captura de pantalla por pantalla. |
| `--overlay-when <target>` | Un objetivo que la app muestra por su cuenta: una pantalla de bloqueo, un pedido de calificación. |
| `--overlay-flow <flow.json>` | El flow que lo quita de en medio. |

### `lynkeus crawl`

```bash
lynkeus crawl [Route] [--depth <n>] [--max <n>] [--to <Route>] [--fresh] [--overlay-when <target>] [--overlay-flow <flow.json>] [--login-flow <a.json,b.json>] [--var <k=v>] [--var-cmd <name='cmd'>] [--press-anything] [--verbose]
```

Pulsa todos los controles que encuentra y aprende adónde lleva cada uno. Lo que aprende alimenta a `map paths` y `map plan`.

Termina una pantalla antes de pasar a otra, y anota en `.lynkeus/frontier.jsonl` lo que no llegó a pulsar, así que una segunda ejecución continúa en lugar de repetir.

:::caution
Por defecto, el recorrido es de solo lectura. En cuanto una pulsación hace que la app escriba (un `POST`, `PUT`, `PATCH` o `DELETE`), `crawl` lo informa, deja de explorar más allá y no vuelve a pulsar ese control. Aun así, esa primera pulsación sí ocurre. Los controles que no deben pulsarse nunca van en `crawl.never`, en [`lynkeus.config.json`](/es/reference/configuration/). lynkeus no trae ninguna lista propia, porque cuáles controles son irreversibles depende de cada app.
:::

| Argumento | Qué es |
|---|---|
| `Route` | Opcional. Dónde empezar. Por defecto, la pantalla actual. |

| Opción | Qué hace |
|---|---|
| `--depth <n>` | Cuántas pantallas de profundidad. Por defecto `1`. |
| `--max <n>` | Cantidad máxima de pulsaciones. Por defecto `80`. |
| `--to <Route>` | Camina hacia esa ruta y se detiene al llegar, en lugar de explorarlo todo. |
| `--fresh` | Ignora lo que ejecuciones anteriores ya pulsaron. |
| `--overlay-when <target>` | Un objetivo que la app muestra por su cuenta. |
| `--overlay-flow <flow.json>` | El flow que lo quita de en medio. |
| `--login-flow <a.json,b.json>` | Los flows que vuelven a iniciar sesión después de un reinicio, separados por comas. |
| `--var <k=v>` | Una variable de flow. Se puede repetir. |
| `--var-cmd <name='cmd'>` | Una variable que se obtiene ejecutando un comando de shell cuando hace falta. Se puede repetir. |
| `--press-anything` | Sigue explorando después de una pulsación que escribió. Solo para un entorno descartable. |
| `--verbose` | Imprime cada recuperación y cada decisión. |

### `lynkeus record`

```bash
lynkeus record [--out <flow.json>] [--so-far] [--screenshots]
```

Observa lo que una persona hace en la app. Al pulsar Ctrl-C escribe un flow con cada paso y lo que causó.

Los toques solo se registran en builds de dispositivo montados con `auto()`; un host sin pantalla registra únicamente rutas y peticiones. Mientras graba, las líneas que escribas por la entrada estándar se ejecutan como comandos.

| Opción | Qué hace |
|---|---|
| `--out <flow.json>` | Dónde escribir el flow. |
| `--so-far` | Arma un borrador con la traza tal como está y termina. |
| `--screenshots` | Toma una captura de pantalla por toque. Quedan listadas en `<out>.strip.md`. |

### `lynkeus snapshot`

```bash
lynkeus snapshot <name> [--update] [--pixels] [--tolerance <ratio>] [--no-freeze]
```

Guarda una referencia de una pantalla y compara contra ella: su árbol y, en un simulador, sus píxeles.

El árbol es la pantalla como líneas anidadas de significado: tipos, etiquetas, `testID`, valores y estados, sin geometría. Un título renombrado o un botón que desapareció es una línea que cambia. Las referencias se guardan en `.lynkeus/snapshots/` y las diferencias en `runs/`.

| Argumento | Qué es |
|---|---|
| `name` | El nombre de la referencia, por ejemplo `onboarding-hero`. |

| Opción | Qué hace |
|---|---|
| `--update` | El cambio es intencional: sobrescribe la referencia. |
| `--pixels` | Compara también una captura de pantalla. Solo simulador. |
| `--tolerance <ratio>` | Qué fracción de los píxeles puede diferir. Por defecto `0.001`. |
| `--no-freeze` | No fija la barra de estado antes de la captura. |

### `lynkeus case run`

```bash
lynkeus case run [files]… [opciones]
```

Ejecuta casos: prepara el backend con los fixtures, corre los pasos contra la app y, si uno falla, guarda la evidencia.

Sin archivos, ejecuta todos los casos de `cases.dir`. Un caso que falla se ejecuta una vez más antes de darse por fallido, salvo que uses `--once`. El comando termina con código `0` si ningún caso falló, `1` si alguno falló y `2` si las opciones no son coherentes entre sí.

| Argumento | Qué es |
|---|---|
| `files` | Opcional, repetible. Los archivos de los casos. Por defecto, todos los `.md` bajo `cases.dir`. |

Opciones que deciden qué se ejecuta y cómo:

| Opción | Qué hace |
|---|---|
| `--host` | Arranca `headless start` para la ejecución y lo detiene al terminar. |
| `--once` | No da una segunda oportunidad al caso que falla. |
| `--continue` | Sigue ejecutando los pasos de un caso después de que uno falla. Si lo que falla es el `setup`, el caso se detiene igual. |
| `--dry-run` | Analiza los casos y lista sus pasos sin ejecutarlos. Detecta pasos mal escritos. |
| `--prepared <dir>` | Dónde deja `case prepare` los `setup` hechos por adelantado. Un caso que encuentra el suyo allí se lo salta. |

Opciones que deciden qué queda guardado:

| Opción | Qué hace |
|---|---|
| `--out <dir>` | Escribe la ejecución como un directorio que un reporte puede leer: `run.json` y `cases.jsonl`, con una línea por intento. |
| `--screenshots` | Con `--out`: una captura de pantalla después de cada paso de la app. |
| `--video` | Con `--out`: graba cada caso en video, donde el host puede hacerlo. Cada paso indica en qué segundo empezó. |
| `--video-fps <n>` | Cuadros por segundo del video. Por defecto `30`. |
| `--report <file>` | Agrega al archivo una línea de JSON por caso. |
| `--events <dir>` | Guarda lo que la app envió a su analítica, por caso, en `<dir>/<id del caso>/events.jsonl`. |
| `--seen <dir>` | Escribe `<dir>/<id del caso>.json` con las pantallas por las que pasó cada caso que aprobó, para armar un mapa de cobertura. |
| `--flakes <file>` | El registro de cómo le fue a cada caso a lo largo de las ejecuciones. Por defecto `.lynkeus/flakes.json`. |

Opciones para el reporte y las trazas del backend:

| Opción | Qué hace |
|---|---|
| `--push` | Con `--out`: sube la ejecución al servicio de reportes cuando termina e imprime la dirección del reporte. |
| `--project <name>` | Con `--push`: el proyecto bajo el que se archiva. Por defecto, el nombre de la carpeta de la app. |
| `--traces` | Escucha las trazas de OpenTelemetry del backend (OTLP sobre HTTP) y guarda, bajo cada paso, lo que el backend hizo por él. El backend tiene que exportar a `http://localhost:<traces-port>` con `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| `--traces-port <port>` | El puerto donde escucha `--traces`. Por defecto `4318`. |

Opciones para ejecutar en paralelo:

| Opción | Qué hace |
|---|---|
| `--jobs <n>` | Cuántos casos a la vez, cada uno en su propio host. Requiere `--ports`. Por defecto `1`. |
| `--ports <list>` | El puerto del driver para cada job, separados por comas: es adonde se conecta su host. |
| `--host-command <command>` | Un comando que arranca un host nuevo para cada caso y lo detiene después. `{port}` se reemplaza por el puerto al que se conecta el host y `{job}` por el número de job. |
| `--in-order` | Con `--jobs`: toma los casos en el orden dado, en lugar de empezar por los más largos. |
| `--ahead <n>` | Prepara hasta esa cantidad de `setup` por adelantado mientras otros casos corren. `0` significa ninguno. Por defecto `0`. |
| `--idle <share>` | Con `--ahead`: empieza un `setup` solo mientras esa fracción de la CPU esté libre. Por defecto `0.25`. |

```bash
# Un caso, alojando la app en Node durante la ejecución
lynkeus case run cases/gift.md --host

# Toda la suite, con evidencia y reporte publicado
lynkeus case run --out run --screenshots --video --push

# Cuatro casos a la vez, cada uno en su host
lynkeus case run --jobs 4 --ports 8123,8124,8125,8126 \
  --host-command 'LYNKEUS_PORT={port} npx lynkeus headless start'
```

Si mezclas opciones que dependen unas de otras, el comando lo dice y no ejecuta nada. Estos son los mensajes:

- `--screenshots and --video keep what they take in the run directory: add --out <dir>`
- `--push uploads the run directory: add --out <dir>`
- `--jobs and --host-command need a driver port per job: --ports with <n>`

### `lynkeus case prepare`

```bash
lynkeus case prepare [files]… [--prepared <dir>] [--jobs <n>] [--ahead <n>] [--idle <share>]
```

Ejecuta el `setup` de los casos antes que ellos, para que cada uno arranque directamente en su primer paso.

Está pensado para una suite que lanza `case run --prepared <dir>` una vez por caso. Arráncalo primero, con los mismos casos y en el orden en que van a correr, y déjalo corriendo. Solo adelanta los `setup` hechos únicamente con fixtures del proyecto. Si un caso empieza antes de que su `setup` esté listo, lo ejecuta él mismo y `case prepare` lo saltea.

Avisa al servidor de fixtures de que trabaja por adelantado (con el comando `lynkeus.ahead`), para que el servidor pueda darle menor prioridad que a los casos en curso.

| Argumento | Qué es |
|---|---|
| `files` | Opcional, repetible. Los casos, en el orden en que van a ejecutarse. Por defecto, todos los `.md` bajo `cases.dir`. |

| Opción | Qué hace |
|---|---|
| `--prepared <dir>` | Dónde dejar los `setup`. El directorio se vacía primero. Por defecto `.lynkeus/prepared`. |
| `--jobs <n>` | Cuántos `setup` se hacen a la vez. Por defecto `1`. |
| `--ahead <n>` | Cuántos `setup` listos y sin usar se mantienen, como máximo. Por defecto `4`. |
| `--idle <share>` | Empieza un `setup` solo mientras al menos esa fracción de la CPU esté libre, de 0 a 1. Por defecto `0.25`. |

### `lynkeus case init`

```bash
lynkeus case init [--force]
```

Escribe un caso de ejemplo, la referencia del formato y un servidor de fixtures del que partir.

| Opción | Qué hace |
|---|---|
| `--force` | Sobrescribe lo que ya exista. |

### `lynkeus report push`

```bash
lynkeus report push <dir> [--project <name>]
```

Sube una ejecución al servicio de reportes e imprime la dirección del reporte.

Sube lo que escribió `case run --out <dir>`: la ejecución, sus casos y cada captura y video que nombran. La dirección del servicio y la clave de la organización se leen de `LYNKEUS_REPORTS_URL` y `LYNKEUS_REPORTS_KEY`. Un video que el plan de la organización no conserva queda fuera, y el comando lo avisa con `not kept on this plan: …`.

| Argumento | Qué es |
|---|---|
| `dir` | El directorio que escribió `case run --out`. |

| Opción | Qué hace |
|---|---|
| `--project <name>` | El proyecto bajo el que se archiva. Por defecto, el nombre de la carpeta de la app. |

### `lynkeus report list`

```bash
lynkeus report list [--limit <n>]
```

Lista los reportes de la organización, del más nuevo al más viejo. Cada línea muestra cuándo empezó la ejecución, su proyecto y plataforma, cuántos casos pasaron y la dirección del reporte.

| Opción | Qué hace |
|---|---|
| `--limit <n>` | Cuántas ejecuciones. Por defecto `20`, como máximo `100`. |

### `lynkeus report plan`

```bash
lynkeus report plan [--upgrade] [--manage]
```

Muestra el plan de la organización, o imprime la dirección de la página donde se cambia.

El plan Free conserva las capturas durante 7 días y admite un proyecto. El plan Team conserva también los videos, durante 90 días, y admite cualquier cantidad de proyectos.

| Opción | Qué hace |
|---|---|
| `--upgrade` | Imprime la dirección del checkout de Stripe para el plan Team. |
| `--manage` | Imprime la dirección del portal de Stripe de una organización que ya paga: tarjeta, facturas y cancelación. |

### `lynkeus report flakes`

```bash
lynkeus report flakes [--project <name>] [--runs <n>]
```

Lista los casos que no siempre pasan al primer intento, según las últimas ejecuciones del proyecto. Disponible en el plan Team.

Los ordena del menos confiable al más confiable. Cada línea muestra las ejecuciones recientes, de la más nueva a la más vieja (`✓` pasó, `↻` pasó al reintentar, `✗` falló), y el último reporte donde salió mal. Un caso que falló en sus últimas tres ejecuciones se marca como roto, no como intermitente.

| Opción | Qué hace |
|---|---|
| `--project <name>` | El proyecto. Por defecto, el nombre de la carpeta de la app. |
| `--runs <n>` | Cuántas de las últimas ejecuciones leer. Por defecto `30`. |

### `lynkeus report history`

```bash
lynkeus report history <case> [--project <name>] [--runs <n>]
```

Muestra cómo le fue a un caso en cada una de las últimas ejecuciones del proyecto, de la más nueva a la más vieja: el resultado, la duración, la rama y el commit desde los que se hizo la ejecución, y el reporte para abrir. Es lo que distingue un caso que falla de vez en cuando de uno que un commit rompió.

| Argumento | Qué es |
|---|---|
| `case` | El id del caso. |

| Opción | Qué hace |
|---|---|
| `--project <name>` | El proyecto. Por defecto, el nombre de la carpeta de la app. |
| `--runs <n>` | Cuántas de las últimas ejecuciones leer. Por defecto `50`. |

## Host sin pantalla (`headless`)

El host sin pantalla ejecuta la app en Node, bajo jest, sin simulador. Habla el mismo protocolo que un dispositivo, así que todos los comandos de [Manejar la app](#manejar-la-app) funcionan igual. Lo específico de este host está en [Host sin pantalla](/es/platforms/headless/).

### `lynkeus headless start`

```bash
lynkeus headless start [--entry <file>] [-- <argumentos de jest>]
```

Aloja la app en Node (jest y React Native Testing Library) y espera a que se conecte un driver. Forma corta: `lynkeus headless`.

Necesita `LYNKEUS_TOKEN` en el entorno, con el mismo valor que la app lee para su token; sin él, se niega a arrancar. `LYNKEUS_PORT` mueve juntos al host y a su driver. `LYNKEUS_HOST` indica dónde escucha el driver cuando el host no está en la misma máquina, por ejemplo un contenedor que se conecta hacia afuera. Lo que escribas después de `--` se le pasa a jest.

Cuando el host se cae, las últimas líneas dicen qué suele significar el error y cómo se arregla.

| Opción | Qué hace |
|---|---|
| `--entry <file>` | El archivo de entrada del host. Si no la das, se usa `entry` de la configuración y, si tampoco está, `qa/headless.tsx`. |

```bash
LYNKEUS_TOKEN=secreto npx lynkeus headless start
```

### `lynkeus headless init`

```bash
lynkeus headless init [--entry <file>] [--component <App.tsx>] [--api-env <NAME>] [--auto] [--force]
```

Escribe el archivo de entrada del host: los mocks por defecto, una comprobación de que el backend es local y tu componente `App`.

| Opción | Qué hace |
|---|---|
| `--entry <file>` | Dónde escribir la entrada. Por defecto, `entry` de la configuración o `qa/headless.tsx`. |
| `--component <App.tsx>` | El archivo del componente `App`. Si está en un lugar habitual, se encuentra solo. |
| `--api-env <NAME>` | La variable de entorno de la que la app lee la dirección de su API. Por defecto, `apiEnv` de la configuración o `API_URL`. |
| `--auto` | Además monta el agente desde `index.js` con `auto()`. |
| `--force` | Sobrescribe una entrada existente. |

### `lynkeus headless doctor`

```bash
lynkeus headless doctor [--entry <file>] [--fix] [--explain <text>]
```

Dice qué módulos nativos simula lynkeus y cuáles todavía necesitan un mock.

| Opción | Qué hace |
|---|---|
| `--entry <file>` | El archivo de entrada del host. |
| `--fix` | Escribe en la entrada mocks vacíos para los módulos que faltan cubrir. |
| `--explain <text>` | Convierte un error de jest en su causa habitual y su arreglo. |

```bash
lynkeus headless doctor --explain "TurboModuleRegistry.getEnforcing(...): 'RNDeviceInfo' could not be found"
```

## Modos

Cada invocación del CLI paga por arrancar un proceso y abrir una conexión, alrededor de 1,5 s. Para ejecutar muchos comandos seguidos hay dos modos que mantienen una sola conexión abierta.

### `lynkeus session`

Mantiene una conexión y lee comandos por la entrada estándar. Cada línea es un arreglo JSON de argumentos y cada respuesta es un objeto JSON en una línea. Así, un paso cuesta unos 50 ms.

```bash
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
```

Al conectarse imprime `{"ok":true,"out":"attached (…)"}`. Después, cada respuesta tiene una de estas dos formas:

```json
{ "ok": true, "out": "…", "json": { } }
{ "ok": false, "error": "…", "why": "…" }
```

`json` aparece cuando el comando tiene una salida estructurada, y `why` cuando hay un diagnóstico del fallo. La línea `["exit"]` termina la sesión.

No todos los comandos están disponibles dentro de una sesión. Quedan fuera los que ejecutan un recorrido entero o alojan la app (`run`, `smoke`, `crawl`, `record`, `case run`, `headless start`) y los que no necesitan una app conectada (los de `report`, `map build`). Si pides uno de ellos, la respuesta es `<comando> is not available in a session`. `lynkeus help <comando>` dice, en su última línea, si el comando se puede usar en una sesión.

### `lynkeus mcp`

Sirve los comandos como herramientas MCP por la entrada y salida estándar, para que un agente de IA maneje la app. Por defecto ofrece los que hacen falta en cada turno: `screen`, `press`, `type`, `wait`, `why`, `call`, `os deeplink`, `map show` y `map plan`.

| Opción | Qué hace |
|---|---|
| `--full` | Sirve todos los comandos. Cuesta alrededor de cinco veces más tokens por turno. |

La guía [Agentes de IA](/es/guides/ai-agents/) explica cómo conectarlo.

### `lynkeus help`

| Forma | Qué imprime |
|---|---|
| `lynkeus help` | El resumen de todos los comandos. Es lo mismo que ejecutar `lynkeus` sin argumentos o con `--help`. |
| `lynkeus help <comando>` | La ayuda de un comando, por ejemplo `lynkeus help case run`. |
| `lynkeus help --markdown` | La referencia completa en Markdown. |

### `lynkeus commands`

Imprime el nombre de cada comando, uno por línea. Es útil para scripts y para el autocompletado.

## Opciones globales

Cualquier comando acepta estas opciones.

| Opción | Qué hace |
|---|---|
| `--root <dir>` | La carpeta de la app. Por defecto, la carpeta actual. Allí se buscan `lynkeus.config.json` y `.lynkeus/`. |
| `--device <udid\|name>` | El UDID o el nombre del simulador. |
| `--app <bundleId>` | El identificador de la app, para abrirla y para los comandos del simulador. |
| `--launch` | Vuelve a abrir la app antes de conectarse. Requiere `--app`. |
| `--attach-timeout <ms>` | Cuánto esperar a que la app se conecte. Por defecto `15000`. |
| `--json` | Salida legible por programas, cuando el comando la tiene. |
| `--help` | Muestra la ayuda. |

Casi todas tienen un equivalente en el entorno y otro en el archivo de configuración. Cuando el mismo valor aparece en más de un lugar, la opción de la línea de comandos gana sobre la variable de entorno, y la variable de entorno sobre el archivo.

| Opción | Variable de entorno | Clave en `lynkeus.config.json` |
|---|---|---|
| `--device` | `LYNKEUS_DEVICE` | `device` |
| `--app` | `LYNKEUS_APP_ID` | `app` |
| `--attach-timeout` | `LYNKEUS_ATTACH_TIMEOUT_MS` | `attachTimeout` |
| (no tiene) | `LYNKEUS_PORT` | `port` |

Las variables están descritas en [Variables de entorno](/es/reference/environment-variables/) y las claves en [Configuración](/es/reference/configuration/).
