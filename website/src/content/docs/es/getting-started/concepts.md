---
title: Conceptos
description: "El vocabulario de lynkeus, término por término: agente, driver, host, pantalla, elemento, objetivo, ruta, caso, paso, ejecución, fixtures y reporte."
---

Esta página define las palabras que usa el resto de la documentación. Cada una tiene un significado preciso, y la mayoría de las confusiones al empezar vienen de mezclar dos de ellas: host con driver, pantalla con árbol, caso con ejecución.

Están ordenadas de modo que cada término se apoye en los anteriores. Si recién llegas, léela de corrido una vez; después sirve como referencia.

## Las tres partes: agente, driver y host

Un test con lynkeus involucra siempre tres cosas: algo dentro de la app, algo que da las órdenes y un lugar donde la app corre.

### Agente

El **agente** es el código de `lynkeus-agent` montado dentro de tu app. En un build de depuración abre una conexión WebSocket hacia tu máquina y responde pedidos: qué hay en pantalla, toca esto, escribe aquello, espera tal ruta.

La dirección de la conexión es lo que hay que recordar. La app llama hacia afuera; nada queda escuchando dentro de ella.

### Driver

El **driver** es quien sostiene el otro extremo de esa conexión y decide qué pedir. Casi siempre es el CLI (`npx lynkeus`). También puede ser un programa tuyo en Node construido sobre `lynkeus-client`, un servidor MCP delante de un modelo de IA, o un trabajo de CI.

El agente no sabe ni le importa cuál es. Todos hablan el mismo protocolo, descrito en [Protocolo](/es/reference/protocol/).

### Host

El **host** es el lugar donde corre la app durante el test. Puede ser:

- un simulador de iOS o un emulador de Android, donde la capa nativa es real;
- el **host sin pantalla** (*headless*), que `lynkeus headless start` levanta en Node: renderiza la app bajo Jest y React Native Testing Library, con la capa nativa reemplazada por mocks.

En los tres, el agente se conecta de la misma manera, así que los mismos comandos y los mismos casos sirven en cualquiera. Lo que cambia es qué es real. La comparación completa está en [Sin pantalla (headless)](/es/platforms/headless/).

:::note
En los mensajes del CLI y en los nombres de las opciones, "host" a secas suele referirse al host sin pantalla. Por ejemplo, `case run --host` significa "aloja la app en Node para esta ejecución". Dentro de un caso, la condición `on: device` distingue el simulador o emulador, y `on: headless` el host sin pantalla.
:::

## Lo que lynkeus ve

### Pantalla

La **pantalla** es la app tal como React la renderizó hace un instante. Es lo que devuelve `lynkeus screen`: la ruta actual, la cadena de navegadores y todos los elementos que una persona podría ver o tocar.

No es lo mismo que el árbol de componentes. Una app mantiene montado mucho más de lo que muestra: las otras pestañas, la pantalla que quedó debajo de una hoja. La pantalla deja eso afuera y solo lo cuenta.

Tampoco es una imagen. Es una lista de hechos, y por eso se lee en milisegundos.

### Elemento

Un **elemento** es cada cosa que aparece en la pantalla. Tiene:

- un **tipo**: `button`, `input`, `text`, `scroll`, `switch`, `image` o `view`;
- un marco, es decir, su posición y tamaño en puntos de la ventana;
- lo que lleve consigo: su `testID`, su texto o etiqueta de accesibilidad, y en un campo de entrada, su **valor**, su texto de ayuda y si tiene el foco. El valor de un campo con `secureTextEntry` aparece enmascarado.

Tres estados importan más que el resto:

| Estado | En el listado | Qué significa |
|---|---|---|
| deshabilitado | `!disabled` | El control no va a responder a un toque. |
| tapado | `~covered` | Un toque en su centro caería sobre otra cosa. Lo determina la propia plataforma. |
| oculto | no se lista; se cuenta en la primera línea | La app no lo está presentando: pertenece a otra pestaña o a la pantalla que una hoja cubre. |

Un cuarto estado, `~inert`, marca un elemento que se puede leer pero no tocar.

Cuando la pantalla presenta una hoja o un diálogo, la primera línea lo nombra, por ejemplo `+overlay#account-sheet`.

### Objetivo

Un **objetivo** es la forma de señalar un elemento en un comando o en un paso. Se escribe de cuatro maneras:

| Forma | Señala |
|---|---|
| `#next-button` | el elemento con ese `testID` |
| `"Continue"` | un control (botón o campo) por su texto exacto y, si no hay, por una parte; un párrafo, solo por su texto exacto |
| `12` | el elemento con ese índice en el último listado de la pantalla |
| `100,200` | un punto, en puntos de la ventana |

Dos reglas resuelven los casos dudosos. Un elemento tapado nunca coincide. Y cuando dos elementos empatan, gana el último, porque es el que se dibuja encima.

Si un control se repite en cada fila de una lista, el objetivo se acota: `--in` elige la coincidencia más cercana a otro objetivo y `--nth` la enésima. Lo explica [Manejar la app](/es/guides/driving-the-app/).

### Ruta

Una **ruta** es el nombre de una pantalla tal como lo informa la navegación de la app, por ejemplo `Settings.Main` o `Checkout.Confirm`. El **camino** es la cadena de navegadores desde la raíz hasta la pantalla enfocada; en la primera línea de `lynkeus screen` aparece entre paréntesis.

Las rutas no las inventa lynkeus. Vienen de un **adaptador de navegación**, la pieza que traduce entre el agente y el enrutador de tu app. El paquete incluye uno para React Navigation, y `auto()` lo conecta solo. Sin adaptador, lynkeus sigue viendo elementos pero no rutas, y `wait Settings.Main` no tiene qué esperar.

`wait` y `see` reconocen una ruta por su mayúscula inicial. Una ruta en minúscula, como las de expo-router, se escribe con el prefijo `route:`, por ejemplo `route:index` (todavía no publicado).

## Lo que escribes y ejecutas

### Caso

Un **caso** es un test escrito como archivo markdown, pensado para que lo lea una persona. Tiene un encabezado que lo identifica (`id`, `title`) y hasta tres secciones:

| Sección | Qué contiene |
|---|---|
| `setup` | Lo que tiene que existir antes de empezar. |
| `steps` | Lo que hace la persona y lo que debe ser cierto después. |
| `expected` | Una frase en prosa que dice qué demuestra el caso. |

```yaml title="cases/settings-dark-mode.md"
---
id: settings-dark-mode
title: "Ajustes: cambiar a modo oscuro"
---
steps:
  - app.press: "#settings-button"
  - app.wait: Settings.Main
  - app.press: "Dark"
  - app.see: { testId: theme-dark-selected }
```

En esta documentación, "test" es la idea general y "caso" es el archivo o el comando (`lynkeus case run`). El formato completo está en [Formato de los casos](/es/reference/case-format/).

### Paso

Un **paso** es cada línea de `setup` o de `steps`. Hay dos familias, y se distinguen por el nombre:

- Los que empiezan con `app.` manejan la app: `app.press`, `app.type`, `app.wait`, `app.see`, `app.nav`. Son los comandos del CLI con otro prefijo.
- Cualquier otro nombre es un fixture (más abajo), salvo `assert`, que lee el backend, y `exec`, que ejecuta un comando de la terminal.

Un paso termina de una de cuatro maneras: pasó, falló, se omitió, o **no es compatible** con este host. Este último caso ocurre cuando el host no tiene forma de hacer lo que se pide, por ejemplo simular una respuesta de red en un dispositivo real. No cuenta como fallo: el caso se detiene ahí y se informa como uno que no puede ejecutarse en este host.

### Fixtures

Los **fixtures** son los datos de prueba que se preparan en el backend antes o durante un caso: un usuario creado, un saldo asignado, un estado forzado.

lynkeus no sabe cómo es tu backend. Lo que hace es delegar: cada paso que no empieza con `app.` se envía, como una línea de JSON, a un comando que declaras en `lynkeus.config.json`, y se lee una línea de respuesta. Ese comando puede ser un script de Node, un *runner* de Rails o un contenedor.

```yaml
setup:
  - create_user: { as: u, name: "Ana" }
```

Aquí `create_user` es un fixture, y `as: u` guarda su respuesta para usarla después como `{{u.user_id}}`. La guía es [Fixtures](/es/guides/fixtures/).

### Ejecución

Una **ejecución** es una corrida de `lynkeus case run`: uno o varios casos, sobre un host, en un momento dado.

Dentro de una ejecución, cada caso tiene uno o dos **intentos**. Un caso que falla se ejecuta una vez más antes de contar como fallido. Si pasa en el segundo intento, se informa como aprobado en el reintento. Un test que a veces pasa y a veces no es un test **intermitente**; la guía [Tests intermitentes](/es/guides/flaky-tests/) explica cómo distinguirlo de uno roto.

Con `--out <dir>`, la ejecución se escribe como un directorio que otro programa puede leer sin saber cómo se hizo:

| Archivo | Contenido |
|---|---|
| `run.json` | Cuándo empezó y terminó, sobre qué corrió la app, los totales. |
| `cases.jsonl` | Una línea por intento de cada caso, en el orden en que corrieron, con sus pasos. |

### Reporte

Un **reporte** es la vista de una ejecución hecha para personas. Muestra cada caso paso a paso, con la captura de pantalla o el video de cada momento, los eventos que la app envió a su analítica y por qué falló lo que falló.

Se obtiene subiendo el directorio de la ejecución al servicio de reportes de [lynkeus.io](https://lynkeus.io), con `case run --out <dir> --push` o con `lynkeus report push <dir>`. La guía es [Reportes](/es/guides/reports/).

## Dónde guarda las cosas

### La carpeta `.lynkeus/`

Todo lo que lynkeus genera queda en `.lynkeus/`, dentro de la carpeta de la app. Es un producto de compilación: se puede borrar sin riesgo y se regenera.

### `lynkeus.config.json`

Los valores que de otro modo repetirías en cada comando van en `lynkeus.config.json`, en la carpeta de la app: el puerto, el simulador, el identificador de la app, la carpeta de los casos, el comando de fixtures.

Cuando el mismo valor está en más de un lugar, el orden de prioridad es: la opción del comando gana sobre la variable de entorno, y la variable de entorno sobre el archivo. Todas las claves están en [Configuración](/es/reference/configuration/).

### El token y el puerto

`LYNKEUS_TOKEN` es el secreto compartido entre la app y su driver. El agente solo atiende a quien lo presenta.

`LYNKEUS_PORT` mueve juntos a la app, al host y al driver. Sirve para tener varias parejas en la misma máquina sin que se crucen. El puerto por defecto es 8123.

## Lo que lynkeus no sabe

lynkeus no sabe nada de tu producto. No tiene una lista de tus pantallas, no sabe qué hacen tus botones, no tiene noción de usuario ni de sesión. Todo lo que informa lo leyó de la app en ejecución o de tu código fuente.

Esto es una decisión de diseño, y tiene una consecuencia práctica. Cuando una decisión requiere conocer el producto (cómo se inicia sesión, qué estado necesita un caso, qué pantalla interrumpe a las demás) la respuesta la das tú, en `lynkeus.config.json` o en tu comando de fixtures. La herramienta nunca fabrica estado por su cuenta.

## Próximos pasos

- [Tu primer test](/es/getting-started/first-test/), si todavía no ejecutaste ninguno.
- [Manejar la app](/es/guides/driving-the-app/): todos los comandos, con ejemplos.
- [Escribir casos](/es/guides/writing-cases/): el formato en la práctica.
