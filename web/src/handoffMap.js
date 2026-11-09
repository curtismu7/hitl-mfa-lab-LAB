// Customer Agent LAB hands a use case here with ?from=customer-agent&uc=<id>&vertical=<id> (read by the vendored return-link module).
// Preselect only where the catalog id obviously maps to this lab's own scenario or vertical; anything else opens the defaults (strip only).
// UC7 (MFA step-up) -> the $600 step-up, UC8 (MFA + HITL consent) -> the $300 human-consent band, UC22 (CIBA) -> the CIBA approval.
// UC27 (HITL consent bypass attempt) also routes here but no single scenario is that story (replay and amount-bound both are), so strip only.
export const UC_SCENARIO = Object.freeze({ UC7: "mfa-step-up", UC8: "consent-hitl", UC22: "ciba-150" });
export const VERTICAL_MAP = Object.freeze({ banking: "finance", healthcare: "health", retail: "retail" });
export const scenarioFor = (ctx) => (ctx && Object.hasOwn(UC_SCENARIO, ctx.uc) ? UC_SCENARIO[ctx.uc] : null);
export const verticalFor = (ctx) => (ctx && ctx.vertical && Object.hasOwn(VERTICAL_MAP, ctx.vertical) ? VERTICAL_MAP[ctx.vertical] : null);
