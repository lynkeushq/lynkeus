---
title: Reportes
description: Cómo guardar una ejecución en un directorio, qué contiene, cómo subirla al servicio de reportes y qué conserva cada plan.
---

Cuando un test falla en tu máquina, la terminal alcanza. Cuando falla en CI a las tres de la mañana, alguien tiene que poder ver qué pasó sin repetir la ejecución. Para eso sirve un reporte: la ejecución completa, paso por paso, con sus capturas de pantalla y el motivo de cada fallo.

lynkeus separa dos cosas. El **directorio de la ejecución** es un conjunto de archivos que escribe la CLI, gratis y en tu máquina. El **reporte alojado** es una página en [lynkeus.io](https://lynkeus.io) que tu equipo abre con un enlace; es el servicio de pago del proyecto, con un plan gratuito. Esta guía cubre ambos.

## Antes de empezar

- Tienes casos que corren ([guía](/es/guides/writing-cases/)).
- Para la segunda mitad, una cuenta en lynkeus.io.

## 1. Guarda la ejecución en un directorio

```bash
npx lynkeus case run --out run --screenshots
```

`--out <dir>` escribe la ejecución como un directorio. `--screenshots` agrega una captura de pantalla después de cada paso de la app. Al terminar, deberías tener:

```text
run/
  run.json                   cuándo empezó y terminó, en qué corrió, los totales
  cases.jsonl                una línea por intento de cada caso, en orden
  settings-dark-mode/        la evidencia del primer intento de ese caso
    01-app-press-settings-button.png
    01-app-press-settings-button.json
    …
```

Hay tres opciones de evidencia, y las tres necesitan `--out`:

| Opción | Qué guarda |
|---|---|
| `--screenshots` | Una imagen de la pantalla después de cada paso de la app, y a su lado un `.json` con lo que la pantalla contenía. |
| `--video` | Una película de cada caso, donde el host ofrece un comando `record`. Cada paso anota en qué segundo empezó. |
| `--video-fps <n>` | Los cuadros por segundo de la película. Por defecto, 30. |

Cada tipo de evidencia se toma solo donde el host puede. El host sin pantalla que incluye lynkeus no dibuja nada que capturar, así que ahí no habrá imágenes; en un simulador o un emulador sí.

La película depende de otra cosa: de que el host ofrezca un comando llamado `record`, que nombra al presentarse (lo lista `lynkeus hello`). El host sin pantalla que incluye lynkeus no lo ofrece, y una sesión de simulador o de emulador tampoco. En esos hosts, una ejecución con `--video` conserva sus capturas y no tiene película.

Si un caso falla y se reintenta, el segundo intento deja su evidencia en una carpeta aparte con el sufijo `.2`.

## 2. Lee lo que quedó

`run.json` describe la ejecución entera:

| Campo | Contenido |
|---|---|
| `schema` | La versión del formato. |
| `startedAt`, `finishedAt` | Cuándo empezó y terminó. |
| `git` | El commit y la rama desde los que se ejecutó. |
| `platform`, `native` | En qué corrió la app. |
| `totals` | Cuántos casos hubo y cuántos pasaron, fallaron, no pudieron correr en este host o necesitaron reintento. |

El archivo se escribe al empezar y otra vez al terminar. Una ejecución interrumpida se reconoce porque no tiene `finishedAt` ni `totals`.

Cada línea de `cases.jsonl` es un intento de un caso: su `id`, título, descripción y archivo, el número de intento (1, o 2 para la segunda oportunidad), el resultado, cuándo empezó, cuánto duró y sus pasos. Cada paso dice a qué parte pertenece (`setup` o `steps`), si pasó, falló, se omitió o no se pudo hacer en este host, cuánto tardó, su error, y los eventos que la app envió a su analítica mientras corría. Un intento fallido conserva su evidencia: la pantalla, las peticiones y el diagnóstico.

Ese formato es un contrato. Los tipos (`RunManifest`, `RunCase`, `RunStep`, `RunEvent`) y la constante `RUN_SCHEMA` están en el paquete `lynkeus-protocol`. A un campo solo se le agregan cosas; si cambia el significado de uno existente, sube el `schema`. Un programa que lee estos archivos debe rechazar un `schema` que no conoce.

:::tip
Si solo necesitas un resumen para otra herramienta, `--report <archivo>` agrega una línea JSON por caso a un archivo, sin crear el directorio.
:::

## 3. Crea una clave para el servicio

1. Entra a [lynkeus.io](https://lynkeus.io) con Google o GitHub. Obtienes una organización propia, o te unes a la que te invitó.
2. En **API keys**, crea una clave. Se muestra una sola vez: guárdala en ese momento.

## 4. Sube la ejecución

```bash
export LYNKEUS_REPORTS_URL=https://lynkeus.io
export LYNKEUS_REPORTS_KEY=lk_…
npx lynkeus case run --out run --screenshots --push
```

`--push` sube el directorio cuando la ejecución termina. Deberías ver, al final del resumen, la dirección del reporte y qué cambió respecto de la ejecución anterior:

```text
3/4 passed
report: https://lynkeus.io/r/…
newly failing (1): checkout-gift
fixed since the run before (1): settings-dark-mode
```

La presencia de las dos variables se comprueba antes de ejecutar nada, para que una clave faltante no aparezca recién cuando ya corrieron todos los casos. En cambio, si la subida falla al final, la ejecución no se pierde ni cambia su resultado: verás `the report was not uploaded: <motivo>` y el directorio sigue en tu disco.

Una ejecución que ya tienes guardada se sube después con:

```bash
npx lynkeus report push run --project mi-app
```

`--project` es el proyecto bajo el que se archiva. Si lo omites, es el nombre de la carpeta de la app. Vale igual en `case run --push`.

## Qué muestra el reporte

El reporte presenta cada caso con sus pasos. Junto a ellos corre la película, sincronizada con el paso que se está viendo, o la captura de pantalla de cada paso. Cada paso lista los eventos de analítica que envió, y un caso fallido muestra por qué falló. La ejecución aparece en **Runs** con su rama y su commit.

Si ejecutaste con `--traces`, cada paso muestra además las peticiones que envió la app y lo que el backend hizo por cada una. Está en [trazas del backend](/es/guides/backend-traces/).

## Planes y retención

| | Free | Team |
|---|---|---|
| Proyectos | 1 | sin límite |
| Historial | 7 días | 90 días |
| Captura de pantalla por paso | sí | sí |
| Película | no | sí |
| Eventos por paso | sí | sí |
| Tendencias de intermitencia | no | sí |

Una tarea diaria borra las ejecuciones más antiguas de lo que el plan conserva, junto con sus archivos.

En el plan Free, una película se omite de la subida y la CLI lo dice junto a la dirección del reporte: `(not kept on this plan: checkout-gift/video.mp4)`. El resto del reporte sube normalmente.

Para ver o cambiar el plan:

```bash
npx lynkeus report plan             # el plan actual y lo que conserva
npx lynkeus report plan --upgrade   # imprime la dirección de pago del plan Team
npx lynkeus report plan --manage    # imprime el portal: tarjeta, facturas y cancelación
```

## Consultar los reportes desde la terminal

```bash
npx lynkeus report list --limit 10
```

Cada línea es una ejecución, de la más reciente a la más antigua: cuándo empezó, su proyecto y plataforma, cuántos casos pasaron y la dirección del reporte. Por defecto lista 20, y como máximo 100.

`report flakes` y `report history` leen las mismas ejecuciones para encontrar los casos que no siempre pasan. Están en [tests intermitentes](/es/guides/flaky-tests/).

Un cliente MCP como Claude, Claude Code o Cursor también puede leer las ejecuciones de tu organización, con tu sesión y solo en modo lectura, conectándose a `https://lynkeus.io/mcp`. La primera vez, el cliente abre lynkeus para pedir tu aprobación; puedes desconectarlo en **Members**.

## Problemas frecuentes

**`--screenshots and --video keep what they take in the run directory: add --out <dir>`.** La evidencia necesita dónde guardarse.

**`--push uploads the run directory: add --out <dir>`.** Mismo motivo: `--push` sube lo que escribe `--out`.

**`set LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY (the organisation’s API key)`.** Falta una de las dos variables en el entorno donde corre el comando. En CI, revisa que el secreto esté expuesto en ese paso.

**`` run: no cases.jsonl; pass the directory `case run --out` wrote ``.** `report push` recibió una carpeta que no es una ejecución.

**No hay capturas de pantalla en el reporte.** El host no puede tomarlas. Ejecuta esos casos en un simulador o un emulador.

## Siguientes pasos

- [Ejecutar en CI](/es/guides/ci/): subir un reporte en cada pull request.
- [Trazas del backend](/es/guides/backend-traces/): agregar al reporte lo que hizo el servidor.
- [Seguridad](/es/security/): qué conserva el servicio alojado.
