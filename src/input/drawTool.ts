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

  private disposers: Array<() => void> = [];

  constructor(
    private dom: HTMLElement,
    private camera: THREE.Camera,
    private terrainMesh: THREE.Object3D,
    private graph: RoadGraph,
    private hf: Heightfield,
    private scene: THREE.Scene,
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

    this.bindEvents();
  }

  private bindEvents(): void {
    const el = this.dom;

    const onPointerDown = (e: PointerEvent) => {
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

      const p = RoadGraph.snap(hit.x, hit.z);
      this.chain = [p];
      this.updatePreview();
    };

    const onPointerMove = (e: PointerEvent) => {
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
      const p = RoadGraph.snap(hit.x, hit.z);
      const last = this.chain[this.chain.length - 1];
      if (last && last.x === p.x && last.z === p.z) return;
      this.chain.push(p);
      this.updatePreview();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (!this.dragging) return;
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
      this.hoverRing.visible = false;
    };

    // Browser/OS can cancel a drag mid-flight (e.g. touch gesture reinterpreted, pen leaving
    // range, window losing focus). Abort cleanly: release capture, reset chain state, and fade
    // out the in-progress preview exactly like an invalid pointerup would.
    const onPointerCancel = () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.pointerId !== null) {
        try {
          if (el.hasPointerCapture(this.pointerId)) {
            el.releasePointerCapture(this.pointerId);
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
    const p = RoadGraph.snap(hit.x, hit.z);
    const y = this.hf.heightAt(p.x, p.z) + HOVER_YLIFT;
    this.hoverBase.set(p.x, y, p.z);
    this.hoverRing.material = this.hoverRingMat;
    this.hoverVisible = true;
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
    // Task 9 swaps this to queue.enqueueDemolish
    this.graph.removeEdge(found.edgeId);
    this.hoverVisible = false;
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
  }
}
