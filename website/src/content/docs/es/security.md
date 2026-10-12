---
title: Seguridad
description: Qué expone el agente y a quién, por qué solo existe en builds de depuración, cómo funciona el token y qué guarda el servicio de reportes.
---

lynkeus pone dentro de tu app un componente que acepta órdenes de afuera: leer la pantalla, pulsar, escribir, navegar. Antes de adoptarlo es razonable preguntar quién puede dar esas órdenes, qué puede ver, y si algo de eso llega a los usuarios. Esta página responde esas preguntas.

Está escrita para quien decide si lo adopta y para quien lo instala. Tiene tres partes: el agente dentro de la app, el host sin pantalla, y el servicio de reportes, que es la única parte de lynkeus que saca datos de tu máquina.

## El resumen

- El agente solo existe en builds de depuración. En iOS, el código nativo que sintetiza toques no se compila en un build de producción. En Android, se niega a correr si la app no es depurable.
- Dentro de la app no escucha nada. La app se conecta hacia afuera, a tu propia máquina.
- Con un token, el agente solo atiende al driver que conoce el secreto.
- El CLI, el agente y el host sin pantalla no envían nada a ningún servicio. Lo único que sale de tu máquina es lo que subes con `--push` o con `lynkeus report push`, y eso lo decides en cada ejecución.

## El agente dentro de la app

### Qué puede hacer quien lo maneja

Quien esté conectado al agente como driver puede hacer, en esencia, lo mismo que una persona con el teléfono en la mano, y además leer algunas cosas que una persona no ve.

| Capacidad | Detalle |
|---|---|
| Leer la pantalla | Todos los textos, etiquetas, `testID` y valores de los campos que la app tiene montados, y la ruta actual con sus parámetros. |
| Actuar | Pulsar, escribir, arrastrar, navegar a cualquier ruta y abrir un enlace profundo. |
| Ver las peticiones | El método, la URL, el estado y la duración de cada petición HTTP de la app. |
| Ver la traza | Las rutas visitadas, los cambios en los stores observados, los eventos de analítica y los comandos ejecutados. |
| Ejecutar los comandos de la app | Todo lo que tu app registró con `qa.register`, además de leer el estado de los stores que mostró con `qa.observe`. |

Los dos últimos puntos dependen de ti. El agente no expone ningún store ni ningún comando que tu app no le haya entregado de forma explícita.

### Qué queda fuera, siempre

El agente recorta algunos datos antes de que salgan de la app:

- **Los campos de contraseña.** El valor de un campo con `secureTextEntry` llega enmascarado con `•`.
- **Las cabeceras y los cuerpos de las peticiones.** No se registran nunca. De una petición solo quedan el método, la URL, el estado y la duración.
- **Los valores sensibles de la URL.** En la cadena de consulta, se oculta el valor de todo parámetro cuyo nombre contenga `token`, `key`, `secret`, `code`, `otp`, `password`, `pin`, `session` o `auth`.
- **El contenido de los stores en la traza.** Cuando un store observado cambia, la traza anota qué claves cambiaron. Los objetos y las listas se reducen a su tamaño.

Hay dos límites que conviene conocer. El recorte de las URL actúa sobre la cadena de consulta: un secreto que viaja en la ruta, como `/reset/<token>`, queda visible. Y en la traza de un store, los valores simples de primer nivel (un texto, un número) se anotan tal cual. No observes con `qa.observe` un store que guarda una credencial en claro en su primer nivel.

### A quién se lo expone

El agente no abre ningún puerto. **Es la app la que se conecta hacia afuera**, a una dirección fija: `localhost` en iOS, y `10.0.2.2` en el emulador de Android, que es la dirección de la máquina que aloja al emulador. Dentro de la app no escucha nada, y nada es alcanzable desde la red.

En la práctica, quien puede manejar la app es quien pueda escuchar en el puerto del driver (`8123` por defecto) en tu máquina. En una máquina de desarrollo, eso es cualquier proceso local. Para eso está el token.

### El token

El token es un secreto compartido entre la app y su driver. Cuando montas el agente con un token, la app exige que el driver se lo presente en su primer mensaje. Hasta entonces no se presenta ni atiende ninguna orden: cada petición recibe el error `unauthenticated`.

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

auto({ token: process.env.LYNKEUS_TOKEN });
```

El CLI lee el mismo valor de la variable de entorno `LYNKEUS_TOKEN`.

Tres recomendaciones:

- **Úsalo siempre.** Sin token, cualquier proceso de tu máquina que escuche en ese puerto maneja tu build de depuración.
- **Que sea por máquina y no esté en el repositorio.** El token protege contra otros procesos de la misma máquina. Un valor fijo que todos conocen protege menos.
- **Tenlo por lo que es.** El valor queda dentro del bundle de JavaScript del build de depuración. Protege una app en desarrollo contra procesos locales; no es una credencial para proteger datos de producción.

El token viaja sin cifrar por una conexión WebSocket local (`ws://`). Eso es adecuado para una conexión dentro de la misma máquina, que es para lo que está pensado.

### Por qué solo en builds de depuración

Un componente que acepta órdenes de afuera no debe existir en la app que reciben tus usuarios. lynkeus lo impide en varias capas, y ninguna depende de que te acuerdes de apagar algo.

| Capa | Qué garantiza |
|---|---|
| `enabled` vale `__DEV__` por defecto | En un bundle de producción, el agente no arranca. |
| El cliente se carga de forma perezosa | El código que abre la conexión solo se evalúa si `enabled` es verdadero. Un bundle de producción nunca lo ejecuta. |
| iOS: `#if DEBUG` | La síntesis de toques usa una API privada de UIKit, la misma técnica en la que se apoyan KIF y Detox. Está envuelta en `#if DEBUG`: en un binario de producción esos símbolos no existen. No están desactivados; no están. |
| Android: `FLAG_DEBUGGABLE` | El módulo nativo se niega a correr si la app no es depurable. |

### El caso que las capas no cubren

Queda un caso que solo tú puedes cerrar: **un build de depuración que apunta a tu backend de producción**.

Ese build pasa todas las comprobaciones anteriores, porque es de depuración. Pero ahí el agente maneja una app con sesión en cuentas reales, sobre datos reales. Un `lynkeus crawl` en ese build pulsaría botones que hacen cosas de verdad.

Ciérralo condicionando `enabled` a tu entorno, además de a `__DEV__`:

```js
auto({
  token: process.env.LYNKEUS_TOKEN,
  enabled: __DEV__ && config.ENV !== 'prod',
});
```

:::danger
Un build de depuración que habla con un backend real, con cuentas reales, no debe correr el agente. `__DEV__` no distingue ese caso; tu configuración de entorno sí.
:::

## El host sin pantalla

El host sin pantalla (headless) ejecuta tu app en Node, sin simulador. La capa nativa está simulada, pero el JavaScript de la app corre de verdad y habla con un backend de verdad. Por eso tiene tres protecciones propias.

**El token es obligatorio.** `lynkeus headless start` se niega a arrancar sin `LYNKEUS_TOKEN`. El mensaje explica el motivo: `a hosted app talks to a real backend, and without one any local process could drive it`.

**La red está limitada a tu máquina.** Con `network: 'real'`, el host rechaza cualquier petición a un servidor que no esté en `networkHosts`, y esa lista por defecto solo contiene la propia máquina (`127.0.0.1` y `localhost`). Una herramienta automática apuntada a producción es exactamente el accidente que esto previene.

**La entrada comprueba adónde apunta la app.** El archivo que genera `lynkeus headless init` lee la variable de la que tu app toma la dirección de su API (`apiEnv` en la configuración, `API_URL` por defecto) y se niega a renderizar la app si no apunta a un backend local. El error es `lynkeus headless only drives a local backend; API_URL is "…"`.

La segunda y la tercera están en tu archivo de entrada, así que las puedes cambiar. Si amplías `networkHosts`, hazlo sabiendo que es la barrera entre un test automático y un servidor que no es tuyo.

## Lo que queda en tu máquina

El CLI escribe sus archivos en la carpeta `.lynkeus/` de tu app: el mapa, las pantallas grabadas, las referencias de `snapshot` y las ejecuciones. Todo eso es producto de una ejecución; se puede borrar y volver a generar.

Algunos de esos archivos contienen lo que la app mostró: capturas de pantalla, textos de pantalla, URL de peticiones. Trátalos como tratarías los artefactos de cualquier suite de tests. Si tus tests corren contra datos que no deben circular, no subas `.lynkeus/` al repositorio.

Los comandos `crawl` y `smoke` merecen una mención aparte, porque actúan por su cuenta. `crawl` es de solo lectura por defecto: en cuanto una pulsación hace que la app escriba (un `POST`, `PUT`, `PATCH` o `DELETE`), deja de explorar más allá y no vuelve a pulsar ese control. Pero esa primera pulsación sí ocurre. Los controles que no deben tocarse nunca se declaran en `crawl.never`, en [`lynkeus.config.json`](/es/reference/configuration/). lynkeus no trae ninguna lista propia.

## El servicio de reportes

El servicio de reportes, en [lynkeus.io](https://lynkeus.io), es la parte paga de lynkeus: recibe una ejecución y la muestra como una página que tu equipo puede abrir. Es opcional. Sin él, lynkeus funciona igual y nada sale de tu máquina.

### Qué se sube, y cuándo

Solo se sube algo cuando lo pides: con `--push` en `lynkeus case run`, o con `lynkeus report push <dir>`. Se sube el directorio que escribió `--out`, y nada más:

| Archivo | Qué contiene |
|---|---|
| `run.json` | Cuándo empezó y terminó la ejecución, la plataforma, los totales, y la rama y el commit de git desde los que se hizo. |
| `cases.jsonl` | Una línea por intento de cada caso: su id, título, descripción y archivo, y sus pasos. |
| capturas de pantalla | Una por paso de la app, si ejecutaste con `--screenshots`. |
| videos | Uno por caso, si ejecutaste con `--video`. |

El contenido de `cases.jsonl` es lo que más conviene mirar. Cada paso lleva el texto del paso tal como está escrito en el caso, su resultado, su error si falló, y además:

- Los eventos de analítica que la app envió durante el paso, con sus propiedades.
- Con `--traces`, lo que el backend hizo por ese paso: las peticiones, las consultas, los jobs y las llamadas salientes que exportó por OpenTelemetry, con sus atributos.
- Si el caso falló, la evidencia: el listado de la pantalla en ese momento, las últimas peticiones y el diagnóstico.

Tres consecuencias prácticas:

- **Los valores escritos en un caso llegan al reporte.** El texto de un paso `app.type` incluye lo que se escribió. No pongas credenciales reales en un caso.
- **Las capturas de pantalla muestran lo que la app mostró.** Si tus tests corren contra datos personales reales, esos datos aparecen en las imágenes.
- **Los atributos de las trazas vienen de tu backend.** Qué incluyen (el texto de una consulta SQL, por ejemplo) depende de cómo esté configurado tu SDK de OpenTelemetry.

La recomendación es la misma en los tres casos: ejecuta contra un backend de pruebas, con datos de prueba. En CI, levanta el backend que el job prueba, con datos sembrados para tests. No hace falta ningún entorno compartido ni interviene ningún dato de producción.

### Quién puede abrir un reporte

Un reporte se puede abrir de dos maneras: con su enlace, o como miembro de tu organización.

El enlace tiene la forma `https://lynkeus.io/r/<token>`. El token es propio de esa ejecución e imposible de adivinar, pero **quien tiene el enlace puede abrir el reporte sin iniciar sesión**, con sus capturas y sus videos. Es lo que permite pegarlo en un pull request. Trata el enlace como tratarías el contenido: no lo pegues donde no pegarías las capturas de pantalla.

Las personas entran al servicio con su cuenta de Google o de GitHub. Cada una tiene una organización propia, o se suma a la que la invitó.

### La clave de API

Para subir ejecuciones, el CLI se identifica con la clave de API de la organización, que lee de `LYNKEUS_REPORTS_KEY`.

- La clave se muestra una sola vez, cuando la creas. El servicio guarda únicamente su hash (SHA-256), así que no puede volver a mostrártela.
- Quien tiene la clave puede subir ejecuciones y leer las de la organización.
- Guárdala como un secreto. En CI va en los secretos del repositorio, nunca en el archivo del workflow.
- Una clave se puede borrar desde el servicio. Si una se filtra, bórrala y crea otra.

### Cuánto tiempo se guarda

Las ejecuciones se conservan durante el período de tu plan y después se eliminan, junto con todos sus archivos.

| | Free | Team |
|---|---|---|
| Ejecuciones y capturas de pantalla | 7 días | 90 días |
| Videos | no se guardan | 90 días |
| Proyectos | 1 | sin límite |

Una tarea diaria elimina las ejecuciones que superaron el período de su plan, y con ellas sus capturas y videos.

En el plan Free, los videos no se guardan en ningún momento: el servicio los rechaza al subirlos, y el CLI lo avisa con `not kept on this plan: …`. El resto de la ejecución se sube igual.

`lynkeus report plan` muestra qué conserva tu plan.

### Clientes de IA

El servicio ofrece un punto de acceso MCP para que un cliente de IA (Claude, Claude Code, Cursor y otros) lea las ejecuciones de tu organización, sus casos y lo que hizo el backend.

- El cliente actúa con tu sesión: la primera vez, lynkeus te pide que apruebes el acceso y que elijas qué organización puede leer.
- Solo puede leer. No puede subir, modificar ni borrar nada.
- Puedes desconectarlo cuando quieras, desde la sección de miembros.
- Cuando alguien deja una organización, el acceso de sus clientes de IA a esa organización termina también.

No lo confundas con `lynkeus mcp`, el comando del CLI. Ese corre en tu máquina, maneja tu app y no habla con el servicio. Está descrito en [Agentes de IA](/es/guides/ai-agents/).

## Lista de comprobación

Antes de dejar lynkeus instalado en un proyecto, repasa esto:

1. El agente se monta con un `token`, y el valor no está en el repositorio.
2. `enabled` depende de tu entorno, no solo de `__DEV__`.
3. Ningún store que guarde credenciales en claro pasa por `qa.observe`.
4. Los comandos registrados con `qa.register` no hacen nada que no quieras que un proceso local pueda disparar.
5. Los tests corren contra un backend de pruebas, con datos de prueba.
6. `crawl.never` nombra los controles irreversibles de tu app.
7. `LYNKEUS_REPORTS_KEY` vive en los secretos de CI.
8. El equipo sabe que el enlace de un reporte se abre sin iniciar sesión.
