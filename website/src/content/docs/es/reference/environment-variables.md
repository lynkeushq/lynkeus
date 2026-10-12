---
title: Variables de entorno
description: Todas las variables de entorno que leen el CLI, el agente y el host sin pantalla, quién las lee y qué hacen.
---

lynkeus lee del entorno lo que no conviene escribir en un archivo: los secretos, y lo que cambia de una máquina a otra o de una ejecución a otra. Esta página lista cada variable, quién la lee y qué efecto tiene.

Hay tres lectores posibles. El **CLI** es el proceso `lynkeus` que ejecutas en la terminal o en CI. El **host sin pantalla** (headless) es la app corriendo en Node, que arranca `lynkeus headless start`. La **app** es tu build de depuración en un simulador, un emulador o un dispositivo.

## Resumen

| Variable | Quién la lee | Para qué |
|---|---|---|
| [`LYNKEUS_TOKEN`](#lynkeus_token) | CLI, host sin pantalla, app | El secreto compartido entre la app y su driver. |
| [`LYNKEUS_PORT`](#lynkeus_port) | CLI, host sin pantalla | El puerto donde se encuentran el driver y la app. |
| [`LYNKEUS_HOST`](#lynkeus_host) | host sin pantalla | Dónde escucha el driver, cuando no está en la misma máquina. |
| [`LYNKEUS_DEVICE`](#lynkeus_device) | CLI | Qué simulador usar. |
| [`LYNKEUS_APP_ID`](#lynkeus_app_id) | CLI | El identificador de la app. |
| [`LYNKEUS_ATTACH_TIMEOUT_MS`](#lynkeus_attach_timeout_ms) | CLI | Cuánto esperar a que la app se conecte. |
| [`LYNKEUS_CONFIG`](#lynkeus_config) | CLI | Un segundo archivo de configuración. |
| [`LYNKEUS_SEED`](#lynkeus_seed) | CLI | Vuelve repetibles los valores al azar de los casos. |
| [`LYNKEUS_RECORD_SCREENS`](#lynkeus_record_screens) | CLI | Graba la estructura de cada pantalla que se lee. |
| [`LYNKEUS_REPORTS_URL`](#lynkeus_reports_url-y-lynkeus_reports_key) | CLI | La dirección del servicio de reportes. |
| [`LYNKEUS_REPORTS_KEY`](#lynkeus_reports_url-y-lynkeus_reports_key) | CLI | La clave de API de la organización. |

Cuando un valor se puede dar por varios caminos, la opción de la línea de comandos gana sobre la variable de entorno, y la variable de entorno gana sobre `lynkeus.config.json`.

## Conexión entre la app y el driver

### `LYNKEUS_TOKEN`

El secreto que comparten la app y su driver. Cuando la app se monta con un token, solo atiende al driver que lo presenta; así, ningún otro proceso de la máquina puede manejarla.

La leen tres partes, y las tres tienen que ver el mismo valor:

| Quién | Cómo la usa |
|---|---|
| El CLI | La presenta a la app en su primer mensaje, en cada comando que se conecta. |
| `lynkeus headless start` | La exige: sin ella se niega a arrancar. Se la pasa a la app alojada como su token. |
| Tu app | La lee donde montas el agente: `auto({ token: process.env.LYNKEUS_TOKEN })`. |

```bash
export LYNKEUS_TOKEN=un-secreto-por-maquina
npx lynkeus screen
```

En la app, la situación es distinta de la del CLI. Un simulador o un dispositivo no ve el entorno de tu terminal, así que el valor tiene que quedar incorporado al bundle de JavaScript cuando se compila. Cómo llega ahí depende de tu proyecto: del mecanismo que tu app ya use para sus variables de entorno. lynkeus no agrega ninguno. Lo que importa es que el valor que recibe la opción `token` sea el mismo que el CLI lee de `LYNKEUS_TOKEN`.

:::note[En Expo]
Expo solo incorpora al bundle las variables que empiezan con `EXPO_PUBLIC_`. La app lee el token de `EXPO_PUBLIC_LYNKEUS_TOKEN`, y el CLI sigue leyendo `LYNKEUS_TOKEN`. Las dos tienen que tener el mismo valor. Los pasos están en la [instalación en Expo](/es/getting-started/installation-expo/).
:::

Si los valores no coinciden, la app rechaza al driver y el CLI termina con `No app attached on …`. Ese síntoma está en [Solución de problemas](/es/troubleshooting/).

### `LYNKEUS_PORT`

El puerto donde escucha el driver y al que se conecta la app. Por defecto es `8123`. Reemplaza a `port` de `lynkeus.config.json`.

La leen el CLI, para saber dónde escuchar, y `lynkeus headless start`, que escribe ese puerto en el host que arranca. Con la misma variable en los dos, el par queda apuntando al mismo puerto.

Sirve para tener varios pares funcionando en una misma máquina, por ejemplo al ejecutar casos en paralelo:

```bash
# Terminal 1: un host y su driver en 8124
LYNKEUS_PORT=8124 LYNKEUS_TOKEN=secreto npx lynkeus headless start

# Terminal 2
LYNKEUS_PORT=8124 LYNKEUS_TOKEN=secreto npx lynkeus screen
```

:::caution
Una app en un simulador o en un dispositivo no lee esta variable. Se conecta al puerto que recibió en la opción `port` de `auto()` o de `<Lynkeus>`, que por defecto es `8123`. Si mueves el driver con `LYNKEUS_PORT`, pásale el mismo puerto a la app al montarla.
:::

Si el puerto ya está en uso, el CLI falla con `Port 8123 is already taken: another lynkeus run is probably still driving the app there. Stop it, or use another port (LYNKEUS_PORT, --ports).`

### `LYNKEUS_HOST`

Dónde escucha el driver. La lee solo el host sin pantalla, y hace falta cuando el host y su driver no están en el mismo lugar: un contenedor que tiene que conectarse hacia afuera, por ejemplo.

```bash
LYNKEUS_HOST=<dirección-del-driver> LYNKEUS_TOKEN=secreto npx lynkeus headless start
```

Sin ella, el host busca al driver en la misma máquina.

## Qué dispositivo y qué app

### `LYNKEUS_DEVICE`

El UDID o el nombre del simulador que usa el CLI. Reemplaza a `device` de la configuración, y la opción `--device` la reemplaza a ella. Acepta un nombre parcial.

Sin ningún valor, el CLI usa el primer simulador encendido. Si nombras uno que no está encendido, falla con `No booted simulator matching "<nombre>".`

### `LYNKEUS_APP_ID`

El bundle id o application id de la app. Reemplaza a `app` de la configuración, y la opción `--app` la reemplaza a ella. Lo usan `lynkeus launch`, la opción `--launch` y los comandos que actúan sobre el simulador.

### `LYNKEUS_ATTACH_TIMEOUT_MS`

Cuánto espera el CLI a que la app se conecte, en milisegundos. Por defecto `15000`. Reemplaza a `attachTimeout` de la configuración, y la opción `--attach-timeout` la reemplaza a ella.

Conviene subirla en CI, donde una app puede tardar más en arrancar:

```bash
LYNKEUS_ATTACH_TIMEOUT_MS=60000 npx lynkeus case run
```

## Casos

### `LYNKEUS_CONFIG`

La ruta de un segundo archivo de configuración, que se lee encima del `lynkeus.config.json` de la app. Existe porque los casos y los fixtures suelen vivir en un repositorio propio.

```bash
LYNKEUS_CONFIG=../qa-suite/lynkeus.config.json npx lynkeus case run
```

Las claves de primer nivel del segundo archivo reemplazan enteras a las del primero, y las rutas bajo su clave `cases` son relativas a ese archivo. Los detalles están en [Configuración](/es/reference/configuration/#un-segundo-archivo-con-lynkeus_config).

### `LYNKEUS_SEED`

Hace que las referencias `{{random.letters}}` y `{{random.digits}}` de un caso den los mismos valores en cada ejecución.

Sin la variable, esos valores son nuevos cada vez. Con ella definida con cualquier valor, cada caso obtiene siempre los mismos, y distintos de los del caso de al lado. Es lo que hace falta para comparar las pantallas de dos ejecuciones: si el nombre del usuario cambia cada vez, todas las capturas difieren.

```bash
LYNKEUS_SEED=1 npx lynkeus case run --out run --screenshots
```

Los valores dependen de la semilla y del id del caso. Cambiar el valor de la semilla cambia todos los valores.

### `LYNKEUS_RECORD_SCREENS`

Con el valor `1`, cada `lynkeus screen` guarda la estructura de la pantalla en `.lynkeus/screens/` y avisa de lo que cambió desde la última lectura. Es lo mismo que pasar `--record` en cada llamada.

```bash
LYNKEUS_RECORD_SCREENS=1 npx lynkeus screen
```

Solo el valor exacto `1` la activa. Lo grabado es lo que después lee `lynkeus map changes`.

## Reportes

### `LYNKEUS_REPORTS_URL` y `LYNKEUS_REPORTS_KEY`

La dirección del servicio de reportes y la clave de API de la organización. Las leen `lynkeus case run --push` y todos los comandos `lynkeus report`. Hacen falta las dos.

```bash
export LYNKEUS_REPORTS_URL=https://lynkeus.io
export LYNKEUS_REPORTS_KEY=lk_…
npx lynkeus case run --out run --screenshots --push
```

Si falta alguna, el comando termina con `set LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY (the organisation’s API key)`.

La clave se crea en el servicio, en la sección de claves de API, y se muestra una sola vez. Es un secreto: en CI va en los secretos del repositorio, nunca en el archivo del workflow.

```yaml
- run: npx lynkeus case run --out run --screenshots --video --push
  env:
    LYNKEUS_REPORTS_URL: https://lynkeus.io
    LYNKEUS_REPORTS_KEY: ${{ secrets.LYNKEUS_REPORTS_KEY }}
```

La guía de [Reportes](/es/guides/reports/) cubre el recorrido completo.

## Variables de otros que lynkeus lee o define

Estas variables no son de lynkeus, pero influyen en lo que hace.

| Variable | Quién la lee | Qué pasa |
|---|---|---|
| `GITHUB_HEAD_REF`, `GITHUB_REF_NAME` | CLI | `case run --out` anota en `run.json` la rama desde la que se hizo la ejecución. En GitHub Actions la toma de estas variables, en ese orden; fuera de ahí, se la pregunta a git. |
| `NODE_OPTIONS` | `headless start` | Le agrega `--dns-result-order=ipv4first` antes de arrancar jest, y conserva lo que ya tuviera. Node resuelve `localhost` primero como IPv6, y un backend local suele escuchar solo en IPv4. |
| `CI` | `headless start` | La define como `1` para el proceso de jest que aloja la app. |
| la que nombre `apiEnv` (por defecto `API_URL`) | host sin pantalla | La entrada que genera `headless init` comprueba que apunte a un backend local antes de renderizar la app. Si no, se detiene con `lynkeus headless only drives a local backend; API_URL is "…"`. |
| `EXPO_PUBLIC_LYNKEUS_TOKEN` | tu app en Expo | El token, con el prefijo que Expo exige para incorporarlo al bundle. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | tu backend | No la lee lynkeus. Es la variable estándar de OpenTelemetry con la que tu backend sabe adónde exportar sus trazas. Con `case run --traces`, apúntala a `http://localhost:4318`, o al puerto de `--traces-port`. Ver [Trazas del backend](/es/guides/backend-traces/). |

## Variables en los casos y en los fixtures

Además de las anteriores, hay dos lugares donde el entorno entra en una ejecución por decisión tuya:

- **`{{env.NOMBRE}}` en un caso.** Cualquier paso puede leer una variable de entorno del proceso del CLI. Si la variable no está definida, el paso falla con `{{env.NOMBRE}} is empty`.
- **`cases.fixtures.env` en la configuración.** Variables adicionales para el comando de fixtures. Se suman al entorno del CLI, que el comando hereda completo.

```yaml
steps:
  - app.type: { text: "{{env.QA_PASSWORD}}", target: "#password-input" }
```
