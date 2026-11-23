import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentBuilder, ChannelType } from 'discord.js';
import { config, getSettings, updateSettings, DATA_DIR, ROOT } from '../config.js';
import { bus, recentActivity, activity } from '../events.js';
import { listModels, openRouterModels } from '../llm.js';
import { respond } from '../companion.js';
import { setPersona } from '../persona.js';
import * as memory from '../memory.js';
import { sessions, leaveChannel, joinChannel } from '../voice/session.js';
import { sttEngine, transcribeSpeech } from '../voice/stt.js';
import * as pcMic from '../voice/pcMic.js';
import { synthesize } from '../voice/fishAudio.js';
import * as emotion from '../emotion.js';
import * as characters from '../characters.js';
import * as music from '../music.js';
import * as video from '../avatarVideo.js';
import * as avatarLive from '../avatarLive.js';
import * as pressure from '../pressure.js';
import * as looks from '../looks.js';
import { theaterRoutes } from '../theater.js';
import { sleep } from '../sleep.js';
import { liveMind, mindRoutes } from '../cognitive-graph.js';
import { mindPageOpened } from '../mind-view.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ANIM_DIR = path.join(DATA_DIR, 'anims');
const startedAt = Date.now();

// songs being sung in her voice from the Songs page: id -> { title, state, file }
const songJobs = new Map();

export function startDashboard(bot) {
  const routes = buildRoutes(bot);

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Companion dashboard"' });
        return res.end('Password required');
      }
      // Block other websites from driving the API through your browser.
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return send(res, 403, { error: 'Cross-origin request blocked' });
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

      // Decode so IDs like "voice:123" match even when the browser sends "voice%3A123".
      const pathname = decodeURIComponent(url.pathname);
      for (const [method, pattern, handler] of routes) {
        const match = method === req.method && pathname.match(pattern);
        if (match) {
          // Binary uploads (mic audio, .glb models) are read by their own handler.
          const ct = String(req.headers['content-type'] || '');
          const binary = ct === 'application/octet-stream' || ct.startsWith('model/') || /\/model$/.test(pathname);
          // a hologram turn can carry files (a photo, a PDF): up to 40 MB there, 1 MB everywhere else
          const body = ['POST', 'PUT'].includes(req.method) && !binary ? await readJson(req, pathname === '/api/lyra/turn' ? 40e6 : 1e6) : {};
          const result = await handler({ req, res, url, params: match.groups ?? {}, body });
          if (result !== undefined) send(res, 200, result);
          return;
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  });

  server.listen(config.dashboard.port, config.dashboard.host, () => {
    const shown = config.dashboard.host === '0.0.0.0' ? 'localhost' : config.dashboard.host;
    activity('ready', { message: `Dashboard at http://${shown}:${config.dashboard.port}` });
  });
  server.on('error', (err) => activity('error', { where: 'dashboard', message: err.message }));
  return server;
}

function buildRoutes(bot) {
  const r = (method, pattern, handler) => [method, new RegExp(`^${pattern}$`), handler];
  // The Discord client while the bot is online, else null.
  const online = () => (bot.client?.isReady() ? bot.client : null);
  const need = () => {
    const client = online();
    if (!client) throw Object.assign(new Error('The bot is offline. Turn it on first.'), { status: 503 });
    return client;
  };

  return [
    r('GET', '/api/status', () => {
      const client = online();
      const brainLabel = config.brain === 'nvidia' ? config.nvidia.model
        : config.brain === 'openrouter' ? config.openrouter.model
        : config.ollama.model;
      return {
        power: { status: bot.status, since: bot.since, error: bot.error, hasToken: Boolean(config.discordToken) },
        bot: client && { tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 128 }) },
        look: looks.statusForApi(),
        ping: client?.ws.ping ?? null,
        uptime: Date.now() - startedAt,
        guilds: client
          ? client.guilds.cache.map((g) => ({ id: g.id, name: g.name, members: g.memberCount, icon: g.iconURL({ size: 64 }) }))
          : [],
        voice: [...sessions.values()].map((s) => s.summary()),
        brain: config.brain,
        brainLabel,
        model: brainLabel,
        embedModel: config.embedder === 'nvidia' ? config.nvidia.embedModel : config.ollama.embedModel,
        fishReady: Boolean(config.fish.apiKey),
        fishVoiceId: config.fish.voiceId || null,
        searchReady: Boolean(config.tavily.apiKey),
        stt: sttEngine(),
        stats: memory.stats(),
        context: null,
      };
    }),

    r('POST', '/api/power/(?<action>on|off)', async ({ params }) => {
      if (params.action === 'on') {
        if (!config.discordToken) throw Object.assign(new Error('DISCORD_TOKEN is empty in .env'), { status: 400 });
        await bot.start();
      } else {
        await bot.stop();
      }
      return { status: bot.status };
    }),

    // Every voice channel the bot can see, with who's in it and whether it's allowed for /join.
    r('GET', '/api/voice-channels', () => {
      const client = online();
      if (!client) return [];
      const allowed = config.voice.channelIds;
      return [...client.guilds.cache.values()].flatMap((g) =>
        g.channels.cache
          .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
          .sort((a, b) => a.rawPosition - b.rawPosition)
          .map((c) => ({
            id: c.id,
            name: c.name,
            guildId: g.id,
            guild: g.name,
            members: c.members.filter((m) => !m.user.bot).map((m) => m.displayName),
            allowed: !allowed.length || allowed.includes(c.id),
            joined: sessions.get(g.id)?.channelId === c.id,
          })),
      );
    }),

    r('POST', '/api/voice/join', async ({ body }) => {
      const client = need();
      const channel = client.channels.cache.get(String(body.channelId ?? ''));
      if (!channel?.isVoiceBased()) throw Object.assign(new Error('Unknown voice channel'), { status: 404 });
      if (!config.fish.apiKey) throw Object.assign(new Error('Voice needs FISH_API_KEY in .env'), { status: 400 });
      // Transcripts go to the voice channel's built-in text chat.
      await joinChannel(channel, channel);
      return { ok: true };
    }),

    // Live activity feed (Server-Sent Events).
    r('GET', '/api/events', ({ req, res }) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const e of recentActivity) res.write(`data: ${JSON.stringify(e)}\n\n`);
      const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      bus.on('activity', onEvent);
      req.on('close', () => {
        clearInterval(keepAlive);
        bus.off('activity', onEvent);
      });
      return undefined;
    }),

    r('GET', '/api/settings', () => getSettings()),
    r('PUT', '/api/settings', ({ body }) => {
      const { persona, botName, ...rest } = body;
      setPersona({ name: botName, persona, reason: 'Edited in dashboard', changedBy: 'dashboard' });
      if (Object.keys(rest).length) {
        updateSettings(rest);
        activity('settings', { message: `Updated ${Object.keys(rest).join(', ')}` });
      }
      return getSettings();
    }),
    r('GET', '/api/persona/history', () => memory.personaHistory()),
    r('POST', '/api/persona/history/(?<id>\\d+)/restore', ({ params }) => {
      const version = memory.personaVersion(Number(params.id));
      if (!version) throw Object.assign(new Error('No such version'), { status: 404 });
      setPersona({
        name: version.name,
        persona: version.persona,
        reason: `Restored version from ${new Date(version.created_at).toLocaleString()}`,
        changedBy: 'dashboard',
      });
      return getSettings();
    }),
    r('GET', '/api/models', () => listModels()),
    r('GET', '/api/openrouter/models', () => openRouterModels()),
    r('GET', '/api/channels', () =>
      [...(online()?.guilds.cache.values() ?? [])]
        .flatMap((g) =>
          g.channels.cache
            .filter((c) => c.type === ChannelType.GuildText)
            .map((c) => ({ id: c.id, name: c.name, guild: g.name, position: c.rawPosition })),
        )
        .sort((a, b) => a.guild.localeCompare(b.guild) || a.position - b.position),
    ),

    // Looks (profile pictures / identity sheet gallery).
    r('GET', '/api/looks', () => looks.stateForApi()),
    r('GET', '/api/looks/reference', async ({ res }) => {
      const ref = looks.reference();
      const image = looks.referenceImage();
      if (!ref || !image) return send(res, 404, { error: 'No reference sheet yet' });
      res.writeHead(200, { 'Content-Type': ref.mime || 'image/png', 'Cache-Control': 'no-cache' });
      res.end(image.bytes);
      return undefined;
    }),
    r('GET', '/api/looks/image/(?<id>[\\w-]+)', async ({ res, params }) => {
      const image = looks.lookImage(params.id);
      if (!image) return send(res, 404, { error: 'No such look' });
      res.writeHead(200, { 'Content-Type': image.mime || 'image/png', 'Cache-Control': 'no-cache' });
      res.end(image.bytes);
      return undefined;
    }),
    r('POST', '/api/looks/(?<id>[\\w-]+)/active', ({ params }) => {
      const look = looks.setActive(params.id);
      if (!look) throw Object.assign(new Error('No such look'), { status: 404 });
      return looks.stateForApi();
    }),
    r('POST', '/api/looks/send', async ({ body }) => {
      const client = need();
      const look = looks.findLook(body.id);
      if (!look) throw Object.assign(new Error('No look to send'), { status: 404 });
      const image = looks.lookImage(look.id);
      if (!image) throw Object.assign(new Error('That look image is missing'), { status: 404 });
      const channel = await client.channels.fetch(String(body.channelId ?? '')).catch(() => null);
      if (!channel?.isTextBased?.()) throw Object.assign(new Error('Pick a text channel first'), { status: 400 });
      await channel.send({ files: [new AttachmentBuilder(image.bytes, { name: image.file })] });
      activity('file', { filename: image.file, bytes: image.bytes.length, to: `#${channel.name}` });
      return { sent: true, channel: channel.name, look: look.name };
    }),

    // Soft stubs for Student dashboard tabs Luna doesn't fully host yet.
    r('GET', '/api/context', () => ({
      last: null,
      recent: [],
      limits: {
        historyLimit: config.historyLimit,
        historyOverlap: 20,
        summaryEvery: 40,
        paragraphsPerRollup: 8,
        rollupAgeHours: 24,
        memoryTopK: 8,
        memoryMinScore: 0.2,
        contextTokens: config.ollama.numCtx || 0,
        contextSource: 'Context metering is not wired here yet — window size is a local estimate only.',
      },
      note: 'Context metering is not wired here yet.',
    })),
    r('GET', '/api/context/turns', () => []),
    r('GET', '/api/context/turn', () => null),
    // Her hologram is her avatar (companion server, port 8770). /api/hologram opens her talk page as Chris
    // (the owner key comes from companion/.env; the dashboard only listens on this PC);
    // /api/hologram?view=face|upper|full opens just her body, framed that way.
    r('GET', '/api/hologram', ({ res, url }) => {
      let env = '';
      try { env = readFileSync(path.join(ROOT, '..', 'companion', '.env'), 'utf8'); } catch {}
      const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
      const host = `http://${url.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost'}:${get('PORT') || 8770}`;
      const view = url.searchParams.get('view');
      const to = view ? `${host}/creator/?embed=1&view=${encodeURIComponent(view)}` : `${host}/${get('OWNER_KEY') ? `?owner=${encodeURIComponent(get('OWNER_KEY'))}` : ''}`;
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
      res.end();
      return undefined;
    }),
    // Chris's reminders, to-dos and check-in snooze (personal.js)
    r('GET', '/api/personal', async () => (await import('../personal.js')).personalSnapshot()),
    // Chris's spending (finance.js; /finance.html): see a month, and edit expenses, bills and budgets
    r('GET', '/api/finance', async ({ url }) => (await import('../finance.js')).financeView(url.searchParams.get('month') || undefined)),
    r('POST', '/api/finance/(?<kind>expense|bill|account|income|transfer|adjust)', async ({ params, body }) => (await import('../finance.js')).financeEdit(params.kind, 'add', 0, body)),
    r('PUT', '/api/finance/(?<kind>expense|bill|account|income|transfer|adjust)/(?<id>\\d+)', async ({ params, body }) => (await import('../finance.js')).financeEdit(params.kind, 'edit', params.id, body)),
    r('DELETE', '/api/finance/(?<kind>expense|bill|account|income|transfer|adjust)/(?<id>\\d+)', async ({ params }) => (await import('../finance.js')).financeEdit(params.kind, 'delete', params.id)),
    r('PUT', '/api/finance/budget', async ({ body }) => (await import('../finance.js')).financeEdit('budget', 'set', 0, body)),
    // Lyra Core: her own learning system's scoreboard (/core.html)
    r('GET', '/api/core', async () => (await import('../core/index.js')).core.stats()),
    r('POST', '/api/core/consolidate', async () => (await import('../core/index.js')).core.consolidate()),
    r('GET', '/api/life', async () => (await import('../life-view.js')).lifeView()),
    r('GET', '/api/journal', async () => {
      const { JOURNAL_DIR } = await import('../journal.js');
      const { readdir, readFile } = await import('node:fs/promises');
      if (!existsSync(JOURNAL_DIR)) return { days: [] };
      const files = (await readdir(JOURNAL_DIR)).filter((f) => f.endsWith('.md')).sort().reverse();
      const days = [];
      for (const f of files.slice(0, 60)) {
        days.push({ date: f.replace(/\.md$/, ''), text: await readFile(path.join(JOURNAL_DIR, f), 'utf8') });
      }
      return { days };
    }),
    r('GET', '/api/profiles/(?<userId>\\w+)', ({ params }) => {
      try { return memory.profiles?.read?.(params.userId) ?? null; } catch { return null; }
    }),
    r('DELETE', '/api/profiles/(?<userId>\\w+)', () => ({ removed: false })),
    r('POST', '/api/memory/wipe', () => {
      throw Object.assign(new Error('Memory wipe is disabled from this dashboard build. Clear data/companion.db manually if you mean it.'), { status: 501 });
    }),
    r('POST', '/api/system/fresh', () => {
      throw Object.assign(new Error('Full reset is disabled from this dashboard build.'), { status: 501 });
    }),

    r('GET', '/api/memories/users', () => memory.memoryUsers()),
    r('GET', '/api/memories/(?<userId>\\w+)', ({ params }) => memory.listMemories(params.userId)),
    r('POST', '/api/memories/(?<userId>\\w+)', async ({ params, body }) => {
      if (!body.content?.trim()) throw Object.assign(new Error('content is required'), { status: 400 });
      await memory.addMemoryManually(params.userId, body.content.trim());
      return memory.listMemories(params.userId);
    }),
    r('DELETE', '/api/memories/(?<userId>\\w+)/(?<id>\\d+)', ({ params }) => ({
      removed: memory.forget(params.userId, Number(params.id)),
    })),
    r('DELETE', '/api/memories/(?<userId>\\w+)', ({ params }) => ({ removed: memory.forget(params.userId) })),

    r('GET', '/api/conversations', () =>
      memory.conversations().map((c) => ({ ...c, label: conversationLabel(online(), c.conversation) })),
    ),
    r('GET', '/api/conversations/(?<id>[\\w:]+)', ({ params }) => memory.recentMessages(params.id, 200)),
    r('DELETE', '/api/conversations/(?<id>[\\w:]+)', ({ params }) => {
      memory.clearConversation(params.id);
      return { ok: true };
    }),

    r('POST', '/api/voice/(?<guildId>\\d+)/leave', ({ params }) => ({ left: leaveChannel(params.guildId) })),
    r('POST', '/api/voice/(?<guildId>\\d+)/say', ({ params, body }) => {
      const session = sessions.get(params.guildId);
      if (!session) throw Object.assign(new Error('Not in voice in that server'), { status: 404 });
      if (!body.text?.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
      session.say(body.text.trim());
      activity('replied', { conversation: session.conversation, voice: true, text: body.text.trim(), manual: true });
      return { ok: true };
    }),

    // Talk to the companion straight from the dashboard (uses the same brain and memory).
    r('POST', '/api/chat', async ({ body }) => {
      if (!body.text?.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
      const reply = await respond({
        conversation: 'dashboard',
        speaker: { id: 'dashboard', name: body.name?.trim() || 'Dashboard' },
        text: body.text.trim(),
      });
      return { reply };
    }),

    // ---- Lyra's hologram (D:\Lyra Real AI\companion): one mind for the hologram page, PC mic and Discord ----
    // The hologram server sends each turn here and speaks the reply itself (one TTS per reply).
    // Chris on the hologram is the same person as Chris on Discord (his Discord ID), so it's one memory of him.
    r('POST', '/api/lyra/turn', async ({ body }) => {
      const isOwner = Boolean(body.isOwner);
      const name = isOwner ? 'Chris' : (String(body.name || '').trim().slice(0, 24) || 'Visitor');
      const ownerId = config.ownerIds[0];
      const speaker = isOwner && ownerId
        ? { id: ownerId, name: 'Chris', username: 'solonaras2' }
        : { id: `holo:${name.toLowerCase()}`, name };
      const conversation = isOwner ? 'hologram' : `hologram:${name.toLowerCase()}`;
      if (isOwner && !body.cue) (await import('../personal.js')).setAway(false, 'talked to her on the hologram');
      const key = `lyra-${conversation}`;
      const cue = body.cue ? String(body.cue).slice(0, 1500) : undefined;
      let text = cue ? '' : String(body.text || '').trim().slice(0, 1500);
      // files pasted or dropped into the hologram chat (2026-11-23): read exactly like Discord attachments (attachments.js)
      let attached = { said: '', extra: '' };
      const files = !cue && Array.isArray(body.files) ? body.files.slice(0, 5).filter((f) => f?.base64 && f?.name) : [];
      if (files.length) {
        const { readAttachments } = await import('../attachments.js');
        const message = {
          content: text, author: { username: isOwner ? 'solonaras2' : name },
          attachments: new Map(files.map((f, i) => [String(i), { name: String(f.name).slice(0, 120), contentType: String(f.type || 'application/octet-stream'), size: Math.floor(String(f.base64).length * 0.75), url: `data:${f.type || 'application/octet-stream'};base64,${f.base64}` }])),
          flags: { has: () => false },
        };
        attached = await readAttachments(message, { owner: isOwner, conversation });
        text = [text, attached.said].filter(Boolean).join(' ').trim();
      }
      if (!cue && !text) throw Object.assign(new Error('text or cue is required'), { status: 400 });
      const sentences = [];
      let feelings = emotion.current(key);
      const gestures = [];
      const onSentence = (raw) => {
        const parsed = emotion.parseSentence(raw);
        const named = parsed.feelings ?? (parsed.text && emotion.guessFromReply(parsed.text));
        feelings = parsed.feelings ? emotion.feel(key, named) : named ? emotion.nudge(key, named) : emotion.current(key);
        if (parsed.text) sentences.push(parsed.text);
        gestures.push(...parsed.gestures);
      };
      const reply = await respond({
        conversation,
        speaker,
        text,
        cue,
        voice: true,
        onSentence,
        discord: { client: online() },
        seen: body.sees ? String(body.sees).slice(0, 800) : '', // how Chris looked: kept with what she remembers
        systemExtra: [
          attached.extra,
          `Right now you're talking through your hologram on Chris's computer${isOwner ? ', with Chris himself' : `, with ${name}, a visitor at the campus terminal`}. ` +
            `Whatever you say is spoken out loud in your voice, so keep it to plain spoken sentences.`,
          // what her webcam eyes see (who's there, their expressions, a described snapshot when someone asked her to look)
          body.sees ? `WHAT YOU SEE through your camera right now (real, live):\n${String(body.sees).slice(0, 1500)}\n` +
            `Use it naturally, like someone in the room would: notice smiles, tiredness, who's there. Don't narrate it constantly or list it.` : '',
          emotion.emotionPrompt(key),
        ].filter(Boolean).join('\n\n'),
      });
      const said = sentences.join(' ').trim() || emotion.stripTags(reply || '');
      return { reply: said, feelings, gestures: [...new Set(gestures)] };
    }),

    // ---- Avatar studio (/avatar.html) ----

    // The cast: everyone who can appear in the studio, with their name, persona, voice and mood.
    r('GET', '/api/avatar/characters', () =>
      characters.list().map(({ modelPath, ...c }) => ({ ...c, feelings: emotion.current(characters.emotionKey(c.id)) })),
    ),
    r('PUT', '/api/avatar/characters/(?<id>[\\w-]+)', ({ params, body }) => {
      const updated = characters.update(params.id, body);
      if (!updated) throw Object.assign(new Error('No such character'), { status: 404 });
      const { modelPath, ...rest } = updated;
      return rest;
    }),

    r('GET', '/api/avatar/library', () => ({ files: characters.library() })),

    // Microsoft Rocketbox mocap clips (converted JSON under data/anims).
    r('GET', '/api/avatar/anims', async () => {
      if (!existsSync(ANIM_DIR)) return { files: [] };
      const files = (await readdir(ANIM_DIR))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/i, ''))
        .sort();
      return { files };
    }),
    r('GET', '/api/avatar/anims/(?<name>[\\w.-]+)', async ({ res, params }) => {
      const name = params.name.replace(/\.json$/i, '');
      if (!/^[\w.-]+$/.test(name)) throw Object.assign(new Error('Invalid anim name'), { status: 400 });
      const file = path.join(ANIM_DIR, `${name}.json`);
      if (!existsSync(file)) throw Object.assign(new Error('No such anim'), { status: 404 });
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
      return undefined;
    }),

    // Persist a .glb for a character (octet-stream body; optional ?filename=).
    r('POST', '/api/avatar/characters/(?<id>[\\w-]+)/model', async ({ req, res, params, url }) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > characters.MAX_MODEL_BYTES + 1) {
          throw Object.assign(new Error(`Model too large (max ${characters.MAX_MODEL_BYTES / 1024 / 1024} MB)`), { status: 413 });
        }
        chunks.push(chunk);
      }
      const filename = url.searchParams.get('filename') || req.headers['x-filename'] || 'upload.glb';
      const updated = characters.saveModel(params.id, Buffer.concat(chunks), filename);
      const { modelPath, ...rest } = updated;
      return rest;
    }),

    // Point a character at an existing library file: { file: "avatars/foo.glb" }.
    r('POST', '/api/avatar/characters/(?<id>[\\w-]+)/model/use', ({ params, body }) => {
      const updated = characters.useLibraryModel(params.id, body.file);
      const { modelPath, ...rest } = updated;
      return rest;
    }),

    r('GET', '/api/avatar/model(?:/(?<id>[\\w-]+))?', async ({ res, params }) => {
      const c = characters.get(params.id ?? 'main');
      if (!c) return send(res, 404, { error: 'No such character' });
      try {
        const data = await readFile(c.modelPath);
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-cache' });
        res.end(data);
      } catch {
        send(res, 404, { error: `No model for ${c.name} at ${c.modelPath}` });
      }
    }),

    // Songs from the music library (including yt/ cache) for the studio player.
    r('GET', '/api/music/(?<file>.+)', async ({ res, params }) => {
      const file = decodeURIComponent(params.file);
      const root = path.resolve(music.MUSIC_DIR);
      const abs = path.resolve(root, file);
      if (!abs.startsWith(root + path.sep) && abs !== root) return send(res, 404, { error: 'No such song' });
      if (!existsSync(abs)) return send(res, 404, { error: 'No such song' });
      const type = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
      res.writeHead(200, { 'Content-Type': type[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream' });
      res.end(await readFile(abs));
    }),
    // Proxy live radio streams so the studio <audio> element isn't blocked by CORS.
    r('GET', '/api/radio/stream', async ({ req, res }) => {
      const u = new URL(req.url, 'http://localhost').searchParams.get('u') || '';
      if (!/^https?:\/\//i.test(u)) return send(res, 400, { error: 'Missing stream URL' });
      let upstream;
      try {
        upstream = await fetch(u, { headers: { 'User-Agent': 'HalMini-amy-smith/1.0', 'Icy-MetaData': '0' }, redirect: 'follow' });
      } catch (err) {
        return send(res, 502, { error: `Radio fetch failed: ${err.message}` });
      }
      if (!upstream.ok || !upstream.body) return send(res, 502, { error: `Radio upstream ${upstream.status}` });
      const ctype = upstream.headers.get('content-type') || 'audio/mpeg';
      res.writeHead(200, {
        'Content-Type': ctype,
        'Cache-Control': 'no-store',
        'Transfer-Encoding': 'chunked',
      });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
        }
      } catch {
        /* client hung up or stream ended */
      }
      res.end();
      return undefined;
    }),
    r('GET', '/api/music', () => ({ tracks: music.tracks(), playlists: music.playlists() })),
    // The Songs page (/songs.html): her songs, played in the call or sung in her voice (2026-11-22)
    r('GET', '/api/songs', async () => ({
      songs: music.tracks().sort((a, b) => b.at - a.at),
      calls: [...sessions.values()].map((s) => ({ guildId: s.guild?.id, ...s.summary(), playing: Boolean(s.music?.on) })),
      singing: [...songJobs.values()].filter((j) => Date.now() - j.at < 30 * 60_000),
      herVoice: (await import('../singvoice.js')).herVoiceReady(),
    })),
    r('POST', '/api/songs/play', ({ body }) => {
      const t = music.tracks().find((x) => x.file === body.file);
      if (!t) throw Object.assign(new Error('No such song'), { status: 404 });
      const call = body.guildId ? sessions.get(body.guildId) : [...sessions.values()][0];
      if (!call) throw Object.assign(new Error("She isn't in a voice call. Join one first (Overview)."), { status: 409 });
      call.playMusic([t.file], { titles: { [t.file]: t.title } });
      activity('music', { message: `Playing "${t.title}" in the call (from the Songs page)` });
      return { ok: true, message: `Playing "${t.title}" in the call.` };
    }),
    r('POST', '/api/songs/sing', async ({ body }) => {
      const { herVoiceReady, inHerVoice } = await import('../singvoice.js');
      if (!herVoiceReady()) throw Object.assign(new Error("Her singing voice (Seed-VC) isn't set up on this PC."), { status: 409 });
      const t = music.tracks().find((x) => x.file === body.file);
      if (!t) throw Object.assign(new Error('No such song'), { status: 404 });
      const id = `${Date.now()}`;
      const title = `${t.title.replace(/\s*\(Lyra\)$/i, '')} (Lyra)`;
      songJobs.set(id, { id, title: t.title, at: Date.now(), state: 'singing' });
      inHerVoice(readFileSync(path.join(music.MUSIC_DIR, t.file)), { ext: path.extname(t.file).slice(1) || 'mp3' })
        .then((buf) => {
          const file = music.addSong(buf, { title, about: `${t.title}, sung by Lyra in her own voice`, voice: 'lyra', source: 'sung' });
          songJobs.set(id, { ...songJobs.get(id), state: 'done', file, done: Date.now() });
          if (body.playInCall && sessions.size) [...sessions.values()][0].playMusic([file], { titles: { [file]: title } });
        })
        .catch((err) => songJobs.set(id, { ...songJobs.get(id), state: err.cancelled ? 'cancelled' : 'failed', error: err.message.slice(0, 200) }));
      return { ok: true, message: `Singing "${t.title}" in her voice: it takes about 2.6x the song's length.` };
    }),
    // stop: the song playing in the call, and anything still being sung in her voice
    r('POST', '/api/songs/stop', async () => {
      const { stopSinging } = await import('../singvoice.js');
      let inCall = 0;
      for (const s of sessions.values()) if (s.music?.on) { s.stopMusic(); inCall++; }
      const cancelled = stopSinging();
      for (const [id, j] of songJobs) if (j.state === 'singing') songJobs.set(id, { ...j, state: 'cancelled' });
      const done = [inCall && 'Stopped the song in the call', cancelled && `${inCall ? 'cancelled' : 'Cancelled'} ${cancelled} song${cancelled > 1 ? 's' : ''} she was singing`].filter(Boolean);
      return { ok: true, message: done.length ? `${done.join(' and ')}.` : "She wasn't singing anything." };
    }),
    r('DELETE', '/api/songs/(?<file>.+)', ({ params }) => ({ ok: true, message: `Moved "${music.trashSong(decodeURIComponent(params.file))}" to the trash folder.` })),
    // The Birthdays page (/birthdays.html): a calendar of his family's birthdays and dates (2026-11-23)
    r('GET', '/api/birthdays', async () => ({ people: (await import('../birthdays.js')).birthdaysAll() })),
    r('POST', '/api/birthdays', async ({ body }) => (await import('../birthdays.js')).birthdayPut(null, body)),
    r('PUT', '/api/birthdays/(?<id>\\d+)', async ({ params, body }) => (await import('../birthdays.js')).birthdayPut(params.id, body)),
    r('DELETE', '/api/birthdays/(?<id>\\d+)', async ({ params }) => (await import('../birthdays.js')).birthdayDelete(params.id)),
    r('GET', '/api/pressure', () => pressure.snapshot()),

    // Video replies: the recorder page's event stream, its "recording started", and the clip itself.
    r('GET', '/api/avatar/recorder', ({ req, res }) => {
      video.attachRecorder(req, res);
      return undefined;
    }),

    // Discord voice → studio lip sync + motion state for open Avatar pages.
    r('GET', '/api/avatar/live', ({ req, res }) => {
      avatarLive.attachLive(req, res);
      return undefined;
    }),
    r('GET', '/api/avatar/motion', () => avatarLive.getMotionState()),
    r('POST', '/api/avatar/motion', ({ body }) => avatarLive.setMotionState({ ...(body || {}), source: body?.source || 'manual' })),
    // Records a test line through the recorder page and returns the clip, to check it works.
    r('POST', '/api/avatar/recorder/test', async ({ res, body }) => {
      if (!video.recorderConnected()) throw Object.assign(new Error('Her video recorder is not running yet (it starts with her; give it a few seconds)'), { status: 409 });
      const clip = await video.requestClip(String(body.text || "Hey, it's me. This is a test of my video replies."));
      if (!clip) throw Object.assign(new Error('No clip came back; see the activity feed for why'), { status: 502 });
      res.writeHead(200, { 'Content-Type': video.isMp4(clip) ? 'video/mp4' : 'video/webm', 'Content-Length': clip.length });
      res.end(clip);
      return undefined;
    }),
    r('POST', '/api/avatar/recorder/(?<id>\\d+)/ack', ({ params }) => ({ ok: video.ack(params.id) })),
    r('POST', '/api/avatar/recorder/(?<id>\\d+)/failed', ({ params, body }) => ({ ok: video.finish(params.id, null, String(body.reason ?? 'the page reported a failure').slice(0, 200)) })),
    r('POST', '/api/avatar/recorder/(?<id>\\d+)', async ({ req, params }) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > video.MAX_CLIP_BYTES + 1) break; // finish() turns oversized clips into text-only
        chunks.push(chunk);
      }
      return { ok: video.finish(params.id, Buffer.concat(chunks)) };
    }),

    r('GET', '/api/avatar/status', () => ({
      botName: config.botName,
      model: config.ollama.model,
      fishReady: Boolean(config.fish.apiKey),
      fishVoiceId: config.fish.voiceId || null,
      stt: sttEngine(),
    })),

    // A character's current feelings (?character=id, default the main one).
    // POST { character, feelings: { name: 0..1 } } nudges them, { character, reset: true } calms them.
    r('GET', '/api/avatar/emotion', ({ url }) => ({
      feelings: emotion.current(characters.emotionKey(url.searchParams.get('character') || 'main')),
      emotions: emotion.EMOTIONS,
      gestures: emotion.GESTURES,
    })),
    r('POST', '/api/avatar/emotion', ({ body }) => {
      const key = characters.emotionKey(characters.get(body.character)?.id ?? 'main');
      if (body.reset) return { feelings: emotion.reset(key) };
      const feelings = {};
      for (const [name, v] of Object.entries(body.feelings ?? {})) {
        if (emotion.EMOTIONS[name]) feelings[name] = Math.max(0, Math.min(1, Number(v) || 0));
      }
      return { feelings: emotion.nudge(key, feelings) };
    }),

    // Push-to-talk: raw 48kHz mono 16-bit PCM in, transcript out (browser fallback).
    r('POST', '/api/avatar/listen', async ({ req }) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 12e6) throw Object.assign(new Error('Recording too long'), { status: 413 });
        chunks.push(chunk);
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length < 9600) return { text: '' }; // under 0.1s
      return { text: (await transcribeSpeech(pcm)) || '' };
    }),

    // PC microphone (server-side ffmpeg) — works when the browser mic is blocked.
    r('GET', '/api/avatar/mic/devices', async () => pcMic.listMicDevices()),
    r('GET', '/api/avatar/mic/status', () => pcMic.micStatus()),
    r('POST', '/api/avatar/mic/start', async ({ body }) => pcMic.startMic({ device: body?.device })),
    r('POST', '/api/avatar/mic/listen', async ({ body }) => pcMic.startListen({ device: body?.device })),
    r('POST', '/api/avatar/mic/stop', async () => {
      const { pcm, ms, device } = pcMic.stopMic();
      if (!pcm.length || pcm.length < 9600) return { text: '', ms, device };
      const text = (await transcribeSpeech(pcm)) || '';
      return { text, ms, device };
    }),
    // Hands-free: pop a VAD-completed utterance and transcribe it.
    r('POST', '/api/avatar/mic/utterance', async () => {
      const u = pcMic.takeUtterance();
      if (!u?.pcm?.length) return { text: '', ready: false };
      if (u.pcm.length < 9600) return { text: '', ready: true, ms: u.ms, device: u.device };
      const text = (await transcribeSpeech(u.pcm)) || '';
      return { text, ready: true, ms: u.ms, device: u.device };
    }),

    // Streams the reply as NDJSON, one line per sentence with its Fish Audio clip (base64 mp3),
    // so the avatar starts talking while the rest is still being generated.
    // Also forwards live activity (plan / memory / tools / errors) as `cortex` lines for the brain panel.
    r('POST', '/api/avatar/chat', async ({ req, res, body }) => {
      // auto: banter mode. Nobody spoke; body.character takes the next turn in the cast's conversation.
      const auto = Boolean(body.auto);
      if (!auto && !body.text?.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
      if (auto && !characters.get(body.character)) throw Object.assign(new Error('Unknown character'), { status: 400 });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      let closed = false;
      res.on('close', () => (closed = true));
      const write = (obj) => !closed && res.write(JSON.stringify(obj) + '\n');

      const text = auto ? '' : body.text.trim();
      const person = body.name?.trim() || 'Dashboard';

      // Whoever is named answers ("Leo, ..."); otherwise whoever the person was talking to.
      const character = characters.get(auto ? body.character : characters.addressee(text, body.character));
      const key = characters.emotionKey(character.id);
      const others = characters.list().filter((c) => c.id !== character.id).map((c) => c.name);
      write({ type: 'speaker', character: character.id });
      // Opening pathway: what a studio turn always walks through.
      write({
        type: 'pathway',
        systems: auto
          ? ['brain', 'feelings', 'voice', 'lips']
          : ['hearing', 'intake', 'memory', 'brain', 'voice', 'lips'],
        label: auto ? 'banter turn' : 'studio turn',
      });

      // Mirror companion/tool activity onto the cortex while this reply runs.
      const onAct = (e) => {
        if (closed) return;
        if (e.conversation && e.conversation !== 'avatar') return;
        for (const spark of cortexSparksFromActivity(e)) write({ type: 'cortex', ...spark });
      };
      bus.on('activity', onAct);
      const finish = () => { bus.off('activity', onAct); };

      // Only the main character may fall back to Fish's default voice; without a voice of their
      // own, the others would get a random voice for every sentence, so they stay silent instead.
      const voiceId = character.voiceId || (character.main ? undefined : null);
      const speak = body.speak !== false && Boolean(config.fish.apiKey) && voiceId !== null;
      if (body.speak !== false && voiceId === null) {
        write({ type: 'notice', message: `${character.name} has no voice yet. Set a Fish voice ID for them in Settings.` });
      }

      // In banter, the cue says whose line to answer; nobody's words are invented for the person.
      let cue;
      if (auto) {
        const last = memory.recentMessages('avatar', 1)[0];
        const lastName = last ? (last.role === 'assistant' ? last.name ?? config.botName : last.name) : null;
        cue =
          lastName && lastName !== character.name
            ? `${person} is listening quietly. It's your turn: reply to what ${lastName} just said, in character, talking with ${others.join(' and ')}. ` +
              `Keep it to one to three sentences. Don't repeat yourself or restate what was said; push the conversation forward, and now and then change the subject.`
            : `${person} is listening quietly. Start a conversation with ${others.join(' and ')} about anything that interests you, in character, in one to three sentences.`;
      }

      // Their first reaction, shown on their face while they think.
      const first = auto ? null : emotion.guessFromUser(text);
      write({ type: 'state', feelings: first ? emotion.nudge(key, first) : emotion.current(key) });

      // Each sentence: strip its feeling tag, fold it into her state, then fetch the clip.
      // Clips are fetched in parallel but sent in sentence order.
      let queue = Promise.resolve();
      const onSentence = (raw) => {
        const parsed = emotion.parseSentence(raw);
        const named = parsed.feelings ?? (parsed.text && emotion.guessFromReply(parsed.text));
        const feelings = parsed.feelings
          ? emotion.feel(key, named)
          : named ? emotion.nudge(key, named) : emotion.current(key);
        const clip = speak && !closed && parsed.text
          ? synthesize(parsed.text, { format: 'mp3', voiceId }).catch((err) => {
              write({ type: 'error', message: err.message });
              return null;
            })
          : null;
        queue = queue.then(async () => {
          const audio = await clip;
          write({ type: 'sentence', text: parsed.text, audio: audio ? audio.toString('base64') : null, feelings, gestures: parsed.gestures });
        });
      };

      try {
        const reply = await respond({
          conversation: 'avatar',
          speaker: { id: 'dashboard', name: person },
          text,
          voice: true,
          onSentence,
          character,
          cue,
          // The studio is "here": files and pictures appear in the chat. With the bot online,
          // she can also send files to Discord channels or DMs, since the dashboard is the owner.
          discord: {
            client: online(),
            showImage: (image) => write({ type: 'image', ...image }),
            showAudio: (track) => write({ type: 'audio', ...track }),
            studioMusic: (command) => write({ type: 'music', ...command }),
            sendHere: (file) => write({ type: 'file', name: file.name, base64: Buffer.from(file.attachment).toString('base64') }),
          },
          systemExtra: [
            others.length &&
              `${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} here too, in the same conversation. Their lines appear as "[Name]: ...". ` +
                `You can talk to them, react to them or tease them, but speak only as yourself, ${character.name}: never write their lines.`,
            emotion.emotionPrompt(key),
          ].filter(Boolean).join('\n\n'),
        });
        await queue;
        write({ type: 'cortex', system: 'voice', kind: 'speak', label: 'reply ready', intensity: 0.7 });
        write({ type: 'done', reply });
      } catch (err) {
        await queue;
        write({ type: 'cortex', system: 'faults', kind: 'default', label: err.message, intensity: 1.1 });
        write({ type: 'error', message: err.message });
      } finally {
        finish();
      }
      res.end();
      return undefined;
    }),

    r('GET', '/api/sleep', () => sleep.status()),
    r('POST', '/api/sleep', ({ body }) => {
      const action = String(body?.action || '').toLowerCase();
      if (action === 'sleep' || action === 'nap') {
        sleep.goToSleep({ nap: action === 'nap' });
        return sleep.status();
      }
      if (action === 'wake') {
        sleep.wake({ by: body?.by || 'dashboard', owner: true });
        return sleep.status();
      }
      throw Object.assign(new Error('action must be sleep, nap, or wake'), { status: 400 });
    }),

    ...theaterRoutes(),
    ...mindRoutes(liveMind),
  ];
}

/** Map activity-bus events → cortex sparks for the avatar brain panel. */
function toolSystem(name) {
  const n = String(name || '');
  if (/^music$|generate_music/.test(n)) return 'music';
  if (/generate_image/.test(n)) return 'images';
  if (/send_file|send_project|^files$/.test(n)) return 'files';
  if (/self|read_source|guide/.test(n)) return 'self';
  if (/web_search/.test(n)) return 'intake';
  if (/note|scratchpad|thread|obligation|rebuild_memories/.test(n)) return 'memory';
  if (/avatar_motion|motion/.test(n)) return 'body';
  if (/checkin|persona|switch_brain/.test(n)) return 'self';
  return 'files';
}

function cortexSparksFromActivity(e) {
  const out = [];
  switch (e.type) {
    case 'heard':
      out.push({ system: 'hearing', kind: 'word', label: `heard · ${(e.text || '').slice(0, 40)}`, intensity: 0.9 });
      out.push({ system: 'intake', kind: 'word', label: e.speaker || 'intake', intensity: 0.65 });
      break;
    case 'memory':
      out.push({
        system: 'memory',
        kind: 'think',
        label: e.count ? `recall · ${e.count} memor${e.count === 1 ? 'y' : 'ies'}` : 'recall',
        intensity: 0.85,
      });
      break;
    case 'plan':
      out.push({ system: 'brain', kind: 'think', label: 'composing', intensity: 0.75 });
      out.push({
        system: 'plan',
        kind: 'think',
        label: e.empty
          ? 'chat only'
          : [e.search && `search`, ...(e.tools || [])].filter(Boolean).join(' · ') || e.reason || 'plan',
        intensity: e.empty ? 0.45 : 1,
      });
      if (e.search) out.push({ system: 'intake', kind: 'tool', label: `web · ${e.search}`.slice(0, 48), intensity: 0.8 });
      for (const t of e.tools || []) {
        out.push({ system: toolSystem(t), kind: 'tool', label: `planned · ${t}`, intensity: 0.7 });
      }
      break;
    case 'tool-call':
      out.push({
        system: e.ok === false ? 'faults' : toolSystem(e.tool),
        kind: e.ok === false ? 'default' : 'tool',
        label: e.ok === false ? `${e.tool} failed` : `${e.tool}${e.action ? ` · ${e.action}` : ''}`,
        intensity: e.ok === false ? 1.1 : 1,
      });
      break;
    case 'error':
      out.push({ system: 'faults', kind: 'default', label: e.message || e.where || 'error', intensity: 1.15 });
      break;
    default:
      break;
  }
  return out;
}

function conversationLabel(client, id) {
  if (id === 'dashboard') return 'Dashboard playground';
  if (id === 'avatar') return 'Avatar studio';
  const [kind, ref] = id.split(':');
  if (kind === 'voice') return `🔊 ${client?.guilds.cache.get(ref)?.name ?? ref}`;
  const channel = client?.channels.cache.get(ref);
  if (!channel) return `# ${ref}`;
  if (channel.type === ChannelType.DM) return `DM · ${channel.recipient?.displayName ?? 'user'}`;
  return `#${channel.name} · ${channel.guild?.name ?? ''}`;
}

function authorized(req) {
  const password = config.dashboard.password;
  if (!password) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg' };

// Her hologram (the character creator, ../customizer) is also served here under /creator/, so the
// video recorder page can capture it (a page can only record a canvas from its own address).
const CREATOR = path.join(ROOT, '..', 'customizer');

async function serveStatic(res, pathname) {
  const creator = pathname.startsWith('/creator/');
  const base = creator ? CREATOR : PUBLIC;
  const rel = creator ? pathname.slice('/creator/'.length) || 'index.html' : pathname === '/' ? 'index.html' : pathname;
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

function send(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 1e6) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}
