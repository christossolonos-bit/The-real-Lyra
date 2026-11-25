import { Client, Events, GatewayIntentBits, MessageFlags, Partials, ChannelType } from 'discord.js';
import { config, updateSettings } from './config.js';
import { loadCommands } from './loadCommands.js';
import { respond, SEARCH_ANNOUNCEMENT } from './companion.js';
import { sessions } from './voice/session.js';
import { requestClip, isMp4 } from './avatarVideo.js';
import { readAttachments, readSharedLinks, recentDocumentsLine } from './attachments.js';
import { activity } from './events.js';
import { sleep } from './sleep.js';

const commands = await loadCommands();

// Owns the Discord connection so the dashboard can turn the bot on and off without restarting the app.
export const bot = {
  client: null,
  status: 'offline', // offline | starting | online | stopping
  since: Date.now(),
  error: null,

  async start() {
    if (this.client) return;
    this.setStatus('starting');
    const client = createClient();
    this.client = client;
    try {
      await client.login(config.discordToken);
      updateSettings({ botEnabled: true });
    } catch (err) {
      this.client = null;
      client.destroy().catch(() => {});
      this.error = err.message;
      this.setStatus('offline');
      activity('error', { where: 'discord login', message: err.message });
      throw err;
    }
  },

  async stop() {
    if (!this.client) return;
    this.setStatus('stopping');
    for (const session of [...sessions.values()]) session.destroy();
    const client = this.client;
    this.client = null;
    await client.destroy();
    updateSettings({ botEnabled: false });
    this.setStatus('offline');
    activity('power', { message: 'Bot turned off' });
  },

  setStatus(status) {
    this.status = status;
    this.since = Date.now();
    if (status !== 'offline') this.error = null;
  },
};

function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers, // privileged: needed for speaker names in voice
    ],
    partials: [Partials.Channel], // required to receive DMs
  });

  client.once(Events.ClientReady, (c) => {
    bot.setStatus('online');
    activity('power', { message: `Online as ${c.user.tag} in ${c.guilds.cache.size} server(s)` });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      activity('error', { where: `/${interaction.commandName}`, message: err.message });
      const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || (!message.content && !message.attachments.size)) return; // voice notes and files have no text

    const isDM = message.channel.type === ChannelType.DM;
    const mentioned = message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true });
    const openChannel = config.chatChannelIds.includes(message.channelId);
    if (!isDM && !mentioned && !openChannel) return;

    let text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    // voice messages, photos and files: what he said in a voice note joins the text; what she reads goes to her prompt
    let attached = { said: '', extra: '' };
    const isOwnerMsg = config.ownerIds.includes(message.author.id);
    // someone on Chris's trusted list (trusted.js): their photos, files and links are read, as information only
    const trustedMsg = !isOwnerMsg && (await import('./trusted.js')).isTrusted(message.author.id);
    if (message.attachments.size) {
      message.channel.sendTyping().catch(() => {});
      attached = await readAttachments(message, { owner: isOwnerMsg, trusted: trustedMsg, conversation: `text:${message.channelId}` });
      text = [text, attached.said].filter(Boolean).join(' ').trim();
    }
    if (trustedMsg && /https?:\/\//i.test(text)) {
      message.channel.sendTyping().catch(() => {});
      const pages = await readSharedLinks(text, { from: message.member?.displayName ?? message.author.displayName ?? message.author.username, conversation: `text:${message.channelId}` });
      if (pages) attached.extra = [attached.extra, pages].filter(Boolean).join('\n\n');
    }
    if (!text) return;

    // Someone talking to her wakes her if she was asleep, then she answers.
    try {
      if (sleep.sleeping()) sleep.wake({ by: message.member?.displayName ?? message.author.username });
      else sleep.tick?.();
    } catch { /* sleep optional */ }

    const speaker = {
      id: message.author.id,
      name: message.member?.displayName ?? message.author.displayName,
      username: message.author.username,
      dm: isDM,
    };
    const files = []; // attachments the bot makes this turn ride along with its reply
    const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
    message.channel.sendTyping().catch(() => {});

    try {
      const reply = await respond({
        conversation: `text:${message.channelId}`,
        speaker,
        text,
        systemExtra: [attached.extra, isOwnerMsg ? recentDocumentsLine() : ''].filter(Boolean).join('\n\n') || undefined,
        onSearching: () =>
          message.reply({ content: `🔎 ${SEARCH_ANNOUNCEMENT}`, allowedMentions: { repliedUser: false } }).catch(() => {}),
        // voice: if she's in a voice channel in this server, typed music requests play there.
        discord: {
          client,
          guild: message.guild,
          sendHere: async (file) => files.push(file),
          // a message (and file) posted in this channel later, after this reply has gone (a song she's singing)
          postLater: (content, file) => message.channel.send({ content, files: file ? [file] : [], allowedMentions: { parse: [] } }),
          voice: message.guild && sessions.get(message.guild.id),
          // Background helpers report back here when they finish, long after this reply.
          notify: (text) => { for (const chunk of splitMessage(text)) message.channel.send({ content: chunk, allowedMentions: { parse: [] } }).catch(() => {}); },
        },
      });
      clearInterval(typing);
      const chunks = splitMessage(reply || '…');
      const last = chunks.length - 1;
      // A clip of her saying it, if the recorder page is open. The text goes out now regardless;
      // the clip is added to the same message when (and if) it arrives.
      const clip = reply ? requestClip(reply) : Promise.resolve(null);
      const first = await message.reply({ content: chunks[0], files: last === 0 ? files : [], allowedMentions: { repliedUser: false, parse: [] } });
      clip.then((video) => video && first.edit({ files: [{ attachment: video, name: isMp4(video) ? 'lyra.mp4' : 'lyra.webm' }] })).catch((err) => activity('error', { where: 'video reply', message: err.message }));
      for (const [i, chunk] of chunks.slice(1).entries()) {
        await message.channel.send({ content: chunk, files: i + 1 === last ? files : [], allowedMentions: { parse: [] } });
      }
      // a cast member may pop in after her (cast.js, 2026-11-25): as a message here, and spoken too if she's in a
      // voice call in this server and they have a voice
      if (reply) castFollowText({ message, text, reply, speaker }).catch((err) => activity('error', { where: 'cast pop-in', message: err.message }));
    } catch (err) {
      clearInterval(typing);
      activity('error', { where: 'text reply', message: err.message });
      await message.reply('My brain glitched for a sec, try again?').catch(() => {});
    }
  });

  async function castFollowText({ message, text, reply, speaker }) {
    const cast = await import('./cast.js');
    const pick = cast.whoPopsIn({ userText: text, reply, needVoice: false });
    if (!pick) return;
    const { recentMessages } = await import('./memory.js');
    const conversation = `text:${message.channelId}`;
    const recent = recentMessages(conversation, 8).map((m) => ({ name: m.role === 'assistant' ? m.name ?? config.botName : m.name ?? 'Someone', text: m.content }));
    const pop = await cast.popIn({ conversation, pick, userText: text, reply, recent, ownerName: speaker?.name || 'Chris' });
    if (!pop) return;
    await new Promise((r) => setTimeout(r, 1500)); // a beat after her, like someone walking up
    await message.channel.send({ content: `**${pop.name}:** ${pop.text}`, allowedMentions: { parse: [] } });
    const session = message.guild && sessions.get(message.guild.id);
    if (session && pop.voiceId) session.speakAs(pop.text, { voiceId: pop.voiceId }).catch(() => {});
  }

  // Leave voice when everyone else has left.
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const session = sessions.get(oldState.guild.id);
    if (!session) return;
    // Someone joined her channel: an intro if they've never met her, plus anything she owes them.
    if (newState.channelId === session.channelId && oldState.channelId !== session.channelId && newState.member) session.arrived([newState.member]);
    if (oldState.channelId !== session.channelId) return;
    const channel = oldState.guild.channels.cache.get(session.channelId);
    if (channel && !channel.members.some((m) => !m.user.bot)) session.destroy();
  });

  return client;
}

function splitMessage(text, max = 2000) {
  const chunks = [];
  while (text.length > max) {
    let cut = text.lastIndexOf('\n', max);
    if (cut < max / 2) cut = text.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  chunks.push(text);
  return chunks;
}
