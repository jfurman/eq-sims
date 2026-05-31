# CLAUDE.md — EQ Guild Agent (build brief)

Build the **agent software** that turns six already-running EQ clients into an AI-orchestrated guild
on a private EQEmu server. The environment is already standing — this is about the brain, the relay,
and the contract between them, not setup.

**Read `docs/simplayer-eqemu-design.md` for the full architecture.** This file is the build brief and the
phased task list. If they conflict, the design doc wins — flag it.

---

## Current state (ALREADY STANDING — do not rebuild)
- akk-stack EQEmu server running on the 32 GB box.
- 6 clients running there: Guild Leader + 5 Lieutenants, each with **e3next** (MacroQuest integrated),
  characters created. e3next handles each client's autonomous combat **locally**.
- Deployment: server + all 6 agent clients on the **32 GB box**; the **3070 Ti laptop** runs the
  player's main character + the **Qwen2.5-14B (Q3_K_M)** brain + this dev environment.
- DanNet is available as a cross-MacroQuest bus.

## What we ARE building
The agent software, in four parts: a **brain** (laptop), a **relay/executor** (32 GB box), the
**intent contract** between them, and a **DB-read** module. We are NOT building a game controller —
the control surface (e3next / MacroQuest / game commands) already exists. We build the channel that
carries the brain's decisions to the local controllers, and the decision logic itself.

---

## Hard rules (do NOT violate)
1. **Brain-and-hands split.** Brain (laptop) decides and emits **intents** over the LAN; the executor
   (32 GB box) receives intents and issues local in-game commands. **Intents cross the LAN, never
   keystrokes.** Never try to drive a client from a different machine than it runs on — MacroQuest is
   local-only.
2. **Don't reimplement combat.** e3next owns moment-to-moment combat, locally and autonomously. The
   agent only directs (where / what / when); it never casts or melees.
3. **Grouping & following are stock mechanics** (`/invite`, e3next assist-the-leader) — not custom code.
4. **LLM off the hot path.** The brain makes low-frequency, high-level decisions (seconds/minutes),
   never per-tick. No LLM call inside any loop faster than ~once every few seconds.
5. **The intent contract is the seam.** A clean, versioned, serializable schema (data — ids/values,
   not raw commands). Brain and executor depend only on the contract, so each is testable alone.
6. **The executor is a THIN relay** — intent -> existing e3next/MQ/DanNet/game command. No decision
   logic in the executor; decisions live in the brain.
7. **DB access is read-mostly** for state (gear, roster, loot, spawns). Prefer issuing in-game commands
   over direct DB writes to change game state.
8. **Verify each link before building on it** (see phases). Don't stack unproven layers.
9. **Private LAN only.** `#zone` is GM-scoped (give the clients' accounts a tightly-scoped status, not
   full GM); the relay/DanNet runs on the trusted LAN.

---

## Components & repo
```
/brain      (laptop)     guild orchestrator: Qwen client, decision logic, intent emitter, DB reader
/executor   (32 GB box)  intent listener (LAN) -> issues in-game commands via the MQ bridge
/mqbridge   (32 GB box)  in-game side: a MacroQuest Lua script that receives commands from the
                         executor and fires them in-game (e3next cmds, DanNet broadcasts, /invite, #zone)
/contract                the shared intent schema (imported by both brain and executor)
/db                      read queries against akk-stack (gear, roster, loot tables, spawns)
```
Language: **Node.js** for brain/executor (LLM + sockets + DB); **Lua** for the MQ bridge. Adjust only
with reason.

---

## The intent contract (the seam — define this first)
Serializable data the brain emits and the executor consumes. Start tiny and grow:
```
{ "type": "say",            "target": "<char>", "text": "..." }          # easiest first test
{ "type": "group_invite",   "member": "<char>" }
{ "type": "assist_player",  "squad": "<lt-id>" }
{ "type": "goto_zone",      "squad": "<lt-id>", "zone": "<shortname>" }   # -> #zone teleport
{ "type": "engage",         "squad": "<lt-id>", "target": "<mob>" }       # -> e3next
{ "type": "come_to_player", "squad": "<lt-id>" }                          # -> teleport + assist
```
Versioned. Data only, never keystrokes. The executor owns the intent->command mapping table.

---

## The executor -> in-game bridge (THE key Phase 0 unknown — solve first)
Getting an external program's command executed *inside* MacroQuest is the riskiest unknown. Evaluate
and pick whichever works on this setup:
- An MQ **Lua bridge** that reads commands from a local socket or a watched file the executor writes,
  then issues them in-game.
- **DanNet execute broadcasts** so one MQ instance relays a command to the whole squad.
- **e3next's command interface** (`/e3` / `/mono e3 <cmd>`) for engage/combat intents.
Goal: fire ONE command (e.g., make a Lieutenant `/say` something, or accept an invite) from the
executor. Once one external command lands in-game, the bridge is proven and the rest is vocabulary.

---

## Phased plan (verify each link before the next)

### Phase 0 — prove the control path (NO LLM yet)
- **0a. Manual baseline:** by hand, `/invite` one Lieutenant into your group; confirm e3next makes it
  follow + assist with zero custom code. (Proves the control surface already exists.)
- **0b. The bridge:** get the executor to fire ONE in-game command on a Lieutenant from the 32 GB box
  (the unknown above). *Exit:* an external command makes a client act in-game.
- **0c. Cross-LAN:** the brain (laptop) sends one intent over the LAN to the executor (32 GB box),
  which executes it. *Exit:* an intent crosses machines and a Lieutenant acts.
- **0d. Teleport-follow test:** issue `#zone` to a Lieutenant that has its 5 bots up; verify the bots
  follow. If not, implement re-summon-on-arrival (bots persist in the DB). *Exit:* a squad relocates intact.

### Phase 1 — grouping + come-to-me (scripted, still no LLM)
Implement intents: `group_invite`, `assist_player`, `goto_zone`, `come_to_player`. Hook the player's
zone event to auto-shadow. On command, form the all-client group (Mode A) and a Lt+bots squad (Mode B,
dropping the player-class bot).

### Phase 2 — the eyes (DB reads)
`/db` module: read a character's and a bot's equipped gear; walk the item->source chain for one upgrade
(`items -> lootdrop_entries -> ... -> spawn2 -> zone`). Pure reads, no game effect. *Exit:* print a
roster gear report and "this upgrade drops in zone Z."

### Phase 3 — the brain's first loop (LLM enters, smallest decision)
Wire Qwen: read gear (DB) -> decide one Lieutenant is under-geared in one slot -> emit one intent
(e.g., `goto_zone`) through the executor. *Exit:* brain -> DB -> intent -> executor -> client, end to
end, on ONE trivial decision.

### Phase 4 — Quartermaster v1
Grow Phase 3 into the full poll / score / source / prioritize / dispatch loop across the 5 squads;
auto-equip on drop; guild-chat narration. (Design doc Section 5.)

---

## Manual / out of scope (for now)
- **Manual (you):** per-class e3next combat config (tune in-game / e3 inis); granting the scoped
  `#zone` account status; the clients themselves (already running).
- **Out of scope until later:** full Quartermaster, 5 parallel expeditions, raid (Mode C) assembly,
  LLM personality/banter, optional realism-mode overland travel; the **guild gear economy + per-Lt
  crafting** (design §5.1 / Phase 4) — design the contract & DB reader with it in mind, build later.

---

## Conventions
- The **intent contract is the only coupling** between brain and executor — version it, change it deliberately.
- Each phase ends with a **demonstrable working link**; commit per step; keep a short PROGRESS.md.
- Executor stays **dumb** (relay only); decisions stay in the **brain**.
- This file is the build brief; `docs/simplayer-eqemu-design.md` is the full architecture.