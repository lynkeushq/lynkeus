---
title: Manejar la app desde la terminal
description: Cómo leer la pantalla, tocar, escribir, deslizar, esperar y navegar en la app en ejecución, y cómo señalar el elemento exacto que quieres.
---

Antes de escribir un test conviene manejar la app a mano. Así descubres cómo se llama cada pantalla, qué `testID` tiene cada botón y cuánto tarda en llegar cada cosa. Esos mismos comandos son después los pasos de un caso, de modo que lo que aprendes aquí se reutiliza tal cual.

Esta guía recorre los comandos que actúan sobre la app en ejecución: `screen`, `press`, `type`, `swipe`, `wait`, `see`, `idle`, `nav` y `back`. También explica los objetivos, que son la forma de decirle a lynkeus sobre qué elemento actuar.

## Antes de empezar

- La app tiene el agente montado y corre en un build de depuración, en un simulador, un emulador o un host sin pantalla. Los dispositivos físicos no están soportados. Si falta ese paso, sigue [la instalación en React Native](/es/getting-started/installation-react-native/) o [en Expo](/es/getting-started/installation-expo/).
- La variable `LYNKEUS_TOKEN` de tu terminal tiene el mismo valor que el token que recibió la app. En React Native, es el valor con el que arrancó Metro.
- Estás en la carpeta de la app. Si no, agrega `--root <dir>` a cada comando.

## Leer la pantalla

Todo empieza por mirar. `screen` devuelve lo que React acaba de renderizar, en pocos milisegundos:

```bash
npx lynkeus screen
```

Deberías ver algo así:

```text
Settings.Main (Tabs > Settings.Main) +overlay#account-sheet · 12 hidden: 12 behind-overlay
4 button #close-sheet "Close"
5 button #delete-account-button "Delete account" !disabled
6 text "Are you sure?"
7 button #slide-to-confirm ~inert
```

La primera línea es el encabezado: la ruta (el nombre de la pantalla según tu navegación), el camino de navegadores hasta llegar a ella y, si hay algo abierto encima, la capa que lo cubre. Al final cuenta lo que la app tiene montado pero no está mostrando, como otra pestaña o la pantalla que quedó debajo de una hoja.

Después viene un elemento por línea: su índice, su tipo (`button`, `input`, `text`, `scroll`, `switch`, `image`, `view`), su `#testId`, su texto y su estado. Un campo de entrada muestra además su valor (`value="…"`), que es lo que contiene el campo nativo. Hay tres estados que importan:

| Marca | Significado |
|---|---|
| `!disabled` | El control no responde a un toque. |
| `~covered` | Hay algo encima que detendría el toque: un toque en su centro caería en otro elemento. |
| `~inert` | Se puede leer, pero no tocar. |

:::note[Desde 0.3.0]
Dos lecturas cambian con la versión 0.3.0, y las dos requieren recompilar la app después de actualizar `lynkeus-agent`. El valor de un campo se lee del campo nativo; antes salía de las propiedades de React, y un campo sin propiedad `value` se leía vacío después de escribir en él. Y en Android un control cuenta como `~covered` solo por lo que detendría un toque; antes, en un build de desarrollo, todos los controles se leían como cubiertos.
:::

`screen` tiene variantes para cada necesidad:

| Opción | Qué agrega |
|---|---|
| `--tree` | La pantalla como líneas anidadas, sin geometría. Es la forma adecuada para comparar dos lecturas. |
| `--all` | También lista lo que no se está mostrando. |
| `--frames` | El centro de cada elemento, en puntos. |
| `--verbose` | El número de commits de React y el costo de la lectura, en el encabezado. |
| `--record` | Guarda la estructura en `.lynkeus/screens/`. Se explica en [grabación y snapshots](/es/guides/recording-and-snapshots/). |

## Objetivos: cómo señalar un elemento

Un objetivo es la forma de nombrar el elemento sobre el que actúa un comando. Se escribe de cuatro maneras:

| Forma | A qué corresponde |
|---|---|
| `#next-button` | El elemento con ese `testID`. |
| `"Continue"` | Un control (botón o campo) cuyo texto es exactamente ese, o que lo contiene. Un párrafo solo coincide por texto exacto. |
| `12` | El elemento con ese índice en la última lectura de `screen`. |
| `100,200` | Un punto de la ventana, en puntos. |

Prefiere siempre `#testId`: no cambia cuando cambia la redacción ni el idioma. El índice sirve para explorar a mano, porque cambia en cuanto cambia la pantalla. Las coordenadas son el último recurso, para lo que no tiene ni `testID` ni texto.

Dos reglas evitan sorpresas. Un elemento cubierto nunca coincide con un objetivo. Y cuando dos elementos empatan, gana el último, porque es el que se dibuja encima.

### Comillas: un texto y nada más

Un objetivo sin `#` que no es un número ni un punto ya se lee como texto, así que `npx lynkeus press Continue` funciona. Las comillas propias sirven para los casos en que la forma engaña. Un objetivo que lleva sus propias comillas es el texto que está adentro, y nunca una ruta, un índice ni un `testID`:

```bash
npx lynkeus wait '"Next"'     # espera el botón "Next", no una ruta llamada Next
npx lynkeus press '"12"'      # el control cuyo texto es 12, no el elemento de índice 12
```

Son dos pares de comillas. Las de afuera son para el shell, que de otro modo se quedaría con las de adentro; las de adentro son las que lee lynkeus.

:::note[Desde 0.3.0]
Antes de la versión 0.3.0, las comillas quedaban dentro del texto buscado y el objetivo no coincidía con nada. Y para `wait` y `see`, una palabra con mayúscula inicial solo podía ser una ruta.
:::

### Acotar cuando el objetivo se repite

En una lista, cada fila suele repetir el mismo control. Dos opciones resuelven la ambigüedad, y valen en `press`, `type` y `wait`:

```bash
# El botón de "me gusta" que acompaña a ese mensaje, no cualquier otro
npx lynkeus press '#like-message-button' --in 'hi from Ana'

# La tercera coincidencia (se cuenta desde 0)
npx lynkeus press '#like-message-button' --nth 2
```

`--in <objetivo>` elige la coincidencia más cercana a otro objetivo. `--nth <n>` elige por posición.

## Tocar, escribir y deslizar

### Tocar

```bash
npx lynkeus press '#next-button'
```

El toque es un dedo sintetizado dentro de la app: lo reciben los reconocedores de gestos, los `Pressable` y las hojas, igual que un toque real.

| Opción | Para qué |
|---|---|
| `--hold <ms>` | Mantener presionado ese tiempo. |
| `--settle` | Esperar a que la app deje de renderizar y luego imprimir la pantalla. Ahorra un `screen` aparte. |
| `--js` | Llamar a `onPress` directamente, sin sintetizar el toque. Sirve para comparar, no como solución. |

### Escribir

```bash
npx lynkeus type "1124888418" '#phone-input'
npx lynkeus type 'ana' '#search' --submit
```

El primer argumento es el texto. El segundo, opcional, es el campo: lynkeus lo toca primero, de modo que recibe el foco como lo haría una persona. Sin objetivo, escribe en el campo que ya tiene el foco.

| Opción | Para qué |
|---|---|
| `--submit` | Termina con la tecla de retorno (dispara `onSubmitEditing`). |
| `--clear` | Vacía el campo antes de escribir. |
| `--paste` | Inserta el texto de una vez, en lugar de tecla por tecla. |

### Deslizar

```bash
npx lynkeus swipe up
npx lynkeus swipe right '#slide-to-confirm'
npx lynkeus swipe --from 40,600 --to 340,600 --duration 400
```

Con una dirección sola, el gesto recorre la pantalla. Con un objetivo, acciona el gesto de ese control: un deslizador, una hoja. En ese caso el arrastre empieza en el centro del control, y un control ancho no siempre puede permitírselo: si el dedo sale de la pantalla, el toque se cancela. Para esos casos, `--from` y `--to` colocan los dos extremos, en puntos. `--distance <pt>` fija cuánto recorre y `--duration <ms>` cuánto tarda.

## Esperar y comprobar

Una prueba confiable no espera un tiempo fijo: espera un hecho. lynkeus ofrece tres comandos, y elegir el correcto es la mitad del trabajo.

**`wait`** espera hasta que aparece una ruta o un elemento, y termina en el render que lo cumple:

```bash
npx lynkeus wait Settings.Main          # una ruta
npx lynkeus wait '#next-button'         # un elemento
npx lynkeus wait '"Next"'               # un texto que, sin comillas, se tomaría por una ruta
npx lynkeus wait '#spinner' --gone      # hasta que se vaya
npx lynkeus wait '#row-25' --scroll     # desliza la lista hasta que entre en la ventana
npx lynkeus wait 800                    # milisegundos, cuando de verdad no hay otra señal
```

Por defecto se rinde a los 10 000 ms; `--timeout <ms>` lo cambia.

**`idle`** espera hasta que la app deja de hacer commits, es decir, hasta que llegaron los datos y terminaron las animaciones:

```bash
npx lynkeus idle
```

Considera que la app está quieta cuando pasa 300 ms sin commits (`--quiet <ms>`) y se rinde a los 5000 ms (`--timeout <ms>`). La respuesta dice si se asentó o no. Hay una trampa: una pantalla que todavía no empezó a cargar se ve igual que una que ya terminó, porque ambas están quietas. Si necesitas distinguirlas, pasa a `--after <commit>` el número de commits que había antes de la acción (lo da `screen --verbose`).

**`see`** no espera: afirma. Comprueba que una ruta o un elemento está en pantalla ahora, y termina con código 1 si no es así:

```bash
npx lynkeus see '#pay-button'
npx lynkeus see '#error-banner' --absent
npx lynkeus see '#pay-button' --within 2000
```

`--absent` afirma lo contrario. `--within <ms>` le da un margen para aparecer.

## Navegar

```bash
npx lynkeus nav Checkout.Confirm '{"id":"abc"}'
npx lynkeus back
```

`nav` salta directo a una ruta, con parámetros en JSON si los necesita. Es un teletransporte, no una acción de usuario: úsalo para llegar al punto donde empieza lo que quieres probar, no para probar la navegación. `back` saca la ruta actual de la pila.

## Varias órdenes en una sola conexión

Cada comando suelto paga por arrancar un proceso y conectarse: cerca de 1,5 s. Cuando vas a enviar varios seguidos, `session` mantiene una conexión abierta y cada paso cuesta unos 50 ms:

```bash
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
```

Lee un arreglo JSON de argumentos por línea y responde un objeto JSON por línea: `{ok, out, json?}` si salió bien, `{ok:false, error, why?}` si no. La línea `exit` la termina. Los comandos que ejecutan un flujo completo o alojan la app no están disponibles dentro de una sesión.

## Cómo funciona

El agente vive dentro de la app. Recorre el árbol de React, se queda con los componentes que un usuario podría ver o tocar, mide cada uno y le pregunta a la plataforma cuál recibiría realmente un toque. Por eso sabe qué está cubierto sin adivinar a partir de una imagen. Toda la lectura ocurre en un solo tick de JavaScript.

Dos cosas quedan fuera a propósito. Los valores de los campos con `secureTextEntry` se enmascaran. Y el registro de peticiones guarda método, ruta, estado y duración, nunca encabezados ni cuerpos.

## Problemas frecuentes

Después de un `press`, `wait`, `type` o `nav` fallido, lynkeus ya imprime la causa. `npx lynkeus why '#next-button'` vuelve a preguntarla en cualquier momento: dice si el objetivo está cubierto, deshabilitado, detrás de una capa, o si no existe y cuál es el parecido más cercano.

**Un toque no hace nada.** Lee la pantalla. El elemento puede estar `~covered`, `!disabled` o no estar presentado; en ese último caso el encabezado lo cuenta (`3 hidden: 3 behind-overlay`) y `screen --all` lo lista. Cierra lo que esté abierto o apunta a algo dentro de la capa.

**`wait` agota el tiempo en una pantalla que claramente está ahí.** El nombre de la ruta viene del adaptador de navegación; mira en `screen` cuál es el nombre real. Sin adaptador no hay rutas, solo elementos.

**Un objetivo de texto no coincide.** Una palabra dentro de un párrafo nunca es un objetivo: los párrafos solo coinciden por texto exacto. `npx lynkeus why '"Continue"'` dice si el texto difiere por una palabra o por un acento.

**`wait` o `see` buscan una ruta donde querías un texto.** Una palabra con mayúscula inicial, como `Next`, se toma por una ruta. Dale comillas propias: `npx lynkeus wait '"Next"'`.

**Un campo muestra `value=""` después de escribir en él.** La app se compiló antes de actualizar `lynkeus-agent`, y el agente sigue leyendo el valor de las propiedades de React. Recompila la app.

**En Android, todos los controles aparecen `~covered`.** Es el mismo motivo: un build de desarrollo compilado antes de actualizar `lynkeus-agent`. Recompila la app.

**No aparece el teclado en el simulador.** El simulador está tomando las teclas del Mac. Desactiva I/O → Keyboard → Connect Hardware Keyboard.

**Las pestañas no aparecen como elementos.** En la plantilla más reciente de Expo, la barra de pestañas la dibuja el sistema, no React Native. No se puede tocar por nombre; usa `npx lynkeus nav <ruta>`.

**Todo va lento.** La causa habitual es un proceso por paso: usa `session`. Si la espera es después de iniciar sesión, quien tarda es tu backend; `npx lynkeus requests` lo muestra.

## Siguientes pasos

- [Escribir casos](/es/guides/writing-cases/): convierte estos comandos en un test que se repite.
- [Referencia de la CLI](/es/reference/cli/): todos los comandos y sus opciones.
- [Solución de problemas](/es/troubleshooting/): más síntomas y sus arreglos.
