// BountyScout data layer: loads the curated programs.json, matches a hunter
// profile against it, and live-checks a program's official page. Read-only.
// Never invents a fee, reward, gate or payout figure: anything the dataset
// does not know stays "unknown" in the result, and the live check reports
// "unknown" instead of guessing when the page cannot be read.
let fetchImpl = null;

/** Tests replace fetch with a stub; production uses the browser's fetch. */
export function setFetchImpl(impl) {
  fetchImpl = impl;
}

function doFetch(url, options) {
  const impl = fetchImpl || fetch;
  return impl(url, options);
}

export const DATA_URL = "./programs.json";

/** Load the curated dataset. Returns {ok, data} or {ok:false, reason}. */
export async function loadPrograms() {
  try {
    const response = await doFetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) {
      return { ok: false, reason: `Program data unavailable: could not load programs.json (HTTP ${response.status}).` };
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.programs)) {
      return { ok: false, reason: "Program data unavailable: programs.json is not in the expected shape." };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, reason: `Program data unavailable: could not load programs.json (${error.message || "network error"}).` };
  }
}

/** Validate a hunter profile. Returns {ok, profile} or {ok:false, reason}. */
export function validateProfile(input) {
  const rep = Number(input?.rep ?? 0);
  const signal = Number(input?.signal ?? 0);
  const maxFeeUsd = Number(input?.maxFeeUsd ?? 0);
  const language = input?.language ?? "Solidity";
  const platform = input?.platform ?? "any";
  const payoutVerifiedOnly = input?.payoutVerifiedOnly === true;
  if (!Number.isFinite(rep) || rep < 0) return { ok: false, reason: "Reputation must be 0 or more." };
  if (!Number.isFinite(signal) || signal < 0) return { ok: false, reason: "Signal must be 0 or more." };
  if (!Number.isFinite(maxFeeUsd) || maxFeeUsd < 0) return { ok: false, reason: "Maximum fee must be $0 or more." };
  if (!["Solidity", "Vyper", "any"].includes(language)) return { ok: false, reason: "Language must be Solidity, Vyper or any." };
  if (!["any", "email", "Immunefi", "HackenProof", "Mantis", "Cantina", "other"].includes(platform)) {
    return { ok: false, reason: "Platform must be any, email, Immunefi, HackenProof, Mantis, Cantina or other." };
  }
  return { ok: true, profile: { rep, signal, maxFeeUsd, language, platform, payoutVerifiedOnly } };
}

/** Fee in USD for matching. Credits count as $1 each (Immunefi: 1 credit = $1).
 * The dataset stores the amount as a number (USD), a string like "100 credits",
 * or null when unverified. Unknown fee -> null. */
export function feeUsd(program) {
  const fee = program?.fee;
  if (!fee) return null;
  const amount = fee.amount_usd_or_credits ?? fee.amount_usd ?? fee.amount_credits;
  if (typeof amount === "number") return amount;
  if (typeof amount === "string") {
    const match = /(\d+(?:\.\d+)?)/.exec(amount);
    if (match) return Number(match[1]);
  }
  return null;
}

/** One-line gate summary for display. Unknown gates are shown as unknown, never guessed. */
export function gateSummary(program) {
  const gates = program?.gates || {};
  const parts = [];
  if (typeof gates.rep_required === "number") parts.push(`rep ${gates.rep_required}+`);
  if (typeof gates.signal_required === "number") parts.push(`Signal ${gates.signal_required}+`);
  if (gates.kyc && gates.kyc !== "unknown") parts.push(`KYC: ${gates.kyc}`);
  if (typeof gates.deposit_usd === "number" && gates.deposit_usd > 0) parts.push(`deposit $${gates.deposit_usd}`);
  if (gates.rule_24h === true) parts.push("24h rule");
  return parts.length > 0 ? parts.join(" · ") : "No gate recorded";
}

function languageMatches(program, language) {
  if (language === "any") return true;
  const scope = program?.scope_language;
  if (!scope || scope === "unknown") return false;
  return scope === language || scope === "mixed";
}

/**
 * Match programs against a hunter profile. Hard rule: a program is only
 * recommended when its fee and gates are known AND the hunter can meet them.
 * Programs with an unknown fee are never recommended under a $0 cap.
 * Paused and finished programs are never recommended (they are still listed
 * in program details). Returns {ok, matches, excluded} where excluded counts
 * why programs were left out.
 */
export function matchPrograms(programs, profile) {
  const valid = validateProfile(profile);
  if (!valid.ok) return valid;
  const p = valid.profile;
  const matches = [];
  const excluded = { fee: 0, rep: 0, signal: 0, language: 0, platform: 0, payout: 0, status: 0 };
  for (const program of programs) {
    const fee = feeUsd(program);
    if (fee === null || fee > p.maxFeeUsd) { excluded.fee += 1; continue; }
    const repRequired = program?.gates?.rep_required;
    if (typeof repRequired === "number" && repRequired > p.rep) { excluded.rep += 1; continue; }
    const signalRequired = program?.gates?.signal_required;
    if (typeof signalRequired === "number" && signalRequired > p.signal) { excluded.signal += 1; continue; }
    if (!languageMatches(program, p.language)) { excluded.language += 1; continue; }
    if (p.platform !== "any" && program?.platform !== p.platform) { excluded.platform += 1; continue; }
    if (p.payoutVerifiedOnly && program?.payout_proof?.status !== "verified") { excluded.payout += 1; continue; }
    if (program?.status === "paused" || program?.status === "finished") { excluded.status += 1; continue; }
    matches.push(program);
  }
  // Cheapest first, payout-verified first, then by name for a stable order.
  matches.sort((a, b) => {
    const feeDiff = (feeUsd(a) ?? 0) - (feeUsd(b) ?? 0);
    if (feeDiff !== 0) return feeDiff;
    const proofDiff = (b?.payout_proof?.status === "verified" ? 1 : 0) - (a?.payout_proof?.status === "verified" ? 1 : 0);
    if (proofDiff !== 0) return proofDiff;
    return String(a.name).localeCompare(String(b.name));
  });
  return { ok: true, matches, excluded, profile: p };
}

/** Short summary of one program for lists and agent answers. */
export function programSummary(program) {
  const fee = feeUsd(program);
  return {
    id: program.id,
    name: program.name,
    platform: program.platform,
    submit_route: program.submit_route || "not recorded in the dataset",
    fee_usd: fee,
    fee_basis: program?.fee?.basis || null,
    fee_note: program?.fee?.notes || null,
    gates: gateSummary(program),
    rewards: program?.rewards || {},
    payout_proof: program?.payout_proof?.status || "unknown",
    payout_amount: program?.payout_proof?.amount || null,
    status: program?.status || "unknown",
    status_note: program?.status_note || null,
    scope_language: program?.scope_language || "unknown",
    program_url: program?.program_url || null,
    hilmi_outcome: program?.hilmi_outcome || null,
  };
}

/** Full record of one program by id. Returns {ok, program} or {ok:false, reason}. */
export function getProgram(programs, id) {
  if (typeof id !== "string" || id.length === 0) return { ok: false, reason: "Give a program id, for example \"across\"." };
  const program = programs.find((entry) => entry.id === id);
  if (!program) return { ok: false, reason: `No program with id "${id}" in the dataset.` };
  return { ok: true, program };
}

/**
 * Compare 2-4 programs side by side. Returns {ok, comparison} or {ok:false, reason}.
 * Comparison rows are plain values from the dataset; unknown stays "unknown".
 */
export function comparePrograms(programs, ids) {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 4) {
    return { ok: false, reason: "Compare 2 to 4 programs: give their ids, for example [\"across\", \"relay\"]." };
  }
  const found = [];
  for (const id of ids) {
    const result = getProgram(programs, id);
    if (!result.ok) return result;
    found.push(result.program);
  }
  const rows = found.map((program) => ({
    id: program.id,
    name: program.name,
    platform: program.platform,
    submit_route: program.submit_route || "not recorded in the dataset",
    fee_usd: feeUsd(program),
    fee_basis: program?.fee?.basis || null,
    fee_note: program?.fee?.notes || null,
    gates: gateSummary(program),
    rewards: program?.rewards || {},
    payout_proof: program?.payout_proof?.status || "unknown",
    payout_amount: program?.payout_proof?.amount || null,
    status: program?.status || "unknown",
    scope_language: program?.scope_language || "unknown",
  }));
  return { ok: true, comparison: rows };
}

const LIVE_TIMEOUT_MS = 8000;

/**
 * Live-check a program's official page. Never claims "live" from the static
 * dataset alone: a live verdict needs a real fetch that answered.
 * - CORS fetch answers 2xx/3xx -> live: true
 * - CORS fetch answers 4xx/5xx -> live: false (page answered with an error)
 * - CORS fetch fails, no-cors fetch answers (opaque) -> live: "unknown",
 *   reachable: true (the page responded but CORS blocks reading its status)
 * - Both fail -> live: false, reachable: false
 * - No program_url in the dataset -> {ok:false, reason}
 */
export async function checkProgramLive(programs, id) {
  const found = getProgram(programs, id);
  if (!found.ok) return found;
  const program = found.program;
  if (!program.program_url) {
    return { ok: false, reason: `No official page URL in the dataset for ${program.name}, so a live check is not possible. Check its submit route instead: ${program.submit_route}.` };
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS) : null;
  try {
    const response = await doFetch(program.program_url, {
      method: "GET",
      mode: "cors",
      redirect: "follow",
      signal: controller ? controller.signal : undefined,
    });
    if (response.status >= 200 && response.status < 400) {
      return { ok: true, id: program.id, name: program.name, live: true, reachable: true, status: response.status, checkedAt: new Date().toISOString(), evidence: `Official page ${program.program_url} answered HTTP ${response.status} just now.` };
    }
    return { ok: true, id: program.id, name: program.name, live: false, reachable: true, status: response.status, checkedAt: new Date().toISOString(), evidence: `Official page ${program.program_url} answered HTTP ${response.status} just now, so the program page is not loading normally.` };
  } catch (error) {
    // CORS or network failure: a no-cors request still tells us whether the
    // host answers at all (opaque response), without reading its status.
    try {
      const opaque = await doFetch(program.program_url, { method: "GET", mode: "no-cors", redirect: "follow" });
      if (opaque && opaque.type === "opaque") {
        return { ok: true, id: program.id, name: program.name, live: "unknown", reachable: true, status: null, checkedAt: new Date().toISOString(), evidence: `Official page ${program.program_url} responded, but its server does not allow this site to read the status (CORS). Live status is unknown — open the link to check.` };
      }
    } catch {
      // Fall through to unreachable.
    }
    return { ok: true, id: program.id, name: program.name, live: false, reachable: false, status: null, checkedAt: new Date().toISOString(), evidence: `Could not reach the official page ${program.program_url} (${error?.name === "AbortError" ? "timed out" : "network error or CORS block"}). Live status is unknown from here — open the link to check.` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
