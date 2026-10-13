---
title: Eventos de analítica
description: Cómo registrar los eventos que la app envía a su analítica, afirmarlos dentro de un caso y comprobar que los embudos que lee un dashboard siguen existiendo.
---

Los eventos de analítica son código que nadie mira hasta que un dashboard amanece vacío. Un refactor renombra una propiedad, alguien mueve una llamada de lugar, y el embudo de registro deja de cerrar sin que ningún test se entere, porque la pantalla se ve igual.

lynkeus trata esos eventos como un resultado más de la app. Puedes verlos en vivo, afirmar dentro de un caso que una acción envió el evento correcto, y describir un embudo completo como un archivo que se verifica en cada ejecución. Esta guía es para quien mantiene la instrumentación y para quien escribe los tests que la protegen.

## Antes de empezar

- La app tiene el agente montado ([instalación](/es/getting-started/installation-react-native/)).
- Sabes dónde la app llama a su SDK de analítica. Lo ideal es que sea una sola función por la que pasan todos los eventos.

## 1. Haz que la app cuente lo que envía

Llama a `qa.event` en el mismo lugar donde la app reporta a su analítica:

```ts title="src/analytics.ts"
import { qa } from 'lynkeus-agent';

export const track = (name: string, props?: Record<string, unknown>) => {
  // Lo que ya hacías: enviar el evento a tu proveedor
  analytics.track(name, props);
  // Lo nuevo: dejar constancia para los tests
  qa.event(name, props);
};
```

`qa.event(name, props)` hace dos cosas: anota el evento en la traza de la app, junto a las rutas, las peticiones y los toques, y lo guarda en un búfer que un test puede leer. El búfer conserva los últimos 500 eventos.

Si tu app ya mantiene su propio búfer de eventos, no hace falta duplicarlo: registra un comando `events` con `qa.register` y reemplaza al predeterminado. lynkeus acepta que cada evento traiga sus propiedades como `props` o como `properties`.

## 2. Míralos en vivo

Usa la app un momento y luego pregunta qué registró:

```bash
npx lynkeus events
npx lynkeus events --name '^signup_'
```

`--name <regex>` filtra por nombre. Este comando lee el búfer y lo deja como está. Para vaciarlo:

```bash
npx lynkeus call events '{"clear":true}'
```

Deberías ver los eventos que acabas de provocar, en orden, cada uno con sus propiedades. Si la lista está vacía, la llamada a `qa.event` no se está ejecutando en el camino que recorriste.

## 3. Afirma un evento dentro de un caso

Dos pasos cubren casi todo: `app.events: clear` vacía el búfer y `app.event` afirma que un evento ocurrió.

```md title="cases/signup-email.md"
---
id: signup-email
title: "Registrarse con correo envía los dos eventos del embudo"
---
steps:
  - app.events: clear
  - app.press: "#signup-button"
  - app.event: { name: signup_started, props: { source: home } }
  - app.type: { text: "ana-{{random.letters}}@example.com", target: "#email-input", submit: true }
  - app.wait: Home.Main
  - app.event: { name: signup_completed, props: { method: email } }
  - app.event: { name: signup_failed, absent: true }
```

- `name` es el evento que debe estar en el búfer.
- `props` son las propiedades que debe llevar. Basta con nombrar las que te importan; las demás se ignoran. Los valores se comparan como texto.
- `absent: true` afirma lo contrario: que ese evento no ocurrió.

`app.event` espera hasta 3000 ms a que el evento aparezca; `timeoutMs` cambia ese plazo. Cuando no llega, el error lo dice con precisión: `no signup_completed event with {"method":"email"}`.

El mismo control existe dentro de `app.see`, para afirmar en un solo paso lo que se ve y lo que se envió:

```yaml
- app.see: { route: Home.Main, event: signup_completed }
```

:::tip
Empieza los casos que afirman eventos con `app.events: clear`. Sin eso, un evento que quedó de un caso anterior puede hacer pasar una afirmación que debía fallar.
:::

## 4. Guarda los eventos de cada ejecución

Con `--out`, cada paso de `cases.jsonl` lleva los eventos que provocó, y el reporte los muestra junto al paso. No hay que pedir nada más:

```bash
npx lynkeus case run --out run
```

Si los quieres como archivos sueltos, uno por caso, usa `--events`:

```bash
npx lynkeus case run --events .lynkeus/runs/events
```

Eso escribe `.lynkeus/runs/events/<id del caso>/events.jsonl`. Cada línea es un evento con el número del paso que lo causó y la ruta en la que ocurrió.

Para los flujos existe la misma idea: `npx lynkeus run flows/signup.json --events` guarda `events.jsonl` en la carpeta de esa ejecución, bajo `.lynkeus/runs/`. A diferencia de `case run`, esta variante vacía el búfer de la app después de cada paso.

Para releerlos:

```bash
npx lynkeus events --run last
npx lynkeus events --run .lynkeus/runs/events/signup-email
```

Cada línea muestra el paso, la ruta, el nombre y las propiedades:

```text
 3 Onboarding.Welcome  signup_started {"source":"home","step":1}
 6 Home.Main  signup_completed {"method":"email"}
```

## 5. Describe el embudo como un contrato

Un embudo es la lista de eventos que un dashboard espera, en orden y con las propiedades que usa. Escríbelo como un archivo:

```json title=".lynkeus/funnels/signup.json"
{
  "steps": [
    { "event": "signup_started", "props": { "source": "string", "step": "number" } },
    { "event": "signup_completed", "props": { "method": "email" } }
  ]
}
```

Cada propiedad nombra una de dos cosas. Si el valor es `"string"`, `"number"` o `"boolean"`, es el tipo que el dashboard necesita. Cualquier otro valor es un valor concreto por el que el dashboard filtra.

Ahora comprueba que una ejecución produjo ese embudo:

```bash
npx lynkeus funnel check signup --run .lynkeus/runs/events/signup-email
```

Si todo está en su lugar:

```text
✓ signup
  ✓ 1 signup_started  (step 3)
  ✓ 2 signup_completed  (step 6)
```

Si algo se rompió, el comando termina con código 1 y dice qué:

```text
✗ signup
  ✓ 1 signup_started  (step 3)
  ✗ 2 signup_completed  (step 6)  — method is "phone", the funnel filters on "email"
```

Los problemas posibles son cuatro:

| Mensaje | Qué pasó |
|---|---|
| `never happened` | El evento no se envió. |
| `happened, but before the step it should follow` | Se envió, pero fuera de orden. |
| `<prop> is missing` | Falta una propiedad. |
| `<prop> is string, the funnel needs number` | La propiedad cambió de tipo. |

Sin `--run`, `funnel check` usa la ejecución más reciente que haya guardado eventos (`last`).

## 6. Compara dos builds

Para saber qué cambió una rama en la analítica, ejecuta lo mismo en `main` y en la rama, y compara:

```bash
npx lynkeus events diff runs-main/signup-email runs-branch/signup-email
```

```text
+ signup_promo_seen
- signup_abandoned
~ signup_started: +campaign, step number→string
```

`+` es un evento nuevo, `-` uno que desapareció y `~` uno cuyas propiedades cambiaron de forma. Un evento perdido o cambiado termina con código 1, de modo que un pull request que rompe un dashboard lo dice antes de que alguien abra el dashboard. Si no hay diferencias verás `(same events, same shapes)`.

## 7. Mide la cobertura de la analítica

```bash
npx lynkeus funnel report
```

Recorre las ejecuciones que guardaron eventos bajo `.lynkeus/runs/` (las últimas 50; `--last <n>` lo cambia) y dice, para cada embudo, qué pasos produce alguna ejecución y cuáles no produce ninguna. Es cobertura, no conversión: una ejecución guionizada siempre convierte. Lo que revela es qué parte de tu instrumentación no está protegida por ningún test.

## Cómo funciona

`qa.event` no intercepta tu SDK ni envía nada a la red: solo guarda una copia de lo que tú le pasas. Las propiedades se recortan a una profundidad acotada antes de guardarse, y las funciones se descartan, para que el búfer no crezca sin límite.

Durante `case run`, lynkeus lee el búfer después de cada paso de la app y atribuye a ese paso lo que haya de nuevo. Lee sin vaciar, porque el caso puede estar afirmando sobre ese mismo búfer.

En un host que además captura lo que reciben los SDK de analítica, cada paso guarda también esos envíos, con el proveedor al que fueron.

## Problemas frecuentes

**`no funnel signup: write .lynkeus/funnels/signup.json`.** El embudo se busca por el nombre del archivo, sin la extensión.

**`no events recorded for that run`.** La carpeta que pasaste a `--run` no tiene un `events.jsonl`, o todavía no hay ninguna ejecución con eventos bajo `.lynkeus/runs/`. Guarda los eventos ahí, como en el paso 4.

**Un evento aparece en el paso equivocado.** Los eventos se atribuyen al paso tras el cual se leyeron. Uno que la app envía con retraso (después de una petición, por ejemplo) cae en el paso siguiente. Agrega un `app.wait` sobre esa petición o un `app.event` que lo espere.

**La afirmación pasa aunque el evento no se envió en este caso.** Quedó en el búfer de antes. Empieza con `app.events: clear`.

**Las propiedades anidadas no coinciden.** Dentro de un caso, `props` compara cada valor como texto. Para comprobar tipos y estructura, usa un embudo.

## Siguientes pasos

- [Reportes](/es/guides/reports/): los eventos de cada paso, en una página.
- [API del agente](/es/reference/agent-api/): `qa.event`, `qa.register` y `qa.observe`.
- [Ejecutar en CI](/es/guides/ci/): correr `funnel check` en cada pull request.
