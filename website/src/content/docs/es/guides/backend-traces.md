---
title: Trazas del backend
description: Cómo usar la opción --traces y OpenTelemetry para ver, debajo de cada paso de un caso, las peticiones que envió la app y lo que el backend hizo por cada una.
---

Un test de interfaz falla en la pantalla, pero la causa suele estar en otro lado: una consulta que tardó cuatro segundos, un trabajo en segundo plano que nunca corrió, una llamada a un tercero que devolvió error. Sin más información, quien mira el fallo tiene que ir a buscar los registros del servidor y adivinar cuáles corresponden a ese momento.

Con `--traces`, lynkeus hace esa correspondencia por ti. Debajo de cada paso del caso quedan las peticiones que la app envió mientras el paso corría y, bajo cada petición, las consultas, los trabajos y las llamadas salientes que desencadenó. Usa OpenTelemetry, el estándar abierto de trazas, así que funciona con cualquier backend que pueda exportarlas y lynkeus no necesita saber nada de él.

Esta guía es para quien ejecuta la suite contra un backend que controla: uno local o el que levanta el job de CI.

## Antes de empezar

- Tu backend tiene el SDK de OpenTelemetry instalado y puede exportar trazas por OTLP sobre HTTP.
- Guardas la ejecución con `--out` ([reportes](/es/guides/reports/)): las trazas quedan dentro de `cases.jsonl`.
- El agente de la app es de una versión que conoce las trazas. Con un agente anterior, la ejecución funciona pero queda sin trazas.

## 1. Arranca el backend con el exportador encendido

Apunta el exportador de tu backend al puerto donde va a escuchar lynkeus:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 <el comando que inicia tu backend>
```

Esa variable es estándar de OpenTelemetry; la lee el SDK de tu lenguaje. Cómo se enciende el SDK depende de tu framework y está en su documentación.

:::caution
Enciende el exportador solo para las ejecuciones de prueba. Tiene un costo pequeño en cada petición, y no hay razón para pagarlo fuera de ellas.
:::

## 2. Ejecuta los casos con `--traces`

```bash
npx lynkeus case run --out run --traces
```

Deberías ver esta línea antes del primer caso:

```text
backend traces: listening on http://localhost:4318 (the backend's OTEL_EXPORTER_OTLP_ENDPOINT)
```

Si el puerto 4318 está ocupado, elige otro en ambos lados:

```bash
npx lynkeus case run --out run --traces --traces-port 4400
# y en el backend: OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4400
```

## 3. Mira el resultado

Sube la ejecución con `--push` y abre el reporte: cada paso lista las peticiones que la app envió mientras corría y, debajo de cada una, lo que desencadenó.

Si prefieres leer los archivos, cada paso de `cases.jsonl` tiene un campo `backend`: una lista de tramos (los *spans* de OpenTelemetry), con la petición primero y lo que provocó debajo. Cada tramo lleva:

| Campo | Contenido |
|---|---|
| `name` | El nombre del tramo, tal como lo puso tu instrumentación. |
| `kind` | `server`, `client`, `internal`, `producer` o `consumer`. |
| `at` | Milisegundos desde que empezó el paso. |
| `ms` | Cuánto duró. |
| `depth` | Su nivel de anidamiento: 0 es la petición, 1 lo que ella provocó, y así sucesivamente. |
| `service` | El servicio que lo emitió, si lo declara. |
| `error` | El error, si lo hubo. |
| `attributes` | Algunos atributos del tramo. |

## Cómo funciona

1. Al empezar, la ejecución abre un receptor OTLP sobre HTTP en `localhost:4318`.
2. Cada paso de la app recibe un identificador de tramo propio. El agente lo pone en el encabezado W3C `traceparent` de todas las peticiones que la app envía durante ese paso.
3. El backend, con su SDK encendido, continúa esa traza y exporta lo que hizo.
4. Cuando el caso termina, lynkeus espera un momento a que lleguen los últimos lotes y guarda bajo cada paso todos los tramos cuya cadena de padres llega hasta él.

Como es el agente quien pone el encabezado, esto funciona igual en un simulador, un emulador, un dispositivo o un host sin pantalla.

Los trabajos en segundo plano entran en la traza cuando su instrumentación propaga el contexto. Las de ActiveJob, Sidekiq y Celery lo hacen.

## Qué queda fuera

- **Lo que ningún paso provocó.** Los tramos de un planificador o de cualquier proceso que no nació de una petición de la app no aparecen: su cadena de padres no llega a ningún paso.
- **El exceso.** Un paso conserva como máximo los primeros 400 tramos. Un reporte no es un perfilador.
- **Los pasos que no son de la app.** Solo los pasos `app.*` y las macros reciben identificador. Lo que hace un fixture en el backend no se registra aquí.

## En CI

En un job de CI no hace falta un entorno compartido. Levanta el backend que el job está probando (su imagen, con una base de datos y una caché como servicios), con datos de prueba, y arráncalo con la misma variable:

```yaml
- run: npx lynkeus case run --host --out run --traces --push
  env:
    LYNKEUS_TOKEN: ${{ secrets.LYNKEUS_TOKEN }}
    LYNKEUS_REPORTS_URL: https://lynkeus.io
    LYNKEUS_REPORTS_KEY: ${{ secrets.LYNKEUS_REPORTS_KEY }}
```

El backend del mismo job debe haberse iniciado antes con `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. El resto del flujo está en [ejecutar en CI](/es/guides/ci/).

## Problemas frecuentes

**`--traces could not listen on port 4318: …`.** Otro proceso ya usa el puerto; lo más común es un colector de OpenTelemetry local. Cambia el puerto con `--traces-port` y apunta el backend al mismo.

**Los pasos no tienen `backend`.** Revisa en orden: que el backend se haya iniciado con la variable (un proceso ya en marcha no la toma), que el SDK esté realmente encendido en ese entorno, que el exportador use HTTP y no gRPC, y que el agente de la app no sea anterior a esta función.

**Aparecen las peticiones, pero no los trabajos.** La instrumentación de tu cola no propaga el contexto de la traza. Sin eso, el trabajo empieza una traza nueva que lynkeus no puede relacionar con ningún paso.

**Faltan tramos al final de un paso lento.** El backend exporta por lotes, un momento después de atender. lynkeus espera hasta tres segundos tras el caso; un exportador configurado con un intervalo mayor llega tarde.

## Siguientes pasos

- [Reportes](/es/guides/reports/): dónde se ven las trazas.
- [Fixtures](/es/guides/fixtures/): preparar los datos del backend.
- [Variables de entorno](/es/reference/environment-variables/): todo lo que lee lynkeus.
