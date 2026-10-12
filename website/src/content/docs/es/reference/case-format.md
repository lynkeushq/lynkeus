---
title: Formato de un caso
description: La estructura del archivo de un caso y todos los verbos que puede usar un paso, con sus parámetros.
---

Un **caso** es un archivo Markdown que describe un test de forma que una persona lo pueda leer de arriba abajo: qué tiene que existir, qué hace el usuario y qué debe ser cierto al final. Esta página es la referencia de ese formato. Si buscas un recorrido guiado, empieza por [Escribir casos](/es/guides/writing-cases/).

La referencia cubre el encabezado, las secciones, cada verbo que puede usar un paso, las condiciones `on:`, las referencias `{{…}}`, los macros y las interrupciones.

## La estructura del archivo

Un caso tiene dos partes: un encabezado en YAML entre dos líneas `---`, y un cuerpo, también en YAML, con tres secciones.

```md title="cases/points.md"
---
id: points
title: "Una usuaria que recibe puntos los ve en la primera pantalla"
description: >
  Qué demuestra este caso y por qué importa, en una o dos frases.
---
setup:
  # Lo que no empieza con `app.` es un fixture: lo responde tu servidor de fixtures.
  - create_user: { as: u, name: "Ana" }

steps:
  - app.see: { text: "Hola" }
  - give_points: { user: u, points: 25 }
  - app.see: { text: "25 puntos", timeoutMs: 10000 }
  - assert: { user: u, path: points, equals: 25 }

expected: |
  Los puntos en pantalla y los que guarda el backend son 25.
```

Si el archivo no empieza con el encabezado, el caso se rechaza con `no frontmatter (a case starts with --- and its id)`.

### El encabezado

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `id` | texto | el nombre del archivo sin `.md` | El identificador del caso. Es el que aparece en los reportes y el que recibe `lynkeus report history`. |
| `title` | texto | ninguno | Una frase que dice qué demuestra el caso. |
| `description` | texto | ninguno | Una explicación más larga. Llega al reporte. |
| `matrix` | objeto | ninguno | Ejecuta el caso una vez por cada combinación de valores. Ver [Matrices](#matrices). |

### Las secciones

| Sección | Qué contiene |
|---|---|
| `setup` | Los pasos que preparan el estado antes de que empiece lo que se quiere probar. |
| `steps` | Los pasos del test. |
| `expected` | Un texto libre que dice qué demuestra el caso. Es para quien lo lee; no se ejecuta. |

`setup` y `steps` son listas de pasos y aceptan los mismos verbos. La diferencia está en lo que pasa cuando algo falla: un paso de `setup` que falla detiene el caso siempre, incluso con `--continue`, porque los pasos siguientes no tendrían sobre qué apoyarse.

### Cómo se escribe un paso

Cada paso es una sola clave: el **verbo**, seguido de su valor. Un verbo sin valor se puede escribir solo.

```yaml
steps:
  - app.back                                   # un verbo sin valor
  - app.press: "#next-button"                  # un valor simple
  - app.type: { text: "Ana", target: "#name" } # un valor con parámetros
```

Un elemento de la lista con más de una clave se rechaza con `must be one step, as verb: value`.

Hay cuatro familias de verbos:

| Verbo | Qué hace |
|---|---|
| `app.<algo>` | Maneja la app o comprueba algo en ella. |
| `assert` | Lee el backend y comprueba un valor. |
| `exec` | Ejecuta un comando de shell. |
| cualquier otro nombre | Es un **fixture**: lynkeus se lo envía al comando declarado en `cases.fixtures`. |

## Objetivos

Muchos verbos reciben un **objetivo**: el elemento sobre el que actúan. Se escribe de cuatro formas.

| Forma | Qué encuentra |
|---|---|
| `"#next-button"` | El elemento con ese `testID`. |
| `'"Continuar"'` | Un control cuya etiqueta es ese texto y, si no hay, uno que lo contenga. Un párrafo solo coincide por texto exacto. |
| `12` | El elemento con ese índice en el listado de la pantalla. |
| `"100,200"` | Un punto de la ventana. |

En YAML, `#` empieza un comentario, así que un objetivo por `testID` va siempre entre comillas. Un objetivo por texto lleva sus propias comillas dobles dentro de las del YAML: `'"Continuar"'`.

Cuando hay varias coincidencias, dos parámetros eligen entre ellas:

| Parámetro | Qué hace |
|---|---|
| `within` | Otro objetivo. Elige la coincidencia más cercana a él: el botón "me gusta" que va con un mensaje determinado. |
| `nth` | El número de coincidencia, contando desde 0. |

## Verbos que manejan la app

### `app.press`

Pulsa un control. Antes de pulsar espera a que el control esté en pantalla, habilitado, sin nada encima y quieto.

```yaml
- app.press: "#pay-button"
- app.press: { target: "#like-button", within: '"hola de Ana"' }
- app.press: { target: "#skip-promo", optional: true }
```

| Parámetro | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `target` | objetivo | obligatorio | Lo que se pulsa. |
| `within` | objetivo | ninguno | Elige la coincidencia más cercana a este objetivo. |
| `nth` | número | ninguno | Elige la coincidencia número `nth`, desde 0. |
| `optional` | booleano | `false` | Pulsa solo si el control está en pantalla. Si no está, el paso queda como omitido y el caso sigue. |
| `hold` | número (ms) | `50` | Cuánto se mantiene el dedo. Unos 600 ms son una pulsación larga. |
| `timeoutMs` | número (ms) | `3000` | Cuánto esperar a que el control quede habilitado y libre. |
| `js` | booleano | `false` | Llama a `onPress` directamente, sin sintetizar un toque. |

Si el objetivo no aparece en el listado, `app.press` espera un momento y después se desplaza por la página para buscarlo. Lo mismo si está en el listado pero fuera de la ventana.

### `app.type`

Escribe en un campo.

```yaml
- app.type: { text: "ana@example.com", target: "#email-input", submit: true }
```

| Parámetro | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `text` | texto | obligatorio | Lo que se escribe. |
| `target` | objetivo | el campo con foco | El campo que se toca antes de escribir. |
| `within`, `nth` | | | Eligen entre varias coincidencias, como en `app.press`. |
| `clear` | booleano | `false` | Vacía el campo primero. |
| `paste` | booleano | `false` | Inserta todo el texto de una vez, en lugar de tecla por tecla. |
| `submit` | booleano | `false` | Termina con la tecla de retorno. |

Sin `paste`, las teclas se envían de a una, con una pequeña pausa entre ellas, para que los formateadores del campo se comporten como con un teclado real.

### `app.swipe`

Arrastra el dedo.

```yaml
- app.swipe: { direction: up }
- app.swipe: { direction: left, target: "#carousel", distance: 200 }
- app.swipe: { from: "200,600", to: "200,200" }
```

| Parámetro | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `direction` | `up`, `down`, `left`, `right` | ninguno | Hacia dónde se mueve el dedo. |
| `target` | objetivo | toda la ventana | El elemento sobre el que se arrastra: un deslizador, una hoja inferior. |
| `distance` | número (puntos) | el 60 % de la ventana en esa dirección | Cuánto se mueve el dedo. |
| `from`, `to` | `"x,y"` | ninguno | Los dos extremos del arrastre, en lugar de una dirección. |
| `durationMs` | número (ms) | `250` | Cuánto dura el arrastre. |

En un dispositivo, después de un `app.swipe` el caso espera a que la pantalla deje de moverse. Un paginador sigue en movimiento después de que el dedo se levanta, y se tragaría un arrastre enviado durante esa inercia.

### `app.wait`

Espera. Según el valor, espera un tiempo fijo, una ruta, un elemento o una petición.

```yaml
- app.wait: 800                                  # milisegundos
- app.wait: Settings.Main                        # una ruta
- app.wait: "#row-25"                            # un objetivo
- app.wait: { target: "#row-25", scroll: true }  # desplazando hasta verlo
- app.wait: { target: "#spinner", gone: true }   # hasta que se vaya
- app.wait: { request: "POST /v1/orders", status: 201 }
```

Con una ruta o un objetivo:

| Parámetro | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `target` | ruta u objetivo | obligatorio | Lo que se espera. |
| `within`, `nth` | | | Eligen entre varias coincidencias. |
| `scroll` | booleano | `false` | Desplaza la lista más cercana hasta que el objetivo esté en la ventana. |
| `gone` | booleano | `false` | Espera a que deje de estar en pantalla. |
| `timeoutMs` | número (ms) | `10000` | Cuánto esperar antes de fallar. |

Con una petición:

| Parámetro | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `request` | texto | obligatorio | `MÉTODO /ruta`. Una ruta sola coincide con cualquier método. La ruta se compara con el final de la URL, sin la cadena de consulta. |
| `status` | número | cualquier `2xx` | El estado HTTP esperado. |
| `timeoutMs` | número (ms) | `10000` | Cuánto esperar antes de fallar. |

Una petición solo cuenta si empezó después de que comenzara el paso de acción anterior. La sección [Qué peticiones cuentan](#qué-peticiones-cuentan) lo explica.

### `app.see`

Comprueba lo que la app muestra o hizo. Es la aserción principal de un caso. Todo lo que nombres tiene que cumplirse a la vez.

```yaml
- app.see: "#pay-button"
- app.see: { text: "25 puntos", timeoutMs: 10000 }
- app.see: { target: "#balance", text: "25" }
- app.see: { route: Checkout.Confirm, request: "GET /v1/cart" }
- app.see: { target: "#error-banner", absent: true }
```

| Parámetro | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `target` | objetivo | ninguno | Un elemento que tiene que estar en pantalla. También como `testId`. |
| `within`, `nth` | | | Eligen entre varias coincidencias. |
| `text` | texto | ninguno | Solo: algún elemento presentado contiene ese texto. Con `target`: el texto del elemento, o el de un elemento que tiene dentro, lo contiene. |
| `route` | texto | ninguno | La ruta actual es esta. |
| `request` | texto | ninguno | La app hizo esa petición, con el formato `MÉTODO /ruta`. |
| `status` | número | cualquiera | Con `request`: la petición respondió con ese estado. |
| `event` | texto | ninguno | La app envió un evento de analítica con ese nombre. |
| `props` | objeto | ninguno | Con `event`: el evento lleva estas propiedades con estos valores. |
| `layer` | booleano o texto | ninguno | `true`: hay una capa abierta sobre la pantalla (un modal, una hoja). `false`: no hay ninguna. Un texto: hay una capa abierta cuyo `testID` lo contiene. |
| `absent` | booleano | `false` | Invierte la comprobación: pasa cuando lo nombrado **no** se cumple. |
| `timeoutMs` | número (ms) | `3000` | Cuánto esperar a que se cumpla. |

Dos comportamientos que conviene conocer:

- Mientras la app tiene peticiones en curso, `app.see` sigue esperando más allá de `timeoutMs`, hasta un tope de 12 segundos. Una pantalla que todavía está cargando no es una pantalla equivocada.
- En un dispositivo, si el objetivo no está en pantalla, `app.see` lo busca antes de fallar: espera un momento por si está llegando, se desplaza por si está más abajo y vuelve a esperar por si un carrusel está por mostrarlo. Recién entonces corre el plazo del paso. Nunca hace un desplazamiento que cerraría una hoja.

### `app.nav`

Salta directamente a una ruta. Es un atajo para llegar adonde empieza el caso, no una acción de usuario.

```yaml
- app.nav: Settings.Main
- app.nav: { route: Checkout.Confirm, params: { id: "abc" } }
```

Después de saltar, espera a que la app esté en esa ruta y a que se aquiete.

### `app.back`

Vuelve a la pantalla anterior. No lleva valor.

### `app.call`

Ejecuta un comando que la app registró con `qa.register`. La [API del agente](/es/reference/agent-api/) explica cómo registrarlos.

```yaml
- app.call: { command: reset }
- app.call: { command: setFlag, params: { name: new-checkout, on: true } }
- app.call: { command: stores, params: { name: session }, as: s, expect: { loggedIn: true } }
```

| Parámetro | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `command` | texto | obligatorio | El nombre del comando. |
| `params` | cualquiera | ninguno | Lo que recibe el comando. |
| `as` | texto | ninguno | Guarda la respuesta bajo ese alias, para leerla después con `{{alias.campo}}`. |
| `expect` | objeto | ninguno | Comprueba campos de la respuesta: cada clave es una ruta con puntos y cada valor lo que debe valer. `null` exige que el campo no exista. |
| `timeoutMs` | número (ms) | `3000` | Con `expect`: cuánto seguir reintentando hasta que la respuesta coincida. |

### `app.run`

Ejecuta un flow de lynkeus desde la carpeta de flows (`cases.flows`).

```yaml
- app.run: login.json
- app.run: { flow: login.json, vars: { phone: "1124888418" } }
```

### `app.requests`

```yaml
- app.requests: mark
```

Marca un punto en la lista de peticiones de la app. A partir de ahí, los pasos que buscan una petición (`app.see` o `app.wait` con `request`) cuentan todo lo que la app pidió desde la marca, hasta que uno de ellos encuentra la suya.

### `app.event` y `app.events`

Comprueban lo que la app envió a su analítica con `qa.event`. La guía [Eventos de analítica](/es/guides/analytics-events/) muestra cómo instrumentar la app.

```yaml
- app.events: clear
- app.press: "#signup-button"
- app.event: signup_started
- app.event: { name: signup_started, props: { source: "home" } }
- app.event: { name: signup_failed, absent: true }
```

| Verbo | Valor | Qué hace |
|---|---|---|
| `app.events` | `clear` | Vacía el búfer de eventos de la app. |
| `app.event` | el nombre, o `{ name, props?, absent?, timeoutMs? }` | Comprueba que la app envió ese evento. Con `props`, que lleva esas propiedades. |

### Cualquier otro comando de lynkeus

Un paso `app.<comando>` que no es ninguno de los anteriores ejecuta el comando del CLI con ese nombre. Los del grupo `os` se escriben sin el prefijo: `app.deeplink`, `app.appstate`, `app.network`, `app.clock`, `app.biometrics`, `app.scan`, `app.gallery`. También `app.mock`, `app.idle`, `app.launch` y los demás de la [referencia del CLI](/es/reference/cli/).

```yaml
- app.deeplink: "myapp://pay/abc"
- app.appstate: background
- app.mock: { route: "GET /v3/accounts", status: 500 }
- app.clock: { now: "2027-01-01T00:00:00Z" }
- app.mock: clear
```

El valor se convierte en los argumentos del comando así:

- Un valor simple es el primer argumento. Si coincide con el nombre de un interruptor del comando, lo activa: `app.mock: clear` equivale a `lynkeus mock --clear`.
- En un objeto, las claves que coinciden con el nombre de un argumento van en su lugar y las demás son opciones. `true` activa un interruptor.
- El primer argumento también se puede llamar `target`, `request`, `route`, `url`, `state` o `text`, aunque el comando lo llame de otro modo.

Algunas opciones tienen un nombre alternativo, más claro dentro de un caso:

| En el caso | Opción del comando |
|---|---|
| `within` | `--in` |
| `timeoutMs` | `--timeout` |
| `holdMs` | `--hold` |
| `delayMs` | `--delay` |
| `durationMs` | `--duration` |
| `advanceMs` | `--advance` |

Una clave que el comando no reconoce hace fallar el paso con `<comando> has no <clave>`. Un verbo que no corresponde a ningún comando ni a ningún macro falla con `app.<nombre> is not a step: lynkeus has no command <nombre>, and the project declares no macro for it`.

## Verbos que preparan y leen el backend

### Fixtures

Los **fixtures** son los datos de prueba que un caso prepara en el backend: un usuario, un pedido, un saldo. Cualquier paso cuyo nombre no empieza con `app.`, y que no es `assert` ni `exec`, es un fixture. lynkeus se lo envía a tu servidor de fixtures como una línea de JSON y lee una línea de respuesta.

```yaml
- create_user: { as: u, name: "Ana", plan: "pro" }
- give_points: { user: u, points: 25 }
```

| Parámetro | Qué hace |
|---|---|
| `as` | Guarda la respuesta bajo ese alias. No se envía al servidor. |
| los nombres declarados en `cases.refs` | Se reemplazan por el campo correspondiente del alias que nombran. Ver [Configuración](/es/reference/configuration/#casesrefs). |
| todo lo demás | Llega al servidor tal como está escrito. |

Antes del primer caso, lynkeus le pregunta al servidor qué fixtures responde. Si un caso nombra uno que no está en esa lista, se rechaza antes de ejecutar nada, en lugar de fallar a la mitad con el backend ya modificado. El protocolo completo está en la guía de [Fixtures](/es/guides/fixtures/).

Si el proyecto no declara `cases.fixtures`, un paso así falla con `<nombre> is not a step lynkeus has, and the project declares no fixtures (cases.fixtures in lynkeus.config.json)`.

### `assert`

Lee el backend y comprueba un valor. Llama al fixture de inspección (`inspect`, o el que nombre `cases.inspect`) y compara un campo de su respuesta.

```yaml
- assert: { user: u, path: points, equals: 25 }
- assert: { user: u, path: orders.0.status, matches: "^(paid|shipped)$" }
- assert: { user: u, path: orders.*.id, includes: "ord_42" }
```

| Parámetro | Qué hace |
|---|---|
| `path` | Obligatorio. La ruta del campo, con puntos: `a.b.0.c`. Un número es una posición en una lista. `a.*.b` reúne el campo `b` de cada elemento de la lista `a`. |
| un comparador | Obligatorio. Uno de la tabla de abajo. |
| todo lo demás | Se le pasa al fixture de inspección, con las mismas reglas de `refs` que cualquier fixture. |

| Comparador | Pasa cuando |
|---|---|
| `equals` | El valor es igual. Si los dos lados son números, se comparan como números; si no, como texto. |
| `near` | El valor es un número a no más de 0,01 del esperado. |
| `gte` | El valor es un número mayor o igual. |
| `lte` | El valor es un número menor o igual. |
| `includes` | El texto contiene al esperado. En una lista, algún elemento lo contiene. |
| `matches` | El valor, como texto, coincide con la expresión regular. |
| `present` | Con `true`, el campo existe y no es `null`. |
| `absent` | Con `true`, el campo no existe o es `null`. |

El fixture de inspección recibe además un parámetro `section`, con el primer segmento de `path`. Un servidor que arma su respuesta por partes puede calcular solo esa. Varios `assert` seguidos sobre la misma sección leen una única respuesta.

Cuando no coincide, el error dice el valor que encontró: `points is 20`.

### `exec`

Ejecuta un comando de shell, para lo que no encaja en un fixture.

```yaml
- exec: "bin/rails runner 'Feature.enable(:new_checkout)'"
- exec: { run: "node scripts/last-otp.mjs {{u.phone}}", as: otp }
- app.type: { text: "{{otp.code}}", target: "#otp-input" }
```

| Parámetro | Qué hace |
|---|---|
| `run` | El comando. |
| `as` | Guarda la salida bajo ese alias. Si la salida contiene un objeto JSON, se guarda ese objeto. Si no, se guarda `{ out: "<la salida>" }`. |

El comando se ejecuta desde la carpeta del archivo de configuración que declara `cases`, con el entorno de lynkeus y un límite de 120 segundos.

## Condiciones `on:`

Un mismo caso corre en un host sin pantalla y en un dispositivo. Lo que solo uno de los dos necesita, como cerrar una pantalla nativa que el host sin pantalla nunca muestra, se escribe en un bloque `on:` con sus pasos bajo `do:`. En los demás hosts esos pasos quedan como omitidos.

```yaml
steps:
  - app.press: "#open-camera"
  - on: device
    do:
      - app.press: "364,84"     # el botón de cerrar de la cámara nativa
  - on: headless
    do:
      - app.scan: "https://pay.example/abc"
```

| Condición | Se cumple cuando |
|---|---|
| `device` | La app corre en un simulador, un emulador o un dispositivo, con toques reales. |
| `headless` | La app corre en un host sin pantalla. |
| `ios`, `android` | La app informa esa plataforma. |
| `has:<comando>` | La app registró ese comando. Sirve cuando un build tiene comandos que otro no. |
| `!<condición>` | Lo contrario de cualquiera de las anteriores: `!ios`, `!has:reset`. |

Un bloque con `do:` y sin `on:` se rechaza.

## Referencias `{{…}}`

En cualquier valor de un paso puedes escribir una referencia entre llaves dobles. Se reemplaza justo antes de ejecutar el paso.

| Referencia | Qué vale |
|---|---|
| `{{alias.campo}}` | Un campo de lo que respondió un paso anterior con `as: alias`. La ruta admite puntos, posiciones y `*`, igual que en `assert`. |
| `{{random.letters}}` | Seis letras minúsculas al azar. |
| `{{random.digits}}` | Seis dígitos al azar. |
| `{{env.NOMBRE}}` | La variable de entorno `NOMBRE`. |
| `{{matrix.clave}}` | El valor de esa clave en la combinación que se está ejecutando. |
| `{{param.nombre}}` | Dentro de un macro: lo que el caso le pasó. |

```yaml
setup:
  - create_user: { as: u, email: "qa-{{random.letters}}@example.com" }
steps:
  - app.type: { text: "{{u.email}}", target: "#email-input" }
  - app.see: { text: "Hola, {{u.name}}" }
```

Un valor que es una sola referencia conserva su tipo: `points: "{{u.points}}"` llega como número si la respuesta tenía un número. Dentro de una frase, la referencia se convierte en texto.

Dos errores frecuentes:

- `no alias 'u' (add 'as: u' to the step that creates it)`: nombraste un alias que ningún paso anterior guardó.
- `{{u.email}} is empty`: el alias existe, pero ese campo no está en la respuesta o es `null`.

### Valores al azar repetibles

`{{random.letters}}` y `{{random.digits}}` son distintos en cada ejecución. Eso evita choques entre ejecuciones, pero impide comparar las pantallas de dos ejecuciones, porque los nombres cambian.

Con la variable de entorno `LYNKEUS_SEED` definida con cualquier valor, cada caso obtiene los mismos valores todas las veces, y valores distintos de los del caso de al lado.

```bash
LYNKEUS_SEED=1 npx lynkeus case run --out run --screenshots
```

## Matrices

Un caso que debe correr con varias entradas lo declara en su encabezado. Se ejecuta una vez por cada combinación.

```md
---
id: signup
matrix: { locale: [en, fr], login: [phone, email] }
---
steps:
  - app.call: { command: setLocale, params: { locale: "{{matrix.locale}}" } }
  - app.press: "#login-with-{{matrix.login}}"
```

Este ejemplo produce cuatro ejecuciones. Cada una lleva la combinación en su id: `signup[locale=en,login=phone]`, `signup[locale=en,login=email]`, y así.

`{{matrix.clave}}` se reemplaza en todo el archivo, encabezado incluido, antes de analizarlo. Una referencia a una clave que no está en `matrix` se rechaza con `{{matrix.x}} is not in its matrix`.

## Macros

Un **macro** es un paso propio del proyecto: un nombre que representa una secuencia de pasos. Se declaran en `cases.macros`, en `lynkeus.config.json`, y se usan en los casos como cualquier otro verbo.

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

```yaml
steps:
  - app.login: { as: u, wait: Home.Main }
```

Dentro del macro, `{{param.x}}` es lo que el caso pasó en la clave `x`. Si el valor de un parámetro es el nombre de un alias, el parámetro es ese alias: por eso `{{param.as.user_id}}` lee el `user_id` del usuario `u`. Si el caso pasa un valor simple en lugar de un objeto, está en `{{param.value}}`.

Un paso del macro puede ser condicional. Se escribe como un objeto con `do` y una o más condiciones:

| Clave | Qué hace |
|---|---|
| `do` | El paso que se ejecuta si las condiciones se cumplen. |
| `when` | Ejecuta el paso solo si la condición se cumple. Con una lista, tienen que cumplirse todas. |
| `unless` | Lo contrario: omite el paso si la condición se cumple. Con una lista, basta con que se cumpla una. |
| `on` | Una condición de host, igual que [`on:`](#condiciones-on) en un caso. |

Las condiciones de `when` y `unless` tienen tres formas:

| Condición | Se cumple cuando |
|---|---|
| `"wait"` | El caso pasó ese parámetro, y su valor no es `false`, `null` ni `none`. |
| `"method=phone"` | El caso pasó ese parámetro con ese valor. |
| `"ran:app.login"` | Ese verbo ya se ejecutó antes en este caso. |

Un macro cuenta como un solo paso del caso. En el reporte aparece como una línea, y las peticiones que espera son las que provocó desde su primera acción.

## Interrupciones

Una **interrupción** es algo que la app puede poner en medio de cualquier paso: una pantalla de bloqueo, un aviso de consentimiento. En lugar de prever esa pantalla en cada caso, la declaras una vez en `cases.interruptions`, junto con los pasos que la quitan.

```json title="lynkeus.config.json"
{
  "cases": {
    "interruptions": [
      { "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }
    ]
  }
}
```

| Clave | Qué hace |
|---|---|
| `see` | El objetivo que delata la interrupción. |
| `do` | Los pasos que la resuelven. Pueden ser macros. |
| `unless` | Opcional. Una expresión regular, sin distinción de mayúsculas. Si el valor del paso en curso coincide, ese paso trata justamente de la interrupción y se deja en paz. |

lynkeus busca las interrupciones antes de cada `app.press`, `app.type`, `app.swipe` y `app.see`, y mientras un `app.wait` espera. Si encuentra una presente, ejecuta sus pasos y después sigue con el paso original.

En el ejemplo, `unless: "keypad"` evita un ciclo: un caso que prueba el teclado de desbloqueo con `app.press: "#unlock-keypad-1"` no se interrumpe a sí mismo.

## Qué peticiones cuentan

Cuando un paso busca una petición, con `app.see` o `app.wait` y el parámetro `request`, no mira todo lo que la app pidió alguna vez. Cuenta solo las peticiones que empezaron después de que comenzara el último paso de acción: un `app.press`, un `app.type`, un `app.nav`.

La razón es que una pantalla anterior pudo haber hecho la misma petición. Sin este límite, esa petición vieja pasaría por la que provocó tu acción.

Los pasos que solo observan (`app.see`, `app.wait`, `app.event`) no mueven ese punto de partida. Por eso puedes encadenar varias comprobaciones después de una acción:

```yaml
- app.press: "#pay-button"
- app.see: { request: "POST /v1/payments", status: 201 }
- app.see: { request: "GET /v1/orders" }
```

Cuando necesitas mirar más atrás, `app.requests: mark` fija el punto a mano. La marca vale hasta que un paso encuentra la petición que buscaba.

## El resultado de un paso y de un caso

Cada paso termina en uno de cuatro estados:

| Estado | Qué significa |
|---|---|
| `passed` | Se ejecutó y salió bien. |
| `failed` | Se ejecutó y falló. |
| `skipped` | No se ejecutó: su condición `on:` no se cumplía, era un `app.press` opcional sin nada que pulsar, o un paso anterior ya había fallado. |
| `unsupported` | El host donde corre el caso no puede hacerlo. |

Un paso queda `unsupported` cuando pide algo que ese host no tiene: una respuesta simulada con `app.mock` en un dispositivo real, o un comando que la app no registra en ese build. En el reporte se lee `this host has no <comando>`. No es un fallo de la app. El caso se detiene ahí, cuenta como uno que no puede ejecutarse en este host y no hace fallar la ejecución.

Un caso termina como `passed`, `failed` o `unsupported`. Uno que falla se ejecuta una vez más antes de darse por fallido; si pasa en el segundo intento, el reporte lo marca como aprobado al reintentar. La opción `--once` desactiva ese segundo intento.

Para revisar un caso sin ejecutarlo:

```bash
npx lynkeus case run cases/points.md --dry-run
```

`--dry-run` analiza el archivo, lista los pasos y marca los que nombran un verbo o una opción que no existe.
