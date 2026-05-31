# Design Sketch v4 — SimPlayer Guild for EQEmu (agent-driven, full-group-of-clients)

> An AI-run guild on a private EQEmu server. Target: **6 clients** — a Guild Leader plus **5
> Lieutenants whose classes form a balanced group**. Each Lieutenant also owns 5 server-side bots, so
> any Lieutenant is a self-sufficient group of six; the Guild Leader owns the filler bots needed for a
> 72-body raid. Uses **stock EQEmu bots — no server fork.** The brain is an external **agent** driving
> the clients via **MacroQuest** + reading the **server DB**. Travel is by **GM `#zone` teleport**, not
> a pathfinding graph. Headline feature: a **Quartermaster** that dispatches squads to farm specific gear.

> **v4 changes:** architecture is now 6 clients (GL + 5 Lieutenants) enabling an all-client group;
> travel switched from a zone-connection graph to GM teleport (`#zone`) + a player-zone shadow hook;
> Quartermaster now runs up to 5 parallel client-anchored expeditions. (2 clients remains the Phase 0
> proving step, not the destination.)

---

## 0. Governing rule
**Server-side bots zone with their owner; only a client can cross a zone line.** So clients are
mobile squad anchors; bots are cheap bodies that follow their owner. **Cost scales with clients**
(each = an EQ process + MacroQuest + agent control), not with bots.

---

## 1. Composition
- **Guild Leader (client):** persistent 24/7 hub; the **Quartermaster brain** (§5); guild-chat anchor;
  owner of the **filler bots** that top a raid up to 72.
- **5 Lieutenants (clients):** their **classes form a balanced group** (tank / healer / CC / support /
  DPS). Each also owns **5 server-side bots**, so each Lieutenant is a self-sufficient group of six and
  travels as a unit (bots zone with their owner).
- **Server-side bots:** squad bodies; combat via stock bot AI; auto-equip drops; level with owner
  (`Bots:BotLevelsWithOwner = true`).
- **Agent / LLM:** ONE guild-brain driving all 6 clients over the EQBC/DanNet bus + reading the DB.

**Raid math (Mode C):** 6 client groups (GL + each Lt, each with 5 bots) = 36; GL tops up the other
6 groups from its own pool (~41 bots, under the 71/character cap). 6 clients + 66 bots = 72 = 12 groups.

---

## 2. The three grouping modes (the payoff)
- **Mode A — all-client group:** Player + the 5 Lieutenant clients = a full group of six, **zero bots
  in the group.** Feels like grouping with five real people. The premium mode.
- **Mode B — Lieutenant squad + player:** player joins one Lieutenant's own group (Lt + 5 bots); the
  Lt **drops the bot matching the player's class** so the player fills that role with no redundancy.
- **Mode C — raid:** all clients converge; GL spawns filler bots to a 72-body, 12-group raid.

---

## 3. Class composition (design choice)
Pick 5 Lieutenant classes that form a balanced group AND anticipate the player as a wildcard sixth.
If the player's class duplicates a Lieutenant in Mode A: accept the redundancy (EQ tolerates two of a
class) or have the GL swap that Lieutenant to a complementary class for the session. The five chosen
classes also dictate each Lieutenant's 5-bot squad makeup.

---

## 4. Control, coordination, travel
- Agent drives each client via **MacroQuest** (movement, targeting, chat, bot `^commands`); one
  guild-brain coordinates all clients over **EQBC / DanNet**.
- **Distributed clients (centralized brain, local hands):** clients may run on separate LAN machines.
  In-game coordination (raid assembly, bot `^commands`, group invites, guild chat) is pure server-side
  mechanics and is **location-agnostic** — the server doesn't care which box a character runs on.
  EQBC/DanNet are network buses, so cross-machine messaging is the normal case, not a limitation. BUT
  MacroQuest injects into its **local** client only, so each machine running a client needs its own MQ
  instance + a thin **local executor** (the agent bridge). Architecture: ONE guild-brain issues
  high-level intents over the network; a local executor on each machine drives that machine's client
  via its MQ. Distribution is a deployment detail (push the executor to each box), not a design change.
- **Travel = GM teleport.** Grant the clients' accounts a tightly-scoped status tier that exposes only
  the movement command(s) needed (`#zone` / goto-style), NOT full GM. A client teleports and its bots
  follow (verify; if not, re-summon the bot group on arrival — they persist in the DB).
- **Shadow the player:** hook the player's **zone event** (Lua zone event or the agent watching the
  event stream) so the relevant squad teleports into the player's zone automatically. For arrival *at*
  the player, teleport-to-coordinates rather than the zone safe point.
- **Optional realism mode:** physical overland travel via `mq2nav` for gear expeditions, if you want
  farming runs to feel like real journeys while player-grouping stays instant. Not required.
- Combat execution for the client Lieutenants uses **e3next** (C#, highly configurable autonomous
  fighter), which runs on the **MQ2Mono** plugin (32-bit framework for EMU) under a MacroQuest build
  that supports it — not stock Very Vanilla. The server-side bots under each Lieutenant are tuned via
  EQEmu's own bot spell settings/stances. The agent issues high-level intents; e3next executes combat.
- The agent reads the **server DB directly** for state — the privileged-orchestrator advantage.

### 4.1 Control topology across machines
```
   3070 Ti LAPTOP (play + brain)              32 GB BOX (always-on: server + agent clients)
  +-------------------------------+         +---------------------------------------------+
  |                               |         |                                             |
  |  Qwen brain (LLM)             |         |   Executor  --+--> GL  client   [MQ + e3next]|
  |     |                         |         |  (relays the  +--> Lt1 client   [MQ + e3next]|
  |     |  high-level INTENTS     | --LAN-->|   brain's     +--> Lt2 client   [MQ + e3next]|
  |     |  (over LAN / DanNet)    |         |   intents to  +--> Lt3 client   [MQ + e3next]|
  |     |                         |         |   the local   +--> Lt4 client   [MQ + e3next]|
  |     +-- reads server DB ------| --LAN-->|   clients)    +--> Lt5 client   [MQ + e3next]|
  |                               |         |                    (each owns 5 server bots) |
  |  Main character (you drive it)|         |                                             |
  |                               |         |   EQEmu server (akk-stack)                  |
  +--------------+----------------+         +----------------------+----------------------+
                 |                                                 |
                 +------------------- LAN game traffic ------------+
                        (every client connects to the server)
```
- **Combat = LOCAL & autonomous.** Each client's e3next fights on the 32 GB box; its 5 server bots use
  EQEmu's bot AI. Nothing combat-related crosses to the laptop.
- **Grouping = SERVER-SIDE & location-blind.** Player + Lieutenants `/invite` into one group regardless
  of which machine each runs on — the group lives on the server.
- **Control = brain -> intents over LAN -> executor -> local e3next.** The laptop's brain never drives a
  Lieutenant directly; it sends INTENT (go here, group up, farm this), and the executor on the 32 GB box
  relays it into each client's local MacroQuest/e3next. Intentions cross the LAN, never keystrokes.
- The laptop runs the brain + your main character only — **no e3next for the Lieutenants** lives there.

---

## 5. The Quartermaster — gear-acquisition director
The Guild Leader polls the whole roster (Lieutenants AND their bots), finds the under-geared, and
dispatches squads to fetch specific class-appropriate gear. With 5 client-anchored squads it runs up
to **5 parallel expeditions**.

**Loop:**
1. **POLL** — read each member's equipped items per slot via **direct DB read** (character + bot
   inventory tables).
2. **SCORE** — per-class stat-weight scoring (§6); flag empty / outdated / below-threshold slots.
3. **SOURCE** — reverse-map a target item to where it drops via the DB chain:
   `items -> lootdrop_entries -> lootdrop -> loottable_entries -> loottable -> npc_types.loottable_id
   -> spawnentry -> spawngroup -> spawn2 -> zone`. Authoritative because the data is yours.
4. **PRIORITIZE** — rank needs (worst gaps, ROI, level-appropriate).
5. **DISPATCH** — assign each free Lieutenant squad a target (zone + mob + item).
6. **TELEPORT -> FARM -> EQUIP -> REPORT** — squad `#zone`s to the target, camps/kills until drop or
   timeout, auto-equips, GL narrates in guild chat.

**Division of labor:** LLM/agent does POLL/SCORE/SOURCE/PRIORITIZE/DISPATCH + chat (low-frequency).
Bot AI + macros do FARM/EQUIP. **LLM off the hot path.**

---

## 6. Gear scoring model
Good-enough heuristic: per-class stat weights over hp / ac / mana / str-sta-wis-int / resists; item
score = weighted sum, gated by usable-by-class/level/race; under-geared = slot empty or below a
level-scaled threshold. Tune over time; perfect itemization (procs/clickies/focus) is a later refinement.

---

## 7. Persistence & lifecycle
- All 6 clients **autologin** and stay connected 24/7; a watchdog auto-relogins on crash/desync.
- Each client's bots are owned by that client, spawned on its login, persisted in the DB.

---

## 8. Guild & social
- The player starts in a guild populated by the GL + 5 Lieutenants (optionally the bots). The GL
  anchors **guild chat**; the agent narrates assignments, banter, and recruiting via the LLM, reading
  and writing guild chat through its client (relayed over EQBC/DanNet so the agent can "read the room").

---

## 9. Implementation plan (start at 2 clients, scale to 6)

### Phase 0 — two clients, one squad, manual targets
GL + 1 Lieutenant with MacroQuest + autologin + EQBC/DanNet; Lieutenant owns 5 bots; build the
**agent bridge** (drive a client: move, chat, bot commands). Grant the scoped teleport command and
verify bots follow a `#zone`. *Exit:* agent teleports the Lt squad to a zone, it fights/loots/auto-
equips, GL sits in guild chat.

### Phase 1 — player grouping + shadow
Hook the player zone event so a squad teleports to the player and groups up (Modes A/B); implement the
drop-matching-class logic.

### Phase 2 — Quartermaster v1
DB gear poll + scoring + item->source reverse lookup; GL dispatches a Lieutenant to farm a specific
upgrade; auto-equip; guild-chat narration.

### Phase 3 — scale to 6 + agent brain
Add Lieutenants to the full balanced five; LLM quartermaster reasoning + guild-chat personality;
5 parallel expeditions; raid assembly (Mode C) with GL filler.

---

## 10. Open decisions
- **Hardware / deployment (decided — Config A):** RAM/VRAM is the constraint. Local LLM =
  **Qwen2.5-14B-Instruct, Q3_K_M (7.3 GB)**, latency-tolerant (§5, off the hot path), so partial CPU
  offload is fine. Layout:
  - **32 GB i9 box (always-on):** akk-stack server + all 6 agent clients (GL + 5 Lts) + their MQ
    instances + the executor that drives them. ~15-18 GB typical; full raid is the peak.
  - **3070 Ti laptop:** main character client + the Qwen **brain** (GPU-accelerated). ~13-15 GB.
    Brain drives the fleet over the LAN (§4).
  - **Guild uptime = laptop uptime.** The guild runs while the main client + LLM are up. For extended
    autonomous farming, park the character safely and leave the laptop awake — disable idle sleep so
    the brain isn't severed. (This gives most of a 24/7 guild's benefit without moving the brain to the
    slow box.)
  - **Client instances (separate folder per client):** each EQ client runs from its **own copy of the
    client folder** (it writes eqclient.ini/UI/logs to its own dir; shared folders corrupt config).
    Configure ONE lightweight Lieutenant folder, then clone it 5x. The laptop's play client keeps
    normal/high settings. ~3-5 GB per copy (disk is cheap).
  - **Lightweight client config** (each background client; `[Defaults]` in eqclient.ini unless noted):
    - `MaxBGFPS=20` — caps unfocused-window FPS (the main multibox saver). Keep ~15-25; **0 = uncapped,
      not lowest**, and below ~15 degrades macros/autofollow.
    - `MaxFPS=30` — foreground cap (low for background clients; play client can be 60+).
    - `ClientCore=-1` — let the OS schedule across cores (formerly `CPUAffinity`; don't pin).
    - `AllLuclinPcModelsOff=TRUE`; `stickfigures=1` — lighter models / stick figures.
    - Windowed + small resolution (edit windowed width/height).
    - In-game Options: particles/shadows/reflections off, clip plane min, detail low, **sound off**,
      hide chat spam.
    - Optional MQ: MQ2EQWire (paid) skips drawing background boxes entirely — biggest CPU saver at scale.
    - Well-tuned clients are light (~sub-1% CPU and a few hundred MB each); 6 won't stress the i9.
  - **Must-fix already applied:** server moved off the laptop (server + LLM + main client would have
    overcommitted 16 GB).
- **The five Lieutenant classes:** which balanced five, and how Mode A handles player-class duplication.
- **Bots follow teleport vs. re-summon on arrival** — DECIDED (Phase 0d, 2026-05-31): bots zone with
  their owner natively on `#zone`. Re-summon is implemented as a fallback but not needed by default.
- **Gear scoring source:** hand-authored weights vs. derived from item data.
- **Farm give-up policy:** timeout/fallback for low-drop targets.

---

## 11. Risk notes
- **6 simultaneous clients** is the real resource constraint — bots are cheap, clients are not.
- **Teleport privilege** — scope the account status to only the movement command(s), not full GM.
- **Bot-follows-teleport** — VERIFIED working (Phase 0d): bots follow `#zone` natively. Re-summon
  fallback kept but unused.
- **Gear scoring is a heuristic** — good-enough beats perfect.
- **One guild-brain agent, not N** — coherence + LLM cost.
- **Private use only** — LAN server; MacroQuest is local tooling; you hold the clients.

---

## 12. Alternative considered, and the Godot tie-in
- **Server-side fork (C++):** autonomous bots in a forked server — cleanest result, most engine work,
  a fork to maintain. Chosen against in favor of the agent-driven model.
- **Godot project:** the ownable, shareable long game. The Quartermaster, grouping-mode, and
  squad-orchestration designs carry over as concepts.