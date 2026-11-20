// Lyra lives in Cyprus time (Chris, 2026-11-20): she knows the day and the time of day or night when you talk,
// and her night-time work (Lyra Core, sleep) follows the Cyprus night. config.js pins the whole runtime to
// Europe/Nicosia (LYRA_TIMEZONE to change it), so every clock in her is Cyprus time even if the PC's isn't.
export const TIMEZONE = process.env.LYRA_TIMEZONE || 'Europe/Nicosia';

const PARTS = [ // [from hour, name, how it feels]
  [0, 'small hours', 'the middle of the night; most people are asleep'],
  [5, 'early morning', 'the day is just starting'],
  [8, 'morning', ''],
  [12, 'midday', ''],
  [14, 'afternoon', ''],
  [18, 'evening', ''],
  [21, 'night', 'it is dark out; the day is winding down'],
];

export function partOfDay(d = new Date()) {
  const h = d.getHours();
  let p = PARTS[0];
  for (const x of PARTS) if (h >= x[0]) p = x;
  return p[1];
}

export const isNight = (d = new Date()) => d.getHours() >= 23 || d.getHours() < 5;

// "Thursday 20 November 2026, 9:41 pm (Cyprus): night. It is dark out; the day is winding down."
export function timeLine(d = new Date()) {
  const when = d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const h = d.getHours();
  const p = [...PARTS].reverse().find((x) => h >= x[0]);
  return `It's ${when} in Cyprus: ${p[1]}.${p[2] ? ` (${p[2][0].toUpperCase()}${p[2].slice(1)}.)` : ''}`;
}

// a short label for when something happened, for memories: "Thursday night", "Sunday morning"
export function momentLabel(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-GB', { weekday: 'long' })} ${partOfDay(d)}, ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}
