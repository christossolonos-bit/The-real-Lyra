import { config } from './config.js';
import { checkOllama } from './llm.js';
import { activity } from './events.js';
import { bot } from './bot.js';
import { startDashboard } from './dashboard/server.js';
import { loadWhisper } from './voice/whisper.js';
import { startPressure, setResearcher } from './pressure.js';
import { research } from './journal.js';
import { startContinuity } from './continuity.js';
import { sleep } from './sleep.js';
import { dreams } from './dreams.js';
import { sessions } from './voice/session.js';

// Ollama only required if it's the chat brain or embedder; default is NVIDIA.
if (config.brain === 'ollama' || config.embedder === 'ollama') {
  await checkOllama().catch((err) => {
    console.error(`Ollama check failed: ${err.message}`);
    process.exit(1);
  });
} else {
  console.log(`[startup] teacher=${config.brain} embedder=${config.embedder} model=${config.nvidia.embedModel}`);
}

process.on('unhandledRejection', (err) => activity('error', { where: 'unhandled', message: String(err?.message ?? err) }));

// The dashboard always runs; the Discord bot can be switched on and off from it.
startDashboard(bot);

// Her video recorder (Discord text replies get a short MP4 of her hologram saying them). Hidden, starts by itself.
const { startRecorder } = await import('./recorder-launcher.js');
startRecorder();

// Her pressure buckets (boredom, curiosity, loneliness...): curiosity and boredom send her off to
// research and write in her journal; the rest speak up in voice calls (see pressure.js).
setResearcher(research);
startPressure();

// Sleep + dreams: she won't turn in while people are in a voice call with her.
sleep.setCompany(() => [...sessions.values()].some((s) => !s.destroyed && (s.humans?.()?.length ?? 0) > 0));
sleep.setDreamer(dreams);
// Lyra Core consolidates (merges, forgets, reasons new beliefs) as she falls asleep, and daily anyway.
const { core, consolidateIfDue, nightWork } = await import('./core/index.js');
const coreLog = (r) => activity('core', { message: `Core consolidated: merged ${r.merged}, forgot ${r.forgotCases + r.forgotPhrases + r.forgotBeliefs}, concluded ${r.concluded.length}`, ...r });
sleep.setOnAsleep(() => { try { nightWork(coreLog); } catch (err) { activity('error', { where: 'core sleep', message: err.message }); } });
setInterval(() => { try { consolidateIfDue(coreLog); } catch {} }, 20 * 60_000).unref(); // Cyprus small hours
sleep.start();
activity('sleep', { message: 'Sleep cycles armed' });

// Chris's reminders (personal.js): out loud on the hologram page if it's open (in her own words), else in a
// Discord voice call he's in, else a Discord DM.
{
  const { startReminders } = await import('./personal.js');
  const { readFileSync } = await import('node:fs');
  const path = (await import('node:path')).default;
  const { ROOT } = await import('./config.js');
  const companionEnv = () => {
    try { return readFileSync(path.join(ROOT, '..', 'companion', '.env'), 'utf8'); } catch { return ''; }
  };
  const get = (env, k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const { presence } = await import('./personal.js');
  startReminders(async (r) => {
    const env = companionEnv();
    const ways = [];
    const owner = config.ownerIds[0];
    // always a DM, so it reaches his phone wherever he is (Chris, 2026-11-20)
    if (bot.client && owner) {
      try {
        const user = await bot.client.users.fetch(owner);
        await user.send(`⏰ ${r.times ? 'Reminder again' : 'Reminder'}: ${r.text}`);
        ways.push('Discord DM');
      } catch {}
    }
    // and out loud on the hologram page when he's home
    if (!presence().away) {
      try {
        const res = await fetch(`http://127.0.0.1:${get(env, 'PORT') || 8770}/api/announce`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90_000),
          body: JSON.stringify({ ownerKey: get(env, 'OWNER_KEY'), kind: 'reminder', text: r.text, again: r.times > 0 }),
        });
        if ((await res.json()).delivered) ways.push('hologram');
      } catch {}
    }
    if (!ways.length) {
      for (const s of sessions.values()) {
        if (!s.destroyed && s.humans?.().some((m) => m.id === owner)) { s.say(`Chris, ${r.times ? 'just reminding you again' : 'your reminder'}: ${r.text}`); ways.push('Discord voice'); break; }
      }
    }
    if (!ways.length) throw new Error('nowhere to remind him: Discord offline and the hologram page closed');
    return ways.join(' + ');
  });
}

// Chris's day (daily.js): shift reminders, out while at work, the morning brief as a DM at his time
{
  const { startDaily } = await import('./daily.js');
  const { respond } = await import('./companion.js');
  startDaily({
    sendBrief: async (facts) => {
      const owner = config.ownerIds[0];
      if (!bot.client || !owner) throw new Error('Discord offline: morning brief not sent');
      const user = await bot.client.users.fetch(owner);
      const dm = await user.createDM();
      const reply = await respond({
        conversation: `text:${dm.id}`,
        speaker: { id: owner, name: 'Chris', username: user.username },
        cue: `It's morning. Send Chris his morning brief as a short Discord message in your own words (not a list read out): what's on today, anything due, the weather, and a line about yesterday if you know it. The facts:\n${facts}`,
      });
      if (reply?.trim()) await user.send(reply.trim().slice(0, 1900));
    },
  });
}

// Chris's spending tracker (finance.js): bills due tomorrow become reminders; budget warnings, bills that need an
// amount and the monthly summary come as a Discord DM
{
  const { startFinance } = await import('./finance.js');
  const { addReminder } = await import('./personal.js');
  startFinance({
    remind: async (text, due) => addReminder(text, due),
    dm: async (text) => {
      const owner = config.ownerIds[0];
      if (!bot.client || !owner) throw new Error('Discord offline: money note not sent');
      await (await bot.client.users.fetch(owner)).send(text);
    },
  });
}

// Continuity: a heartbeat so downtime is known after a restart, plus her recent mistakes.
startContinuity();

// Load local Whisper in the background: it's the main transcriber, or Groq's instant fallback.
if (config.stt !== 'fish') loadWhisper().catch((err) => activity('error', { where: 'whisper', message: err.message }));

if (!config.discordToken) {
  activity('error', { where: 'startup', message: 'DISCORD_TOKEN is empty in .env, so the bot stays offline' });
} else if (config.botEnabled) {
  bot.start().catch(() => {});
} else {
  activity('power', { message: 'Bot is switched off. Turn it on from the dashboard.' });
}
