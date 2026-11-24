---
title: Flutter
description: Qué cambia al usar Lynkeus con una app de Flutter. La preparación, los tres lugares donde corre (un simulador o emulador, sin pantalla con flutter test, Lynkeus FastSim), qué cambia al escribir casos, los sustitutos de plugins y los límites actuales.
---

Lynkeus también maneja apps de Flutter. Los casos, el CLI, los reportes y el servidor MCP son los mismos que en React Native ([Escribir casos](/es/guides/writing-cases/), [Manejar la app](/es/guides/driving-the-app/)); aquí solo está lo que cambia en Flutter.

Dos paquetes de Dart, en la carpeta `flutter/` del repositorio, marcan la diferencia:

- **`lynkeus_agent`** va en tu app. Se conecta al CLI desde un build de depuración y responde leyendo el árbol de widgets.
- **`lynkeus_headless`** va en `dev_dependencies` y aloja la app dentro de `flutter test`, sin simulador.

Un tercero, `lynkeus_plugins`, es opcional ([Plugins simulados](#plugins-simulados)). Ninguno está todavía en pub.dev, así que se declaran como dependencias de git o de ruta. [Lynkeus FastSim](#lynkeus-fastsim) corre la app en un host propio, que se instala aparte de estos paquetes. Hace falta Flutter 3.47.9 o posterior.

## Resumen

| Tema | En una app de Flutter |
|---|---|
| Preparación | `npx lynkeus init` (`--headless` agrega el paquete del host; `--runtime flutter` en una carpeta que también es de React Native), o a mano. |
| Token en la app | `--dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)`, y `LYNKEUS_HOST` y `LYNKEUS_PORT` también con `--dart-define`. Sin plugin de Babel. |
| Dónde corre | En un simulador o emulador (build de depuración); [sin pantalla](#sin-pantalla-headless) con `flutter test` y `case run --host`, con cualquiera de los dos aspectos según `flutterHost.platform`; [Lynkeus FastSim](#lynkeus-fastsim), un host aparte. Un build de release no lleva el agente. |
| `testId` | Un `ValueKey<String>` o un `Semantics(identifier:)`, que se escribe `#id`. |
| En un caso | `app.wait: { text: X }` espera siempre un texto; los comandos se registran con `LynkeusAgent.register`; un campo sin etiqueta se apunta por su texto de ayuda. |
| Rutas | Se leen del `Router` de la app (go_router y similares) sin conectar nada, o con un observador de `Navigator`. En `wait` se escriben `route:/settings`. |
| Red | Solo las peticiones del `HttpClient` de `dart:io`. Los hosts mantienen a la app fuera de internet (`networkHosts`) y reproducen lo que grabó una corrida en un dispositivo. |
| Plugins | En un host, sustitutos en memoria, en la [tabla de abajo](#plugins-simulados). |

## Preparación

El camino corto es `lynkeus init`, desde la carpeta de la app:

```bash
npx lynkeus init
```

En una carpeta cuyo `pubspec.yaml` depende de `flutter`, `init` agrega `lynkeus_agent` a `dependencies`, lo arranca en `lib/main.dart` y crea el token del proyecto en `.lynkeus/token`, fuera de git. Solo cambia lo que falta. Si la carpeta también es una app de React Native, pasa `--runtime flutter`; `--headless` agrega además `lynkeus_headless` a `dev_dependencies`; `--no-install` no toca el `pubspec.yaml`; y si `main.dart` no tiene un `runApp(` que pueda reconocer, imprime las líneas que hay que agregar. Cuando el lockfile muestra un plugin que en un host necesita `lynkeus_plugins`, `init` también lo agrega, con su llamada ([Plugins simulados](#plugins-simulados)).

A mano:

```yaml title="pubspec.yaml"
dependencies:
  lynkeus_agent:
    git:
      url: https://github.com/lynkeushq/lynkeus.git
      path: flutter/lynkeus_agent
```

```dart title="lib/main.dart"
import 'package:lynkeus_agent/lynkeus_agent.dart';

void main() {
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

Arranca el agente lo primero en `main()`, antes de `WidgetsFlutterBinding.ensureInitialized()`. El agente pone su propio binding, que es el de siempre más lo necesario para que un frame capturado salga igual cada vez ([más abajo](#qué-muestra-el-frame-de-un-paso)) y, en FastSim, para que la app tenga su área segura; un binding ya creado no se puede reemplazar, y `lynkeus init` deja la línea en ese lugar. El agente lee el token de un `--dart-define`; sin él queda apagado y lo dice en la consola. Con un simulador o emulador abierto, corre la app y comprueba con `npx lynkeus screen`; qué necesita cada plataforma está en [iOS](/es/platforms/ios/) y [Android](/es/platforms/android/):

```bash
flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

`LYNKEUS_HOST` y `LYNKEUS_PORT` también son `--dart-define`. Por defecto la app llama a `127.0.0.1:8123`, y en Android primero a `10.0.2.2` y después a `127.0.0.1`. La app de `flutter/sample/` y sus casos sirven de ejemplo completo.

### Una app con su propio binding

Si el binding de la app es una clase propia (por ejemplo, una que redefine `handlePointerEvent`), basta con que herede de `LynkeusBinding` en lugar de `WidgetsFlutterBinding` y que la cree antes de llamar a `LynkeusAgent.start()`, que entonces la usa; así conserva todo lo anterior:

```dart title="lib/main.dart"
class MyBinding extends LynkeusBinding {
  // las redefiniciones de la app
}

void main() {
  MyBinding();
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

`lynkeus init` no reescribe la clase: cuando `main()` crea un binding propio, deja `start()` después y avisa qué se pierde. Sin ese cambio la app corre igual y se puede manejar, y en FastSim sus plugins siguen recibiendo respuesta, pero las animaciones infinitas no se fijan, los desvanecimientos no se esperan y, en FastSim, la pantalla no tiene área segura; la consola lo avisa. Si el binding se crea después de `start()`, Flutter lo rechaza con su propia comprobación: `Binding is already initialized to LynkeusBinding`.

## Sin pantalla (headless)

`lynkeus_headless` ejecuta el `main()` de tu app dentro de `flutter test`, con diseño real y pintado por software, sin simulador. El agente se conecta como en un dispositivo, así que todos los comandos funcionan igual; qué es un host está en [Headless](/es/platforms/headless/), y aquí solo lo que cambia.

Agrégalo a la app:

```yaml title="pubspec.yaml"
dev_dependencies:
  lynkeus_headless:
    git:
      url: https://github.com/lynkeushq/lynkeus.git
      path: flutter/lynkeus_headless
```

```bash
npx lynkeus headless start    # escribe .lynkeus/host/lynkeus_host_test.dart y lo corre con flutter test
npx lynkeus case run --host   # levanta ese host durante la ejecución y lo detiene al terminar
```

`npx lynkeus init --headless` agrega la dependencia por ti.

El archivo del host vive en `.lynkeus/host/` y no en `test/`: un host nunca termina, y el `flutter test` de la app lo recogería junto con sus pruebas y se quedaría colgado. El CLI busca Flutter en `FLUTTER_ROOT`, después en `flutter` del `PATH` y por último con `mise which flutter`. Si el punto de entrada no es `lib/main.dart`, indícalo con `--entry` o con `entry` en `lynkeus.config.json`.

### Tiempo

La app corre con el tiempo falso de flutter_test, así que el host manda sobre el reloj. Mientras el CLI espera a la app y ella no tiene peticiones en curso, cada vuelta adelanta el reloj un cuadro entero: una cuenta regresiva de tres segundos pasa en unos cientos de milisegundos reales. En el resto del tiempo el reloj sigue el paso del reloj real. `lynkeus os clock` lo maneja a mano (`--advance`, `--settle`, `--now`, `--reset`). El reloj de la app es `package:clock`.

### Pantalla y capturas

Por defecto el host simula un iPhone (402x874 puntos a 3x, con sus márgenes seguros); con `"platform": "android"`, un teléfono Android. Así un mismo host sirve para los dos aspectos. Se cambia en `lynkeus.config.json`:

```json
{ "flutterHost": { "platform": "android", "window": "412x915@2.625", "networkHosts": ["127.0.0.1", "api.local"] } }
```

`platform` es `ios` o `android` y cambia `defaultTargetPlatform`, la pantalla, `device_info_plus` y la posición por defecto (`Platform` sigue siendo el de la máquina: mira [Límites actuales](#límites-actuales)); `window` tiene la forma `AnchoxAlto@escala`, y `networkHosts` es [la valla de red](#la-valla-de-red). Las capturas salen como PNG al tamaño en píxeles del dispositivo, con las fuentes de la app, Roboto y MaterialIcons cargadas, para que el texto sea legible. `case run --host` le pasa al host `--locale`, `--time-zone` y `--epoch`.

### Comandos que agrega el host

`appstate` (`active`, `inactive` o `background`, pasando por los estados intermedios), `deeplink` (un enlace como lo entregaría el sistema), `memory` (el tamaño residente del proceso) y `exit` (termina el host). Un caso puede reservar pasos para el host con `on: headless`. Las vistas nativas (un WebView, un mapa, un video) quedan en blanco en el host sin pantalla, porque no hay nada que las dibuje, y un paso que apunta adentro de una falla con un error que dice cuál es; [FastSim pinta un recuadro](#lynkeus-fastsim) en su lugar.

## Lynkeus FastSim

[Lynkeus FastSim](/es/guides/fastsim/) corre una app de Flutter sin el simulador de Xcode ni un emulador de Android. Carga el kernel de depuración de la propia app en el motor de Flutter, en un Mac con Apple Silicon o en Linux, y maneja él mismo el reloj de la app: una cuenta regresiva de tres segundos o una página que tarda dos en cargar pasan en milisegundos. Lynkeus lo maneja como a un simulador, así que los casos son los mismos. Es parte del plan Team; las keys, el inicio de sesión y los grants funcionan igual que en React Native y están en la [guía de FastSim](/es/guides/fastsim/).

### Instalar, empaquetar y correr

```bash
npx lynkeus fastsim install
```

Si el `pubspec.yaml` de la carpeta toma `flutter` del SDK, instala el build de Flutter; en otra carpeta, agrega `--runtime flutter`. Hay un solo build por máquina y sirve para las dos plataformas, porque el motor de Flutter dibuja iOS y Android con el mismo código: `darwin-arm64-flutter` en un Mac con Apple Silicon, y `linux-arm64-flutter` o `linux-x64-flutter` en Linux. Pesa unos 57 MB en Mac y 64 MB en Linux, casi todo por las fuentes de Android que trae para el aspecto de Android. En Linux usa además zlib y OpenSSL 3 del sistema (en Debian y Ubuntu, el paquete `libssl3`). La primera vez que corres una versión de Flutter, FastSim baja el motor de esa versión del almacenamiento de Flutter (unos 30 MB en Mac y 15 MB en Linux) a `~/.cache/lynkeus/fastsim/flutter-engine/`.

Empaqueta la app, y repítelo cada vez que cambie su código Dart:

```bash
FLUTTER=flutter <carpeta instalada>/bin/fastsim-bundle . <carpeta del bundle> ios -- --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

El bundle es el kernel de depuración de la app, hecho con `flutter build bundle --debug --no-track-widget-creation`. Lo que va después de `--` (`--dart-define`, `--flavor`, `-t lib/main_dev.dart`) se le pasa a ese comando. Con `android` en vez de `ios`, la app ve un teléfono Android. Si tu Flutter no es el `flutter` del `PATH`, dilo en `FLUTTER` (`fvm flutter`, `mise exec flutter@3.50.1 -- flutter`). En un Mac, el bundle de `ios` lleva también los shaders del motor del Simulador de iOS, que se copian de ese Flutter y con los que el host dibuja el aspecto de iOS. Si tu Flutter nunca bajó sus archivos de iOS, no los tiene: `fastsim-bundle` se detiene con código 3 y te pide `flutter precache --ios`, que alcanza con correr una vez.

Después corre los casos, con un host por caso:

```bash
npx lynkeus case run <casos> --ports 8232 --host-command "<carpeta instalada>/bin/fastsim-run <carpeta del bundle> {port}"
```

`--ports` es el puerto al que llama la app de cada host; con `--jobs <n>` hacen falta `n` (`--ports 8232,8233`). La salida de cada host queda en `<carpeta del bundle>/hosts/<puerto>.out` y `.err`; en el `.err` están las líneas de `print` y `debugPrint` de la app y los `[stub]` de los reemplazos de plugins. Con `FASTSIM_HOST_FLAGS` le pasas más opciones al host, como `--appearance dark` o `--locale es-AR`.

Para comparar las pantallas de FastSim con las de un simulador o un emulador, arma la app de referencia con el mismo código y las mismas opciones: `flutter build ios --simulator --debug` o `flutter build apk --debug --no-track-widget-creation`, con los mismos `--dart-define`. Si alguno de los dos no lleva `--no-track-widget-creation`, los kernels ya no son iguales y los píxeles pueden diferir.

### Qué le da el host a la app

- **Un dispositivo.** `ios` es un iPhone 17 (402×874 puntos a 3×, con su área segura y la altura de sus teclados); `android` es un Pixel 9 (411×923 puntos a 2,625×). `Platform.isIOS` o `Platform.isAndroid` responden por ese teléfono, y el código de la app va por esa rama.
- **Su propio reloj.** Lo siguen `DateTime.now()`, `Timer`, `Future.delayed` y `Stopwatch`. Se adelanta mientras el driver espera a la app y no hay ningún pedido en curso a un servidor real; si lo hay, avanza al ritmo del reloj de pared, para que el backend conteste a su tiempo. Un pedido que responde `netmock` no lo frena: su `delayMs` pasa a la velocidad del reloj. `lynkeus os clock` lo mueve a mano.
- **Los demás comandos del host**, como en React Native: capturas, grabación de video, esperar a que la pantalla quede quieta, `lynkeus os appstate` (la app pasa por cada estado del ciclo de vida en el camino, como lo manda un teléfono) y relanzar la app.
- **Sustitutos para los plugins**, los mismos que en el host sin pantalla: [Plugins simulados](#plugins-simulados).

### Qué necesita la app

- **Que el agente arranque primero**, y que el binding propio de la app herede de `LynkeusBinding`: [Preparación](#preparación). Sin eso la app corre, se puede manejar y sus plugins reciben respuesta, pero se queda sin área segura.
- **`lynkeus_plugins`** cuando un plugin no tiene canal al que volver ([Plugins simulados](#plugins-simulados)).

### Límites

- **Las vistas nativas son un recuadro.** Un `UiKitView`, un `AndroidView` o un `PlatformViewLink` (una web view, un mapa, una barra de pestañas nativa) conserva su lugar y su tamaño, y FastSim pinta ahí un rectángulo gris con el tipo de la vista y la leyenda «native view, not drawn». Lo que Flutter dibuja encima, como un botón sobre un mapa, se ve y responde a los toques igual que en el teléfono. Cualquier otro paso que cae dentro de la vista (`press`, `type`, el punto de partida de un `swipe`) falla con el error `this point is inside native view <tipo>, which only exists on a device`, en vez de tocar en el vacío. `screen` informa el rectángulo de cada vista en `platformViews` en todos los entornos, y la comparación de píxeles tapa esos rectángulos de los dos lados, así que el recuadro nunca cuenta como diferencia. Lo que muestra la vista se prueba en un simulador, un emulador o un teléfono, donde los pasos sobre ella sí funcionan.
- **Los píxeles coinciden en un solo host por aspecto.** El aspecto de iOS coincide con el simulador en un Mac (Impeller sobre Metal, con la fuente del sistema del propio simulador si está instalado el runtime de iOS de Xcode, y los shaders que baja `flutter precache --ios`); en Linux todavía no hay sustituto para esa fuente. El aspecto de Android coincide con el emulador en Linux, donde el motor dibuja con OpenGL ES sobre ANGLE y SwiftShader, igual que el emulador. El motor de un Mac solo tiene Metal, y parte de lo que Flutter dibuja en Android (el estiramiento al pasarse del borde de una lista) no existe para Metal: ahí el aspecto de Android sirve para saber si los casos pasan, no cómo salen los píxeles.
- **Texto de otras escrituras con el aspecto de iOS en Linux.** Para el aspecto de Android, el build de Linux trae las fuentes del propio Android, y cuando a la fuente de la app le falta un carácter se usa otra como lo haría Android, en el orden de su `fonts.xml` (chino, japonés, árabe, devanagari, tailandés, emoji). El aspecto de iOS en Linux no tiene esas fuentes, así que esos caracteres salen como cuadrados. Los casos pasan igual, porque leen el árbol de widgets; los píxeles no coinciden.
- **Solo el motor de depuración que publica Flutter.** Nada de builds de profile o release, ni motores propios. Se comprobó con Flutter 3.47.9 y 3.50.1 (y una beta 3.51); en Linux arm64, Flutter publica motores a partir de la 3.38.
- **Un plugin con solo código nativo detrás** que ni `lynkeus_plugins` ni la carga de bibliotecas de escritorio cubren no tiene quién le conteste. `fastsim-bundle` y el host lo nombran al arrancar. isar trae biblioteca de Linux solo para x86-64, así que en un host Linux arm64 Isar no puede abrir su base.

## Qué cambia en un caso

Los casos, los objetivos y los pasos son los de [Escribir casos](/es/guides/writing-cases/) y del [formato de los casos](/es/reference/case-format/). Esto es lo que cambia.

### Cómo se identifican los elementos

Un `testId` es un `ValueKey<String>` (o `Key('...')`) o un `Semantics(identifier: ...)`, y se escribe `#increment`; si la clave está en un envoltorio, nombra al primer elemento listado debajo. El texto y las etiquetas (`Semantics(label:)`, un tooltip, el `semanticLabel` de un ícono) se buscan como en cualquier caso, y un fragmento de un párrafo nunca es un objetivo. Un campo sin etiqueta se encuentra por su texto de ayuda completo (`app.type: { target: "Search...", text: "Paris" }`); si hay una etiqueta o un texto con las mismas palabras, ganan ellos. El tipo de cada elemento sale de lo que los controles le dicen a las tecnologías de asistencia, así que Material, Cupertino y los paquetes `material_ui` y `cupertino_ui` se leen igual.

La pantalla es el árbol de elementos en escena: quedan fuera las rutas tapadas por una opaca, los subárboles `Offstage` y las filas de una lista perezosa más allá de lo visible. `covered` es la prueba de impacto de Flutter en el centro del elemento, e `inert` es estar bajo un `IgnorePointer` o `AbsorbPointer`.

### Esperas y comandos

En un proyecto de Flutter, `app.wait: { text: Siguiente }` espera siempre ese texto, aunque la palabra parezca otra cosa; en un proyecto de React Native el valor de `text` se interpreta como el valor suelto de `app.wait` (una ruta, milisegundos, un `#testId` o un texto). Una ruta de Flutter se escribe `route:/settings` ([más abajo](#rutas)).

Un comando para `app.call` se registra con `LynkeusAgent.register('reset', (_) { … })`, donde React Native tiene `qa.register`. `reset` y `busy` significan lo mismo que en la [API del agente](/es/reference/agent-api/).

### Qué muestra el frame de un paso

El frame de un paso sale del código de la app, de los pasos del caso y de los datos, y no de cuánto tardó el dispositivo: dos corridas en el simulador y una en FastSim muestran lo mismo. Por eso `idle` (lo que espera `--settle`) no da la app por quieta mientras haya algo en marcha que termina solo: un temporizador que la app puso para un plazo no mayor que la espera (una página que carga a los 2 segundos, un aviso que se va a los 2 segundos, la pausa antes de buscar lo que se escribe) o uno puesto al arrancar, antes de la primera acción del driver (el de una pantalla de bienvenida); una animación que dispara alguno de esos trabajos (un aviso que se desvanece); una imagen que todavía carga; o una petición en curso. No cuentan los temporizadores periódicos, un sondeo en bucle ni los más largos que la espera. [El protocolo](/es/reference/protocol/) tiene la regla completa.

Una animación que no termina nunca no tiene final que esperar. Si al contestar `idle` hay en pantalla un spinner, un shimmer o un cursor que parpadea, el agente dibuja un frame más en el que cada uno está en el instante en que empezó, con el cursor visible, y no dibuja nada más hasta el siguiente pedido del driver que no sea una captura de pantalla (`screenshot`, `still`); una lectura como `screen` también lo libera, para que una espera que la consulta vea avanzar a la app. Como mucho dura 3 segundos. Todo esto necesita el binding del agente ([Preparación](#preparación)).

En una corrida con frames, los `app.see` que siguen a un paso se ejecutan antes de tomar el frame de ese paso, así que un aviso que el paso muestra todavía está ahí para verlo, y después comparten el frame de ese paso: no tienen captura propia, y el frame es el de la pantalla una vez que el aviso se fue.

### Rutas

Los nombres de ruta de Flutter suelen empezar con `/`, y una palabra en minúscula sola se lee como texto, así que en un caso hay que decir que es una ruta: `app.wait: "route:/settings"`.

`route`, `path`, los eventos `navigation` y `navigate` necesitan saber cuáles son las rutas de la app.

Si la app usa el router de Flutter (`MaterialApp.router`, que es lo que usan go_router, auto_route o un delegado propio), no hay nada que conectar: el agente lee el `Router` raíz de la app. Con go_router, la ruta es la de su estado: el `name` o, si no tiene, el `fullPath` (el patrón `/habits/:id`, no la dirección `/habits/42`), que son los nombres que le da el grafo de rutas. Con otro router, es el camino de la ubicación actual. `navigate` manda el camino igual que el motor entrega un enlace profundo, así que las redirecciones del router se aplican como con cualquier enlace.

Para ir a una ruta que solo se conoce por su nombre hace falta el `goNamed` del propio router. En ese caso, dale las rutas al agente en el lugar donde se crea el router; sirve también cuando el router se arma dentro de un State o de un provider:

```dart
final appRouterProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(routes: [...]);
  LynkeusAgent.routes = LynkeusRoutes(
    current: () => router.state.name ?? router.state.fullPath,
    changes: router.routerDelegate,
    navigate: (route, params) => route.startsWith('/')
        ? router.go(route)
        : router.goNamed(route, pathParameters: {for (final e in (params ?? const {}).entries) e.key: '${e.value}'}),
  );
  return router;
});
```

`current` devuelve la ruta en foco, `changes` avisa cuando puede haber cambiado y `navigate` es lo que llama `lynkeus nav`. Si el router ya existe antes de `runApp`, `LynkeusAgent.start(routes: ...)` recibe lo mismo.

Con un `Navigator` y rutas con nombre, pasa el observador del agente en el navegador raíz:

```dart
MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver], routes: {...});
```

En los dos casos, una página que se abre sin nombre, como `Navigator.push(MaterialPageRoute(builder: (_) => const Items()))`, se informa con el nombre de la clase del widget que muestra (`Items`), el mismo que usa `lynkeus map`. No se puede abrir por nombre, y deja de ser la ruta en cuanto se cierra, aunque siga deslizándose fuera de la pantalla. Lo que no es una página (un diálogo, una hoja inferior) no se informa y la ruta sigue siendo la de abajo. Si `navigate` pide una ruta que ya está en la pila, el agente vuelve a ella en lugar de apilar otra copia.

### El grafo de rutas

`map`, `case impact`, `case coverage`, `smoke` y `crawl` funcionan en una app de Flutter con las mismas opciones y la misma salida que en React Native. `lynkeus map build` saca las rutas del código Dart de `lib/` y no hace falta tener el SDK de Dart para eso. Lo que entiende:

- **go_router**: cada `GoRoute`, también los anidados en `routes:` y los que cuelgan de `ShellRoute` o de las ramas de un `StatefulShellRoute`, y las rutas con `@TypedGoRoute`. La ruta se llama como su `name:` o, si no lo tiene, como su camino completo. Cuando el camino o el nombre salen de una función auxiliar (el campo de un enum, un `switch` sobre él, una constante estática, un texto con interpolación), se leen en cada lugar donde se llama a esa función. Una ruta que solo redirige no cuenta como pantalla.
- **`Navigator` con rutas con nombre**: `routes:` y `home:` de `MaterialApp`, `CupertinoApp` o `WidgetsApp`, y `onGenerateRoute` cuando hace un `switch` o un `if` sobre el nombre de la ruta.
- **Un router propio de la app** (fluro, por ejemplo): toda llamada que registra un camino junto con un builder, como `router.define('/goods', handler: Handler(handlerFunc: (_, __) => const GoodsPage()))`.
- **Navegaciones**: `context.go`, `push`, `goNamed`, `pushNamed`, `Navigator.pushNamed` y parecidas. Una dirección como `/habits/42` se asocia a la ruta `/habits/:id`. `Navigator.push(MaterialPageRoute(builder: (_) => X()))` lleva a la pantalla `X`. El control que dispara la navegación es el widget cuyo callback `on…:` contiene la llamada (o el método que ese callback nombra), identificado por su `key: ValueKey('…')`.

Cada pantalla apunta al archivo del widget que construye su builder, y `case impact` sigue los imports desde ahí igual que en React Native; si se importa un barrel, cuenta solo los archivos que declaran lo que se usa. Lo que no se puede leer aparece en la salida de `map build` con su archivo y su línea, y queda guardado en `warnings` dentro del grafo: ninguna ruta desaparece sin aviso. `smoke` solo abre las rutas que no piden nada, así que deja fuera las que tienen parámetros en el camino, las que convierten `state.extra` o los `arguments` de la ruta a un tipo que no admite null, y las páginas sin nombre. Tanto `smoke` como `crawl` abren las rutas con el `navigate` del agente, por eso la app tiene que tener un `Router`, el observador o `LynkeusRoutes`. Si una ruta redirige (por ejemplo, a una bienvenida que todavía no se vio), se informa dónde terminó.

## Registro de red

Las peticiones que pasan por el `HttpClient` de `dart:io` se registran, se simulan y se retienen con los mismos comandos que en React Native ([Fixtures](/es/guides/fixtures/), `lynkeus requests`, `lynkeus mock`). Lo usan `package:http` (con `IOClient`) y dio con su adaptador por defecto; un cliente con red propia (un canal de plataforma, un webview) no se ve.

### La valla de red

Un host (el headless y el host de Flutter de [Lynkeus FastSim](/es/guides/fastsim/#apps-de-flutter)) mantiene a la app fuera de internet: solo llega a loopback y a `10.0.2.2`. Una petición a cualquier otro host falla como error de socket, y el mensaje dice qué hacer:

```text
lynkeus: images.example.com is outside networkHosts (127.0.0.1, localhost, ::1, 10.0.2.2): mock the request (app.mock in the case, or lynkeus mock), or allow the host with "flutterHost": { "networkHosts": [...] } in lynkeus.config.json
```

Hay dos salidas: simular la petición, o permitir el host en `lynkeus.config.json` (`"flutterHost": { "networkHosts": ["127.0.0.1", "api.local"] }`; la lista reemplaza a la de por defecto, así que conserva los hosts locales que uses). Una petición bloqueada igual aparece en `lynkeus requests`, y una que responde un mock no llega a la valla. En un simulador, un emulador o un teléfono no hay valla.

### Reproducir lo que la app pidió a internet

Una imagen de red que viene de un host bloqueado se ve como su marcador de posición, mientras que en un dispositivo se ve la imagen. Graba una vez lo que pide la app, en una corrida con red real, y los hosts responden desde la grabación:

```bash
npx lynkeus case run --device <simulador> --net-cache qa/net --net-record
npx lynkeus case run --host --net-cache qa/net
```

La carpeta tiene el formato de `--net_cache` del host de React Native: un archivo por URL con el cuerpo tal como lo leyó la app, y al lado un `.json` con la URL, el estado y algunas cabeceras. Con `--host-command` (FastSim) se reproduce igual. En `lynkeus requests` una respuesta reproducida aparece como `replayed`, y un mock sigue respondiendo primero.

Se graban los GET y los HEAD exitosos (2xx; los HEAD son los que usan las comprobaciones de conexión) a hosts que no son locales, y ninguno que haya enviado una cabecera `Authorization` o cookies, salvo que agregues `--net-record-credentials`. No se graban otros métodos, WebSockets, cuerpos en streaming ni lo que pida un cliente con red propia. Un host que arranca la propia corrida graba desde que se lanza la app, así que también queda lo que la app pide al abrir. En un dispositivo, el build graba desde el lanzamiento si se compila con `--dart-define=LYNKEUS_NET_RECORD=1`; si no, desde que se conecta el driver. La respuesta reproducida trae la cabecera `Date` grabada: una app que corrige su reloj con el del servidor toma entonces como hora actual la de la grabación. El agente retiene como mucho unos 64 MB de grabaciones a la vez, descartando las más antiguas, y el CLI las retira después de cada caso. `--net-record` exige `--net-cache`, y solo el agente de Flutter sabe grabar; la app de React Native tiene `--net_record`.

## Plugins simulados

En un host no hay parte nativa: flutter_test no responde los canales de plataforma, y FastSim se salta el registro de plugins que genera la app. Por eso el agente responde los canales él mismo, con sustitutos en memoria que viven en `lynkeus_agent` (`package:lynkeus_agent/hosts.dart`). El host sin pantalla y FastSim contestan igual, y los mismos comandos `lynkeus call` los manejan. En un simulador, un emulador o un teléfono corre el plugin de verdad.

| Plugin | Sustituto | Se maneja con |
|---|---|---|
| `shared_preferences`, `flutter_secure_storage` | un mapa clave-valor | la app |
| `path_provider` | carpetas bajo una carpeta temporal por ejecución | |
| `sqflite` | el SQLite del sistema, con las bases en una carpeta de la ejecución (desde la 2.4 hace falta `lynkeus_plugins`, ver abajo) | la app |
| `device_info_plus`, `package_info_plus` | un iPhone 17 con iOS 26.5, o un emulador Android 15, según lo que simule el host; datos fijos del paquete (`io.lynkeus.host`, 1.0.0) | |
| `url_launcher` | dice que puede abrir la URL, no abre nada y la anota | `lynkeus call launched` (`{"clear": true}` la vacía) |
| `local_auth` | Face ID en iOS, una huella en Android; los avisos tienen éxito | `lynkeus os biometrics --available none\|face\|fingerprint --next success\|fail\|cancel\|<código de error>` |
| `permission_handler` | todos los permisos concedidos | `lynkeus call permissions '{"7": 4}'` (número de permiso a estado: 0 denegado, 1 concedido, 2 restringido, 3 limitado, 4 denegado para siempre) |
| `connectivity_plus` | Wi-Fi; apagada equivale al modo avión: falla toda petición de la app, incluso las que se reproducirían de una grabación, y solo responde `netmock` | `lynkeus os network off` (o `lynkeus call network '{"state": "off"}'`) |
| `flutter_local_notifications` | todos los permisos concedidos; anota lo que la app programa o muestra, sin mostrar nada | `lynkeus call notifications` (`{"clear": true}` lo vacía) |
| `flutter_timezone` | la zona de `--time-zone` o, si no hay, la de la máquina | |
| `share_plus` | la hoja de compartir responde que se compartió y anota qué | `lynkeus call shared` (`{"clear": true}`) |
| `file_selector` | un selector devuelve lo que se puso en cola con `files`, o se cancela si no hay nada; guardar responde una ruta en una carpeta de la ejecución | `lynkeus call files '{"open": "/ruta/backup.json"}'` |
| `open_file`, `app_settings` | no abren nada; quedan anotados junto a las URL | `lynkeus call launched` |
| `dynamic_color` | sin colores del fondo de pantalla | |
| `geolocator` | la posición con la que arranca el simulador de iOS o el emulador de Android (Apple Park o el Googleplex), con permiso concedido y el servicio de ubicación encendido; sus pantallas de ajustes quedan anotadas en `launched` | `lynkeus call location '{"permission": "denied", "request": "whileInUse", "latitude": 52.52, "longitude": 13.4, "service": false}'` |
| `geocoding` (hasta la 4.x) | el lugar conocido más cercano: las dos posiciones por defecto y los que agregue un caso con `place` en `location` | `lynkeus call location` |
| `home_widget` | guarda los datos de los widgets y las actualizaciones pedidas | `lynkeus call widgets` (`{"clear": true}` vacía las actualizaciones) |
| `workmanager` | las tareas quedan programadas y nunca corren | `lynkeus call tasks` |
| `flutter_displaymode` | un único modo de 120 Hz | |
| `restart_app` | cuenta el reinicio y responde que se hizo; la app sigue como estaba | `lynkeus call tasks` (`restarts`) |

Un caso que usa estos comandos pone esos pasos dentro de `on: has:notifications` (o `has:shared`, `has:files`, `has:launched`), así solo corren donde existen: en un simulador, la hoja de compartir y el selector de archivos son del sistema y el agente no llega a ellos.

Cualquier otro canal responde null, para que el `await` de la app no se cuelgue, y deja una línea `[stub] <canal>` en el registro del host. Con `LYNKEUS_CHANNELS=trace` se imprime cada llamada. Los plugins sin canal de método por defecto piden algo más:

- **`flutter_local_notifications` y `workmanager`** reciben su implementación solo del registro de plugins. El archivo que escribe `headless start`, y el kernel que arma `fastsim-bundle`, fijan su clase de iOS o de Android según la plataforma que simula el host cuando `pubspec.lock` los incluye. El proyecto no tiene que hacer nada.
- **`geocoding` 5** no tiene canal y sus clases de plataforma son proxies de Pigeon: en un host falla como un geocodificador que no encuentra nada, y entra el respaldo que tenga la app.
- **sqflite 2.4 o posterior** (también cuando llega a través de `cached_network_image`) y **la API asíncrona de shared_preferences** fallan en un host. El paquete opcional `lynkeus_plugins` los resuelve. Agrégalo junto a `lynkeus_agent`, como dependencia normal, y llámalo en la línea siguiente al arranque del agente:

```dart
LynkeusAgent.start();
LynkeusPlugins.ensureInitialized();
```

En un simulador, un emulador o un teléfono no hace nada. `lynkeus init` solo lo agrega cuando tu `pubspec.lock` muestra uno de esos plugins, y `lynkeus status` lo comprueba.

- **Un plugin que llama a su biblioteca nativa con `dart:ffi`**, como una base Isar a través de `isar_community_flutter_libs`, no tiene un canal que se pueda sustituir. Pero muchos traen esa biblioteca ya compilada para escritorio (`macos/libisar.dylib`, `linux/libisar.so`), y un host corre en un escritorio. Antes de arrancar la app, carga cada biblioteca que un plugin tiene en su carpeta `macos/` (o `linux/`), según la lista de `.flutter-plugins-dependencies`, y lo dice en el log (`native libraries: libisar.dylib`). Cuando el plugin la busca, la encuentra ya cargada, y la base funciona de verdad, con sus archivos en la carpeta temporal de la ejecución. En FastSim, `fastsim-bundle` copia al bundle las bibliotecas de macOS y de Linux. Un plugin FFI sin versión de escritorio falla como fallaría en un escritorio que no lo soporta; si solo trae binarios de iOS o de Android, `fastsim-bundle` y el host lo nombran al arrancar y dicen qué hacer.

Un proyecto agrega los suyos en `test/lynkeus_host.dart` (no termina en `_test.dart`, para que sus pruebas unitarias lo ignoren), que `lynkeus headless start` pasa al host si existe:

```dart title="test/lynkeus_host.dart"
import 'package:lynkeus_headless/lynkeus_headless.dart';

void configureHost(HostConfig host) {
  host.standIns.add('com.example/wallet', (method, args) => method == 'balance' ? 1250 : null);
  host.plugins.preferences['flutter.onboarded'] = true;
}
```

## Límites actuales

- Un build de release no lleva el agente: solo funciona en builds de depuración.
- El host sin pantalla ve el `Platform` de la máquina y el `DateTime.now()` real. El reloj de la app es `package:clock`, que el host falsea. En una Mac, la app que pregunta por `Platform.isMacOS` sigue su camino de escritorio aunque `defaultTargetPlatform` y la pantalla sean las del teléfono: `device_info_plus` también responde los datos de ese camino, y los canales que solo existen en escritorio reciben null. El código que depende de `Platform.isAndroid` o `Platform.isIOS` no corre nunca sin pantalla, simule el host el aspecto que simule. Si una app programa algo solo en esa rama (los widgets de la pantalla de inicio, un modo de pantalla), sin pantalla eso no ocurre.
- `--seed` no se aplica: el `Random()` de Dart no se puede sembrar desde afuera.
- Los reinicios de `--host-heap` se omiten en este host: no hay cifras de heap.
- El grafo de rutas se arma leyendo la sintaxis, sin tipos. Una tabla de rutas que se arma en tiempo de ejecución, un builder que pasa por muchas funciones auxiliares o un widget envuelto en una clase de página propia del router pueden quedar sin resolver, y `map build` lo avisa. A una página sin nombre solo se llega tocando lo que la abre, así que `crawl` no puede volver a ella directamente; tampoco se sigue una función auxiliar que recibe la página como closure (`NavigationHelper.open(context, () => PlaceInfo())`).
- `crawl` distingue las pantallas por su ruta. Si las pestañas solo cambian el cuerpo (una `NavigationBar` sobre un `TabBarView`), todas son la ruta `/`: sus controles se tocan una vez desde donde esté el recorrido, sin explorarlas como pantallas aparte.
- Lynkeus FastSim tiene sus propios límites, en [su sección](#lynkeus-fastsim).
- Dos apps que llaman al mismo puerto entran en conflicto: cierra la otra o usa otro puerto con `LYNKEUS_PORT`.

## Probada con apps reales

Además de la app de ejemplo y los casos de conformidad del runtime, Lynkeus para Flutter se prueba con apps de código abierto de distinto tipo: una base de datos sobre `dart:ffi`, sqflite, notificaciones locales, tareas en segundo plano, mapas, red reproducida y una app con su propio binding. Ni esas apps ni sus casos están en el repositorio. Pasan en el host sin pantalla y, en una Mac, en FastSim con los dos aspectos. Lo que encontraron esas corridas está en los límites de más arriba.

## Software de terceros y marcas

Los paquetes de Dart tienen licencia MIT, y sus dependencias usan licencias BSD o Apache. Flutter y Dart son marcas registradas de Google LLC. Lynkeus no está afiliado a Google ni cuenta con su respaldo.
