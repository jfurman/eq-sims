# PROGRESS

Short, append-only log of what's proven and what's next. See `CLAUDE.md` (build brief) and
`docs/simplayer-eqemu-design.md` (architecture).

## Decisions / deviations
- **2026-05-30 — One-click launchers + single config.** All settings moved to `config.json`
  (`config.js` resolves it; env vars still override). Box: `scripts\start-box.cmd` (validates +
  starts executor + clipboards the bridge command). Laptop: `scripts\console.cmd` (interactive intent
  console). `scripts\test.cmd` runs the local test. The one step that can't be auto-launched is
  `/lua run bridge` (must run inside MacroQuest); the launcher clipboards it.
- **2026-05-30 — Runtime: Node.js instead of Python** for brain/executor. The dev laptop has no
  Python; Node.js is installed. The brief allows adjustment "with reason." `mqbridge` stays Lua
  (it runs inside MacroQuest). Downstream impact to revisit at Phase 3+: the Qwen LLM client and
  the DB-read module will also be Node (use a Qwen/OpenAI-compatible HTTP client + a MySQL driver).
- **Bridge transport: append-only line files** (`queue.tsv` / `acks.tsv`) in a shared dir, chosen
  over a socket because it needs **zero libraries inside MQ's Lua** and is atomic via newline
  appends. Executor and bridge are co-located (same box), so a local path suffices. The LAN hop is
  the brain→executor TCP socket; the bridge hop never crosses machines.

## Phase 0 — prove the control path

### Built (this repo)
- `contract/intents.js` — the seam. Versioned (`0.2.0`) JSON intent schema (typed req/opt fields),
  builders, `validate()`, serialize/parse. The only coupling between brain and executor.
  `0.2.0` added `resummon_bots` and optional `resummonBots`/`resummonDelayMs` on `goto_zone`.
- `executor/` — thin relay: `executor.js` (LAN TCP listener), `mapping.js` (intent→MQ command table,
  executor-owned), `bridge.js` (executor's half of the file bridge).
- `mqbridge/bridge.lua` — in-game hands: tails `queue.tsv`, runs `mq.cmd`, appends acks. Dumb relay.
- `brain/emit.js` — Phase 0 emitter (no LLM): builds one intent, sends it over the LAN.
- `tools/mockbridge.js` + `tools/test-phase0.js` — game-free end-to-end test double + test.

### Verified
- **[x] Software pipeline (laptop, no game).** `node tools/test-phase0.js` → **ALL PASS**.
  Proves brain → TCP → executor → `queue.tsv` → bridge → `acks.tsv` → executor → reply, plus
  contract validation (stale version & unknown type rejected). The mock bridge speaks the same file
  protocol as `bridge.lua`, so only the final `mq.cmd` in-game hop is left to verify on the box.

- **[x] Re-summon-on-arrival wired.** `goto_zone --resummon` issues `#zone`, waits a brain-supplied
  delay (default 15s), then `^spawn` each bot + `^summon` + `^follow`; standalone `resummon_bots` too.
  Proven in the local test (correct command sequence + delay honored). In-game tuning of the bot
  command syntax (`^spawn` vs `#bot`) is in `executor/mapping.js` `BOT`.

### Live-box verification (`docs/box-runbook.md`)
- **[x] 0b. The bridge** — 2026-05-30. `bridge.lua` loaded in the anchor MQ; laptop emit produced
  `/dex Cynric /say bridge is alive`, bridge acked `OK`, and the line was **visually confirmed in the
  client chat window**. The first external command reached MQ and took effect in-game.
- **[x] 0c. Cross-LAN** — 2026-05-30. Same command: brain on the **laptop** -> executor on the box at
  `192.168.1.204:8777` -> in-game. Required: laptop `config.json` `brain.executorHost` = box LAN IP,
  and an inbound firewall rule for TCP 8777 on the box. An intent crossed machines and a client acted.
- **[x] 0a. Manual baseline** — 2026-05-30. `/invite` accepted by e3next + follow/assist working.
  **Prerequisite found:** e3next only auto-accepts group invites from someone in its bot
  network/guild/raid. The player must share a GUILD with the Lieutenants (design §8) before any
  grouping works — this is a hard Phase 1 prerequisite, not optional flavor.
- **[ ] 0d. Teleport-follow** — `goto_zone` issues `#zone`; verify the 5 bots follow. If not, use
  `--resummon` (now wired) and confirm the squad relocates intact.
  - **Fix applied 2026-05-30:** server commands (`#zone`, `^spawn/^summon/^follow`) must be issued via
    `/say` — MQ drops a bare `#`/`^`, but EQEmu parses them from the chat packet. Mapping now wraps
    them (`dexGameCmd` in `executor/mapping.js`). Local test updated + green. Awaiting in-game retest.
  - Prereq cleared: scoped `#zone` account status granted (works when typed in chat).

> Note: bridge `status:OK` = command dispatched via `mq.cmd`, not in-game-effect-confirmed. A `/dex`
> to an unknown DanNet peer still acks OK. Confirm peer names with `/dnet`.

## Next
- Close 0a–0d on the live boxes; tick the boxes above with notes (esp. the 0d bot-follow result).
- Phase 1: `come_to_player` needs the player zone/loc shadow hook before its mapping can emit a
  command (currently returns "no command produced" by design).
