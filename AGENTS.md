# dim-m20-dash (M20 Ctrl)

A DimOS Desktop app for the Deep Robotics Lynx M20: one panel per onboard computer (GOS, AOS, NOS/.106), recording to
mcap, and a blueprint mode that watches and commands a running dimos blueprint through the dimos gateway.

## Layout

- `backend/` (Deno, no dependencies at runtime): `main.ts` serves the API and `frontend/`; `routes.ts` is every
  endpoint (dimos.yaml's `provides:` repeats them: `deno task check-endpoints [--write]`).
  - `stats.ts`: the stats loop each board runs over ssh, and its parser. `boards.ts`: one source per board (ssh or
    fake), a TCP probe of port 22, the indicators. `fake.ts`: simulated boards whose state changes over time.
  - `blueprint.ts`: blueprint mode (GET active, active/streams, peek, active/modules; motion = M20Connection's RPCs).
  - `recording.ts` + `mcap.ts`: the Record button's mcap (copied from G1 Ctrl). `settings.ts`: `<dataDir>/settings.json`.
- `frontend/`: plain JS + CSS, no build; Desktop's theme tokens only.

## Try a change

- `deno task test` (fake ssh, fake boards, a fake dimos gateway: no robot needed).
- `deno task fake` → http://localhost:8788 with simulated boards; add `M20_DASH_DESKTOP_URL=http://127.0.0.1:5555`
  to use a running Desktop's dimos gateway (blueprint mode).
- Installed: edit `~/.dimos/apps/dim-m20-dash`, `nix build .#dimosApp`, then
  `curl -fsS -X POST localhost:5555/gateways/desktop/management/apps/dim-m20-dash/reload`.

## Rules

- Motion only from a request (a click, an agent call), only through the blueprint. Direct mode has no motion: the
  M20's own control protocol isn't implemented here, and none should be guessed.
- On a robot don't build there (no `nix build`, `deno install`): cross build, rsync, hot-load
  ([edge compute](https://github.com/jeff-hykin/dimos-desktop-mirror/blob/main/docs/create-apps/edge-compute.md)).
