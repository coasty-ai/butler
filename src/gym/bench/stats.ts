/**
 * The statistics a cycle report and the regression rules use. Everything here
 * is a pure function of counts; nothing reads a result row, so nothing can
 * carry screen text into a report.
 */

/** z for a 95% two-sided interval. */
export const Z95 = 1.959964;

/**
 * Wilson score interval for a rate k/n. Chosen over Wald because cells are
 * small and rates near 0 or 1 are common: it never goes below 0 or above 1,
 * and the upper bound of 0/n (0.114 at n=30, 0.096 at n=36, 0.060 at n=60,
 * 0.041 at n=90) is what the "class fixed" rule reads.
 */
export function wilson(k: number, n: number, z = Z95): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * The standard normal CDF through erf (Abramowitz and Stegun 7.1.26, error
 * under 1.5e-7), which is plenty for a p value printed to three places.
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  const phi = 0.5 * (1 + erf);
  return x >= 0 ? phi : 1 - phi;
}

export interface ProportionTest {
  /** Pooled two-proportion z, positive when the second rate is higher. */
  z: number;
  /** One-sided p that the second rate is lower (a drop). */
  pDrop: number;
  /** One-sided p that the second rate is higher (a rise). */
  pRise: number;
  pTwoSided: number;
  delta: number;
}

/**
 * Pooled two-proportion z test between k1/n1 (before) and k2/n2 (after).
 * One-sided p values are reported in both directions so a caller can ask
 * about a drop (a regression) or a rise (a fix) without redoing the arithmetic.
 */
export function twoProportionZ(
  k1: number,
  n1: number,
  k2: number,
  n2: number,
): ProportionTest {
  if (n1 <= 0 || n2 <= 0)
    return { z: 0, pDrop: 1, pRise: 1, pTwoSided: 1, delta: 0 };
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const pRise = 1 - normalCdf(z);
  const pDrop = normalCdf(z);
  return {
    z,
    pDrop,
    pRise,
    pTwoSided: Math.min(1, 2 * Math.min(pDrop, pRise)),
    delta: p2 - p1,
  };
}

/**
 * McNemar's exact test over paired outcomes: b pairs that passed before and
 * failed after, c pairs that failed before and passed after. Under the null
 * the discordant pairs split evenly, so the p value is the binomial tail of
 * min(b, c) out of b + c at one half, doubled and capped at 1.
 */
export function mcnemarExact(
  b: number,
  c: number,
): {
  pTwoSided: number;
  /** One-sided p that "after" is worse (more b than c). */
  pWorse: number;
  /** One-sided p that "after" is better. */
  pBetter: number;
  discordant: number;
} {
  const n = b + c;
  if (n === 0) return { pTwoSided: 1, pWorse: 1, pBetter: 1, discordant: 0 };
  // Worse: at least b "passed then failed" pairs, i.e. at most c the other way.
  const pWorse = binomialTail(n, c);
  const pBetter = binomialTail(n, b);
  return {
    pTwoSided: Math.min(1, 2 * binomialTail(n, Math.min(b, c))),
    pWorse,
    pBetter,
    discordant: n,
  };
}

/**
 * P(X <= k) for X ~ Binomial(n, 1/2), summed in log space: 2^-n underflows
 * past n = 1074, and pooled cycles in the Honesty Report can get there.
 */
export function binomialTail(n: number, k: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  const logs: number[] = [];
  let logChoose = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    logs.push(logChoose - n * Math.LN2);
  }
  const top = Math.max(...logs);
  const sum = logs.reduce((total, value) => total + Math.exp(value - top), 0);
  return Math.min(1, Math.exp(top) * sum);
}

/**
 * Per-arm sample size for a two-proportion test at alpha (two-sided) and the
 * given power: the report prints it beside the regression table, so
 * "unchanged" is read against how many attempts a real drop would need.
 */
export function powerN(
  p1: number,
  p2: number,
  alpha = 0.05,
  power = 0.8,
): number {
  if (p1 === p2) return Infinity;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);
  const pBar = (p1 + p2) / 2;
  const numerator =
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
    zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator / (p2 - p1)) ** 2);
}

/** Inverse normal CDF by bisection over normalCdf; plenty for report text. */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
