---
title: Preguntas frecuentes
description: Respuestas cortas a lo que se pregunta primero sobre lynkeus, desde qué llega a producción hasta cómo se compara con otras herramientas.
---

Respuestas breves a las dudas que aparecen al evaluar o empezar a usar lynkeus. Cada una enlaza a la página que la desarrolla.

## Antes de adoptarlo

### ¿En qué se diferencia de Detox, Maestro o Appium?

Cubre el mismo terreno: manejar un build real de extremo a extremo. La diferencia es desde dónde. Esas herramientas actúan a través del sistema operativo; lynkeus actúa desde dentro de la app.

De ahí salen su ventaja y su condición. Es rápido, porque nada sale del proceso para decidir el paso siguiente, y afirma sobre hechos (rutas, valores, peticiones) en lugar de imágenes. A cambio, necesita un build de depuración con el agente adentro.

### ¿Llega algo a mi build de producción?

No. El módulo nativo se compila vacío fuera de los builds de depuración, y el JavaScript del agente nunca se evalúa cuando `enabled` es falso.

En iOS, el código que genera los toques está dentro de `#if DEBUG`: los símbolos no existen en el binario de producción. En Android, el módulo se niega a funcionar si la app no es depurable. Más en [Seguridad](/es/security/).

### ¿Puedo probar mi build de producción con lynkeus?

No, y es consecuencia directa de la respuesta anterior. lynkeus prueba el build de depuración de tu app.

### ¿Cuánto cuesta?

lynkeus es de código abierto, con licencia MIT. El agente, el CLI y el host sin pantalla no tienen costo.

El servicio de reportes alojados en [lynkeus.io](https://lynkeus.io) es aparte y opcional. Tiene dos planes:

| | Free | Team |
|---|---|---|
| Capturas de pantalla | sí | sí |
| Video de cada caso | no | sí |
| Historial | 7 días | 90 días |
| Proyectos | uno | sin límite |

El plan Team es una suscripción por organización. Más en [Reportes](/es/guides/reports/).

### ¿Necesito el servicio de reportes para usarlo?

No. `lynkeus case run` imprime el resultado en la terminal y, con `--out <dir>`, escribe la ejecución como archivos que puedes leer con tus propias herramientas. El servicio agrega la vista para personas y el historial.

### ¿Qué versiones de React Native admite?

React Native 0.76 o posterior. En iOS, con la Nueva Arquitectura. El CLI y el host sin pantalla necesitan Node 22 o posterior.

### ¿Funciona con Expo?

Sí, en iOS y en Android, con un development build. No funciona en Expo Go, porque el agente tiene código nativo. No hace falta ningún *config plugin*. Los pasos están en [Instalación en Expo](/es/getting-started/installation-expo/) y los límites en [Expo](/es/platforms/expo/).

## Al instalar

### ¿Tengo que agregar `testID` a toda mi app?

No es obligatorio. Un elemento también se puede señalar por su texto, por su índice en el listado de la pantalla o por un punto.

Aun así, el `testID` es la forma más estable: no cambia con el idioma ni con la redacción. Agrégalo en los controles que tus tests tocan.

### ¿Tengo que modificar mis pantallas?

No. El agente se monta con una llamada a `auto()` en el punto de entrada de la app, y ninguna pantalla renderiza nada adicional. El comando `lynkeus init` agrega esa llamada por ti (todavía no publicado).

### ¿Con qué librerías de navegación funciona?

Con React Navigation, sin configuración: `auto()` encuentra el contenedor por su cuenta. Las rutas de expo-router también se reconocen.

Con otro enrutador, puedes escribir un adaptador de navegación y pasárselo al componente `<Lynkeus>`. Sin adaptador, lynkeus sigue leyendo la pantalla, tocando y esperando elementos; lo que no tiene son nombres de rutas. Más en [API del agente](/es/reference/agent-api/).

### ¿Para qué sirve el token?

Para que solo tu driver pueda manejar la app. El agente atiende únicamente a quien abre la conexión con el mismo secreto, lo que deja afuera a cualquier otro proceso de tu máquina.

La app lo recibe en la opción `token`; el CLI lo lee de `LYNKEUS_TOKEN`. El host sin pantalla no arranca sin él.

### ¿La app queda expuesta a la red?

No. La app es la que se conecta hacia afuera, a tu propia máquina. Dentro de la app nada queda escuchando, y nada es alcanzable desde la red.

### ¿Funciona en un dispositivo físico?

Esta documentación cubre el simulador de iOS y el emulador de Android. Por defecto la app se conecta a `localhost` en iOS y a `10.0.2.2` en Android, dos direcciones que un teléfono real no puede usar para llegar a tu máquina.

## Al escribir tests

### ¿En qué formato se escriben los tests?

En archivos markdown llamados casos: un encabezado que los identifica y una lista de pasos en YAML. Están pensados para que los lea cualquiera del equipo. Empieza por [Tu primer test](/es/getting-started/first-test/).

Si prefieres escribirlos en código, `lynkeus-client` es el cliente de Node sobre el que está construido el CLI. Con él manejas la app desde Jest, Vitest o el ejecutor que ya uses.

### ¿Cómo preparo datos en el backend?

Con fixtures: datos de prueba que tu propio comando crea cuando un caso los pide. lynkeus le envía cada pedido como una línea de JSON y lee la respuesta. No necesita saber nada de tu backend. Más en [Fixtures](/es/guides/fixtures/).

### ¿Puedo ejecutar los tests sin simulador?

Sí. `lynkeus headless start` aloja la app en Node, bajo Jest y React Native Testing Library, y `case run --host` lo hace por ti durante una ejecución. La capa nativa queda reemplazada por mocks, así que hay cosas que solo un simulador puede probar. Más en [Sin pantalla (headless)](/es/platforms/headless/).

### ¿El mismo test sirve para iOS, Android y sin pantalla?

Sí. Un caso no dice dónde corre la app. Los pocos pasos que solo necesita un lado se marcan con `on: ios`, `on: android`, `on: device` o `on: headless`, y en los demás se omiten.

### ¿Qué pasa cuando un test falla?

El caso se detiene en ese paso y lynkeus guarda la pantalla tal como estaba, las peticiones que había hecho la app y el motivo: el objetivo estaba tapado, oculto detrás de una capa, deshabilitado o ausente. Después el caso se ejecuta una vez más antes de contar como fallido.

A mano, `lynkeus why <objetivo>` hace la misma pregunta en cualquier momento.

### ¿Cómo distingo un test intermitente de uno roto?

Un caso que falla y pasa en el reintento queda marcado en el resumen como aprobado en el reintento. lynkeus lleva además un registro de cómo le fue a cada caso a lo largo de las ejecuciones. Más en [Tests intermitentes](/es/guides/flaky-tests/).

### ¿Por qué cada comando tarda más de un segundo si los pasos son de milisegundos?

Porque un comando suelto paga por arrancar un proceso y conectarse, cerca de 1,5 segundos. El paso en sí cuesta milisegundos.

Para encadenar muchos, `lynkeus session` mantiene una sola conexión abierta y cada paso baja a unos 50 ms. `lynkeus case run` ya trabaja así. Más en [Manejar la app](/es/guides/driving-the-app/).

## En el equipo y en CI

### ¿Puedo correr varias ejecuciones en la misma máquina?

Sí. Define `LYNKEUS_PORT` con un valor distinto para cada pareja de app y driver. Cada pareja es independiente.

### ¿Cómo lo llevo a CI?

De dos maneras, que se pueden combinar. Con el host sin pantalla no necesitas simuladores y puedes repartir la suite entre núcleos. Con un simulador o un emulador pruebas además la capa nativa. Las dos están en [CI](/es/guides/ci/).

### ¿Puede usarlo un agente de IA?

Sí. `lynkeus mcp` sirve los comandos como herramientas MCP. El modelo recibe elementos estructurados en lugar de píxeles, así que decide el paso siguiente a partir de hechos. Más en [Agentes de IA](/es/guides/ai-agents/).

### ¿Qué registra lynkeus de las peticiones de mi app?

El método, la ruta, el código de respuesta y la duración. Nunca los encabezados ni los cuerpos, y los valores sensibles de la consulta se ocultan. El valor de un campo con `secureTextEntry` también aparece enmascarado. Más en [Seguridad](/es/security/).

### ¿lynkeus sabe algo de mi producto?

No, y es deliberado. No tiene una lista de tus pantallas ni sabe qué es un usuario en tu app. Lo que requiere conocer el producto (cómo iniciar sesión, qué datos necesita un caso) lo aportas tú, en `lynkeus.config.json` y en tu comando de fixtures.

### ¿Puedo contribuir al proyecto?

El repositorio no recibe contribuciones: los *issues* están desactivados y los *pull requests* se cierran automáticamente. Puedes hacer un *fork* bajo los términos de la licencia MIT.
