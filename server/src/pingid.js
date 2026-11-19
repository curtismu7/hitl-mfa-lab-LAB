// PingID setup wizard state + the live-check contract. Mock mode keeps the wizard state per
// workspace and never leaves the process. The live check (`GET /api/pingid/check`) never runs
// a network call itself: it reports the configuration PRESENCE (never the values) and hands
// back the owner-run script command — `scripts/pingid-check.mjs` — which runs outside the
// netguard by design (the server's zero-outbound rule stays intact).
export const WIZARD_STEPS = [
  {
    id: 'policy-assigned',
    title: 'Assign the MFA sign-on policy',
    why: 'Out of the box the Multi_Factor sign-on policy exists but is assigned to nothing, so the enrolment prompt never appears (measured 2026-11-18).',
    where: 'PingOne admin console → your app → Sign-on Policy → assign the policy that carries the PingID (MFA) authentication action.',
  },
  {
    id: 'signin-enrol',
    title: 'Sign in as the user — enrolment happens at sign-in',
    why: 'The hosted login accepts the password, then shows "Welcome to PingID — Start" with a QR code and a manual pairing key (three groups of four digits). Worker-app API pairing is refused (WORKER apps get only the openid resource), so the sign-in path is the only enrolment route.',
    where: 'The environment\'s Self Service URL (Settings → Environment Properties → URLs), or the app\'s own login page.',
  },
  {
    id: 'scan-qr',
    title: 'Scan the QR (or type the pairing key) with PingID on the phone',
    why: 'The device pairs to the user; the first login doubles as the first push-approval test.',
    where: 'PingID mobile app → + → scan, or type the pairing key shown on the screen.',
  },
  {
    id: 'device-active',
    title: 'Verify the device shows ACTIVE',
    why: 'One device record per user; the same physical phone can hold multiple persona entries. Needs only p1:read:device on a worker token.',
    where: 'Live check: run scripts/pingid-check.mjs (owner-run), or the admin console → Directory → user → Devices.',
  },
  {
    id: 'stepup-live',
    title: 'Next sign-in steps up for real',
    why: 'Password accepted → PingID authenticator page → push on the phone → approve → the authorization code is issued. A callback 404 on a test app after approval is harmless — the enrolment and the sign-in both completed by then.',
    where: 'Sign in again and approve the push on the phone.',
  },
];

export const emptyWizard = () => ({ done: [] });

export function isWizardComplete(w) {
  return WIZARD_STEPS.every((s) => w.done.includes(s.id));
}
