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

## Por qué la interfaz es limitada

El Harness Host ya restringe su propia ruta `/api` a autoridades de loopback y
exige un token de lanzamiento o una cookie de sesión firmada. Este plugin no toca
esa ruta, no modifica el bind del servidor web y no lee la cookie de sesión del
Harness. Abre su propio listener, lo autentica con sus propios tokens de
dispositivo y llama a los métodos Remote en proceso como el operador.

## Configuración

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

## Emparejamiento

Tras el inicio, el plugin registra la URL de emparejamiento y la escribe en
`<stateDir>/pairing.txt`. Ábrela una vez en el teléfono; la página envía el
código y el secreto a `/pair` y almacena el token devuelto en `localStorage`.
Cada código de emparejamiento es de un solo uso y caduca. Los tokens de
dispositivo se almacenan solo como resúmenes SHA-256, y `/operator/revoke`
(solo para llamadas de loopback) revoca un dispositivo o todos ellos.

## Superficie HTTP

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
| GET | `/operator/code`, `/operator/devices` | Emparejamiento y lista solo por loopback. |
| POST | `/operator/revoke` | Revocación solo por loopback. |

## Notas de seguridad

Enlazar a la interfaz ZeroTier significa que todos los dispositivos de esa red
virtual pueden abrir el puerto; el token de dispositivo es la única barrera
delante de un agente que puede ejecutar comandos de shell y editar archivos.
Mantén restringida la pertenencia a la red ZeroTier, rota los tokens revocando y
volviendo a emparejar, y trata `pairing.txt` como una credencial.

## License

MIT
