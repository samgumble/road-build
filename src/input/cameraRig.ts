import * as THREE from 'three';
import { damp } from '../render/easing';

const IDLE_TIMEOUT = 20; // seconds
const IDLE_ORBIT_SPEED = 0.02; // rad/s
const DAMP_LAMBDA = 8;

const MIN_RADIUS = 20;
const MAX_RADIUS = 620;
const MIN_POLAR = 0.15; // near-vertical guard (radians from +Y)
const MAX_POLAR = Math.PI / 2 - 0.02; // don't go below horizon

// Task 29 (mobile): two-finger gesture tuning. Pan speed reuses the same goalRadius-scaled factor
// as the mouse MMB pan (panByScreenDelta) so the two feel consistent at any zoom level. Pinch and
// twist are read from the two touch pointers' centroid/distance/angle deltas frame-to-frame (via
// pointer events, not TouchEvent — this app already standardized on pointer events for mouse, so
// touch gestures are built the same way rather than introducing a second input API).
const PINCH_ZOOM_SENSITIVITY = 1.0; // multiplies the inverse distance-ratio applied to goalRadius
const TWIST_ORBIT_SENSITIVITY = 1.0; // radians of azimuth per radian of measured twist

export class CameraRig {
  target = new THREE.Vector3(0, 0, 0);
  idle = false;

  // goal (input-driven) spherical state
  private goalTarget = new THREE.Vector3(0, 0, 0);
  private goalAzimuth: number;
  private goalPolar: number;
  private goalRadius: number;

  // current (damped, rendered) spherical state
  private azimuth: number;
  private polar: number;
  private radius: number;

  private idleTimer = 0;

  private panKeys = { w: false, a: false, s: false, d: false };

  private rightDown = false;
  private middleDown = false;
  private lastX = 0;
  private lastY = 0;

  // Task 29: active touch pointers (pointerType === 'touch' only), keyed by pointerId. Mouse/pen
  // input never enters this map, so every desktop path above is completely unaffected.
  private touches = new Map<number, { x: number; y: number }>();
  // Task 29 fix (review finding 1): the two pointerIds currently driving the gesture. Tracked
  // explicitly (rather than inferring "still 2 fingers down") so a pointer-membership change
  // (e.g. A+B -> +C (ignored, size 3) -> -A (size 2, but now B+C) can be detected and rebaselined
  // instead of computing deltas against a stale A+B baseline, which produced a one-frame camera
  // snap.
  private gesturePair: [number, number] | null = null;
  private twoFingerLastCenter: { x: number; y: number } | null = null;
  private twoFingerLastDist = 0;
  private twoFingerLastAngle = 0;
  /** Set by main.ts to let DrawTool know a two-finger gesture just started, so it can cancel any
   * in-progress single-finger draw chain cleanly (reuses the pointercancel path). */
  onTwoFingerStart: (() => void) | null = null;

  private disposers: Array<() => void> = [];

  constructor(private camera: THREE.PerspectiveCamera, private domElement: HTMLElement) {
    const offset = new THREE.Vector3().subVectors(camera.position, this.target);
    this.radius = this.goalRadius = offset.length();
    this.azimuth = this.goalAzimuth = Math.atan2(offset.x, offset.z);
    this.polar = this.goalPolar = Math.acos(THREE.MathUtils.clamp(offset.y / (this.radius || 1), -1, 1));

    this.bindEvents();
    this.updateCameraFromSpherical();
  }

  private bindEvents(): void {
    const el = this.domElement;

    const onContextMenu = (e: Event) => e.preventDefault();
    el.addEventListener('contextmenu', onContextMenu);

    const onPointerDown = (e: PointerEvent) => {
      this.registerInput();

      // Task 29 (mobile): touch pointers never drive the RMB/MMB paths above (touch has no
      // `button` semantics the way mouse does — DrawTool owns single-finger touch for
      // drawing/demolish). Track every touch pointer here purely to recognize a *second* finger
      // landing, which starts a two-finger camera gesture and cedes control away from DrawTool.
      if (e.pointerType === 'touch') {
        const wasBelowTwo = this.touches.size < 2;
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size >= 2) {
          el.setPointerCapture(e.pointerId);
          if (wasBelowTwo) this.onTwoFingerStart?.();
          this.syncGesturePair();
        }
        return;
      }

      if (e.button === 2) {
        this.rightDown = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        el.setPointerCapture(e.pointerId);
      } else if (e.button === 1) {
        this.middleDown = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      // left button (0) intentionally ignored — reserved for draw tool.
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        if (!this.touches.has(e.pointerId)) return;
        this.registerInput();
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size >= 2) this.updateTwoFingerGesture();
        return;
      }

      if (!this.rightDown && !this.middleDown) return;
      this.registerInput();
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      if (this.rightDown) {
        this.goalAzimuth -= dx * 0.005;
        this.goalPolar = THREE.MathUtils.clamp(this.goalPolar - dy * 0.005, MIN_POLAR, MAX_POLAR);
      } else if (this.middleDown) {
        this.panByScreenDelta(dx, dy);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        this.touches.delete(e.pointerId);
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        this.syncGesturePair();
        return;
      }

      if (e.button === 2) this.rightDown = false;
      if (e.button === 1) this.middleDown = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      this.touches.delete(e.pointerId);
      this.syncGesturePair();
    };

    const onWheel = (e: WheelEvent) => {
      this.registerInput();
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.001);
      const prevRadius = this.goalRadius;
      this.goalRadius = THREE.MathUtils.clamp(this.goalRadius * factor, MIN_RADIUS, MAX_RADIUS);

      // Dolly toward cursor: shift goalTarget slightly along the ray under the cursor. When the
      // ray has no usable terrain intersection (cursor over open sky, or a near-horizon grazing
      // ray whose intersection would land implausibly far away — see rayGroundIntersection's
      // MAX_RADIUS*2 cap), fall back to dollying toward the camera's current look-target instead
      // of leaving goalTarget untouched — this keeps the zoom-toward-cursor *feel* consistent
      // without ever being able to fling the camera off toward a degenerate point.
      const ndc = this.pointerToNdc(e.clientX, e.clientY);
      const dir = this.ndcToWorldDir(ndc);
      const groundPoint = this.rayGroundIntersection(dir) ?? this.goalTarget.clone();
      const radiusDelta = prevRadius - this.goalRadius;
      const t = THREE.MathUtils.clamp(radiusDelta / prevRadius, -0.5, 0.5);
      const toPoint = new THREE.Vector3().subVectors(groundPoint, this.goalTarget);
      this.goalTarget.addScaledVector(toPoint, t);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
        this.registerInput();
        this.panKeys[k] = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') this.panKeys[k] = false;
    };

    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    this.disposers.push(
      () => el.removeEventListener('contextmenu', onContextMenu),
      () => el.removeEventListener('pointerdown', onPointerDown),
      () => window.removeEventListener('pointermove', onPointerMove),
      () => window.removeEventListener('pointerup', onPointerUp),
      () => window.removeEventListener('pointercancel', onPointerCancel),
      () => el.removeEventListener('wheel', onWheel),
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
    );
  }

  private registerInput(): void {
    this.idleTimer = 0;
    this.idle = false;
  }

  private panByScreenDelta(dx: number, dy: number): void {
    const panSpeed = this.goalRadius * 0.0016;
    const forward = new THREE.Vector3(
      Math.sin(this.goalAzimuth),
      0,
      Math.cos(this.goalAzimuth),
    );
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    this.goalTarget.addScaledVector(right, -dx * panSpeed);
    this.goalTarget.addScaledVector(forward, dy * panSpeed);
  }

  /**
   * Task 29 (mobile): two-finger touch gesture recognition, combining pan/pinch/twist into one
   * frame-to-frame delta the same way desktop combines MMB-pan + wheel-dolly + RMB-orbit, just
   * driven by the two active touch pointers' centroid/distance/angle instead of separate mouse
   * buttons. `this.touches` only ever contains `pointerType === 'touch'` entries (see onPointerDown
   * above), so this never runs for mouse/pen input.
   */
  private twoFingerPoints(): [{ x: number; y: number }, { x: number; y: number }] | null {
    if (!this.gesturePair) return null;
    const a = this.touches.get(this.gesturePair[0]);
    const b = this.touches.get(this.gesturePair[1]);
    if (!a || !b) return null;
    return [a, b];
  }

  /**
   * Review fix (finding 1): recompute which two pointerIds should drive the gesture — the first
   * two touches in Map insertion order, matching the old `twoFingerPoints()` behavior — every time
   * a touch pointer goes down/up/cancels. If fewer than two touches remain, clear the pair and
   * baseline entirely (as before). If two-or-more remain but the *driving pair's membership*
   * changed (e.g. A+B -> +C, then -A leaves B+C, which never matched the old A+B baseline), force
   * a rebaseline instead of letting `updateTwoFingerGesture` compute deltas against stale
   * center/dist/angle — that mismatch was the one-frame camera snap this fix addresses.
   */
  private syncGesturePair(): void {
    if (this.touches.size < 2) {
      this.gesturePair = null;
      this.twoFingerLastCenter = null;
      return;
    }
    const ids = [...this.touches.keys()];
    const newPair: [number, number] = [ids[0], ids[1]];
    const changed =
      !this.gesturePair ||
      this.gesturePair[0] !== newPair[0] ||
      this.gesturePair[1] !== newPair[1];
    this.gesturePair = newPair;
    if (changed) this.beginTwoFingerGesture();
  }

  private beginTwoFingerGesture(): void {
    const pts = this.twoFingerPoints();
    if (!pts) return;
    const [a, b] = pts;
    this.twoFingerLastCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.twoFingerLastDist = Math.hypot(b.x - a.x, b.y - a.y);
    this.twoFingerLastAngle = Math.atan2(b.y - a.y, b.x - a.x);
  }

  private updateTwoFingerGesture(): void {
    const pts = this.twoFingerPoints();
    if (!pts) return;
    const [a, b] = pts;
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);

    if (!this.twoFingerLastCenter) {
      this.twoFingerLastCenter = center;
      this.twoFingerLastDist = dist;
      this.twoFingerLastAngle = angle;
      return;
    }

    // Pan: centroid screen-space delta, same treatment as MMB pan.
    const dx = center.x - this.twoFingerLastCenter.x;
    const dy = center.y - this.twoFingerLastCenter.y;
    if (dx !== 0 || dy !== 0) this.panByScreenDelta(dx, dy);

    // Pinch: distance ratio drives the dolly, inverted (fingers spreading = zoom in = smaller
    // radius) — same clamp range as the wheel dolly.
    if (this.twoFingerLastDist > 1e-3 && dist > 1e-3) {
      const factor = (this.twoFingerLastDist / dist) * PINCH_ZOOM_SENSITIVITY + (1 - PINCH_ZOOM_SENSITIVITY);
      this.goalRadius = THREE.MathUtils.clamp(this.goalRadius * factor, MIN_RADIUS, MAX_RADIUS);
    }

    // Twist: change in the finger-pair's angle drives azimuth orbit, mirroring RMB drag's yaw.
    // Review fix (finding 2): guard against near-coincident fingers on *either* frame (current or
    // last) — if either sample's distance is unstable, atan2's angle becomes noisy and produces
    // unstable azimuth jumps, so skip applying the twist delta that frame (still updates the
    // baseline below so the next frame measures a real delta rather than compounding a skip).
    if (this.twoFingerLastDist >= 1e-3 && dist >= 1e-3) {
      let deltaAngle = angle - this.twoFingerLastAngle;
      deltaAngle = Math.atan2(Math.sin(deltaAngle), Math.cos(deltaAngle));
      this.goalAzimuth -= deltaAngle * TWIST_ORBIT_SENSITIVITY;
    }

    this.twoFingerLastCenter = center;
    this.twoFingerLastDist = dist;
    this.twoFingerLastAngle = angle;
  }

  private pointerToNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private ndcToWorldDir(ndc: THREE.Vector2): THREE.Vector3 {
    const v = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera);
    return v.sub(this.camera.position).normalize();
  }

  /**
   * Camera fix (Addendum A Task 21 deliverable 6): the wheel-dolly used to fling the camera when
   * the cursor ray grazed near the horizon. The strict "points at open sky" case (`dir.y >= 0`,
   * ray never crosses y=0) was already guarded below and is harmless on its own. The actual bug
   * was near-miss rays just *below* the horizon: `dir.y` a tiny negative number (cursor near the
   * top of the screen while the camera is looking nearly flat) drives `t = -origin.y/dir.y` to a
   * huge value, so `groundPoint` lands thousands of units away. `onWheel` blends toward that point
   * with a factor clamped to [-0.5, 0.5], but the vector being blended is itself enormous, so a
   * single wheel tick could still yank `goalTarget` far off, and it compounds on repeated ticks at
   * the same grazing angle. Reject any intersection whose distance from the camera exceeds
   * MAX_RADIUS * 2 (comfortably covers every legitimate on-screen ground point at any allowed
   * zoom level) — beyond that it's functionally "hit the sky", so onWheel's existing `if
   * (groundPoint)` null-check already does the right thing: dolly the zoom without touching
   * goalTarget instead of flinging it toward a degenerate point.
   */
  private rayGroundIntersection(dir: THREE.Vector3): THREE.Vector3 | null {
    const origin = this.camera.position;
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = -origin.y / dir.y;
    if (t < 0 || t > MAX_RADIUS * 2) return null;
    return new THREE.Vector3().copy(origin).addScaledVector(dir, t);
  }

  private updateCameraFromSpherical(): void {
    const sinPolar = Math.sin(this.polar);
    const x = this.radius * sinPolar * Math.sin(this.azimuth);
    const y = this.radius * Math.cos(this.polar);
    const z = this.radius * sinPolar * Math.cos(this.azimuth);
    this.camera.position.set(this.target.x + x, this.target.y + y, this.target.z + z);
    this.camera.lookAt(this.target);
  }

  update(dt: number): void {
    // WASD continuous pan
    if (this.panKeys.w || this.panKeys.a || this.panKeys.s || this.panKeys.d) {
      this.registerInput();
      const panSpeed = this.goalRadius * 1.2 * dt;
      const forward = new THREE.Vector3(Math.sin(this.goalAzimuth), 0, Math.cos(this.goalAzimuth));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      if (this.panKeys.w) this.goalTarget.addScaledVector(forward, -panSpeed);
      if (this.panKeys.s) this.goalTarget.addScaledVector(forward, panSpeed);
      if (this.panKeys.a) this.goalTarget.addScaledVector(right, -panSpeed);
      if (this.panKeys.d) this.goalTarget.addScaledVector(right, panSpeed);
    }

    // idle detection
    if (!this.idle) {
      this.idleTimer += dt;
      if (this.idleTimer >= IDLE_TIMEOUT) this.idle = true;
    }
    if (this.idle) {
      this.goalAzimuth += IDLE_ORBIT_SPEED * dt;
    }

    // critically damped approach of current -> goal
    this.target.x = damp(this.target.x, this.goalTarget.x, DAMP_LAMBDA, dt);
    this.target.y = damp(this.target.y, this.goalTarget.y, DAMP_LAMBDA, dt);
    this.target.z = damp(this.target.z, this.goalTarget.z, DAMP_LAMBDA, dt);

    this.radius = damp(this.radius, this.goalRadius, DAMP_LAMBDA, dt);
    this.polar = damp(this.polar, this.goalPolar, DAMP_LAMBDA, dt);

    // shortest-path damping for azimuth (angle wraparound)
    let deltaAz = this.goalAzimuth - this.azimuth;
    deltaAz = Math.atan2(Math.sin(deltaAz), Math.cos(deltaAz));
    this.azimuth += deltaAz * (1 - Math.exp(-DAMP_LAMBDA * dt));

    this.updateCameraFromSpherical();
  }

  dispose(): void {
    this.disposers.forEach((fn) => fn());
    this.disposers = [];
  }
}
