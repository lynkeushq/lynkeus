---
title: Flutter
description: Cómo usar Lynkeus con una app de Flutter, desde montar lynkeus_agent hasta correr casos en un simulador, un emulador o sin pantalla, con lo que se lee del árbol de widgets y los límites actuales.
---

Lynkeus también maneja apps de Flutter. El agente vive dentro de la app, lee el árbol de widgets en vivo y genera toques reales por el sistema de gestos de Flutter, así que los casos, los comandos y los reportes son los mismos que en React Native.

Hay tres piezas, todas en la carpeta `flutter/` del repositorio:

- **`lynkeus_agent`**, un paquete de Dart que montas en tu app. Se conecta al CLI desde un build de depuración y responde a los pedidos: qué hay en pantalla, toca esto, escribe aquello.
- **`lynkeus_headless`**, un paquete que aloja la app dentro de `flutter test`, sin simulador. Es lo que usa `lynkeus case run --host`.
- **`sample/`**, una app pequeña (iOS y Android) con casos en `sample/cases/` que sirven de modelo.

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

El agente necesita el token del proyecto en el build. En Flutter se pasa con `--dart-define`:

```bash
flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

El agente llama hacia afuera a `127.0.0.1:8123`; en Android prueba primero `10.0.2.2` y después `127.0.0.1`. Para cambiarlo, define `LYNKEUS_HOST` y `LYNKEUS_PORT` también con `--dart-define`.

## En el simulador de iOS y el emulador de Android

Con un dispositivo encendido, `flutter run` con el mismo `--dart-define` deja la app abierta. Si prefieres compilar e instalar tú (desde `flutter/sample/`, por ejemplo):

```bash
# Simulador de iOS
flutter build ios --simulator --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
xcrun simctl install <device> build/ios/iphonesimulator/Runner.app
xcrun simctl launch <device> io.lynkeus.lynkeusSample

# Emulador de Android
flutter build apk --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
adb -s <serial> install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s <serial> shell am start -n io.lynkeus.lynkeus_sample/.MainActivity
```

Después, con la app abierta:

```bash
npx lynkeus case run --device <device>
```

Elegir el dispositivo funciona igual que en [iOS](/es/platforms/ios/) y [Android](/es/platforms/android/).

## Cómo se identifican los elementos

El agente lee el árbol de elementos que está en escena. Quedan fuera las rutas que otra ruta opaca tapa, los subárboles con `Offstage` y las filas que una lista perezosa mantiene construidas más allá de lo visible. Los marcos son los límites de los objetos de render, en puntos lógicos.

- **`testId`.** Un widget con `ValueKey<String>` (o `Key('...')`) o con `Semantics(identifier: ...)` se encuentra por ese id: `#increment`.
- **Texto y etiqueta.** Un elemento se encuentra por su texto o por la etiqueta de `Semantics`.
- **Tipo (`kind`).** Sale del nivel de widgets y de lo que los controles le dicen a las tecnologías de asistencia: `Semantics(button: true)`, un interruptor, un campo de texto, o un `GestureDetector` con manejador de toque. Por eso Material, Cupertino y los paquetes `material_ui` y `cupertino_ui` se leen igual. Los tipos son `button`, `input`, `switch`, `text`, `image`, `scroll` y `view`.
- **`covered`.** Es la prueba de impacto de Flutter en el centro del elemento: otro elemento recibiría el toque.
- **`hidden: behind-modal`.** Todo lo que queda debajo de la barrera de la ruta modal más alta.
- **`inert`.** El elemento está bajo un `IgnorePointer` o un `AbsorbPointer`.

Para que un caso pueda llamar a lógica de tu app, registra un comando:

```dart
LynkeusAgent.register('reset', (params) async { /* … */ });
```

y úsalo desde el caso con `app.call: { command: reset }`. Dos nombres tienen sentido para los drivers: `reset` (dejar la app como recién instalada) y `busy` (verdadero mientras la app tiene trabajo en curso).

## Escribir casos

El formato es el mismo que en React Native ([Escribir casos](/es/guides/writing-cases/)). Una diferencia: los nombres de ruta de Flutter suelen empezar con `/` y no con mayúscula, así que en `app.wait` necesitan el prefijo `route:`.

```yaml
app.wait: "route:/settings"
```

Un caso del `sample/`, que cuenta, escribe y espera una cuenta regresiva:

```markdown
---
id: flutter-resend-code
title: "Counter and resend countdown in a Flutter app"
---
steps:
  - app.call: { command: reset }
  - app.see: { text: "Count: 0" }
  - app.press: "#increment"
  - app.press: "#increment"
  - app.see: { text: "Count: 2" }
  - app.type: { target: "#name", text: "Ana" }
  - app.press: "#send"
  - app.see: { text: "Code sent to Ana" }
  - app.wait: { target: "Resend now", timeoutMs: 6000 }
expected:
  - The counter reads 2 and the code went to Ana.
```

Empezar con `reset` permite correr los casos en cualquier orden sobre una misma ejecución de la app.

## Rutas

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

## Registro de red y mocks

El agente envuelve el `HttpClient` de `dart:io` mediante `HttpOverrides.global`, así que ve las peticiones de `package:http` (con `IOClient`) y las de dio con su adaptador por defecto. Un cliente que no pasa por `dart:io` no se registra.

Las peticiones se registran con los valores secretos ocultos, con las mismas reglas que en React Native, y cuentan como en curso para `idle`. Se leen con `lynkeus requests` y `lynkeus trace`. `lynkeus mock` las responde antes de la red o las retiene: `--hold` las deja en curso hasta un `--release`, útil para dejar a la vista un estado de carga.

```bash
npx lynkeus mock "GET /items" --status 500
npx lynkeus mock "GET /items" --hold
npx lynkeus mock --release
```

## Sin pantalla (headless)

`lynkeus_headless` ejecuta el `main()` de tu app dentro de `flutter test`, con diseño real y pintado por software, sin simulador. El agente se conecta como en un dispositivo, así que todos los comandos funcionan igual.

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

La app corre con el tiempo falso de flutter_test, así que el host manda sobre el reloj. Mientras el CLI espera a la app y ella no tiene peticiones en curso, cada vuelta adelanta el reloj un cuadro entero: una cuenta regresiva de tres segundos pasa en unos cientos de milisegundos reales. En el resto del tiempo el reloj sigue el paso del reloj real. `lynkeus os clock` lo maneja a mano: `--advance <ms>` ejecuta cada cuadro y temporizador de ese intervalo, `--settle` bombea cuadros sin mover el tiempo, `--now` y `--reset` cambian lo que responde el reloj de la app.

El reloj de la app es `package:clock` (`clock.now()`), que flutter_test falsea. `DateTime.now()` lee el reloj real.

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

Un proyecto agrega los suyos en `test/lynkeus_host.dart` (no termina en `_test.dart`, para que sus pruebas unitarias lo ignoren). `lynkeus headless start` lo usa si existe:

```dart
import 'package:lynkeus_headless/lynkeus_headless.dart';

void configureHost(HostConfig host) {
  host.standIns.add('com.example/wallet', (method, args) => method == 'balance' ? 1250 : null);
  host.plugins.preferences['flutter.onboarded'] = true;
}
```

### Comandos que agrega el host

`appstate` (`active`, `inactive` o `background`, pasando por los estados intermedios), `deeplink` (un enlace como lo entregaría el sistema), `memory` (el tamaño residente del proceso) y `exit` (termina el host). Un caso puede reservar pasos para el host con `on: headless`, como hace `sample/cases/settings.md`.

## Límites actuales

- Un build de release no lleva el agente: solo funciona en builds de depuración.
- El host sin pantalla ve el `Platform` de la máquina y el `DateTime.now()` real. El reloj de la app es `package:clock`, que el host falsea.
- `--seed` no se aplica: el `Random()` de Dart no se puede sembrar desde afuera.
- Los reinicios de `--host-heap` se omiten en este host: no hay cifras de heap.
- `map`, `case impact`, `smoke` y `crawl` necesitan los fuentes de React Navigation y todavía no funcionan con Flutter.
- `lynkeus status` solo revisa la preparación de React Native (pide un `package.json`), así que en un proyecto de Flutter todavía no es significativo.
- Lynkeus FastSim para Flutter todavía no está disponible.
- Dos apps que llaman al mismo puerto entran en conflicto: cierra la otra o usa otro puerto con `LYNKEUS_PORT`.
