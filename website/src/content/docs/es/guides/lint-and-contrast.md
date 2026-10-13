---
title: Lint y contraste
description: Qué revisa lynkeus lint en una pantalla, cómo usar una línea base para ver solo lo nuevo y cómo medir el contraste del texto en modo claro y oscuro.
---

Hay observaciones que aparecen en casi toda revisión de interfaz: un botón de ícono sin etiqueta, un área de toque demasiado pequeña, una clave de traducción que se coló en pantalla, un texto gris sobre gris. Son fáciles de ver y tediosas de buscar, así que nadie las busca en cada build.

`lynkeus lint` las busca por ti. Lee la pantalla actual y señala lo que una persona marcaría en una revisión. No es una certificación de accesibilidad: es la lista de sospechosos habituales, revisada cada vez. Esta guía sirve a quien desarrolla una pantalla y a quien quiere que un pull request no empeore las que ya existen.

## Antes de empezar

- La app corre con el agente montado y puedes manejarla ([guía](/es/guides/driving-the-app/)).
- Para medir contraste necesitas un host que pueda tomar una captura de pantalla: un simulador o un emulador.

## 1. Revisa una pantalla

Lleva la app a la pantalla que te interesa y ejecuta:

```bash
npx lynkeus lint
```

Deberías ver un encabezado con la ruta y el conteo, y un hallazgo por línea:

```text
Settings.Main: 2 warn, 2 info
  ⚠ [unlabeled-control] #7 button with no text, label or testId
  ⚠ [low-contrast] #14 "Available balance" 2.9:1 (#8a8a8f on #ffffff), needs 4.5:1
  · [small-target] #9 36×20pt target (< 44) Edit
  · [duplicate-testid] #3 testId "row" is on 3 elements (3, 11, 19)
```

Cada línea trae la gravedad (`⚠` es una advertencia, `·` es información), la regla entre corchetes, el índice del elemento en `lynkeus screen` y la explicación. Una pantalla sin hallazgos responde `Settings.Main: clean`.

`lint` mira una sola pantalla: la que está abierta. Para revisar varias, navega a cada una:

```bash
npx lynkeus nav Settings.Main && npx lynkeus idle && npx lynkeus lint
```

## Las reglas

| Regla | Gravedad | Qué señala |
|---|---|---|
| `unlabeled-control` | advertencia | Un botón o un interruptor sin texto, sin etiqueta de accesibilidad y sin `testID`. Un lector de pantalla no tiene qué anunciar. |
| `small-target` | advertencia o información | Un control habilitado de menos de 44 puntos de ancho o de alto. Es advertencia si el control es solo un ícono; es información si tiene texto, porque entonces suele medirse la etiqueta y no el área que realmente responde al toque. |
| `untranslated` | advertencia | Un texto con forma de clave de traducción, como `settings.profile.title` o `error_network_timeout`. |
| `low-contrast` | advertencia o información | Un texto que no se distingue lo suficiente de su fondo. Se explica más abajo. |
| `covered-control` | información | Un botón, campo o interruptor habilitado que está cubierto: un toque no lo alcanzaría. |
| `offscreen` | información | Un elemento con nombre cuyo marco se sale de la ventana. |
| `zero-size` | información | Un texto cuyo marco mide cero de ancho o de alto. |
| `duplicate-testid` | información | El mismo `testID` en más de un elemento. Un test que apunte a él no sabe cuál le toca. |

Los elementos que la app no está presentando, como los de otra pestaña o los que quedaron bajo una hoja, no se revisan.

## 2. Hazlo fallar cuando corresponde

Por defecto `lint` informa y termina con código 0. Con `--strict` termina con código 1 si hay alguna advertencia; los hallazgos de información no lo hacen fallar.

```bash
npx lynkeus lint --strict
```

Dentro de un caso, cualquier comando de lynkeus es un paso, así que la misma revisión se puede fijar a una pantalla concreta del recorrido:

```yaml
steps:
  - app.wait: Settings.Main
  - app.lint: strict
```

## 3. Usa una línea base para ver solo lo nuevo

Una app con historia tiene hallazgos viejos. Si `--strict` falla desde el primer día por cuarenta problemas heredados, el equipo lo desactiva. La línea base resuelve eso: guarda los hallazgos actuales y, a partir de ahí, solo se muestran los nuevos.

En `main`, guarda los hallazgos de la pantalla:

```bash
npx lynkeus lint --save .lynkeus/lint/home.json
```

```text
saved 4 finding(s) for Settings.Main → .lynkeus/lint/home.json
```

En la rama, compara contra ese archivo:

```bash
npx lynkeus lint --baseline .lynkeus/lint/home.json --strict
```

Si la rama no agregó nada verás `nothing new on Settings.Main against .lynkeus/lint/home.json`. Si agregó algo, `1 new against .lynkeus/lint/home.json:` seguido solo de lo nuevo.

Un hallazgo se reconoce por su regla, su `testID` y aquello de lo que trata (la etiqueta del control, el texto), no por lo que se midió. Un área de toque que pasó de 32 a 30 puntos sigue siendo el hallazgo que la línea base ya tiene, y no aparece como nuevo.

:::note[Desde 0.3.0]
Antes de la versión 0.3.0, un hallazgo se reconocía por su mensaje, y el mensaje incluye la medida: cualquier cambio en el número lo hacía volver como nuevo. Una línea base guardada antes sigue comparando por el mensaje que guardó. Guárdala otra vez con `--save` para obtener el comportamiento nuevo.
:::

El archivo guarda los hallazgos por ruta, así que un mismo archivo sirve para todas las pantallas: ejecuta `--save` en cada una y se van acumulando. Para no repetir la ruta del archivo en cada comando, nómbralo en la configuración; `lint` lo usa siempre que no se le indique otro:

```json title="lynkeus.config.json"
{ "lintBaseline": ".lynkeus/lint.json" }
```

## 4. Mide el contraste

En un host que puede tomar una captura de pantalla, `lint` mide además cuánto se distingue cada texto de lo que tiene detrás. No hace falta ninguna opción: forma parte de la revisión.

```text
⚠ [low-contrast] #14 "Available balance" 2.9:1 (#8a8a8f on #ffffff), needs 4.5:1
```

La línea dice la proporción medida, los dos colores que se compararon y la proporción que se exige. Las cifras son las de WCAG 2, nivel AA:

| Texto | Proporción mínima |
|---|---|
| Normal | 4,5 a 1 |
| Grande (18 puntos, o 14 en negrita) | 3 a 1 |

Se juzgan los textos, los botones y los campos que muestran algo. Un control deshabilitado no se juzga, porque la pauta lo excluye.

### Claro y oscuro son dos pantallas

Un color que funciona sobre blanco puede desaparecer sobre negro. Revisa ambos modos:

```bash
npx lynkeus os appearance light && npx lynkeus lint
npx lynkeus os appearance dark  && npx lynkeus lint
```

`os appearance` cambia el modo del simulador desde afuera.

### Cómo se mide

lynkeus lee los píxeles de la captura de pantalla, no los estilos. Los colores que la app declara no dicen nada de una etiqueta puesta sobre una foto, un degradado o una hoja translúcida; los píxeles sí, porque son lo que ve la persona.

Para cada texto toma su rectángulo en la imagen. El fondo es el color que ocupa la mayor parte del rectángulo. El texto es, entre los colores con suficientes píxeles como para ser letras, el que más se aleja del fondo.

De ahí salen dos consecuencias que conviene conocer:

- **Sobre un fondo que no es un color plano, el hallazgo es información y no advertencia.** El mensaje agrega `over a varied background`. En ese caso el fondo es una estimación, y la decisión queda en manos de una persona.
- **Una cifra baja es un hallazgo; una cifra alta no es un certificado.** Cualquier otra cosa dentro del rectángulo, como un ícono junto a la etiqueta, solo puede subir la cifra. Un texto que pasa aquí puede merecer igual una mirada.

La medición de contraste existe desde la versión 0.3.0. Implica tomar una captura. Para omitirlo en una ejecución:

```bash
npx lynkeus lint --no-contrast
```

En un host que no toma capturas, el resto de las reglas corre igual y `lint` avisa: `contrast not measured: this host takes no screenshots`.

## Ajustar las reglas a tu app

Todo se configura bajo `lint` en `lynkeus.config.json`:

```json title="lynkeus.config.json"
{
  "lint": {
    "minTouchTarget": 44,
    "i18nKeyPatterns": ["^[a-z]+(\\.[a-z0-9_]+){2,}$"],
    "contrast": { "normal": 4.5, "large": 3, "ignore": ["^watermark$"] }
  }
}
```

| Clave | Qué cambia |
|---|---|
| `minTouchTarget` | El tamaño mínimo de un área de toque, en puntos. Por defecto, 44. |
| `i18nKeyPatterns` | Expresiones regulares que describen cómo se ve una clave sin traducir en tu app. Por defecto reconoce `a.b.c` y `clave_con_guiones_bajos`. Una lista vacía apaga la regla. |
| `contrast.normal`, `contrast.large` | Las proporciones exigidas para texto normal y grande. |
| `contrast.ignore` | Expresiones regulares de `testID` que se dejan fuera: una marca de agua, un color de marca que nadie puede cambiar. |
| `contrast` en `false` | Apaga la medición de contraste. |

## Problemas frecuentes

**La regla `untranslated` marca textos que sí son contenido.** Un identificador o un nombre de usuario con guiones bajos tiene la misma forma que una clave. Ajusta `i18nKeyPatterns` al formato real de tus claves.

**`small-target` marca todos los ítems de la barra de pestañas.** Es el caso que la regla ya contempla: tienen texto, así que salen como información y no hacen fallar `--strict`.

**El contraste cambia entre ejecuciones.** Hay una animación en curso cuando se toma la captura. Ejecuta `npx lynkeus idle` antes de `lint`.

**La línea base no filtra nada.** Los hallazgos se guardan por ruta. Si `--save` se ejecutó en otra pantalla, la ruta actual no tiene línea base y todo cuenta como nuevo.

## Siguientes pasos

- [Ejecutar en CI](/es/guides/ci/): comparar contra la línea base en cada pull request.
- [Grabación y snapshots](/es/guides/recording-and-snapshots/): detectar cambios en la estructura de una pantalla.
- [Referencia de configuración](/es/reference/configuration/): todas las claves de `lynkeus.config.json`.
