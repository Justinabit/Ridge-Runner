/* Procedural audio.
 *
 * Everything here is synthesised with the Web Audio API. There are no asset
 * files: nothing to download, nothing to license, nothing to bloat the repo,
 * and it works offline. The result is deliberately synthetic-retro, which suits
 * the low-poly look better than sampled engine recordings would.
 *
 * Browsers refuse to start audio without a user gesture, so the context is
 * created lazily on the first call to start() and every method is a safe no-op
 * until then (and permanently, if Web Audio is unavailable). */

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let started = false;

  // engine
  let engOscA = null, engOscB = null, engFilter = null, engGain = null;
  // wind + tyres
  let noiseSrc = null, windFilter = null, windGain = null;
  let skidFilter = null, skidGain = null;
  let scrapeFilter = null, scrapeGain = null;
  // shield hum
  let shieldOsc = null, shieldGain = null;
  // music
  let musicGain = null, musicTimer = null, musicStep = 0;

  function noiseBuffer() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function start() {
    if (started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;                       // no Web Audio: stay silent forever
    try { ctx = new AC(); } catch { return; }
    started = true;

    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    /* ---- engine: two detuned saws through a lowpass that opens with revs ---- */
    engGain = ctx.createGain();
    engGain.gain.value = 0;
    engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 700;
    engFilter.Q.value = 6;
    engOscA = ctx.createOscillator(); engOscA.type = 'sawtooth';
    engOscB = ctx.createOscillator(); engOscB.type = 'square';
    engOscA.frequency.value = 60;
    engOscB.frequency.value = 30;
    engOscA.connect(engFilter); engOscB.connect(engFilter);
    engFilter.connect(engGain); engGain.connect(master);
    engOscA.start(); engOscB.start();

    /* ---- one noise source feeding both wind and tyre skid ---- */
    noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer();
    noiseSrc.loop = true;

    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 480;
    windFilter.Q.value = 0.7;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    noiseSrc.connect(windFilter); windFilter.connect(windGain); windGain.connect(master);

    skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 2200;
    skidFilter.Q.value = 3;
    skidGain = ctx.createGain(); skidGain.gain.value = 0;
    noiseSrc.connect(skidFilter); skidFilter.connect(skidGain); skidGain.connect(master);

    // metal-on-metal scrape: lower and harsher than the tyre squeal
    scrapeFilter = ctx.createBiquadFilter();
    scrapeFilter.type = 'bandpass';
    scrapeFilter.frequency.value = 900;
    scrapeFilter.Q.value = 1.4;
    scrapeGain = ctx.createGain(); scrapeGain.gain.value = 0;
    noiseSrc.connect(scrapeFilter); scrapeFilter.connect(scrapeGain); scrapeGain.connect(master);
    noiseSrc.start();

    /* ---- shield hum ---- */
    shieldOsc = ctx.createOscillator();
    shieldOsc.type = 'triangle';
    shieldOsc.frequency.value = 320;
    shieldGain = ctx.createGain(); shieldGain.gain.value = 0;
    shieldOsc.connect(shieldGain); shieldGain.connect(master);
    shieldOsc.start();

    /* ---- music bed ---- */
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.16;
    musicGain.connect(master);
    startMusic();
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /* A slow minor-key arpeggio with a root drone. Scheduled one note at a time
   * from a timer, which is plenty accurate at this tempo and far simpler than
   * a lookahead scheduler. */
  const SCALE = [0, 3, 5, 7, 10, 12, 10, 7];
  const ROOTS = [110, 110, 98, 87.31];
  function startMusic() {
    if (musicTimer) clearInterval(musicTimer);
    musicTimer = setInterval(() => {
      if (!ctx || muted || ctx.state !== 'running') return;
      const root = ROOTS[Math.floor(musicStep / 8) % ROOTS.length];
      const semi = SCALE[musicStep % SCALE.length];
      const freq = root * Math.pow(2, semi / 12) * 2;
      blip(freq, 0.5, 0.06, 'triangle', musicGain);
      if (musicStep % 8 === 0) blip(root / 2, 1.4, 0.14, 'sine', musicGain);
      musicStep++;
    }, 320);
  }

  function blip(freq, dur, vol, type, dest) {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(dest || master);
    o.start(); o.stop(ctx.currentTime + dur + 0.05);
  }

  /** Called every frame with the current driving state. */
  function update({ speed, throttle, grounded, sliding, shielded, boosting, scraping }, topSpeed) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const frac = Math.min(1, speed / topSpeed);

    // revs rise with speed but never quite settle, so it never sounds static
    const rev = 55 + frac * 150 + (boosting ? 40 : 0);
    engOscA.frequency.setTargetAtTime(rev, t, 0.08);
    engOscB.frequency.setTargetAtTime(rev * 0.5, t, 0.08);
    engFilter.frequency.setTargetAtTime(500 + frac * 2200 + throttle * 700, t, 0.1);
    engGain.gain.setTargetAtTime(muted ? 0 : 0.11 + throttle * 0.07, t, 0.12);

    windGain.gain.setTargetAtTime(muted ? 0 : frac * frac * 0.16, t, 0.2);
    windFilter.frequency.setTargetAtTime(400 + frac * 900, t, 0.2);

    const skid = (sliding && grounded) ? 0.14 : 0;
    skidGain.gain.setTargetAtTime(muted ? 0 : skid, t, 0.05);

    scrapeGain.gain.setTargetAtTime(muted ? 0 : (scraping ? 0.13 + frac * 0.09 : 0), t, 0.04);
    if (scraping) scrapeFilter.frequency.setTargetAtTime(700 + frac * 1400, t, 0.08);

    shieldGain.gain.setTargetAtTime(muted ? 0 : (shielded ? 0.05 : 0), t, 0.15);
    if (shielded) shieldOsc.frequency.setTargetAtTime(320 + Math.sin(t * 3) * 25, t, 0.2);
  }

  /* ---- one-shots ---- */
  function pickup(kind) {
    if (!ctx || muted) return;
    const base = kind === 'FUEL' ? 620 : 760;
    blip(base, 0.12, 0.22, 'square');
    setTimeout(() => blip(base * 1.5, 0.16, 0.18, 'square'), 70);
    if (kind !== 'FUEL') setTimeout(() => blip(base * 2, 0.2, 0.15, 'triangle'), 140);
  }

  function impact(strength = 1) {
    if (!ctx || muted) return;
    blip(70, 0.35, 0.3 * strength, 'sine');
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.32 * strength, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(); src.stop(ctx.currentTime + 0.32);
  }

  function crash() {
    impact(1.4);
    setTimeout(() => blip(180, 0.6, 0.2, 'sawtooth'), 60);
    setTimeout(() => blip(120, 0.9, 0.18, 'sawtooth'), 180);
  }

  function boostStart() {
    if (!ctx || muted) return;
    for (let i = 0; i < 5; i++) setTimeout(() => blip(300 + i * 160, 0.18, 0.14, 'sawtooth'), i * 45);
  }

  function uiClick() { blip(520, 0.09, 0.16, 'square'); }

  function setMuted(v) {
    muted = v;
    if (master) master.gain.setTargetAtTime(v ? 0 : 0.9, ctx.currentTime, 0.05);
  }
  function isMuted() { return muted; }

  function setMusicEnabled(v) {
    if (musicGain && ctx) musicGain.gain.setTargetAtTime(v ? 0.16 : 0, ctx.currentTime, 0.1);
  }

  return {
    start, resume, update, pickup, impact, crash, boostStart, uiClick,
    setMuted, isMuted, setMusicEnabled,
    get ready() { return !!ctx; },
  };
}
