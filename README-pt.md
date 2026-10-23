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

## Why the interface is narrow

O Harness Host já protege sua própria rota `/api` para autoridades de loopback e
exige um token de lançamento ou um cookie de sessão assinado. Este plugin não toca
nessa rota, não altera o bind do servidor web e não lê o cookie de sessão
do Harness. Ele abre seu próprio listener, autentica-o com seus próprios tokens
de dispositivo e chama os métodos Remote em processo como o operador.

## Sidebar panel

O painel fica na barra lateral. O DSH monta o bundle do navegador na inicialização, então mudanças de cliente exigem **reinício a frio**; o painel lista espaços de trabalho, cria um pelo caminho digitado e mostra o registro de dispositivos com revogação. O telefone carrega o painel pelo listener deste plugin, então as rotas são de mesma origem; uma página do Host não as responde e o painel informa isso em linha.

## Configuration

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

## Access

Com `autoAccess` (padrão) o telefone abre o endereço fixo `http://<endereço ZeroTier>:8790/` e entra na interface oficial, sem código de pareamento nem token na URL. Qualquer máquina que alcance a porta é admitida e registrada, então **a rede ZeroTier é a única fronteira**; `autoAccess: false` restaura o pareamento.

## Pairing (with `autoAccess: false`)

Após a inicialização, o plugin registra a URL de pareamento e a grava em
`<stateDir>/pairing.txt`. Abra-a uma vez no celular; a página envia o código e o
segredo para `/pair` e armazena o token retornado em `localStorage`. Todo código de pareamento
é de uso único e expira. Os tokens de dispositivo são armazenados apenas como digests SHA-256,
e `/operator/revoke` (requer a chave de operador; loopback sem chave) revoga um dispositivo ou todos eles.

## HTTP surface

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
| GET | `/operator/code`, `/operator/devices` | Pareamento e lista com a chave de operador (loopback sem chave). |
| POST | `/operator/revoke` | Revogação com a chave de operador (loopback sem chave). |

## Approvals

O Host despacha `approval/request` por waterfall; o plugin mantém a decisão por até 60 segundos enquanto o telefone responde. `POST /answers` com `allow: true` devolve `allowed-once` e `false` devolve `rejected`; tempo esgotado, telefone revogado ou descarga do plugin devolvem a decisão ao desktop.

## Security notes

Vincular à interface ZeroTier significa que todo dispositivo nessa rede virtual pode
abrir a porta; o token de dispositivo é a única barreira diante de um agente que pode
executar comandos de shell e editar arquivos. Mantenha a participação na rede ZeroTier
restrita, rotacione tokens revogando e pareando novamente, e trate
`pairing.txt` como uma credencial.

## Verification status

`lib/tests/all.test.js` executa 78 testes unitários e os quatro scripts de aceitação rodam contra um Host ativo. `/hello` informa `build` e `hostBase` para distinguir versão obsoleta de porta errada; mudanças de cliente exigem reinício a frio.

## License

MIT
