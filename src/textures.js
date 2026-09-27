// STUB — owned by Agent 1 (World). Procedural canvas textures. Replace bodies, keep signatures.
import * as THREE from 'three';

function solid(color = '#ff00ff') {
  const c = document.createElement('canvas'); c.width = c.height = 4;
  const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** Tileable neon grid (lines on dark bg). RepeatWrapping set. @returns {THREE.CanvasTexture} */
export function createGridTexture({ size = 256, divisions = 4, lineColor = '#ff2bd6', bgColor = '#0b0320', lineWidth = 3 } = {}) { return solid(bgColor); }
/** Vertical sky gradient (+ stars). @returns {THREE.CanvasTexture} */
export function createSkyTexture({ top = '#05001a', bottom = '#3d0060', stars = 160 } = {}) { return solid(bottom); }
/** Striped synthwave sun disc with alpha. @returns {THREE.CanvasTexture} */
export function createSunTexture({ top = '#ffd319', bottom = '#ff2bd6', size = 512 } = {}) { return solid(top); }
/** Soft radial glow sprite (white center -> transparent). Used by effects.js for particles. @returns {THREE.CanvasTexture} */
export function createGlowTexture({ size = 64, color = '#ffffff' } = {}) { return solid(color); }
/** Mountain silhouette strip with glowing edge line (alpha). @returns {THREE.CanvasTexture} */
export function createMountainTexture({ width = 1024, height = 256, fill = '#14002e', edge = '#ff2bd6', seed = 1 } = {}) { return solid(fill); }
/** Generic emissive panel pattern for obstacles/buildings (stripes/windows). @returns {THREE.CanvasTexture} */
export function createPanelTexture({ size = 128, color = '#9d4dff', bg = '#10002a', style = 'stripes' } = {}) { return solid(color); }
