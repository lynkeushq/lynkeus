---
title: Escribir casos
description: "El formato de un caso en la práctica: setup y pasos, alias y valores entre llaves dobles, pasos que dependen del host, macros, interrupciones, y cómo ejecutar uno o muchos."
---

Un caso es un test escrito en un archivo que una persona puede leer de arriba abajo: qué tiene que existir, qué hace el usuario y qué debe ser cierto al final. El mismo archivo corre en un simulador, en un teléfono y en el host sin pantalla.

Esta guía es para quien escribe y mantiene los tests. Parte de un caso mínimo y va agregando lo que un proyecto real termina necesitando. La lista completa de pasos y parámetros está en la [referencia del formato](/es/reference/case-format/).

## Antes de empezar

- Ya puedes manejar la app desde la terminal ([guía](/es/guides/driving-the-app/)).
- Conoces los `testID` y las rutas de las pantallas que vas a probar. `npx lynkeus screen` te los muestra.

## 1. Crea el primer caso

```bash
npx lynkeus case init
```

Deberías ver:

```text
wrote cases/example.md
wrote cases/README.md
wrote cases/fixtures.mjs
added cases to lynkeus.config.json
next: `lynkeus case run cases/example.md --dry-run`, then make fixtures.mjs talk to your backend
```

El comando deja un caso de ejemplo, la referencia del formato y un servidor de fixtures para empezar. Los fixtures son los datos de prueba que se preparan en el backend; tienen [su propia guía](/es/guides/fixtures/). Por ahora escribe un caso que no los necesita:

```md title="cases/settings-dark-mode.md"
---
id: settings-dark-mode
title: "Ajustes: cambiar a modo oscuro"
description: >
  Quien elige el modo oscuro lo ve marcado como seleccionado.
---
steps:
  - app.press: "#settings-button"
  - app.wait: Settings.Main
  - app.press: "Dark"
  - app.see: { testId: theme-dark-selected }

expected: |
  La opción de modo oscuro queda seleccionada.
```

El archivo tiene dos partes. El encabezado, entre las líneas `---`, nombra el caso: `id` lo identifica en los reportes (si falta, se usa el nombre del archivo), y `title` y `description` explican qué demuestra. El cuerpo es YAML con tres claves:

| Clave | Qué contiene |
|---|---|
| `setup` | Lo que tiene que existir antes de empezar. Si un paso de aquí falla, el caso no continúa. |
| `steps` | Lo que hace la persona y lo que se comprueba. |
| `expected` | Una frase para quien lee: qué queda demostrado. No se ejecuta. |

Cada paso es una sola clave con su valor: `verbo: valor`.

## 2. Revísalo sin ejecutarlo

```bash
npx lynkeus case run cases/settings-dark-mode.md --dry-run
```

`--dry-run` analiza el archivo y lista los pasos sin tocar la app. Atrapa los errores de escritura antes de gastar una ejecución: un verbo que no existe aparece como `app.pres is not a step: lynkeus has no command pres, and the project declares no macro for it`.

## 3. Ejecútalo

Con la app abierta en el simulador:

```bash
npx lynkeus case run cases/settings-dark-mode.md
```

O sin simulador, alojando la app en Node durante la ejecución:

```bash
npx lynkeus case run cases/settings-dark-mode.md --host
```

Deberías ver cada paso con su duración y, al final, el resumen (los tiempos son ilustrativos):

```text
▶ settings-dark-mode — Ajustes: cambiar a modo oscuro
  ✅ app.press #settings-button  (71ms)
  ✅ app.wait Settings.Main  (212ms)
  ✅ app.press Dark  (64ms)
  ✅ app.see testId: theme-dark-selected  (9ms)
✅ PASSED  ✅ 4  — 0.4s
✅ settings-dark-mode
1/1 passed
```

Un paso que falla detiene el caso. La salida muestra entonces la pantalla en el momento del fallo, las últimas peticiones de la app y el porqué: cubierto, oculto tras una capa, deshabilitado, desaparecido.

## Los pasos que manejan la app

Los pasos `app.*` son los comandos de la terminal con otra sintaxis. Estos son los que usarás a diario:

| Paso | Valor | Notas |
|---|---|---|
| `app.press` | objetivo, o `{ target, within?, nth?, optional?, hold? }` | Espera a que el control esté y esté habilitado. Con `optional` solo toca si está en pantalla. |
| `app.type` | `{ text, target?, submit?, clear? }` | Toca primero `target`. |
| `app.swipe` | `{ direction, target?, distance? }` o `{ from, to }` | |
| `app.wait` | ruta, objetivo, ms, `{ target, scroll? }` o `{ request, status? }` | Una `request` se escribe `MÉTODO /ruta`. |
| `app.see` | objetivo, o `{ testId?, text?, route?, request?, event?, layer?, absent?, timeoutMs? }` | Una afirmación. Todo lo que nombres debe cumplirse. |
| `app.nav` | ruta, o `{ route, params }` | Un teletransporte, para llegar a donde empieza el caso. |
| `app.back` | | |
| `app.call` | `{ command, params?, expect?, as? }` | Un comando que la app registró con `qa.register`. |

Cualquier otro comando de lynkeus también es un paso, con sus argumentos por nombre: `app.mock`, `app.network`, `app.appstate`, `app.deeplink`.

`app.press` y `app.see` hacen más de lo que parece. Si el objetivo no está, esperan un momento por si está llegando, deslizan por si quedó más abajo y esperan otro poco por si un carrusel está por mostrarlo. Solo entonces empieza a correr el plazo del paso (3000 ms en `app.see`, salvo que indiques `timeoutMs`). Por eso rara vez hace falta escribir un deslizamiento a mano.

### Comprobar una petición

`app.see` y `app.wait` también miran lo que la app le pidió al backend:

```yaml
steps:
  - app.press: "#pay-button"
  - app.wait: { request: "POST /v3/payments", status: 201 }
```

Solo cuentan las peticiones que empezaron después de que comenzó el paso anterior. Así una petición vieja a la misma ruta no pasa por la que tu acción provocó. Si necesitas contar desde antes, el paso `app.requests: mark` pone la marca a mano.

## Guardar una respuesta y usarla después

Un paso puede guardar lo que le respondieron con `as`, y los pasos siguientes lo leen entre llaves dobles:

```yaml
setup:
  - create_user: { as: u, name: "Ana" }

steps:
  - app.type: { text: "{{u.name}}", target: "#name-input" }
  - app.see: { text: "Hola, {{u.name}}" }
```

`u` es un alias: el nombre que le diste a esa respuesta. `{{u.user_id}}` lee un campo de ella. Dentro de las llaves caben otras cuatro fuentes:

| Expresión | Valor |
|---|---|
| `{{random.letters}}` | Seis letras al azar, nuevas en cada ejecución. |
| `{{random.digits}}` | Seis dígitos al azar. |
| `{{env.NOMBRE}}` | Una variable de entorno. |
| `{{matrix.clave}}` | El valor de esta combinación de la matriz (más abajo). |

Con la variable `LYNKEUS_SEED` definida, cada caso saca siempre los mismos valores aleatorios, distintos de los del caso de al lado. Es lo que hace falta para comparar las pantallas de dos ejecuciones.

Si usas un alias que nadie creó, el caso falla con `` no alias 'u' (add `as: u` to the step that creates it) ``.

## Un caso, varias entradas

Cuando el mismo recorrido debe probarse con varias combinaciones, decláralas en el encabezado:

```yaml
---
id: signup
matrix: { locale: [en, fr], login: [phone, email] }
---
steps:
  - app.see: { testId: "signup-{{matrix.login}}-input" }
```

El caso corre una vez por combinación y cada ejecución lleva su nombre: `signup[locale=fr,login=phone]`.

## Pasos que solo aplican en un host

Un caso corre en un host sin pantalla y en un dispositivo. A veces uno de los dos necesita algo que el otro no, como cerrar una pantalla nativa que el host nunca muestra. Esos pasos van bajo `on`:

```yaml
steps:
  - on: device
    do:
      - app.press: "364,84"
```

`on` acepta `device`, `headless`, `ios`, `android` y `has:<comando>` (el host cuya app registró ese comando). Un `!` adelante lo invierte: `on: "!ios"`. En los demás hosts el paso se omite.

Hay un tercer resultado además de pasar o fallar. Si un paso pide algo que el host no puede hacer, como una respuesta simulada en un dispositivo real, el caso se detiene ahí y se cuenta como `unsupported`: no falla la ejecución, y el mismo caso pasa donde el host sí puede.

## Pasos propios: macros

Cuando tres o cuatro pasos se repiten en cada caso (iniciar sesión, casi siempre), dales un nombre en `lynkeus.config.json`:

```json title="lynkeus.config.json"
{
  "cases": {
    "macros": {
      "app.login": [
        { "app.call": { "command": "reset" } },
        { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
        { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
      ]
    }
  }
}
```

El caso lo usa como cualquier otro paso:

```yaml
setup:
  - create_user: { as: u }
  - app.login: { as: u, wait: Home.Main }
```

Dentro de la macro, `{{param.x}}` es lo que el caso pasó. Si un parámetro nombra un alias, vale por ese alias: por eso `{{param.as.user_id}}` lee el `user_id` de `u`. `when` ejecuta un paso solo si el caso pasó ese parámetro (`"when": "wait"`) o ese valor (`"when": "method=phone"`); `unless` hace lo contrario.

## Lo que se atraviesa: interrupciones

Una pantalla de bloqueo o una hoja de consentimiento pueden aparecer delante de cualquier paso. En lugar de defender cada caso, descríbelas una vez:

```json title="lynkeus.config.json"
{
  "cases": {
    "interruptions": [
      { "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }
    ]
  }
}
```

Antes de tocar, escribir, deslizar o comprobar, lynkeus mira si `see` está en pantalla y, si está, ejecuta `do`. Un paso cuyo propio texto coincide con `unless` trata justamente de esa pantalla, y se deja en paz.

## Ejecutar uno o muchos

```bash
npx lynkeus case run                          # todos los .md de cases.dir
npx lynkeus case run cases/a.md cases/b.md    # solo estos
npx lynkeus case run --continue               # sigue con los pasos del caso aunque uno falle
npx lynkeus case run --report out.jsonl       # una línea JSON por caso
```

Sin archivos, corre todos los `.md` de la carpeta de casos, salvo `README.md`, `FORMAT.md` y `CATALOG.md`. El comando termina con código 1 si algún caso falló.

### Reintentos

Un caso que falla se ejecuta una vez más antes de contarse como fallido. Si pasa en el segundo intento, el resumen lo dice: `⚠ passed on retry`. `--once` quita esa segunda oportunidad. Qué hacer con los casos que pasan a veces está en [tests intermitentes](/es/guides/flaky-tests/).

### Varios casos a la vez

Cada trabajo en paralelo necesita su propio host, y cada host marca a su propio puerto. Arranca un host por puerto y dile a `case run` cuáles son:

```bash
# En dos terminales (el token es el mismo que lee la app)
LYNKEUS_TOKEN=secret LYNKEUS_PORT=8123 npx lynkeus headless start
LYNKEUS_TOKEN=secret LYNKEUS_PORT=8124 npx lynkeus headless start

# En una tercera
LYNKEUS_TOKEN=secret npx lynkeus case run --jobs 2 --ports 8123,8124
```

Los casos más largos empiezan primero, para que los trabajos terminen juntos; `--in-order` respeta el orden dado. Si faltan puertos verás `--jobs and --host-command need a driver port per job: --ports with 2`.

`--host-command <comando>` va un paso más allá: arranca un host nuevo para cada caso y lo detiene al terminar. En el comando, `{port}` es el puerto al que debe marcar el host y `{job}` el número de trabajo.

## Cómo funciona

`case run` abre una sola conexión con la app y envía por ella los mismos comandos de la terminal. Antes del primer caso arranca el comando de fixtures y lo mantiene vivo. Además, espera lo que solo un dispositivo hace: la inercia de un paginador después de levantar el dedo, o una pantalla que todavía se está deslizando hacia su lugar. Por eso el mismo archivo sirve en ambos hosts sin pausas escritas a mano.

## Problemas frecuentes

**`no frontmatter (a case starts with --- and its id)`.** El archivo no empieza con el encabezado entre líneas `---`.

**`must be one step, as verb: value`.** Un elemento de la lista tiene dos claves. Cada paso lleva una sola; los parámetros van dentro del valor.

**`has do without on`.** Un bloque `do` necesita su `on`.

**`no cases under cases`.** No hay casos en la carpeta configurada. `cases.dir` en `lynkeus.config.json` dice dónde buscar.

**Los casos viven en otro repositorio.** `LYNKEUS_CONFIG` nombra un segundo archivo de configuración que se lee encima del de la app; las rutas bajo su clave `cases` son relativas a ese archivo.

## Siguientes pasos

- [Fixtures](/es/guides/fixtures/): preparar el backend para cada caso.
- [Reportes](/es/guides/reports/): guardar la ejecución y compartirla.
- [Referencia del formato](/es/reference/case-format/): cada verbo con todos sus parámetros.
