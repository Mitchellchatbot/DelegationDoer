// One-liners shown under the "Welcome, {name}!" header in the SOD
// modal. Curated for tone — punchy, professional, not corporate-glib,
// safe for any audience. The picker is deterministic per (user, day)
// so a refresh during the same shift shows the same line.

export const MOTIVATIONAL_LINES: string[] = [
  "You can CRUSH it today!",
  "Big day ahead — you've got this.",
  "One focused hour beats a scattered three.",
  "Start with the hard thing. Future-you will thank you.",
  "Small wins stack. Stack a few today.",
  "Make today count.",
  "Show up. The rest follows.",
  "Pick one thing. Finish it. Repeat.",
  "Brave the inbox first — then the real work.",
  "Today is a clean slate.",
  "Done is better than perfect.",
  "Energy in, results out.",
  "Less talk, more ship.",
  "Tighten the loop. Move faster.",
  "Quality > quantity. Both > neither.",
  "Be the person your past self bet on.",
  "Reply to the one email you've been avoiding.",
  "Your future self is watching. Make them proud.",
  "Make the thing. Then make it better.",
  "Compound today's work into tomorrow's edge.",
  "Plant a flag. Defend it.",
  "Choose the harder right.",
  "One percent better than yesterday.",
  "Discipline beats motivation. Bring both.",
  "Focus is a superpower. Use it.",
  "Cut the noise. Ship the signal.",
  "Lead with the most important thing.",
  "Don't wait for momentum — start, and it'll come.",
  "Be brutal with your time. Generous with your effort.",
  "First task: name your top priority. Then attack it.",
  "Make a dent today.",
  "Move the needle. Even a little.",
  "Be relentless with the small stuff.",
  "Steady hands. Sharp focus.",
  "Today's plan: be useful.",
  "Beat the blank page.",
  "Reply quickly. Think slowly.",
  "Build the muscle. Show up.",
  "Less fire-fighting. More fire-prevention.",
  "Don't perfect — proceed.",
  "Start before you feel ready.",
  "Stay curious. Stay shipping.",
  "Your standards are the ceiling. Raise them.",
  "Action eats anxiety for breakfast.",
  "Pick the dragon you're slaying today.",
  "Half-finished is a debt. Pay it down.",
  "Win the morning. The afternoon follows.",
  "Be where your feet are.",
  "Today's work is tomorrow's portfolio.",
  "Make the next 90 minutes matter."
];

// Stable per-day pick — so refreshing the page or re-opening the modal
// in the same shift shows the same line (less disorienting than a new
// pick every render).
export function pickMotivationalLine(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % MOTIVATIONAL_LINES.length;
  return MOTIVATIONAL_LINES[idx];
}
