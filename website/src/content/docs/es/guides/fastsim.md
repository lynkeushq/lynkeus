---
title: Correr casos en fastsim
description: Corre tus casos en fastsim, un simulador que dibuja la app en un Mac o en Linux sin el simulador de Xcode ni un emulador, e instálalo para la plataforma que pruebas.
---

fastsim ejecuta tu app de React Native sin el simulador de Xcode y sin emulador de Android. Carga el JavaScript de la app, calcula el layout con el propio renderer de React Native y la dibuja, mucho más rápido que un simulador. lynkeus lo maneja igual que a un simulador, así que los mismos casos corren en ambos.

## Cuándo usarlo

Úsalo cuando una suite tarda demasiado en un simulador, cuando quieres correr muchos casos a la vez o cuando la máquina no tiene simulador, como un servidor Linux o un runner de CI.

Está disponible para las organizaciones cuyo plan lo incluye. Necesitas `LYNKEUS_CLOUD_KEY`, la API key de tu organización en [lynkeus.io](https://lynkeus.io).

## Instalarlo

Ejecuta la instalación una vez por cada plataforma que pruebes:

```bash
lynkeus fastsim install --platform ios
lynkeus fastsim install --platform android
```

El comando baja el build que corresponde a la máquina donde lo ejecutas, verifica su SHA-256 y lo descomprime en `~/.cache/lynkeus/fastsim/<versión>/<variante>/`. Con `LYNKEUS_FASTSIM_DIR` cambias esa carpeta.

| Máquina | iOS | Android |
|---|---|---|
| Mac con Apple Silicon | `darwin-arm64-ios` (unos 8 MB) | `darwin-arm64-android` (unos 65 MB) |
| Linux x64 o arm64 | `linux-<arch>-ios` | `linux-<arch>-android` |
| Windows | Ejecuta lynkeus dentro de WSL2: ahí instala el build de Linux | Igual |
| Mac con Intel | No está soportado | No está soportado |

Con `--variant <nombre>` instalas un build por su nombre en lugar del de esta máquina. Todos los flags están en la [referencia de comandos](/es/reference/cli/#lynkeus-fastsim-install).

## Empaquetar la app y correr casos

La app necesita sus dependencias instaladas y el agente de lynkeus montado, igual que para un simulador. En la carpeta que mostró la instalación hay un `README.md` con los detalles. Hacen falta dos comandos.

Empaqueta la app, y vuelve a hacerlo cada vez que cambie su JavaScript:

```bash
<carpeta instalada>/bin/fastsim-bundle <carpeta de la app> <carpeta del bundle> ios
```

Para un bundle de Android, escribe `android` en lugar de `ios`. Ejecútalo en una terminal que tenga el entorno de tu build de desarrollo, como las variables `EXPO_PUBLIC_` y la dirección del backend: quedan escritas dentro del bundle.

Después corre los casos, con un host por caso:

```bash
npx lynkeus case run <casos> --host-command "<carpeta instalada>/bin/fastsim-run <carpeta del bundle> {port}"
```

lynkeus levanta un host en un puerto libre para cada caso, espera a que la app se conecte y lo detiene cuando el caso termina. Con `--jobs <n>` corren `n` casos a la vez, cada uno en su propio host. La salida de cada host queda en `<carpeta del bundle>/hosts/<puerto>.out` y `.err`; los errores de JavaScript y las líneas de la consola están en el `.err`.

## Desde un agente de IA por MCP

El [servidor MCP](/es/guides/ai-agents/) ofrece los mismos pasos como herramientas. El agente llama a `fastsim_install` con `platform` en `ios` o `android`, con `LYNKEUS_CLOUD_KEY` en el entorno donde arrancó el servidor. Luego lee el `README.md` de la carpeta que devuelve la herramienta, ejecuta `bin/fastsim-bundle` para empaquetar la app y llama a `case_run` con `host_command` igual a `<carpeta instalada>/bin/fastsim-run <carpeta del bundle> {port}`. Para correr casos en paralelo, agrega `jobs`.

## Qué reemplaza y dónde llega

fastsim no tiene el sistema operativo de un teléfono debajo, así que reemplaza la parte nativa:

- Las librerías que son solo JavaScript corren tal cual.
- Los componentes y APIs centrales de React Native, react-native-reanimated, react-native-svg, lottie-react-native, rive-react-native, react-native-screens y los módulos comunes de Expo corren sobre la parte nativa propia de fastsim.
- Un módulo nativo para el que fastsim no tiene reemplazo se ve como ausente, igual que en un teléfono que no lo tiene. Si es el módulo de un paquete de Expo, el archivo `.err` del host lo nombra con una línea `[fastsim] <nombre> has no stand-in yet`.
- Las vistas nativas que fastsim no dibuja, como mapas, web views y vistas previas de cámara, ocupan su lugar y su tamaño pero no muestran nada.

Cuánto se parece a un dispositivo real depende de la plataforma:

- **Android** lo dibuja Skia, la misma librería con la que dibuja Android.
- **iOS** coincide con el simulador píxel por píxel solo en un Mac, donde lo dibujan los frameworks y las fuentes de Apple. En Linux se dibuja con otra fuente, así que queda cerca pero no idéntico.

Instala y compara por plataforma: un build de iOS no dice nada sobre Android.

## Problemas frecuentes

**`set LYNKEUS_CLOUD_KEY to your organization's API key`.** Código de salida 2. El comando no encontró una clave. Expórtala, o ponla en `[env]` de `mise.local.toml`, y vuelve a ejecutarlo.

**El servicio responde 403.** El plan de tu organización no incluye fastsim. Consulta a quien administra la organización o escribe al soporte de lynkeus.io.

**`fastsim runs on Windows inside WSL2`.** Abre una terminal de WSL2, instala lynkeus ahí y ejecuta la instalación de nuevo: instala el build de Linux.

**`fastsim runs on Apple Silicon Macs only`.** Los Mac con Intel no tienen build. Usa un simulador, o corre fastsim en una máquina Linux.

**`no fastsim release ... for <variant>`.** El servicio no tiene ese build para tu organización. El mensaje lista lo que sí puedes instalar.
