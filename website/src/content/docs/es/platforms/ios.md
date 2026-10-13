---
title: iOS
description: Lo que es propio de iOS al usar lynkeus, con sus requisitos, la elección del simulador, los comandos del sistema y los problemas conocidos.
---

Esta página reúne lo que es específico de iOS: qué necesita lynkeus para funcionar, cómo elige el simulador, qué puede pedirle al sistema desde afuera y qué suele fallar.

Supone que ya instalaste lynkeus. Si no, empieza por [Instalación en React Native](/es/getting-started/installation-react-native/) o [Instalación en Expo](/es/getting-started/installation-expo/).

## Requisitos

- **La Nueva Arquitectura.** En iOS es obligatoria. El agente mide cada elemento a través del árbol de Fabric, con una llamada síncrona.
- **Un build de depuración.** En un build de producción el agente no existe (más abajo, [Por qué solo en depuración](#por-qué-solo-en-depuración)).
- **React Native 0.76 o posterior.**
- **Un simulador encendido**, con la app abierta. El CLI consulta los simuladores con `xcrun simctl`, así que necesita las herramientas de Xcode. Un iPhone físico no sirve (más abajo, [Límites](#límites)).
- **Node 22 o posterior** para el CLI.

Después de instalar o actualizar `lynkeus-agent`, instala los pods y recompila una vez:

```bash
cd ios && pod install
```

## Cómo se conecta la app

En iOS el agente se conecta a `localhost:8123`. El simulador comparte la red con tu Mac, así que esa dirección alcanza directamente al CLI.

Si necesitas otro puerto, define `LYNKEUS_PORT` con el mismo valor para la app y para el CLI.

## Elegir el simulador

Con un solo simulador encendido no hay nada que elegir: lynkeus usa ese.

Con varios, indica cuál por su UDID o por una parte de su nombre. Hay tres lugares donde decirlo, de mayor a menor prioridad:

| Dónde | Ejemplo |
|---|---|
| La opción `--device` | `npx lynkeus screen --device "iPhone 16"` |
| La variable `LYNKEUS_DEVICE` | `export LYNKEUS_DEVICE="iPhone 16"` |
| La clave `device` en `lynkeus.config.json` | `"device": "iPhone 16"` |

Si el nombre no coincide con ningún simulador encendido, el mensaje es:

```
No booted simulator matching "iPhone 16".
```

## Abrir y reiniciar la app

Para que lynkeus pueda abrir la app necesita su identificador (*bundle id*). Dáselo con `--app`, o una vez con la clave `app` en `lynkeus.config.json`.

```bash
npx lynkeus launch com.example.myapp
```

`launch` cierra la app si estaba abierta, la vuelve a abrir, espera a que el agente se conecte e imprime la pantalla. Con `--clean` ejecuta antes el comando `reset` de la app, si la app lo registró.

Cualquier otro comando acepta `--launch --app <bundleId>` para reiniciar la app antes de conectarse:

```bash
npx lynkeus screen --launch --app com.example.myapp
```

## Lo que el sistema le entrega a la app

En un simulador, la capa nativa es real. Los comandos del grupo `os` actúan sobre el simulador desde afuera, como lo haría el sistema operativo. Todos necesitan saber cuál es la app, así que conviene tener `app` en la configuración.

| Comando | Qué hace |
|---|---|
| `lynkeus os permissions <grant\|revoke\|reset> <servicio>` | Concede, revoca o restablece un permiso: `camera`, `photos`, `location`, `microphone`, `contacts`. |
| `lynkeus os push <payload>` | Entrega una notificación push. Recibe un JSON o un archivo `.json`. |
| `lynkeus os appearance <light\|dark>` | Cambia entre modo claro y oscuro. |
| `lynkeus os location <lat>,<lon>` | Fija la ubicación del dispositivo. Con `clear` la borra. |
| `lynkeus os language [tag]` | Reinicia la app en otro idioma, por ejemplo `de-DE`. Sin argumento usa el de `lynkeus.config.json`. |
| `lynkeus os deeplink <url>` | Abre una URL en la app, como se la entregaría el sistema. |

Ejemplos:

```bash
npx lynkeus os permissions grant camera
npx lynkeus os push '{"alert":"Tu pedido está en camino"}'
npx lynkeus os appearance dark
```

Una notificación que solo trae `alert` se envuelve sola en la clave `aps` que espera el simulador.

## Capturas de pantalla y píxeles

Un simulador tiene píxeles, y eso habilita tres cosas que el host sin pantalla no puede hacer.

`lynkeus screenshot <archivo>` escribe en un PNG lo que se ve en ese momento.

`lynkeus snapshot <nombre> --pixels` compara la pantalla con una imagen de referencia. Antes de tomarla, fija la barra de estado (9:41, batería completa) para que el reloj no cuente como diferencia. La opción `--no-freeze` lo evita.

`lynkeus lint` mide además el contraste de cada texto contra lo que tiene detrás. Como lee los píxeles y no los estilos, conviene revisar los dos temas:

```bash
npx lynkeus os appearance light && npx lynkeus lint
npx lynkeus os appearance dark  && npx lynkeus lint
```

Más en [Lint y contraste](/es/guides/lint-and-contrast/) y en [Grabación y snapshots](/es/guides/recording-and-snapshots/).

## Por qué solo en depuración

Para generar un toque que los reconocedores de gestos acepten como real, el agente usa API privada de UIKit. Es la misma técnica en la que se apoyan KIF y Detox.

Ese código está envuelto en `#if DEBUG`. En un build de producción los símbolos no existen en el binario: no están desactivados, están ausentes. No hay nada que una revisión de la tienda pueda encontrar ni nada que un tercero pueda activar.

Del lado de JavaScript ocurre algo equivalente. El cliente del agente, que es todo lo que lee la pantalla y habla con el driver, solo se carga cuando `enabled` es verdadero. Eso vale sea cual sea la forma en que la app importa el paquete y lo que Metro esté configurado para incorporar.

## Problemas conocidos

### Al escribir no aparece el teclado

`type` toca primero el campo, igual que una persona, y eso debería levantar el teclado del sistema. Cuando no aparece, el simulador está tomando las teclas del teclado de la Mac.

Desactívalo en el menú del simulador, en **I/O → Keyboard → Connect Hardware Keyboard**, o desde la terminal:

```bash
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
```

### El CLI no encuentra la app

La app intenta conectarse a `localhost:8123` apenas arranca. Si el CLI no la ve, revisa:

1. Que sea un build de depuración.
2. Que `enabled` sea verdadero en este entorno.
3. Que el log de la app no diga `lynkeus: the app passed a token and it is empty`. Si lo dice, el token no llegó a la app y el agente quedó apagado; el arreglo está en [Solución de problemas](/es/troubleshooting/).
4. Que el token que recibió la app sea el `LYNKEUS_TOKEN` del CLI.

### Un campo se lee vacío después de escribir en él

`lynkeus screen` muestra `value=""` en un campo donde `type` acaba de escribir. Pasa en una app compilada antes de actualizar `lynkeus-agent`: el agente lee el valor de las propiedades de React, y un campo que la app no controla con una propiedad `value` no lo tiene ahí.

Desde la versión 0.3.0 el valor es lo que contiene el campo nativo. La lectura vive en el módulo nativo, así que hay que instalar los pods y recompilar la app después de actualizar. Hasta entonces, el agente lee las propiedades como antes.

### La app lleva otra versión del agente

Si actualizaste el CLI pero no recompilaste la app, lynkeus avisa que las versiones difieren. El agente y el CLI tienen que coincidir: instala la misma versión de `lynkeus-agent` y recompila.

## Límites

- **Dispositivos físicos.** No están soportados. El CLI busca un simulador encendido, y abrir la app, tomar capturas de pantalla y los comandos `os` pasan por `simctl` sobre un simulador.
- **Video.** `case run --video` filma solo donde el host ofrece un comando `record`. Una sesión de simulador no lo ofrece: la ejecución conserva sus capturas y no tiene película.
- **Builds de producción.** No hay forma de activar el agente en uno, y es intencional.

## Próximos pasos

- [Manejar la app](/es/guides/driving-the-app/)
- [Solución de problemas](/es/troubleshooting/)
- [Seguridad](/es/security/)
