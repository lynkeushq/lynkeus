---
title: Agentes de IA
description: Cómo dejar que un agente de IA maneje la app con lynkeus mcp, qué herramientas recibe, cómo lee una pantalla y qué instrucciones darle para que no gaste su contexto.
---

Un agente de IA que prueba una app a partir de capturas de pantalla trabaja a ciegas y caro: cada imagen cuesta miles de tokens y solo le permite suponer dónde está el botón. lynkeus le da otra cosa: la pantalla como una lista de hechos. Qué ruta está abierta, qué elementos hay, cuáles se pueden tocar y cuáles están cubiertos. Con eso el modelo decide el siguiente paso a partir de datos y no de píxeles.

El puente es MCP (Model Context Protocol), el protocolo con el que un cliente como Claude Code o Cursor le ofrece herramientas a un modelo. `lynkeus mcp` sirve los comandos de lynkeus como herramientas MCP. Esta guía es para quien configura ese agente: cómo conectarlo, qué recibe y qué conviene escribir en sus instrucciones.

## Antes de empezar

- La app corre con el agente de lynkeus montado, en un simulador, un emulador o un host sin pantalla. (En esta página, "el agente" a secas es el de IA.)
- Tu cliente de IA admite servidores MCP por entrada y salida estándar.
- Ejecutaste `npx lynkeus map build` en la carpeta de la app. Lee el código una vez y escribe `.lynkeus/graph.json`: las rutas, los `testID` y las navegaciones. Las herramientas `map_show` y `map_plan` dependen de ese archivo.

## 1. Registra el servidor en tu cliente

El servidor se inicia con un comando:

```bash
npx lynkeus mcp
```

No lo ejecutes a mano: es el cliente quien lo arranca y le habla por entrada y salida estándar. En los clientes que se configuran con un archivo JSON, la entrada suele tener esta forma:

```json
{
  "mcpServers": {
    "lynkeus": {
      "command": "npx",
      "args": ["lynkeus", "mcp", "--root", "/ruta/a/tu/app"],
      "env": { "LYNKEUS_TOKEN": "el-mismo-token-que-lee-la-app" }
    }
  }
}
```

Dos detalles importan. `--root` le dice a lynkeus cuál es la carpeta de la app, porque el cliente no siempre arranca el servidor ahí. Y `LYNKEUS_TOKEN` debe tener el mismo valor que el token de la app; sin él, la app no atiende al servidor. El nombre y la ubicación exactos del archivo dependen de tu cliente: consulta su documentación.

Deberías ver, en la lista de herramientas de tu cliente, las nueve del conjunto básico.

## 2. Elige cuántas herramientas servir

Cada herramienta que ofreces le cuesta tokens al modelo en cada turno, la use o no. Por eso hay dos tamaños:

| Comando | Herramientas | Costo aproximado por turno |
|---|---|---|
| `lynkeus mcp` | 9 | 750 tokens |
| `lynkeus mcp --full` | las 42 | 4200 tokens |

Empieza con el conjunto básico. Agrega `--full` solo para un agente cuyo trabajo sea rastrear la app, grabar o tomar snapshots.

Las nueve herramientas básicas son:

| Herramienta | Qué hace |
|---|---|
| `screen` | Lee la pantalla: ruta y elementos. |
| `press` | Toca un elemento. |
| `type` | Escribe en un campo. |
| `wait` | Espera una ruta o un elemento. |
| `why` | Explica por qué falló lo último. |
| `call` | Ejecuta un comando que la app registró con `qa.register`. |
| `os_deeplink` | Abre una URL en la app, como se la entregaría el sistema. |
| `map_show` | Qué botones tiene una pantalla y a dónde llevan, según el código. |
| `map_plan` | Indicaciones para ir de una ruta a otra. |

Si `lynkeus.config.json` declara `language` o `locale`, aparece una décima, `app_locale`, que le dice al modelo en qué idioma están las pantallas antes de que empiece a adivinar.

## 3. Enséñale a leer una pantalla

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

## 4. Dale instrucciones

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

1. Ejecuta `lynkeus map check --base main` en la rama. Obtiene las pantallas que el cambio alcanza.
2. Cruza ese resultado con los casos que tocan esas rutas. Obtiene los casos que debe ejecutar.
3. Los ejecuta. Por cada fallo, llama a `why`.
4. Arregla el caso si la app cambió a propósito, o el código si no.
5. Deja en el pull request el arreglo, el caso y las pantallas que registró la ejecución (con `LYNKEUS_RECORD_SCREENS=1`). Quien revisa lee un solo diff en lugar de buscar.

Los pasos 1 y 3 usan comandos que no están en el conjunto básico. El agente necesita `--full` o acceso a una terminal.

## Sin MCP: una sesión

Un agente que tiene terminal pero no MCP, o un script propio, puede usar `lynkeus session`. Mantiene una conexión abierta, lee un arreglo JSON por línea y responde un objeto JSON por línea:

```bash
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
```

Cada paso cuesta unos 50 ms, contra cerca de 1,5 s de un comando suelto. Cuando un paso falla, la respuesta trae `why` junto al error.

## Leer los reportes desde un agente

Lo anterior es un agente que maneja la app. Hay otro uso, independiente: un agente que lee los resultados. El servicio de reportes ofrece su propio servidor MCP, solo de lectura, en `https://lynkeus.io/mcp`. Está descrito en [reportes](/es/guides/reports/).

## Límites y cuidados

- **Solo builds de depuración.** El agente de lynkeus no existe en un build de producción. Un agente de IA no puede manejar la app que tienen tus usuarios.
- **`nav` no es un usuario.** Con `--full`, el modelo puede saltar a cualquier ruta. Sirve para llegar rápido al punto de partida; un recorrido que se quiere validar debe hacerse con toques.
- **Cuidado con el backend real.** Un modelo toca lo que le parece razonable. Apunta la app a un backend de pruebas, no a uno con cuentas reales.
- **Elementos del sistema.** Lo que dibuja el sistema operativo y no React Native, como la barra de pestañas nativa de la plantilla más reciente de Expo, no aparece en `screen`.

## Problemas frecuentes

**El cliente no muestra herramientas.** El servidor no arrancó. Ejecuta `npx lynkeus mcp --root /ruta/a/tu/app` a mano para ver el error; lo habitual es una ruta equivocada.

**Todas las herramientas agotan el tiempo.** El servidor arrancó, pero la app no se conectó. Revisa que la app esté abierta, que sea un build de depuración y que el token coincida. `npx lynkeus hello` desde la terminal confirma la conexión.

**`map_plan` no devuelve indicaciones.** El grafo estático solo conoce las navegaciones que pudo leer en el código. `npx lynkeus crawl` recorre la app y agrega los caminos observados.

**El modelo insiste con un texto que no coincide.** Una palabra dentro de un párrafo no es un objetivo. Indícale que use `#testId`, y agrega `testID` a los controles que no lo tengan.

## Siguientes pasos

- [Manejar la app](/es/guides/driving-the-app/): los mismos comandos, a mano.
- [Referencia de la CLI](/es/reference/cli/): los 42 comandos que sirve `--full`.
- [Seguridad](/es/security/): qué expone el agente y por qué solo en depuración.
