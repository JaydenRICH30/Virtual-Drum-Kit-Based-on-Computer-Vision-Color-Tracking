import * as THREE from "./vendor/three/three.module.min.js";
import { FilesetResolver, HandLandmarker } from "./vendor/mediapipe/vision_bundle.mjs";

const DRUMS = {
  HiHat: { label: "HI-HAT", audio: "HiHat.mp3", midi: [42, 44, 46] },
  Crash: { label: "CRASH", audio: "Crash.mp3", midi: [49, 55, 57] },
  MountedTom: { label: "TOM", audio: "MountedTom.mp3", midi: [45, 47, 48, 50] },
  Snare: { label: "SNARE", audio: "Snare.mp3", midi: [37, 38, 40] },
  BassDrum: { label: "KICK", audio: "BassDrum.mp3", midi: [35, 36] },
};

const elements = {
  video: document.querySelector("#video"),
  trackingCanvas: document.querySelector("#trackingCanvas"),
  threeCanvas: document.querySelector("#threeCanvas"),
  stageViewport: document.querySelector("#stageViewport"),
  cameraButton: document.querySelector("#cameraButton"),
  midiButton: document.querySelector("#midiButton"),
  resetButton: document.querySelector("#resetButton"),
  cameraStatus: document.querySelector("#cameraStatus"),
  midiStatus: document.querySelector("#midiStatus"),
  audioStatus: document.querySelector("#audioStatus"),
  cameraMessage: document.querySelector("#cameraMessage"),
  cameraDevice: document.querySelector("#cameraDevice"),
  markerReadout: document.querySelector("#markerReadout"),
  modeLabel: document.querySelector("#modeLabel"),
  stageHint: document.querySelector("#stageHint"),
  fpsReadout: document.querySelector("#fpsReadout"),
  latencyReadout: document.querySelector("#latencyReadout"),
  impactRipple: document.querySelector("#impactRipple"),
  hitCounter: document.querySelector("#hitCounter"),
  lastInstrument: document.querySelector("#lastInstrument"),
  detectionStatus: document.querySelector("#detectionStatus"),
  handsReadout: document.querySelector("#handsReadout"),
  audioReadout: document.querySelector("#audioReadout"),
  modeButtons: [...document.querySelectorAll("[data-mode]")],
};

const trackingContext = elements.trackingCanvas.getContext("2d");

const state = {
  stream: null,
  cameraStarting: false,
  colorTask: null,
  inputMode: "hybrid",
  colorCandidates: [],
  colorSlots: [null, null],
  nextColorCandidateId: 1,
  latestColorMarkers: [],
  latestHandResults: null,
  latestHandResultsAt: -Infinity,
  handHistory: new Map(),
  pendingImpulses: [null, null],
  lastImpulseAt: [-Infinity, -Infinity],
  lastStrikeAt: [-Infinity, -Infinity],
  contactStates: [
    createContactState(),
    createContactState(),
  ],
  handLandmarker: null,
  handLandmarkerLoading: false,
  lastHandVideoTime: -1,
  midiAccess: null,
  hitCount: 0,
};

const HYBRID_CONFIG = {
  zAccelerationThreshold: 1.4,
  zSpeedThreshold: 0.06,
  fusionWindowMs: 95,
  markerFreshnessMs: 85,
  strikeRefractoryMs: 70,
  impulseRefractoryMs: 65,
  releaseFrames: 1,
  minDownwardStep: 0.0025,
  minDownwardSpeed: 0.055,
  downwardDominance: 1.0,
};

function createContactState() {
  return {
    inside: false,
    fired: false,
    downwardEntry: false,
    outsideFrames: 0,
    hit: null,
    entryDrum: null,
    lastX: null,
    lastY: null,
    lastAt: null,
  };
}

function setStatus(element, text, status = "idle") {
  element.lastChild.textContent = text;
  element.dataset.state = status;
}

function readableCameraError(error) {
  if (error?.name === "NotAllowedError" && /system/i.test(error?.message || "")) {
    return "This browser session cannot use the camera. Open this local address in Edge or Chrome, allow camera access, and retry.";
  }
  if (error?.name === "NotAllowedError") return "Camera permission is blocked. Allow camera access for this local site and retry.";
  if (error?.name === "NotFoundError") return "No camera was detected by this browser.";
  if (error?.name === "NotReadableError") return "The camera is busy. Close other video apps and retry.";
  if (error?.name === "OverconstrainedError") return "The selected camera cannot provide the requested video mode.";
  return `Camera error: ${error?.message || "Unknown error"}`;
}

class AudioEngine {
  constructor() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = AudioContextClass ? new AudioContextClass({ latencyHint: "interactive" }) : null;
    this.buffers = new Map();
    this.master = this.context?.createGain() || null;
    if (this.master) {
      this.master.gain.value = 0.92;
      this.master.connect(this.context.destination);
    }
  }

  async load() {
    if (!this.context) throw new Error("Web Audio API is unavailable.");
    await Promise.all(Object.entries(DRUMS).map(async ([name, drum]) => {
      const response = await fetch(`assets/audio/${drum.audio}`);
      if (!response.ok) throw new Error(`Unable to load ${drum.audio}`);
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    }));
    setStatus(elements.audioStatus, "Audio ready", "ready");
    elements.audioReadout.textContent = "Ready";
  }

  async resume() {
    if (this.context?.state === "suspended") await this.context.resume();
  }

  play(name, velocity = 1) {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.context || !this.master) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    gain.gain.value = THREE.MathUtils.clamp(velocity, 0.18, 1.15);
    source.buffer = buffer;
    source.connect(gain).connect(this.master);
    source.start(this.context.currentTime);
  }
}

class DrumKit3D {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x1b2b3d, 0.027);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    this.camera.position.set(0, 5.4, 12.6);
    this.camera.lookAt(0, 0.75, 0);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hitMeshes = [];
    this.instruments = new Map();
    this.effects = new Map();
    this.frameSamples = [];
    this.lastFrame = performance.now();
    this.parallax = { x: 0, y: 0 };
    this.trackingPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2.55);
    this.trackingIndicators = [];

    this.buildEnvironment();
    this.buildKit();
    this.buildTrackingIndicators();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    container.addEventListener("pointermove", (event) => {
      const bounds = container.getBoundingClientRect();
      this.parallax.x = (event.clientX - bounds.left) / bounds.width - 0.5;
      this.parallax.y = (event.clientY - bounds.top) / bounds.height - 0.5;
    });
    container.addEventListener("pointerleave", () => { this.parallax.x = 0; this.parallax.y = 0; });
    this.resize();
    this.renderer.setAnimationLoop((time) => this.render(time));
  }

  buildEnvironment() {
    const hemisphere = new THREE.HemisphereLight(0xc9e5ff, 0x34465a, 1.62);
    this.scene.add(hemisphere);

    const key = new THREE.SpotLight(0xe3f4ff, 68, 35, Math.PI / 5, 0.55, 1.5);
    key.position.set(-5, 10, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);

    const rim = new THREE.SpotLight(0xb7f32b, 44, 28, Math.PI / 4, 0.8, 1.4);
    rim.position.set(6, 7, -5);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(8.4, 96),
      new THREE.MeshStandardMaterial({ color: 0x293b4e, roughness: 0.9, metalness: 0.06 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.03;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.8, 4.84, 96),
      new THREE.MeshBasicMaterial({ color: 0x7fa5c7, transparent: true, opacity: 0.62, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.006;
    this.scene.add(ring);

    const grid = new THREE.GridHelper(15, 30, 0x6f8da8, 0x354b60);
    grid.position.y = 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.38;
    this.scene.add(grid);
  }

  metalMaterial(color = 0x7d8796, roughness = 0.24) {
    return new THREE.MeshStandardMaterial({ color, metalness: 0.86, roughness });
  }

  addStand(x, y, z, height = 2.1, arm = 0) {
    const material = this.metalMaterial(0x616c7a, 0.3);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, height, 12), material);
    pole.position.set(x, y + height / 2, z);
    pole.castShadow = true;
    this.scene.add(pole);
    if (arm) {
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, arm, 10), material);
      boom.rotation.z = Math.PI / 2.7;
      boom.position.set(x + arm * 0.34, y + height - 0.06, z);
      this.scene.add(boom);
    }
  }

  addDrum(name, options) {
    const { position, radius, depth, color, rotation = [0, 0, 0] } = options;
    const group = new THREE.Group();
    group.position.set(...position);
    group.rotation.set(...rotation);

    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, depth, 64, 1, false),
      new THREE.MeshPhysicalMaterial({ color, metalness: 0.58, roughness: 0.24, clearcoat: 0.72, clearcoatRoughness: 0.2 }),
    );
    shell.castShadow = true;
    shell.receiveShadow = true;
    group.add(shell);

    const rimMaterial = this.metalMaterial(0x9ca6b3, 0.2);
    for (const y of [-depth / 2, depth / 2]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.96, 0.045, 12, 64), rimMaterial);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = y;
      group.add(rim);
    }

    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.94, radius * 0.94, 0.055, 64),
      new THREE.MeshPhysicalMaterial({ color: 0xe2e6e9, transparent: true, opacity: 0.84, roughness: 0.66, metalness: 0.05 }),
    );
    head.position.y = depth / 2 + 0.03;
    head.userData.drumName = name;
    group.add(head);
    this.hitMeshes.push(head);
    this.scene.add(group);
    this.instruments.set(name, { group, target: head, type: "drum", baseRotation: group.rotation.clone() });
    this.effects.set(name, 0);
    this.addLabel(DRUMS[name].label, group, 0, radius + 0.42, 0);
    return group;
  }

  addKick() {
    const group = new THREE.Group();
    group.position.set(0, 0.96, 1.12);
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(1.32, 1.32, 1.36, 72),
      new THREE.MeshPhysicalMaterial({ color: 0x141c28, metalness: 0.62, roughness: 0.23, clearcoat: 0.7 }),
    );
    shell.rotation.x = Math.PI / 2;
    shell.castShadow = true;
    group.add(shell);
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(1.24, 72),
      new THREE.MeshPhysicalMaterial({ color: 0x1e2937, roughness: 0.72, metalness: 0.08, clearcoat: 0.2 }),
    );
    face.position.z = 0.695;
    face.userData.drumName = "BassDrum";
    group.add(face);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.27, 0.062, 14, 72), this.metalMaterial());
    ring.position.z = 0.715;
    group.add(ring);
    this.hitMeshes.push(face);
    this.scene.add(group);
    this.instruments.set("BassDrum", { group, target: face, type: "kick", baseRotation: group.rotation.clone() });
    this.effects.set("BassDrum", 0);
    this.addLabel("KICK", group, 0, 0.05, 0.7);
  }

  addCymbal(name, options) {
    const { position, radius, color = 0xb68a28, tilt = 0, labelPosition = [0, radius + 0.35, 0] } = options;
    const group = new THREE.Group();
    group.position.set(...position);
    group.rotation.z = tilt;
    const cymbal = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.22, radius, 0.075, 72),
      new THREE.MeshPhysicalMaterial({ color, metalness: 0.92, roughness: 0.23, clearcoat: 0.42, side: THREE.DoubleSide }),
    );
    cymbal.userData.drumName = name;
    cymbal.castShadow = true;
    group.add(cymbal);
    const bell = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.2, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.metalMaterial(0xd0a744, 0.18));
    bell.position.y = 0.04;
    group.add(bell);
    this.hitMeshes.push(cymbal);
    this.scene.add(group);
    this.instruments.set(name, { group, target: cymbal, type: "cymbal", baseRotation: group.rotation.clone() });
    this.effects.set(name, 0);
    this.addLabel(DRUMS[name].label, group, ...labelPosition);
  }

  addLabel(text, parent, x, y, z) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    context.font = "700 24px Segoe UI, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "rgba(235,241,248,.88)";
    context.fillText(text, 128, 32);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.scale.set(1.45, 0.36, 1);
    sprite.position.set(x, y, z);
    parent.add(sprite);
  }

  buildKit() {
    this.addKick();
    this.addDrum("Snare", { position: [-1.82, 1.28, 0.96], radius: 0.9, depth: 0.52, color: 0xa7b0bd, rotation: [0.02, 0, -0.05] });
    this.addDrum("MountedTom", { position: [0.68, 2.38, 0.18], radius: 0.82, depth: 0.82, color: 0x253b55, rotation: [0.21, 0, 0.05] });
    this.addCymbal("HiHat", { position: [-3.32, 2.28, 0.52], radius: 1.08, tilt: 0.04, color: 0xc69a32 });
    this.addCymbal("Crash", {
      position: [3.08, 3.42, -0.2],
      radius: 1.43,
      tilt: -0.12,
      color: 0xc19a3d,
      labelPosition: [0.2, 0.62, 0.12],
    });
    this.addStand(-3.32, 0, 0.52, 2.22);
    this.addStand(2.68, 0, -0.2, 3.08, 1.18);
    this.addStand(-1.82, 0, 0.96, 1.22);

    const pedal = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.06, 0.78),
      new THREE.MeshStandardMaterial({ color: 0x303a48, metalness: 0.7, roughness: 0.35 }),
    );
    pedal.position.set(0, 0.08, 2.78);
    pedal.rotation.x = -0.14;
    pedal.castShadow = true;
    this.scene.add(pedal);
  }

  trackingMaterial(materials, options) {
    const material = new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0, ...options });
    materials.push(material);
    return material;
  }

  buildTrackingIndicator(index) {
    const materials = [];
    const group = new THREE.Group();
    group.visible = false;
    group.renderOrder = 20 + index;

    const stick = new THREE.Group();
    // First-person layout: the tracked blue tip stays at the impact point while
    // each shortened handle angles down toward the player's left or right hand.
    stick.rotation.z = index ? 0.44 : -0.44;
    stick.scale.setScalar(0.5);
    const wood = this.trackingMaterial(materials, { color: index ? 0xd69b5a : 0xc78648, roughness: 0.36, metalness: 0.03, clearcoat: 0.18, depthTest: false });
    const grip = this.trackingMaterial(materials, { color: index ? 0x44342e : 0x3a2b27, roughness: 0.7, metalness: 0.02, depthTest: false });
    const collarMaterial = this.trackingMaterial(materials, { color: 0xbadfff, emissive: 0x1766a5, emissiveIntensity: 0.65, roughness: 0.24, metalness: 0.42, depthTest: false });
    const blue = this.trackingMaterial(materials, { color: index ? 0x55b8ff : 0x348cff, emissive: index ? 0x168cff : 0x125dff, emissiveIntensity: 1.55, roughness: 0.18, metalness: 0.08, clearcoat: 0.72, clearcoatRoughness: 0.16, depthTest: false });
    const highlight = new THREE.MeshBasicMaterial({ color: 0xd9f3ff, transparent: true, opacity: 0, depthWrite: false, depthTest: false });
    const blueGlow = new THREE.MeshBasicMaterial({ color: 0x289cff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    materials.push(highlight);
    materials.push(blueGlow);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.054, 0.076, 0.9, 24), wood);
    shaft.position.y = -0.61;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.077, 0.088, 0.3, 24), grip);
    handle.position.y = -1.21;
    const butt = new THREE.Mesh(new THREE.SphereGeometry(0.088, 20, 12), grip);
    butt.scale.y = 0.62;
    butt.position.y = -1.38;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.064, 0.16, 24), collarMaterial);
    collar.position.y = -0.16;
    const tip = new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.16, 8, 24), blue);
    tip.position.y = 0.08;
    const tipHighlight = new THREE.Mesh(new THREE.SphereGeometry(0.052, 16, 10), highlight);
    tipHighlight.scale.set(0.62, 1.2, 0.38);
    tipHighlight.position.set(-0.055, 0.18, 0.12);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.29, 28, 18), blueGlow);
    glow.scale.y = 1.18;
    glow.position.y = 0.08;
    stick.add(shaft, handle, butt, collar, tip, tipHighlight, glow);

    const handGroup = new THREE.Group();
    const hand = this.trackingMaterial(materials, { color: index ? 0x79e5ff : 0x53d8ff, emissive: 0x127898, emissiveIntensity: 0.75, roughness: 0.32, depthTest: false });
    const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.62, 8, 16), hand);
    finger.position.y = 0.43;
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 16), hand);
    palm.scale.set(0.88, 1.16, 0.42);
    palm.position.set(index ? -0.12 : 0.12, 1.05, 0);
    const fingertip = new THREE.Mesh(new THREE.SphereGeometry(0.155, 24, 16), hand);
    handGroup.add(finger, palm, fingertip);

    const reticleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false });
    materials.push(reticleMaterial);
    const reticle = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.022, 10, 48), reticleMaterial);
    reticle.renderOrder = 30 + index;
    const light = new THREE.PointLight(index ? 0x36a2ff : 0x2f7bff, 0, 2.4, 2);
    group.add(stick, handGroup, reticle, light);
    this.scene.add(group);

    this.trackingIndicators.push({
      group,
      stick,
      hand: handGroup,
      reticle,
      light,
      materials,
      point: new THREE.Vector3(),
      target: new THREE.Vector3(),
      lastSeen: -Infinity,
      opacity: 0,
    });
  }

  buildTrackingIndicators() {
    this.buildTrackingIndicator(0);
    this.buildTrackingIndicator(1);
  }

  updateTrackingIndicator(index, normalizedX, normalizedY, mode = "color") {
    const indicator = this.trackingIndicators[index];
    if (!indicator) return;
    const x = THREE.MathUtils.clamp(normalizedX, 0, 1);
    const y = THREE.MathUtils.clamp(normalizedY, 0, 1);
    this.pointer.set(x * 2 - 1, -(y * 2 - 1));
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.trackingPlane, indicator.target)) {
      this.raycaster.ray.at(10, indicator.target);
    }
    if (!indicator.group.visible) indicator.point.copy(indicator.target);
    indicator.group.visible = true;
    indicator.lastSeen = performance.now();
    indicator.stick.visible = mode === "color";
    indicator.hand.visible = mode === "hands";
    indicator.reticle.material.color.set(mode === "color" ? (index ? 0x89c7ff : 0x62a4ff) : (index ? 0x8cecff : 0x53d8ff));
    indicator.light.color.set(mode === "color" ? (index ? 0x36a2ff : 0x2f7bff) : 0x53d8ff);
  }

  clearTrackingIndicator(index = null) {
    if (index === null) {
      this.trackingIndicators.forEach((indicator) => { indicator.lastSeen = -Infinity; });
      return;
    }
    if (this.trackingIndicators[index]) this.trackingIndicators[index].lastSeen = -Infinity;
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  pick(normalizedX, normalizedY, includeKick = false) {
    this.pointer.set(normalizedX * 2 - 1, -(normalizedY * 2 - 1));
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersections = this.raycaster.intersectObjects(this.hitMeshes, false);
    const hit = intersections.find((item) => includeKick || item.object.userData.drumName !== "BassDrum");
    if (!hit) return null;
    const projected = hit.point.clone().project(this.camera);
    return {
      name: hit.object.userData.drumName,
      screenX: (projected.x + 1) / 2,
      screenY: (1 - projected.y) / 2,
    };
  }

  strike(name, strength = 1) {
    this.effects.set(name, Math.max(this.effects.get(name) || 0, THREE.MathUtils.clamp(strength, 0.35, 1.35)));
    const instrument = this.instruments.get(name);
    if (instrument) {
      const material = instrument.target.material;
      if (!material.userData.baseEmissive) material.userData.baseEmissive = material.emissive?.clone() || new THREE.Color(0x000000);
      if (material.emissive) material.emissive.set(0xb7f32b);
    }
  }

  render(time) {
    const delta = Math.min(0.05, Math.max(0.001, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    this.frameSamples.push(delta);
    if (this.frameSamples.length > 45) this.frameSamples.shift();

    this.camera.position.x += (this.parallax.x * 0.65 - this.camera.position.x) * 0.018;
    this.camera.position.y += (5.4 - this.parallax.y * 0.32 - this.camera.position.y) * 0.018;
    this.camera.lookAt(0, 0.78, 0);

    this.trackingIndicators.forEach((indicator, index) => {
      const trackingAge = performance.now() - indicator.lastSeen;
      const trackingTargetOpacity = trackingAge < 180 ? 1 : 0;
      indicator.opacity += (trackingTargetOpacity - indicator.opacity) * (trackingTargetOpacity ? 0.34 : 0.14);
      indicator.point.lerp(indicator.target, 0.36);
      indicator.group.position.copy(indicator.point);
      indicator.reticle.quaternion.copy(this.camera.quaternion);
      indicator.reticle.rotation.z = time * (index ? -0.0012 : 0.0014);
      const pulse = 1 + Math.sin(time * 0.012 + index * Math.PI) * 0.08;
      indicator.reticle.scale.setScalar(pulse);
      for (const material of indicator.materials) {
        material.opacity = indicator.opacity * (material === indicator.reticle.material ? 0.9 : material.blending === THREE.AdditiveBlending ? 0.23 : 0.92);
      }
      indicator.light.intensity = indicator.opacity * 2.8;
      if (indicator.opacity < 0.01 && trackingTargetOpacity === 0) indicator.group.visible = false;
    });

    for (const [name, instrument] of this.instruments) {
      const effect = this.effects.get(name) || 0;
      const eased = effect * effect;
      if (instrument.type === "cymbal") {
        instrument.group.rotation.x = Math.sin(time * 0.05) * eased * 0.12;
        instrument.group.rotation.z = instrument.baseRotation.z + Math.sin(time * 0.065) * eased * 0.09;
      } else if (instrument.type === "kick") {
        instrument.target.scale.setScalar(1 - eased * 0.04);
      } else {
        instrument.target.scale.set(1, 1 - eased * 0.18, 1);
        instrument.group.rotation.z = instrument.baseRotation.z + Math.sin(time * 0.07) * eased * 0.025;
      }
      if (instrument.target.material.emissive) {
        instrument.target.material.emissiveIntensity = eased * 0.9;
        if (effect < 0.01) instrument.target.material.emissive.copy(instrument.target.material.userData.baseEmissive || new THREE.Color());
      }
      this.effects.set(name, Math.max(0, effect - delta * 3.8));
    }

    this.renderer.render(this.scene, this.camera);
    if (this.frameSamples.length === 45 && Math.floor(time / 750) !== Math.floor((time - delta * 1000) / 750)) {
      const average = this.frameSamples.reduce((sum, value) => sum + value, 0) / this.frameSamples.length;
      elements.fpsReadout.textContent = `${Math.round(1 / average)} FPS`;
    }
  }
}

const audio = new AudioEngine();
const kit = new DrumKit3D(elements.threeCanvas, elements.stageViewport);

audio.load().catch((error) => {
  console.error(error);
  setStatus(elements.audioStatus, "Audio error", "error");
  elements.audioReadout.textContent = "Error";
});

function showRipple(hit) {
  if (!hit) return;
  elements.impactRipple.style.left = `${hit.screenX * 100}%`;
  elements.impactRipple.style.top = `${hit.screenY * 100}%`;
  elements.impactRipple.classList.remove("active");
  void elements.impactRipple.offsetWidth;
  elements.impactRipple.classList.add("active");
}

async function registerHit(name, source, hit = null, velocity = 1, detectedAt = performance.now()) {
  await audio.resume();
  audio.play(name, velocity);
  kit.strike(name, velocity);
  showRipple(hit);
  state.hitCount += 1;
  elements.hitCounter.textContent = `${state.hitCount} ${state.hitCount === 1 ? "hit" : "hits"}`;
  elements.lastInstrument.textContent = DRUMS[name].label;
  elements.latencyReadout.textContent = `${Math.max(0, Math.round(performance.now() - detectedAt))} ms · ${source}`;
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
}

function waitForMetadata(video, timeout = 7000) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The camera opened but returned no video metadata.")), timeout);
    video.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function startCamera() {
  if (state.cameraStarting) return;
  state.cameraStarting = true;
  elements.cameraButton.disabled = true;
  elements.cameraButton.textContent = "Starting camera…";
  setStatus(elements.cameraStatus, "Camera starting", "idle");
  elements.cameraMessage.textContent = "Requesting the integrated camera…";
  stopCamera();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 60, min: 30, max: 60 },
        facingMode: "user",
      },
      audio: false,
    });
    state.stream = stream;
    elements.video.srcObject = stream;
    await waitForMetadata(elements.video);
    await elements.video.play();
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    elements.cameraDevice.textContent = track.label || "Integrated Camera";
    setStatus(elements.cameraStatus, `Camera ${settings.width || elements.video.videoWidth}×${settings.height || elements.video.videoHeight}`, "ready");
    elements.cameraMessage.textContent = "Camera active. All vision processing stays inside this browser.";
    elements.cameraButton.textContent = "Restart camera";
    startColorTracking();
  } catch (error) {
    console.error(error);
    stopCamera();
    setStatus(elements.cameraStatus, "Camera error", "error");
    elements.cameraMessage.textContent = readableCameraError(error);
    elements.cameraButton.textContent = "Retry camera";
  } finally {
    state.cameraStarting = false;
    elements.cameraButton.disabled = false;
  }
}

window.tracking.ColorTracker.registerColor("blue", (red, green, blue) => {
  const strongestOtherChannel = Math.max(red, green);
  const weakestChannel = Math.min(red, green, blue);
  const chroma = blue - weakestChannel;
  return blue >= 65 && blue - strongestOtherChannel >= 24 && chroma / Math.max(blue, 1) >= 0.32;
});

const colorTracker = new window.tracking.ColorTracker(["blue"]);
colorTracker.setMinDimension(8);
colorTracker.setMinGroupSize(18);

function startColorTracking() {
  if (state.colorTask) return;
  state.colorTask = window.tracking.track(elements.video, colorTracker);
}

function sizeTrackingCanvas() {
  const width = Math.max(1, Math.round(elements.video.offsetWidth));
  const height = Math.max(1, Math.round(elements.video.offsetHeight));
  if (elements.trackingCanvas.width !== width || elements.trackingCanvas.height !== height) {
    elements.trackingCanvas.width = width;
    elements.trackingCanvas.height = height;
  }
  return { width, height };
}

function markerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function selectTrackedBlueMarkers(rectangles, width, height, timestamp) {
  const detections = rectangles.map((rectangle) => {
    const normalizedWidth = rectangle.width / width;
    const normalizedHeight = rectangle.height / height;
    return {
      rectangle,
      x: 1 - (rectangle.x + rectangle.width / 2) / width,
      y: (rectangle.y + rectangle.height / 2) / height,
      area: normalizedWidth * normalizedHeight,
      aspect: normalizedWidth / Math.max(normalizedHeight, 0.0001),
      size: Math.max(normalizedWidth, normalizedHeight),
    };
  }).filter((detection) => (
    detection.area >= 0.00012
    && detection.area <= 0.032
    && detection.size <= 0.24
    && detection.aspect >= 0.35
    && detection.aspect <= 2.8
  ));

  const availableCandidates = new Set(state.colorCandidates);
  const matchedCandidates = new Set();
  detections.sort((a, b) => b.area - a.area).forEach((detection) => {
    let bestCandidate = null;
    let bestDistance = Infinity;
    for (const candidate of availableCandidates) {
      const distance = markerDistance(detection, candidate);
      const areaRatio = Math.max(detection.area, candidate.area) / Math.max(Math.min(detection.area, candidate.area), 0.00001);
      if (distance < 0.16 && areaRatio < 4.2 && distance < bestDistance) {
        bestCandidate = candidate;
        bestDistance = distance;
      }
    }

    if (!bestCandidate) {
      bestCandidate = {
        id: state.nextColorCandidateId++,
        x: detection.x,
        y: detection.y,
        area: detection.area,
        frames: 0,
        motion: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
      };
      state.colorCandidates.push(bestCandidate);
    } else {
      availableCandidates.delete(bestCandidate);
      const movement = markerDistance(detection, bestCandidate);
      bestCandidate.motion = bestCandidate.motion * 0.82 + movement;
      bestCandidate.x = detection.x;
      bestCandidate.y = detection.y;
      bestCandidate.area = detection.area;
      bestCandidate.lastSeen = timestamp;
    }
    bestCandidate.frames += 1;
    bestCandidate.rectangle = detection.rectangle;
    matchedCandidates.add(bestCandidate);
  });

  state.colorCandidates = state.colorCandidates.filter((candidate) => timestamp - candidate.lastSeen < 420);
  const lockedIds = new Set(state.colorSlots.filter(Boolean).map((slot) => slot.id));
  const eligible = state.colorCandidates.filter((candidate) => (
    timestamp - candidate.lastSeen < 120
    && candidate.frames >= 3
    && (candidate.motion >= 0.015 || lockedIds.has(candidate.id))
  ));

  state.colorSlots = state.colorSlots.map((slot) => {
    if (!slot) return null;
    const candidate = eligible.find((item) => item.id === slot.id);
    return candidate || null;
  });

  const usedIds = new Set(state.colorSlots.filter(Boolean).map((slot) => slot.id));
  let referenceMarker = state.colorSlots.find(Boolean) || null;
  state.colorSlots = state.colorSlots.map((slot) => {
    if (slot) return slot;
    const replacement = eligible
      .filter((candidate) => {
        if (usedIds.has(candidate.id)) return false;
        if (!referenceMarker) return true;
        const areaRatio = Math.max(candidate.area, referenceMarker.area) / Math.max(Math.min(candidate.area, referenceMarker.area), 0.00001);
        return areaRatio <= 2.8;
      })
      .sort((a, b) => (b.motion + b.frames * 0.001) - (a.motion + a.frames * 0.001))[0] || null;
    if (replacement) {
      usedIds.add(replacement.id);
      referenceMarker ||= replacement;
    }
    return replacement;
  });

  return state.colorSlots.map((candidate, slot) => candidate ? { ...candidate, slot } : null).filter(Boolean);
}

function drawColorMarkers(markers, width, height) {
  for (const marker of markers) {
    const { rectangle } = marker;
    trackingContext.strokeStyle = marker.slot ? "#79c5ff" : "#2f7bff";
    trackingContext.fillStyle = marker.slot ? "rgba(121,197,255,.17)" : "rgba(47,123,255,.16)";
    trackingContext.lineWidth = 3;
    trackingContext.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    trackingContext.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  }
}

function renderTrackingOverlay() {
  const { width, height } = sizeTrackingCanvas();
  trackingContext.clearRect(0, 0, width, height);
  drawColorMarkers(state.latestColorMarkers, width, height);
  if (state.latestHandResults) drawHands(state.latestHandResults, width, height);
}

function associateHandsWithMarkers(results) {
  const hands = results.landmarks || [];
  const pairs = [];
  hands.forEach((landmarks, handIndex) => {
    const anchor = landmarks[8] || landmarks[9] || landmarks[0];
    state.latestColorMarkers.forEach((marker) => {
      pairs.push({
        handIndex,
        marker,
        distance: Math.hypot(1 - anchor.x - marker.x, anchor.y - marker.y),
      });
    });
  });

  const assignments = new Map();
  const usedHands = new Set();
  const usedSlots = new Set();
  pairs.sort((a, b) => a.distance - b.distance).forEach((pair) => {
    if (pair.distance > 0.48 || usedHands.has(pair.handIndex) || usedSlots.has(pair.marker.slot)) return;
    assignments.set(pair.handIndex, pair.marker);
    usedHands.add(pair.handIndex);
    usedSlots.add(pair.marker.slot);
  });
  return assignments;
}

function attemptHybridStrikes(timestamp) {
  state.pendingImpulses.forEach((impulse, slot) => {
    if (!impulse) return;
    const marker = state.latestColorMarkers.find((item) => item.slot === slot);
    const contact = state.contactStates[slot];
    const impulseAge = timestamp - impulse.time;
    if (impulseAge > HYBRID_CONFIG.fusionWindowMs) {
      state.pendingImpulses[slot] = null;
      return;
    }
    if (!marker || timestamp - marker.lastSeen > HYBRID_CONFIG.markerFreshnessMs) return;
    if (!contact.inside || contact.fired || !contact.downwardEntry || !contact.hit) return;
    if (timestamp - state.lastStrikeAt[slot] < HYBRID_CONFIG.strikeRefractoryMs) return;
    state.lastStrikeAt[slot] = timestamp;
    state.pendingImpulses[slot] = null;
    contact.fired = true;
    registerHit(contact.hit.name, `HYBRID ${slot + 1} · Z`, contact.hit, impulse.strength, impulse.time);
  });
}

function updateContactStates(trackedMarkers) {
  for (let slot = 0; slot < 2; slot += 1) {
    const marker = trackedMarkers.find((item) => item.slot === slot);
    const contact = state.contactStates[slot];
    if (!marker) continue;

    const hasHistory = contact.lastX !== null && contact.lastY !== null && contact.lastAt !== null;
    const dt = hasHistory ? Math.max(0.008, (marker.lastSeen - contact.lastAt) / 1000) : 0;
    const dx = hasHistory ? marker.x - contact.lastX : 0;
    const dy = hasHistory ? marker.y - contact.lastY : 0;
    const downwardSpeed = dt ? dy / dt : 0;
    const downwardMotion = hasHistory
      && dt < 0.16
      && dy >= HYBRID_CONFIG.minDownwardStep
      && downwardSpeed >= HYBRID_CONFIG.minDownwardSpeed
      && dy >= Math.abs(dx) * HYBRID_CONFIG.downwardDominance;
    const hit = kit.pick(marker.x, marker.y, false);
    if (hit) {
      if (!contact.inside) {
        contact.inside = true;
        contact.fired = false;
        contact.entryDrum = hit.name;
        contact.downwardEntry = contact.outsideFrames > 0 && downwardMotion;
        if (!contact.downwardEntry) state.pendingImpulses[slot] = null;
      } else if (hit.name !== contact.entryDrum) {
        contact.downwardEntry = false;
        state.pendingImpulses[slot] = null;
      }
      contact.outsideFrames = 0;
      contact.hit = hit;
    } else {
      contact.hit = null;
      contact.outsideFrames += 1;
      if (contact.outsideFrames >= HYBRID_CONFIG.releaseFrames) {
        const wasInside = contact.inside;
        contact.inside = false;
        contact.fired = false;
        contact.downwardEntry = false;
        contact.entryDrum = null;
        if (wasInside) state.pendingImpulses[slot] = null;
      }
    }

    contact.lastX = marker.x;
    contact.lastY = marker.y;
    contact.lastAt = marker.lastSeen;
  }
}

colorTracker.on("track", (event) => {
  if (state.inputMode !== "hybrid") return;
  const detectedAt = performance.now();
  const { width, height } = sizeTrackingCanvas();
  const trackedMarkers = selectTrackedBlueMarkers(event.data, width, height, detectedAt);
  state.latestColorMarkers = trackedMarkers;
  updateContactStates(trackedMarkers);
  renderTrackingOverlay();
  const ignoredCount = Math.max(0, event.data.length - trackedMarkers.length);
  elements.markerReadout.textContent = `${trackedMarkers.length}/2 sticks${ignoredCount ? ` · ${ignoredCount} ignored` : ""}`;
  const handsFound = state.latestHandResults?.landmarks?.length || 0;
  const contactLocked = state.contactStates.some((contact) => contact.inside && contact.fired);
  const wrongWayContact = state.contactStates.some((contact) => contact.inside && !contact.downwardEntry);
  elements.detectionStatus.textContent = contactLocked
    ? "Lift struck stick to re-arm"
    : wrongWayContact
    ? "Downward entry required · lift stick"
    : trackedMarkers.length && handsFound
    ? trackedMarkers.length === 2 && handsFound === 2 ? "Fusion armed · Z strike" : `${trackedMarkers.length} stick + ${handsFound} hand`
    : trackedMarkers.length ? "Sticks ready · find hands" : event.data.length ? "Filtering interference" : "Searching";

  for (let slot = 0; slot < 2; slot += 1) {
    const marker = trackedMarkers.find((item) => item.slot === slot);
    if (marker) kit.updateTrackingIndicator(slot, marker.x, marker.y, "color");
    else kit.clearTrackingIndicator(slot);
  }

  attemptHybridStrikes(detectedAt);
});

async function initialiseHandTracking() {
  if (state.handLandmarker || state.handLandmarkerLoading) return;
  state.handLandmarkerLoading = true;
  elements.detectionStatus.textContent = "Loading AI";
  if (state.stream) setStatus(elements.cameraStatus, "Camera + AI loading", "idle");
  try {
    const vision = await FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
    const options = {
      baseOptions: { modelAssetPath: "./models/hand_landmarker.task", delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    try {
      state.handLandmarker = await HandLandmarker.createFromOptions(vision, options);
    } catch (gpuError) {
      console.warn("MediaPipe GPU initialisation failed; using CPU.", gpuError);
      options.baseOptions.delegate = "CPU";
      state.handLandmarker = await HandLandmarker.createFromOptions(vision, options);
    }
    elements.detectionStatus.textContent = "Hybrid ready";
    if (state.stream) setStatus(elements.cameraStatus, "Camera + hybrid ready", "ready");
  } catch (error) {
    console.error(error);
    elements.detectionStatus.textContent = "AI error";
    elements.cameraMessage.textContent = `MediaPipe failed to initialise: ${error.message}`;
  } finally {
    state.handLandmarkerLoading = false;
  }
}

function drawHands(results, width, height) {
  trackingContext.lineWidth = 2;
  const connections = HandLandmarker.HAND_CONNECTIONS || [];
  results.landmarks.forEach((landmarks) => {
    trackingContext.strokeStyle = "rgba(83,216,255,.62)";
    for (const connection of connections) {
      const from = landmarks[connection.start];
      const to = landmarks[connection.end];
      trackingContext.beginPath();
      trackingContext.moveTo(from.x * width, from.y * height);
      trackingContext.lineTo(to.x * width, to.y * height);
      trackingContext.stroke();
    }
    landmarks.forEach((landmark, index) => {
      trackingContext.beginPath();
      trackingContext.fillStyle = index === 8 ? "#8bc2ff" : "#53d8ff";
      trackingContext.arc(landmark.x * width, landmark.y * height, index === 8 ? 5 : 2.5, 0, Math.PI * 2);
      trackingContext.fill();
    });
  });
}

function processHandResults(results, timestamp) {
  const hands = results.landmarks || [];
  state.latestHandResults = results;
  state.latestHandResultsAt = timestamp;
  renderTrackingOverlay();
  elements.handsReadout.textContent = String(hands.length);
  const assignments = associateHandsWithMarkers(results);

  assignments.forEach((marker, handIndex) => {
    const tip = hands[handIndex][8];
    const worldTip = results.worldLandmarks?.[handIndex]?.[8] || tip;
    const previous = state.handHistory.get(marker.slot);
    const dt = previous ? Math.max(0.008, (timestamp - previous.time) / 1000) : 0;
    const rawVelocityZ = previous ? (previous.z - worldTip.z) / dt : 0;
    const velocityZ = previous ? previous.velocityZ * 0.18 + rawVelocityZ * 0.82 : 0;
    const accelerationZ = previous ? (velocityZ - previous.velocityZ) / dt : 0;
    state.handHistory.set(marker.slot, { z: worldTip.z, velocityZ, time: timestamp });

    const zImpulse = previous
      && dt < 0.14
      && velocityZ > HYBRID_CONFIG.zSpeedThreshold
      && accelerationZ > HYBRID_CONFIG.zAccelerationThreshold
      && timestamp - state.lastImpulseAt[marker.slot] > HYBRID_CONFIG.impulseRefractoryMs;
    const contact = state.contactStates[marker.slot];
    if (zImpulse && !(contact.inside && contact.fired)) {
      state.lastImpulseAt[marker.slot] = timestamp;
      state.pendingImpulses[marker.slot] = {
        time: timestamp,
        strength: THREE.MathUtils.clamp(0.55 + velocityZ * 0.65 + accelerationZ * 0.055, 0.55, 1.15),
      };
    }
  });

  const contactLocked = state.contactStates.some((contact) => contact.inside && contact.fired);
  const wrongWayContact = state.contactStates.some((contact) => contact.inside && !contact.downwardEntry);
  elements.detectionStatus.textContent = contactLocked
    ? "Lift struck stick to re-arm"
    : wrongWayContact
    ? "Downward entry required · lift stick"
    : state.latestColorMarkers.length && hands.length
    ? state.latestColorMarkers.length === 2 && hands.length === 2 ? "Fusion armed · Z strike" : `${state.latestColorMarkers.length} stick + ${hands.length} hand`
    : hands.length ? "Hands ready · find blue tips" : "Searching";
  attemptHybridStrikes(timestamp);
}

async function handLoop() {
  requestAnimationFrame(handLoop);
  if (state.inputMode !== "hybrid" || !state.handLandmarker || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (elements.video.currentTime === state.lastHandVideoTime) return;
  state.lastHandVideoTime = elements.video.currentTime;
  const timestamp = performance.now();
  try {
    const results = state.handLandmarker.detectForVideo(elements.video, timestamp);
    processHandResults(results, timestamp);
  } catch (error) {
    console.warn("Skipped one MediaPipe frame", error);
  }
}
requestAnimationFrame(handLoop);

async function setInputMode(mode) {
  state.inputMode = "hybrid";
  kit.clearTrackingIndicator();
  state.colorCandidates = [];
  state.colorSlots = [null, null];
  state.latestColorMarkers = [];
  state.latestHandResults = null;
  state.handHistory.clear();
  state.pendingImpulses = [null, null];
  state.contactStates = [
    createContactState(),
    createContactState(),
  ];
  trackingContext.clearRect(0, 0, elements.trackingCanvas.width, elements.trackingCanvas.height);
  elements.modeButtons.forEach((button) => button.classList.add("active"));
  elements.modeLabel.textContent = "HYBRID";
  elements.stageHint.textContent = "Strike downward from above · lift clear · strike again";
  elements.handsReadout.textContent = "0";
  elements.detectionStatus.textContent = "Loading fusion";
  await initialiseHandTracking();
}

function drumFromMidi(note) {
  return Object.keys(DRUMS).find((name) => DRUMS[name].midi.includes(note)) || null;
}

function attachMidiInputs() {
  let count = 0;
  for (const input of state.midiAccess.inputs.values()) {
    count += 1;
    input.onmidimessage = (event) => {
      const [status, note, velocity] = event.data;
      const isNoteOn = (status & 0xf0) === 0x90 && velocity > 0;
      if (!isNoteOn) return;
      const drum = drumFromMidi(note);
      if (drum) registerHit(drum, "MIDI", null, Math.max(0.35, velocity / 127), performance.now());
    };
  }
  if (count) {
    setStatus(elements.midiStatus, `${count} MIDI input${count === 1 ? "" : "s"}`, "ready");
    elements.midiButton.textContent = "MIDI pedal connected";
  } else {
    setStatus(elements.midiStatus, "No MIDI device", "idle");
    elements.midiButton.textContent = "Search for MIDI pedal";
  }
}

async function connectMidi() {
  await audio.resume();
  if (!navigator.requestMIDIAccess) {
    setStatus(elements.midiStatus, "Web MIDI unsupported", "error");
    elements.midiButton.textContent = "Use Chrome or Edge for MIDI";
    return;
  }
  try {
    state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    state.midiAccess.onstatechange = attachMidiInputs;
    attachMidiInputs();
  } catch (error) {
    console.error(error);
    setStatus(elements.midiStatus, "MIDI permission denied", "error");
  }
}

elements.cameraButton.addEventListener("click", startCamera);
elements.midiButton.addEventListener("click", connectMidi);
elements.resetButton.addEventListener("click", () => {
  state.hitCount = 0;
  elements.hitCounter.textContent = "0 hits";
  elements.lastInstrument.textContent = "—";
  elements.latencyReadout.textContent = "Ready";
});
elements.modeButtons.forEach((button) => button.addEventListener("click", () => setInputMode(button.dataset.mode)));

window.addEventListener("pointerdown", () => audio.resume(), { once: true });
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
  event.preventDefault();
  registerHit("BassDrum", "SPACE", null, 1, performance.now());
});

window.addEventListener("beforeunload", () => {
  stopCamera();
  state.colorTask?.stop?.();
  state.handLandmarker?.close?.();
});

window.virtualDrum = {
  getState: () => ({
    inputMode: state.inputMode,
    hitCount: state.hitCount,
    cameraActive: Boolean(state.stream?.getVideoTracks().some((track) => track.readyState === "live")),
    audioState: audio.context?.state,
    midiInputs: state.midiAccess ? state.midiAccess.inputs.size : 0,
    mediaPipeReady: Boolean(state.handLandmarker),
  }),
  trigger: (name) => DRUMS[name] && registerHit(name, "TEST"),
  setPointer: (x, y, mode = "color", index = 0) => kit.updateTrackingIndicator(index, x, y, mode),
  clearPointer: (index = null) => kit.clearTrackingIndicator(index),
};

setInputMode("hybrid");
startCamera();
