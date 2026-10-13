---
title: Introducción
description: Qué es lynkeus, qué le aporta a cada persona del equipo, cómo encajan sus piezas y por dónde empezar.
---

lynkeus es una herramienta de código abierto para ejecutar tests automatizados sobre apps de React Native. Maneja la app desde adentro del proceso, y deja un reporte de cada ejecución.

Esta página explica la idea de fondo, qué gana cada rol con ella y cómo se relacionan las piezas. Si ya sabes que quieres probarla, salta a [Instalación en React Native](/es/getting-started/installation-react-native/) o a [Instalación en Expo](/es/getting-started/installation-expo/).

## El problema que resuelve

Las herramientas habituales de pruebas de extremo a extremo manejan la app desde afuera. Le preguntan al sistema operativo qué hay en pantalla, toman una captura y deducen el resto. Cada paso cuesta un segundo o más, y la respuesta es una imagen, no un dato.

lynkeus corre **dentro** de un build de depuración de tu app. Lee el árbol de React, así que lo que informa es lo que React renderizó: las rutas, los `testID`, los valores de los campos, qué elemento recibiría un toque y cuáles quedaron tapados por una hoja o un diálogo. Los toques y las teclas se generan dentro del proceso, y las esperas terminan en el render que las satisface, no cuando vence un temporizador.

De ahí salen los tiempos:

| Operación | Tiempo | Qué hace |
|---|---|---|
| `screen` | 2 a 9 ms | Lista lo que hay en pantalla: `testID`, textos, valores y qué está tapado. |
| `press` | unos 60 ms | Un toque real: lo reciben los reconocedores de gestos, `Pressable` y las hojas. |
| `type` | 25 ms por tecla | Escribe por el camino del teclado, así que las máscaras y `onChange` se comportan como con una persona. |
| `wait` | exacto | Termina en el momento en que aparece (o desaparece) una ruta o un elemento. |

## Qué le aporta a cada rol

**Si desarrollas la app**, la instalación es un paquete y una línea en el punto de entrada. No hay que tocar las pantallas. En un build de producción el módulo nativo se compila vacío y el JavaScript del agente nunca se evalúa.

**Si escribes y ejecutas tests**, trabajas con archivos legibles llamados casos: una lista de pasos que se ejecuta igual en un simulador, en un emulador o sin simulador. Cuando un paso falla, lynkeus guarda la pantalla tal como estaba, las peticiones que hizo la app y el motivo: el elemento estaba tapado, deshabilitado, detrás de una capa o ya no existía.

**Si decides si adoptarla**, los puntos a evaluar son tres. Los tests afirman sobre hechos (rutas, valores, peticiones de red) que una captura de pantalla no muestra. La misma suite corre en CI sin granja de dispositivos. Y la herramienta no sabe nada de tu producto: preparar datos en el backend queda en un comando tuyo, que lynkeus solo invoca.

## Cómo encajan las piezas

Hay cuatro piezas. Conviene tenerlas claras antes de instalar nada.

### El agente, dentro de la app

El **agente** es el paquete `lynkeus-agent`, montado en tu app. En un build de depuración abre una conexión WebSocket hacia tu propia máquina y responde pedidos: qué hay en pantalla, toca esto, escribe aquello, espera tal ruta. La app es la que llama hacia afuera; nada queda escuchando dentro de ella.

### El CLI, en tu terminal

El **CLI** es el paquete `lynkeus`. Es el otro extremo de esa conexión, lo que la documentación llama *driver*. Con él manejas la app a mano (`lynkeus screen`, `lynkeus press`), ejecutas casos (`lynkeus case run`) y revisas la pantalla en busca de problemas de accesibilidad y de contraste (`lynkeus lint`). También puede servir sus comandos a un agente de IA con `lynkeus mcp`.

### Los hosts: dónde corre la app

El **host** es el lugar donde corre la app durante el test. Hay tres posibilidades, y un mismo caso sirve para todas:

- un simulador de iOS,
- un emulador de Android,
- el host sin pantalla (*headless*): `lynkeus headless start` renderiza la app en Node, bajo Jest y React Native Testing Library, sin simulador y sin compilar nada nativo.

En el simulador y el emulador la capa nativa es real. En el host sin pantalla está simulada con mocks, y a cambio arranca en unos 40 segundos y se puede multiplicar por núcleos en CI. La página [Sin pantalla (headless)](/es/platforms/headless/) detalla qué se gana y qué se pierde.

### Los reportes alojados

Una ejecución puede escribirse como un directorio (`lynkeus case run --out`) y subirse al servicio de reportes de [lynkeus.io](https://lynkeus.io) con `--push`. El reporte muestra cada caso paso a paso, con sus capturas de pantalla o su video, los eventos que envió la app y por qué falló lo que falló. Este servicio es de pago en su plan Team y tiene un plan gratuito; el resto de lynkeus funciona sin él. Los detalles están en [Reportes](/es/guides/reports/).

## Paquetes

| Paquete | Para qué sirve |
|---|---|
| `lynkeus-agent` | Se monta en la app. Lee la pantalla, genera toques y teclas, espera, registra peticiones. |
| `lynkeus` | El CLI: maneja la app, ejecuta casos, sirve los comandos por MCP. |
| `lynkeus-headless` | Aloja la app en Node bajo Jest, con el mismo protocolo y sin simulador. |
| `lynkeus-client` | El cliente de Node sobre el que está construido el CLI, para escribir tu propio ejecutor. |
| `lynkeus-protocol` | El contrato de la conexión, como tipos de TypeScript. |

## Requisitos

- React Native 0.76 o posterior, con la Nueva Arquitectura.
- Builds de depuración de iOS y de Android, en un simulador o un emulador. lynkeus no funciona en builds de producción, a propósito, y los dispositivos físicos no están soportados.
- Node 22 o posterior para el CLI y para el host sin pantalla.

## Por dónde seguir

El recorrido recomendado, en orden:

1. Instala lynkeus en tu app: [React Native](/es/getting-started/installation-react-native/) o [Expo](/es/getting-started/installation-expo/).
2. Escribe y ejecuta [tu primer test](/es/getting-started/first-test/).
3. Lee [Conceptos](/es/getting-started/concepts/) para fijar el vocabulario que usa el resto de la documentación.

Después, según lo que necesites:

- [Manejar la app](/es/guides/driving-the-app/) y [Escribir casos](/es/guides/writing-cases/), para el trabajo diario.
- [Fixtures](/es/guides/fixtures/), para preparar datos en el backend antes de cada caso.
- [CI](/es/guides/ci/), para llevar la suite a la integración continua.
- [Seguridad](/es/security/), si tienes que justificar ante tu equipo qué expone el agente.
- [Preguntas frecuentes](/es/faq/), para las dudas que aparecen primero.
