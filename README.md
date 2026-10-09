# dsh-plugin-zt-remote

A ZeroTier-only remote surface for DeepSeek Harness. It binds one HTTP listener to
the ZeroTier interface of the machine running the Harness Host, and serves a
phone page that can:

- list workspaces and create one from a host path;
- list sessions, start a session in a workspace, and reopen an existing conversation;
- send a prompt that continues an existing conversation, or cancel its running turn;
- follow streaming output and see tool activity;
- pair a device through a one-time code and revoke it later.

The configuration plane is deliberately absent. There is no settings page, no
credential route, no model-provider route, and no directory picker: the plugin
reaches only the Remote methods that the actions above need, so a paired device
cannot reconfigure the Harness even though it can drive tasks.

## Why the interface is narrow

The Harness Host already fences its own `/api` route to loopback authorities and
requires a launch token or a signed session cookie. This plugin does not touch
that route, does not change the webserver bind, and does not read the Harness
session cookie. It opens its own listener, authenticates it with its own device
tokens, and calls the Remote methods in-process as the operator.

## Sidebar panel

The package also ships a browser half (`lib/client.js`, exported as `./client`). It
registers one sidebar entry and its main-area page, so the same three operations are
reachable from the official interface instead of a floating link:

| Slot | Id | What it renders |
| --- | --- | --- |
| `sidebar.panellist` | `zt-remote` | The globe glyph and the `远程管理` entry. |
| `main` | `zt-remote` (the `key`) | The panel itself. |

The panel has three sections: the registered workspace list with a reload action, a
typed-path workspace form, and the device roster with its operator-key field, a
per-device revoke, and revoke-all. Every result — including a refused key, a
transport failure, and a non-JSON reply — renders as inline text; the component
never throws and never blanks the slot.

Both halves reach the same routes `lib/server.js` already served:

| Method | Path | Caller |
| --- | --- | --- |
| GET | `/workspaces` | Panel: workspace roster. |
| POST | `/workspaces` | Panel: create from `{ path }`. |
| GET | `/operator/devices` | Panel: device roster, with `x-zt-operator-key`. |
| POST | `/operator/revoke` | Panel: `{ deviceId }`, or no body for every device. |

A phone loads the panel from this plugin's own listener, so those are the literal
same-origin routes and the device cookie rides along, exactly as the standalone page
at `/ui/manage` already worked. A desktop page is served by the Host origin, where
nothing answers `/workspaces`; `lib/web-bridge.js` therefore registers one
`ctx.webServer` prefix route (`/zt-remote`) that answers the same four paths by
calling the plugin's own services in-process. That bridge is loopback-only, mounts
nothing else — no session, prompt, event, or approval route — and never hands the
operator key to the browser. In a composition without a Web server (a headless
profile) it is skipped and the panel reports the failure inline.

`/ui/manage` remains a valid standalone page; the plugin no longer injects a link to
it into the proxied shell.

**Client-plugin changes need a cold restart of DSH.** The browser bundle is read when
the page composes its entry graph, so a restart of the Host is what publishes a changed
`lib/client.js`; reloading the browser alone keeps running the previous bundle, and
editing the file while a session is live does not remount the row either.

## Configuration

Everything is configurable from the profile's `cordis.patch.yml`:

```yaml
- id: zt-remote
  config:
    listenPort: 8790
    interfaceHint: zerotier
    pairCodeTtlSeconds: 600
    deviceTokenDays: 30
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Serve while the plugin is loaded. |
| `listenAddress` | `''` | Explicit IPv4 bind. Empty auto-detects. |
| `listenPort` | `8790` | TCP port. |
| `interfaceHint` | `zerotier` | Case-insensitive interface-name substring for auto-detection. |
| `pairCodeTtlSeconds` | `600` | Lifetime of one pairing code. |
| `deviceTokenDays` | `30` | Lifetime of an issued device token. |
| `bodyLimitBytes` | `1048576` | Maximum request body. |
| `historyPageLimit` | `60` | Messages per history page. |
| `stateDir` | `''` | Paired-device directory; empty uses `$DSH_HOME/plugin-data/dsh-plugin-zt-remote`. |

Auto-detection refuses to start when no interface matches, or when several do:
a surface that can execute shell commands must never widen to every interface
because detection failed.

## Access

Open the ZeroTier address and the official Web UI answers — no pairing code, no
token in the URL, the same feel as `http://127.0.0.1:19387` on this machine:

```
http://192.0.2.10:8790/          → 303 → the official Web UI at /ui/
```

`autoAccess` (default on) admits any peer that can reach the listener and records
it in the device roster with the peer address as its name, so it can still be
revoked later:

```
http://192.0.2.10:8790/operator/devices?key=<operator key>
```

**The ZeroTier network is then the only boundary.** Anyone who can reach the
listener can drive the agent, so keep the network's membership restricted. Set
`autoAccess: false` to restore the pairing gate; the listener then requires a
device cookie, obtained from the pairing page at `/` or from
`/ui/login?token=<device token>`.

The operator key exists because the listener binds the ZeroTier address only: no
loopback peer can ever reach `/operator/*`, so `pairing.txt` is the local path to
pairing material and to device revocation.

## Pairing (with `autoAccess: false`)

The plugin logs the pairing URL and writes two lines to `<stateDir>/pairing.txt`:
the URL, then the operator key.

```
http://192.0.2.10:8790/#p=ABCD-2345.<secret>
<operator key>
```

Open the URL once on the phone; the page posts the code and secret to `/pair`,
receives a device cookie, and lands on the official UI. Every pairing code is
single-use and expires.

```
http://192.0.2.10:8790/operator/code?key=<operator key>
http://192.0.2.10:8790/operator/devices?key=<operator key>
POST http://192.0.2.10:8790/operator/revoke?key=<operator key>   {"deviceId":"…"}
```

`/operator/code` mints a fresh code when the previous one is gone, so a spent or
expired code never needs a restart. Device tokens are stored only as SHA-256
digests, and the operator key lives only in that 0600 file and the Host log.

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Phone page. |
| GET | `/hello` | Identity and capabilities. |
| POST | `/pair` | Exchange code and secret for a device token. |
| GET | `/workspaces` | Workspace roster, read from the opening `workspace/follow` baseline. |
| POST | `/workspaces` | Create a workspace from `{ path }`. |
| GET | `/sessions` | Session roster. |
| POST | `/sessions` | Create a session from `{ workspaceId?, cwd?, agentPreset? }`. |
| GET | `/sessions/:id/messages` | Message-aligned history page. |
| POST | `/sessions/:id/prompt` | Continue the conversation with `{ text, mode? }`. |
| POST | `/sessions/:id/cancel` | Cancel the running turn. |
| GET | `/sessions/:id/events` | Server-sent events: history snapshot, frames, and approval notices. |
| GET | `/events` | Server-sent events for pending approvals without a session open. |
| GET | `/approvals` | Approval asks still waiting for a phone answer. |
| POST | `/answers` | Answer one ask with `{ requestId, allow }`. |
| GET | `/operator/code`, `/operator/devices` | Operator-key pairing material and roster. |
| POST | `/operator/revoke` | Operator-key device revocation. |

On the Host origin the same four workspace and device paths are also reachable under
the bridge prefix (`/zt-remote/workspaces`, `/zt-remote/operator/devices`,
`/zt-remote/operator/revoke`) for a loopback page; see [Sidebar panel](#sidebar-panel).

## Approvals

The Host dispatches `approval/request` through a waterfall and awaits the
result, so this plugin registers one listener that holds the decision open for
up to 60 seconds while the phone answers:

- the ask is published to every open phone stream as `approval` with the tool
  name and reason;
- `POST /answers` with `allow: true` returns `allowed-once`, which grants only
  the action asked about; `allow: false` returns `rejected`;
- no answer, a revoked phone, a timeout, or plugin unload delegates to the
  desktop answerers instead, so the desktop keeps working exactly as before;
- the session's approval policy still decides first: under `never` no answerer
  sees the ask at all, and a phone cannot override it.

## Security notes

Binding to the ZeroTier interface means every device on that virtual network can
open the port; the device token is the only fence in front of an agent that can
run shell commands and edit files. Keep the ZeroTier network membership
restricted, rotate tokens by revoking and re-pairing, and treat
`pairing.txt` as a credential.

## Verification status

`verify.mjs` runs the whole surface end to end against a live Host and passes:

```
node verify.mjs
  ✔ plugin answers /hello
  ✔ module generation is r11-acceptance
  ✔ a request without a device token is refused — 401
  ✔ operator key mints a pairing code
  ✔ pairing issues a device token — 43 chars
  ✔ workspace roster is readable — 7 workspaces
  ✔ a workspace can be created
  ✔ session roster is readable — 55 sessions
  ✔ a conversation can be created
  ✔ a prompt is accepted
  ✔ the turn produced an assistant message — user,assistant,turn-end
  ✔ the event stream delivers frames
  ✔ the approval desk answers
  ✔ a device can pair after a revoke cycle
  ✔ this run owns exactly one row with its name
  ✔ the paired device can be revoked
  ✔ a revoked token stops working — 401
全部通过
```

Four wire facts were learned only by running against the real Gateway, and each is now
pinned by a test:

- `session/list` names its parameter `_request` and answers `{ items }`, not `{ sessions }`.
- The workspace roster is the `items` array of the `workspace/follow` baseline frame;
  `workspace/list` does not exist.
- `session/follow` accepts `assistantStream` only as `true` or omitted — `false` fails
  boundary validation. History is read from that stream's opening snapshot, because
  `session/page` needs a `throughSeq` bound to the log's head that a caller cannot know.
- The persisted record format is `{ type, seq, time, data }`: the kind field is `type`,
  not `kind`. Runtime-context, skill, and time-sample messages arrive as `user/message`
  with a different `source.kind` and are filtered out of the phone transcript.

Load a changed plugin module with a Host restart: HMR reloads the profile configuration
and remounts the row, but it does not re-import a changed module. `/hello` reports a
`build` id so a stale generation is visible instead of silently misbehaving.

## License

MIT
