// BountyScout tests: dataset integrity, profile matching, fee parsing,
// program details/compare, and the live check's graceful UNKNOWN path.
// Pure data-layer tests (no DOM, no network): the dataset is read from disk
// and fetch is stubbed where a live check needs one.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  setFetchImpl,
  validateProfile,
  matchPrograms,
  feeUsd,
  gateSummary,
  programSummary,
  getProgram,
  comparePrograms,
  checkProgramLive,
} from "../data.js";

const dir = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(dir, "..", "programs.json"), "utf8"));
const programs = data.programs;
const ids = (list) => list.map((program) => program.id);
const byId = (id) => programs.find((program) => program.id === id);

afterEach(() => setFetchImpl(null));

describe("dataset", () => {
  it("loads 53 programs dated 2026-11-18", () => {
    assert.equal(data.data_as_of, "2026-11-18");
    assert.equal(programs.length, 53);
  });

  it("gives every program all required fields and a unique id", () => {
    const required = ["id", "name", "platform", "submit_route", "fee", "gates", "rewards", "payout_proof", "scope_language", "status", "program_url"];
    const seen = new Set();
    for (const program of programs) {
      for (const key of required) assert.ok(key in program, `${program.id} misses ${key}`);
      assert.ok(!seen.has(program.id), `duplicate id ${program.id}`);
      seen.add(program.id);
      assert.ok("amount_usd_or_credits" in program.fee, `${program.id} fee misses amount_usd_or_credits`);
      assert.ok(["critical", "high", "medium", "low"].every((tier) => tier in program.rewards), `${program.id} rewards incomplete`);
      assert.ok(["status", "amount", "source", "date"].every((key) => key in program.payout_proof), `${program.id} payout_proof incomplete`);
    }
  });

  it("marks unverified fees as null, never as a guessed number", () => {
    const unknownFee = programs.filter((program) => feeUsd(program) === null);
    assert.ok(unknownFee.length >= 20, `expected many unknown fees, got ${unknownFee.length}`);
    assert.ok(unknownFee.some((program) => program.id === "aave"));
    assert.ok(unknownFee.some((program) => program.id === "magpiexyz"));
  });
});

describe("feeUsd", () => {
  it("parses numbers, credit strings and null", () => {
    assert.equal(feeUsd(byId("across")), 0);
    assert.equal(feeUsd(byId("alchemix")), 100); // "100 credits" string in the dataset
    assert.equal(feeUsd(byId("origin")), 25); // "25 credits"
    assert.equal(feeUsd(byId("zksync-era")), 50); // "50 credits"
    assert.equal(feeUsd(byId("erc-4337")), 7);
    assert.equal(feeUsd(byId("kinetiq")), 20); // $20 deposit
    assert.equal(feeUsd(byId("aave")), null); // unverified
  });
});

describe("profile matching (rep 0, no fee, Solidity)", () => {
  const profile = { rep: 0, signal: 0, maxFeeUsd: 0, language: "Solidity" };
  const result = matchPrograms(programs, profile);

  it("returns 19 matches and counts every exclusion", () => {
    assert.equal(result.ok, true);
    assert.equal(result.matches.length, 19);
    assert.equal(result.matches.length + Object.values(result.excluded).reduce((a, b) => a + b, 0), 53);
    assert.deepEqual(result.excluded, { fee: 32, rep: 1, signal: 0, language: 1, platform: 0, payout: 0, status: 0 });
  });

  it("includes the no-fee email/Immunefi/Mantis class: Across, Relay, Tori", () => {
    const found = ids(result.matches);
    for (const id of ["across", "relay", "tori", "gearbox", "maple", "morpheus", "rigoblock", "stakedao", "midas", "uma"]) {
      assert.ok(found.includes(id), `expected match ${id}`);
    }
  });

  it("excludes fee and gated programs", () => {
    const found = ids(result.matches);
    for (const id of ["alchemix", "origin", "zksync-era", "erc-4337", "dexe", "kinetiq", "noirwallet", "nado", "curve", "beanstalk", "aave", "magpiexyz", "whitechain"]) {
      assert.ok(!found.includes(id), `expected exclusion ${id}`);
    }
  });

  it("sorts payout-verified programs first at the same fee", () => {
    const firstThree = ids(result.matches.slice(0, 3));
    assert.deepEqual(firstThree, ["cronos-zkevm", "gearbox", "morpheus"]);
    assert.ok(result.matches.slice(0, 3).every((program) => program.payout_proof.status === "verified"));
  });

  it("never recommends a paused or finished program", () => {
    assert.ok(result.matches.every((program) => program.status !== "paused" && program.status !== "finished"));
  });
});

describe("invalid profile", () => {
  it("rejects negative reputation, negative fee, and unknown language/platform", () => {
    assert.equal(validateProfile({ rep: -1 }).ok, false);
    assert.equal(validateProfile({ maxFeeUsd: -5 }).ok, false);
    assert.equal(validateProfile({ language: "Rust" }).ok, false);
    assert.equal(validateProfile({ platform: "GitHub" }).ok, false);
  });

  it("returns the validation failure from matchPrograms instead of matching", () => {
    const result = matchPrograms(programs, { rep: -1 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Reputation/);
  });

  it("accepts an empty profile as rep 0, no fee, Solidity", () => {
    const result = validateProfile({});
    assert.equal(result.ok, true);
    assert.deepEqual(result.profile, { rep: 0, signal: 0, maxFeeUsd: 0, language: "Solidity", platform: "any", payoutVerifiedOnly: false });
  });
});

describe("program details and compare", () => {
  it("reads one program with its fee note and gates", () => {
    const found = getProgram(programs, "alchemix");
    assert.equal(found.ok, true);
    const summary = programSummary(found.program);
    assert.equal(summary.fee_usd, 100);
    assert.match(summary.fee_note, /100 credits/);
    assert.equal(summary.platform, "Immunefi");
    assert.equal(summary.status, "live");
  });

  it("reports an unknown id instead of inventing a program", () => {
    const found = getProgram(programs, "no-such-program");
    assert.equal(found.ok, false);
    assert.match(found.reason, /No program/);
  });

  it("says the rep gate and the deposit in plain words", () => {
    assert.match(gateSummary(byId("whitechain")), /rep 50\+/);
    assert.match(gateSummary(byId("kinetiq")), /deposit \$20/);
    assert.match(gateSummary(byId("midas")), /24h rule/);
    assert.equal(gateSummary(byId("across")), "KYC: none");
  });

  it("reports rewards and payout proof exactly as recorded", () => {
    assert.match(programSummary(byId("alchemix")).rewards.medium, /\$3,000/);
    assert.match(programSummary(byId("gearbox")).payout_amount, /\$432,400/);
    assert.equal(programSummary(byId("gearbox")).payout_proof, "verified");
    assert.equal(programSummary(byId("relay")).payout_proof, "not_found");
  });

  it("compares 2 programs side by side", () => {
    const result = comparePrograms(programs, ["alchemix", "relay"]);
    assert.equal(result.ok, true);
    assert.equal(result.comparison.length, 2);
    assert.equal(result.comparison[0].fee_usd, 100);
    assert.equal(result.comparison[1].fee_usd, 0);
  });

  it("refuses to compare 1 program or an unknown id", () => {
    assert.equal(comparePrograms(programs, ["across"]).ok, false);
    assert.equal(comparePrograms(programs, ["across", "no-such-program"]).ok, false);
    assert.equal(comparePrograms(programs, ["a", "b", "c", "d", "e"]).ok, false);
  });
});

describe("live check", () => {
  it("reports a 200 page as live", async () => {
    setFetchImpl(async () => ({ status: 200 }));
    const result = await checkProgramLive(programs, "across");
    assert.equal(result.ok, true);
    assert.equal(result.live, true);
    assert.equal(result.reachable, true);
    assert.equal(result.status, 200);
  });

  it("reports a 404 page as not live but reachable", async () => {
    setFetchImpl(async () => ({ status: 404 }));
    const result = await checkProgramLive(programs, "across");
    assert.equal(result.ok, true);
    assert.equal(result.live, false);
    assert.equal(result.reachable, true);
    assert.equal(result.status, 404);
  });

  it("degrades to unknown, unreachable, when both fetches fail", async () => {
    setFetchImpl(async () => { throw new Error("network down"); });
    const result = await checkProgramLive(programs, "across");
    assert.equal(result.ok, true);
    assert.equal(result.live, false);
    assert.equal(result.reachable, false);
    assert.equal(result.status, null);
    assert.match(result.evidence, /unknown/i);
  });

  it("degrades to unknown, reachable, when CORS blocks reading the status", async () => {
    setFetchImpl(async (url, options) => {
      if (options?.mode === "no-cors") return { type: "opaque" };
      throw new Error("CORS blocked");
    });
    const result = await checkProgramLive(programs, "across");
    assert.equal(result.ok, true);
    assert.equal(result.live, "unknown");
    assert.equal(result.reachable, true);
  });

  it("cannot check a program with no official page URL in the dataset", async () => {
    const result = await checkProgramLive(programs, "hyperliquid");
    assert.equal(result.ok, false);
    assert.match(result.reason, /No official page URL/);
  });

  it("cannot check an unknown program id", async () => {
    const result = await checkProgramLive(programs, "no-such-program");
    assert.equal(result.ok, false);
    assert.match(result.reason, /No program/);
  });
});

describe("network instructions", () => {
  const network = JSON.parse(readFileSync(join(dir, "..", "bountyscout.network.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(dir, "..", "agent-manifest.json"), "utf8"));
  const replacements = network.commondefs.replacement_strings;
  const expand = (text) => {
    let out = text;
    for (const [key, value] of Object.entries(replacements)) out = out.split(`{${key}}`).join(value);
    return out;
  };
  const front = network.tools.find((agent) => agent.name === "bounty_scout_coordinator");
  const expandedFront = expand(front.instructions);
  const specialists = ["program_matcher", "gate_checker", "payout_verifier", "live_status_checker"];

  it("names the coordinator as front agent and keeps the peer policy closed", () => {
    assert.equal(manifest.networks[0].front_man, "bounty_scout_coordinator");
    assert.equal(manifest.peer_policy.mode, "closed");
    assert.ok(manifest.allowed_peers.includes("https://dio955.github.io"));
    assert.deepEqual(front.tools, [...specialists, "https://dio955.github.io/contractscope/contractscope"]);
    assert.equal(network.link_labels["https://dio955.github.io/contractscope/contractscope"], "ContractScope");
  });

  it("keeps the expanded front instructions within the 5,000-char budget", () => {
    assert.ok(expandedFront.length <= 5000, `front is ${expandedFront.length} chars after expansion`);
    assert.ok(!/\{[a-z_]+\}/.test(expandedFront), "expanded front still has a {placeholder}");
  });

  it("refuses a submit/create-account/pay request before doing anything else", () => {
    assert.ok(expandedFront.includes("This site cannot submit a report, create an account, or pay a fee or deposit."));
    assert.ok(expandedFront.includes("If asked to submit a report, create an account or pay, refuse the action, then give the submit route and official page from the program details."));
  });

  it("live-checks and verifies payout proof before recommending", () => {
    assert.ok(expandedFront.includes("Before recommending, live-check the top matches and get payout proof for each program you name."));
    assert.ok(expandedFront.includes("A live status comes only from a website_check_program_live result, never from the dataset alone"));
    assert.ok(expandedFront.includes("Never recommend a program whose fee or gate blocks the hunter"));
    assert.ok(expandedFront.includes("A match is not a guarantee of reward"));
  });

  it("calls the ContractScope peer only for contract-safety questions", () => {
    assert.ok(expandedFront.includes("For a contract-safety question only, ask contractscope_contractscope in one sentence under 140 characters with the address and chain"));
    assert.ok(expandedFront.includes("https://dio955.github.io/contractscope/"));
    assert.ok(expandedFront.includes("Call each partner at most once per visitor message."));
  });

  it("gives every specialist the Answer/Evidence/Implication shape and the UNKNOWN rule", () => {
    for (const name of specialists) {
      const spec = network.tools.find((agent) => agent.name === name);
      const expanded = expand(spec.instructions);
      assert.ok(expanded.includes("Answer:"), `${name} lacks the answer line.`);
      assert.ok(expanded.includes("Evidence:"), `${name} lacks the evidence line.`);
      assert.ok(expanded.includes("Implication:"), `${name} lacks the implication line.`);
      assert.ok(expanded.includes("Never upgrade UNKNOWN to a recommendation"), `${name} lacks the UNKNOWN rule.`);
    }
  });
});
