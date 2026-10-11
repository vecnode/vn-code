/**
 * flow-field — an example run for the p5js-prototypes skill.
 *
 * Read it as a reference for the shape every p5.js prototype in this lab has:
 *
 *   - the seed is applied to randomSeed AND noiseSeed before anything is drawn;
 *   - every tunable is read through P('name'), so the shell's sliders are part
 *     of the algorithm rather than a filter over it;
 *   - window.__LAB.drew marks the first real frame.
 *
 * The algorithm, in one sentence: particles drift along a layered noise field and
 * die of old age, so density accumulates where the field slows them down.
 */
(function () {
  const spec = window.__LAB;

  /** One parameter by name, as the shell currently has it. */
  const P = (name) => spec.param(name);

  /** Set when the population has to be rebuilt (a parameter or the window changed). */
  let dirty = true;

  randomSeed(spec.seed);
  noiseSeed(spec.seed);

  const state = { particles: [], frames: 0 };

  /** Layer two octaves so the field has weather at one scale and texture at another. */
  function angleAt(x, y) {
    const scale = P('scale');
    const drift = state.frames * P('speed') * 0.00035;
    const coarse = noise(x * scale, y * scale, drift);
    const fine = noise(x * scale * 3.1, y * scale * 3.1, drift * 1.7);
    return (coarse * 0.75 + fine * 0.25) * TWO_PI * 3;
  }

  function respawn(particle) {
    particle.x = random(width);
    particle.y = random(height);
    particle.life = random(0.4, 1) * P('life');
    particle.age = 0;
    particle.speed = P('flow') * random(0.6, 1.4);
  }

  function populate() {
    const wanted = P('particles');
    while (state.particles.length > wanted) state.particles.pop();
    while (state.particles.length < wanted) {
      const particle = { x: 0, y: 0, age: 0, life: 1, speed: 1 };
      respawn(particle);
      particle.age = random(particle.life);
      state.particles.push(particle);
    }
  }

  function setup() {
    const canvas = createCanvas(windowWidth, windowHeight);
    canvas.parent('lab-stage');
    pixelDensity(1);
    populate();
    background(0);
    strokeCap(ROUND);
  }

  function draw() {
    if (dirty) {
      populate();
      background(0);
      state.frames = 0;
      dirty = false;
    }
    state.frames += 1;

    noStroke();
    fill(0, P('veil'));
    rect(0, 0, width, height);

    const weight = P('weight');
    for (const particle of state.particles) {
      const angle = angleAt(particle.x, particle.y);
      const nextX = particle.x + Math.cos(angle) * particle.speed;
      const nextY = particle.y + Math.sin(angle) * particle.speed;
      const remaining = 1 - particle.age / particle.life;
      const brightness = 45 + 120 * remaining;

      stroke(brightness * 0.7, brightness * 1.6, 255 - brightness * 0.4, 150);
      strokeWeight(weight * remaining + 0.3);
      line(particle.x, particle.y, nextX, nextY);

      particle.x = nextX;
      particle.y = nextY;
      particle.age += 1;
      if (particle.age > particle.life || particle.x < -20 || particle.x > width + 20 || particle.y < -20 || particle.y > height + 20) {
        respawn(particle);
      }
    }

    if (state.frames === 1) spec.drew = true;
  }

  function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
    dirty = true;
  }

  window.labOnParam = function (name) {
    // Rebuilding the population on a parameter change is what makes the control
    // part of the algorithm: the sliders change the system, not a filter over it.
    if (name !== 'veil' && name !== 'speed' && name !== 'weight') dirty = true;
  };

  Object.assign(window, { setup, draw, windowResized });
})();
