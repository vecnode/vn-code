/**
 * attractor-nodes â€” an example run for the p5js-prototypes skill.
 *
 * The second reference shape, and the one that shows a different kind of system:
 * where flow-field is a FIELD (the same rule everywhere, evaluated per particle),
 * this is an INTERACTION (a handful of bodies, and every particle feels all of
 * them). Both are state + a rule; they differ in where the interesting structure
 * comes from, which is exactly the kind of choice worth making deliberately.
 *
 * The algorithm, in one sentence: particles are pulled toward moving attractors
 * and their short trails accumulate into the basins between them.
 */
window.__dshProtoLabSketch__(function () {
  // The run's contract. The long name is deliberate: p5's global mode copies its
  // prototype onto window, so window.color (and anything else short) is p5's.
  const spec = window.__dshProtoLab__;

  /** One parameter by name, as the shell currently has it. */
  const P = (name) => spec.param(name);

  /** Set when the population has to be rebuilt (a parameter or the window changed). */
  let dirty = true;


  // The system is the ATTRACTORS plus the particles: a handful of bodies that
  // every particle feels, with its own slow drift and its own lifecycle.
  const state = {
    attractors: [],
    particles: [],
    frames: 0,
  };

  /** Attractors drift on independent closed paths, so they never settle. */
  function drift(attractor, frames) {
    const t = frames * 0.004 + attractor.phase;
    attractor.x = width * (0.5 + 0.36 * Math.cos(t * attractor.rateX));
    attractor.y = height * (0.5 + 0.36 * Math.sin(t * attractor.rateY));
  }

  /** Keep exactly P('attractors') bodies, adding or retiring as the slider moves. */
  function ensureAttractors(count) {
    while (state.attractors.length > count) state.attractors.pop();
    while (state.attractors.length < count) {
      const index = state.attractors.length;
      state.attractors.push({
        x: random(width),
        y: random(height),
        mass: random(0.6, 1.6),
        phase: random(TWO_PI),
        rateX: random(0.6, 1.3),
        rateY: random(0.6, 1.3),
        hue: (index * 360) / Math.max(1, count),
      });
    }
  }

  function respawn(particle, atAttractor) {
    const from = atAttractor ?? state.attractors[Math.floor(random(state.attractors.length))];
    particle.x = (from === undefined ? width / 2 : from.x) + random(-24, 24);
    particle.y = (from === undefined ? height / 2 : from.y) + random(-24, 24);
    particle.px = particle.x;
    particle.py = particle.y;
    particle.vx = random(-1, 1);
    particle.vy = random(-1, 1);
    particle.hue = from === undefined ? 0 : from.hue;
    particle.age = 0;
    particle.life = random(60, 260);
  }

  function populate() {
    while (state.particles.length > P('particles')) state.particles.pop();
    while (state.particles.length < P('particles')) {
      const particle = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, hue: 0, age: 0, life: 1 };
      respawn(particle);
      particle.age = random(particle.life);
      state.particles.push(particle);
    }
  }

  // Handed over, NOT left on window: p5's auto-start would race the shell for it.
  // See the note above window.__dshProtoLabLifecycle__ in index.html.
  window.__dshProtoLabLifecycle__.setup = function () {
    // The seed first, before anything is drawn - and here rather than at the top of
    // the factory: these globals only exist once p5 has started.
    randomSeed(spec.seed);
    noiseSeed(spec.seed);
    const canvas = createCanvas(windowWidth, windowHeight);
    canvas.parent('lab-stage');
    colorMode(HSB, 360, 100, 100, 100);
    pixelDensity(1);
    strokeCap(ROUND);
    ensureAttractors(P('attractors'));
    populate();
    background(0);
  }

  window.__dshProtoLabLifecycle__.draw = function () {
    if (dirty) {
      ensureAttractors(P('attractors'));
      populate();
      background(0);
      state.frames = 0;
      dirty = false;
    }
    state.frames += 1;

    const attractors = state.attractors;
    for (const attractor of attractors) drift(attractor, state.frames);

    // A veil keeps the history; how MUCH history is a parameter, because it is
    // the difference between a diagram of paths and a wash of density.
    noStroke();
    fill(0, 0, 4, P('veil'));
    rect(0, 0, width, height);

    const strength = P('pull');
    const drag = P('drag');
    const wobble = P('wobble');
    for (const particle of state.particles) {
      let ax = 0;
      let ay = 0;
      for (const attractor of attractors) {
        const dx = attractor.x - particle.x;
        const dy = attractor.y - particle.y;
        const distance = Math.max(18, Math.sqrt(dx * dx + dy * dy));
        const force = (strength * attractor.mass) / (distance * distance) * 900;
        ax += (dx / distance) * force;
        ay += (dy / distance) * force;
      }
      // A little noise on the acceleration is what makes the basins readable
      // rather than smooth: without it every particle takes the same path in.
      const angle = noise(particle.x * 0.004, particle.y * 0.004, state.frames * 0.002) * TWO_PI * 2;
      ax += Math.cos(angle) * wobble;
      ay += Math.sin(angle) * wobble;

      particle.vx = (particle.vx + ax) * drag;
      particle.vy = (particle.vy + ay) * drag;
      particle.px = particle.x;
      particle.py = particle.y;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.age += 1;

      const remaining = 1 - particle.age / particle.life;
      stroke(particle.hue, 70, 100, 90 * remaining);
      strokeWeight(P('weight') * remaining + 0.3);
      line(particle.px, particle.py, particle.x, particle.y);

      if (particle.age > particle.life || particle.x < -40 || particle.x > width + 40 || particle.y < -40 || particle.y > height + 40) {
        respawn(particle);
      }
    }

    // The bodies themselves last, so they read as the cause rather than as
    // another trail.
    noStroke();
    for (const attractor of attractors) {
      fill(attractor.hue, 30, 100, 22);
      circle(attractor.x, attractor.y, 26 * attractor.mass);
      fill(attractor.hue, 55, 100, 85);
      circle(attractor.x, attractor.y, 7 * attractor.mass);
    }

    if (state.frames === 1) spec.drew = true;
  }

  window.windowResized = function () {
    resizeCanvas(windowWidth, windowHeight);
    dirty = true;
  }

  window.labOnParam = function (name) {
    // `veil`, `drag` and `weight` change the rendering; everything else changes
    // the system, so it starts again from a known state.
    if (name !== 'veil' && name !== 'drag' && name !== 'weight') dirty = true;
  };

  // The lifecycle is on `window`, where p5's global mode looks for it.
});
