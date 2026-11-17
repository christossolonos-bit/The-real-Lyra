# The real Lyra

Lyra from the *Lyra AI* series, brought to life on a PC. She is the Vira data center in Death Valley, and the cyan hologram on the projector disc is just her face.

She has one mind, and you can reach it in three ways:

- **Her hologram:** a 3D body you design yourself, rendered as her cyan hologram. You talk to her through your PC microphone, she answers in her own cloned voice, and her body moves with her mood.
- **Discord:** text, DMs and voice calls through a Discord bot.
- **Her dashboard:** her memory, feelings, wants, journal, the theater (watching YouTube together in a call), tools and settings.

She remembers people, has moods that come and go, speaks first when she has something on her mind, keeps a journal, and knows her own story (Episodes 1 to 4) as its narrator.

## What's in here

| Folder | What it is |
|---|---|
| `lyra-runtime/` | **Her mind.** Brain (NVIDIA Nemotron), long-term memory, contacts, feelings, wants, sleep and dreams, tools (web search, music, images, files, news), the theater, the Discord bot and its voice calls, and the dashboard on `http://127.0.0.1:3010`. Her persona and story canon are in `persona.md`. |
| `companion/` | **Her hologram.** The talk page (`http://localhost:8770`), her Fish Audio voice, and her ears (`ears/ears.py`: PC mic, Silero VAD and faster-whisper on the GPU). Every turn goes to her mind in `lyra-runtime`. If that isn't running, a small standalone mind (`src/mind.js`, `mind/`) answers instead. |
| `customizer/` | **Her body.** A three.js character creator (hair, face, skin, eyes, outfit, Lyra's series look, hologram preview) and the motion system: Rocketbox animations retargeted onto her skeleton (`retarget.js`), with idle, talk and listen sets picked by her mood. |
| `tools/` | Blender scripts used to build models and convert the Rocketbox animation pack (`convert_rocketbox_anims.py`). |

## Not in this repo (on purpose)

- **Keys and tokens.** Each part has its own `.env` (see below).
- **Her memories.** `companion/data/` and `lyra-runtime/data/`.
- **The body model.** `customizer/models/humanfemale_hd.glb` is a private model that isn't redistributable, so put your own rigged model there.
- **Big rebuildable files:** `node_modules/`, Whisper models, and `customizer/models/rocketbox_anims.glb`. Rebuild the last one from [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) with `tools/convert_rocketbox_anims.py`.

## Setup

Requirements: Node 22+, Python 3.11+ with `faster-whisper`, `silero-vad`, `sounddevice` and `numpy`, FFmpeg, and an NVIDIA GPU for fast local speech-to-text (optional).

1. `cd lyra-runtime && npm install`, then `cd ../companion && npm install`.
2. Create `lyra-runtime/.env` with `DISCORD_TOKEN`, `CLIENT_ID`, `OWNER_IDS` (your Discord user ID), `BOT_NAME=Lyra`, `VOICE_WAKE_WORD=lyra`, `BRAIN=nvidia`, `NVIDIA_API_KEY`, `FISH_API_KEY`, `FISH_VOICE_ID`, `TAVILY_API_KEY` (web search), and `DASHBOARD_PORT=3010`.
3. Create `companion/.env` with `NVIDIA_API_KEY`, `FISH_API_KEY`, `FISH_VOICE_LYRA`, `OWNER_KEY` (any random string: it marks you as the owner on her page), `PORT=8770`, `MIC_NAME` (part of your microphone's name), `WHISPER_MODEL=small.en` and `LYRA_CANON_UP_TO=4`.
4. Put a body model in `customizer/models/` and build the animation pack.

## Running her

1. `lyra-runtime/start.bat` starts her mind, dashboard and Discord. Turn Discord on with the power button on the dashboard.
2. `companion/Start Lyra.bat` starts her hologram, voice and ears, and opens her page as the owner.

On her page, just talk: your PC microphone is her ears. The **Dashboard** button opens her dashboard. In Discord, write "Lyra, ..." or DM her, and use `/join` to bring her into a voice call. In a group call she answers when someone says her name.

## Rules she keeps

- The secret of the stairwell behind the round door is never guessed or hinted at.
- She never claims to be human, and she's honest about being Lyra, an AI character, when sincerely asked.
- Visitors meet her inside the story. Only the owner gets her private side.
- One model request and one voice request per reply.
