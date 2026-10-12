---
title: Grabación y snapshots
description: Cómo grabar lo que hace una persona en la app para obtener un flujo, guardar la estructura de una pantalla como línea base y detectar cuándo una pantalla cambió sin que nadie lo pidiera.
---

Esta guía reúne tres herramientas que responden a la misma pregunta: ¿qué había en esta pantalla y qué pasó en ella? `record` observa a una persona y escribe lo que hizo. `snapshot` guarda la estructura de una pantalla y avisa cuando cambia. `screen --record` hace lo mismo con todas las pantallas por las que pasa una suite, sin que tengas que nombrarlas.

Las tres sirven a quien escribe tests y prefiere partir de algo observado antes que de una página en blanco, y a quien quiere enterarse de un cambio de interfaz el día en que ocurre.

## Antes de empezar

- La app corre con el agente montado ([instalación](/es/getting-started/installation-react-native/)).
- Para grabar toques, el agente está montado con `auto()` y la app corre en un dispositivo, un simulador o un emulador.
- Para comparar píxeles, un simulador.

## Grabar lo que hace una persona

Escribir un flujo a mano exige conocer cada `testID`. Grabarlo es más rápido: usas la app y lynkeus anota.

### 1. Empieza a grabar

```bash
npx lynkeus record --out flows/login.json
```

Deberías ver:

```text
recording; use the app, then Ctrl-C to write flows/login.json
```

### 2. Usa la app

Recorre lo que quieres grabar. Cada cosa que pasa aparece en la terminal:

```text
  touch  #get-started-button  on Onboarding.Welcome
  route  Onboarding.Phone
  touch  #phone-input  on Onboarding.Phone
  touch  #next-button  on Onboarding.Phone
  req    200 POST /v3/session 142ms
  store  session: token
  route  Settings.Main
```

### 3. Termina con Ctrl-C

```text
7 steps → flows/login.json
```

El archivo es un flujo: un toque por cada toque tuyo y, después de cada uno, lo que causó.

```json title="flows/login.json"
{
  "name": "login",
  "steps": [
    { "press": { "testId": "get-started-button" } },
    { "waitFor": { "route": "Onboarding.Phone", "timeoutMs": 10000 } },
    { "press": { "testId": "phone-input" } },
    { "press": { "testId": "next-button" } },
    { "waitFor": { "route": "Settings.Main", "timeoutMs": 10000 } },
    { "note": "requests: POST /v3/session 200" },
    { "note": "stores changed: session.token" }
  ]
}
```

Lo valioso son las líneas que no son toques. La ruta a la que llevó cada toque, las peticiones que disparó y los stores que cambió son las afirmaciones que un test necesita, no solo sus pasos. Las notas no se ejecutan: son el material con el que escribes después un `app.wait: { request: … }` en un caso.

### 4. Reprodúcelo

```bash
npx lynkeus run flows/login.json
```

`run` repite el flujo e informa, por paso, la duración, la ruta y los errores. `--diff` imprime qué cambió en pantalla después de cada paso.

### Opciones de `record`

| Opción | Para qué |
|---|---|
| `--out <flow.json>` | Dónde escribir el flujo. Sin ella, queda bajo `.lynkeus/runs/record/`. |
| `--screenshots` | Una captura de pantalla por toque, tomada cuando la pantalla se asienta, y un archivo `<out>.strip.md` que las lista en orden para revisar la grabación antes de conservarla. |
| `--so-far` | No espera: arma el flujo con lo que la traza ya tiene y termina. Sirve cuando ya hiciste el recorrido y se te olvidó grabar. |

Mientras graba, `record` ejecuta como comandos las líneas que recibe por la entrada estándar. Un script puede así manejar una parte de la grabación (`wait Settings.Main`, por ejemplo) y dejarte el resto a ti.

### Lo que la grabación no captura

- **Texto escrito.** La grabación registra toques. El toque sobre un campo queda; lo que tecleaste, no. Agrega a mano los pasos `type`.
- **Toques sin nombre.** Un toque sobre algo sin `testID` ni texto queda como una nota: `touch at 120,340 on Home.Main hit nothing lynkeus could name`. Es la señal de que a ese control le falta un `testID`.
- **Toques en el host sin pantalla.** Ahí no hay toques que rastrear, y la grabación contiene solo rutas y peticiones. Verás `(no touches were traced: …)`.

## Snapshots: la estructura de una pantalla como línea base

Un snapshot guarda cómo es una pantalla hoy para avisarte cuando sea distinta. lynkeus guarda por defecto el **árbol**: la pantalla como líneas anidadas de significado, sin geometría.

```text
- screen Onboarding.Welcome (Root > Onboarding.Welcome)
  - text "Welcome"
  - button "Get started" #get-started-button
  - button "I already have an account" #login-button [disabled]
```

Cada línea lleva el tipo, el texto, el `testID`, el valor y el estado. No lleva posiciones ni tamaños. Por eso un título renombrado o un botón que desapareció es una línea que cambia, y un ajuste de espaciado o de tipografía no es nada. Funciona en todos los hosts, incluido el que no tiene pantalla.

### 1. Crea la línea base

Con la pantalla abierta:

```bash
npx lynkeus snapshot onboarding-hero
```

```text
onboarding-hero: tree baseline written → .lynkeus/snapshots/onboarding-hero.tree.txt
```

### 2. Compara más adelante

El mismo comando, cuando la línea base ya existe, compara:

```bash
npx lynkeus snapshot onboarding-hero
```

Si nada cambió verás `onboarding-hero: tree matches the baseline (4 lines)`. Si algo cambió, el comando termina con código 1 y muestra la diferencia como la de un archivo de código, con `-` para la línea que ya no está y `+` para la nueva:

```text
onboarding-hero: the tree differs from the baseline (1 line(s) gone, 1 new):
  - - button "Get started" #get-started-button
  + - button "Start" #get-started-button
  actual: .lynkeus/runs/snapshots/…
  accept with --update if the change is intended
```

### 3. Acepta un cambio intencional

```bash
npx lynkeus snapshot onboarding-hero --update
```

Reescribe la línea base. Súbela al repositorio junto con el cambio que la provocó, para que quien revisa vea ambos.

### Píxeles, pocos y a propósito

`--pixels` agrega una captura de pantalla y la compara con la guardada. La diferencia se dibuja en rojo sobre gris.

```bash
npx lynkeus snapshot onboarding-hero --pixels
```

| Opción | Para qué |
|---|---|
| `--tolerance <ratio>` | La fracción de píxeles que puede diferir. Por defecto, 0,001. |
| `--no-freeze` | No congela la barra de estado. Por defecto se fija en 9:41 con batería llena, para que el reloj no cuente como diferencia. |

Reserva los píxeles para las pantallas donde lo visual *es* el producto: una ilustración, un gráfico, un mapa. Una comparación de píxeles se rompe con cada cambio de fuente o de dato; para todo lo demás, el árbol dice más y molesta menos. Si cambias de dispositivo verás `size changed … (a different device or orientation?)`: las líneas base de píxeles valen para un tamaño de pantalla.

## Vigilar todas las pantallas sin nombrarlas

`snapshot` vigila las pantallas que elegiste. Para enterarte de los cambios en las demás, deja que la suite registre todo lo que ve:

```bash
LYNKEUS_RECORD_SCREENS=1 npx lynkeus case run
```

Con esa variable, cada lectura de pantalla guarda la estructura de su ruta en `.lynkeus/screens/`. A mano, lo mismo se hace con `npx lynkeus screen --record`, que además indica qué cambió desde la lectura anterior.

Después, pregunta qué se movió:

```bash
npx lynkeus map changes
```

Lista los `testID` que aparecieron (`+`), desaparecieron (`-`) o se movieron (`⇢`) en cada ruta, y los textos que cambiaron (`~`), con su fecha. Muestra los últimos 30 cambios; `--last <n>` lo ajusta.

La ventaja es que no depende de tus afirmaciones. Una suite que nunca comprueba `#mute-toggle` igual te avisa el día en que desaparece.

### Qué hacer con lo registrado

Todo lo que está bajo `.lynkeus/` es texto, y cambia como cambia el código: en un pull request que alguien revisa.

- **Si la rama cambia una pantalla,** sube lo que la ejecución registró en el mismo pull request que el código. Quien revisa ve los controles nuevos junto al diff que los agregó, y `map changes` en `main` se queda en silencio.
- **Si la app cambió sola** (un flag que se activó, una respuesta del backend que cambió), una ejecución nocturna sobre `main` lo detecta. Ábrelo como un pull request propio, con la salida de `lynkeus map changes` como descripción.

## Problemas frecuentes

**`map changes` no informa nada.** Verás `` (no recorded screen changes; record with `lynkeus screen --record` or LYNKEUS_RECORD_SCREENS=1) ``. Sin pantallas registradas no hay con qué comparar; hace falta al menos dos lecturas de la misma ruta.

**El snapshot del árbol cambia en cada ejecución.** La pantalla muestra datos que varían: un nombre generado, una fecha, un saldo. Fija los datos con fixtures y, si usas valores aleatorios, define `LYNKEUS_SEED` para que cada caso saque siempre los mismos.

**La grabación sale sin toques en un simulador.** Los toques se rastrean en los builds montados con `auto()`. Revisa que la app monte el agente de esa forma.

**El snapshot de píxeles falla por una animación.** Ejecuta `npx lynkeus idle` antes de `snapshot`, para comparar una pantalla quieta.

## Siguientes pasos

- [Escribir casos](/es/guides/writing-cases/): convertir un flujo grabado en un caso con afirmaciones.
- [Lint y contraste](/es/guides/lint-and-contrast/): la otra revisión automática de una pantalla.
- [Referencia de la CLI](/es/reference/cli/): todas las opciones de `record`, `snapshot` y `map`.
