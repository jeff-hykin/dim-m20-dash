# dim-m20-dash (M20 Ctrl)

A DimOS Desktop app for the Deep Robotics Lynx M20: one panel per onboard computer (GOS, AOS, NOS/.106), recording to
mcap, and a blueprint mode that watches and commands a running dimos blueprint through the dimos gateway.

## Layout

- `backend/` (Deno, no dependencies at runtime): `main.ts` serves the API and `frontend/`; `routes.ts` is every endpoint
  (dimos.yaml's `provides:` repeats them: `deno task check-endpoints [--write]`).
  - `stats.ts`: the stats loop each board runs over ssh, and its parser. `boards.ts`: one source per board (ssh or
    fake), a TCP probe of port 22, the indicators. `fake.ts`: simulated boards whose state changes over time.
  - `blueprint.ts`: blueprint mode (GET active, active/streams, peek, active/modules; motion = M20Connection's RPCs).
  - `basic_server.ts`: the vendor basic_server protocol (frames, tables), shared with `m20tool/`.
  - `robot.ts`: the M20's own status (motion, gait, charging, e-stop, batteries, joint temperatures, errors) from AOS's
    basic_server reports (UDP 10.21.31.103:30000). On its own it sends only the heartbeat (`robot_test.ts` checks);
    commands go through its command() / usageMode() from `direct.ts` only. Needs `--unstable-net`. With the fake boards
    it simulates the robot (starts sitting, regular control mode).
  - `direct.ts`: driving readiness per mode, Enable driving (`m20 stand` / `m20 direct`: the robot resets its usage mode
    on every stand and undock, so the CLI sets it after standing), stand up / undock through `m20`, and direct mode's
    axis-command loop.
  - `recording.ts` + `mcap.ts`: the Record button's mcap (copied from G1 Ctrl), with the Record options of
    `record_streams.ts` (stream groups, rate caps, label, folder, splitting). The live topics come raw through
    `zenoh_tap.py`, which `tap.ts` runs with DIMOS_APP's `dimosPython` against its `zenohConnect` (subscribe only).
    `syslogs.ts`: the recording's system logs (Go2 Ctrl's health.rs for each board, over one more read-only ssh while
    recording: health every 2 s, journal warnings, network-safety, AOS's basic_server log, health dumps). `settings.ts`:
    `<dataDir>/settings.json`.
- `m20tool/`: the M20 setup + robot CLI (Deno, compiled per target, released as `m20tool-v<version>`, installed on its
  own by `m20tool/install.sh`; on the boards `~/.local/bin/m20`, which M20 Ctrl calls, runs it). See its README.md.
- `frontend/` (React + Vite, like G1 Ctrl and Go2 Ctrl; `frontend/dist` is built and committed so no robot builds it):
  `src/App.tsx` the page (main view = camera or 3D, panels on the left, command dock, d-pad / phone thumb sticks);
  `live.ts` the live topics through Desktop's zenoh-gateway (pose from tf/slam_odom, slam_body_points, local_map,
  command_ready, front/rear cameras) and the fake world used with the fake boards; `drive.ts` the drive loop (a Twist on
  the blueprint's `tele_cmd_vel` at 20 Hz, gateway deadman, nothing while idle); `scene3d.ts` the three.js view;
  `camera.ts` JPEG / H.265 decoding; `gamepad.ts` (Go2 Ctrl's), `ThumbStick.tsx` + `stick.ts` (dimos-react's);
  `dim-app/source/` vendored dim-app (theme, zenoh). Desktop's theme tokens only.

## Try a change

- `deno task test` (fake ssh, fake boards, a fake dimos gateway, and the drive loop against a stand-in zenoh client: no
  robot needed). After a frontend change: `deno task build` (tsc + vite into `frontend/dist`) and commit `dist` too.
- `deno task fake` → http://localhost:8788 with simulated boards; add `M20_DASH_DESKTOP_URL=http://127.0.0.1:5555` to
  use a running Desktop's dimos gateway (blueprint mode).
- No blueprint to hand: `deno task fake-gateway` (a stand-in dimos gateway with an M20 blueprint, port 8790) and
  `deno task demo` (fake boards against it). With the fake boards the page also fakes the robot: a room, a lidar scan,
  test-card cameras, and a pose the drive moves; nothing goes to zenoh.
- Installed: edit `~/.dimos/apps/dim-m20-dash`, `nix build .#dimosApp`, then
  `curl -fsS -X POST localhost:5555/gateways/desktop/management/apps/dim-m20-dash/reload`.

## Rules

- Motion only from a request (a click, a held key/stick, an agent call). Stand up / lie down / dock / Enable driving
  always ask first; driving sends only while an input is held, with a deadman (the gateway's in blueprint mode,
  `direct.ts`'s move hold in direct mode).
- Two ways to drive (`direct.ts` has the details): blueprint mode publishes tele_cmd_vel for the running blueprint (the
  robot must be in navigation control mode, RL control); direct mode sends the vendor's axis commands to basic_server
  (regular control mode, standing). `readiness()` says what's in the way; Enable driving (POST api/drive/enable) fixes
  it (`m20 stand` in blueprint mode). Blueprint mode is the default whenever a blueprint run starts.
- On a robot don't build there (no `nix build`, `deno install`): cross build, rsync, hot-load
  ([edge compute](https://github.com/jeff-hykin/dimos-desktop-mirror/blob/main/docs/create-apps/edge-compute.md)).
