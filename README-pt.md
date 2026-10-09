# dsh-plugin-zt-remote

Uma superfície remota somente ZeroTier para o DeepSeek Harness. Ela vincula um único listener HTTP à
interface ZeroTier da máquina que executa o Harness Host e serve uma
página para celular que pode:

- listar workspaces e criar um a partir de um caminho do host;
- listar sessões, iniciar uma sessão em um workspace e reabrir uma conversa existente;
- enviar um prompt que continua uma conversa existente, ou cancelar seu turno em execução;
- acompanhar a saída em streaming e ver a atividade das ferramentas;
- parear um dispositivo por meio de um código de uso único e revogá-lo depois.

O plano de configuração está deliberadamente ausente. Não há página de configurações, nem rota de
credenciais, nem rota de provedor de modelo, nem seletor de diretórios: o plugin
acessa apenas os métodos Remote de que as ações acima precisam, de modo que um dispositivo pareado
não pode reconfigurar o Harness, ainda que possa conduzir tarefas.

## Por que a interface é restrita

O Harness Host já protege sua própria rota `/api` para autoridades de loopback e
exige um token de lançamento ou um cookie de sessão assinado. Este plugin não toca
nessa rota, não altera o bind do servidor web e não lê o cookie de sessão
do Harness. Ele abre seu próprio listener, autentica-o com seus próprios tokens
de dispositivo e chama os métodos Remote em processo como o operador.

## Configuração

Tudo é configurável a partir do `cordis.patch.yml` do perfil:

```yaml
- id: zt-remote
  config:
    listenPort: 8790
    interfaceHint: zerotier
    pairCodeTtlSeconds: 600
    deviceTokenDays: 30
```

| Campo | Padrão | Significado |
| --- | --- | --- |
| `enabled` | `true` | Servir enquanto o plugin estiver carregado. |
| `listenAddress` | `''` | Bind IPv4 explícito. Vazio detecta automaticamente. |
| `listenPort` | `8790` | Porta TCP. |
| `interfaceHint` | `zerotier` | Substring do nome da interface, sem diferenciar maiúsculas de minúsculas, para detecção automática. |
| `pairCodeTtlSeconds` | `600` | Tempo de vida de um código de pareamento. |
| `deviceTokenDays` | `30` | Tempo de vida de um token de dispositivo emitido. |
| `bodyLimitBytes` | `1048576` | Corpo máximo da requisição. |
| `historyPageLimit` | `60` | Mensagens por página de histórico. |
| `stateDir` | `''` | Diretório de dispositivos pareados; vazio usa `$DSH_HOME/plugin-data/dsh-plugin-zt-remote`. |

A detecção automática se recusa a iniciar quando nenhuma interface corresponde, ou quando várias
correspondem: uma superfície que pode executar comandos de shell nunca deve se ampliar para todas as
interfaces porque a detecção falhou.

## Pareamento

Após a inicialização, o plugin registra a URL de pareamento e a grava em
`<stateDir>/pairing.txt`. Abra-a uma vez no celular; a página envia o código e o
segredo para `/pair` e armazena o token retornado em `localStorage`. Todo código de pareamento
é de uso único e expira. Os tokens de dispositivo são armazenados apenas como digests SHA-256,
e `/operator/revoke` (somente chamadores de loopback) revoga um dispositivo ou todos eles.

## Superfície HTTP

| Método | Caminho | Finalidade |
| --- | --- | --- |
| GET | `/` | Página para celular. |
| GET | `/hello` | Identidade e capacidades. |
| POST | `/pair` | Trocar código e segredo por um token de dispositivo. |
| GET | `/workspaces` | Lista de workspaces. |
| POST | `/workspaces` | Criar um workspace a partir de `{ path }`. |
| GET | `/sessions` | Lista de sessões. |
| POST | `/sessions` | Criar uma sessão a partir de `{ workspaceId?, cwd?, agentPreset? }`. |
| GET | `/sessions/:id/messages` | Página de histórico alinhada a mensagens. |
| POST | `/sessions/:id/prompt` | Continuar a conversa com `{ text, mode? }`. |
| POST | `/sessions/:id/cancel` | Cancelar o turno em execução. |
| GET | `/sessions/:id/events` | Server-sent events: snapshot do histórico mais frames. |
| GET | `/operator/code`, `/operator/devices` | Pareamento e lista somente via loopback. |
| POST | `/operator/revoke` | Revogação somente via loopback. |

## Notas de segurança

Vincular à interface ZeroTier significa que todo dispositivo nessa rede virtual pode
abrir a porta; o token de dispositivo é a única barreira diante de um agente que pode
executar comandos de shell e editar arquivos. Mantenha a participação na rede ZeroTier
restrita, rotacione tokens revogando e pareando novamente, e trate
`pairing.txt` como uma credencial.

## License

MIT
