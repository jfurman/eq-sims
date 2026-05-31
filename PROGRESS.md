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
- **[x] 0d. Teleport-follow** — DONE (2026-05-31). `node brain/emit.js goto_zone Oram guildlobby`
  relocated Oram end-to-end (brain -> executor -> bridge -> `/e3bct` -> local `/say #zone`), and
  **the bots zoned with their owner natively** — re-summon NOT needed. The design's #1 risk
  (bot-follows-teleport) is resolved in our favor. `--resummon` stays as a wired fallback only.

## PHASE 0 COMPLETE (2026-05-31)
Control path proven end to end: brain (laptop) -> intent over LAN -> executor (box) -> file bridge ->
MacroQuest -> in-game, across machines, for say + GM teleport with squads intact. Key resolved
unknowns: scoped `#zone` status; player must be guilded for e3next to accept invites; server commands
need `/say` AND a local-execution relay (`/e3bct`, not `/dex`); bots follow `#zone` natively.
  - **Fix 1 (2026-05-30):** server commands (`#zone`, `^…`) must be wrapped in `/say` — MQ drops a
    bare `#`/`^`; the client routes `#`/`^` to the command path only from the chat/`/say` path.
  - **Fix 2 (2026-05-31):** the relay matters. DanNet `/dex <peer> /say #zone` executes on the peer
    through a path that does NOT trigger `#`/`^` routing -> literal say. But `/docommand /say #zone`
    run LOCALLY teleports. So we relay via e3next's targeted broadcast (`/e3bct {peer} {cmd}`), which
    runs the command locally on the target. Relay is now **config-driven** (`relay` in config.json) so
    it's swappable without code. Local test green. **Anchor (bridge host) must run e3next** to issue
    `/e3bct`. Awaiting in-game retest of `goto_zone`.
  - Prereq cleared: scoped `#zone` account status granted (works when typed in chat).

> Note: bridge `status:OK` = command dispatched via `mq.cmd`, not in-game-effect-confirmed. A `/dex`
> to an unknown DanNet peer still acks OK. Confirm peer names with `/dnet`.

## Phase 1 — player grouping + shadow (in progress, still no LLM)

### Built (this repo) — software complete, local test green (18 checks)
- **Contract v0.3.0:** `come_to_player {squad, zone, x?,y?,z?, player?}`, grouping primitives
  `group_invite {inviter,member}` / `make_leader {leader,by}` / `drop_bot {squad,bot}`, and
  `assist_player {squad, player}`.
- **Executor mapping:** come_to_player (`#zone` + optional delayed `#goto` to your loc), the group
  primitives, and `drop_bot` (despawn via `BOT.despawn`, default `^depop`).
- **`mqbridge/playerwatch.lua`** — runs in YOUR client's MQ (laptop); read-only; writes your
  zone/loc/class/name to `.player/state.tsv` each second.
- **`brain/shadow.js`** — watches that file; on a zone change emits `come_to_player` for the
  configured `shadow.squads`. `scripts/shadow.cmd` one-click.
- **`brain/group.js`** — sequences the primitives into Mode A (you + 5 Lt clients; anchor invites,
  then `/makeleader you`) and Mode B (join a Lt's squad; drops the bot whose ROLE matches yours —
  role, not class, per the 2026-05-31 correction). Uses `config.json` `roster`.

### Decisions baked in
- **Mode B drops by ROLE, not class.** Player has a role (tank/healer/cc/support/dps); Mode B drops
  the squad bot in that role (may be a different class). Brain resolves role->bot from `roster`.
- **No laptop executor needed.** Your client only runs the read-only `playerwatch.lua`; grouping is
  driven from the box (anchor Lt invites, your e3next auto-accepts — guilded).

### Not yet verified (needs the live setup)
- **[ ] Roster** filled in `config.json` (player name/class/role; 5 Lt names/classes/roles; GL;
  anchor; each Lt's bots name/class/role).
- **[ ] playerwatch.lua** copied to the PLAYER client's MQ `\lua\` and `/lua run playerwatch`.
- **[ ] Shadow** — `scripts/shadow.cmd` on the laptop; you zone, the shadow squad follows.
- **[ ] come_to_player coords** — verify `#goto x y z` order on your build (set `shadow.sendCoords`).
- **[ ] Mode A / Mode B** — run `node brain/group.js a` / `b <Lt>`; confirm group forms; Mode B drop.
- **[ ] Relay coverage** — confirm `group_invite`/`assist_player` land in-game (only `say`/`#zone`
  exercised live so far).

## Next
- Close 0a–0d on the live boxes; tick the boxes above with notes (esp. the 0d bot-follow result).
- Phase 1: `come_to_player` needs the player zone/loc shadow hook before its mapping can emit a
  command (currently returns "no command produced" by design).
