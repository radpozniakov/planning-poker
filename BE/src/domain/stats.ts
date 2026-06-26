import { isNumericCard, type Vote, type VoteStats } from "@pp/shared";

/**
 * Pure vote-statistics computation (spec open Q6). Only numeric cards participate;
 * `?` and `☕` are excluded. When there are no numeric votes every numeric field is
 * `null` and `allAgree` is `false` — never NaN, never a throw.
 */
export function computeVoteStats(votes: Iterable<Vote>): VoteStats {
  const numeric: number[] = [];
  for (const vote of votes) {
    if (isNumericCard(vote.cardValue)) {
      numeric.push(vote.cardValue);
    }
  }

  const numericCount = numeric.length;
  if (numericCount === 0) {
    return {
      min: null,
      max: null,
      average: null,
      allAgree: false,
      numericCount: 0,
    };
  }

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const sum = numeric.reduce((acc, n) => acc + n, 0);
  const average = Math.round((sum / numericCount) * 10) / 10;

  return { min, max, average, allAgree: min === max, numericCount };
}
