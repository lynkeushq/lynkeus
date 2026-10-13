---
title: Tests intermitentes
description: Cómo detectar los casos que pasan unas veces y fallan otras, medir con qué frecuencia y en qué paso, y distinguir un test intermitente de uno roto.
---

Un test intermitente es el que pasa y falla sin que nada haya cambiado. Es más caro que un test roto: el roto se arregla, mientras que el intermitente enseña al equipo a ignorar los fallos, y un fallo ignorado ya no protege nada.

El primer paso para arreglarlo es dejar de tratarlo como una impresión ("ese falla a veces") y convertirlo en un dato: cuántas veces falla, en qué paso y con qué error. lynkeus ofrece cuatro herramientas para eso, de la más inmediata a la más amplia. Esta guía las recorre en ese orden.

## Antes de empezar

- Tienes casos que corren ([guía](/es/guides/writing-cases/)).
- Para la última sección, ejecuciones subidas al servicio de reportes con el plan Team ([reportes](/es/guides/reports/)).

## 1. El reintento: la primera señal

Un caso que falla se ejecuta una vez más antes de contarse como fallido. Si pasa en el segundo intento, el resumen lo marca:

```text
✅ checkout-gift  ⚠ passed on retry
✅ settings-dark-mode
2/2 passed
```

La ejecución termina bien, pero esa marca es información: algo en ese caso no es estable. No la dejes pasar.

Cuando estás investigando, el reintento estorba, porque oculta justo el fallo que quieres ver. Quítalo con `--once`:

```bash
npx lynkeus case run cases/checkout-gift.md --once
```

## 2. El historial local: `.lynkeus/flakes.json`

Cada `case run` anota cómo le fue a cada caso en un archivo, `.lynkeus/flakes.json`. Conserva los últimos 20 resultados de cada uno: cuándo corrió, si pasó, si necesitó reintento, cuánto tardó y, si falló, en qué paso y con qué error.

Con ese historial, el resumen avisa cuando los resultados recientes de un caso se contradicen:

```text
⚠ checkout-gift is flaky: 3 of its last 20 runs failed or needed a second chance
```

La condición es precisa. Un caso que falló o necesitó reintento en *algunas* de sus últimas ejecuciones es intermitente. Uno que falló en *todas* no recibe el aviso: no es intermitente, está roto.

`--flakes <archivo>` cambia dónde se guarda. El historial es un archivo local, así que un runner de CI que arranca limpio cada vez empieza sin él. Para ese caso está el historial alojado, más abajo.

## 3. Repetir hasta que falle: `flake`

Para medir un recorrido concreto, `flake` lo repite varias veces y resume dónde murió. Trabaja sobre un flujo, que es un archivo JSON con una lista de pasos:

```json title="flows/login.json"
{
  "name": "login",
  "vars": ["phone"],
  "steps": [
    { "press": { "testId": "get-started-button" } },
    { "type": { "text": "{{phone}}", "target": { "testId": "phone-input" } } },
    { "press": { "testId": "next-button" } },
    { "waitFor": { "route": "Settings.Main" } }
  ]
}
```

```bash
npx lynkeus flake flows/login.json --times 10 --var phone=1124888418
```

Deberías ver cuántas veces pasó, la duración mediana y un renglón por cada forma de fallo:

```text
login: passed 8/10 (median 12s)
  2× at step 4 (waitFor {"route":"Settings.Main"}): Timed out …
```

Ahora la impresión es un número y un paso: falla dos de cada diez veces, siempre esperando `Settings.Main`. El comando termina con código 1 si alguna repetición falló. Por defecto repite 5 veces.

Dos mensajes adicionales orientan la lectura:

- `no failure in this sample; if it fails elsewhere, the difference is the environment (load, data, a parallel runner)`. Aquí no falló. Si falla en CI, la diferencia está en el entorno: carga, datos u otro runner en paralelo.
- `more than one failure shape: not one flake but several, or a screen that fails in different ways when slow`. Falló de más de una manera. Son varios problemas, o una pantalla que se rompe de formas distintas cuando va lenta.

## 4. Pregunta por qué

Con el paso identificado, reproduce el fallo y pregunta la causa:

```bash
npx lynkeus why Settings.Main
```

`why` lee la pantalla, las últimas peticiones y la traza de la app, y responde con lo que encontró: el objetivo está pero cubierto o deshabilitado, todas las peticiones dan 401, el backend respondió 5xx, todavía había peticiones en curso, el texto difiere por un acento. `--route <Ruta>` le indica qué ruta se esperaba. Dentro de `case run` esa misma explicación ya viene debajo del caso fallido, en el bloque `— why:`.

## 5. El historial del equipo: reportes alojados

Si subes las ejecuciones con `--push`, el servicio conserva el historial de todos los runners. Dos comandos lo consultan (plan Team):

```bash
npx lynkeus report flakes --project mi-app
```

```text
mi-app: 30 runs
flaky    87%  ✓✓↻✓✗✓✓✓  checkout-gift  https://lynkeus.io/r/…
broken   62%  ✗✗✗✓✓✓✓✓  profile-edit  https://lynkeus.io/r/…
```

Ordena los casos por la frecuencia con que pasaron al primer intento, del menos confiable al más confiable. Cada línea muestra las ejecuciones recientes, la más nueva primero: `✓` pasó, `↻` pasó en el reintento, `✗` falló. Al final va el último reporte donde salió mal. Lee las últimas 30 ejecuciones; `--runs <n>` lo cambia.

Para seguir un solo caso:

```bash
npx lynkeus report history checkout-gift --project mi-app
```

Muestra cada ejecución de ese caso con su resultado, su duración, la rama y el commit desde los que se hizo, y el reporte para abrir.

## Intermitente o roto

La distinción decide qué hacer, y las herramientas la marcan de tres maneras:

| Señal | Intermitente | Roto |
|---|---|---|
| Historial local | Algunas de las últimas ejecuciones fallaron o necesitaron reintento. | Todas fallaron: no hay aviso de intermitencia, solo el fallo. |
| `report flakes` | `flaky`: resultados mezclados. | `broken`: falló en sus últimas tres ejecuciones. |
| `report history` | Los fallos aparecen salpicados entre ramas y commits distintos. | Los fallos empiezan en un commit y no paran. |

Un caso roto tiene un commit culpable: `report history` te lo señala y se arregla ahí. Un caso intermitente tiene una condición que a veces se cumple y a veces no, y hay que encontrarla.

## Las causas que más se repiten

**Estado que sobrevive entre casos.** Una caché de consultas que quedó del caso anterior es la causa más común de errores entre tests. Registra en la app un comando `reset` que cierre la sesión y limpie el almacenamiento y las cachés; `npx lynkeus launch --clean` lo ejecuta, y tus casos pueden llamarlo con `app.call: { command: reset }`.

**Esperar un tiempo en lugar de un hecho.** `app.wait: 2000` pasa en tu máquina y falla en un runner más lento. Espera la ruta, el elemento o la petición: `app.wait: { request: "POST /v3/session" }`.

**Actuar mientras los datos siguen llegando.** Si la app registra un comando `busy`, que responde `true` mientras está cargando, quien la maneja puede esperar a los datos y no a un reloj. `npx lynkeus idle` espera a que la app deje de renderizar.

**Una pantalla que nunca se queda quieta.** Un contador o un reloj en pantalla hacen que `idle` agote su plazo en cada pantalla que los muestra. Declara los `testID` de esos controles en `live`, en `lynkeus.config.json`, y su texto deja de contar como actividad.

**Datos que chocan.** Dos casos que usan el mismo usuario se pisan cuando corren en paralelo. Crea los datos en cada caso, con `{{random.letters}}` donde algo deba ser único.

## Ver todo lo que falla de una vez

Por defecto un caso se detiene en el primer paso que falla. Mientras investigas puede convenir lo contrario:

```bash
npx lynkeus case run cases/checkout-gift.md --once --continue
```

`--continue` sigue ejecutando los pasos después de un fallo, para ver en una sola pasada todo lo que está mal. Un setup que falla sigue deteniendo el caso, porque sin él los pasos no tienen sobre qué apoyarse.

## Siguientes pasos

- [Reportes](/es/guides/reports/): subir las ejecuciones para tener historial.
- [Trazas del backend](/es/guides/backend-traces/): cuando la causa está en el servidor.
- [Solución de problemas](/es/troubleshooting/): síntomas de un paso que falla.
