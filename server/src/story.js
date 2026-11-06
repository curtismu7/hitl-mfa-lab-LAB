import { fillDeep } from './cast.js';
import { BANNER, FACTS, HOSTED_BANNER, INTRO, RULE, SCENARIOS, TALK_TRACK, TITLE, TOOLS } from './policyData.js';

export const rawStory = () => ({ title: TITLE, intro: INTRO, banner: BANNER, hostedBanner: HOSTED_BANNER, rule: RULE, scenarios: SCENARIOS, facts: FACTS, tools: TOOLS, talkTrack: TALK_TRACK });

// The story with the cast filled in.
export function buildStory(cast, { hosted = false } = {}) {
  const s = fillDeep(rawStory(), cast);
  return {
    title: s.title,
    intro: s.intro,
    banner: hosted ? s.hostedBanner : s.banner,
    tokenLabel: 'MOCK policy decisions, MOCK MFA challenges and MOCK CIBA approvals: for education, never a real credential',
    rule: s.rule,
    scenarios: s.scenarios,
    tools: s.tools,
    facts: s.facts,
    talkTrack: s.talkTrack,
    cast,
  };
}

// docs/talk-track.md is generated from the same data the UI reads (`npm run talk-track`); a test fails if they drift.
export function renderTalkTrackMarkdown(cast) {
  const s = buildStory(cast);
  const parts = ['# Talk track', '', '<!-- Generated from server/src/policyData.js by `npm run talk-track`. Do not edit by hand. -->', ''];
  for (const t of s.talkTrack) parts.push(`## ${t.title}`, '', t.say, '');
  parts.push('## The scenarios', '');
  s.scenarios.forEach((sc, i) => parts.push(`${i + 1}. **${sc.title}.** ${sc.lesson}`));
  return `${parts.join('\n')}\n`;
}
