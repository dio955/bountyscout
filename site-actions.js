// Registers BountyScout's read-only operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names
// in "actions.agentTools" become model tools, called website_<name>.
// Every action is a read: nothing here changes page state, submits a report,
// creates an account, or pays anything. Bad input is refused with
// {ok: false, reason} and live-check failures are returned as results, so the
// agent can explain them.
import { App } from "./script.js";

export function registerActions(actions) {
  actions.register({
    name: "list_programs",
    description: "Find bug-bounty programs matching a hunter profile from the curated dataset (data as of 18 November 2026). Filters by platform, maximum submission fee in USD, reputation, Signal, scope language, payout-proof status and live status. Programs whose fee or gate the hunter cannot meet are never returned. Paused and finished programs are never returned.",
    effect: "read",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        rep: { type: "number", minimum: 0, description: "The hunter's HackenProof reputation (0 if none)." },
        signal: { type: "number", minimum: 0, description: "The hunter's HackerOne Signal (0 if none)." },
        maxFeeUsd: { type: "number", minimum: 0, description: "The most the hunter will pay to submit, in USD. 0 means no fee only." },
        language: { type: "string", enum: ["Solidity", "Vyper", "any"], description: "Scope language the hunter can audit." },
        platform: { type: "string", enum: ["any", "email", "Immunefi", "HackenProof", "Mantis", "Cantina", "other"], description: "Where the hunter wants to submit." },
        payoutVerifiedOnly: { type: "boolean", description: "True to return only programs with verified payout proof." },
      },
    },
    execute: (args) => App.page.findPrograms(args),
  });
  actions.register({
    name: "get_program_details",
    description: "Read the full curated record of one program: platform, submit route, fee, gates, reward tiers, payout proof, status, scope language and the hunter's own audit outcome where one exists. Unknown values are reported as unknown, never guessed.",
    effect: "read",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string", description: "The program id, for example \"across\" or \"relay\"." },
      },
    },
    execute: ({ id }) => App.page.getProgramDetails(id),
  });
  actions.register({
    name: "check_program_live",
    description: "Live-check a program's official page from this browser: fetches the page and reports whether it answers (live), answers with an error, cannot be read because of CORS (unknown, but reachable), or cannot be reached at all. Never claims a program is live from the static dataset alone.",
    effect: "read",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string", description: "The program id, for example \"maple\" or \"tori\"." },
      },
    },
    execute: ({ id }) => App.page.checkProgramLive(id),
  });
  actions.register({
    name: "compare_programs",
    description: "Compare 2 to 4 programs side by side: platform, submit route, fee, gates, reward tiers, payout proof, status and scope language, all from the curated dataset.",
    effect: "read",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["ids"],
      properties: {
        ids: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" }, description: "Program ids to compare, for example [\"across\", \"relay\"]." },
      },
    },
    execute: ({ ids }) => App.page.comparePrograms(ids),
  });
}
