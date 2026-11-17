// Lyra on Discord, using lunabot's token (DISCORD_TOKEN). Ported from the Luna bot's Discord layer,
// wired to Lyra's own mind. Nothing is shared with or written to the Luna project.
//
// Text:  DMs, @mentions, channels in DISCORD_CHAT_CHANNEL_IDS, and any message starting with "Lyra".
// Slash: /join (she joins your voice channel), /leave.
// Voice: hears people (transcribed by her ears on this PC's GPU), answers in her Fish voice.
//        With several people in the call she only answers when someone says "Lyra".
// Chris: Discord user IDs in DISCORD_OWNER_IDS talk to her as Chris; everyone else is a campus visitor.
//
// One model request and one voice request per reply.

import { Client, Events, GatewayIntentBits, Partials, ChannelType, MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js";
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, AudioPlayerStatus,
  VoiceConnectionStatus, EndBehaviorType, NoSubscriberBehavior, StreamType,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { Readable } from "node:stream";

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const OWNER_IDS = list(process.env.DISCORD_OWNER_IDS);
const CHAT_CHANNELS = list(process.env.DISCORD_CHAT_CHANNEL_IDS);
const EARS = `http://127.0.0.1:${process.env.EARS_PORT || 8772}/transcribe`;
const WAKE = /\b(lyra|lira|lyre|leera|laura|lara|lyrah)\b/i; // what Whisper tends to hear for "Lyra"
const SILENCE_MS = 800, MIN_SPEECH_MS = 450, FRAME_MS = 20;

let ctx; // { turn, mind, clock, broadcast }

// ---------- who's talking ----------
function speaker(user, member) {
  const isOwner = OWNER_IDS.includes(user.id);
  let name = isOwner ? ctx.mind.OWNER : (member?.displayName || user.globalName || user.username || "Visitor").slice(0, 24);
  if (!isOwner && name.toLowerCase() === ctx.mind.OWNER.toLowerCase()) name = `${name} (visitor)`;
  return { name, isOwner };
}

// ---------- her voice for Discord (Ogg Opus straight from Fish, no conversion) ----------
async function voiceClip(text) {
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.FISH_API_KEY}`, "Content-Type": "application/json", model: process.env.FISH_MODEL || "s1" },
    body: JSON.stringify({ text, reference_id: process.env.FISH_VOICE_LYRA, format: "opus", latency: "balanced" }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`voice ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- text ----------
function split(text, max = 2000) {
  const out = [];
  while (text.length > max) { let c = text.lastIndexOf(" ", max); if (c < max / 2) c = max; out.push(text.slice(0, c)); text = text.slice(c).trimStart(); }
  out.push(text); return out;
}
const where = (msg) => (msg.channel.type === ChannelType.DM ? "a Discord DM" : `#${msg.channel.name} on Discord`);

async function onMessage(client, msg) {
  if (msg.author.bot || !msg.content) return;
  const isDM = msg.channel.type === ChannelType.DM;
  const mentioned = msg.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
  const named = /^\s*(hey\s+)?lyra\b[\s,:!?]*/i.test(msg.content);
  if (!isDM && !mentioned && !named && !CHAT_CHANNELS.includes(msg.channelId)) return;
  const text = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  if (!text) return;

  const { name, isOwner } = speaker(msg.author, msg.member);
  ctx.mind.arrive(name);
  const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
  msg.channel.sendTyping().catch(() => {});
  try {
    const r = await ctx.turn({ name, isOwner, voice: "none", content: `[${ctx.clock()}] (typed in ${where(msg)}) ${text.slice(0, 1500)}` });
    clearInterval(typing);
    if (r.error) { await msg.reply({ content: r.error === "busy" ? "One second, I'm still talking to someone." : "Something glitched. Try again?", allowedMentions: { repliedUser: false } }); return; }
    ctx.broadcast("discord", isOwner ? { who: name, mood: r.mood, gesture: r.gesture, state: r.state } : { who: name, text, ...r });
    discord.note("text", `${name} (${where(msg)}): "${text}" → ${r.speech ? `"${r.speech}"` : "(stayed quiet)"}`);
    if (!r.speech) return; // she chose to stay quiet
    const parts = split(r.speech);
    await msg.reply({ content: parts[0], allowedMentions: { repliedUser: false, parse: [] } });
    for (const p of parts.slice(1)) await msg.channel.send({ content: p, allowedMentions: { parse: [] } });
  } catch (e) {
    clearInterval(typing);
    discord.note("error", `reply failed: ${e.message}`);
    await msg.reply({ content: "My mind went blank for a second. Try again?", allowedMentions: { repliedUser: false } }).catch(() => {});
  }
}

// ---------- voice ----------
const sessions = new Map(); // guildId -> VoiceSession

class VoiceSession {
  constructor(connection, channel) {
    this.connection = connection; this.guild = channel.guild; this.channelId = channel.id; this.channelName = channel.name;
    this.listening = new Set();
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on("error", (e) => console.error("Voice playback:", e.message));
    connection.subscribe(this.player);
    connection.receiver.speaking.on("start", (id) => this.listen(id));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]);
      } catch { this.destroy(); }
    });
  }
  get speaking() { return this.player.state.status !== AudioPlayerStatus.Idle; }
  humans() { return this.guild.channels.cache.get(this.channelId)?.members.filter((m) => !m.user.bot).size ?? 0; }

  listen(userId) {
    if (this.listening.has(userId) || userId === this.guild.client.user.id) return;
    this.listening.add(userId);
    const stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
    const decoder = new OpusScript(48000, 2, OpusScript.Application.VOIP);
    const pcm = []; let frames = 0;
    stream.on("data", (packet) => {
      try {
        const b = decoder.decode(packet); // 48 kHz stereo 16-bit
        const mono = Buffer.alloc(b.length >> 1);
        for (let i = 0, o = 0; i + 3 < b.length; i += 4, o += 2) mono.writeInt16LE((b.readInt16LE(i) + b.readInt16LE(i + 2)) >> 1, o);
        pcm.push(mono); frames++;
      } catch { /* skip a corrupt packet */ }
    });
    stream.once("end", () => {
      this.listening.delete(userId); decoder.delete();
      if (frames * FRAME_MS < MIN_SPEECH_MS || this.speaking) return; // too short, or she's talking
      this.heard(userId, Buffer.concat(pcm)).catch((e) => console.error("Voice reply:", e.message));
    });
    stream.once("error", () => this.listening.delete(userId));
  }

  async heard(userId, pcm) {
    const r = await fetch(EARS, { method: "POST", body: pcm, headers: { "Content-Type": "application/octet-stream" }, signal: AbortSignal.timeout(30000) })
      .then((x) => x.json()).catch(() => null);
    if (!r) { discord.note("error", "voice: her ears aren't running (ears/ears.py), so she can't hear the call"); return; }
    const text = (r.text || "").trim();
    if (!text) return;
    if (this.humans() > 1 && !WAKE.test(text)) { discord.note("heard", `(not for her) ${text}`); return; } // a group call: only when someone says her name
    const member = this.guild.members.cache.get(userId) ?? (await this.guild.members.fetch(userId).catch(() => null));
    const { name, isOwner } = speaker(member?.user ?? { id: userId }, member);
    ctx.mind.arrive(name);
    const out = await ctx.turn({ name, isOwner, voice: "none", content: `[${ctx.clock()}] (said out loud in the Discord voice call "${this.channelName}") ${text}` });
    if (out.error || !out.speech) return;
    ctx.broadcast("discord", isOwner ? { who: name, voiceCall: true, mood: out.mood, gesture: out.gesture, state: out.state } : { who: name, text, voiceCall: true, ...out });
    discord.note("voice", `${name} (call): "${text}" → "${out.speech}"`);
    const clip = await voiceClip(out.speech);
    this.player.play(createAudioResource(Readable.from(clip), { inputType: StreamType.OggOpus }));
  }

  async say(text) {
    const clip = await voiceClip(text);
    this.player.play(createAudioResource(Readable.from(clip), { inputType: StreamType.OggOpus }));
  }

  destroy() {
    sessions.delete(this.guild.id);
    try { this.player.stop(true); this.connection.destroy(); } catch { /* already gone */ }
  }
}

async function join(channel) {
  const existing = sessions.get(channel.guild.id);
  if (existing?.channelId === channel.id) return existing;
  existing?.destroy();
  const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); }
  catch { connection.destroy(); throw new Error("couldn't connect to the voice channel within 20 seconds"); }
  const s = new VoiceSession(connection, channel);
  sessions.set(channel.guild.id, s);
  return s;
}

// ---------- slash commands ----------
const COMMANDS = [
  new SlashCommandBuilder().setName("join").setDescription("Lyra joins your voice channel and listens").setDMPermission(false),
  new SlashCommandBuilder().setName("leave").setDescription("Lyra leaves the voice channel").setDMPermission(false),
];

async function onCommand(i) {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === "join") {
    const channel = i.member?.voice?.channel;
    if (!channel) return i.reply({ content: "Join a voice channel first, then /join.", flags: MessageFlags.Ephemeral });
    await i.deferReply();
    try {
      const s = await join(channel);
      discord.note("voice", `Joined ${channel.name} in ${channel.guild.name}`);
      const { name, isOwner } = speaker(i.user, i.member);
      await i.editReply(`I'm in **${channel.name}**. Just talk${s.humans() > 1 ? ", and say my name so I know it's for me" : ""}.`);
      const hello = await ctx.turn({ name, isOwner, voice: "none", content: `[${ctx.clock()}] (${name} just brought you into the Discord voice call "${channel.name}". Say a short hello out loud.)` });
      if (hello.speech) await s.say(hello.speech);
    } catch (e) { await i.editReply(`I couldn't join: ${e.message}`); }
  } else if (i.commandName === "leave") {
    const s = sessions.get(i.guildId);
    if (!s) return i.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
    s.destroy(); discord.note("voice", `Left ${s.channelName} (/leave)`);
    await i.reply("Okay. I'll be here if you need me.");
  }
}

async function registerCommands(client) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  const body = COMMANDS.map((c) => c.toJSON());
  // per server = instant; the bot is in a handful of servers
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body }).catch((e) => console.error(`Slash commands in ${guild.name}:`, e.message));
  }
}

// for offline tests only
export const _test = { setContext: (c) => { ctx = c; }, onMessage, speaker };

// ---------- on / off (the dashboard drives this) ----------
export const discord = {
  client: null, state: "offline", since: Date.now(), error: null, log: [],
  note(kind, text) {
    discord.log.push({ at: Date.now(), kind, text: String(text).slice(0, 400) });
    if (discord.log.length > 80) discord.log.shift();
    ctx?.broadcast("discord-status", { state: discord.state });
  },
  set(state, error = null) { discord.state = state; discord.since = Date.now(); discord.error = error; ctx?.broadcast("discord-status", { state: discord.state }); },
  status() {
    const c = discord.client;
    return {
      state: discord.state, since: discord.since, error: discord.error, tokenSet: !!process.env.DISCORD_TOKEN,
      tag: c?.user?.tag || null, avatar: c?.user?.displayAvatarURL?.({ size: 64 }) || null,
      servers: c ? [...c.guilds.cache.values()].map((g) => g.name) : [],
      voice: [...sessions.values()].map((s) => ({ server: s.guild.name, channel: s.channelName, people: s.humans() })),
      log: discord.log.slice(-40),
    };
  },
  async start() {
    if (discord.client || !process.env.DISCORD_TOKEN) return discord.status();
    discord.set("starting");
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
      partials: [Partials.Channel],
    });
    client.once(Events.ClientReady, async (c) => {
      discord.set("online");
      discord.note("power", `Online as ${c.user.tag} in ${c.guilds.cache.size} server(s), talking as Lyra`);
      console.log(`Discord: online as ${c.user.tag} in ${c.guilds.cache.size} server(s). Talking as Lyra.`);
      if (!process.env.DISCORD_SKIP_COMMANDS) await registerCommands(c);
    });
    client.on(Events.MessageCreate, (m) => onMessage(client, m).catch((e) => discord.note("error", `message: ${e.message}`)));
    client.on(Events.InteractionCreate, (i) => onCommand(i).catch((e) => discord.note("error", `command: ${e.message}`)));
    client.on(Events.VoiceStateUpdate, (oldS) => {
      const s = sessions.get(oldS.guild.id);
      if (s && oldS.channelId === s.channelId && s.humans() === 0) { s.destroy(); discord.note("voice", `Left ${s.channelName}: everyone else left`); }
    });
    discord.client = client;
    try { await client.login(process.env.DISCORD_TOKEN); }
    catch (e) {
      discord.client = null; client.destroy().catch(() => {});
      discord.set("offline", e.message); discord.note("error", `login failed: ${e.message}`);
    }
    return discord.status();
  },
  async stop() {
    if (!discord.client) return discord.status();
    discord.set("stopping");
    for (const s of [...sessions.values()]) s.destroy();
    const c = discord.client; discord.client = null;
    await c.destroy().catch(() => {});
    discord.set("offline"); discord.note("power", "Logged out of Discord");
    return discord.status();
  },
  async leaveVoice() { for (const s of [...sessions.values()]) s.destroy(); discord.note("voice", "Left voice (dashboard)"); return discord.status(); },
};

export async function startDiscord(context, { login = false } = {}) {
  ctx = context;
  if (login) await discord.start();
  return discord;
}
