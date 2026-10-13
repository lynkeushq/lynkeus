---
title: Expo
description: Lo que es propio de Expo al usar lynkeus, con sus requisitos, el punto de entrada con expo-router, el token, las rutas y los límites conocidos.
---

Esta página reúne lo que es específico de Expo: por qué hace falta un development build, cómo convive el agente con expo-router, cómo se nombran las rutas y qué no se puede hacer todavía.

Para instalar paso a paso, sigue [Instalación en Expo](/es/getting-started/installation-expo/). Aquí está la explicación de fondo y la lista de límites.

Todo lo que sigue se verificó en un proyecto nuevo de Expo SDK 57, con React Native 0.86 y expo-router, en el simulador de iOS y en el emulador de Android.

Expo funciona en las dos plataformas. En Android, con un development build, el agente se conecta, la pantalla se lee y las rutas de expo-router se reconocen.

## Requisitos

- **Un development build.** No funciona en Expo Go.
- **Los proyectos nativos generados**, con `npx expo prebuild`.
- **Node 22 o posterior** para el CLI.

No hace falta un *config plugin*. El módulo nativo se enlaza automáticamente al compilar.

## Por qué no funciona en Expo Go

El agente tiene código nativo: es lo que genera los toques y las teclas dentro del proceso. Expo Go es una app ya compilada que no puede incorporar módulos nativos nuevos. Un development build es tu propia app compilada en modo de depuración, y sí los incluye.

En la práctica, el ciclo es este:

```bash
npx expo install lynkeus-agent
npx lynkeus init
npx expo run:ios
```

o `npx expo run:android`. Solo hay que recompilar cuando cambia el código nativo, es decir, al instalar o actualizar `lynkeus-agent`.

## El punto de entrada

El agente se monta antes de que la app renderice. En un proyecto con expo-router no hay un `index.js` propio donde hacerlo, porque el punto de entrada es el del enrutador.

La solución es darle a la app un archivo de entrada propio, que monte el agente y después cargue el enrutador. `lynkeus init` lo escribe y apunta `main` a él:

```bash
npx lynkeus init
```

:::note[Desde 0.3.0]
`lynkeus init` existe desde la versión 0.3.0. Con una versión anterior, haz los dos cambios a mano.
:::

El archivo que escribe es este:

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

// Primero el agente, después el enrutador.
auto({ token: process.env.EXPO_PUBLIC_LYNKEUS_TOKEN });

import 'expo-router/entry';
```

Y este es el cambio en `package.json`:

```json title="package.json"
{
  "main": "index.js"
}
```

No hay que modificar ningún `_layout` ni ninguna pantalla.

## El token, en dos variables

El token es el secreto que comparten la app y el CLI. En Expo se llama distinto en cada lado, y la razón es una regla de Expo, no de lynkeus.

Expo solo incluye en el bundle las variables de entorno cuyo nombre empieza con `EXPO_PUBLIC_`. Una variable llamada `LYNKEUS_TOKEN` llegaría a la app como `undefined`.

| Quién lo lee | Variable |
|---|---|
| La app, dentro del bundle | `EXPO_PUBLIC_LYNKEUS_TOKEN` |
| El CLI, en tu terminal | `LYNKEUS_TOKEN` |

Las dos deben tener el mismo valor.

:::caution
Si la app recibe `undefined` como token, el agente no exige ninguno y atiende a cualquier proceso de tu máquina que se conecte. Comprueba que el nombre de la variable empiece con `EXPO_PUBLIC_`.
:::

## Las rutas

El agente reconoce las rutas de expo-router sin configuración. En un proyecto nuevo, `lynkeus screen` imprime en su primera línea:

```
index (__root > index)
```

`index` es la ruta enfocada y `__root > index` es la cadena de navegadores hasta ella.

### Los nombres van en minúscula

expo-router nombra cada ruta por su archivo, y por eso van en minúscula: `index`, `explore`. Esto importa en dos comandos.

`lynkeus wait` y `lynkeus see` reciben un solo argumento y deciden por su forma si es una ruta o un texto. Una palabra que empieza con mayúscula, como `Settings.Main`, se lee como ruta. Una palabra en minúscula sola se busca como texto en pantalla.

Para decir que una palabra en minúscula es una ruta, ponle adelante el prefijo `route:`:

```bash
npx lynkeus wait route:index
npx lynkeus see route:index
```

En un caso, entre comillas:

```yaml
steps:
  - app.wait: "route:index"
```

:::note[Desde 0.3.0]
El prefijo `route:` existe desde la versión 0.3.0.
:::

`lynkeus nav` no necesita el prefijo: su argumento siempre es una ruta.

```bash
npx lynkeus nav index
```

## Límites conocidos

### La barra de pestañas nativa

La plantilla más reciente de Expo usa una barra de pestañas nativa. La dibuja el sistema operativo, no React Native.

lynkeus lee el árbol de React, así que esas pestañas no aparecen como elementos en `lynkeus screen` y no se pueden tocar por nombre ni por `testID`.

Para cambiar de pestaña, navega a la ruta:

```bash
npx lynkeus nav <ruta>
```

En un caso:

```yaml
steps:
  - app.nav: <ruta>
```

Ten presente lo que esto implica para tus tests. `nav` es un salto directo, no una acción de usuario, así que un caso escrito de este modo no demuestra que tocar la pestaña funcione. Demuestra lo que ocurre una vez que estás en ella.

Si tu app usa una barra de pestañas dibujada con componentes de React Native, este límite no aplica.

### Expo Go

No hay forma de usar lynkeus en Expo Go, por lo explicado arriba.

### Builds de producción

Como en cualquier app de React Native, el agente solo existe en builds de depuración. Los detalles por sistema están en [iOS](/es/platforms/ios/) y [Android](/es/platforms/android/).

## Próximos pasos

- [Instalación en Expo](/es/getting-started/installation-expo/), si todavía no instalaste.
- [Tu primer test](/es/getting-started/first-test/)
- [Solución de problemas](/es/troubleshooting/)
