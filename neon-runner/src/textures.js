// Procedural canvas textures (owned by Agent 1 · World). See ARCHITECTURE.md §4.1b.
// Every function is pure (no shared state) and returns a THREE.CanvasTexture in sRGB.
// Colors are CSS strings (use `hex()` from config.js to convert 0xRRGGBB numbers).
import * as THREE from 'three';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function finish(canvas, { repeat = false, mipmaps = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (!mipmaps) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
  t.needsUpdate = true;
  return t;
}

/** Small deterministic PRNG (mulberry32) so textures are reproducible per seed. */
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tileable neon grid (lines on dark bg). RepeatWrapping set.
 * One texture tile holds `divisions` × `divisions` cells; lines sit on the tile edges so the
 * pattern is seamless. Extra opts: `glow` (px of soft halo), `axis` ('both' | 'x' | 'y'), `core` (0..1 white core alpha).
 * @returns {THREE.CanvasTexture}
 */
export function createGridTexture({ size = 256, divisions = 4, lineColor = '#ff2bd6', bgColor = '#0b0320', lineWidth = 3, glow = 10, axis = 'both', core = 0.55 } = {}) {
  const [c, g] = makeCanvas(size, size);
  g.fillStyle = bgColor;
  g.fillRect(0, 0, size, size);
  const step = size / divisions;
  const drawLines = (width, alpha) => {
    g.globalAlpha = alpha;
    g.fillStyle = lineColor;
    for (let i = 0; i <= divisions; i++) {
      const p = i * step - width / 2; // lines at 0 and size are both drawn (half each) → seamless
      if (axis !== 'x') g.fillRect(0, p, size, width);   // horizontal lines (along u)
      if (axis !== 'y') g.fillRect(p, 0, width, size);   // vertical lines (along v)
    }
  };
  // soft halo: several widening low-alpha passes, then the crisp core line
  if (glow > 0) {
    const passes = 4;
    for (let k = passes; k >= 1; k--) drawLines(lineWidth + (glow * k) / passes, 0.07);
  }
  drawLines(lineWidth, 1);
  // hot white-ish core for bloom
  g.globalAlpha = core;
  g.fillStyle = '#ffffff';
  const cw = Math.max(1, lineWidth * 0.34);
  for (let i = 0; i <= divisions; i++) {
    const p = i * step - cw / 2;
    if (axis !== 'x') g.fillRect(0, p, size, cw);
    if (axis !== 'y') g.fillRect(p, 0, cw, size);
  }
  g.globalAlpha = 1;
  return finish(c, { repeat: true });
}

/**
 * Vertical sky gradient (+ stars), laid out for a sphere's equirect UVs (v = 0.5 is the
 * horizon). Canvas top = zenith. Horizontally tileable (stars wrap), so it can be repeated.
 * Extra opts: `horizon` (glow color at the horizon), `below` (color under the horizon),
 * `width`, `height`, `seed`.
 * @returns {THREE.CanvasTexture}
 */
export function createSkyTexture({ top = '#05001a', bottom = '#3d0060', stars = 160, horizon = '#ff2266', below = '#1a0033', width = 1024, height = 1024, seed = 7 } = {}) {
  const [c, g] = makeCanvas(width, height);
  const hy = height / 2; // horizon row
  const grad = g.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0.0, top);
  grad.addColorStop(0.30, top);          // zenith .. ~36° elevation stays dark
  grad.addColorStop(0.435, bottom);      // purple band
  grad.addColorStop(0.492, horizon);     // hot pink right above the horizon
  grad.addColorStop(0.5, horizon);
  grad.addColorStop(0.515, below);       // below horizon: fog color (ground fades into it)
  grad.addColorStop(1.0, below);
  g.fillStyle = grad;
  g.fillRect(0, 0, width, height);

  // stars — only in the upper part, fading out toward the horizon glow
  const r = rng(seed);
  for (let i = 0; i < stars; i++) {
    const x = r() * width;
    const y = r() * hy * 0.94;
    const fade = 1 - Math.pow(y / (hy * 0.94), 3);
    const big = r() < 0.12;
    const rad = big ? 1.3 + r() * 0.9 : 0.5 + r() * 0.7;
    g.globalAlpha = (0.35 + r() * 0.65) * fade;
    g.fillStyle = r() < 0.25 ? '#9ff6ff' : (r() < 0.3 ? '#ffc6f4' : '#ffffff');
    for (let dx = -width; dx <= width; dx += width) { // wrap copies for seamless tiling
      if (x + dx < -4 || x + dx > width + 4) continue;
      g.beginPath();
      g.arc(x + dx, y, rad, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
  const t = finish(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/**
 * Striped synthwave sun disc with alpha: vertical gradient (top → bottom), horizontal
 * transparent slits in the lower half that get thicker toward the bottom.
 * Extra opts: `stripes` (count), `halo` (0..1 soft outer glow alpha).
 * @returns {THREE.CanvasTexture}
 */
export function createSunTexture({ top = '#ffd319', bottom = '#ff2bd6', size = 512, stripes = 7, halo = 0.0 } = {}) {
  const [c, g] = makeCanvas(size, size);
  const cx = size / 2, cy = size / 2, R = size * 0.46;
  if (halo > 0) {
    const hg = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, size / 2);
    hg.addColorStop(0, `rgba(255,60,180,${halo})`);
    hg.addColorStop(1, 'rgba(255,60,180,0)');
    g.fillStyle = hg;
    g.fillRect(0, 0, size, size);
  }
  // disc
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.clip();
  const grad = g.createLinearGradient(0, cy - R, 0, cy + R);
  grad.addColorStop(0, top);
  grad.addColorStop(0.45, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // slits: cut out with destination-out
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  const startY = cy - R * 0.3;
  const span = cy + R - startY;
  for (let i = 0; i < stripes; i++) {
    const f = i / stripes;
    const y = startY + span * (f * (2 - f) * 0.98); // denser near the top of the striped zone
    const h = size * (0.012 + 0.03 * (i / (stripes - 1 || 1)));
    g.fillRect(0, y, size, h);
  }
  g.restore();
  g.globalCompositeOperation = 'source-over';
  return finish(c);
}

/**
 * Soft radial glow sprite (white center -> transparent). Used by effects.js for particles.
 * @returns {THREE.CanvasTexture}
 */
export function createGlowTexture({ size = 64, color = '#ffffff' } = {}) {
  const [c, g] = makeCanvas(size, size);
  const h = size / 2;
  const rgb = cssToRgb(color);
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0.0, `rgba(${rgb},1)`);
  grad.addColorStop(0.18, `rgba(${rgb},0.85)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.3)`);
  grad.addColorStop(0.75, `rgba(${rgb},0.07)`);
  grad.addColorStop(1.0, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return finish(c);
}

/**
 * Mountain silhouette strip with glowing edge line (alpha above the ridge).
 * Horizontally tileable (the ridge is a sum of integer-frequency sines).
 * Extra opts: `base` (fill color at the bottom, e.g. the fog color), `peak` (0..1 max ridge
 * height), `rough` (0..1 detail amount), `wire` (0..1 alpha of internal vector lines).
 * @returns {THREE.CanvasTexture}
 */
export function createMountainTexture({ width = 1024, height = 256, fill = '#14002e', edge = '#ff2bd6', seed = 1, base = null, peak = 0.85, rough = 0.5, wire = 0.25 } = {}) {
  const [c, g] = makeCanvas(width, height);
  const r = rng(seed * 9973 + 17);
  // ridge profile: sum of sines with integer frequencies → seamless across u
  const waves = [];
  const freqs = [2, 3, 5, 7, 11, 17, 29, 41];
  for (let i = 0; i < freqs.length; i++) {
    waves.push({ f: freqs[i], a: Math.pow(0.62, i) * (i > 3 ? rough * 1.6 : 1), p: r() * Math.PI * 2 });
  }
  const N = 256;
  const ys = new Float32Array(N + 1);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(u * Math.PI * 2 * w.f + w.p);
    // sharpen peaks a bit (abs-ish shaping)
    v = Math.sign(v) * Math.pow(Math.abs(v), 0.85);
    ys[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const lowY = height * 0.92, highY = height * (1 - peak);
  const toY = (v) => lowY + (highY - lowY) * ((v - min) / (max - min || 1));

  // fill
  g.beginPath();
  g.moveTo(0, height);
  for (let i = 0; i <= N; i++) g.lineTo((i / N) * width, toY(ys[i]));
  g.lineTo(width, height);
  g.closePath();
  const grad = g.createLinearGradient(0, highY, 0, height);
  grad.addColorStop(0, fill);
  grad.addColorStop(1, base || fill);
  g.fillStyle = grad;
  g.fill();

  // internal "vector" lines from ridge vertices down (retro wireframe feel)
  if (wire > 0) {
    g.save();
    g.clip();
    g.strokeStyle = edge;
    g.globalAlpha = wire;
    g.lineWidth = 1;
    for (let i = 0; i <= N; i += 8) {
      const x = (i / N) * width, y = toY(ys[i]);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * width * 0.03, height);
      g.stroke();
    }
    g.globalAlpha = wire * 0.6;
    for (let k = 1; k <= 3; k++) { // contour-ish offsets of the ridge
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = (i / N) * width;
        const y = toY(ys[i]) + k * k * height * 0.035;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.restore();
  }

  // glowing ridge line: wide faint halo passes, then a crisp core
  const ridge = () => {
    g.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * width, y = toY(ys[i]);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  };
  g.strokeStyle = edge;
  g.lineJoin = 'round';
  g.globalAlpha = 0.12; g.lineWidth = 9; ridge();
  g.globalAlpha = 0.25; g.lineWidth = 5; ridge();
  g.globalAlpha = 1.0; g.lineWidth = 2.2; ridge();
  g.globalAlpha = 1;
  const t = finish(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/**
 * Generic emissive panel pattern for obstacles/buildings.
 * style: 'stripes' (diagonal hazard stripes), 'windows' (dark facade, lit windows, glowing
 * border), 'border' (dark fill with glowing frame), 'chevrons'.
 * Extra opts: `seed`, `density` (0..1 lit-window ratio).
 * @returns {THREE.CanvasTexture}
 */
export function createPanelTexture({ size = 128, color = '#9d4dff', bg = '#10002a', style = 'stripes', seed = 3, density = 0.35 } = {}) {
  const [c, g] = makeCanvas(size, size);
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  const bw = Math.max(2, size * 0.035);
  const border = (a = 1) => {
    g.globalAlpha = a;
    g.strokeStyle = color;
    g.lineWidth = bw;
    g.strokeRect(bw / 2, bw / 2, size - bw, size - bw);
    g.globalAlpha = 1;
  };
  if (style === 'stripes') {
    g.fillStyle = color;
    const w = size / 8;
    for (let x = -size; x < size * 2; x += w * 2) {
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + w, 0); g.lineTo(x + w - size, size); g.lineTo(x - size, size);
      g.closePath(); g.fill();
    }
    border();
  } else if (style === 'windows') {
    const r = rng(seed);
    const cols = 6, rows = 12;
    const cw = size / cols, ch = size / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const lit = r() < density;
        g.globalAlpha = lit ? 0.6 + r() * 0.4 : 0.08;
        g.fillStyle = lit && r() < 0.2 ? '#ffffff' : color;
        g.fillRect(x * cw + cw * 0.22, y * ch + ch * 0.25, cw * 0.56, ch * 0.45);
      }
    }
    g.globalAlpha = 1;
    border();
  } else if (style === 'chevrons') {
    g.strokeStyle = color;
    g.lineWidth = size * 0.07;
    for (let y = -size * 0.2; y < size * 1.2; y += size * 0.3) {
      g.beginPath();
      g.moveTo(size * 0.15, y + size * 0.2); g.lineTo(size * 0.5, y); g.lineTo(size * 0.85, y + size * 0.2);
      g.stroke();
    }
    border();
  } else { // 'border'
    border();
    g.globalAlpha = 0.25;
    border();
  }
  const t = finish(c, { repeat: true });
  return t;
}

function cssToRgb(color) {
  if (typeof color === 'number') return `${(color >> 16) & 255},${(color >> 8) & 255},${color & 255}`;
  const s = String(color).trim();
  if (s[0] === '#') {
    const h = s.length === 4 ? s.slice(1).split('').map((ch) => ch + ch).join('') : s.slice(1, 7);
    const n = parseInt(h, 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const m = s.match(/\d+(\.\d+)?/g);
  return m && m.length >= 3 ? `${m[0]},${m[1]},${m[2]}` : '255,255,255';
}
