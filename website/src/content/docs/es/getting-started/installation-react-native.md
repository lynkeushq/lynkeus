---
title: Instalación en React Native
description: Cómo instalar lynkeus en una app de React Native CLI, montar el agente, configurar el token y comprobar que el CLI se conecta.
---

Esta página instala lynkeus en una app creada con React Native CLI. Al terminar, tendrás el agente montado en tu app y podrás leer la pantalla desde la terminal con `lynkeus screen`.

Si tu app usa Expo, sigue [Instalación en Expo](/es/getting-started/installation-expo/): los pasos cambian.

## Qué vas a instalar

Son dos paquetes, y hacen cosas distintas.

`lynkeus-agent` es el **agente**: el código que queda dentro de tu app. Lee lo que React renderizó y genera toques y teclas. Tiene una parte nativa, así que hay que recompilar la app una vez.

`lynkeus` es el **CLI**: el programa que ejecutas en la terminal. Abre un puerto en tu máquina y espera a que la app se conecte.

El sentido de la conexión importa para diagnosticar problemas: es la app la que llama al CLI, no al revés. Dentro de la app nada queda escuchando.

## Antes de empezar

- React Native 0.76 o posterior.
- La Nueva Arquitectura activada. En iOS es obligatoria.
- Node 22 o posterior.
- Un simulador de iOS o un emulador de Android donde ya puedas correr tu app en modo de depuración. Los dispositivos físicos no están soportados.

## Pasos

### 1. Instala los paquetes

Los dos van como dependencias de desarrollo.

```bash
yarn add -D lynkeus-agent lynkeus
```

Con npm:

```bash
npm install --save-dev lynkeus-agent lynkeus
```

En iOS, instala además los pods:

```bash
cd ios && pod install
```

### 2. Monta el agente

Desde la carpeta de la app, ejecuta:

```bash
npx lynkeus init
```

:::note[Desde 0.3.0]
`lynkeus init` existe desde la versión 0.3.0. Con una versión anterior, agrega las líneas a mano como se muestra más abajo.
:::

El comando hace dos cambios. Abre el punto de entrada de la app (`index.js`, `index.tsx` o `index.ts`) y agrega la llamada a `auto()` después del último `import`. Y agrega el plugin `lynkeus-agent/babel` a `babel.config.js`, que es lo que hace llegar el token a la app; lo explica el paso 3. Deberías ver:

```
added auto() to index.js
added lynkeus-agent/babel to babel.config.js
start Metro with LYNKEUS_TOKEN set to the value the CLI reads; after changing it, start Metro with --reset-cache
```

Si el agente ya estaba montado, imprime `index.js already mounts the agent` y no toca ese archivo. Lo mismo con el plugin: `babel.config.js already has lynkeus-agent/babel`.

Si el comando no encuentra `babel.config.js` (o `babel.config.cjs`), o no reconoce su forma, no lo modifica y te pide que agregues el plugin a mano:

```
add 'lynkeus-agent/babel' to the plugins in babel.config.js, so the app can read LYNKEUS_TOKEN
```

#### Qué hace, y cómo hacerlo a mano

En el punto de entrada, el comando agrega un `import` y una llamada a `auto()` antes de `registerComponent`. El resultado equivale a este archivo, que puedes escribir tú. El comando no escribe `enabled`, porque su valor por defecto ya es `__DEV__`; aquí aparece para que se vea dónde acotarlo:

```js title="index.js"
import { AppRegistry } from 'react-native';
import { auto } from 'lynkeus-agent/auto';

import App from './src/App';
import { name as appName } from './app.json';

// Monta el agente solo en builds de depuración.
auto({ token: process.env.LYNKEUS_TOKEN, enabled: __DEV__ });

AppRegistry.registerComponent(appName, () => App);
```

En `babel.config.js`, agrega una entrada a la lista de plugins:

```js title="babel.config.js"
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Escribe LYNKEUS_TOKEN en el bundle de desarrollo.
  plugins: ['lynkeus-agent/babel'],
};
```

`auto()` hace dos cosas por ti. Envuelve el componente raíz a través de `AppRegistry`, de modo que ninguna pantalla tiene que renderizar nada. Y encuentra por su cuenta el contenedor de React Navigation, que es de donde salen los nombres de las rutas.

Las dos opciones del ejemplo:

| Opción | Valor por defecto | Qué controla |
|---|---|---|
| `enabled` | `__DEV__` | Si el agente corre o no. Cuando es `false`, el cliente (el código que lee la pantalla y habla con el CLI) nunca se evalúa. |
| `token` | ninguno | El secreto que debe presentar el CLI antes de ser atendido. Lo explica el paso 3. |

:::caution
Un build de depuración que apunta a producción, con cuentas reales, no debería correr el agente. Acota `enabled` según tu entorno, por ejemplo `enabled: __DEV__ && config.ENV !== 'prod'`.
:::

### 3. Define el token

El token es un secreto compartido entre la app y el CLI. Sirve para que otros procesos de tu máquina no puedan manejar la app: el agente solo atiende a quien abre la conexión con el mismo valor.

La app lo recibe en la opción `token` de `auto()`. El CLI lo lee de la variable de entorno `LYNKEUS_TOKEN`. Los dos valores tienen que coincidir.

El CLI lee la variable de tu terminal. La app no puede: React Native no le da ningún entorno, así que dentro del bundle `process.env.LYNKEUS_TOKEN` vale `undefined` mientras nada escriba ahí el valor. De eso se encarga el plugin `lynkeus-agent/babel` que agregó el paso 2: cuando Metro transforma el código, reemplaza `process.env.LYNKEUS_TOKEN` por el valor que la variable tiene en el entorno de Metro.

Por eso la variable tiene que estar definida en la terminal donde arrancas Metro, además de aquella donde ejecutas el CLI:

```bash
export LYNKEUS_TOKEN=un-secreto-local
npx react-native start --reset-cache
```

:::note[Desde 0.3.0]
El plugin `lynkeus-agent/babel` llega con la versión 0.3.0, junto con una regla nueva: un token que la app pasa y llega vacío deja al agente apagado. Antes, ese caso se trataba como "sin token" y el agente atendía a cualquier proceso que se conectara.
:::

Tres cosas a tener presentes:

- **Metro guarda lo que ya transformó.** Después de cambiar el valor de `LYNKEUS_TOKEN`, arranca Metro una vez con `--reset-cache`. Sin eso, la app sigue con el valor anterior.
- **El plugin solo actúa en un bundle de desarrollo.** En un bundle de producción no escribe nada: el secreto de tu máquina no llega a un build de producción.
- **Un token vacío apaga el agente.** Si la app pasa `token` y el valor llega vacío o `undefined`, el agente no arranca y la app lo dice en su log con una línea que empieza con `lynkeus: the app passed a token and it is empty`. Nunca pasa a atender sin token. Qué revisar está más abajo, en [Problemas frecuentes](#problemas-frecuentes).

Si la app tiene un token y el CLI presenta otro, la app no responde. Desde la terminal se ve igual que una app que no se conectó.

Llamar a `auto()` sin la clave `token` es otra cosa: ahí el agente no exige ninguno y atiende a cualquier proceso local que se conecte.

### 4. Recompila la app

El agente trae código nativo, así que el cambio no llega con una recarga de Metro. Con Metro corriendo como en el paso 3, recompila una vez:

```bash
npx react-native run-ios
```

o bien:

```bash
npx react-native run-android
```

A partir de aquí, con Metro alcanza. Solo tendrás que recompilar de nuevo cuando actualices `lynkeus-agent`.

### 5. Comprueba la conexión

Con la app abierta en el simulador o el emulador, ejecuta desde la carpeta de la app:

```bash
npx lynkeus screen
```

Deberías ver primero una línea que confirma la conexión y después el contenido de la pantalla, algo parecido a esto:

```
attached in 96ms (iPhone 16)
Home (Tabs > Home)
button #settings-button "Settings"
text "Welcome back"
input #search value="" placeholder="Search"
```

La primera línea del listado es la ruta actual y, entre paréntesis, la cadena de navegadores que llevan hasta ella. Cada línea siguiente es un elemento: su tipo, su `testID` con `#` adelante, su texto y su estado.

Si quieres ver qué dijo la app de sí misma (plataforma, versión del agente y comandos registrados), ejecuta:

```bash
npx lynkeus hello
```

Con eso la instalación está completa. El siguiente paso es [tu primer test](/es/getting-started/first-test/).

## Alternativa: el componente `<Lynkeus>`

`auto()` cubre el caso habitual. El componente explícito sirve cuando quieres pasarle un adaptador de navegación propio, porque usas un enrutador que no es React Navigation, o cuando prefieres ver el montaje en tu árbol de componentes.

Se monta una sola vez, en cualquier lugar debajo del contenedor de navegación. No renderiza nada.

```tsx title="src/App.tsx"
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { Lynkeus, reactNavigationAdapter } from 'lynkeus-agent';

const App = () => {
  const ref = useNavigationContainerRef();
  return (
    <NavigationContainer ref={ref}>
      <RootNavigator />
      <Lynkeus
        navigation={reactNavigationAdapter(ref)}
        token={process.env.LYNKEUS_TOKEN}
        enabled={__DEV__}
        app={{ name: 'myapp' }}
      />
    </NavigationContainer>
  );
};
```

Sus propiedades:

| Propiedad | Valor por defecto | Qué controla |
|---|---|---|
| `enabled` | `__DEV__` | Si el agente corre. |
| `navigation` | ninguno | El adaptador de navegación. El paquete incluye `reactNavigationAdapter(ref)`. Sin adaptador hay pantalla, toques y esperas, pero no rutas. |
| `host`, `port` | `localhost` (`10.0.2.2` en el emulador de Android), `8123` | Dónde escucha el CLI. |
| `token` | ninguno | El secreto compartido con el CLI. Si lo pasas y llega vacío, el agente queda apagado y la app lo dice en su log. |
| `app` | ninguno | Datos libres que la app envía al conectarse: nombre, versión, entorno. |

`auto()` acepta las mismas opciones, salvo `navigation`, que resuelve solo.

Una app que monta las dos cosas sigue funcionando: el primer cliente que arranca se queda con la conexión y el segundo no hace nada.

## Notas por plataforma

**iOS.** Requiere la Nueva Arquitectura. La app se conecta a `localhost:8123`. Más en [iOS](/es/platforms/ios/).

**Android.** El agente se niega a funcionar si la app no es depurable. Desde el emulador, la app se conecta a `10.0.2.2:8123`, que es la dirección con la que el emulador alcanza tu máquina. Más en [Android](/es/platforms/android/).

## Qué pasó por debajo

Al arrancar, el agente intenta conectarse al puerto 8123 de tu máquina. Durante los primeros 3 segundos reintenta cada 100 ms; después espacia los intentos hasta un máximo de 1,5 segundos. Que nadie escuche es la situación normal, así que la app no muestra ningún error mientras tanto.

Cuando ejecutas un comando, el CLI abre ese puerto, espera a que la app llegue (15 segundos por defecto), presenta el token, hace el pedido y cierra. Por eso un comando suelto cuesta bastante más que el paso en sí. Para encadenar muchos, `lynkeus session` mantiene una sola conexión abierta; lo explica [Manejar la app](/es/guides/driving-the-app/).

## Problemas frecuentes

### El CLI no encuentra la app

El mensaje es:

```
No app attached on 127.0.0.1:8123 within 15000ms. Is a dev build running with <Lynkeus>?
```

Revisa, en este orden:

1. Que la app esté abierta y sea un build de depuración.
2. Que hayas recompilado después de instalar `lynkeus-agent`.
3. Que `enabled` sea verdadero en este entorno.
4. Que el log de la app no diga que el token llegó vacío (el problema siguiente).
5. Que el token que Metro escribió en el bundle sea el mismo `LYNKEUS_TOKEN` que lee el CLI.

Si la app tarda en arrancar, dale más tiempo con `--attach-timeout <ms>`. Para que el CLI relance la app antes de conectarse, usa `--launch --app <bundleId>`.

### El log de la app dice `lynkeus: the app passed a token and it is empty`

El punto de entrada lee `process.env.LYNKEUS_TOKEN` y nada puso un valor ahí. El agente queda apagado en lugar de atender a quien se conecte, y desde la terminal el síntoma es el del problema anterior: el CLI no encuentra la app.

Revisa tres cosas:

1. Que `'lynkeus-agent/babel'` esté en la lista `plugins` de `babel.config.js`.
2. Que Metro haya arrancado con `LYNKEUS_TOKEN` definida.
3. Que, después de agregar el plugin o de cambiar el valor, hayas arrancado Metro una vez con `--reset-cache`.

### La primera línea muestra `?` en lugar de una ruta

El agente no tiene de dónde sacar las rutas. Con `auto()`, eso significa que no encontró un contenedor de React Navigation. Con `<Lynkeus>`, que no le pasaste `navigation`. Los elementos se leen igual, pero `lynkeus wait <Ruta>` no tiene qué esperar.

### Aviso de versiones distintas

```
⚠️  The app runs lynkeus-agent 0.2.0, this CLI is lynkeus 0.3.0: they can misread each other without an error.
```

El agente y el CLI tienen que ser de la misma versión. Instala en la app la versión de `lynkeus-agent` que indica el aviso y recompila.

### Dos ejecuciones se pelean por el puerto

Define `LYNKEUS_PORT` con el mismo valor en la app y en el CLI. Cada pareja es independiente, así que puedes tener varias en la misma máquina.

La lista completa de síntomas está en [Solución de problemas](/es/troubleshooting/).

## Próximos pasos

- [Tu primer test](/es/getting-started/first-test/): maneja la app a mano y escribe un caso.
- [Conceptos](/es/getting-started/concepts/): el vocabulario del resto de la documentación.
- [API del agente](/es/reference/agent-api/): `auto`, `<Lynkeus>`, `qa.register` y los adaptadores.
- [Seguridad](/es/security/): qué expone el agente y por qué solo existe en depuración.
