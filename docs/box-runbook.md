# Box runbook — what to do on the 32 GB box (the machine running the clients)

This is the exact, ordered checklist to bring Phase 0 live. The **executor** and the **MQ Lua
bridge** both run here (they share local files); the **brain** runs on the laptop. Do every step on
the box unless it says "laptop."

The control path you're standing up:
```
laptop: brain/emit.js  --TCP :8777-->  box: executor.js  --queue.tsv-->  bridge.lua (in MQ)  --mq.cmd--> client
                                                          <--acks.tsv----
```

---

## A. Prerequisites on the box (one-time)

1. **Node.js** — the executor is Node (no npm packages needed). Check:
   ```powershell
   node -v        # any modern LTS; if "not recognized", install Node.js LTS
   ```
2. **The clients are already running** (GL + 5 Lieutenants) with MacroQuest, per the brief. Confirm
   each client's MacroQuest has these plugins loaded:
   - **MQ2DanNet** — the cross-client bus. Check in any client's MQ console: `/plugin mq2dannet` (or
     it's in your autoload). `/dnet` should list all peers (the other characters).
   - **MQ2Lua** — runs the bridge script. `/plugin mq2lua`.
   - **e3next (MQ2Mono)** on the Lieutenants — already in place for combat; the bridge doesn't need it
     for 0b/0c/0d.
3. **DanNet peer names** — `/dex` targets a peer by name. In a client console run `/dnet` and note the
   exact peer names (usually the character names). You'll pass these as `<target>`/`<squad>` to the
   brain. If `/dnet` shows `server_charname`, use that full string.
4. **Scoped `#zone` status** (needed only for `goto_zone` / 0d) — grant the squad accounts a status
   tier that exposes `#zone` but NOT full GM. Verify by manually typing `#zone nro` in a Lieutenant; if
   it teleports, the privilege is set.
5. **Bot names** (needed only for re-summon) — in a Lieutenant console run `^botlist` (or your build's
   equivalent) and note the 5 bot names you own. You'll pass these to `--resummon`.

---

## B. Install the agent software on the box (one-time)

1. Copy this repo to the box, e.g. `C:\EQ`.
2. Create the shared bridge directory:
   ```powershell
   New-Item -ItemType Directory -Force C:\EQ\.bridge
   ```
3. Open `mqbridge/bridge.lua` and set the dir to that exact path (forward slashes are fine):
   ```lua
   local BRIDGE_DIR = 'C:/EQ/.bridge'
   ```
4. Put the bridge where MacroQuest looks for Lua scripts. `/lua run bridge` resolves to
   `<MQ-root>/lua/bridge.lua`. Either copy it there, or symlink:
   ```powershell
   # replace <MQ-root> with your MacroQuest folder (the one containing MacroQuest.exe + a \lua subdir)
   Copy-Item C:\EQ\mqbridge\bridge.lua "<MQ-root>\lua\bridge.lua"
   ```
   (If you edit `BRIDGE_DIR` later, re-copy — or symlink once with
   `New-Item -ItemType SymbolicLink -Path "<MQ-root>\lua\bridge.lua" -Target C:\EQ\mqbridge\bridge.lua`.)

---

## C. Start the two box-side processes (every session)

> **One-click:** double-click `scripts\start-box.cmd`. It checks Node, ensures the bridge dir,
> verifies it matches `bridge.lua`, copies `/lua run bridge` to your clipboard, and starts the
> executor. Then do step 2 below (paste into the anchor client). Settings come from `config.json`.

The manual equivalent, if you prefer:

1. **Executor** — in a PowerShell window on the box:
   ```powershell
   cd C:\EQ
   node executor/executor.js          # reads config.json
   ```
   Expect: `listening on 0.0.0.0:8777`, the bridge dir, and `contract v0.2.0`. Leave it running.

2. **Bridge** — pick ONE always-on client as the **anchor** (the Guild Leader is the natural choice;
   it must see all peers in `/dnet`). In that client's MQ console:
   ```
   /lua run bridge
   ```
   Expect: `[mqbridge] starting. dir=C:/EQ/.bridge` and `[mqbridge] tailing ...`. Leave it running.
   Stop later with `/lua stop bridge`. To make this automatic, add `/lua run bridge` to however your
   clients already autoload e3next.

> Why the anchor: the bridge issues `/dex <peer> ...` to reach every other client over DanNet, so it
> only needs to run in ONE instance, not all six.

---

## D. Phase 0 verification steps

### 0a — manual baseline (no software; proves the control surface exists)
By hand, `/invite` one Lieutenant into your group and confirm e3next makes it follow + assist with no
custom code. Pure stock mechanics.

### 0b — the bridge (run ON the box)
With executor + bridge running, in a second PowerShell on the box:
```powershell
cd C:\EQ
node brain/emit.js say <LieutenantName> hello from the bridge
```
Expect: that Lieutenant says the line in-game; the command prints `"ok": true`. **This is the key
unknown proven** — an external program drove a command into MacroQuest.

### 0c — cross-LAN (run FROM the laptop)
First, allow the port through the box's firewall (one-time, run on the box as admin):
```powershell
New-NetFirewallRule -DisplayName "EQ executor 8777" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8777
```
Find the box's LAN IP (`ipconfig` on the box). Then on the **laptop**:
```powershell
cd C:\EQ
$env:EQ_EXEC_HOST = "<box-LAN-IP>"
$env:EQ_EXEC_PORT = "8777"
node brain/emit.js say <LieutenantName> hello across the LAN
```
Expect: same in-game `/say`, but the intent crossed machines. *Exit: an intent crosses the LAN and a
Lieutenant acts.*

### 0d — teleport-follow + re-summon fallback (run FROM the laptop)
With a Lieutenant's 5 bots spawned, first test the plain teleport:
```powershell
node brain/emit.js goto_zone <LieutenantName> nro      # nro = a real target zone shortname
```
Watch the bots. **Two outcomes:**
- **Bots follow the `#zone`** → re-summon isn't needed; note it in PROGRESS.md and you're done.
- **Bots DON'T follow** → use the re-summon form, which teleports then re-spawns/summons/follows the
  bots after a zone-load pause (default 15s; tune with `--delay <ms>`):
  ```powershell
  node brain/emit.js goto_zone <LieutenantName> nro --resummon <bot1>,<bot2>,<bot3>,<bot4>,<bot5> --delay 15000
  ```
  Expect: the Lieutenant teleports, then ~15s later each bot is `^spawn`ed, `^summon`ed to the Lt, and
  set to `^follow`. *Exit: a squad relocates intact.*

> Standalone re-summon (if a squad is already in-zone but its bots despawned):
> ```powershell
> node brain/emit.js resummon_bots <LieutenantName> <bot1> <bot2> <bot3> <bot4> <bot5>
> ```

---

## E. Tuning notes (server-specific)

- **Bot command syntax.** The re-summon uses `^spawn` / `^summon` / `^follow on` (modern EQEmu / akk-
  stack). If your build uses the older `#bot ...` form, edit the `BOT` constants at the top of
  `executor/mapping.js` — one place, nothing else changes.
- **DanNet name mismatch.** If `/dex <name> ...` does nothing, the peer name is wrong — re-check
  `/dnet` and use the exact string it prints.
- **`#zone` denied.** The squad account lacks the scoped status (step A.4).
- **`bridge timeout: no ack`.** The executor wrote to the queue but the bridge isn't reading it: the
  bridge isn't running, or `BRIDGE_DIR` in `bridge.lua` ≠ `EQ_BRIDGE_DIR` on the executor.

---

## F. Pre-flight without the game (any machine)

Before touching the box you can prove the whole software pipeline with a mock bridge:
```powershell
node tools/test-phase0.js     # expect: ALL PASS
```
This exercises brain → executor → bridge-files → ack, including re-summon, leaving only the in-game
`mq.cmd` hop for the box.
