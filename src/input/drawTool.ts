import * as THREE from 'three';
import type { P2, RoadSample } from '../core/types';
import { RoadGraph } from '../sim/roads/graph';
import { validateChain, makeSampler } from '../sim/roads/path';
import type { Heightfield } from '../sim/terrain/heightfield';

const PREVIEW_COLOR = 0xe8641b;
const INVALID_COLOR = 0xc0392b;
const PREVIEW_YLIFT = 0.4;
const STAKE_RADIUS = 0.1;
const STAKE_HEIGHT = 0.9;
const HOVER_INNER = 1.6;
const HOVER_OUTER = 2.2;
const HOVER_YLIFT = 0.15;
const HOVER_BREATHE_HZ = 0.5;
const HOVER_BREATHE_AMOUNT = 0.05;
const FADE_DURATION = 0.3; // seconds
// Magnetic snap radius (Fix: "separate roads should snap together") — wide enough to catch a
// cursor that's a bit off an existing junction/mid-edge point (grid cells are 8u) without pulling
// in unrelated nodes across a normal street spacing.
const MAGNET_RADIUS = 6;
// Close-the-loop snap radius (Task 41: "can't create a road in a complete loop") — same radius as
// MAGNET_RADIUS, but this one snaps onto the ACTIVE chain's own first point, which `graph.
// magnetSnap` has no way to see (it only knows about already-committed nodes/edges). Without this,
// closing a loop by eye relies on landing exactly on the same 8u grid cell as the start stake;
// this makes it forgiving the same way snapping onto an existing junction is.
const LOOP_CLOSE_RADIUS = 6;
// A chain needs at least this many points before "closing the loop" is meaningful (matches
// RoadGraph.commitClosedLoop's own minimum of 3 distinct points for a non-degenerate loop).
const LOOP_CLOSE_MIN_POINTS = 3;

const STAKE_DUST_COUNT = 200; // pool capacity — plenty for rapid-fire stake planting during a drag
const STAKE_DUST_BURST = 5; // particles spawned per planted stake
const STAKE_DUST_LIFETIME = 0.5; // seconds
const STAKE_DUST_SIZE = 0.5;
const STAKE_DUST_COLOR = '#c9b48a';

/**
 * Minimal fixed-capacity particle pool for the stake-planting dust puff — deliberately not shared
 * with `ConstructionRenderer`'s pool (that one lives in render/, this is input/, and the two never
 * need to coordinate); see the plan's polish checklist item for "stake dust puffs on plant".
 * Same ring-buffer/no-per-frame-allocation shape as the construction dust/steam pools.
 */
class StakeDustPool {
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly ages: Float32Array;
  private readonly alive: Uint8Array;
  private cursor = 0;
  readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;

  constructor(private readonly capacity: number) {
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity).fill(Infinity);
    this.alive = new Uint8Array(capacity);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      color: STAKE_DUST_COLOR,
      size: STAKE_DUST_SIZE,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  burst(x: number, y: number, z: number): void {
    for (let i = 0; i < STAKE_DUST_BURST; i++) {
      const slot = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.4 + Math.random() * 0.6;
      this.positions[slot * 3] = x;
      this.positions[slot * 3 + 1] = y;
      this.positions[slot * 3 + 2] = z;
      this.velocities[slot * 3] = Math.cos(angle) * speed;
      this.velocities[slot * 3 + 1] = 0.8 + Math.random() * 0.6;
      this.velocities[slot * 3 + 2] = Math.sin(angle) * speed;
      this.ages[slot] = 0;
      this.alive[slot] = 1;
    }
  }

  update(dt: number): void {
    let maxAlive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.ages[i] += dt;
      if (this.ages[i] >= STAKE_DUST_LIFETIME) {
        this.alive[i] = 0;
        this.positions[i * 3 + 1] = -9999;
        continue;
      }
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      maxAlive = i + 1;
    }
    this.geo.setDrawRange(0, maxAlive);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export type DrawToolMode = 'draw' | 'demolish' | 'none';

/**
 * Owns freehand road drawing (survey preview + stakes + commit) and demolish-click.
 *
 * LMB-only: pointerdown starts a chain, pointermove appends snapped points (resampling the
 * live preview through the real sampler so bridges preview correctly), pointerup commits the
 * chain via `graph.commitChain` iff `validateChain` passes — otherwise the preview fades out
 * and is discarded. RMB/MMB are never touched, so the orbit/pan camera rig keeps working.
 */
export class DrawTool {
  mode: DrawToolMode = 'draw';

  private sampler: (ctrl: P2[]) => RoadSample[];
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  // in-progress chain state
  private dragging = false;
  private pointerId: number | null = null;
  private chain: P2[] = [];
  private chainValid = false;

  // Task 29 (mobile): tracks active touch pointer ids on this element so a second finger landing
  // mid-draw can be recognized and the in-progress chain cancelled cleanly (reusing the
  // pointercancel path) rather than treating the second touch as a draw continuation. Mouse/pen
  // pointers never enter this set.
  private activeTouchIds = new Set<number>();

  // preview scene objects (drawing)
  private previewGroup: THREE.Group;
  private previewLine: THREE.Line | null = null;
  private stakes: THREE.Mesh[] = [];
  private stakeMat: THREE.MeshBasicMaterial;
  private stakeMatInvalid: THREE.MeshBasicMaterial;

  // fade-out state (invalid chain released)
  private fading: { group: THREE.Group; elapsed: number } | null = null;

  // hover ring
  private hoverRing: THREE.Mesh;
  private hoverRingMat: THREE.MeshBasicMaterial;
  private demolishHoverRingMat: THREE.MeshBasicMaterial;
  private hoverVisible = false;
  private hoverBase = new THREE.Vector3();
  private clock = 0;

  // dust puff on stake plant
  private stakeDust: StakeDustPool;

  private disposers: Array<() => void> = [];

  constructor(
    private dom: HTMLElement,
    private camera: THREE.Camera,
    private terrainMesh: THREE.Object3D,
    private graph: RoadGraph,
    private hf: Heightfield,
    private scene: THREE.Scene,
    private demolish: (edgeId: number) => void = (edgeId) => graph.removeEdge(edgeId),
  ) {
    this.sampler = makeSampler(hf);

    this.previewGroup = new THREE.Group();
    this.scene.add(this.previewGroup);

    this.stakeMat = new THREE.MeshBasicMaterial({ color: PREVIEW_COLOR });
    this.stakeMatInvalid = new THREE.MeshBasicMaterial({ color: INVALID_COLOR });

    const ringGeo = new THREE.RingGeometry(HOVER_INNER, HOVER_OUTER, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.hoverRingMat = new THREE.MeshBasicMaterial({
      color: PREVIEW_COLOR,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.demolishHoverRingMat = new THREE.MeshBasicMaterial({
      color: INVALID_COLOR,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.hoverRing = new THREE.Mesh(ringGeo, this.hoverRingMat);
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);

    this.stakeDust = new StakeDustPool(STAKE_DUST_COUNT);
    this.scene.add(this.stakeDust.points);

    this.bindEvents();
  }

  private bindEvents(): void {
    const el = this.dom;

    const onPointerDown = (e: PointerEvent) => {
      // Task 29 (mobile): touch contacts are never distinguished by `button` the way mouse buttons
      // are — every simultaneous touch reports `button === 0`. Track each touch pointer that lands
      // on the canvas; a *second* finger landing mid-draw must cancel the in-progress chain and
      // cede to CameraRig's two-finger gesture rather than being treated as a second draw start or
      // silently ignored while corrupting `this.dragging`'s single-pointer assumption.
      if (e.pointerType === 'touch') {
        this.activeTouchIds.add(e.pointerId);
        if (this.activeTouchIds.size >= 2) {
          this.cancelActiveDrag();
          return;
        }
      }

      if (e.button !== 0) return; // LMB only; never touch RMB/MMB
      if (this.mode === 'none') return;

      if (this.mode === 'demolish') {
        this.tryDemolishAt(e.clientX, e.clientY);
        return;
      }

      const hit = this.groundPointAt(e.clientX, e.clientY);
      if (!hit) return;

      this.cancelFade();
      this.dragging = true;
      this.pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      this.hoverRing.visible = false;

      const p = this.graph.magnetSnap(hit.x, hit.z, MAGNET_RADIUS);
      this.chain = [p];
      this.updatePreview();
      this.spawnStakeDust(p.x, p.z);
    };

    const onPointerMove = (e: PointerEvent) => {
      // A second touch is already down — camera gestures own input until fingers lift (see
      // onPointerDown above, which already cancelled any in-progress draw when the 2nd finger
      // landed). Ignore hover/draw updates from either finger while this holds.
      if (e.pointerType === 'touch' && this.activeTouchIds.size >= 2) return;

      if (this.mode === 'demolish' && !this.dragging) {
        this.updateDemolishHover(e.clientX, e.clientY);
        return;
      }

      if (!this.dragging) {
        this.updateDrawHover(e.clientX, e.clientY);
        return;
      }

      const hit = this.groundPointAt(e.clientX, e.clientY);
      if (!hit) return;
      const p = this.applyLoopCloseSnap(this.graph.magnetSnap(hit.x, hit.z, MAGNET_RADIUS));
      const last = this.chain[this.chain.length - 1];
      if (last && last.x === p.x && last.z === p.z) return;
      this.chain.push(p);
      this.updatePreview();
      this.spawnStakeDust(p.x, p.z);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') this.activeTouchIds.delete(e.pointerId);
      if (e.button !== 0) return;
      if (!this.dragging) return;
      if (this.pointerId !== e.pointerId) return;
      this.dragging = false;
      if (this.pointerId !== null && el.hasPointerCapture(this.pointerId)) {
        el.releasePointerCapture(this.pointerId);
      }
      this.pointerId = null;

      if (this.chainValid && this.chain.length >= 2) {
        this.graph.commitChain(this.chain);
        this.clearPreview();
      } else {
        this.startFade();
      }
      this.chain = [];
    };

    const onPointerLeave = () => {
      // Minor 5: also clear `hoverVisible`, not just the ring's `visible` flag — otherwise the
      // per-frame update loop (`update()`'s `showHover` computation) resurrects the ring next
      // frame at its last hovered position, since it only reads `hoverVisible`/`dragging`/`mode`
      // and has no idea the pointer actually left the canvas.
      this.hoverVisible = false;
      this.hoverRing.visible = false;
    };

    // Browser/OS can cancel a drag mid-flight (e.g. touch gesture reinterpreted, pen leaving
    // range, window losing focus). Abort cleanly: release capture, reset chain state, and fade
    // out the in-progress preview exactly like an invalid pointerup would.
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerType === 'touch') this.activeTouchIds.delete(e.pointerId);
      this.cancelActiveDrag();
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('pointercancel', onPointerCancel);

    this.disposers.push(
      () => el.removeEventListener('pointerdown', onPointerDown),
      () => el.removeEventListener('pointermove', onPointerMove),
      () => el.removeEventListener('pointerup', onPointerUp),
      () => el.removeEventListener('pointerleave', onPointerLeave),
      () => el.removeEventListener('pointercancel', onPointerCancel),
    );
  }

  private pointerToNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    return this.ndc;
  }

  private groundPointAt(clientX: number, clientY: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.pointerToNdc(clientX, clientY), this.camera);
    const hits = this.raycaster.intersectObject(this.terrainMesh, false);
    return hits.length ? hits[0].point : null;
  }

  private updateDrawHover(clientX: number, clientY: number): void {
    const hit = this.groundPointAt(clientX, clientY);
    if (!hit) {
      this.hoverVisible = false;
      this.hoverRing.visible = false;
      return;
    }
    const p = this.applyLoopCloseSnap(this.graph.magnetSnap(hit.x, hit.z, MAGNET_RADIUS));
    const y = this.hf.heightAt(p.x, p.z) + HOVER_YLIFT;
    this.hoverBase.set(p.x, y, p.z);
    this.hoverRing.material = this.hoverRingMat;
    this.hoverVisible = true;
  }

  /**
   * Close-the-loop magnetism (Task 41): while a chain with >= LOOP_CLOSE_MIN_POINTS points is
   * active, if `p` (already resolved through `graph.magnetSnap`) lands within LOOP_CLOSE_RADIUS of
   * the chain's OWN first point, snap onto that exact first point instead. `RoadGraph.magnetSnap`
   * can't see this — the chain isn't committed yet, so the first point isn't a node/edge-interior
   * point the graph knows about. Without this, closing a loop requires landing on the exact same
   * 8u grid cell as the start stake; this makes it as forgiving as snapping onto an existing
   * junction. No-op (returns `p` unchanged) when there's no active chain or it's too short — this
   * is deliberately only relevant while `dragging` is true, since `this.chain` is empty otherwise.
   */
  private applyLoopCloseSnap(p: P2): P2 {
    if (this.chain.length < LOOP_CLOSE_MIN_POINTS) return p;
    const start = this.chain[0];
    const d = Math.hypot(start.x - p.x, start.z - p.z);
    return d <= LOOP_CLOSE_RADIUS ? { x: start.x, z: start.z } : p;
  }

  /** Raycasts road groups (tagged `userData.edgeId`) under the pointer, walking up `.parent`. */
  private findRoadEdgeAt(clientX: number, clientY: number): { edgeId: number; point: THREE.Vector3 } | null {
    this.raycaster.setFromCamera(this.pointerToNdc(clientX, clientY), this.camera);
    // Scope the raycast to road groups only (not terrain/water/preview) — recomputed each call
    // since edges come and go and this must never be cached across calls.
    const roadGroups = this.scene.children.filter((obj) => obj.userData && obj.userData.edgeId !== undefined);
    const hits = this.raycaster.intersectObjects(roadGroups, true);
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        if (obj.userData && typeof obj.userData.edgeId === 'number') {
          return { edgeId: obj.userData.edgeId as number, point: hit.point };
        }
        obj = obj.parent;
      }
    }
    return null;
  }

  /** Small dust puff at a freshly-planted survey stake — see StakeDustPool above. */
  private spawnStakeDust(x: number, z: number): void {
    const y = this.hf.heightAt(x, z);
    this.stakeDust.burst(x, y, z);
  }

  private updateDemolishHover(clientX: number, clientY: number): void {
    const found = this.findRoadEdgeAt(clientX, clientY);
    if (!found) {
      this.hoverVisible = false;
      this.hoverRing.visible = false;
      return;
    }
    this.hoverBase.set(found.point.x, found.point.y + HOVER_YLIFT, found.point.z);
    this.hoverRing.material = this.demolishHoverRingMat;
    this.hoverVisible = true;
  }

  private tryDemolishAt(clientX: number, clientY: number): void {
    const found = this.findRoadEdgeAt(clientX, clientY);
    if (!found) return;
    this.demolish(found.edgeId);
    this.hoverVisible = false;
    this.hoverRing.visible = false;
  }

  /**
   * Cancels any in-progress draw chain cleanly — same effect as a browser/OS pointercancel
   * (release capture, drop the chain, fade the rejected preview). Public so CameraRig can call it
   * directly (via `onTwoFingerStart`, wired in main.ts) the instant a second finger lands,
   * cleanly ceding control to the two-finger camera gesture (Task 29). No-ops if nothing is
   * dragging.
   */
  cancelActiveDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.pointerId !== null) {
      try {
        if (this.dom.hasPointerCapture(this.pointerId)) {
          this.dom.releasePointerCapture(this.pointerId);
        }
      } catch {
        // pointer capture already released/invalid — nothing to clean up
      }
    }
    this.pointerId = null;
    this.chainValid = false;
    this.startFade();
    this.chain = [];
    this.hoverRing.visible = false;
  }

  private cancelFade(): void {
    if (!this.fading) return;
    this.disposeGroup(this.fading.group);
    this.fading = null;
  }

  private clearPreview(): void {
    if (this.previewLine) {
      this.previewGroup.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      this.previewLine = null;
    }
    for (const s of this.stakes) {
      this.previewGroup.remove(s);
      s.geometry.dispose();
    }
    this.stakes = [];
  }

  private startFade(): void {
    // Move current preview objects into their own group and fade it out over FADE_DURATION.
    // Stakes normally share the class-level stakeMat/stakeMatInvalid materials (reused across
    // redraws), so give each faded stake its own cloned material — otherwise animating opacity
    // here would bleed into (and dispose() would break) materials still used by future previews.
    const group = new THREE.Group();
    if (this.previewLine) {
      this.previewLine.material = (this.previewLine.material as THREE.LineDashedMaterial).clone();
      group.add(this.previewLine);
    }
    for (const s of this.stakes) {
      s.material = (s.material as THREE.MeshBasicMaterial).clone();
      group.add(s);
    }
    this.scene.add(group);
    this.previewLine = null;
    this.stakes = [];
    this.fading = { group, elapsed: 0 };
  }

  private disposeGroup(group: THREE.Group): void {
    this.scene.remove(group);
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    }
  }

  /**
   * Rebuilds the survey preview (stakes + dashed line) from the current chain. Only called from
   * pointerdown/pointermove when the snapped point actually changes, so resampling is naturally
   * throttled to real chain growth rather than every pointer event.
   */
  private updatePreview(): void {
    if (this.chain.length < 1) return;

    this.chainValid = this.chain.length >= 2 && validateChain(this.chain, this.hf);

    this.rebuildStakes();
    this.rebuildLine();
  }

  private rebuildStakes(): void {
    for (const s of this.stakes) {
      this.previewGroup.remove(s);
      s.geometry.dispose();
    }
    this.stakes = [];

    const mat = this.chainValid ? this.stakeMat : this.stakeMatInvalid;
    const geo = new THREE.CylinderGeometry(STAKE_RADIUS, STAKE_RADIUS, STAKE_HEIGHT, 8);
    for (const p of this.chain) {
      const mesh = new THREE.Mesh(geo, mat);
      const y = this.hf.heightAt(p.x, p.z) + STAKE_HEIGHT / 2;
      mesh.position.set(p.x, y, p.z);
      this.previewGroup.add(mesh);
      this.stakes.push(mesh);
    }
  }

  private rebuildLine(): void {
    if (this.previewLine) {
      this.previewGroup.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      this.previewLine = null;
    }

    if (this.chain.length < 2) return;

    const samples = this.sampler(this.chain);
    const positions = new Float32Array(samples.length * 3);
    for (let i = 0; i < samples.length; i++) {
      positions[i * 3] = samples[i].x;
      positions[i * 3 + 1] = samples[i].y + PREVIEW_YLIFT;
      positions[i * 3 + 2] = samples[i].z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    const color = this.chainValid ? PREVIEW_COLOR : INVALID_COLOR;
    const mat = new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.2, linewidth: 1 });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    this.previewGroup.add(line);
    this.previewLine = line;
  }

  update(dt: number): void {
    this.clock += dt;

    // fade-out of a rejected preview
    if (this.fading) {
      this.fading.elapsed += dt;
      const u = Math.min(1, this.fading.elapsed / FADE_DURATION);
      const opacity = 1 - u;
      for (const child of this.fading.group.children) {
        if (child instanceof THREE.Line) {
          (child.material as THREE.LineDashedMaterial).transparent = true;
          (child.material as THREE.LineDashedMaterial).opacity = opacity;
        } else if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshBasicMaterial;
          mat.transparent = true;
          mat.opacity = opacity;
        }
      }
      if (u >= 1) {
        this.disposeGroup(this.fading.group);
        this.fading = null;
      }
    }

    // hover ring breathing + visibility
    const showHover = this.hoverVisible && !this.dragging && this.mode !== 'none';
    this.hoverRing.visible = showHover;
    if (showHover) {
      this.hoverRing.position.copy(this.hoverBase);
      const breathe = 1 + HOVER_BREATHE_AMOUNT * Math.sin(2 * Math.PI * HOVER_BREATHE_HZ * this.clock);
      this.hoverRing.scale.set(breathe, 1, breathe);
    }

    this.stakeDust.update(dt);
  }

  dispose(): void {
    this.disposers.forEach((fn) => fn());
    this.disposers = [];
    this.clearPreview();
    this.cancelFade();
    this.scene.remove(this.previewGroup);
    this.scene.remove(this.hoverRing);
    this.hoverRing.geometry.dispose();
    this.hoverRingMat.dispose();
    this.demolishHoverRingMat.dispose();
    this.stakeMat.dispose();
    this.stakeMatInvalid.dispose();
    this.scene.remove(this.stakeDust.points);
    this.stakeDust.dispose();
  }
}
