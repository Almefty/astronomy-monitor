/**
 * The WebGL part of the 3D Solar System. Loaded with a dynamic import() only when the panel is
 * on screen, so three.js never slows down the rest of the dashboard.
 *
 * Rendering is on demand: a frame is drawn only when something changes (time moves, the camera
 * moves, the selection or theme changes), and never while the view is off-screen or the tab is
 * hidden (`setActive(false)`). Distances are true to scale; bodies are drawn as fixed-size dots
 * and grow into true-size spheres only when you zoom in far enough for that to be visible.
 */
import {
  AmbientLight, BufferAttribute, BufferGeometry, Color, Line, LineBasicMaterial, LineDashedMaterial, LineLoop, LineSegments,
  Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, PointLight, Points, Scene, ShaderMaterial, SphereGeometry,
  Vector3, WebGLRenderer, type Material,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { KM_PER_AU, orbitPath, planetElements, type Vec3 } from "../../shared/orbit";
import { cssVar } from "../core/theme";
import {
  AU_PER_LD, asteroidPosition, BODIES, bodyPositions, geocentricTrack, moonTrack, type Asteroid, type BodyId,
} from "./orrery-model";

export type ViewId = "inner" | "outer" | "earth";

export interface SceneState {
  /** Displayed time, UTC ms, and the matching JD (TDB). */
  ms: number;
  jd: number;
  selected: string | null;
  view: ViewId;
}

export interface OrreryOptions {
  container: HTMLElement;
  asteroids: Asteroid[];
  getState(): SceneState;
  onPick(id: string): void;
  onHover(id: string | null, clientX: number, clientY: number): void;
  onScale(label: string, px: number): void;
  onContextLost(): void;
  reducedMotion: boolean;
}

export interface Orrery {
  invalidate(): void;
  setActive(on: boolean): void;
  goTo(view: ViewId, animate?: boolean): void;
  refreshTheme(): void;
  destroy(): void;
}

const FOV = 45;
/**
 * Radius (au) each view frames (on the short side; seen from 40° above, orbits look flatter, so
 * Mars's and Neptune's orbits still fit). Near Earth: 0.03 au ≈ 12 LD, so the Moon's orbit shows.
 */
const VIEW_RADIUS: Record<ViewId, number> = { inner: 1.5, outer: 25, earth: 0.03 };
const DOT: Partial<Record<BodyId, number>> = { sun: 14, earth: 9, moon: 6 };
const PLANET_DOT = 8;
const AST_DOT = 6;

const POINT_VERT = /* glsl */ `
attribute float size;
attribute vec3 color;
attribute float alpha;
uniform float dpr;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = color;
  vAlpha = alpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * dpr;
}`;
// Round dot with a thin outline in the background colour, so overlapping dots stay distinct.
const POINT_FRAG = /* glsl */ `
uniform vec3 edge;
uniform float ring;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  if (r > 1.0) discard;
  float aa = 1.0 - smoothstep(0.82, 1.0, r);
  if (ring > 0.5) {
    gl_FragColor = vec4(vColor, aa * smoothstep(0.55, 0.66, r) * vAlpha);
  } else {
    gl_FragColor = vec4(mix(vColor, edge, smoothstep(0.5, 0.68, r)), aa * vAlpha);
  }
  // Colours are linear inside three.js; convert to sRGB so dots match the CSS palette exactly.
  #include <colorspace_fragment>
}`;

function pointsMaterial(dpr: number, ring = false): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { dpr: { value: dpr }, edge: { value: new Color() }, ring: { value: ring ? 1 : 0 } },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

function pointsGeometry(n: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("color", new BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("size", new BufferAttribute(new Float32Array(n), 1));
  g.setAttribute("alpha", new BufferAttribute(new Float32Array(n).fill(1), 1));
  return g;
}

function lineGeometry(points: Vec3[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(points.flat()), 3));
  return g;
}

/** Update a line's points in place (no new GPU buffer per frame while time plays). */
function setLine(line: Line, points: Vec3[]) {
  const attr = line.geometry.getAttribute("position") as BufferAttribute | undefined;
  if (!attr || attr.count !== points.length) {
    line.geometry.dispose();
    line.geometry = lineGeometry(points);
    return;
  }
  points.forEach((p, k) => attr.setXYZ(k, p[0], p[1], p[2]));
  attr.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

/** A "nice" scale-bar length (au) that is 60–150 px long at `auPerPx`. */
function niceScale(auPerPx: number): [number, string] {
  const candidates: [number, string][] = [
    [AU_PER_LD, "1 LD"], [5 * AU_PER_LD, "5 LD"], [0.05, "0.05 au"], [0.1, "0.1 au"], [0.25, "0.25 au"],
    [0.5, "0.5 au"], [1, "1 au"], [2, "2 au"], [5, "5 au"], [10, "10 au"], [20, "20 au"], [50, "50 au"],
  ];
  for (const c of candidates) if (c[0] / auPerPx >= 60) return c;
  return candidates[candidates.length - 1]!;
}

export function createOrrery(opts: OrreryOptions): Orrery {
  const { container, asteroids } = opts;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: "default" });
  renderer.setPixelRatio(dpr);
  const canvas = renderer.domElement;
  canvas.className = "orrery-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const labelLayer = document.createElement("div");
  labelLayer.className = "orrery-labels";
  labelLayer.setAttribute("aria-hidden", "true");
  container.append(canvas, labelLayer);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1e-6, 1e4);
  camera.up.set(0, 0, 1); // ecliptic north is up
  camera.position.set(0, -3.2, 3.2);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = !opts.reducedMotion;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.8;
  controls.minDistance = 0.00025; // ~37,000 km: Earth (6,378 km radius) stays outside the camera
  controls.maxDistance = 160;
  controls.zoomSpeed = 2; // the range is huge: 0.00025 au to 160 au
  scene.add(new AmbientLight(0xffffff, 0.35));
  const sunLight = new PointLight(0xffffff, 2.2, 0, 0);
  scene.add(sunLight);

  /* ---------- Objects */

  const planetBodies = BODIES.filter((b) => b.planet);
  const planetOrbitMat = new LineBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false });
  const planetOrbits = planetBodies.map((b) => {
    const line = new LineLoop(new BufferGeometry(), planetOrbitMat);
    line.renderOrder = 1;
    scene.add(line);
    return { body: b, line };
  });
  let orbitsJd = NaN;

  const withOrbit = asteroids.filter((a) => a.orbit);
  const astOrbitSegs: number[] = [];
  for (const a of withOrbit) {
    const path = orbitPath(a.orbit!, 160, 200);
    for (let k = 0; k < path.length - 1; k++) astOrbitSegs.push(...path[k]!, ...path[k + 1]!);
  }
  const astOrbitGeom = new BufferGeometry();
  astOrbitGeom.setAttribute("position", new BufferAttribute(new Float32Array(astOrbitSegs), 3));
  const astOrbitMat = new LineBasicMaterial({ transparent: true, opacity: 0.07, depthTest: false });
  const astOrbits = new LineSegments(astOrbitGeom, astOrbitMat);
  astOrbits.renderOrder = 1;
  scene.add(astOrbits);

  const selOrbitMat = new LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false });
  const selOrbit = new Line(new BufferGeometry(), selOrbitMat);
  selOrbit.renderOrder = 2;
  scene.add(selOrbit);
  const trackMat = new LineDashedMaterial({ transparent: true, opacity: 0.95, depthTest: false, dashSize: 1, gapSize: 1 });
  const track = new Line(new BufferGeometry(), trackMat);
  track.renderOrder = 2;
  scene.add(track);
  const trackTicks = new Points(pointsGeometry(64), pointsMaterial(dpr));
  trackTicks.renderOrder = 3;
  scene.add(trackTicks);

  const moonOrbitMat = new LineBasicMaterial({ transparent: true, opacity: 0.6, depthTest: false });
  const moonOrbit = new Line(new BufferGeometry(), moonOrbitMat);
  moonOrbit.renderOrder = 1;
  scene.add(moonOrbit);
  // The CNEOS "close approach" limit, 0.05 au, as a ring around Earth in the ecliptic plane.
  const ringPts: Vec3[] = Array.from({ length: 129 }, (_, k) => {
    const t = (k / 128) * 2 * Math.PI;
    return [0.05 * Math.cos(t), 0.05 * Math.sin(t), 0];
  });
  const limitMat = new LineDashedMaterial({ transparent: true, opacity: 0.5, depthTest: false, dashSize: 0.002, gapSize: 0.0015 });
  const limitRing = new Line(lineGeometry(ringPts), limitMat);
  limitRing.computeLineDistances();
  limitRing.renderOrder = 1;
  scene.add(limitRing);

  const sphereGeom = new SphereGeometry(1, 32, 16);
  const spheres = new Map<BodyId, Mesh>();
  for (const b of BODIES) {
    const mat: Material = b.id === "sun" ? new MeshBasicMaterial() : new MeshLambertMaterial();
    const m = new Mesh(sphereGeom, mat);
    m.scale.setScalar(b.radiusKm / KM_PER_AU);
    scene.add(m);
    spheres.set(b.id, m);
  }

  const bodyPoints = new Points(pointsGeometry(BODIES.length), pointsMaterial(dpr));
  bodyPoints.renderOrder = 5;
  bodyPoints.frustumCulled = false;
  scene.add(bodyPoints);
  const astPoints = new Points(pointsGeometry(asteroids.length), pointsMaterial(dpr));
  astPoints.renderOrder = 4;
  astPoints.frustumCulled = false;
  scene.add(astPoints);
  const selRing = new Points(pointsGeometry(1), pointsMaterial(dpr, true));
  selRing.renderOrder = 6;
  selRing.frustumCulled = false;
  scene.add(selRing);

  /* ---------- Theme */

  const colors = { bg: new Color(), ink: new Color(), ink2: new Color(), ink3: new Color(), axis: new Color(), sun: new Color(), earth: new Color(), ast: new Color(), pha: new Color() };
  function refreshTheme() {
    const v = (n: string) => new Color(cssVar(n, container) || "#888");
    colors.bg = v("--panel-2");
    colors.ink = v("--ink");
    colors.ink2 = v("--ink-2");
    colors.ink3 = v("--ink-3");
    colors.axis = v("--axis");
    colors.sun = v("--sun");
    colors.earth = v("--series-3");
    colors.ast = v("--series-1");
    colors.pha = v("--series-2");
    scene.background = colors.bg;
    planetOrbitMat.color = colors.axis;
    astOrbitMat.color = colors.ast;
    selOrbitMat.color = colors.ink;
    trackMat.color = colors.ink;
    moonOrbitMat.color = colors.ink3;
    limitMat.color = colors.ink3;
    for (const [id, m] of spheres) (m.material as MeshBasicMaterial).color = id === "sun" ? colors.sun : id === "earth" ? colors.earth : colors.ink2;
    for (const p of [bodyPoints, astPoints, selRing, trackTicks]) (p.material as ShaderMaterial).uniforms.edge!.value = colors.bg;
    const col = bodyPoints.geometry.getAttribute("color") as BufferAttribute;
    BODIES.forEach((b, k) => {
      const c = b.id === "sun" ? colors.sun : b.id === "earth" ? colors.earth : b.id === "moon" ? colors.ink3 : colors.ink2;
      col.setXYZ(k, c.r, c.g, c.b);
    });
    col.needsUpdate = true;
    const acol = astPoints.geometry.getAttribute("color") as BufferAttribute;
    asteroids.forEach((a, k) => {
      const c = a.approach.pha ? colors.pha : colors.ast;
      acol.setXYZ(k, c.r, c.g, c.b);
    });
    acol.needsUpdate = true;
    const rc = selRing.geometry.getAttribute("color") as BufferAttribute;
    rc.setXYZ(0, colors.ink.r, colors.ink.g, colors.ink.b);
    rc.needsUpdate = true;
    const tc = trackTicks.geometry.getAttribute("color") as BufferAttribute;
    for (let k = 0; k < tc.count; k++) tc.setXYZ(k, colors.ink.r, colors.ink.g, colors.ink.b);
    tc.needsUpdate = true;
    invalidate();
  }

  /* ---------- Labels (DOM, positioned each frame) */

  const labels = new Map<string, HTMLElement>();
  function label(id: string, text: string, cls = ""): HTMLElement {
    let el = labels.get(id);
    if (!el) {
      el = document.createElement("span");
      el.className = `orrery-label ${cls}`;
      el.textContent = text;
      labelLayer.append(el);
      labels.set(id, el);
    }
    return el;
  }

  /* ---------- State per frame */

  let positions = bodyPositions(opts.getState().jd);
  const astPos: (Vec3 | null)[] = asteroids.map(() => null);
  let lastJd = NaN, lastSel: string | null | undefined, lastTrackKey = "";
  let width = 1, height = 1;
  let active = false;
  let raf = 0;
  let follow: "sun" | "earth" = "sun";
  let transition: { t0: number; dur: number; fromT: Vector3; toT: Vector3; fromC: Vector3; toC: Vector3 } | null = null;
  const tmp = new Vector3();

  function selectedAsteroid(sel: string | null) {
    return sel ? asteroids.findIndex((a) => a.des === sel) : -1;
  }

  function followPoint(): Vector3 {
    const p = follow === "earth" ? positions.earth : positions.sun;
    return new Vector3(p[0], p[1], p[2]);
  }

  function updateWorld(st: SceneState) {
    positions = bodyPositions(st.jd);
    // Planet orbits drift slowly (Table 1 rates are per century): rebuild after ~5 years.
    if (!(Math.abs(st.jd - orbitsJd) < 1800)) {
      orbitsJd = st.jd;
      for (const { body, line } of planetOrbits) {
        line.geometry.dispose();
        line.geometry = lineGeometry(orbitPath(planetElements(body.planet!, st.jd), 256));
      }
    }
    const bp = bodyPoints.geometry.getAttribute("position") as BufferAttribute;
    BODIES.forEach((b, k) => {
      const p = positions[b.id];
      bp.setXYZ(k, p[0], p[1], p[2]);
      spheres.get(b.id)!.position.set(p[0], p[1], p[2]);
    });
    bp.needsUpdate = true;
    const ap = astPoints.geometry.getAttribute("position") as BufferAttribute;
    const aa = astPoints.geometry.getAttribute("alpha") as BufferAttribute;
    asteroids.forEach((a, k) => {
      const p = asteroidPosition(a, st.jd);
      astPos[k] = p;
      if (p) ap.setXYZ(k, p[0], p[1], p[2]);
      // Already past its close approach at the displayed time: faded, like the 2D chart.
      aa.setX(k, a.caMs < st.ms ? 0.45 : 1);
    });
    ap.needsUpdate = true;
    aa.needsUpdate = true;

    const si = selectedAsteroid(st.selected);
    if (st.selected !== lastSel) {
      lastSel = st.selected;
      selOrbit.geometry.dispose();
      selOrbit.geometry = si >= 0 && asteroids[si]!.orbit ? lineGeometry(orbitPath(asteroids[si]!.orbit!, 400, 200)) : new BufferGeometry();
    }
    // Moon's orbit and the selected asteroid's path *relative to Earth*, drawn around Earth.
    setLine(moonOrbit, moonTrack(st.jd, positions.earth));
    limitRing.position.set(positions.earth[0], positions.earth[1], positions.earth[2]);
    const a = si >= 0 ? asteroids[si]! : null;
    const key = a ? `${a.des}:${st.jd.toFixed(4)}` : "";
    if (key !== lastTrackKey) {
      lastTrackKey = key;
      const tp = trackTicks.geometry.getAttribute("position") as BufferAttribute;
      const ts = trackTicks.geometry.getAttribute("size") as BufferAttribute;
      ts.array.fill(0);
      if (a?.orbit) {
        // From 3 days before the earlier of (now shown, closest approach) to 3 days after the later.
        const lo = Math.min(st.ms, a.caMs) - 3 * 86_400_000, hi = Math.max(st.ms, a.caMs) + 3 * 86_400_000;
        const span = Math.min(30 * 86_400_000, hi - lo);
        const center = Math.min(Math.max((lo + hi) / 2, a.caMs - span / 2 + 3 * 86_400_000), a.caMs + span / 2 - 3 * 86_400_000);
        const days = span / 2 / 86_400_000;
        setLine(track, geocentricTrack(a, center, days, 360, positions.earth));
        track.computeLineDistances();
        // Ticks at whole UTC days.
        const firstDay = Math.ceil((center - span / 2) / 86_400_000) * 86_400_000;
        let n = 0;
        for (let t = firstDay; t <= center + span / 2 && n < tp.count; t += 86_400_000, n++) {
          const p = geocentricTrack(a, t, 0, 0, positions.earth)[0]!;
          tp.setXYZ(n, p[0], p[1], p[2]);
          ts.setX(n, 3.5);
        }
      } else {
        track.geometry.dispose();
        track.geometry = new BufferGeometry();
      }
      tp.needsUpdate = true;
      ts.needsUpdate = true;
    }
  }

  function project(p: Vec3 | Vector3): { x: number; y: number; front: boolean } {
    tmp.set(p instanceof Vector3 ? p.x : p[0], p instanceof Vector3 ? p.y : p[1], p instanceof Vector3 ? p.z : p[2]);
    tmp.applyMatrix4(camera.matrixWorldInverse);
    const front = tmp.z < 0;
    tmp.applyMatrix4(camera.projectionMatrix);
    return { x: ((tmp.x + 1) / 2) * width, y: ((1 - tmp.y) / 2) * height, front };
  }

  /** Pixels per au at the distance of `p` from the camera. */
  function pxPerAu(dist: number): number {
    return height / 2 / (Math.tan((FOV * Math.PI) / 360) * dist);
  }

  function frame() {
    raf = 0;
    if (!active) return;
    const st = opts.getState();
    if (st.jd !== lastJd || st.selected !== lastSel) {
      updateWorld(st);
      lastJd = st.jd;
    }

    // Follow Earth (near-Earth view) or stay on the Sun; camera moves with its target.
    const fp = followPoint();
    if (transition) {
      const k = Math.min(1, (performance.now() - transition.t0) / transition.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      controls.target.lerpVectors(transition.fromT, transition.toT, e);
      camera.position.lerpVectors(transition.fromC, transition.toC, e);
      // The destination keeps following Earth while the move runs.
      const drift = fp.clone().sub(transition.toT);
      transition.toT.add(drift);
      transition.toC.add(drift);
      if (k >= 1) transition = null;
    } else {
      const d = fp.clone().sub(controls.target);
      if (d.lengthSq() > 0) {
        controls.target.add(d);
        camera.position.add(d);
      }
    }
    const moving = controls.update();

    const camDist = camera.position.distanceTo(controls.target);
    camera.near = Math.max(1e-7, camDist * 1e-3);
    camera.far = camDist * 1e3 + 200;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // Dots shrink away when the true-size sphere is larger than the dot (zoomed right in).
    const bs = bodyPoints.geometry.getAttribute("size") as BufferAttribute;
    BODIES.forEach((b, k) => {
      const p = positions[b.id];
      const dist = camera.position.distanceTo(tmp.set(p[0], p[1], p[2]));
      const sphPx = (b.radiusKm / KM_PER_AU) * pxPerAu(dist);
      const dot = DOT[b.id] ?? PLANET_DOT;
      bs.setX(k, sphPx * 2 > dot * 0.8 ? 0 : dot);
    });
    bs.needsUpdate = true;
    const as = astPoints.geometry.getAttribute("size") as BufferAttribute;
    const si = selectedAsteroid(st.selected);
    asteroids.forEach((a, k) => as.setX(k, !astPos[k] ? 0 : k === si ? AST_DOT + 3 : a.approach.pha ? AST_DOT + 1 : AST_DOT));
    as.needsUpdate = true;
    const rs = selRing.geometry.getAttribute("size") as BufferAttribute;
    const sp = si >= 0 ? astPos[si] : null;
    if (sp) (selRing.geometry.getAttribute("position") as BufferAttribute).setXYZ(0, sp[0], sp[1], sp[2]);
    selRing.geometry.getAttribute("position").needsUpdate = true;
    rs.setX(0, sp ? 22 : 0);
    rs.needsUpdate = true;

    // Earth-scale overlays only when they'd be visible: Moon orbit ≥ 10 px, 0.05 au ring ≥ 30 px.
    const e = positions.earth;
    const earthPx = pxPerAu(camera.position.distanceTo(tmp.set(e[0], e[1], e[2])));
    moonOrbit.visible = AU_PER_LD * earthPx > 10;
    limitRing.visible = 0.05 * earthPx > 30 && 0.05 * earthPx < 4 * height;
    track.visible = trackTicks.visible = si >= 0 && 0.01 * earthPx > 4;
    limitMat.dashSize = 6 / earthPx;
    limitMat.gapSize = 4 / earthPx;
    trackMat.dashSize = 7 / earthPx;
    trackMat.gapSize = 3 / earthPx;
    selOrbit.visible = si >= 0;
    selOrbitMat.opacity = track.visible ? 0.35 : 0.9;

    renderer.render(scene, camera);
    placeLabels(st, si, earthPx);

    const [len, text] = niceScale(1 / pxPerAu(camDist));
    opts.onScale(text, len * pxPerAu(camDist));
    if (moving || transition) invalidate();
  }

  function placeLabels(st: SceneState, si: number, earthPx: number) {
    const placed: [number, number, number, number][] = [];
    const want: { id: string; text: string; p: Vec3; cls: string; dot: number }[] = [];
    if (si >= 0 && astPos[si]) want.push({ id: `a:${asteroids[si]!.des}`, text: asteroids[si]!.label, p: astPos[si]!, cls: "is-selected", dot: 11 });
    // Earth first, then the Sun and planets outwards: the most useful labels win any overlap.
    const order = BODIES.filter((b) => b.id === "earth").concat(BODIES.filter((b) => b.id !== "earth"));
    for (const b of order) {
      if (b.id === "moon" && AU_PER_LD * earthPx < 22) continue; // Moon sits on Earth's dot
      want.push({ id: b.id, text: b.name, p: positions[b.id], cls: b.id === "earth" ? "is-earth" : "", dot: (DOT[b.id] ?? PLANET_DOT) / 2 });
    }
    const seen = new Set<string>();
    for (const w of want) {
      const s = project(w.p);
      const el = label(w.id, w.text, w.cls);
      seen.add(w.id);
      const wPx = w.text.length * 6.6 + 6, hPx = 15;
      // Right of the dot, or left of it when that would run off the edge.
      let x = s.x + w.dot + 4;
      if (x + wPx > width) x = s.x - w.dot - 4 - wPx;
      const y = s.y - hPx / 2;
      const off = !s.front || s.x < -20 || s.y < -20 || s.x > width + 20 || s.y > height + 20;
      const overlap = placed.some(([px, py, pw, ph]) => x < px + pw && x + wPx > px && y < py + ph && y + hPx > py);
      if (off || overlap || x < 0) {
        el.hidden = true;
        continue;
      }
      placed.push([x, y, wPx, hPx]);
      el.hidden = false;
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    for (const [id, el] of labels) if (!seen.has(id)) el.hidden = true;
  }

  function invalidate() {
    if (!raf && active) raf = requestAnimationFrame(frame);
  }

  /* ---------- Camera presets */

  function goTo(view: ViewId, animate = !opts.reducedMotion) {
    follow = view === "earth" ? "earth" : "sun";
    controls.enablePan = view !== "earth";
    const toT = followPoint();
    const aspect = width / height;
    const dist = (VIEW_RADIUS[view] / (Math.tan((FOV * Math.PI) / 360) * Math.min(1, aspect))) * 1.08;
    // Keep the current viewing direction unless it is nearly edge-on; then look from 40° above.
    const dir = camera.position.clone().sub(controls.target).normalize();
    if (!(Math.abs(dir.z) > 0.25) || !Number.isFinite(dir.x)) dir.set(0, -Math.cos(0.7), Math.sin(0.7));
    const toC = toT.clone().add(dir.multiplyScalar(dist));
    if (!animate) {
      transition = null;
      controls.target.copy(toT);
      camera.position.copy(toC);
    } else {
      transition = { t0: performance.now(), dur: 700, fromT: controls.target.clone(), toT, fromC: camera.position.clone(), toC };
    }
    invalidate();
  }

  /* ---------- Input: tap/click to select, hover for names */

  function nearest(clientX: number, clientY: number, radius: number): string | null {
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let best: string | null = null, bestD = radius * radius;
    const test = (id: string, p: Vec3 | null, bias = 0) => {
      if (!p) return;
      const s = project(p);
      if (!s.front) return;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2 - bias;
      if (d < bestD) [best, bestD] = [id, d];
    };
    asteroids.forEach((a, k) => test(`a:${a.des}`, astPos[k]!, 4));
    for (const b of BODIES) test(b.id, positions[b.id]);
    return best;
  }

  let down: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener("pointerdown", (ev) => (down = { x: ev.clientX, y: ev.clientY, t: performance.now() }));
  canvas.addEventListener("pointerup", (ev) => {
    if (!down) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 6 || !quick) return;
    const id = nearest(ev.clientX, ev.clientY, ev.pointerType === "touch" ? 26 : 16);
    if (id) opts.onPick(id);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerType !== "mouse" || ev.buttons) return;
    const id = nearest(ev.clientX, ev.clientY, 12);
    canvas.style.cursor = id ? "pointer" : "";
    opts.onHover(id, ev.clientX, ev.clientY);
  });
  canvas.addEventListener("pointerleave", () => opts.onHover(null, 0, 0));
  controls.addEventListener("change", invalidate);
  controls.addEventListener("start", () => {
    transition = null;
    opts.onHover(null, 0, 0);
  });

  canvas.addEventListener("webglcontextlost", (ev) => {
    ev.preventDefault();
    active = false;
    opts.onContextLost();
  });

  const ro = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    invalidate();
  });
  ro.observe(container);
  {
    const r = container.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
  }

  refreshTheme();

  return {
    invalidate,
    setActive(on) {
      if (on === active) return;
      active = on;
      if (on) invalidate();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    goTo,
    refreshTheme,
    destroy() {
      active = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as Material | Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      labelLayer.remove();
    },
  };
}
