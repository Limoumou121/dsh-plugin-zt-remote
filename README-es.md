# dsh-plugin-zt-remote

Una superficie remota exclusiva de ZeroTier para DeepSeek Harness. Enlaza un
único listener HTTP a la interfaz ZeroTier de la máquina que ejecuta el Harness
Host, y sirve una página de teléfono que puede:

- listar espacios de trabajo y crear uno a partir de una ruta del host;
- listar sesiones, iniciar una sesión en un espacio de trabajo y reabrir una conversación existente;
- enviar un prompt que continúa una conversación existente, o cancelar su turno en ejecución;
- seguir la salida en streaming y ver la actividad de las herramientas;
- emparejar un dispositivo mediante un código de un solo uso y revocarlo más tarde.

El plano de configuración está deliberadamente ausente. No hay página de ajustes,
ni ruta de credenciales, ni ruta de proveedores de modelos, ni selector de
directorios: el plugin solo alcanza los métodos Remote que necesitan las acciones
anteriores, de modo que un dispositivo emparejado no puede reconfigurar el
Harness aunque pueda impulsar tareas.

## Why the interface is narrow

El Harness Host ya restringe su propia ruta `/api` a autoridades de loopback y
exige un token de lanzamiento o una cookie de sesión firmada. Este plugin no toca
esa ruta, no modifica el bind del servidor web y no lee la cookie de sesión del
Harness. Abre su propio listener, lo autentica con sus propios tokens de
dispositivo y llama a los métodos Remote en proceso como el operador.

## Sidebar panel

El panel vive en la barra lateral. DSH compone el bundle del navegador al arrancar, así que un cambio de cliente exige **reiniciar en frío**; el panel lista espacios de trabajo, crea uno por ruta escrita y muestra el registro de dispositivos con revocación. Un teléfono carga el panel desde el listener de este plugin, por lo que las rutas son del mismo origen; una página del Host no las responde y el panel lo indica en línea.

## Configuration

Todo es configurable desde el `cordis.patch.yml` del perfil:

```yaml
- id: zt-remote
  config:
    listenPort: 8790
    interfaceHint: zerotier
    pairCodeTtlSeconds: 600
    deviceTokenDays: 30
```

| Campo | Predeterminado | Significado |
| --- | --- | --- |
| `enabled` | `true` | Sirve mientras el plugin está cargado. |
| `listenAddress` | `''` | Bind IPv4 explícito. Vacío lo detecta automáticamente. |
| `listenPort` | `8790` | Puerto TCP. |
| `interfaceHint` | `zerotier` | Subcadena del nombre de la interfaz, sin distinción de mayúsculas, para la detección automática. |
| `pairCodeTtlSeconds` | `600` | Vida útil de un código de emparejamiento. |
| `deviceTokenDays` | `30` | Vida útil de un token de dispositivo emitido. |
| `bodyLimitBytes` | `1048576` | Cuerpo máximo de la solicitud. |
| `historyPageLimit` | `60` | Mensajes por página de historial. |
| `stateDir` | `''` | Directorio de dispositivos emparejados; vacío usa `$DSH_HOME/plugin-data/dsh-plugin-zt-remote`. |

La detección automática se niega a iniciar cuando ninguna interfaz coincide, o
cuando coinciden varias: una superficie que puede ejecutar comandos de shell
nunca debe ampliarse a todas las interfaces porque la detección falló.

## Access

Con `autoAccess` (por defecto) el teléfono abre la dirección fija `http://<dirección ZeroTier>:8790/` y entra en la interfaz oficial, sin código de emparejamiento ni token en la URL. Cualquier equipo que alcance el puerto se admite y queda en el registro, así que **la red ZeroTier es la única frontera**; `autoAccess: false` restaura el emparejamiento.

## Pairing (with `autoAccess: false`)

Tras el inicio, el plugin registra la URL de emparejamiento y la escribe en
`<stateDir>/pairing.txt`. Ábrela una vez en el teléfono; la página envía el
código y el secreto a `/pair` y almacena el token devuelto en `localStorage`.
Cada código de emparejamiento es de un solo uso y caduca. Los tokens de
dispositivo se almacenan solo como resúmenes SHA-256, y `/operator/revoke`
(requiere la clave de operador; loopback sin clave) revoca un dispositivo o todos ellos.

## HTTP surface

| Método | Ruta | Propósito |
| --- | --- | --- |
| GET | `/` | Página del teléfono. |
| GET | `/hello` | Identidad y capacidades. |
| POST | `/pair` | Canjear código y secreto por un token de dispositivo. |
| GET | `/workspaces` | Lista de espacios de trabajo. |
| POST | `/workspaces` | Crear un espacio de trabajo a partir de `{ path }`. |
| GET | `/sessions` | Lista de sesiones. |
| POST | `/sessions` | Crear una sesión a partir de `{ workspaceId?, cwd?, agentPreset? }`. |
| GET | `/sessions/:id/messages` | Página de historial alineada con los mensajes. |
| POST | `/sessions/:id/prompt` | Continuar la conversación con `{ text, mode? }`. |
| POST | `/sessions/:id/cancel` | Cancelar el turno en ejecución. |
| GET | `/sessions/:id/events` | Eventos enviados por el servidor: instantánea del historial más tramas. |
| GET | `/operator/code`, `/operator/devices` | Emparejamiento y lista con la clave de operador (loopback sin clave). |
| POST | `/operator/revoke` | Revocación con la clave de operador (loopback sin clave). |

## Approvals

El Host despacha `approval/request` por waterfall; el plugin mantiene la decisión hasta 60 segundos mientras el teléfono responde. `POST /answers` con `allow: true` devuelve `allowed-once` y `false` devuelve `rejected`; un tiempo agotado, un teléfono revocado o la descarga del plugin devuelven la decisión al escritorio.

## Security notes

Enlazar a la interfaz ZeroTier significa que todos los dispositivos de esa red
virtual pueden abrir el puerto; el token de dispositivo es la única barrera
delante de un agente que puede ejecutar comandos de shell y editar archivos.
Mantén restringida la pertenencia a la red ZeroTier, rota los tokens revocando y
volviendo a emparejar, y trata `pairing.txt` como una credencial.

## Verification status

`lib/tests/all.test.js` ejecuta 78 pruebas unitarias y los cuatro scripts de aceptación corren contra un Host activo. `/hello` informa `build` y `hostBase` para distinguir una versión obsoleta de un puerto equivocado; los cambios de cliente requieren un reinicio en frío.

## License

MIT
