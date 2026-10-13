---
title: Configuración
description: Todas las claves de lynkeus.config.json, con su tipo, su valor por defecto y lo que hacen.
---

`lynkeus.config.json` guarda lo que de otro modo repetirías en cada invocación: qué simulador usar, dónde están los casos, cómo se prepara el backend. También es el lugar donde le dices a lynkeus lo que solo tú sabes de tu producto, como qué botones nunca debe pulsar un recorrido automático.

El archivo es opcional y todas sus claves también. Esta página las describe una por una.

## Dónde va y cómo se lee

El archivo va en la carpeta de la app, que es la carpeta actual o la que indiques con `--root`.

Cuando el mismo valor se puede dar de varias maneras, el orden de prioridad es siempre el mismo: la opción de la línea de comandos gana sobre la variable de entorno, y la variable de entorno gana sobre el archivo.

Si el archivo existe pero no es JSON válido, el comando falla y el mensaje empieza con la ruta del archivo.

### Un segundo archivo con `LYNKEUS_CONFIG`

Los casos y los fixtures suelen vivir en un repositorio propio, separado del de la app. Para eso, la variable `LYNKEUS_CONFIG` nombra un segundo archivo de configuración que se lee encima del de la app.

```bash
LYNKEUS_CONFIG=../qa-suite/lynkeus.config.json npx lynkeus case run
```

Dos cosas a tener en cuenta:

- Las claves del segundo archivo reemplazan enteras a las del primero. Si los dos declaran `cases`, vale solo el `cases` del segundo; no se combinan clave por clave.
- Las rutas dentro de `cases` son relativas al archivo que las declara, no a la carpeta de la app.

## Un archivo completo

Este ejemplo usa todas las claves. En un proyecto real casi nunca hacen falta todas.

```json title="lynkeus.config.json"
{
  "port": 8123,
  "device": "iPhone 16",
  "app": "com.example.myapp",
  "attachTimeout": 15000,

  "entry": "qa/headless.tsx",
  "apiEnv": "API_URL",
  "strictMode": false,

  "language": "es",
  "locale": { "languageTag": "es-MX", "country": "MX" },

  "live": ["^countdown-", "^clock$"],
  "errorCopy": ["algo salió mal", "inténtalo de nuevo"],

  "lintBaseline": ".lynkeus/lint.json",
  "lint": {
    "i18nKeyPatterns": ["^[a-z]+(\\.[a-z0-9]+){2,}$"],
    "minTouchTarget": 44,
    "contrast": { "normal": 4.5, "large": 3, "ignore": ["^watermark$"] }
  },

  "crawl": {
    "never": ["delete-account", "^pay-", "cerrar sesión"],
    "close": ["^modal-close$"],
    "back": ["^header-back$"]
  },

  "cases": {
    "dir": "cases",
    "flows": "flows",
    "fixtures": {
      "command": "node cases/fixtures.mjs",
      "cwd": ".",
      "env": { "RAILS_ENV": "test" },
      "timeoutMs": 120000
    },
    "inspect": "inspect",
    "refs": { "user": "user_id" },
    "macros": {
      "app.login": [
        { "app.call": { "command": "reset" } },
        { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
        { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
      ]
    },
    "interruptions": [
      { "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }
    ],
    "nativeMocks": {
      "PaymentsSdk.presentSheet": { "result": { "status": "paid" } }
    }
  }
}
```

## Conexión y dispositivo

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `port` | número | `8123` | El puerto donde escucha el driver y al que se conecta la app. La variable `LYNKEUS_PORT` lo reemplaza. |
| `device` | texto | el primer simulador encendido | El UDID o el nombre del simulador. Un nombre parcial también sirve: `"iPhone 16"` encuentra `iPhone 16 Pro`. Lo reemplazan `--device` y `LYNKEUS_DEVICE`. |
| `app` | texto | ninguno | El bundle id (iOS) o application id (Android). Lo usan `launch`, `--launch` y los comandos del simulador. Lo reemplazan `--app` y `LYNKEUS_APP_ID`. |
| `attachTimeout` | número (ms) | `15000` | Cuánto esperar a que la app se conecte. Lo reemplazan `--attach-timeout` y `LYNKEUS_ATTACH_TIMEOUT_MS`. |

Si no nombras ningún dispositivo y no hay ningún simulador encendido, lynkeus da por hecho que la app corre en un host sin pantalla y simplemente espera a que se conecte.

:::note
`port` en este archivo solo mueve al driver (el CLI) y al host sin pantalla que arranca `headless start`. Una app en un simulador o en un dispositivo se conecta al puerto que le pasaste al montar el agente, en la opción `port` de `auto()` o de `<Lynkeus>`. Si cambias uno, cambia el otro.
:::

## Host sin pantalla

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `entry` | texto | `qa/headless.tsx` | El archivo de entrada del host sin pantalla. Lo reemplaza `--entry`. |
| `apiEnv` | texto | `API_URL` | La variable de entorno de la que la app lee la dirección de su API. La entrada que genera `headless init` comprueba que esa variable apunte a un backend local y, si no, se niega a renderizar la app. Lo reemplaza `--api-env`. |
| `strictMode` | booleano | `false` | Conserva `React.StrictMode` en el host. Está apagado por defecto porque producción no lo tiene, y sus renders dobles duplican cada petición, cada commit y cada milisegundo que el host mide. |
| `live` | lista de textos | ninguno | Expresiones regulares para los `testID` de controles cuyo contenido cambia solo: un reloj, una cuenta regresiva. Su texto deja de contar como commit. Sin esto, `idle` agotaría todo su tiempo de espera en cada pantalla que muestre uno. |

Las expresiones de `live` se unen en una sola y distinguen mayúsculas de minúsculas.

## Idioma

lynkeus nunca lee los textos de tu app para adivinar su idioma. Estas dos claves se lo dicen, y él solo las pasa adelante.

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `language` | texto | ninguno | El idioma que habla la app, por ejemplo `"es"`. |
| `locale` | objeto | ninguno | `{ "languageTag": "es-MX", "country": "MX" }`. Los dos campos son opcionales. |

Se usan en tres lugares: `lynkeus os language` toma este idioma cuando no le das uno, la entrada que genera `headless init` simula esta configuración regional, y `lynkeus mcp` se la informa al cliente para que un modelo que lee las pantallas sepa en qué idioma están.

## Lint

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `lintBaseline` | texto | ninguno | El archivo de referencia contra el que compara `lynkeus lint` cuando no le das `--baseline`. |
| `lint.i18nKeyPatterns` | lista de textos | dos patrones (ver abajo) | Expresiones regulares que describen cómo se ve una clave de traducción sin traducir. No distinguen mayúsculas. Una lista vacía apaga la regla. |
| `lint.minTouchTarget` | número (puntos) | `44` | El lado más chico que se acepta para un objetivo táctil. |
| `lint.contrast` | `false` u objeto | activado | Cómo se mide el contraste del texto. `false` apaga la comprobación. |
| `lint.contrast.normal` | número | `4.5` | La relación de contraste mínima para texto común. |
| `lint.contrast.large` | número | `3` | La relación mínima para texto grande: 18 puntos, o 14 en negrita. |
| `lint.contrast.ignore` | lista de textos | ninguno | Expresiones regulares de `testID` que la comprobación de contraste deja fuera. |

:::note[Desde 0.3.0]
`lint.contrast` existe desde la versión 0.3.0.
:::

Por defecto, `i18nKeyPatterns` reconoce dos formas: tres o más segmentos separados por puntos (`home.header.title`) y tres o más segmentos separados por guiones bajos (`home_header_title`). Si las claves de tu app tienen otra forma, o si tu app muestra textos legítimos con esa forma, cámbialo aquí.

Los valores por defecto del contraste son los de WCAG 2. La guía [Lint y contraste](/es/guides/lint-and-contrast/) explica cada regla.

## Recorridos automáticos

Estas claves las leen `lynkeus crawl` y `lynkeus smoke`.

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `errorCopy` | lista de textos | ninguno | Expresiones regulares para el texto que tu app muestra cuando algo se rompió. `smoke` y `crawl` informan cada coincidencia como un problema. |
| `crawl.never` | lista de textos | ninguno | Controles que el recorrido nunca pulsa. |
| `crawl.close` | lista de textos | ninguno | Controles que cierran una capa que la app abre por encima de la pantalla. |
| `crawl.back` | lista de textos | ninguno | Controles que vuelven atrás. Si no declaras ninguno, el recorrido toma como tal un control pequeño en la esquina superior izquierda. |

Las expresiones de `crawl` se comparan contra el `testID` y contra la etiqueta de cada control. Tanto estas como las de `errorCopy` no distinguen mayúsculas de minúsculas.

:::caution
`crawl.never` empieza vacío a propósito. lynkeus no trae ninguna lista de palabras peligrosas, porque cuáles controles son irreversibles depende de cada app. Antes de recorrer una app conectada a datos que te importan, declara aquí lo que no se debe tocar: borrar la cuenta, pagar, enviar.
:::

## Casos (`cases`)

Todo lo que necesita `lynkeus case run` está bajo la clave `cases`. `lynkeus case init` escribe una versión inicial.

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `cases.dir` | texto | `cases` | La carpeta donde viven los casos. Sin archivos en la línea de comandos, `case run` ejecuta todos los `.md` que haya allí. |
| `cases.flows` | texto | `flows` | La carpeta donde viven los flows que un caso ejecuta con `app.run`. |
| `cases.fixtures` | objeto | ninguno | El comando que responde los pasos de fixtures. Ver abajo. |
| `cases.inspect` | texto | `inspect` | El nombre del fixture por el que `assert` lee el backend. |
| `cases.refs` | objeto | ninguno | Qué parámetros apuntan a algo que creó un paso anterior. Ver abajo. |
| `cases.macros` | objeto | ninguno | Pasos propios del proyecto: un nombre y la lista de pasos que representa. |
| `cases.interruptions` | lista | ninguno | Lo que la app puede poner en medio de cualquier paso, y cómo quitarlo. |
| `cases.nativeMocks` | objeto | ninguno | Qué responden los SDK nativos que un host sin pantalla no puede ejecutar. |

Las rutas de `dir`, `flows` y `fixtures.cwd` son relativas al archivo de configuración que las declara.

### `cases.fixtures`

Los **fixtures** son los datos de prueba que un caso prepara en el backend. lynkeus no sabe nada de tu backend: arranca un comando tuyo una vez por ejecución y le habla en líneas de JSON, una de ida y una de vuelta por paso. El protocolo está en la guía de [Fixtures](/es/guides/fixtures/).

| Clave | Tipo | Por defecto | Qué hace |
|---|---|---|---|
| `command` | texto | obligatorio | El comando que se ejecuta, tal como lo escribirías en un shell. Puede ser cualquier cosa que lea una línea y escriba otra: un script de Node, un runner de Rails, un contenedor. |
| `cwd` | texto | `.` | La carpeta desde la que se ejecuta. |
| `env` | objeto de textos | ninguno | Variables de entorno adicionales para el comando. Se suman a las del proceso de lynkeus. |
| `timeoutMs` | número (ms) | `120000` | Cuánto esperar la respuesta de cada paso. |

### `cases.refs`

`refs` evita repetir identificadores en cada paso. Cada entrada dice: "el parámetro con este nombre apunta a tal campo de lo que respondió un paso anterior".

Con `"refs": { "user": "user_id" }`:

```yaml
setup:
  - create_user: { as: u, name: "Ana" }   # responde { "user_id": "u_1", … }
steps:
  - give_points: { user: u, points: 25 }  # el fixture recibe user_id: "u_1"
  - give_points: { points: 5 }            # sin `user`: recibe el último user_id creado
```

Un paso que nombra `user: u` llega al fixture como `user_id`, leído de lo que guardó `as: u`. Un paso que no nombra ningún usuario recibe el más reciente.

### `cases.macros`

Un macro le pone nombre a una secuencia de pasos, para que los casos digan `app.login` en lugar de repetir cuatro líneas. La clave es el nombre del paso y el valor es la lista de pasos que representa. Dentro, `{{param.x}}` es lo que el caso le pasó.

La sintaxis completa, con `when`, `unless` y `on`, está en [Formato de un caso](/es/reference/case-format/#macros).

### `cases.interruptions`

Cada entrada describe algo que la app puede mostrar en cualquier momento, como una pantalla de bloqueo o un aviso de consentimiento, y los pasos que lo quitan.

| Clave | Tipo | Qué hace |
|---|---|---|
| `see` | texto (un objetivo) | Lo que delata la interrupción, por ejemplo `"#unlock-keypad"`. |
| `do` | lista de pasos | Los pasos que la resuelven. |
| `unless` | texto (expresión regular) | Opcional. Si el paso en curso coincide con esta expresión, es un paso que trata justamente de esa pantalla y se deja en paz. No distingue mayúsculas. |

### `cases.nativeMocks`

Un host sin pantalla no puede ejecutar SDK nativos de terceros: una pasarela de pago, un verificador de identidad. `nativeMocks` dice qué responde cada llamada.

Cada clave tiene la forma `Módulo.método`, con el nombre del módulo nativo tal como aparece en `NativeModules`. El valor tiene dos campos, ambos opcionales:

| Campo | Qué hace |
|---|---|
| `result` | El valor con el que se resuelve la llamada. |
| `screen` | Muestra una página sustituta, con `title`, y opcionalmente `subtitle`, `image` (una URI) y `buttons`. |

`buttons` es un objeto que va de la etiqueta de cada botón al resultado que devuelve. Cada botón se puede pulsar como `#native-mock-<etiqueta>`.

```json
"nativeMocks": {
  "IdentitySdk.start": {
    "screen": {
      "title": "Verificación de identidad",
      "buttons": { "approve": { "status": "approved" }, "reject": { "status": "rejected" } }
    }
  }
}
```

La configuración se envía a la app al comienzo de cada caso, así que un caso nunca hereda lo que cambió el anterior. Un paso puede cambiarla en medio del caso; `null` quita el mock de una clave:

```yaml
- app.call:
    command: nativeMocks
    params: { set: { "IdentitySdk.start": { result: { status: "rejected" } } } }
```

## Lo que no va en este archivo

- **El token.** Es un secreto y se lee de la variable `LYNKEUS_TOKEN`. No lo pongas en un archivo que se sube al repositorio.
- **La dirección y la clave del servicio de reportes.** Van en `LYNKEUS_REPORTS_URL` y `LYNKEUS_REPORTS_KEY`.

Las dos están en [Variables de entorno](/es/reference/environment-variables/).
