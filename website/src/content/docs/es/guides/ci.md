---
title: Ejecutar en CI
description: Qué necesita un job de integración continua para correr los casos de lynkeus, qué host conviene usar, cómo paralelizar y cómo dejar el reporte en el pull request.
---

Un test que solo corre en la máquina de quien lo escribió protege poco. El objetivo de esta guía es que tus casos corran en cada pull request y que, cuando uno falle, quien lo vea tenga un enlace con todo lo necesario para entenderlo.

lynkeus no publica una acción propia para ejecutar casos: un job de CI ejecuta los mismos comandos que usas en tu terminal. Aquí verás qué necesita ese job, cómo elegir dónde corre la app y un flujo de trabajo de ejemplo para GitHub Actions que puedes adaptar a cualquier otro sistema.

## Antes de empezar

- Tus casos pasan en tu máquina ([escribir casos](/es/guides/writing-cases/)).
- Sabes cómo levantar tu backend en un entorno de pruebas, con datos de prueba.
- Si vas a subir reportes, tienes una clave del servicio ([reportes](/es/guides/reports/)).

## Qué necesita un job

| Necesidad | Detalle |
|---|---|
| Node 22 o posterior | Para la CLI y para el host sin pantalla. |
| Las dependencias de la app | Incluidos `lynkeus` y `lynkeus-agent`, instalados como dependencias de desarrollo. |
| Un host | Dónde corre la app durante el test. Se elige en la sección siguiente. |
| `LYNKEUS_TOKEN` | El secreto compartido entre la app y quien la maneja. Debe tener el mismo valor en ambos lados. |
| El backend | El que el job está probando: su imagen, con su base de datos y su caché como servicios, y datos de prueba. No hace falta un entorno compartido. |
| El comando de fixtures | Lo que declaraste en `cases.fixtures`, con acceso a ese backend. |
| Las variables del servicio de reportes | `LYNKEUS_REPORTS_KEY`, solo si usas `--push` (y `LYNKEUS_REPORTS_URL` para un servicio distinto de lynkeus.io). |

## Elige el host

El host es dónde corre la app durante el test. Hay dos opciones, y la mayoría de los equipos termina usando ambas.

| | Host sin pantalla (headless) | Simulador o emulador |
|---|---|---|
| Qué es | La app alojada en Node, bajo jest. | La app instalada en un simulador de iOS o un emulador de Android. |
| Qué necesita el runner | Solo Node. | Las herramientas de la plataforma, un build de depuración y el dispositivo virtual encendido. |
| Arranque | Unos 40 segundos, sin compilar nada. | El tiempo de compilar e instalar el build. |
| Capa nativa | Simulada: cámara, biometría e integraciones con el sistema son dobles de prueba. | Real. |
| Capturas de pantalla | No: no dibuja nada que capturar. | Sí. |
| Paralelismo | Un host por puerto, tantos como núcleos tengas. | Un dispositivo virtual por trabajo. |

La recomendación: corre toda la suite en el host sin pantalla en cada pull request, porque es rápido y no depende de animaciones. Reserva el simulador para lo que el host sin pantalla no puede decirte: gestos nativos complejos, lo que muestra un WebView, la entrega de notificaciones, los fallos nativos y los píxeles. Los casos son los mismos; solo cambia cómo arranca el host. Los detalles están en [la plataforma headless](/es/platforms/headless/).

## 1. Prepara la entrada del host sin pantalla

Esto se hace una vez, en tu máquina, y se sube al repositorio:

```bash
npx lynkeus headless init
npx lynkeus headless doctor
```

`headless init` escribe `qa/headless.tsx`: los dobles de prueba predeterminados, un control que verifica que la app apunte a un backend local, y tu componente `App`. `headless doctor` lista qué módulos nativos simula lynkeus y cuáles todavía necesitan un doble tuyo; `--fix` escribe esos dobles.

Comprueba que arranca antes de llevarlo a CI:

```bash
LYNKEUS_TOKEN=secret npx lynkeus case run --host
```

## 2. Escribe el flujo de trabajo

Este ejemplo corre todos los casos en el host sin pantalla y sube el reporte:

```yaml title=".github/workflows/lynkeus.yml"
name: lynkeus
on:
  pull_request:

jobs:
  cases:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22

      # Instala las dependencias con el gestor que use tu proyecto
      - run: yarn install --frozen-lockfile

      # Aquí va lo que levanta tu backend de pruebas y carga sus datos

      - name: Ejecutar los casos
        run: npx lynkeus case run --host --out run --push
        env:
          LYNKEUS_TOKEN: ${{ secrets.LYNKEUS_TOKEN }}
          LYNKEUS_REPORTS_URL: https://lynkeus.io
          LYNKEUS_REPORTS_KEY: ${{ secrets.LYNKEUS_REPORTS_KEY }}
```

Lo que hace la línea central:

- `--host` arranca `headless start` para la ejecución y lo detiene al terminar. No hay que manejar el proceso a mano.
- `--out run` guarda la ejecución como directorio.
- `--push` la sube al terminar e imprime la dirección del reporte.

Deberías ver, al final del registro del paso, el resumen y el enlace:

```text
✅ settings-dark-mode
❌ checkout-gift
1/2 passed
report: https://lynkeus.io/r/…
newly failing (1): checkout-gift
```

El paso termina con código 1 si algún caso falló, y eso marca el job como fallido. Un caso que el host no puede ejecutar (`unsupported`) no hace fallar la ejecución. Si la subida del reporte falla, el resultado de los casos no cambia.

El reporte lleva la rama y el commit de la ejecución. En GitHub Actions, la rama se toma del pull request.

## 3. Deja el resultado en el pull request

Para que nadie tenga que abrir el registro del job, publica las líneas importantes como comentario:

```yaml
      - name: Ejecutar los casos
        # pipefail: sin él, el paso tomaría el código de salida de tee y nunca fallaría
        run: |
          set -o pipefail
          npx lynkeus case run --host --out run --push | tee lynkeus.log
        env:
          LYNKEUS_TOKEN: ${{ secrets.LYNKEUS_TOKEN }}
          LYNKEUS_REPORTS_URL: https://lynkeus.io
          LYNKEUS_REPORTS_KEY: ${{ secrets.LYNKEUS_REPORTS_KEY }}

      - name: Comentar en el pull request
        if: always() && github.event_name == 'pull_request'
        run: gh pr comment ${{ github.event.pull_request.number }} --body "$(grep -E '^(report:|newly failing|fixed since)' lynkeus.log)"
        env:
          GH_TOKEN: ${{ github.token }}
```

El comentario contiene el enlace al reporte y qué casos se rompieron o se arreglaron respecto de la ejecución anterior. El job necesita permiso de escritura sobre los pull requests.

## 4. Corre varios casos a la vez

Cada trabajo en paralelo necesita su propio host, y cada host marca a su propio puerto. `LYNKEUS_PORT` mueve al host y a quien lo maneja juntos:

```yaml
      - name: Ejecutar los casos en paralelo
        run: |
          LYNKEUS_PORT=8123 npx lynkeus headless start &
          LYNKEUS_PORT=8124 npx lynkeus headless start &
          npx lynkeus case run --jobs 2 --ports 8123,8124 --attach-timeout 120000 --out run --push
        env:
          LYNKEUS_TOKEN: ${{ secrets.LYNKEUS_TOKEN }}
          LYNKEUS_REPORTS_URL: https://lynkeus.io
          LYNKEUS_REPORTS_KEY: ${{ secrets.LYNKEUS_REPORTS_KEY }}
```

`--attach-timeout` le da a la app más tiempo para conectarse: el valor predeterminado es de 15 segundos y un host recién lanzado tarda más en estar listo. Los casos más largos se toman primero, para que los trabajos terminen juntos.

Con trabajos en paralelo, asegúrate de que cada caso cree sus propios datos. Dos casos que comparten un usuario se pisan.

## Saber qué pantallas toca un pull request

Hay una pieza que sí viene lista. Este comando escribe un flujo de trabajo en tu repositorio:

```bash
npx lynkeus map ci
```

```text
wrote .github/workflows/lynkeus-map-check.yml
```

En cada pull request, ese flujo construye el mapa de la app a partir del código (sin app ni dispositivo), ejecuta `map check` contra la rama base y mantiene actualizado un único comentario con las pantallas que el cambio alcanza. Sirve para decidir qué casos importan en esa rama. `--depth <n>` fija a cuántas importaciones de distancia mira (2 por defecto) y `--force` sobrescribe el archivo si ya existe.

## Si usas un simulador o un emulador

El job tiene más trabajo antes de llegar a lynkeus: compilar el build de depuración, encender el dispositivo virtual, instalar la app y abrirla. Eso depende de tu proyecto y de tu sistema de CI. Lo que lynkeus necesita saber es poco:

- **Solo builds de depuración.** En iOS, además, la Nueva Arquitectura. En Android, la app debe ser depurable; de lo contrario el agente se niega a funcionar.
- **Un dispositivo virtual, no uno físico.** El CLI busca un simulador o un emulador encendido. Los dispositivos físicos no están soportados.
- **La app es quien se conecta.** Marca a `localhost:8123` en el simulador de iOS y a `10.0.2.2:8123` en el emulador de Android. Durante los primeros 3 segundos reintenta cada 100 ms; después espacia los intentos hasta un máximo de 1,5 segundos. No hay que abrir ningún puerto hacia la app.
- **El token se escribe en el bundle.** En una app de React Native lo escribe el plugin `lynkeus-agent/babel` cuando Metro transforma el código, así que el paso que arranca Metro necesita `LYNKEUS_TOKEN` con el mismo valor que el paso que ejecuta los casos. En Expo, la variable de la app es `EXPO_PUBLIC_LYNKEUS_TOKEN`. Un bundle de producción nunca recibe el token.
- **Un token vacío apaga el agente.** Si la app pasa un token y le llega vacío, el agente no arranca y lo dice en el log de la app: `lynkeus: the app passed a token and it is empty`. En el job se ve como una app que nunca se conecta.

Con la app instalada, el comando cambia poco:

```bash
npx lynkeus case run --launch --app com.example.myapp --out run --screenshots --push
```

`--launch --app <bundleId>` reinicia la app antes de conectarse. Aquí `--screenshots` sí produce una imagen por paso. `--video` filma solo donde el host ofrece un comando `record`, y una sesión de simulador o de emulador no lo ofrece: la ejecución conserva sus capturas y no tiene película.

## Cómo funciona

`case run --host` lanza el host como un proceso hijo y espera a que diga que está listo, hasta 180 segundos. El host renderiza tu app en Node con React Native Testing Library; el agente que vive dentro marca hacia afuera igual que en un dispositivo, y a partir de ahí todos los comandos funcionan sin cambios. Al terminar, `case run` detiene el host y el comando de fixtures.

## Problemas frecuentes

**`the host did not come up within 180 s: …` o `the host failed to start: …`.** Lo que sigue a los dos puntos son las últimas líneas del host. Casi siempre es un módulo nativo sin doble de prueba. Ejecuta `npx lynkeus headless doctor` en tu máquina; para un error de jest que no reconoces, `npx lynkeus headless doctor --explain "<primera línea>"` lo traduce a su causa habitual.

**La app nunca sale de la pantalla de inicio.** Además del módulo nativo faltante, hay otra causa propia de CI: Node resuelve `localhost` a IPv6 mientras tu backend escucha en IPv4. Usa `127.0.0.1` en la dirección del backend.

**Un cambio en una variable de entorno no tiene efecto.** Si tu configuración de babel incrusta las variables de entorno, la caché de transformaciones de jest conserva el primer valor que vio. Borra el directorio de caché al que apunta tu configuración de jest, o no lo guardes entre ejecuciones.

**El host rechaza las peticiones al backend.** Con la red real activada, el host solo permite los destinos de `networkHosts`, que por defecto son los locales. Es deliberado: evita que una suite automatizada termine apuntando a producción. El backend del job debe estar en `127.0.0.1` o `localhost`.

**El host no arranca y pide el token.** `headless start` se niega a correr sin `LYNKEUS_TOKEN`. Revisa que el secreto esté expuesto en ese paso.

**La memoria crece en suites largas.** El host sin pantalla pierde unas decenas de MB por cada reinicio completo de la app. Una suite de cientos de casos debe reiniciar el host de vez en cuando; `npx lynkeus call memory` informa cuánto lleva.

**Dos ejecuciones pelean por el puerto.** En un runner compartido, fija `LYNKEUS_PORT` con un valor distinto en cada job, tanto para el host como para quien lo maneja.

## Siguientes pasos

- [Reportes](/es/guides/reports/): qué muestra el enlace que deja el job.
- [Tests intermitentes](/es/guides/flaky-tests/): qué hacer cuando un caso pasa en el reintento.
- [Trazas del backend](/es/guides/backend-traces/): agregar al reporte lo que hizo el servidor.
- [Variables de entorno](/es/reference/environment-variables/): todo lo que puede configurar un job.
