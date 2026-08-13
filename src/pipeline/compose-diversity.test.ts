import { describe, expect, test } from "bun:test";
import type { NormalizedPick } from "../shared/editor-schema.ts";
import { diversifyPicks } from "./compose-diversity.ts";
import { CONVERSATION_TOP_N } from "./compose-partition.ts";

// These lock the diversity invariant: no single narrative cluster owns
// the conversation section, and no cluster owns the issue — but a
// genuinely monotopic week still produces a normally-shaped brief.

function pick(rank: number, lead: number): NormalizedPick {
  return {
    lead_story_id: lead,
    story_ids: [lead],
    rank,
    reason: `pick ${lead}`,
    is_arc: false,
  };
}

// Story ids encode their cluster in the hundreds digit: 101, 102 → "a".
const byHundreds = (lead: number): string => `c${Math.floor(lead / 100)}`;

describe("diversifyPicks — lead cap", () => {
  test("one narrative cannot own the conversation section", () => {
    // The reported failure: the editor ranked five Hormuz-adjacent picks
    // 1..5, so the whole lead section was one story told five ways.
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 104),
      pick(5, 105),
      pick(6, 201),
      pick(7, 301),
      pick(8, 401),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 5,
      maxLeadPerCluster: 2,
    });
    const head = res.picks.slice(0, CONVERSATION_TOP_N);
    const fromC1 = head.filter((p) => byHundreds(p.lead_story_id) === "c1");
    expect(fromC1).toHaveLength(2);
    expect(res.relaxed).toBe(false);
    // The other three lead slots went to the other clusters, in the
    // editor's own rank order.
    expect(head.map((p) => p.lead_story_id)).toEqual([101, 102, 201, 301, 401]);
  });

  test("demoted picks land directly behind the head, not at the bottom", () => {
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
      maxPicksPerCluster: 5,
      maxLeadPerCluster: 2,
    });
    expect(res.demoted).toEqual([103]);
    // 103 was rank 3; it now sits at rank 6 — top of Worth knowing,
    // ahead of picks the editor ranked below it.
    const rankOf103 = res.picks.find((p) => p.lead_story_id === 103)!.rank;
    expect(rankOf103).toBe(CONVERSATION_TOP_N + 1);
  });

  test("ranks come out contiguous from 1, so routeSection stays coherent", () => {
    const picks = [pick(1, 101), pick(2, 102), pick(3, 103), pick(4, 201)];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 5,
      maxLeadPerCluster: 1,
    });
    expect(res.picks.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
  });
});

describe("diversifyPicks — whole-issue cap", () => {
  test("surplus picks from one cluster are cut, keeping the best-ranked", () => {
    const picks = [
      pick(1, 101),
      pick(2, 102),
      pick(3, 103),
      pick(4, 104),
      pick(5, 201),
    ];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 2,
      maxLeadPerCluster: 2,
    });
    expect(res.cuts.map((c) => c.lead_story_id)).toEqual([103, 104]);
    expect(res.picks.map((p) => p.lead_story_id)).toEqual([101, 102, 201]);
  });

  test("cuts shorten the issue rather than relocating the crowding", () => {
    // Demoting instead of cutting would just move a monotopic block from
    // the lead into Worth knowing. Silence is a feature.
    const picks = [pick(1, 101), pick(2, 102), pick(3, 103)];
    const res = diversifyPicks(picks, byHundreds, {
      maxPicksPerCluster: 1,
      maxLeadPerCluster: 1,
    });
    expect(res.picks).toHaveLength(1);
  });
});

describe("diversifyPicks — relaxation", () => {
  test("a genuinely single-narrative week still fills the lead section", () => {
    // Everything is one cluster. Enforcing the lead cap here would ship
    // a two-item conversation section for no editorial reason.
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
      maxLeadPerCluster: 2,
    });
    expect(res.relaxed).toBe(true);
    expect(res.picks.slice(0, CONVERSATION_TOP_N)).toHaveLength(
      CONVERSATION_TOP_N,
    );
    // Relaxation preserves the editor's ordering exactly.
    expect(res.picks.map((p) => p.lead_story_id)).toEqual([
      101, 102, 103, 104, 105, 106,
    ]);
  });

  test("an unclustered pick is never treated as crowding", () => {
    // clusterOf returns null for stories whose theme has no centroid.
    // Two such picks must not be lumped together.
    const picks = [pick(1, 101), pick(2, 102), pick(3, 103)];
    const res = diversifyPicks(picks, () => null, {
      maxPicksPerCluster: 1,
      maxLeadPerCluster: 1,
    });
    expect(res.cuts).toHaveLength(0);
    expect(res.picks).toHaveLength(3);
  });

  test("fewer picks than lead slots is not an error", () => {
    const res = diversifyPicks([pick(1, 101), pick(2, 201)], byHundreds, {
      maxPicksPerCluster: 3,
      maxLeadPerCluster: 1,
    });
    expect(res.picks.map((p) => p.lead_story_id)).toEqual([101, 201]);
    expect(res.relaxed).toBe(false);
  });

  test("empty pick list survives", () => {
    const res = diversifyPicks([], byHundreds, {
      maxPicksPerCluster: 3,
      maxLeadPerCluster: 2,
    });
    expect(res.picks).toEqual([]);
    expect(res.cuts).toEqual([]);
  });
});
