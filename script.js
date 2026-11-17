// BountyScout page script. Exports App.page: the single page object that both
// the page's own form and the agent's site-actions call, so both follow one set
// of rules. All data comes from the curated programs.json (see data.js) plus
// live checks the visitor's browser runs. Nothing here submits a report,
// creates an account or pays anything.
import {
  checkProgramLive as liveCheck,
  comparePrograms as compare,
  feeUsd,
  gateSummary,
  getProgram,
  loadPrograms,
  matchPrograms,
  programSummary,
  validateProfile,
} from "./data.js";

const state = {
  profile: { rep: 0, signal: 0, maxFeeUsd: 0, language: "Solidity", platform: "any", payoutVerifiedOnly: false },
  matches: [],
  excluded: null,
  selectedId: null,
  selectedProgram: null,
  lastLiveCheck: null,
  dataAsOf: null,
  dataLoaded: false,
  dataError: null,
};

let cachedData = null;

async function dataset() {
  if (cachedData) return { ok: true, data: cachedData };
  const loaded = await loadPrograms();
  if (!loaded.ok) {
    state.dataError = loaded.reason;
    return loaded;
  }
  cachedData = loaded.data;
  state.dataAsOf = loaded.data.data_as_of || null;
  state.dataLoaded = true;
  return { ok: true, data: cachedData };
}

function el(id) {
  try {
    if (typeof document === "undefined") return null;
    return document.querySelector(`#${id}`);
  } catch {
    return null;
  }
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function rewardLine(rewards) {
  const parts = [];
  if (rewards?.critical) parts.push(`Critical ${rewards.critical}`);
  if (rewards?.high) parts.push(`High ${rewards.high}`);
  if (rewards?.medium) parts.push(`Medium ${rewards.medium}`);
  if (rewards?.low) parts.push(`Low ${rewards.low}`);
  return parts.length > 0 ? parts.join(" · ") : "Rewards not listed";
}

function payoutLine(program) {
  const proof = program?.payout_proof || {};
  if (proof.status === "verified") {
    return `Verified: ${proof.amount || "payout confirmed"}${proof.source ? ` (${proof.source})` : ""}`;
  }
  if (proof.status === "not_found") return "No payout proof found";
  return "Payout proof unknown";
}

/** Render the matching-programs list from state. Never throws. */
function renderResults() {
  try {
    const list = el("results-list");
    const empty = el("results-empty");
    const note = el("results-note");
    if (!list) return;
    list.textContent = "";
    if (state.matches.length === 0) {
      if (empty) empty.textContent = "No matching programs for this profile. Loosen the profile (a higher fee cap, another platform) or ask the assistant why each program was excluded.";
      if (note) note.textContent = state.excluded
        ? `Excluded by this profile — fee: ${state.excluded.fee}, reputation: ${state.excluded.rep}, Signal: ${state.excluded.signal}, language: ${state.excluded.language}, platform: ${state.excluded.platform}, payout proof: ${state.excluded.payout}, paused/finished: ${state.excluded.status}.`
        : "";
      return;
    }
    if (empty) empty.textContent = "";
    for (const program of state.matches) {
      const item = document.createElement("li");
      const fee = feeUsd(program);
      const feeText = fee === null ? "unknown" : fee === 0 ? "$0" : program?.fee?.basis === "deposit" ? `$${fee} deposit` : `$${fee}`;
      item.textContent = `${program.name} — ${program.platform}, fee ${feeText}, ${gateSummary(program)}, ${rewardLine(program.rewards)}, payout: ${payoutLine(program)}, status: ${program.status || "unknown"}. `;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Details";
      button.setAttribute("data-program-id", program.id);
      button.addEventListener("click", () => { App.page.getProgramDetails(program.id); });
      item.appendChild(button);
      list.appendChild(item);
    }
    if (note) note.textContent = `Showing ${state.matches.length} program${state.matches.length === 1 ? "" : "s"} that fit this profile. Paused and finished programs are never listed here. Data as of ${state.dataAsOf || "unknown date"}.`;
  } catch {
    // Rendering must never break the search itself.
  }
}

/** Render the selected program's detail card from state. Never throws. */
function renderDetail() {
  try {
    const card = el("program-card");
    if (!card) return;
    const program = state.selectedProgram;
    if (!program) {
      card.hidden = true;
      return;
    }
    const fee = feeUsd(program);
    setText("detail-name", `${program.name} (${program.id})`);
    setText("detail-route", `${program.platform} — ${program.submit_route || "not recorded in the dataset"}`);
    setText("detail-fee", fee === null ? `Unknown${program?.fee?.notes ? ` — ${program.fee.notes}` : ""}` : fee === 0 ? "$0 (no fee)" : program?.fee?.basis === "deposit" ? `$${fee} deposit${program?.fee?.notes ? ` — ${program.fee.notes}` : ""}` : `$${fee}${program?.fee?.notes ? ` — ${program.fee.notes}` : ""}`);
    setText("detail-gates", gateSummary(program));
    setText("detail-rewards", rewardLine(program.rewards));
    setText("detail-payout", payoutLine(program));
    setText("detail-status", `${program.status || "unknown"}${program.status_note ? ` — ${program.status_note}` : ""}`);
    setText("detail-scope", program.scope_language || "unknown");
    setText("detail-live", state.lastLiveCheck && state.lastLiveCheck.id === program.id
      ? state.lastLiveCheck.evidence
      : "Not checked yet — use the button below or ask the assistant.");
    card.hidden = false;
  } catch {
    // Rendering must never break the detail lookup itself.
  }
}

export const App = {
  page: {
    /** Plain-JSON copy of the page state for the agent's read tool. */
    getState() {
      return {
        profile: { ...state.profile },
        matches: state.matches.map((program) => programSummary(program)),
        excluded: state.excluded ? { ...state.excluded } : null,
        selectedId: state.selectedId,
        selectedProgram: state.selectedProgram ? programSummary(state.selectedProgram) : null,
        lastLiveCheck: state.lastLiveCheck ? { ...state.lastLiveCheck } : null,
        dataAsOf: state.dataAsOf,
        dataLoaded: state.dataLoaded,
        dataError: state.dataError,
        disclaimer: "Data as of 18 November 2026. Fees, gates and program status change — always re-check the program's official page before submitting. A match is not a guarantee of reward.",
      };
    },

    /** Validate and remember a hunter profile without searching. Refuses bad input. */
    setProfile(input) {
      const valid = validateProfile(input);
      if (!valid.ok) return valid;
      state.profile = valid.profile;
      return { ok: true, profile: { ...state.profile } };
    },

    /** Find programs matching the profile (page form values by default). */
    async findPrograms(input) {
      const valid = validateProfile(input ?? state.profile);
      if (!valid.ok) return valid;
      state.profile = valid.profile;
      const loaded = await dataset();
      if (!loaded.ok) return loaded;
      const result = matchPrograms(loaded.data.programs, state.profile);
      if (!result.ok) return result;
      state.matches = result.matches;
      state.excluded = result.excluded;
      renderResults();
      return { ok: true, profile: { ...state.profile }, matches: state.matches.map((program) => programSummary(program)), excluded: { ...state.excluded } };
    },

    /** Full record of one program; stores it and renders the detail card. */
    async getProgramDetails(id) {
      const loaded = await dataset();
      if (!loaded.ok) return loaded;
      const found = getProgram(loaded.data.programs, id);
      if (!found.ok) return found;
      state.selectedId = found.program.id;
      state.selectedProgram = found.program;
      state.lastLiveCheck = null;
      renderDetail();
      return { ok: true, program: found.program };
    },

    /** Compare 2-4 programs side by side. */
    async comparePrograms(ids) {
      const loaded = await dataset();
      if (!loaded.ok) return loaded;
      return compare(loaded.data.programs, ids);
    },

    /** Live-check a program's official page; stores and renders the result. */
    async checkProgramLive(id) {
      const loaded = await dataset();
      if (!loaded.ok) return loaded;
      const result = await liveCheck(loaded.data.programs, id);
      if (result.ok) {
        state.lastLiveCheck = result;
        if (state.selectedId === id) renderDetail();
      }
      return result;
    },

    /** Test hook: clear the cached dataset so tests can stub a fresh load. */
    _resetForTests() {
      cachedData = null;
      state.matches = [];
      state.excluded = null;
      state.selectedId = null;
      state.selectedProgram = null;
      state.lastLiveCheck = null;
      state.dataAsOf = null;
      state.dataLoaded = false;
      state.dataError = null;
    },
  },
};

// Wire the page's own form to the same methods the assistant calls.
try {
  const form = el("profile-form");
  if (form && typeof form.addEventListener === "function") {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = el("find-status");
      const readNumber = (id) => {
        const node = el(id);
        return node ? Number(node.value) : 0;
      };
      const readValue = (id) => {
        const node = el(id);
        return node ? node.value : "";
      };
      const payoutNode = el("profile-payout");
      const profile = {
        rep: readNumber("profile-rep"),
        signal: readNumber("profile-signal"),
        maxFeeUsd: Number(readValue("profile-fee")),
        language: readValue("profile-language"),
        platform: readValue("profile-platform"),
        payoutVerifiedOnly: payoutNode ? payoutNode.checked : false,
      };
      if (status) status.textContent = "Searching the curated dataset…";
      const result = await App.page.findPrograms(profile);
      if (status) {
        status.textContent = result.ok
          ? `Found ${result.matches.length} matching program${result.matches.length === 1 ? "" : "s"}.`
          : result.reason;
      }
    });
    for (const button of (typeof document !== "undefined" && document.querySelectorAll
      ? document.querySelectorAll("[data-sample-profile]") : [])) {
      button.addEventListener("click", () => {
        const preset = button.getAttribute("data-sample-profile");
        const set = (id, value) => { const node = el(id); if (node) node.value = value; };
        const payoutNode = el("profile-payout");
        if (preset === "zero") {
          set("profile-rep", "0"); set("profile-signal", "0"); set("profile-fee", "0");
          set("profile-language", "Solidity"); set("profile-platform", "any");
          if (payoutNode) payoutNode.checked = false;
        } else if (preset === "paid") {
          set("profile-rep", "0"); set("profile-signal", "0"); set("profile-fee", "100");
          set("profile-language", "Solidity"); set("profile-platform", "any");
          if (payoutNode) payoutNode.checked = false;
        } else if (preset === "vyper") {
          set("profile-rep", "0"); set("profile-signal", "0"); set("profile-fee", "0");
          set("profile-language", "Vyper"); set("profile-platform", "any");
          if (payoutNode) payoutNode.checked = false;
        }
      });
    }
    const liveButton = el("live-check-button");
    if (liveButton && typeof liveButton.addEventListener === "function") {
      liveButton.addEventListener("click", async () => {
        const status = el("live-check-status");
        if (!state.selectedId) {
          if (status) status.textContent = "Pick a program first.";
          return;
        }
        if (status) status.textContent = "Checking the official page… (read-only, no submission is sent)";
        const result = await App.page.checkProgramLive(state.selectedId);
        if (status) {
          status.textContent = result.ok ? result.evidence : result.reason;
        }
      });
    }
  }
} catch {
  // The page must keep working even if the form wiring fails.
}
