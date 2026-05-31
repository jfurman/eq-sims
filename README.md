# EQ Guild Agent

AI-orchestrated guild for a private EQEmu server. The **brain** (laptop) decides and emits
**intents** over the LAN; the **executor** (32 GB box) relays them into the running clients via a
**MacroQuest Lua bridge**. Intents cross the LAN — keystrokes never do. See `CLAUDE.md` for the build
brief and `docs/simplayer-eqemu-design.md` for the architecture.

```
brain/emit.js  --TCP (LAN)-->  executor/executor.js  --queue.tsv-->  mqbridge/bridge.lua  --mq.cmd--> in-game
 (laptop)                       (32 GB box)            <--acks.tsv---  (inside MacroQuest)
   |                              |
   +-- contract/intents.js -------+   (the only shared schema)
```

Runtime: **Node.js** (brain + executor, stdlib only — no `npm install`), **Lua** (the MQ bridge).
See PROGRESS.md for why Node instead of Python.

## One-click

All settings live in **[config.json](config.json)** (paths, ports, the box's LAN IP) — edit that, not
env vars. Then double-click:

| Where | Double-click | Does |
|---|---|---|
| **32 GB box** | `scripts\start-box.cmd` | checks Node, ensures the bridge dir, verifies it matches `bridge.lua`, copies `/lua run bridge` to your clipboard, and starts the executor. You paste that one command into the anchor client's MQ console once. |
| **laptop** | `scripts\console.cmd` | opens the guild console — type `say Lt1 hello`, `goto_zone Lt1 nro --resummon b1,b2`, etc., and it sends the intent over the LAN. |
| **anywhere** | `scripts\test.cmd` | runs the game-free end-to-end test (expect `ALL PASS`). |

The only thing not auto-launched is `/lua run bridge` itself — that has to run *inside* MacroQuest
(the whole point of the bridge). The launcher puts it on your clipboard; to make it fully automatic,
add `/lua run bridge` to however your clients already autoload e3next.

## Layout
- `config.json` / `config.js` — single config source (env vars still override).
- `contract/intents.js` — versioned intent schema (the seam). Imported by brain and executor.
- `brain/emit.js` — Phase 0 intent emitter (no LLM yet).
- `executor/` — `executor.js` (LAN listener), `mapping.js` (intent→command table), `bridge.js`.
- `mqbridge/bridge.lua` — runs inside MacroQuest; executes commands in-game.
- `scripts/` — one-click launchers: `start-box.cmd`, `console.cmd`, `test.cmd`.
- `tools/` — `mockbridge.js` (game-free bridge stand-in) + `test-phase0.js` (end-to-end test).

## Verify the software locally (no game, run on either machine)
```
node tools/test-phase0.js      # expect: ALL PASS
```
This exercises the whole pipeline with a mock bridge that speaks the real bridge's file protocol.

## Run on the live boxes (Phase 0 in-game)

> **For the box running the clients, follow [docs/box-runbook.md](docs/box-runbook.md)** — the exact,
> ordered checklist (prereqs, install, start, 0a–0d, tuning). The summary below is the short form.

### One-time setup
1. Copy this repo to the **32 GB box** (for the executor + bridge).
2. In `mqbridge/bridge.lua`, set `BRIDGE_DIR` to a real dir on the box, e.g. `C:/EQ/.bridge`.
3. Start the executor on the box with the **same** dir:
   ```powershell
   $env:EQ_BRIDGE_DIR = "C:/EQ/.bridge"   # must match bridge.lua
   $env:EQ_EXEC_PORT  = "8777"            # default
   node executor/executor.js
   ```
4. In the **anchor** MacroQuest instance on the box (the one with DanNet peers visible), run:
   ```
   /lua run bridge
   ```
   You should see `[mqbridge] tailing ...` in the MQ console. Requires DanNet loaded on all clients
   (so `/dex <peer> ...` reaches them) and, for `goto_zone`, the scoped `#zone` status on the squad
   account.

### 0b — the bridge (one command lands in-game), run ON the box
```powershell
node brain/emit.js say Lt1 hello from the bridge
```
Expect: Lieutenant `Lt1` says "hello from the bridge" in-game; result JSON shows `"ok": true`.
(Replace `Lt1` with a real character / DanNet peer name.)

### 0c — cross-LAN, run FROM the laptop
```powershell
$env:EQ_EXEC_HOST = "<the box's LAN IP>"
$env:EQ_EXEC_PORT = "8777"
node brain/emit.js say Lt1 hello across the LAN
```
Expect: same in-game `/say`, but the intent crossed machines. Open port 8777 on the box's firewall.

### 0d — teleport-follow, run FROM the laptop (with Lt1's 5 bots up)
```powershell
node brain/emit.js goto_zone Lt1 nro      # nro = a target zone shortname
```
Expect: the Lieutenant `#zone`s to `nro`. **Verify the 5 bots follow.** If they don't, use the
re-summon form — it teleports, then re-spawns/summons/follows the bots after a zone-load pause:
```powershell
node brain/emit.js goto_zone Lt1 nro --resummon bot1,bot2,bot3,bot4,bot5 --delay 15000
# or, if already in-zone but bots despawned:
node brain/emit.js resummon_bots Lt1 bot1 bot2 bot3 bot4 bot5
```
Record the bot-follow result in PROGRESS.md.

## Intent vocabulary (current)
| intent | args | maps to | status |
|---|---|---|---|
| `say` | `<target> <text...>` | `/dex <target> /say <text>` | verified path |
| `goto_zone` | `<squad> <zone> [--resummon b,…] [--delay ms]` | `/dex <squad> /say #zone <zone>` (+ delayed `/say ^spawn`/`^summon`/`^follow`) | needs scoped GM |
| `resummon_bots` | `<squad> <bot…>` | `/dex <squad> /say ^spawn/^summon/^follow` | tune bot syntax |
| `assist_player` | `<squad>` | `/dex <squad> /assist …` | default, tune to e3next |
| `engage` | `<squad> <mob>` | `/dex <squad> /target <mob>` | default, tune to e3next |
| `group_invite` | `<member>` | member auto-accept | prefer e3next auto-accept |
| `come_to_player` | `<squad>` | — | Phase 1 (needs shadow hook) |

The brain only ever emits the left two columns' data; the executor owns the mapping (right column).

> **Why `/say` wraps `#`/`^` commands:** EQEmu parses GM (`#`) and bot (`^`) commands from chat-channel
> packets (the server reads the prefix). MacroQuest's parser only handles `/` slash commands and drops
> a bare `#`/`^`, so the executor issues them through `/say` — the same packet as typing in the chat box.
