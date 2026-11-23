---
title: Flutter
description: Cómo usar Lynkeus con una app de Flutter, desde montar lynkeus_agent hasta correr casos en un simulador, un emulador o sin pantalla, con lo que se lee del árbol de widgets y los límites actuales.
---

Lynkeus también maneja apps de Flutter. Los casos, el CLI, los reportes y el servidor MCP son los mismos que en React Native ([Escribir casos](/es/guides/writing-cases/), [Manejar la app](/es/guides/driving-the-app/)); aquí solo está lo que cambia en Flutter.

Dos paquetes de Dart, en la carpeta `flutter/` del repositorio, marcan la diferencia:

- **`lynkeus_agent`** va en tu app. Se conecta al CLI desde un build de depuración y responde leyendo el árbol de widgets.
- **`lynkeus_headless`** va en `dev_dependencies` y aloja la app dentro de `flutter test`, sin simulador.

## Preparación

El camino corto es `lynkeus init`, desde la carpeta de la app:

```bash
npx lynkeus init
```

Detecta una app de Flutter por su `pubspec.yaml` (con `flutter: sdk: flutter` en `dependencies`). Con `--runtime react-native` o `--runtime flutter` fuerzas el tipo de proyecto. El comando agrega `lynkeus_agent` al `pubspec.yaml`, agrega el import y la llamada `LynkeusAgent.start();` antes de `runApp` en `lib/main.dart`, y crea el token del proyecto en `.lynkeus/token`. Con `--no-install` no toca el `pubspec.yaml`.

Si prefieres hacerlo a mano:

```yaml
# pubspec.yaml
dependencies:
  lynkeus_agent:
    path: ../lynkeus_agent   # hasta que se publique
```

```dart
import 'package:lynkeus_agent/lynkeus_agent.dart';

void main() {
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

Arranca el agente lo primero en `main()`, antes de `WidgetsFlutterBinding.ensureInitialized()`: Lynkeus FastSim instala su propio binding y uno ya creado no se puede reemplazar (`lynkeus init` lo deja en ese lugar). El agente necesita el token del proyecto en el build. En Flutter se pasa con `--dart-define`:

```bash
flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

El agente llama hacia afuera a `127.0.0.1:8123`; en Android prueba primero `10.0.2.2` y después `127.0.0.1`. Para cambiarlo, define `LYNKEUS_HOST` y `LYNKEUS_PORT` también con `--dart-define`.

## En el simulador de iOS y el emulador de Android

Con un simulador o emulador abierto, `flutter run` con el mismo `--dart-define` deja la app lista y `npx lynkeus screen` debería mostrar su pantalla; qué necesita cada plataforma está en [iOS](/es/platforms/ios/) y [Android](/es/platforms/android/). La app de `flutter/sample/` y sus casos sirven de ejemplo completo.

## Cómo se identifican los elementos

Un `testId` es un `ValueKey<String>` (o `Key('...')`) o un `Semantics(identifier: ...)`, y se escribe `#increment`; si la clave está en un envoltorio, nombra al primer elemento listado debajo. El texto y las etiquetas (`Semantics(label:)`, un tooltip, el `semanticLabel` de un ícono) se buscan como en cualquier caso, y un fragmento de un párrafo nunca es un objetivo. El tipo de cada elemento sale de lo que los controles le dicen a las tecnologías de asistencia, así que Material, Cupertino y los paquetes `material_ui` y `cupertino_ui` se leen igual.

La pantalla es el árbol de elementos en escena: quedan fuera las rutas tapadas por una opaca, los subárboles `Offstage` y las filas de una lista perezosa más allá de lo visible. `covered` es la prueba de impacto de Flutter en el centro del elemento, e `inert` es estar bajo un `IgnorePointer` o `AbsorbPointer`.

Un comando para `app.call` se registra con `LynkeusAgent.register('reset', (params) async { … })`. Dos nombres tienen sentido para los drivers: `reset` (dejar la app como recién instalada) y `busy` (verdadero mientras hay trabajo en curso).

## Rutas

Los nombres de ruta de Flutter suelen empezar con `/`, y una palabra en minúscula sola se lee como texto, así que en un caso hay que decir que es una ruta: `app.wait: "route:/settings"`. El resto del formato de los casos es el de React Native.

`route`, `path`, los eventos `navigation` y `navigate` necesitan saber cuáles son las rutas de la app. Con un `Navigator` y rutas con nombre, pasa el observador del agente en el navegador raíz:

```dart
MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver], routes: {...});
```

Las rutas sin nombre (un diálogo, una página sin `settings`) están en pantalla pero no se informan: la ruta sigue siendo la última con nombre.

Si la app usa un router, el agente no depende de ningún paquete de routers: describes las rutas con el estado del propio router. Con go_router:

```dart
final router = GoRouter(routes: [...]);

void main() {
  LynkeusAgent.start(
    routes: LynkeusRoutes(
      current: () => router.state.name ?? router.state.matchedLocation,
      changes: router.routerDelegate,
      navigate: (name, params) => router.goNamed(
        name,
        pathParameters: {for (final e in (params ?? const {}).entries) e.key: '${e.value}'},
      ),
    ),
  );
  runApp(MaterialApp.router(routerConfig: router));
}
```

## Registro de red

Las peticiones que pasan por el `HttpClient` de `dart:io` se registran, se simulan y se retienen con los mismos comandos que en React Native ([Fixtures](/es/guides/fixtures/), `lynkeus requests`, `lynkeus mock`). Lo usan `package:http` (con `IOClient`) y dio con su adaptador por defecto; un cliente con red propia (un canal de plataforma, un webview) no se ve.

## Sin pantalla (headless)

`lynkeus_headless` ejecuta el `main()` de tu app dentro de `flutter test`, con diseño real y pintado por software, sin simulador. El agente se conecta como en un dispositivo, así que todos los comandos funcionan igual; qué es un host está en [Headless](/es/platforms/headless/), y aquí solo lo que cambia.

Agrégalo a la app:

```yaml
dev_dependencies:
  lynkeus_headless:
    path: ../lynkeus_headless   # hasta que se publique
```

```bash
npx lynkeus headless start    # escribe .lynkeus/host/lynkeus_host_test.dart y lo corre con flutter test
npx lynkeus case run --host   # levanta ese host durante la ejecución y lo detiene al terminar
```

El archivo del host vive en `.lynkeus/host/` y no en `test/`: un host nunca termina, y el `flutter test` de la app lo recogería junto con sus pruebas y se quedaría colgado. El CLI busca Flutter en `FLUTTER_ROOT`, después en `flutter` del `PATH` y por último con `mise which flutter`. Si el punto de entrada no es `lib/main.dart`, indícalo con `--entry` o con `entry` en `lynkeus.config.json`.

### Tiempo

La app corre con el tiempo falso de flutter_test, así que el host manda sobre el reloj. Mientras el CLI espera a la app y ella no tiene peticiones en curso, cada vuelta adelanta el reloj un cuadro entero: una cuenta regresiva de tres segundos pasa en unos cientos de milisegundos reales. En el resto del tiempo el reloj sigue el paso del reloj real. `lynkeus os clock` lo maneja a mano (`--advance`, `--settle`, `--now`, `--reset`). El reloj de la app es `package:clock`.

### Pantalla y capturas

Por defecto el host simula un iPhone (402x874 puntos a 3x, con sus márgenes seguros). Cámbialo en `lynkeus.config.json`:

```json
{ "flutterHost": { "platform": "android", "window": "412x915@2.625", "networkHosts": ["127.0.0.1", "api.local"] } }
```

`platform` es `ios` o `android`, `window` tiene la forma `AnchoxAlto@escala` y `networkHosts` son los únicos hosts a los que la app puede llegar (por defecto, loopback y `10.0.2.2`; los demás fallan como un error de socket). Las capturas salen como PNG al tamaño en píxeles del dispositivo, con las fuentes de la app, Roboto y MaterialIcons cargadas, para que el texto sea legible.

### Plugins simulados

flutter_test no responde los canales de plataforma: un plugin lanzaría `MissingPluginException`. El host responde a todos. Estos plugins tienen un sustituto que guarda su estado en memoria durante la ejecución:

| Plugin | Sustituto | Se maneja con |
|---|---|---|
| shared_preferences | un mapa clave-valor | la app |
| flutter_secure_storage | un mapa clave-valor | la app |
| path_provider | carpetas bajo una carpeta temporal por ejecución | |
| device_info_plus, package_info_plus | un iPhone 17 con iOS 26.5, o un emulador Android 15, según lo que simule el host | |
| url_launcher | dice que puede abrir la URL, no abre nada y la anota | `lynkeus call launched` (`{ clear: true }` la vacía) |
| local_auth | un sensor con Face ID registrado; los avisos tienen éxito | `lynkeus os biometrics --available none\|face --next success\|fail\|cancel\|<código>` |
| permission_handler | todos los permisos concedidos | `lynkeus call permissions '{"7": 4}'` (número de permiso a estado) |
| connectivity_plus | Wi-Fi | `lynkeus call network '{"state": "off"}'` |

Cualquier otro canal recibe un éxito vacío (null), para que el `await` de la app no se cuelgue, y deja una línea `[stub] <canal>` en el registro del host. Con `LYNKEUS_CHANNELS=trace` se imprime cada llamada y su respuesta.

Hay plugins que no tienen un canal de método por defecto al que sustituir, y por eso fallan en un host: sqflite 2.4 o posterior (también cuando llega a través de `cached_network_image`) y la API asíncrona de shared_preferences. El paquete opcional `lynkeus_plugins` los resuelve. Agrégalo junto a `lynkeus_agent`, como dependencia normal, y llámalo en la línea siguiente al arranque del agente:

```dart
LynkeusAgent.start();
LynkeusPlugins.ensureInitialized();
```

En un simulador, un emulador o un teléfono no hace nada. `lynkeus init` solo lo agrega cuando tu `pubspec.lock` muestra uno de esos plugins, y `lynkeus status` lo comprueba. Las vistas nativas (un WebView, un mapa, un video) quedan en blanco en cualquier host, porque no hay nada que las dibuje.

Un proyecto agrega los suyos en `test/lynkeus_host.dart` (no termina en `_test.dart`, para que sus pruebas unitarias lo ignoren). `lynkeus headless start` lo usa si existe:

```dart
import 'package:lynkeus_headless/lynkeus_headless.dart';

void configureHost(HostConfig host) {
  host.standIns.add('com.example/wallet', (method, args) => method == 'balance' ? 1250 : null);
  host.plugins.preferences['flutter.onboarded'] = true;
}
```

### Comandos que agrega el host

`appstate` (`active`, `inactive` o `background`, pasando por los estados intermedios), `deeplink` (un enlace como lo entregaría el sistema), `memory` (el tamaño residente del proceso) y `exit` (termina el host). Un caso puede reservar pasos para el host con `on: headless`.

## Límites actuales

- Un build de release no lleva el agente: solo funciona en builds de depuración.
- El host sin pantalla ve el `Platform` de la máquina y el `DateTime.now()` real. El reloj de la app es `package:clock`, que el host falsea.
- `--seed` no se aplica: el `Random()` de Dart no se puede sembrar desde afuera.
- Los reinicios de `--host-heap` se omiten en este host: no hay cifras de heap.
- `map`, `case impact`, `smoke` y `crawl` necesitan los fuentes de React Navigation y todavía no funcionan con Flutter.
- `lynkeus status` solo revisa la preparación de React Native (pide un `package.json`), así que en un proyecto de Flutter todavía no es significativo.
- Lynkeus FastSim para Flutter todavía no está disponible.
- Dos apps que llaman al mismo puerto entran en conflicto: cierra la otra o usa otro puerto con `LYNKEUS_PORT`.
