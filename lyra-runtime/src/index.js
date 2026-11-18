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

// Her pressure buckets (boredom, curiosity, loneliness...): curiosity and boredom send her off to
// research and write in her journal; the rest speak up in voice calls (see pressure.js).
setResearcher(research);
startPressure();

// Sleep + dreams: she won't turn in while people are in a voice call with her.
sleep.setCompany(() => [...sessions.values()].some((s) => !s.destroyed && (s.humans?.()?.length ?? 0) > 0));
sleep.setDreamer(dreams);
// Lyra Core consolidates (merges, forgets, reasons new beliefs) as she falls asleep, and daily anyway.
const { core, consolidateIfDue } = await import('./core/index.js');
const coreLog = (r) => activity('core', { message: `Core consolidated: merged ${r.merged}, forgot ${r.forgotCases + r.forgotPhrases + r.forgotBeliefs}, concluded ${r.concluded.length}`, ...r });
sleep.setOnAsleep(() => { try { coreLog(core.consolidate()); } catch (err) { activity('error', { where: 'core sleep', message: err.message }); } });
setInterval(() => { try { consolidateIfDue(coreLog); } catch {} }, 6 * 3_600_000).unref();
sleep.start();
activity('sleep', { message: 'Sleep cycles armed' });

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
