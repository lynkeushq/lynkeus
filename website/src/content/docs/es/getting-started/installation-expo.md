---
title: Instalación en Expo
description: Cómo instalar lynkeus en una app de Expo con development build, montar el agente junto a expo-router y comprobar la conexión.
---

Esta página instala lynkeus en una app de Expo. Los pasos se probaron en un proyecto nuevo de Expo SDK 57, con React Native 0.86 y expo-router, en el simulador de iOS y en el emulador de Android. En los dos el agente se conecta, la pantalla se lee y las rutas de expo-router se reconocen.

Si tu app no usa Expo, sigue [Instalación en React Native](/es/getting-started/installation-react-native/).

## Lo que cambia respecto de React Native CLI

Son tres diferencias, y conviene conocerlas antes de empezar porque explican cada paso.

**Hace falta un development build.** El agente tiene código nativo. Expo Go trae un conjunto fijo de módulos nativos y no puede cargar otros, así que lynkeus no funciona allí.

**expo-router no tiene `index.js`.** El agente se monta en el punto de entrada de la app, antes de que se renderice nada. Un proyecto con expo-router no tiene ese archivo. El comando `lynkeus init` lo crea por ti.

**El token viaja en otra variable.** Expo solo incluye en el bundle las variables de entorno cuyo nombre empieza con `EXPO_PUBLIC_`. La app y el CLI terminan leyendo dos variables distintas, que deben tener el mismo valor. A cambio, Expo no necesita el plugin de Babel `lynkeus-agent/babel` que usa una app de React Native CLI.

## Antes de empezar

- Un proyecto de Expo que ya puedas compilar con `npx expo run:ios` o `npx expo run:android`.
- Node 22 o posterior.
- Un simulador de iOS o un emulador de Android. Los dispositivos físicos no están soportados.

No hace falta ningún *config plugin*: el módulo nativo se enlaza solo.

## Pasos

### 1. Instala el agente y el CLI

El agente se instala con el comando de Expo:

```bash
npx expo install lynkeus-agent
```

El CLI es una dependencia de desarrollo común:

```bash
npm install --save-dev lynkeus
```

### 2. Monta el agente

Desde la carpeta del proyecto, ejecuta:

```bash
npx lynkeus init
```

:::note[Desde 0.3.0]
`lynkeus init` existe desde la versión 0.3.0. Con una versión anterior, haz lo mismo a mano como explica [Montar el agente a mano](#montar-el-agente-a-mano).
:::

En un proyecto con expo-router, el comando hace dos cosas: escribe un `index.js` que monta el agente y después carga el enrutador, y apunta la clave `main` de `package.json` a ese archivo. Deberías ver:

```
wrote index.js (mounts the agent, then loads expo-router) and pointed package.json's main at it
Expo: the agent has native code, so it runs in a development build (npx expo run:ios, npx expo run:android), not in Expo Go
Expo: start the dev server with EXPO_PUBLIC_LYNKEUS_TOKEN set to the same value as LYNKEUS_TOKEN; Expo passes the app only variables with that prefix
```

Las dos últimas líneas son recordatorios de los pasos que siguen: el token y el development build.

Si tu proyecto de Expo ya tiene un `index.js` propio, el comando no crea nada: agrega las líneas de `auto()` a ese archivo, después del último `import`, e imprime `added auto() to index.js`. Si el agente ya estaba montado, lo dice y no toca nada.

No hay que modificar ninguna pantalla ni ningún `_layout`.

### 3. Define el token en las dos variables

:::note[Desde 0.4.0]
`lynkeus init` crea el token del proyecto en `.lynkeus/token` y lo escribe en `.env.local` como `EXPO_PUBLIC_LYNKEUS_TOKEN`, el archivo que Expo lee y que su plantilla deja fuera de git; la CLI lee el mismo token. Reinicia el servidor de desarrollo y salta este paso. Definir las variables sigue funcionando, y el entorno gana sobre los archivos.
:::

El token es un secreto compartido: el agente solo atiende al proceso que abre la conexión con el mismo valor. Evita que otro programa de tu máquina maneje la app.

| Quién lo lee | Variable |
|---|---|
| La app | `EXPO_PUBLIC_LYNKEUS_TOKEN` |
| El CLI | `LYNKEUS_TOKEN` |

Define las dos con el mismo valor en la terminal donde vas a trabajar. El servidor de desarrollo de Expo tiene que arrancar con `EXPO_PUBLIC_LYNKEUS_TOKEN` ya definida:

```bash
export EXPO_PUBLIC_LYNKEUS_TOKEN=un-secreto-local
export LYNKEUS_TOKEN=un-secreto-local
```

Si la variable de la app no está definida, o su nombre no empieza con `EXPO_PUBLIC_`, el token llega vacío. En ese caso el agente queda apagado y la app lo dice en su log con una línea que empieza con `lynkeus: the app passed a token and it is empty`. Nunca pasa a atender sin token.

:::note[Desde 0.3.0]
Antes de la versión 0.3.0, un token que llegaba vacío se trataba como "sin token" y el agente atendía a cualquier proceso que se conectara.
:::

:::caution
El valor de `EXPO_PUBLIC_LYNKEUS_TOKEN` queda escrito en el bundle en el momento de empaquetar. Si lo cambias, la app tiene que volver a empaquetarse para verlo.
:::

### 4. Genera los proyectos nativos y compila

```bash
npx expo prebuild
```

Después compila y abre la app en la plataforma que quieras:

```bash
npx expo run:ios
```

```bash
npx expo run:android
```

Esto produce un development build que ya contiene el módulo nativo del agente. Solo tendrás que repetirlo cuando actualices `lynkeus-agent`; para el resto de los cambios alcanza con el servidor de desarrollo.

### 5. Comprueba la conexión

Con la app abierta, ejecuta desde la carpeta del proyecto:

```bash
npx lynkeus screen
```

En un proyecto nuevo de expo-router deberías ver una primera línea como esta, seguida de los elementos de la pantalla:

```
index (__root > index)
```

`index` es la ruta actual, con el nombre que le da expo-router. Lo que va entre paréntesis es la cadena de navegadores desde la raíz hasta la pantalla enfocada. Que aparezcan significa que el agente reconoció las rutas de expo-router.

Con eso la instalación está completa. Sigue con [tu primer test](/es/getting-started/first-test/).

## Montar el agente a mano

Esto es lo que `lynkeus init` escribe en un proyecto con expo-router. Sirve para hacerlo sin el comando y para entender qué cambió en tu proyecto.

Primero, un archivo `index.js` en la raíz. Monta el agente y después carga el enrutador:

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

// El agente se monta antes de que expo-router renderice la app.
auto({ token: process.env.EXPO_PUBLIC_LYNKEUS_TOKEN });

import 'expo-router/entry';
```

`auto()` envuelve el componente raíz y encuentra el contenedor de navegación por su cuenta. Por defecto solo corre cuando `__DEV__` es verdadero, así que no necesitas pasar `enabled` salvo que quieras restringirlo más.

Segundo, la clave `main` de `package.json`. En un proyecto con expo-router apunta a `expo-router/entry`; tiene que apuntar al archivo nuevo:

```json title="package.json"
{
  "main": "index.js"
}
```

Si te saltas este cambio, la app arranca con normalidad pero el agente nunca se monta, porque `index.js` no se ejecuta.

## Qué pasó por debajo

Al arrancar, la app ejecuta `index.js`. `auto()` registra un envoltorio para el componente raíz y, cuando expo-router monta la app, el agente queda adentro. Desde ahí intenta conectarse al puerto 8123 de tu máquina: a `localhost` en iOS y a `10.0.2.2` en el emulador de Android.

Cuando ejecutas `npx lynkeus screen`, el CLI abre ese puerto, espera a la app, presenta el token y pide la pantalla. La app es la que llama; dentro de ella nada queda escuchando.

## Problemas frecuentes

### El CLI no encuentra la app

```
No app attached on 127.0.0.1:8123 within 15000ms. Is a dev build running with <Lynkeus>?
```

Las causas, de la más común a la menos:

1. Montaste el agente a mano y `main` en `package.json` sigue apuntando a `expo-router/entry`.
2. Estás abriendo la app en Expo Go y no en el development build.
3. No recompilaste después de instalar `lynkeus-agent`.
4. El token llegó vacío a la app, y su log lo dice: `lynkeus: the app passed a token and it is empty`. Define `EXPO_PUBLIC_LYNKEUS_TOKEN` antes de arrancar el servidor de desarrollo.
5. Las dos variables del token no tienen el mismo valor, o cambiaste `EXPO_PUBLIC_LYNKEUS_TOKEN` sin volver a empaquetar.

### Las pestañas no aparecen en `lynkeus screen`

La plantilla más reciente de Expo usa una barra de pestañas nativa. La dibuja el sistema operativo, no React Native, así que sus pestañas no figuran como elementos y no se pueden tocar por nombre.

Para cambiar de pestaña en un test, navega directamente a la ruta:

```bash
npx lynkeus nav <ruta>
```

El nombre de cada ruta es el que muestra la primera línea de `lynkeus screen` cuando estás en esa pantalla.

`nav` es un salto directo, no una acción de usuario. Sirve para llegar al punto donde empieza lo que quieres probar. Más detalle en [Expo](/es/platforms/expo/).

### Un cambio en el token no surte efecto

Mira la advertencia del paso 3: el valor está fijo en el bundle. Vuelve a empaquetar la app con la variable ya definida.

## Próximos pasos

- [Tu primer test](/es/getting-started/first-test/): maneja la app a mano y escribe un caso.
- [Expo](/es/platforms/expo/): los límites conocidos de la plataforma.
- [Conceptos](/es/getting-started/concepts/): el vocabulario del resto de la documentación.
- [Solución de problemas](/es/troubleshooting/): la lista completa de síntomas.
