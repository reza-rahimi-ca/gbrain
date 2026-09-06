// merge-lcov.test.ts — behavioral, fixture-locked tests for
// scripts/merge-lcov.ts (containment-sprint coverage machinery).
//
// Fixtures are inline synthetic lcov strings written into tmp lane dirs;
// the script runs as a subprocess from the repo root (SF normalization and
// the neverLoaded scan resolve against process.cwd()).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isMergedArtifactPath, normalizeSf, parseLcovText } from "../../scripts/merge-lcov.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runMerge(args: string[], env: Record<string, string> = {}): RunResult {
  const res = Bun.spawnSync(["bun", join(REPO_ROOT, "scripts", "merge-lcov.ts"), ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, GENERATED_AT: "2026-08-15T00:00:00.000Z", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "merge-lcov-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function laneDir(name: string, lcovText: string, manifest?: object): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lcov.info"), lcovText, "utf8");
  if (manifest) writeFileSync(join(dir, "lane-manifest.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

function outPaths(name: string): { lcov: string; json: string } {
  return { lcov: join(tmp, `${name}.lcov.info`), json: join(tmp, `${name}.json`) };
}

interface SummaryShape {
  generatedAt: string;
  corpus: string;
  lanes: { expected: string[]; complete: string[] };
  degraded: boolean;
  total: { lines: number; covered: number; pct: number };
  dirs: Record<string, { lines: number; covered: number; pct: number }>;
  files: Record<string, { lines: number; covered: number; pct: number }>;
  functionCoverage: string;
  neverLoaded: { count: number; files: string[] };
  lineHits: Record<string, Record<string, number>>;
}

function readSummary(path: string): SummaryShape {
  return JSON.parse(readFileSync(path, "utf8")) as SummaryShape;
}

const LANE_A = [
  "TN:",
  "SF:src/fixture-cov-a.ts",
  "FN:1,alpha",
  "FNDA:2,alpha",
  "DA:1,1",
  "DA:2,0",
  "DA:3,5",
  "LF:3",
  "LH:2",
  "end_of_record",
  "",
].join("\n");

const LANE_B = [
  "TN:",
  "SF:src/fixture-cov-a.ts",
  "FN:1,alpha",
  "FNDA:3,alpha",
  "DA:1,2",
  "DA:2,0",
  "DA:4,7",
  "end_of_record",
  "",
].join("\n");

describe("merge: DA summing across lanes", () => {
  it("sums per-line hits, unions lines, regenerates counters", () => {
    const a = laneDir("sum-a", LANE_A);
    const b = laneDir("sum-b", LANE_B);
    const out = outPaths("sum");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a, b]);
    expect(res.code).toBe(0);

    const lcov = readFileSync(out.lcov, "utf8");
    expect(lcov).toContain("SF:src/fixture-cov-a.ts");
    expect(lcov).toContain("DA:1,3"); // 1 + 2
    expect(lcov).toContain("DA:2,0"); // 0 + 0
    expect(lcov).toContain("DA:3,5"); // lane A only
    expect(lcov).toContain("DA:4,7"); // lane B only
    expect(lcov).toContain("FNDA:5,alpha"); // 2 + 3 summed per function name
    expect(lcov).toContain("FNF:1");
    expect(lcov).toContain("FNH:1");
    expect(lcov).toContain("LF:4");
    expect(lcov).toContain("LH:3");

    const json = readSummary(out.json);
    expect(json.files["src/fixture-cov-a.ts"]).toEqual({ lines: 4, covered: 3, pct: 75 });
    expect(json.lineHits["src/fixture-cov-a.ts"]).toEqual({ "1": 3, "2": 0, "3": 5, "4": 7 });
    expect(json.degraded).toBe(false);
    expect(json.functionCoverage).toBe("informational");
    expect(json.generatedAt).toBe("2026-08-15T00:00:00.000Z");
  });

  it("honors COVERAGE_CORPUS and defaults to 'unknown'", () => {
    const a = laneDir("corpus-a", LANE_A);
    const out = outPaths("corpus");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a], { COVERAGE_CORPUS: "prCorpus" });
    expect(readSummary(out.json).corpus).toBe("prCorpus");

    const out2 = outPaths("corpus2");
    const res = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts", "merge-lcov.ts"), "--out-lcov", out2.lcov, "--out-json", out2.json, a],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, COVERAGE_CORPUS: "", GENERATED_AT: "2026-08-15T00:00:00.000Z" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(res.exitCode).toBe(0);
    expect(readSummary(out2.json).corpus).toBe("unknown");
  });
});

describe("merge: SF normalization", () => {
  it("merges absolute, repo-relative, and foreign-checkout-prefix SF paths into one record", () => {
    const abs = [
      `SF:${REPO_ROOT}/src/fixture-cov-n.ts`,
      "DA:1,1",
      "end_of_record",
      "",
    ].join("\n");
    const rel = ["SF:src/fixture-cov-n.ts", "DA:1,1", "DA:2,4", "end_of_record", ""].join("\n");
    const foreign = [
      `SF:/ci/runner/work/${basename(REPO_ROOT)}/src/fixture-cov-n.ts`,
      "DA:1,1",
      "end_of_record",
      "",
    ].join("\n");
    const a = laneDir("norm-a", abs);
    const b = laneDir("norm-b", rel);
    const c = laneDir("norm-c", foreign);
    const out = outPaths("norm");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a, b, c]);
    expect(res.code).toBe(0);

    const json = readSummary(out.json);
    expect(Object.keys(json.files)).toEqual(["src/fixture-cov-n.ts"]);
    // 1+1+1 on line 1, 4 on line 2 — all three spellings merged.
    expect(json.lineHits["src/fixture-cov-n.ts"]).toEqual({ "1": 3, "2": 4 });
    const lcov = readFileSync(out.lcov, "utf8");
    expect(lcov.match(/^SF:/gm)?.length).toBe(1);
  });

  it("normalizeSf unit: strips cwd, strips any prefix ending in the repo dir name, keeps relatives", () => {
    expect(normalizeSf(`${REPO_ROOT}/src/a.ts`, REPO_ROOT)).toBe("src/a.ts");
    // Single marker occurrence, no real backing file at the candidate path —
    // resolved via the shallow tier (candidate's first component, "src",
    // exists as a real top-level dir under REPO_ROOT).
    expect(normalizeSf(`/ci/work/${basename(REPO_ROOT)}/src/a.ts`, REPO_ROOT)).toBe("src/a.ts");
    expect(normalizeSf("src/a.ts", REPO_ROOT)).toBe("src/a.ts");
    expect(normalizeSf("./src/a.ts", REPO_ROOT)).toBe("src/a.ts");
    // Conservative case: no occurrence of `/<repo dir name>/` anywhere in the
    // path at all — genuinely untied to the repo boundary, kept as-is (never
    // matches src/, stays out of the JSON metrics).
    expect(normalizeSf("/unrelated/machine/path/a.ts", REPO_ROOT)).toBe("/unrelated/machine/path/a.ts");
  });

  // The boundary picker is NOT "first occurrence" or "last occurrence" of the
  // marker — it enumerates every candidate boundary and validates each
  // against the real checkout on disk (exact full-path match first, then a
  // "first path component exists" fallback), picking the boundary only when
  // exactly one candidate is plausible. These fixtures use REAL filesystem
  // state (REPO_ROOT itself, and a synthetic checkout built under `tmp`) —
  // the validation has nothing to check against with a fictional root.
  describe("normalizeSf: candidate-boundary validation against the real checkout", () => {
    it("(a) checkout dir literally named 'src' (this repo's own layout): a doubled /src/src/ marker resolves to the single candidate that exists on disk, not to first-vs-last", () => {
      // REPO_ROOT's basename IS "src", and it contains a real internal
      // src/core/ directory (src/src/core/abort-check.ts on disk) — the
      // exact collision this fix targets.
      expect(normalizeSf(`${REPO_ROOT}/src/core/abort-check.ts`, REPO_ROOT)).toBe("src/core/abort-check.ts");
      // Doubled marker: candidate "src/core/abort-check.ts" is an exact real
      // path; candidate "core/abort-check.ts" (the over-strip a naive
      // lastIndexOf/first-occurrence pick could produce) is not — unambiguous.
      expect(normalizeSf("/ci/runner/work/src/src/core/abort-check.ts", REPO_ROOT))
        .toBe("src/core/abort-check.ts");
      // One more junk segment ahead of the doubled marker — still resolves
      // to the same single real candidate.
      expect(normalizeSf("/ci/runner/work/checkout/src/src/core/abort-check.ts", REPO_ROOT))
        .toBe("src/core/abort-check.ts");
      // Adversarial: the repo basename ("src") ALSO repeats earlier in the
      // pure runner-prefix segment, unrelated to the checkout root
      // ("/build/src/agent/work/..."). Three total marker occurrences, but
      // only one candidate ("src/core/abort-check.ts") clears the exact
      // tier — the spurious prefix occurrence's candidate
      // ("agent/work/src/src/core/abort-check.ts") has no real top-level
      // "agent" dir under REPO_ROOT, so it clears neither tier.
      expect(normalizeSf("/build/src/agent/work/src/src/core/abort-check.ts", REPO_ROOT))
        .toBe("src/core/abort-check.ts");
    });

    it("(a-ambiguous) checkout named 'src': repo basename repeats in BOTH the runner prefix and the repo-relative path, with no exact match to break the tie — fails conservatively", () => {
      // Two candidate boundaries, neither an exact match, but BOTH first
      // components ("test/" and "scripts/") are real top-level dirs under
      // REPO_ROOT — genuinely ambiguous from string content + shallow
      // validation alone. Retain the absolute path rather than guess.
      const adversarial = "/ci/src/test/src/scripts/tool.ts";
      expect(normalizeSf(adversarial, REPO_ROOT)).toBe(adversarial);
    });

    it("(b) a repo root with a different checkout directory name still resolves an internal source directory, including a doubled marker and an ambiguous case", () => {
      const gbrainRoot = join(tmp, "gbrain-checkout");
      mkdirSync(join(gbrainRoot, "src", "core"), { recursive: true });
      writeFileSync(join(gbrainRoot, "src", "core", "foo.ts"), "// fixture\n");
      mkdirSync(join(gbrainRoot, "scripts"), { recursive: true });
      writeFileSync(join(gbrainRoot, "scripts", "tool.ts"), "// fixture\n");
      mkdirSync(join(gbrainRoot, "test"), { recursive: true });

      expect(normalizeSf(`${gbrainRoot}/src/core/foo.ts`, gbrainRoot)).toBe("src/core/foo.ts");
      // Foreign machine, different absolute prefix, SAME checkout dir name,
      // single marker occurrence.
      expect(normalizeSf(`/runner/_work/example-org/gbrain-checkout/src/core/foo.ts`, gbrainRoot))
        .toBe("src/core/foo.ts");
      // A nested non-src internal directory normalizes the same way.
      expect(normalizeSf(`/runner/_work/example-org/gbrain-checkout/scripts/tool.ts`, gbrainRoot))
        .toBe("scripts/tool.ts");
      // Doubled marker: an internal directory happens to share the
      // checkout's own (non-"src") name. Only the inner candidate
      // ("src/core/foo.ts") is an exact real path; the outer candidate
      // ("gbrain-checkout/src/core/foo.ts") is not — unambiguous.
      expect(normalizeSf(`/ci/runner/work/gbrain-checkout/gbrain-checkout/src/core/foo.ts`, gbrainRoot))
        .toBe("src/core/foo.ts");
      // Adversarial ambiguous case, mirrored for a non-"src" checkout name:
      // basename repeats in the runner prefix AND inside the repo-relative
      // path; both candidates' first components ("test/", "scripts/") are
      // real dirs, neither candidate is an exact match (the leaf file
      // doesn't exist) — conservative fallback.
      const adversarial = `/ci/gbrain-checkout/test/gbrain-checkout/scripts/nonexistent-tool.ts`;
      expect(normalizeSf(adversarial, gbrainRoot)).toBe(adversarial);
    });

    it("(c) traversal-shaped candidates are rejected fail-closed BEFORE any filesystem probe, never escaping root", () => {
      const travRoot = join(tmp, "trav-checkout");
      mkdirSync(join(travRoot, "src", "core"), { recursive: true });
      writeFileSync(join(travRoot, "src", "core", "foo.ts"), "// fixture\n");
      // A sibling directory OUTSIDE travRoot whose file would exist if a
      // traversal candidate were ever handed to existsSync unfiltered — this
      // proves the escape target is real, not merely hypothetical.
      mkdirSync(join(tmp, "trav-outside"), { recursive: true });
      writeFileSync(join(tmp, "trav-outside", "secret.ts"), "// should never be probed\n");

      // Single marker occurrence; the only candidate is traversal-shaped
      // ("../trav-outside/secret.ts") and must be rejected lexically before
      // existsSync ever runs — the real escape target existing on disk must
      // not matter. Conservative fallback: original absolute SF preserved.
      const escapeSf = "/ci/work/trav-checkout/../trav-outside/secret.ts";
      expect(normalizeSf(escapeSf, travRoot)).toBe(escapeSf);

      // Doubled marker, both candidates traversal-shaped (".." segments) —
      // still 0 plausible candidates, still preserved unchanged.
      const doubledEscapeSf = "/ci/trav-checkout/trav-checkout/../../etc/passwd";
      expect(normalizeSf(doubledEscapeSf, travRoot)).toBe(doubledEscapeSf);

      // Doubled marker where ONE candidate is traversal-shaped (rejected
      // lexically) and the OTHER is a safe, exact, real repo-relative path —
      // the safe boundary still resolves normally; a ".." elsewhere in the
      // string doesn't poison an unrelated valid candidate.
      const mixedSf = "/ci/work/decoy/trav-checkout/../trav-checkout/src/core/foo.ts";
      expect(normalizeSf(mixedSf, travRoot)).toBe("src/core/foo.ts");
    });
  });
});

describe("merge: malformed input handling", () => {
  it("skips a malformed lcov file whole and marks degraded, keeping the good lane", () => {
    const good = laneDir("mal-good", LANE_A);
    const bad = laneDir("mal-bad", "DA:1,1\n"); // DA outside any SF record
    const out = outPaths("mal");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, good, bad]);
    expect(res.code).toBe(0); // never aborts
    expect(res.stderr).toContain("malformed");
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.files["src/fixture-cov-a.ts"]).toEqual({ lines: 3, covered: 2, pct: 66.67 });
  });

  it("treats a truncated file (SF without end_of_record) as malformed", () => {
    const bad = laneDir("trunc-bad", "SF:src/fixture-trunc.ts\nDA:1,1\n");
    const out = outPaths("trunc");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, bad]);
    expect(res.code).toBe(0);
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.files["src/fixture-trunc.ts"]).toBeUndefined(); // whole file skipped
  });

  it("parseLcovText unit: unknown record types warn and are skipped without malforming", () => {
    const res = parseLcovText("SF:src/x.ts\nBRDA:1,0,0,1\nDA:1,1\nend_of_record\n");
    expect(res.malformed).toBe(false);
    expect(res.warnings.some((w) => w.includes("BRDA"))).toBe(true);
    expect(res.records[0]?.da).toEqual([[1, 1]]);
  });

  it("parseLcovText unit: non-numeric DA is malformed", () => {
    const res = parseLcovText("SF:src/x.ts\nDA:one,1\nend_of_record\n");
    expect(res.malformed).toBe(true);
    expect(res.records).toEqual([]);
  });
});

describe("merge: lane manifests", () => {
  const GOOD_MANIFEST = { lane: "shard-1", sha: "deadbeef", lcovCount: 1, complete: true };

  it("complete expected lanes → not degraded; lanes.complete lists them", () => {
    const a = laneDir("man-ok", LANE_A, GOOD_MANIFEST);
    const out = outPaths("man-ok");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "shard-1", a]);
    expect(res.code).toBe(0);
    const json = readSummary(out.json);
    expect(json.degraded).toBe(false);
    expect(json.lanes.expected).toEqual(["shard-1"]);
    expect(json.lanes.complete).toEqual(["shard-1"]);
  });

  it("missing manifest for an expected lane → degraded", () => {
    const a = laneDir("man-miss", LANE_A, GOOD_MANIFEST);
    const out = outPaths("man-miss");
    const res = runMerge([
      "--out-lcov", out.lcov, "--out-json", out.json,
      "--manifest-expect", "shard-1,serial", a,
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("serial");
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.lanes.expected).toEqual(["shard-1", "serial"]);
    expect(json.lanes.complete).toEqual(["shard-1"]);
  });

  it("incomplete manifest for an expected lane → degraded", () => {
    const a = laneDir("man-inc", LANE_A, { ...GOOD_MANIFEST, complete: false });
    const out = outPaths("man-inc");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "shard-1", a]);
    const json = readSummary(out.json);
    expect(json.degraded).toBe(true);
    expect(json.lanes.complete).toEqual([]);
  });

  it("shard manifest with lcovCount != 1 → degraded (xargs-batching tripwire)", () => {
    const a = laneDir("man-two", LANE_A, { ...GOOD_MANIFEST, lcovCount: 2 });
    const out = outPaths("man-two");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "shard-1", a]);
    expect(res.stderr).toContain("lcovCount=2");
    expect(readSummary(out.json).degraded).toBe(true);
  });

  it("non-shard lane may carry many lcov files without tripping the tripwire", () => {
    const a = laneDir("man-serial", LANE_A, { lane: "serial", sha: "d", lcovCount: 12, complete: true });
    const out = outPaths("man-serial");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, "--manifest-expect", "serial", a]);
    expect(readSummary(out.json).degraded).toBe(false);
  });
});

describe("merge: JSON metrics scope + hand-computed totals", () => {
  const LANE_C = [
    "SF:src/fixture-tot-one.ts",
    "DA:1,1",
    "DA:2,0",
    "end_of_record",
    "SF:src/core/fixture-tot-two.ts",
    "DA:10,3",
    "DA:11,1",
    "DA:12,0",
    "end_of_record",
    "SF:test/fixture-tot.test.ts",
    "DA:1,1",
    "end_of_record",
    "SF:scripts/fixture-tot-tool.ts",
    "DA:1,1",
    "end_of_record",
    "",
  ].join("\n");

  it("totals/dirs/files count src/ only; out-lcov keeps every record", () => {
    const c = laneDir("tot-c", LANE_C);
    const out = outPaths("tot");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, c]);
    expect(res.code).toBe(0);

    const json = readSummary(out.json);
    // Hand-computed: src lines 2+3=5, covered 1+2=3 → 60%.
    expect(json.total).toEqual({ lines: 5, covered: 3, pct: 60 });
    expect(json.dirs["src"]).toEqual({ lines: 2, covered: 1, pct: 50 });
    expect(json.dirs["src/core"]).toEqual({ lines: 3, covered: 2, pct: 66.67 });
    expect(Object.keys(json.files).sort()).toEqual([
      "src/core/fixture-tot-two.ts",
      "src/fixture-tot-one.ts",
    ]);
    expect(json.lineHits["test/fixture-tot.test.ts"]).toBeUndefined();

    // Non-src records stay in the merged lcov artifact.
    const lcov = readFileSync(out.lcov, "utf8");
    expect(lcov).toContain("SF:test/fixture-tot.test.ts");
    expect(lcov).toContain("SF:scripts/fixture-tot-tool.ts");
  });

  it("neverLoaded inventories real src files absent from the data — count + sorted list, no percentage", () => {
    const c = laneDir("never-c", LANE_C);
    const out = outPaths("never");
    runMerge(["--out-lcov", out.lcov, "--out-json", out.json, c]);
    const json = readSummary(out.json);
    // The fixture files are "loaded" (present in data); every real src file is not.
    expect(json.neverLoaded.count).toBe(json.neverLoaded.files.length);
    expect(json.neverLoaded.files).toContain("src/cli.ts");
    expect(json.neverLoaded.files).not.toContain("src/fixture-tot-one.ts");
    const sorted = [...json.neverLoaded.files].sort();
    expect(json.neverLoaded.files).toEqual(sorted);
    expect(json.neverLoaded.files.every((f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))).toBe(true);
  });
});

describe("merge: self-merge guard (coverage-merged exclusion)", () => {
  it("skips lcov.info under a coverage-merged path segment without degrading", () => {
    // CI report-job re-runs download the PRIOR run's own coverage-merged
    // artifact via the coverage-* glob; re-merging it would double every hit
    // count. The guard drops it while keeping real lanes.
    laneDir("selfmerge/lane-a", LANE_A);
    laneDir(
      "selfmerge/coverage-merged",
      ["SF:src/fixture-prior-merged.ts", "DA:1,100", "end_of_record", ""].join("\n"),
    );
    const out = outPaths("selfmerge");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, join(tmp, "selfmerge")]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("self-merge guard");
    const json = readSummary(out.json);
    expect(json.files["src/fixture-prior-merged.ts"]).toBeUndefined(); // prior artifact dropped
    expect(json.files["src/fixture-cov-a.ts"]).toEqual({ lines: 3, covered: 2, pct: 66.67 }); // real lane kept
    expect(json.degraded).toBe(false); // expected on re-runs, not data loss
  });

  it("skips a direct lcov.info FILE input under a coverage-merged segment", () => {
    laneDir("selfmerge-direct/coverage-merged", LANE_A);
    const a = laneDir("selfmerge-direct/lane-a", LANE_A);
    const out = outPaths("selfmerge-direct");
    const res = runMerge([
      "--out-lcov", out.lcov, "--out-json", out.json,
      join(tmp, "selfmerge-direct", "coverage-merged", "lcov.info"),
      a,
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("self-merge guard");
    // Only the real lane merged: hits are lane-A's alone, not doubled.
    expect(readSummary(out.json).lineHits["src/fixture-cov-a.ts"]).toEqual({ "1": 1, "2": 0, "3": 5 });
  });

  it("isMergedArtifactPath unit: matches a path SEGMENT, not a substring", () => {
    expect(isMergedArtifactPath("/dl/coverage-merged/lcov.info")).toBe(true);
    expect(isMergedArtifactPath("dl/coverage-merged/nested/lcov.info")).toBe(true);
    expect(isMergedArtifactPath("/dl/coverage-merged-old/lcov.info")).toBe(false);
    expect(isMergedArtifactPath("/dl/coverage-shard1/lcov.info")).toBe(false);
  });
});

describe("merge: CLI contract", () => {
  it("missing required args → exit 2", () => {
    const res = runMerge(["--out-lcov", join(tmp, "x.lcov")]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage");
  });

  it("nonexistent input path warns and marks degraded, never aborts", () => {
    const a = laneDir("ghost-a", LANE_A);
    const out = outPaths("ghost");
    const res = runMerge(["--out-lcov", out.lcov, "--out-json", out.json, a, join(tmp, "does-not-exist")]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("not found");
    expect(readSummary(out.json).degraded).toBe(true);
  });
});
