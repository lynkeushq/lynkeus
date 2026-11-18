---
title: Correr casos en Lynkeus FastSim
description: Corre tus casos en Lynkeus FastSim, un simulador que dibuja la app en un Mac o en Linux sin el simulador de Xcode ni un emulador, e instálalo para la plataforma que pruebas.
---

Lynkeus FastSim ejecuta tu app de React Native sin el simulador de Xcode y sin emulador de Android. Carga el JavaScript de la app, calcula el layout con el propio renderer de React Native y la dibuja, mucho más rápido que un simulador. Lynkeus lo maneja igual que a un simulador, así que los mismos casos corren en ambos.

## Cuándo usarlo

Úsalo cuando una suite tarda demasiado en un simulador, cuando quieres correr muchos casos a la vez o cuando la máquina no tiene simulador, como un servidor Linux o un runner de CI.

Es opcional y de pago: Lynkeus FastSim forma parte del plan Team ([planes](https://lynkeus.io/pricing)). El host headless y el simulador o emulador siguen siendo gratis y cubren los mismos casos. Lo tienen las organizaciones cuyo plan lo incluye, y quien es owner de la organización decide quién lo baja. Necesitas `LYNKEUS_CLOUD_KEY` con una API key que un owner creó marcando **May download Lynkeus FastSim**, en la página de API keys de [lynkeus.io](https://lynkeus.io). Una key pensada solo para reportes no sirve para bajarlo, así que conviene que el CI tenga la suya. En la página de Members los owners ven cada descarga, quién la hizo y cuándo, y desde ahí dan lugares a los miembros.

Si eres miembro y tienes un lugar, no necesitas una key: ejecuta `lynkeus fastsim install` en una terminal y, si no encuentra una key ni una sesión guardada, abre el navegador por sí solo (es el mismo paso que `lynkeus login`) y sigue con la instalación. También puedes iniciar sesión antes:

```bash
lynkeus login
```

Se abre lynkeus.io en tu navegador, donde entras y eliges la organización. La sesión queda guardada en `~/.config/lynkeus/credentials.json`, con permisos solo para ti, y `lynkeus fastsim install` la usa cuando no hay `LYNKEUS_CLOUD_KEY`. Se renueva sola cuando vence, y `lynkeus logout` la borra. En una máquina sin navegador, `lynkeus login --no-browser` imprime la dirección para que la abras en otro equipo. El navegador solo se abre si estás en una terminal (stdin y stderr son terminales y `CI` no está definida); un script, el CI o el servidor MCP nunca esperan un navegador: necesitan una key, y sin ella el comando termina con código 2. Si la sesión guardada terminó o se revocó, la instalación lo dice y te hace iniciar sesión una vez más. Con `--no-browser` en `fastsim install` se imprime la dirección en vez de abrirla.

## Instalarlo

Ejecuta la instalación una vez por cada plataforma que pruebes:

```bash
lynkeus fastsim install --platform ios
lynkeus fastsim install --platform android
```

El comando baja el build que corresponde a la máquina donde lo ejecutas, verifica su SHA-256 y su firma y lo descomprime en `~/.cache/lynkeus/fastsim/<versión>/<variante>/`. Con `LYNKEUS_FASTSIM_DIR` cambias esa carpeta.

| Máquina | iOS | Android |
|---|---|---|
| Mac con Apple Silicon | `darwin-arm64-ios` (unos 8 MB) | `darwin-arm64-android` (unos 65 MB) |
| Linux x64 o arm64 | `linux-<arch>-ios` | `linux-<arch>-android` |
| Windows | Ejecuta Lynkeus dentro de WSL2: ahí instala el build de Linux | Igual |
| Mac con Intel | No está soportado | No está soportado |

Con `--variant <nombre>` instalas un build por su nombre en lugar del de esta máquina. Todos los flags están en la [referencia de comandos](/es/reference/cli/#lynkeus-fastsim-install).

## Paquetes firmados y grants

Cada paquete de FastSim va firmado por Lynkeus, y `lynkeus fastsim install` verifica la firma antes de descomprimir nada. Un paquete sin firma, o modificado después de firmarse, se rechaza y no se escribe nada.

Además, cada host de FastSim necesita un permiso reciente (grant) de lynkeus.io para arrancar. `lynkeus case run` (y `case_run` por MCP) lo pide antes de arrancar los hosts, con la misma key o sesión que la instalación, y se lo pasa a cada uno; así lynkeus no tiene que estar instalado en el proyecto ni global: basta `npx -y lynkeus mcp`. El grant se guarda una hora: una suite con muchos casos consulta al servicio una vez por hora, no una por caso. Si no se puede conseguir (sin key ni sesión, sin FastSim en el plan, sin conexión), la ejecución se detiene con el motivo en vez de arrancar hosts. Si ejecutas `bin/fastsim-run` a mano, recurre a `npx --no-install lynkeus fastsim grant`, que sí necesita lynkeus instalado; también puedes definir `FASTSIM_GRANT` tú mismo. Por eso FastSim tiene que poder llegar a lynkeus.io cuando arranca un host, incluso en una máquina donde el paquete ya está instalado. Puedes ejecutar tú mismo `lynkeus fastsim grant --platform ios` para comprobar que funciona.

El plan Team incluye FastSim en 5 máquinas de desarrollo y 4 hosts de CI en paralelo; cada extra cuesta $15 y $20 al mes. La CLI envía un id aleatorio por instalación (guardado en `~/.config/lynkeus/machine-id`) para que lynkeus.io pueda contarlas: una máquina es una instalación que pidió un grant o una descarga en los últimos 30 días, y un host de CI es una a la que se le dio un grant en la última hora. Una máquina que ya se contó sigue funcionando. Pasado el límite, por ahora recibes un aviso y más adelante un rechazo que dice dónde agregar más ([planes](https://lynkeus.io/pricing), o Members). Da a cada runner de CI su propia carpeta home, o el mismo id contará como un solo host.

La app necesita sus dependencias instaladas y el agente de Lynkeus montado, igual que para un simulador. En la carpeta que mostró la instalación hay un `README.md` con los detalles. Hacen falta dos comandos.

Empaqueta la app, y vuelve a hacerlo cada vez que cambie su JavaScript:

```bash
<carpeta instalada>/bin/fastsim-bundle <carpeta de la app> <carpeta del bundle> ios
```

Para un bundle de Android, escribe `android` en lugar de `ios`. Ejecútalo en una terminal que tenga el entorno de tu build de desarrollo, como las variables `EXPO_PUBLIC_` y la dirección del backend: quedan escritas dentro del bundle.

Después corre los casos, con un host por caso:

```bash
npx lynkeus case run <casos> --host-command "<carpeta instalada>/bin/fastsim-run <carpeta del bundle> {port}"
```

Lynkeus levanta un host en un puerto libre para cada caso, espera a que la app se conecte y lo detiene cuando el caso termina. Con `--jobs <n>` corren `n` casos a la vez, cada uno en su propio host. La salida de cada host queda en `<carpeta del bundle>/hosts/<puerto>.out` y `.err`; los errores de JavaScript y las líneas de la consola están en el `.err`.

## Desde un agente de IA por MCP

El [servidor MCP](/es/guides/ai-agents/) ofrece los mismos pasos como herramientas. El agente llama a `fastsim_install` con `platform` en `ios` o `android`, con `LYNKEUS_CLOUD_KEY` en el entorno donde arrancó el servidor, o con la sesión que guardaste al ejecutar `lynkeus login` en una terminal. El servidor nunca abre un navegador: si no hay key ni sesión guardada, ejecuta tú `lynkeus fastsim install` o `lynkeus login` en una terminal. Luego lee el `README.md` de la carpeta que devuelve la herramienta, ejecuta `bin/fastsim-bundle` para empaquetar la app y llama a `case_run` con `host_command` igual a `<carpeta instalada>/bin/fastsim-run <carpeta del bundle> {port}`. Para correr casos en paralelo, agrega `jobs`.

## Qué reemplaza y dónde llega

FastSim no tiene el sistema operativo de un teléfono debajo, así que reemplaza la parte nativa:

- Las librerías que son solo JavaScript corren tal cual.
- Los componentes y APIs centrales de React Native, react-native-reanimated, react-native-svg, lottie-react-native, rive-react-native, react-native-screens y los módulos comunes de Expo corren sobre la parte nativa propia de FastSim.
- Un módulo nativo para el que FastSim no tiene reemplazo se ve como ausente, igual que en un teléfono que no lo tiene. Si es el módulo de un paquete de Expo, el archivo `.err` del host lo nombra con una línea `[fastsim] <nombre> has no stand-in yet`.
- Las vistas nativas que FastSim no dibuja, como mapas, web views y vistas previas de cámara, ocupan su lugar y su tamaño pero no muestran nada.

Cuánto se parece a un dispositivo real depende de la plataforma:

- **Android** lo dibuja Skia, la misma librería con la que dibuja Android.
- **iOS** coincide con el simulador píxel por píxel solo en un Mac, donde lo dibujan los frameworks y las fuentes de Apple. En Linux se dibuja con otra fuente, así que queda cerca pero no idéntico.

Instala y compara por plataforma: un build de iOS no dice nada sobre Android.

## Problemas frecuentes

**`set LYNKEUS_CLOUD_KEY to an API key an owner of your organization made with "May download Lynkeus FastSim"`.** Código de salida 2. El comando no encontró ni una clave ni una sesión. Exporta una clave, o ponla en `[env]` de `mise.local.toml`, o, si eres miembro con un lugar, vuelve a ejecutarlo desde una terminal: te hace iniciar sesión. Este código es lo que reciben un script, el CI o MCP cuando no hay con qué iniciar sesión.

**`this key may not download Lynkeus FastSim`.** La key se creó sin **May download Lynkeus FastSim**. Pídele a un owner de la organización una key creada con esa opción.

**`you have no Lynkeus FastSim seat`.** Entraste como miembro y no tienes un lugar. Los owners los asignan en la página de Members.

**`this sign-in may not download Lynkeus FastSim: sign in again with lynkeus login`** (o **`the sign-in was refused`**). El servicio no acepta la sesión guardada, por ejemplo porque venció o se creó antes de que tuvieras tu lugar. Ejecuta `lynkeus login` de nuevo.

**`this organization has no Lynkeus FastSim entitlement`** (o **has expired**). El plan de tu organización no incluye FastSim. Consulta a quien administra la organización o escribe al soporte de lynkeus.io.

**`Lynkeus FastSim runs on Windows inside WSL2`.** Abre una terminal de WSL2, instala Lynkeus ahí y ejecuta la instalación de nuevo: instala el build de Linux.

**`Lynkeus FastSim runs on Apple Silicon Macs only`.** Los Mac con Intel no tienen build. Usa un simulador, o corre FastSim en una máquina Linux.

**`no Lynkeus FastSim release ... for <variant>`.** El servicio no tiene ese build para tu organización. El mensaje lista lo que sí puedes instalar.
