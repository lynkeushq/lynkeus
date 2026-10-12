---
title: Android
description: Lo que es propio de Android al usar lynkeus, con sus requisitos, la conexión desde el emulador, los comandos del sistema disponibles y los problemas conocidos.
---

Esta página reúne lo que es específico de Android: qué exige el agente para funcionar, cómo llega la app del emulador hasta el CLI, qué comandos del sistema existen y cuáles no, y qué suele fallar.

Supone que ya instalaste lynkeus. Si no, empieza por [Instalación en React Native](/es/getting-started/installation-react-native/) o [Instalación en Expo](/es/getting-started/installation-expo/).

## Requisitos

- **Una app depurable.** El módulo nativo comprueba la marca `FLAG_DEBUGGABLE` de la aplicación y se niega a funcionar si no está. Un build de depuración la tiene; uno de producción, no.
- **React Native 0.76 o posterior.**
- **Un emulador encendido**, con la app abierta.
- **`adb` disponible en la terminal.** El CLI lo usa para encontrar el dispositivo y para todo lo que ocurre fuera de la app, como tomar una captura de pantalla.

El agente trae código nativo. Después de instalar o actualizar `lynkeus-agent`, recompila la app una vez.

## Cómo se conecta la app

Desde dentro del emulador, `localhost` es el propio emulador, no tu máquina. Por eso en Android el agente se conecta por defecto a `10.0.2.2:8123`: es la dirección con la que el emulador alcanza a la computadora que lo aloja.

No tienes que configurar nada. El agente elige la dirección según la plataforma.

Si necesitas otro puerto, define `LYNKEUS_PORT` con el mismo valor para la app y para el CLI. Si necesitas otra dirección, las opciones `host` y `port` de `auto()` y de `<Lynkeus>` la cambian:

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

// Solo si el CLI no está en la dirección por defecto.
auto({ token: process.env.LYNKEUS_TOKEN, host: '10.0.2.2', port: 8123 });
```

## Cómo se elige el dispositivo

Leer la pantalla, tocar y esperar no requieren elegir nada: esos pedidos viajan por la conexión que abrió la app. El dispositivo importa para lo que el CLI hace desde afuera, con `adb`, como `lynkeus screenshot`.

Al conectarse, la app dice en qué plataforma corre. Cuando dice Android, el CLI busca su dispositivo con `adb devices` y sigue esta regla:

1. Si `--device` o la variable `LYNKEUS_DEVICE` nombran un número de serie que `adb devices` lista como listo, usa ese.
2. Si no, usa el primero que esté listo.

```bash
adb devices
```

```
List of devices attached
emulator-5554	device
```

```bash
npx lynkeus screenshot inicio.png --device emulator-5554
```

El valor tiene que ser el número de serie exacto. Un nombre que no coincide con ninguno no produce un error: se usa el primer dispositivo. Es deliberado, para que un `device` pensado para el simulador de iOS no rompa las ejecuciones en Android cuando trabajas con las dos plataformas.

Si `adb devices` no lista ninguno, el mensaje es:

```
No Android device or emulator is up (adb devices lists none).
```

## Cómo se generan los toques

En Android el agente construye eventos `MotionEvent` y los entrega a la ventana de la actividad. Las teclas pasan por el `EditText` que tiene el foco.

No usa instrumentación ni pide el permiso `INJECT_EVENTS`. Los eventos entran por el mismo camino que los de un dedo, de modo que los reconocedores de gestos, los `Pressable` y las hojas los reciben como reales.

## Por qué solo en builds depurables

El agente permite manejar la app desde otro proceso. En una app publicada eso sería una puerta abierta, así que la comprobación está en el código nativo y no depende de una opción que alguien pueda olvidar.

Si la app no es depurable, las llamadas al módulo fallan con este mensaje:

```
Lynkeus is only available in debuggable builds
```

Del lado de JavaScript, además, el cliente del agente solo se carga cuando `enabled` es verdadero, y su valor por defecto es `__DEV__`.

## Lo que el sistema le entrega a la app

:::caution
`lynkeus launch` y los comandos `os` de esta sección no se ejecutaron en Android durante la verificación de esta documentación. Lo que sigue describe lo que hace el código. En el emulador se comprobaron la conexión del agente, la lectura de la pantalla y `lynkeus screenshot`.
:::

Los comandos del grupo `os` actúan sobre el emulador desde afuera, a través de `adb`. En Android hay tres disponibles, además de `os deeplink`:

| Comando | Qué hace |
|---|---|
| `lynkeus os permissions <grant\|revoke> <permiso>` | Concede o revoca un permiso. |
| `lynkeus os appearance <light\|dark>` | Cambia entre modo claro y oscuro. |
| `lynkeus os location <lat>,<lon>` | Fija la ubicación del emulador. |
| `lynkeus os deeplink <url>` | Abre una URL en la app, como se la entregaría el sistema. Lo resuelve el agente, no `adb`. |

Dos diferencias con iOS en los permisos. No existe `reset`: solo `grant` y `revoke`. Y el permiso se nombra como en Android. Puedes escribir el nombre completo o solo la última parte, que lynkeus completa:

```bash
npx lynkeus os permissions grant camera --app com.example.myapp
npx lynkeus os permissions grant android.permission.ACCESS_FINE_LOCATION --app com.example.myapp
```

En el primer ejemplo, `camera` se convierte en `android.permission.CAMERA`.

Los comandos `os push` y `os language` no están disponibles en Android. Si los ejecutas, el mensaje es:

```
"push" is not available on Android through lynkeus; permissions, appearance and location are
```

## Capturas de pantalla y píxeles

Un emulador tiene píxeles, igual que un simulador de iOS.

`lynkeus screenshot <archivo>` escribe en un PNG lo que se ve en ese momento. Está verificado en el emulador.

`lynkeus snapshot <nombre> --pixels` compara la pantalla con una imagen de referencia. Antes de tomarla, pone la barra de estado en modo de demostración (9:41, batería completa, sin notificaciones) para que el reloj no cuente como diferencia.

`lynkeus lint` mide además el contraste de cada texto contra lo que tiene detrás. Revisa los dos temas:

```bash
npx lynkeus os appearance light && npx lynkeus lint
npx lynkeus os appearance dark  && npx lynkeus lint
```

## Problemas conocidos

### Un toque cae por encima de su objetivo

Ocurría en apps que dibujan debajo de la barra de estado. La posición calculada para un elemento y la posición real de su vista diferían en la altura de esa barra, y el toque caía más arriba.

Está corregido a partir de la versión 0.2.0: el módulo nativo informa dónde está realmente cada vista. El arreglo vive en el código nativo, así que **hay que recompilar la app** después de actualizar `lynkeus-agent`. Hasta que lo hagas, el agente se comporta como antes.

### El CLI no encuentra la app

La app intenta conectarse a `10.0.2.2:8123` apenas arranca. Si el CLI no la ve, revisa:

1. Que la app sea un build de depuración.
2. Que `enabled` sea verdadero en este entorno.
3. Que el token con el que se compiló la app sea el `LYNKEUS_TOKEN` que lee el CLI.

Si la app tarda en arrancar, `--attach-timeout <ms>` le da más tiempo.

### La app lleva otra versión del agente

Si actualizaste el CLI sin recompilar la app, lynkeus avisa que las versiones difieren. Instala la misma versión de `lynkeus-agent` que la del CLI y recompila.

## Límites

- **Dispositivos físicos.** Esta documentación cubre el emulador. La dirección por defecto, `10.0.2.2`, solo existe dentro de él; un teléfono real no llega a tu máquina por ahí.
- **Notificaciones push e idioma.** No hay comando para entregarlas o cambiarlo en Android.
- **Builds de producción.** El agente no funciona en uno, y es intencional.

## Próximos pasos

- [Manejar la app](/es/guides/driving-the-app/)
- [Solución de problemas](/es/troubleshooting/)
- [Seguridad](/es/security/)
