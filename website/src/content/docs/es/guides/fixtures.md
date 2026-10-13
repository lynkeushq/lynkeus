---
title: Fixtures
description: Cómo un caso prepara y consulta los datos del backend a través de un comando propio del proyecto, y el protocolo de una línea JSON que ese comando debe hablar.
---

Casi ningún test empieza de cero: necesita un usuario que exista, un saldo, un pedido en cierto estado. Los fixtures son esos datos de prueba que se preparan en el backend antes de que la app haga nada, y también la forma de leer el backend después para comprobar que la app lo dejó como debía.

lynkeus no sabe nada de tu backend, y es intencional. Tú declaras un comando; lynkeus le envía una línea JSON por cada paso y lee una línea de respuesta. Esta guía es para quien conecta ese comando: suele ser alguien de backend o de QA con acceso a la API de administración.

## Antes de empezar

- Tienes al menos un caso escrito ([guía](/es/guides/writing-cases/)).
- Tienes una forma de crear datos en un backend de pruebas: una API de administración, un script, una semilla de base de datos.

## Qué es un fixture dentro de un caso

En un caso, todo paso cuyo nombre no empieza con `app.`, y que no es `assert`, `exec` ni una macro, es un fixture:

```md title="cases/example.md"
---
id: example
title: "Quien recibe puntos los ve en la primera pantalla"
---
setup:
  # create_user no es un paso de la app: lo responde tu comando de fixtures
  - create_user: { as: u, name: "Ana" }

steps:
  - app.see: { text: "Hello" }
  - give_points: { user: u, points: 25 }
  - app.see: { text: "25 points", timeoutMs: 10000 }
  - assert: { user: u, path: points, equals: 25 }

expected: |
  Los puntos en pantalla y los que guarda el backend son 25.
```

`create_user` y `give_points` son nombres que inventas tú. `assert` es de lynkeus, pero lee el backend a través de otro fixture tuyo. Los tres llegan al mismo comando.

## 1. Declara el comando

```json title="lynkeus.config.json"
{
  "cases": {
    "dir": "cases",
    "fixtures": { "command": "node cases/fixtures.mjs", "cwd": ".", "timeoutMs": 120000 },
    "inspect": "inspect",
    "refs": { "user": "user_id" }
  }
}
```

| Clave | Qué hace |
|---|---|
| `fixtures.command` | El comando que responde. Puede ser cualquier cosa que lea una línea y escriba una línea: un script de Node, un runner de Rails, un contenedor. |
| `fixtures.cwd` | La carpeta donde se inicia. |
| `fixtures.env` | Variables de entorno adicionales para el comando. |
| `fixtures.timeoutMs` | Cuánto esperar cada respuesta. Por defecto, 120 000 ms. |
| `inspect` | El fixture que usa `assert` para leer el backend. Por defecto, `inspect`. |
| `refs` | Qué parámetros apuntan a algo creado por un paso anterior. Se explica más abajo. |

`npx lynkeus case init` escribe esta configuración y un `cases/fixtures.mjs` de partida.

## 2. Escribe el servidor

Este es el servidor que deja `case init`, con dos fixtures en memoria. Reemplaza los cuerpos por llamadas a tu backend:

```js title="cases/fixtures.mjs"
#!/usr/bin/env node
import readline from 'node:readline';

const users = new Map();

const fixtures = {
  async create_user({ name = 'Test user' }) {
    const user = { user_id: `u_${users.size + 1}`, name, points: 0 };
    users.set(user.user_id, user);
    return user;
  },
  async give_points({ user_id, points }) {
    const user = users.get(user_id);
    if (!user) throw new Error(`no user ${user_id}`);
    user.points += Number(points);
    return { user_id, points: user.points };
  },
  // Lo que lee `assert`
  async inspect({ user_id }) {
    return users.get(user_id) ?? {};
  },
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { command, params } = JSON.parse(line);
  // lynkeus pregunta una vez qué responde este servidor
  if (command === 'lynkeus.describe') {
    console.log(JSON.stringify({ commands: Object.keys(fixtures) }));
    continue;
  }
  try {
    const fixture = fixtures[command];
    if (!fixture) throw new Error(`no fixture ${command}`);
    console.log(JSON.stringify({ ok: true, ...(await fixture(params ?? {})) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
  }
}
```

## 3. Comprueba que responde

```bash
npx lynkeus case run cases/example.md --dry-run
npx lynkeus case run cases/example.md --host
```

La primera línea revisa el archivo sin ejecutar nada. La segunda corre el caso completo. Deberías ver los pasos `create_user`, `give_points` y `assert` con su marca ✅ entre los pasos de la app.

## El protocolo

Es una conversación por la entrada y la salida estándar, una línea cada vez.

```text
→ {"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
← {"ok": true, "user_id": "u_1", "name": "Ana"}
```

- `command` es el nombre del paso.
- `params` es el paso tal como está escrito en el caso, sin `as`.
- `env` son los mismos parámetros aplanados a texto y en mayúsculas (`userId` llega como `USER_ID`). Sirve para un servidor que se los pasa a un script de shell.
- La respuesta es cualquier objeto JSON. Para decir que falló, responde `"ok": false` con un `error`: ese texto es el mensaje del paso fallido.

El comando se inicia una vez por ejecución y se mantiene vivo; cuando hay varios trabajos en paralelo, cada uno abre su propia conexión. lynkeus ignora las líneas de la salida que no empiezan con `{`, así que un mensaje suelto no rompe la conversación, pero los registros van mejor por la salida de error.

### La lista de fixtures: `lynkeus.describe`

Antes del primer caso, lynkeus pregunta qué sabe hacer el servidor:

```text
→ {"command": "lynkeus.describe", "params": {}, "env": {}}
← {"commands": ["create_user", "give_points", "inspect"]}
```

Con esa lista, revisa todos los casos antes de ejecutar ninguno. Si alguno nombra un fixture que no está, la ejecución se rechaza:

```text
example: no fixture give_point
the fixtures command answers: create_user, give_points, inspect
```

La alternativa es peor: un caso que falla a la mitad, con el backend ya modificado. Un servidor que responde `"ok": false` a esta pregunta no se revisa, y sus casos corren sin esa comprobación.

Si el servidor está en marcha pero no puede atender (su base de datos está caída, por ejemplo), puede agregar `"down": "<motivo>"` a la respuesta. Ningún caso empieza, y verás `the fixtures server cannot serve: <motivo>`.

## Encadenar pasos: `as` y `refs`

`as: u` guarda la respuesta del fixture con el alias `u`. A partir de ahí hay dos maneras de usarla.

La explícita es leer un campo con llaves dobles: `{{u.user_id}}`.

La cómoda es `refs`. Con `"refs": { "user": "user_id" }`, escribir `user: u` en un paso hace que el fixture reciba `user_id` con el valor que guardó `u`. Y un paso que no nombra ningún usuario recibe el más reciente. En el ejemplo, `give_points: { user: u, points: 25 }` llega al servidor así:

```text
→ {"command": "give_points", "params": {"points": 25, "user_id": "u_1"}, "env": {"POINTS": "25", "USER_ID": "u_1"}}
```

## Leer el backend: `assert`

Una pantalla puede mostrar 25 puntos sin que el backend los tenga. `assert` cierra esa brecha: llama al fixture `inspect` y comprueba un campo de la respuesta.

```yaml
- assert: { user: u, path: points, equals: 25 }
- assert: { user: u, path: orders.0.status, matches: "^paid" }
- assert: { user: u, path: orders.*.id, includes: "ord_7" }
```

`path` recorre la respuesta con puntos: `orders.0.status` entra al primer pedido, y `orders.*.id` reúne el `id` de todos. Los comparadores son:

| Comparador | Se cumple cuando |
|---|---|
| `equals` | El valor es igual (compara números como números). |
| `includes` | El texto lo contiene, o algún elemento de la lista lo contiene. |
| `gte`, `lte` | El número es mayor o igual, o menor o igual. |
| `near` | El número difiere en 0,01 como máximo. |
| `matches` | El texto cumple la expresión regular. |
| `present`, `absent` | El campo existe, o no existe. |

Cuando no se cumple, el error dice lo que encontró: `points is 20`.

El fixture `inspect` recibe, además de tus parámetros, uno llamado `section` con el primer tramo del `path` (`orders` en los ejemplos). Un servidor que arma su respuesta por partes puede calcular solo esa. Varios `assert` seguidos sobre la misma sección leen una sola respuesta.

## Ejecutar un comando de shell: `exec`

Para lo que no merece un fixture, `exec` ejecuta un comando y, con `as`, guarda su salida JSON:

```yaml
setup:
  - exec: { run: "node scripts/issue-coupon.mjs", as: coupon }
steps:
  - app.type: { text: "{{coupon.code}}", target: "#coupon-input" }
```

Si la salida no es JSON, queda como `{ out: "<texto>" }`.

## Preparar los setups por adelantado

En una suite grande, buena parte del tiempo se va en crear datos. `--ahead <n>` prepara hasta `n` setups de los casos siguientes mientras corren los actuales, y solo cuando sobra CPU (`--idle`, por defecto 0,25):

```bash
npx lynkeus case run --ahead 4
```

Solo se adelanta un setup hecho únicamente de fixtures: sin pasos `app.*`, macros, `exec`, `assert` ni bloques `on`. La conexión que trabaja por adelantado se anuncia primero con el comando `lynkeus.ahead`, para que tu servidor pueda darle menos prioridad; si no lo conoce, puede responder cualquier cosa.

Para una suite que lanza `case run` una vez por caso existe `npx lynkeus case prepare`, que deja los setups en una carpeta (`.lynkeus/prepared` por defecto) que luego lee `case run --prepared <dir>`.

## Problemas frecuentes

**`create_user is not a step lynkeus has, and the project declares no fixtures (cases.fixtures in lynkeus.config.json)`.** Falta `cases.fixtures` en la configuración, o lynkeus está leyendo otra carpeta. Revisa `--root`.

**`create_user: the fixtures command did not answer within 120000 ms`.** El servidor recibió la línea y no respondió. Lo habitual es que haya escrito la respuesta en varias líneas o que no haya vaciado la salida. Cada respuesta es una sola línea.

**`create_user: the fixtures command ended: …`.** El proceso terminó. Lo que sigue a los dos puntos son las últimas líneas de su salida de error.

**`alias 'u' has no user_id`.** `refs` busca ese campo en la respuesta guardada y el fixture no lo devolvió.

**Los casos se pisan entre sí.** Haz que cada caso cree sus propios datos, con `{{random.letters}}` o `{{random.digits}}` en lo que deba ser único, en lugar de compartir un usuario fijo.

## Siguientes pasos

- [Escribir casos](/es/guides/writing-cases/): el resto del formato.
- [Trazas del backend](/es/guides/backend-traces/): ver qué hizo el backend en cada paso.
- [Referencia de configuración](/es/reference/configuration/): todas las claves de `cases`.
