# Changelog

## 0.1.1

Compatibility and proxy fixes found against a live Host across several restarts.

- **Host origin detection.** `hostBase` defaults to detection from the live `webServer`
  service (`protocol`/`port`). The desktop Host picks a port per launch, so the previous
  fixed default reached a closed port after a restart and the Web UI answered
  `webui/host-session-unavailable`. `/hello` now reports the resolved origin under
  `value.hostBase`.
- **Owner Peer on every Gateway call.** The Gateway requires a `PeerScope` per
  invocation and reads its `principal` and `signal`; calls without one failed with
  `Cannot read properties of undefined (reading 'signal')`. The plugin now creates one
  owner peer and disposes it with the plugin.
- **Prefix is stripped before forwarding.** An origin-root asset URL from a client
  plugin was forwarded with the Web UI prefix attached, so the Host answered 404. The
  prefix now decides only that a request is proxied.
- **Documentation.** Five-language READMEs share one heading set, the sidebar panel is
  documented, and the operator routes are described by their key requirement rather
  than as loopback-only. Display metadata (`./icon`, locale exports) and
  `packageManager` are declared for the Plugin Manager.

## 0.1.0

Initial surface: the official Web UI proxied onto a ZeroTier address, workspace and
session routes, prompt continuation, file upload and attachment reads, approval
answers, device pairing and revocation, and a sidebar client plugin.
