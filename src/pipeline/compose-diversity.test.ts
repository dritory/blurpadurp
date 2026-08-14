import { describe, expect, test } from "bun:test";
import type { NormalizedPick } from "../shared/editor-schema.ts";
import { diversifyPicks } from "./compose-diversity.ts";
import {
  CONVERSATION_TOP_N,
  WORTH_KNOWING_TOP_N,
  routeSection,
} from "./compose-partition.ts";

// These lock the diversity invariant: a dominant narrative is spread
// DOWN the brief rather than stacked at the top, and no cluster owns the
// issue — but the sections are still filled, since rank-based routing
// gives no way to shrink one.

function pick(rank: number, lead: number): NormalizedPick {
  return {
    lead_story_id: lead,
    story_ids: [lead],
    rank,
    reason: `pick ${lead}`,
    is_arc: false,
  };
}

// Story ids encode their cluster in the hundreds digit: 101, 102 → "c1".
const byHundreds = (lead: number): string => `c${Math.floor(lead / 100)}`;

// Where a pick actually lands once compose partitions on rank. Mirrors
// the real path: diversifyPicks re-ranks, routeSection reads the rank.
function sectionOf(res: { picks: NormalizedPick[] }, lead: number): string {
  const p = res.picks.find((x) => x.lead_story_id === lead);
  if (p === undefined) return "cut";
  return routeSection({
    kind: "single",
    rank: p.rank,
    confidence: "high",
    penaltyFactors: [],
  });
}

describe("diversifyPicks — spreading a dominant narrative", () => {
  test("one narrative gets one slot per section instead of owning the top", () => {
    // The reported failure: the editor ranked five Hormuz-adjacent picks
    // 1..5, so the whole lead section was one story told five ways.
    // Wanted: one up top, one in Worth knowing, the rest further down.
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 104),
      pick(5, 105),
      pick(6, 201),
      pick(7, 301),
      pick(8, 401),
      pick(9, 501),
      pick(10, 601),
      pick(11, 701),
      pick(12, 801),
      pick(13, 901),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 4,
      maxPerSectionPerCluster: 1,
    });
    expect(res.overCap).toEqual([]);

    const c1 = res.picks.filter((p) => byHundreds(p.lead_story_id) === "c1");
    // The whole-issue cap trimmed 5 → 4, and those four are spread.
    expect(c1).toHaveLength(4);
    expect(sectionOf(res, 101)).toBe("conversation");
    expect(sectionOf(res, 102)).toBe("worth_knowing");
    expect(sectionOf(res, 103)).toBe("worth_watching");
    expect(sectionOf(res, 104)).toBe("worth_watching");
    expect(sectionOf(res, 105)).toBe("cut");

    // Exactly one c1 item in each bounded section.
    const inConversation = res.picks
      .slice(0, CONVERSATION_TOP_N)
      .filter((p) => byHundreds(p.lead_story_id) === "c1");
    expect(inConversation).toHaveLength(1);
    const inKnowing = res.picks
      .slice(CONVERSATION_TOP_N, WORTH_KNOWING_TOP_N)
      .filter((p) => byHundreds(p.lead_story_id) === "c1");
    expect(inKnowing).toHaveLength(1);
  });

  test("the cluster's best-ranked pick is the one that leads", () => {
    // Spreading must not cost the story its position: the editor's top
    // pick still opens the brief, it just isn't followed by four more of
    // the same story.
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 201),
      pick(5, 301),
      pick(6, 401),
      pick(7, 501),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 9,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks[0]!.lead_story_id).toBe(101);
    expect(res.picks.slice(0, CONVERSATION_TOP_N).map((p) => p.lead_story_id))
      .toEqual([101, 201, 301, 401, 501]);
    // 102 and 103 dropped out of the lead rather than being cut. Both
    // land in Worth knowing here: only two picks are left by then, so
    // there is nothing to separate them with — the cap did what it
    // could, which is get them out of the top.
    expect(sectionOf(res, 102)).toBe("worth_knowing");
    expect(sectionOf(res, 103)).toBe("worth_knowing");
    expect(res.movedDown).toContain(102);
    expect(res.movedDown).toContain(103);
    expect(res.cuts).toHaveLength(0);
  });

  test("a blocked pick lands as high as it legitimately can", () => {
    // 102 is blocked from the conversation but should take the FIRST
    // Worth-knowing slot, ahead of picks the editor ranked below it.
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 201),
      pick(4, 301),
      pick(5, 401),
      pick(6, 501),
      pick(7, 601),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 9,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks.find((p) => p.lead_story_id === 102)!.rank).toBe(
      CONVERSATION_TOP_N + 1,
    );
  });

  test("ranks come out contiguous from 1, so routeSection stays coherent", () => {
    const picks = [pick(1, 101), pick(2, 102), pick(3, 103), pick(4, 201)];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 9,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
  });

  test("unrelated clusters are left in the editor's order", () => {
    const picks = [pick(1, 101), pick(2, 201), pick(3, 301), pick(4, 401)];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 4,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks.map((p) => p.lead_story_id)).toEqual([101, 201, 301, 401]);
    expect(res.movedDown).toEqual([]);
    expect(res.overCap).toEqual([]);
  });
});

describe("diversifyPicks — whole-issue cap", () => {
  test("surplus beyond the issue cap is cut, keeping the best-ranked", () => {
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 104),
      pick(5, 201),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 2,
      maxPerSectionPerCluster: 1,
    });
    expect(res.cuts.map((c) => c.lead_story_id)).toEqual([103, 104]);
    expect(res.picks.map((p) => p.lead_story_id).sort()).toEqual([
      101, 102, 201,
    ]);
  });

  test("the cap stops a huge cluster riding the spread down the issue", () => {
    // Nine picks on one story: without the whole-issue cap the spread
    // would place one in every section and still leave six in the tail.
    const picks = Array.from({ length: 9 }, (_, i) => pick(i + 1, 101 + i));
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 3,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks).toHaveLength(3);
    expect(res.cuts).toHaveLength(6);
  });
});

describe("diversifyPicks — the reserve", () => {
  // The editor is asked for more than ships (12-18 against a 15 issue)
  // so that dropping a crowding pick costs a slot rather than a section.
  // The pool is never thin enough for "silence is a feature" to be the
  // right justification for a short issue.
  test("a cluster cut is absorbed by the reserve, not by the issue", () => {
    // Six picks on one story plus nine others — 15 from the editor.
    const picks = [
      ...[101, 102, 103, 104, 105, 106].map((id, i) => pick(i + 1, id)),
      ...[201, 301, 401, 501, 601, 701, 801, 901, 1001].map((id, i) =>
        pick(7 + i, id),
      ),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 4,
      maxPerSectionPerCluster: 1,
      maxPicks: 12,
    });
    // Two picks cut for crowding, three trimmed off the tail — and the
    // issue still ships a full 12 with all three sections populated.
    expect(res.picks).toHaveLength(12);
    const tail = res.picks.filter(
      (p) => sectionOf(res, p.lead_story_id) === "worth_watching",
    );
    expect(tail.length).toBeGreaterThan(0);
  });

  test("without a reserve the tail section is what disappears", () => {
    // The regression this guards: same shape, no spare picks. Twelve in,
    // ten out, Worth watching empty. Kept as a test so the reason the
    // reserve exists stays visible.
    const picks = [
      ...[101, 102, 103, 104, 105, 106].map((id, i) => pick(i + 1, id)),
      ...[201, 301, 401, 501, 601, 701].map((id, i) => pick(7 + i, id)),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 4,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks).toHaveLength(10);
    expect(
      res.picks.filter(
        (p) => sectionOf(res, p.lead_story_id) === "worth_watching",
      ),
    ).toHaveLength(0);
  });

  test("the trim comes off the tail, never out of the spread", () => {
    const picks = Array.from({ length: 14 }, (_, i) =>
      pick(i + 1, (i + 1) * 100 + 1),
    );
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 4,
      maxPerSectionPerCluster: 1,
      maxPicks: 11,
    });
    expect(res.picks).toHaveLength(11);
    // The first eleven of the editor's order survive; the last three go.
    expect(res.picks.map((p) => p.lead_story_id)).toEqual(
      picks.slice(0, 11).map((p) => p.lead_story_id),
    );
    expect(res.cuts.map((c) => c.lead_story_id)).toEqual([1201, 1301, 1401]);
  });

  test("no trimming when the issue is already at or under size", () => {
    const picks = [pick(1, 101), pick(2, 201), pick(3, 301)];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 4,
      maxPerSectionPerCluster: 1,
      maxPicks: 15,
    });
    expect(res.picks).toHaveLength(3);
    expect(res.cuts).toEqual([]);
  });
});

describe("diversifyPicks — over-cap placements", () => {
  test("an over-cap placement is routine, not a quiet-week signal", () => {
    // Two five-wide sections need ten picks before the tail sees
    // anything, and the editor targets 10-15. So an issue at the bottom
    // of that range runs out of other-cluster material in section two as
    // a matter of course — with plenty of distinct stories in play.
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 104),
      ...[201, 301, 401, 501, 601, 701].map((id, i) => pick(5 + i, id)),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 9,
      maxPerSectionPerCluster: 1,
    });
    // Seven distinct clusters, nothing remotely monotopic — and it still
    // reports an over-cap placement. A boolean here would read as "this
    // week was one story", which is why it's a count.
    expect(new Set(picks.map((p) => byHundreds(p.lead_story_id))).size).toBe(7);
    expect(res.overCap.length).toBeGreaterThan(0);
    expect(res.overCap.length).toBeLessThan(picks.length / 2);
  });

  test("a genuinely single-narrative week still fills the lead section", () => {
    // Everything is one cluster. Sections are fixed-size, so the cap
    // cannot be honoured — the conversation fills anyway rather than
    // shipping a one-item lead.
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 104),
      pick(5, 105),
      pick(6, 106),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 99,
      maxPerSectionPerCluster: 1,
    });
    // Nearly everything is over cap — THAT is the monotopic signal.
    expect(res.overCap.length).toBeGreaterThan(picks.length / 2);
    expect(res.picks.slice(0, CONVERSATION_TOP_N)).toHaveLength(
      CONVERSATION_TOP_N,
    );
    // Relaxation preserves the editor's ordering exactly.
    expect(res.picks.map((p) => p.lead_story_id)).toEqual([
      101, 102, 103, 104, 105, 106,
    ]);
    expect(res.movedDown).toEqual([]);
  });

  test("spreading still does what it can when material is short", () => {
    // Four picks from one cluster, two from another, five lead slots.
    // Promotion runs out, so the conversation carries more c1 than the
    // cap allows — but c2 was still promoted ahead of c1's surplus,
    // which is the part that works.
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 104),
      pick(5, 201),
      pick(6, 202),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 99,
      maxPerSectionPerCluster: 1,
    });
    expect(res.overCap.length).toBeGreaterThan(0);
    expect(res.picks.slice(0, CONVERSATION_TOP_N).map((p) => p.lead_story_id))
      .toEqual([101, 201, 102, 103, 104]);
  });

  test("an unclustered pick is never treated as crowding", () => {
    // clusterOf returns null for stories whose theme has no centroid.
    // Two such picks must not be lumped together.
    const picks = [pick(1, 101), pick(2, 102), pick(3, 103)];
    const res = diversifyPicks(picks, () => null, {
      maxPicksPerCluster: 1,
      maxPerSectionPerCluster: 1,
    });
    expect(res.cuts).toHaveLength(0);
    expect(res.picks).toHaveLength(3);
    expect(res.overCap).toEqual([]);
  });

  test("fewer picks than lead slots is not an error", () => {
    const res = diversifyPicks([pick(1, 101), pick(2, 201)], byHundreds, {
      maxPicksPerCluster: 3,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks.map((p) => p.lead_story_id)).toEqual([101, 201]);
    expect(res.overCap).toEqual([]);
  });

  test("empty pick list survives", () => {
    const res = diversifyPicks([], byHundreds, {
      maxPicksPerCluster: 3,
      maxPerSectionPerCluster: 1,
    });
    expect(res.picks).toEqual([]);
    expect(res.cuts).toEqual([]);
  });
});
