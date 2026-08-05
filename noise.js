/* ---------- deterministic value noise (no external lib needed) ---------- */
export function hash1(n) {
  const s = Math.sin(n) * 43758.5453123;
  return s - Math.floor(s); // [0,1)
}

export function smoothNoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i * 12.9898);
  const b = hash1((i + 1) * 12.9898);
  return a + (b - a) * u; // [0,1)
}

export function octaveNoise(x, octaves = 3, persistence = 0.5) {
  let total = 0, amp = 1, freq = 1, maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    total += (smoothNoise(x * freq) * 2 - 1) * amp;
    maxAmp += amp;
    amp *= persistence;
    freq *= 2.1;
  }
  return total / maxAmp; // [-1,1]
}