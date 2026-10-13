---
title: Tu primer test
description: Maneja la app a mano desde la terminal, escribe un primer caso, ejecútalo y aprende a leer lo que imprime.
---

Esta página te lleva de una app con lynkeus instalado a un test que pasa. Primero vas a manejar la app a mano desde la terminal, para ver qué lee lynkeus y cómo se nombran las cosas. Después vas a poner esos mismos pasos en un archivo y a ejecutarlo.

El orden no es casual. Un caso es la misma secuencia de comandos que escribirías a mano, guardada en un archivo. Si entiendes los comandos, el formato del caso no tiene nada nuevo que aprender.

## Antes de empezar

- lynkeus instalado en tu app: [React Native](/es/getting-started/installation-react-native/) o [Expo](/es/getting-started/installation-expo/).
- La app abierta en un simulador o un emulador, en build de depuración.
- `npx lynkeus screen` funcionando: imprime la pantalla actual.
- Si configuraste un token, la variable `LYNKEUS_TOKEN` definida en tu terminal, con el mismo valor que recibió la app.

Los ejemplos usan una app imaginaria con un botón de ajustes y un selector de tema. Los `testID` y las rutas de tu app son otros: cada vez que veas `#settings-button` o `Settings.Main`, reemplázalos por lo que te muestre `lynkeus screen`.

## Parte 1: manejar la app a mano

### 1. Lee la pantalla

Todo empieza por saber qué hay. Ejecuta, desde la carpeta de la app:

```bash
npx lynkeus screen
```

Deberías ver algo como esto:

```
Home (Tabs > Home)
button #settings-button "Settings"
text "Welcome back"
3 button "Open"
4 button "Open"
input #search value="" placeholder="Search"
```

Cómo se lee:

- **La primera línea** es la ruta actual (`Home`) y, entre paréntesis, los navegadores que llevan hasta ella.
- **Cada línea siguiente** es un elemento: su tipo (`button`, `input`, `text`, `scroll`, `switch`, `image`, `view`), su `testID` con `#` adelante y su texto.
- **El número al principio** aparece solo cuando hace falta: cuando el elemento no tiene nombre propio o lo comparte con otro, como los dos botones "Open". Es su índice en este listado.
- **El estado va al final**: `!disabled` si el control no responde a un toque, `~covered` si hay algo dibujado encima.

Lo que la app tiene montado pero no está mostrando (otra pestaña, la pantalla que quedó debajo de una hoja) no se lista. La primera línea lo cuenta, por ejemplo `· 12 hidden: 12 behind-overlay`.

### 2. Elige un objetivo

Un **objetivo** es la forma de señalar un elemento. Todos los comandos que tocan o buscan algo reciben uno, escrito de una de cuatro maneras:

| Forma | Señala |
|---|---|
| `#settings-button` | el elemento con ese `testID` |
| `"Settings"` | un control por su texto exacto y, si no hay, por una parte del texto |
| `3` | el elemento con ese índice en el último listado |
| `100,200` | un punto de la ventana |

Usa el `testID` siempre que exista. No cambia con el idioma ni con la redacción de los textos.

Un objetivo que lleva sus propias comillas es siempre el texto que está adentro, nunca una ruta, un índice ni un `testID`. Para que las comillas lleguen a lynkeus hay que protegerlas de la terminal con otras: `'"Settings"'`. Cuándo hace falta está en [Errores habituales](#errores-habituales).

### 3. Toca un elemento

```bash
npx lynkeus press '#settings-button' --settle
```

`press` genera un toque real sobre el elemento. La opción `--settle` espera a que la app deje de renderizar y después imprime la pantalla nueva, así ves de inmediato a dónde llegaste:

```
Settings.Main (Tabs > Settings.Main)
text "Appearance"
button "Light"
button "Dark"
```

Las comillas simples alrededor de `#settings-button` evitan que la terminal interprete el `#` como el comienzo de un comentario.

### 4. Espera en lugar de dormir

En un test, después de tocar algo hay que esperar a que la app llegue a donde tiene que llegar. `wait` termina en el momento exacto en que eso ocurre:

```bash
npx lynkeus wait Settings.Main
```

Acepta una ruta, un objetivo o una cantidad de milisegundos. Si a los 10 segundos no apareció lo esperado, falla. Ese límite se cambia con `--timeout <ms>`.

Esperar una ruta o un elemento es siempre mejor que esperar un tiempo fijo: el test no tarda más de lo necesario y no falla cuando la máquina está lenta.

### 5. Afirma lo que debe ser cierto

`see` comprueba que algo esté en pantalla ahora mismo. Es lo que convierte una secuencia de toques en un test.

```bash
npx lynkeus press "Dark"
npx lynkeus see '#theme-dark-selected'
```

Deberías ver:

```
on screen: #theme-dark-selected
```

Si el elemento no está, imprime `not on screen: #theme-dark-selected` y el comando termina con código 1. Con `--absent` afirmas lo contrario, y con `--within <ms>` le das un margen para aparecer.

Acabas de hacer un test a mano: tocar, esperar, tocar, afirmar. La parte 2 lo guarda en un archivo.

## Parte 2: escribir y ejecutar un caso

Un **caso** es un archivo markdown con una lista de **pasos**. Cada paso es uno de los comandos que acabas de usar, con el prefijo `app.`.

### 1. Crea el archivo

Los casos viven en la carpeta `cases/` de la app. Crea este:

```yaml title="cases/settings-dark-mode.md"
---
id: settings-dark-mode
title: "Ajustes: cambiar a modo oscuro"
---
steps:
  - app.press: "#settings-button"
  - app.wait: Settings.Main
  - app.press: "Dark"
  - app.see: { testId: theme-dark-selected }
```

Qué es cada parte:

- **El encabezado**, entre las dos líneas `---`, identifica el caso. `id` es el nombre con el que aparece en la salida y en los reportes. `title` es la descripción para quien lo lea.
- **`steps`** es la lista de pasos, en el orden en que se ejecutan.
- **`app.press`**, **`app.wait`** y **`app.see`** son los comandos `press`, `wait` y `see` de la parte 1. Reciben el mismo objetivo.
- **`app.see: { testId: theme-dark-selected }`** es la forma larga de la afirmación. Aquí el `testID` va sin `#`. La forma larga permite además afirmar sobre un texto (`text`), una ruta (`route`) o una petición de red (`request`).

Un paso que falla detiene el caso.

### 2. Revisa el archivo sin tocar la app

```bash
npx lynkeus case run cases/settings-dark-mode.md --dry-run
```

`--dry-run` lee el caso y recorre sus pasos sin ejecutarlos. Sirve para encontrar errores de formato antes de gastar una ejecución.

### 3. Ejecuta el caso

Deja la app en la pantalla donde empieza el caso y ejecuta:

```bash
npx lynkeus case run cases/settings-dark-mode.md
```

Deberías ver una línea por paso y, al final, el resultado:

```
▶ settings-dark-mode — Ajustes: cambiar a modo oscuro
  ✅ app.press #settings-button  (71ms)
  ✅ app.wait Settings.Main  (212ms)
  ✅ app.press Dark  (64ms)
  ✅ app.see testId: theme-dark-selected  (9ms)
✅ PASSED  ✅ 4  — 0.4s
✅ settings-dark-mode
1/1 passed
```

El comando termina con código 0 si ningún caso falló y con código 1 si alguno falló. Eso es lo que mira un sistema de CI.

Sin nombre de archivo, `npx lynkeus case run` ejecuta todos los `.md` de la carpeta `cases/`.

## Cómo leer un caso que falla

Cambia el último paso para que busque algo que no existe y vuelve a ejecutar. La salida cambia en tres cosas.

**El paso fallido lleva el motivo en la misma línea:**

```
  ❌ app.see testId: theme-blue-selected  — <motivo>  (<duración>ms)
```

**Debajo viene la evidencia.** lynkeus imprime hasta tres bloques:

- `— screen at the failure:` la pantalla tal como estaba en ese momento, en el mismo formato que `lynkeus screen`.
- `— requests:` las peticiones que había hecho la app.
- `— why:` el diagnóstico. Para un paso sobre un objetivo dice si estaba tapado, oculto detrás de una capa, deshabilitado o si no existía.

**El caso se ejecuta una segunda vez.** Verás `retrying settings-dark-mode once`. Un caso solo cuenta como fallido si falla las dos veces. Si pasa en el segundo intento, el resumen lo marca con `⚠ passed on retry`: es la señal de un test intermitente, y conviene mirarlo aunque la ejecución haya terminado bien. Con `--once` no hay segundo intento.

Fuera de un caso, la misma pregunta se hace a mano:

```bash
npx lynkeus why '#theme-blue-selected'
```

## Errores habituales

### El caso depende de dónde quedó la app

El ejemplo supone que la app está en la pantalla inicial. Si la ejecución anterior la dejó en Ajustes, el primer paso no encuentra `#settings-button`.

Para llegar al punto de partida sin depender del estado anterior, empieza el caso con `app.nav`, que salta directo a una ruta:

```yaml
steps:
  - app.nav: Home
  - app.press: "#settings-button"
```

`app.nav` es un salto, no una acción de usuario. Úsalo para ubicarte, no para probar la navegación.

### Una palabra con mayúscula se toma como ruta

`wait` y `see` deciden qué buscar por la forma de lo que les pasas. Una sola palabra que empieza con mayúscula, como `Dark`, se interpreta como el nombre de una ruta, no como un texto.

Para decir que es un texto, dale sus propias comillas. Un objetivo entre comillas nunca es una ruta:

```bash
npx lynkeus wait '"Dark"'
```

Las comillas simples de afuera son para la terminal; las dobles de adentro son las que lee lynkeus. En un caso se escribe igual, o con la forma larga:

```yaml
  - app.wait: '"Dark"'
  - app.see: { text: "Dark" }
```

:::note[Desde 0.3.0]
Antes de la versión 0.3.0, las comillas quedaban dentro del texto buscado y el objetivo no coincidía con nada.
:::

### Una ruta en minúscula se toma como texto

Es el caso inverso, y aparece con expo-router, que nombra las rutas por su archivo: `index`, `explore`. Una palabra en minúscula sola se busca como texto en pantalla. Para decir que es una ruta, ponle adelante el prefijo `route:`:

```bash
npx lynkeus wait route:index
```

```yaml
  - app.wait: "route:index"
```

El prefijo `route:` existe desde la versión 0.3.0.

### Un texto no coincide

Un control se encuentra por su texto exacto y, si no hay coincidencia, por una parte del texto. Un párrafo solo se encuentra por su texto completo: una palabra dentro de un texto largo nunca es un objetivo. `lynkeus why` indica si el texto que buscas difiere del que hay por la redacción o por un acento.

### `wait` vence en una pantalla que está a la vista

El nombre de la ruta no es el que supones. Lo define la navegación de tu app, no el título visible. Ejecuta `npx lynkeus screen` estando en esa pantalla y copia el nombre de la primera línea.

### El archivo no empieza con el encabezado

```
no frontmatter (a case starts with --- and its id)
```

La primera línea del archivo tiene que ser `---`, sin nada antes.

## Qué pasó por debajo

`case run` abre una sola conexión con la app y envía los pasos uno tras otro. Por eso un caso es mucho más rápido que la misma secuencia escrita como comandos sueltos, donde cada uno paga por arrancar un proceso y conectarse.

El ejecutor también absorbe lo que solo ocurre en un dispositivo. Después de un toque espera el render que ese toque causó. Antes de `app.see` y `app.press`, si el objetivo no está en la ventana, espera un momento y se desplaza para buscarlo más abajo. No tienes que escribir esas esperas.

## El mismo caso, sin simulador

El archivo que escribiste no dice dónde corre la app. Con la opción `--host`, lynkeus la aloja en Node durante la ejecución, sin simulador:

```bash
npx lynkeus case run cases/settings-dark-mode.md --host
```

Antes hay que preparar el host sin pantalla una vez. Lo explica [Sin pantalla (headless)](/es/platforms/headless/).

## Próximos pasos

- [Conceptos](/es/getting-started/concepts/): el vocabulario completo.
- [Manejar la app](/es/guides/driving-the-app/): `type`, `swipe`, `idle`, y cómo acotar un objetivo cuando se repite.
- [Escribir casos](/es/guides/writing-cases/): `setup`, variables, pasos propios y ejecución en paralelo.
- [Fixtures](/es/guides/fixtures/): cómo un caso prepara datos en el backend antes de empezar.
- [Reportes](/es/guides/reports/): guardar una ejecución y verla con capturas de pantalla.
