---
title: Relay del backend
description: Cómo dar a una app que corre lejos de tu máquina acceso a un backend local, con una conexión saliente y una sesión temporal, sin abrir puertos.
---

Piensa en este caso: estás desarrollando el backend en tu equipo, donde escucha en `127.0.0.1`, y necesitas que una app lo use desde un dispositivo en una granja de pruebas, un runner de otra red o el teléfono de una colega. Esa app no puede llegar a tu loopback. Y publicar el backend en internet, aunque sea un rato, es justo lo que no quieres hacer.

El comando `lynkeus relay` lo resuelve invirtiendo la dirección de la conexión: es tu máquina la que llama al servicio de lynkeus. La app habla con el servicio, y el servicio entrega cada pedido a tu CLI por esa misma conexión, que lo pasa al backend local y devuelve la respuesta por el mismo camino.

## Cuándo no lo necesitas

Si la app ya ve tu máquina, no hace falta. Es el caso del simulador de iOS en la misma Mac, del emulador de Android (que llega a ella como `10.0.2.2`) y del [host sin pantalla](/es/platforms/headless/).

El relay lo ofrece el servicio alojado de [lynkeus.io](https://lynkeus.io), así que requiere la clave de API de tu organización. Solo transporta las llamadas de la app a tu API. El canal entre el driver y la app es otro y no pasa por aquí.

## Ponerlo en marcha

Necesitas tres cosas:

1. El backend corriendo en loopback (por ejemplo, en `http://127.0.0.1:3000`), con su API móvil bajo `/api/mobile/`.
2. La clave de tu organización en `LYNKEUS_REPORTS_KEY`. Si esa variable no existe, la CLI prueba con `LYNKEUS_CLOUD_KEY`. Más en [variables de entorno](/es/reference/environment-variables/).
3. Una terminal que puedas dejar abierta.

Ejecuta:

```bash
lynkeus relay --backend http://127.0.0.1:3000
```

La CLI crea la sesión, abre la conexión y avisa por stderr, con una línea como esta:

```text
relay listening: https://lynkeus.io/relay/relay_<64 hex>/api/mobile/ (expires 2026-11-16T15:30:00.000Z)
```

Esa URL es lo que debe recibir la app como dirección de su API: en `API_URL`, en una constante de compilación o donde tu proyecto la lea. Desde ese momento, un `GET <esa URL>/perfil` llega a tu backend como `GET /api/mobile/perfil`; el backend no sabe que hay un intermediario.

El proceso se queda esperando. Termina cuando pulsas Ctrl-C o cuando la sesión vence; en ambos casos la URL deja de funcionar. Si necesitas seguir, vuelve a ejecutarlo: cada ejecución crea una sesión nueva, con otro token y otra URL.

### Opciones

| Opción | Por defecto | Para qué sirve |
|---|---|---|
| `--backend <url>` | `http://127.0.0.1:3000` | El backend local. Solo se admiten HTTP o HTTPS sobre `localhost`, `127.0.0.1` o `::1`, y la URL no puede llevar usuario ni contraseña. |
| `--prefix <ruta>` | `/api/mobile/` | Lo único que se reenvía. Tiene que empezar con `/api/mobile/`; puedes acotarlo (`/api/mobile/v2/`), nunca ampliarlo. |
| `--ttl <segundos>` | `900` | Vida de la sesión. El máximo es `3600`; un valor mayor lo rechaza el servicio. |
| `--cloud <url>` | `LYNKEUS_REPORTS_URL` o `https://lynkeus.io` | A qué servicio conectarse. Fuera de loopback debe ser TLS. Un servicio local (HTTP, en `127.0.0.1`) sirve para pruebas. |

## Por qué hay dos secretos

Al crear la sesión, el servicio genera dos valores al azar y los entrega una sola vez:

| Secreto | Forma | Dónde vive | Qué permite |
|---|---|---|---|
| Token | `relay_` y 64 hex | En la URL de la app | Enviar pedidos a la sesión |
| Secreto del socket | `relaysock_` y 64 hex | Solo en la CLI | Conectarse como el lado local y contestar |

El token tiene que viajar con la app, así que acaba en lugares poco discretos: variables de entorno de un job, logs de red, informes de fallos. Si con ese mismo valor se pudiera también abrir la conexión del lado local, quien lo encontrara podría suplantar a tu CLI y responderle a la app lo que quisiera, con datos falsos que la app daría por buenos. Por eso abrir el socket exige el secreto aparte, que no sale de tu máquina. El token por sí solo no puede contestar nada.

Si una conexión nueva se presenta con el secreto correcto, sustituye a la anterior y los pedidos que esta tenía abiertos fallan. Es el mecanismo de reconexión; no lances dos relays para la misma sesión.

## Qué no puede hacer el relay

Los límites son parte del diseño:

- **Tiempo.** 15 minutos por defecto, 1 hora como tope.
- **Rutas.** Solo las que están bajo el prefijo (que debe colgar de `/api/mobile/`). Se rechazan las rutas con `..`, con barras invertidas o con bytes nulos. Lo que queda fuera recibe 403 y nunca llega al backend.
- **Destino.** Solo tu loopback. La CLI no sigue redirecciones: si el backend responde con una, la app recibe esa respuesta tal cual.
- **Tamaño y plazo.** 1 MiB por pedido, 8 MiB por respuesta y 30 segundos para que el backend conteste.
- **Cantidad.** 1000 pedidos por sesión, 8 en paralelo, y 20 sesiones activas por organización.
- **Cabeceras.** Pasan `accept`, `content-type`, `x-api-key`, `x-version`, `x-bundleversion`, `user-agent`, `traceparent`, `tracestate` y el `authorization` propio de la app. No pasan `cookie`, `host` ni las credenciales de lynkeus.
- **Respuestas como datos.** El servicio las marca para que un navegador no las ejecute ni las muestre. Así, un backend que contestara HTML no podría ejecutar código en el origen del servicio, donde están las sesiones de tu equipo. A la app, que las lee como datos, no le cambia nada.

## Qué guarda el servicio

Para sostener la sesión, el servicio registra los hashes SHA-256 del token y del secreto del socket (los valores no), la organización, el prefijo, la hora de vencimiento y cuántos pedidos van. El contenido que atraviesa el relay, es decir, cuerpos, cabeceras y token, no se escribe en ningún log ni se guarda: lo maneja un proceso efímero que une la conexión de la app con la de tu CLI.

## Si algo falla

Mensajes de la CLI (la CLI los emite en inglés):

| Mensaje | Qué pasa | Qué hacer |
|---|---|---|
| `set LYNKEUS_REPORTS_KEY (or LYNKEUS_CLOUD_KEY) … to create a relay session` | Falta la clave. Código de salida 2. | Define la variable y repite. |
| `could not create the relay session (401)` | El servicio no aceptó la clave. Código de salida 1. | Revisa que sea la de tu organización y que no esté revocada. |
| `could not create the relay session (429)` | La organización ya tiene 20 sesiones activas. | Cierra relays que no uses o espera a que venzan. |
| `the relay service is older than this CLI: it gave no socket secret` | El servicio no conoce el segundo secreto. | Actualiza el servicio o cambia `--cloud`. |
| `the relay backend must be an HTTP(S) loopback URL` | `--backend` no es loopback. | Levanta el backend en tu máquina. |
| `the relay prefix must stay under /api/mobile/` | El prefijo se sale de lo permitido. | Elige uno que empiece con `/api/mobile/`. |
| `the relay could not connect` | La CLI no abrió el WebSocket. | Comprueba la red, `--cloud` y si un proxy bloquea WebSockets. |

Códigos que ve la app:

| Código | Causa probable |
|---|---|
| 403 | La ruta está fuera del prefijo. |
| 503 | La CLI no está conectada: la cortaste o perdió la red. Vuelve a ejecutarla y entrega la URL nueva. |
| 504 | El backend tardó más de 30 segundos. |
| 502 | La CLI no alcanzó el backend o este devolvió algo inválido. Comprueba que corre en la dirección de `--backend`. |
| 413 | El pedido pesa más de 1 MiB. |
| 429 | Más de 8 pedidos a la vez, o la sesión agotó sus 1000. |
| 404 | La sesión no existe o ya venció: ejecuta `lynkeus relay` otra vez. |

## Más información

- [Seguridad](/es/security/): qué expone lynkeus y a quién.
- [Referencia de la CLI](/es/reference/cli/): todas las opciones del comando.
