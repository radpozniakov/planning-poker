import { describe, expect, it } from "vitest";
import type { CardValue, Vote } from "@pp/shared";
import { computeVoteStats } from "./stats";

function votes(...cards: CardValue[]): Vote[] {
  return cards.map((cardValue, i) => ({ participantId: `p${i}`, cardValue, hidden: false }));
}

describe("computeVoteStats", () => {
  it("excludes non-numeric cards (? and ☕) from min/max/avg", () => {
    const stats = computeVoteStats(votes(2, 8, "?", "☕"));
    expect(stats.numericCount).toBe(2);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(8);
    expect(stats.average).toBe(5);
    expect(stats.allAgree).toBe(false);
  });

  it("reports allAgree when every numeric vote is equal", () => {
    const stats = computeVoteStats(votes(5, 5, 5, "?"));
    expect(stats.allAgree).toBe(true);
    expect(stats.min).toBe(5);
    expect(stats.max).toBe(5);
    expect(stats.average).toBe(5);
    expect(stats.numericCount).toBe(3);
  });

  it("rounds the average to one decimal place", () => {
    // (1 + 2 + 2) / 3 = 1.666… -> 1.7
    expect(computeVoteStats(votes(1, 2, 2)).average).toBe(1.7);
    // (1 + 2) / 2 = 1.5
    expect(computeVoteStats(votes(1, 2)).average).toBe(1.5);
  });

  it("returns nulls (no throw) when there are no numeric votes", () => {
    const stats = computeVoteStats(votes("?", "☕", "?"));
    expect(stats).toEqual({ min: null, max: null, average: null, allAgree: false, numericCount: 0 });
  });

  it("handles an empty round", () => {
    const stats = computeVoteStats([]);
    expect(stats).toEqual({ min: null, max: null, average: null, allAgree: false, numericCount: 0 });
  });
});
