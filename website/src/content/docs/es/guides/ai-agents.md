---
title: Agentes de IA
description: Cómo dejar que un agente de IA maneje la app con lynkeus mcp, qué herramientas recibe, cómo lee una pantalla y qué instrucciones darle para que no gaste su contexto.
---

Un agente de IA que prueba una app a partir de capturas de pantalla trabaja a ciegas y caro: cada imagen cuesta miles de tokens y solo le permite suponer dónde está el botón. lynkeus le da otra cosa: la pantalla como una lista de hechos. Qué ruta está abierta, qué elementos hay, cuáles se pueden tocar y cuáles están cubiertos. Con eso el modelo decide el siguiente paso a partir de datos y no de píxeles.

El puente es MCP (Model Context Protocol), el protocolo con el que un cliente como Claude Code o Cursor le ofrece herramientas a un modelo. `lynkeus mcp` sirve los comandos de lynkeus como herramientas MCP. Esta guía es para quien configura ese agente: cómo conectarlo, qué recibe y qué conviene escribir en sus instrucciones.

## Antes de empezar

- Una app de React Native, sin framework o con Expo, que puedas compilar y abrir en un simulador o un emulador. (En esta página, "el agente" a secas es el de IA; el de lynkeus es `lynkeus-agent`.)
- Un cliente de IA que admita servidores MCP por entrada y salida estándar.

:::note[Desde 0.4.0]
El servidor configura la app por su cuenta (`init`, `status`) y corre casos (`case_run`). Con una versión anterior, instala el agente como explica [Instalación](/es/getting-started/installation-react-native/), define `LYNKEUS_TOKEN` en el entorno con el que el cliente arranca el servidor y corre los casos desde una terminal.
:::

## 1. Conecta el servidor

`lynkeus mcp` es un servidor por entrada y salida estándar: el cliente lo arranca como proceso hijo y le habla por ahí. No lo ejecutes a mano. En Claude Code, desde la carpeta de la app:

```bash
claude mcp add lynkeus -- npx -y lynkeus mcp
```

En Cursor, en `.cursor/mcp.json`:

```json
{ "mcpServers": { "lynkeus": { "command": "npx", "args": ["-y", "lynkeus", "mcp"] } } }
```

El servidor trabaja en la carpeta donde lo arranca el cliente, o en la que indique `--root <carpeta>`. Para que el agente pueda subir corridas a lynkeus.io, agrega al entorno del servidor `LYNKEUS_REPORTS_KEY` con una API key de tu organización (`-e LYNKEUS_REPORTS_KEY=lk_…` en Claude Code); la página de API keys muestra la línea con la key ya puesta.

Deberías ver las herramientas de lynkeus en la lista de tu cliente.

## 2. Pídele que configure lynkeus

Con palabras comunes:

```text
Configura lynkeus en esta app.
```

Al conectarse, el servidor le explica al modelo el orden a seguir. El agente llama a `status`, que lista lo que el proyecto tiene y qué arregla cada pieza que falta, y después a `init`, que instala `lynkeus-agent`, lo monta en el punto de entrada de la app y crea el token del proyecto en `.lynkeus/token` (fuera de git). Nadie define variables: el bundle de la app, la CLI y el servidor leen ese archivo.

El agente de lynkeus tiene código nativo, así que hay que compilar la app de nuevo (`npx react-native run-ios`, o `npx expo run:ios` en Expo) y reiniciar Metro con `--reset-cache`. Un agente con terminal lo hace solo; si no, te lo pide. Después `status` muestra la app conectada y el agente ya puede leer la pantalla.

Para correr sin simulador, pídele que la prepare en modo headless: `headless_init` instala jest, Testing Library y `lynkeus-headless` y escribe el punto de entrada, `headless_doctor` nombra los módulos nativos que falten simular, y los casos corren en Node con `case_run` y `host`. El backend de la app tiene que ser local; `apiUrl` en `lynkeus.config.json` se lo indica al host.

## 3. Pídele un test

```text
Escribe un test para la pantalla de inicio de sesión, córrelo y sube la corrida.
```

La primera vez el agente llama a `case_init`, que escribe un caso de ejemplo y la referencia del formato. Después lleva la app a la pantalla con `press`, `type` y `wait`, escribe el caso como archivo markdown y lo corre con `case_run`. Un caso que falla vuelve con la pantalla donde falló y el motivo, para que el agente corrija el caso o reporte el error de la app. Con `push`, la corrida sube a lynkeus.io y el agente tiene la dirección del reporte apenas arranca: no hace falta esperar al final, porque el reporte se va completando caso por caso.

Hay dos atajos para no escribir el caso desde cero. `case_here` arma uno con lo que la app muestra en ese momento, con verificaciones que ya pasan. `case_new` arma el borrador para otra pantalla: los toques para llegar, la preparación del backend que ofrece el servidor de fixtures y las verificaciones que quedan por escribir. Para saber qué puede preparar ese servidor, el agente llama a `fixtures_describe`.

Si el caso es largo, conviene partirlo. La referencia que escribe `case_init` le enseña al agente a abrir cada parte de `steps` con un comentario numerado (`# 3 Un PIN equivocado`), con la misma numeración que la lista de `expected`. El reporte agrupa los pasos según esas secciones, y quien lo lee encuentra cada parte sin abrir el archivo.

Cuando el caso simula una respuesta con `app.mock`, esa petición aparece marcada `(mocked)` en `requests`, en `trace` y en la evidencia de un fallo. El diagnóstico nunca culpa al backend por algo que inventó el propio caso, así que el agente no confunde su simulación con un error real del servidor.

### Suites largas

Si la suite tarda minutos, pídele que reparta el trabajo:

```text
Corre todos los casos en headless, de a tres, y avísame cómo va.
```

`case_run` acepta `jobs`, `ports` y `host_command`. Cada trabajo usa su propio host, y `host_command` levanta uno nuevo para cada caso. Correr en paralelo tiene una trampa: todos los casos comparten el mismo backend. Un caso que cambia algo que ven todos los demás, como un feature flag global, tiene que declarar `exclusive: true` en su frontmatter; así corre solo, sin otros casos al mismo tiempo.

Con `host`, si el host headless se cae a mitad de un caso, o si su memoria pasa del porcentaje que indica `host_heap`, la corrida lo vuelve a levantar antes del caso siguiente. Una caída hace fallar ese caso y no todos los que vienen después.

Mientras tanto, `case_status` responde en qué va la corrida: cuántos casos terminaron y cuántos fallaron, qué está corriendo cada trabajo y en qué sección del caso, y cuánto falta. Lo puede llamar el agente, o una persona desde otra terminal con `npx lynkeus case status`. Si el cliente manda un progress token junto con `case_run`, además recibe notificaciones de progreso de MCP con esa misma línea.

## 4. Elige cuántas herramientas servir

Cada herramienta que ofreces le cuesta tokens al modelo en cada turno, la use o no. Por eso hay dos tamaños:

| Comando | Herramientas | Costo aproximado por turno |
|---|---|---|
| `lynkeus mcp` | 22 | 3500 tokens |
| `lynkeus mcp --full` | las 56 | 7300 tokens |

Empieza con el conjunto básico. Agrega `--full` solo para un agente cuyo trabajo sea rastrear la app, grabar o tomar snapshots.

Las herramientas básicas son:

| Herramienta | Qué hace |
|---|---|
| `status` | Qué tiene el proyecto de lynkeus y qué falta, cada cosa con su arreglo, y si hay una app conectada. |
| `init` | Instala el agente de lynkeus, lo monta y crea el token del proyecto. |
| `headless_init` | Prepara la app para correr en Node, sin simulador. También una app con Expo Router. |
| `headless_doctor` | Lista los módulos nativos que la app usa y que nada simula todavía, y puede escribir stubs para ellos. |
| `case_init` | Escribe un caso de ejemplo y la referencia del formato. |
| `case_run` | Corre casos, de a uno o en paralelo; uno que falla vuelve con su pantalla y su motivo. |
| `case_status` | En qué va una corrida: casos terminados, qué corre cada trabajo y en qué sección, cuánto falta. |
| `case_here` | Arma un caso con la pantalla que la app muestra ahora, con verificaciones que ya pasan. |
| `case_new` | Arma el borrador de un caso para una pantalla: cómo llegar, qué preparar, qué falta verificar. |
| `case_coverage` | A qué pantallas llegan los casos, a cuáles ninguno, y cuáles nombra un caso aunque la app ya no las tenga. |
| `case_impact` | Qué casos alcanza el cambio de una rama, para correr solo esos. |
| `fixtures_describe` | Qué puede preparar y leer el servidor de fixtures del proyecto, con los parámetros de cada comando. |
| `fixtures_check` | Si el servidor de fixtures cumple el protocolo. |
| `screen` | Lee la pantalla: ruta y elementos. |
| `press` | Toca un elemento. |
| `type` | Escribe en un campo. |
| `wait` | Espera una ruta o un elemento. |
| `why` | Explica por qué falló lo último. |
| `call` | Ejecuta un comando que la app registró con `qa.register`. |
| `os_deeplink` | Abre una URL en la app, como se la entregaría el sistema. |
| `map_show` | Qué botones tiene una pantalla y a dónde llevan, según el código. |
| `map_plan` | Indicaciones para ir de una ruta a otra. |

Si `lynkeus.config.json` declara `language` o `locale`, aparece una más, `app_locale`, que le dice al modelo en qué idioma están las pantallas antes de que empiece a adivinar.

## 5. Enséñale a leer una pantalla

Esto es lo que recibe el modelo cuando llama a `screen`:

```text
Settings.Main (Tabs > Settings.Main) +overlay#account-sheet · 12 hidden: 12 behind-overlay
4 button #close-sheet "Close"
5 button #delete-account-button "Delete account" !disabled
6 text "Are you sure?"
7 button #slide-to-confirm ~inert
```

- El encabezado trae la ruta, el camino de navegadores y la capa que está encima, si la hay.
- Lo que la plataforma no está presentando (otra pestaña, la pantalla bajo una hoja) no se lista: solo se cuenta. No se puede tocar, así que al modelo no le sirve.
- Hay un elemento por línea: índice, tipo, `#testId`, texto y estado. `!disabled` no responde, `~covered` tiene algo dibujado encima, `~inert` se lee pero no se toca.
- No hay coordenadas. El modelo señala los controles por `#testId`.
- Un ícono dentro de un botón es parte del botón y no se lista aparte.

Una pantalla promedio ocupa unos 250 tokens. La salida en JSON es varias veces más grande y no agrega nada que un modelo necesite: es para programas.

## 6. Dale instrucciones

El modelo conoce las herramientas por su descripción, pero no sabe cuál es la forma barata de usarlas. Unas pocas reglas en sus instrucciones de sistema le ahorran la mayor parte de los errores. Este texto sirve de punto de partida:

```md
Pruebas una app de React Native a través de las herramientas de lynkeus.

- Antes de explorar una pantalla, llama a map_show con su ruta: te dice qué
  botones tiene y a dónde llevan, sin abrirla.
- Para ir de una pantalla a otra, pide el camino con map_plan (from, to) y
  sigue esos toques. No pruebes botones al azar.
- Señala los controles por #testId. Usa el texto solo si no hay testId.
- Cuando una fila repite un control, acota con "in" (el texto de esa fila)
  o con "nth".
- Si lo que buscas está más abajo en una lista, usa wait con "scroll".
- Si un campo actúa con la tecla de retorno, usa type con "submit".
- Cuando algo falle, llama a why. No vuelvas a leer la pantalla: cuesta lo
  mismo y dice menos.
```

### Por qué `why` y no otro `screen`

Es la regla que más rinde. En una sola respuesta, `why` dice si el objetivo está cubierto, oculto tras una capa, deshabilitado o si no existe (y cuál es el parecido más cercano); si la sesión se perdió, si el backend falló o limitó las peticiones, si todavía hay peticiones en curso o si no se hizo ninguna; y si el navegador murió. Un modelo que relee la pantalla tras un fallo gasta lo mismo y tiene que deducir todo eso por su cuenta.

Además, cuando una herramienta falla, la respuesta de error ya trae ese diagnóstico adjunto, bajo `why:`.

## Un ciclo completo: revisar un pull request

Con estas piezas, un agente puede hacerse cargo de la verificación de una rama:

1. Llama a `case_impact` con `base: main`. Esa herramienta mira qué pantallas toca el diff y qué cubre cada caso, y devuelve dos listas: los casos que hay que correr y las pantallas alcanzadas que ningún caso cubre.
2. Corre esos casos con `case_run`. Por cada fallo, llama a `why`.
3. Arregla el caso si la app cambió a propósito, o el código si no.
4. Para cada pantalla sin cobertura, escribe un caso nuevo; `case_new` le da el borrador.
5. Deja en el pull request el arreglo, los casos y las pantallas que registró la ejecución (con `LYNKEUS_RECORD_SCREENS=1`). Quien revisa lee un solo diff en lugar de buscar.

Todo eso está en el conjunto básico; no hace falta `--full`.

## Sin MCP: una sesión

Un agente que tiene terminal pero no MCP, o un script propio, puede usar `lynkeus session`. Mantiene una conexión abierta, lee un arreglo JSON por línea y responde un objeto JSON por línea:

```bash
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
```

Cada paso cuesta unos 50 ms, contra cerca de 1,5 s de un comando suelto. Cuando un paso falla, la respuesta trae `why` junto al error.

## Leer los reportes desde un agente

Lo anterior es un agente que maneja la app. Hay otro uso, independiente: un agente que lee los resultados. El servicio de reportes ofrece su propio servidor MCP, solo de lectura, en `https://lynkeus.io/mcp`. Sus herramientas son `list_runs`, `get_run`, `get_case`, `get_step`, `get_frame`, `case_history` y `flaky_cases`. `get_case` dice qué prueba el caso y qué espera, y por cada paso los eventos de analítica que disparó, con el servicio al que fue cada uno (distinguiendo los de la app de los del backend), y las peticiones que mandó la app. `get_step` trae un paso completo: cada evento con sus propiedades, y cada petición con sus encabezados y cuerpos y lo que volvió, con los secretos ya ocultos. `get_frame` devuelve como imagen la pantalla que dejó un paso, por defecto el que falló, para que el cliente vea qué mostraba la app. Una ejecución guarda capturas cuando se hizo con `--screenshots`. Está descrito en [reportes](/es/guides/reports/).

## Límites y cuidados

- **Solo builds de depuración.** El agente de lynkeus no existe en un build de producción. Un agente de IA no puede manejar la app que tienen tus usuarios.
- **`nav` no es un usuario.** Con `--full`, el modelo puede saltar a cualquier ruta. Sirve para llegar rápido al punto de partida; un recorrido que se quiere validar debe hacerse con toques.
- **Cuidado con el backend real.** Un modelo toca lo que le parece razonable. Apunta la app a un backend de pruebas, no a uno con cuentas reales.
- **Elementos del sistema.** Lo que dibuja el sistema operativo y no React Native, como la barra de pestañas nativa de la plantilla más reciente de Expo, no aparece en `screen`.

## Problemas frecuentes

**El cliente no muestra herramientas.** El servidor no arrancó. Ejecuta `npx lynkeus mcp --root /ruta/a/tu/app` a mano para ver el error; lo habitual es una ruta equivocada.

**Todas las herramientas agotan el tiempo.** El servidor arrancó, pero la app no se conectó. Pídele al agente que llame a `status`: dice qué pieza falta. Lo habitual es que la app no esté abierta, que no sea un build de depuración, o que su bundle no tenga el token: después de que `init` lo creó, hay que reiniciar Metro con `--reset-cache`. El token es el de `.lynkeus/token`, salvo que el entorno del servidor defina `LYNKEUS_TOKEN`.

**`map_plan` no devuelve indicaciones.** El grafo estático solo conoce las navegaciones que pudo leer en el código. `npx lynkeus crawl` recorre la app y agrega los caminos observados.

**El modelo insiste con un texto que no coincide.** Una palabra dentro de un párrafo no es un objetivo. Indícale que use `#testId`, y agrega `testID` a los controles que no lo tengan.

## Siguientes pasos

- [Manejar la app](/es/guides/driving-the-app/): los mismos comandos, a mano.
- [Referencia de la CLI](/es/reference/cli/): los 56 comandos que sirve `--full`.
- [Seguridad](/es/security/): qué expone el agente y por qué solo en depuración.
