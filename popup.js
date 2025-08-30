// danmaku.js (ES Module)

export const TAU = Math.PI * 2;

export class RNG {
  constructor(seed = 123456789) { this.s = seed >>> 0; }
  next() {
    // xorshift32
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x >>> 0;
    return (this.s & 0xffffffff) / 0x100000000;
  }
  range(a = 0, b = 1) { return a + (b - a) * this.next(); }
}

export class Pool {
  constructor(capacity, create) {
    this.create = create;
    this.items = Array.from({ length: capacity }, () => create());
    this.free = [...this.items];
    this.alive = new Set();
  }
  acquire() {
    const it = this.free.pop() ?? this.create();
    this.alive.add(it);
    return it;
  }
  release(it) {
    this.alive.delete(it);
    this.free.push(it);
  }
  forEach(fn) {
    for (const it of this.alive) fn(it);
  }
}

export class Scheduler {
  constructor() { this.time = 0; this.events = []; }
  update(dt) {
    this.time += dt;
    for (const ev of this.events) {
      if (ev.cancelled) continue;
      if (ev.type === 'at' && this.time >= ev.t && !ev.fired) { ev.fired = true; ev.fn(); }
      if (ev.type === 'every') {
        if (this.time >= ev.next) { ev.fn(); ev.next += ev.dt; }
      }
    }
    this.events = this.events.filter(e => !e.cancelled && (e.type !== 'at' || !e.fired));
  }
  at(t, fn) { this.events.push({ type: 'at', t, fn, fired: false }); }
  after(dt, fn) { this.at(this.time + dt, fn); }
  every(dt, fn, startDelay = 0) { this.events.push({ type: 'every', dt, fn, next: this.time + startDelay }); }
  clear() { this.events.length = 0; }
}

export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.pointer = { active: false, x: 0, y: 0 };
    window.addEventListener('keydown', e => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    const toLocal = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (canvas.height / rect.height);
      return { x, y };
    };
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      const p = toLocal(e);
      this.pointer = { active: true, x: p.x, y: p.y };
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.pointer.active) return;
      const p = toLocal(e);
      this.pointer.x = p.x; this.pointer.y = p.y;
    });
    canvas.addEventListener('pointerup', e => { this.pointer.active = false; });
  }
  axis() {
    let x = 0, y = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) x -= 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) x += 1;
    if (this.keys.has('arrowup') || this.keys.has('w')) y -= 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) y += 1;
    return { x, y };
  }
}

export class Entity {
  constructor({ x = 0, y = 0, r = 4, color = '#fff' } = {}) {
    this.x = x; this.y = y; this.r = r; this.color = color; this.alive = true;
  }
  update(dt, scene) {}
  draw(ctx) {
    ctx.fillStyle = this.color;
    ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, TAU); ctx.fill();
  }
  kill() { this.alive = false; }
}

export class Bullet extends Entity {
  constructor() {
    super();
    this.vx = 0; this.vy = 0;
    this.ax = 0; this.ay = 0;
    this.life = 6; // seconds
    this.age = 0;
    this.team = 'enemy'; // or 'player'
    this.rotate = false;
    this.theta = 0;
    this.spin = 0;
  }
  reset(opts = {}) {
    this.alive = true; this.age = 0;
    this.x = opts.x ?? 0; this.y = opts.y ?? 0;
    this.vx = opts.vx ?? 0; this.vy = opts.vy ?? 0;
    this.ax = opts.ax ?? 0; this.ay = opts.ay ?? 0;
    this.r = opts.r ?? 4; this.color = opts.color ?? '#fffb';
    this.life = opts.life ?? 6; this.team = opts.team ?? 'enemy';
    this.rotate = !!opts.rotate; this.theta = opts.theta ?? 0; this.spin = opts.spin ?? 0;
    return this;
  }
  update(dt, scene) {
    this.age += dt;
    this.vx += this.ax * dt; this.vy += this.ay * dt;
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (this.rotate) { this.theta += this.spin * dt; }
    if (this.age >= this.life || this.offscreen(scene)) this.kill();
  }
  offscreen(scene) {
    const m = 20;
    return (this.x < -m || this.x > scene.width + m || this.y < -m || this.y > scene.height + m);
  }
  draw(ctx) {
    if (this.rotate) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.theta);
      ctx.fillStyle = this.color;
      ctx.fillRect(-this.r, -this.r * 0.5, this.r * 2, this.r);
      ctx.restore();
    } else {
      super.draw(ctx);
    }
  }
}

export class Player extends Entity {
  constructor({ x, y, r = 5, color = '#6cf', speed = 220, lives = 3 }) {
    super({ x, y, r, color });
    this.speed = speed;
    this.lives = lives;
    this.invul = 0;
    this.slow = false;
    this.fireCooldown = 0;
    this.onDeath = null;
  }
  update(dt, scene) {
    const input = scene.engine.input;
    const axis = input.axis();
    this.slow = input.keys.has('shift');
    const spd = this.speed * (this.slow ? 0.5 : 1);
    this.x += axis.x * spd * dt; this.y += axis.y * spd * dt;

    if (input.pointer.active) {
      const t = 0.22; // follow pointer smoothing
      this.x += (input.pointer.x - this.x) * t;
      this.y += (input.pointer.y - this.y) * t;
    }

    this.x = Math.max(this.r, Math.min(scene.width - this.r, this.x));
    this.y = Math.max(this.r, Math.min(scene.height - this.r, this.y));

    if (this.invul > 0) this.invul -= dt;

    // auto fire
    this.fireCooldown -= dt;
    const fireRate = this.slow ? 0.12 : 0.08;
    if (this.fireCooldown <= 0) {
      this.fire(scene);
      this.fireCooldown = fireRate;
    }
  }
  fire(scene) {
    const speed = this.slow ? 520 : 640;
    const spread = this.slow ? 0.08 : 0.18;
    const n = this.slow ? 1 : 3;
    for (let i = 0; i < n; i++) {
      const dx = (i - (n - 1) / 2) * spread;
      const b = scene.bullets.acquire().reset({
        x: this.x + dx * 20,
        y: this.y - 8,
        vx: dx * 80,
        vy: -speed,
        r: 3,
        color: '#8ff',
        life: 1.2,
        team: 'player'
      });
      scene.bulletList.push(b);
    }
  }
  hit(scene) {
    if (this.invul > 0) return;
    this.lives -= 1;
    this.invul = 2.0;
    if (this.lives < 0) { this.kill(); if (this.onDeath) this.onDeath(scene); }
  }
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.invul > 0 ? 0.6 : 1;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(this.x, this.y - this.r * 2);
    ctx.lineTo(this.x - this.r, this.y + this.r);
    ctx.lineTo(this.x + this.r, this.y + this.r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

export class Enemy extends Entity {
  constructor({ x, y, r = 14, color = '#f66', hp = 100 }) {
    super({ x, y, r, color });
    this.hp = hp;
    this.vx = 0; this.vy = 0;
    this.onDeath = null;
  }
  update(dt, scene) {
    this.x += this.vx * dt; this.y += this.vy * dt;
    if (this.hp <= 0 && this.alive) { this.kill(); if (this.onDeath) this.onDeath(scene, this); }
  }
  damage(d) { this.hp -= d; }
}

export const Patterns = {
  spiral({ angle = 0, delta = 0.2, count = 1, speed = 120, color = '#ff8', r = 4, spin = 0 }) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const th = angle + i * delta;
      out.push(({ x, y }) => ({
        x, y,
        vx: Math.cos(th) * speed,
        vy: Math.sin(th) * speed,
        r, color,
        rotate: true,
        theta: th,
        spin
      }));
    }
    return out;
  },
  ring({ base = 0, bullets = 24, speed = 160, color = '#fb8', r = 4 }) {
    const out = [];
    for (let i = 0; i < bullets; i++) {
      const th = base + (i / bullets) * TAU;
      out.push(({ x, y }) => ({
        x, y,
        vx: Math.cos(th) * speed,
        vy: Math.sin(th) * speed,
        r, color,
        rotate: true,
        theta: th,
        spin: 4
      }));
    }
    return out;
  },
  aimed({ target, spread = 0, count = 1, speed = 200, color = '#fbb', r = 4 }) {
    const out = [];
    const base = Math.atan2(target.y, target.x);
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * spread;
      const th = base + off;
      out.push(({ x, y }) => ({
        x, y,
        vx: Math.cos(th) * speed,
        vy: Math.sin(th) * speed,
        r, color
      }));
    }
    return out;
  },
  wave({ base = 0, amplitude = 0.8, freq = 3, speed = 180, color = '#bbf', r = 4 }) {
    const out = [];
    const th = base;
    out.push(({ x, y, t }) => ({
      x, y,
      vx: Math.cos(th) * speed,
      vy: Math.sin(th) * speed,
      ax: Math.cos((t + Math.random()) * freq) * amplitude * 20,
      ay: Math.sin((t + Math.random()) * freq) * amplitude * 20,
      r, color
    }));
    return out;
  },
  randomSpread({ rng, center = 0, arc = TAU, count = 10, speed = 140, color = '#df8', r = 3 }) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const th = center + (rng.next() - 0.5) * arc;
      out.push(({ x, y }) => ({
        x, y,
        vx: Math.cos(th) * speed,
        vy: Math.sin(th) * speed,
        r, color
      }));
    }
    return out;
  }
};

export class Emitter {
  constructor({
    x = 0, y = 0, rate = 0.1, pattern = () => [], team = 'enemy', enabled = true, target = null
  } = {}) {
    this.x = x; this.y = y;
    this.rate = rate; // seconds between bursts
    this.timer = 0;
    this.pattern = pattern; // function (ctx) -> array of initializers
    this.team = team;
    this.enabled = enabled;
    this.age = 0;
    this.target = target;
  }
  update(dt, scene) {
    if (!this.enabled) return;
    this.age += dt;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.emit(scene);
      this.timer = this.rate;
    }
  }
  emit(scene) {
    const inits = this.pattern({ t: this.age, scene, target: this.target ?? scene.player });
    for (const init of inits) {
      const b = scene.bullets.acquire().reset({ team: this.team });
      const o = init({ x: this.x, y: this.y, t: this.age, scene });
      b.reset({ ...o, team: this.team });
      scene.bulletList.push(b);
    }
  }
}

export class Scene {
  constructor(engine, { width, height, rngSeed = 20240830 } = {}) {
    this.engine = engine;
    this.width = width ?? engine.width;
    this.height = height ?? engine.height;

    this.rng = new RNG(rngSeed);
    this.scheduler = new Scheduler();

    this.entities = new Set();
    this.bullets = new Pool(2048, () => new Bullet());
    this.bulletList = [];
    this.emitters = new Set();

    this.player = null;
    this.enemies = new Set();

    this.debug = { collisions: false };
  }
  add(ent) { this.entities.add(ent); return ent; }
  remove(ent) { this.entities.delete(ent); }
  addEmitter(em) { this.emitters.add(em); return em; }
  removeEmitter(em) { this.emitters.delete(em); }

  setPlayer(p) { this.player = p; this.add(p); return p; }
  addEnemy(e) { this.enemies.add(e); this.add(e); return e; }

  update(dt) {
    this.scheduler.update(dt);

    // Emitters
    for (const em of this.emitters) em.update(dt, this);

    // Entities
    for (const e of this.entities) if (e.alive) e.update(dt, this);

    // Bullets
    this.bullets.forEach(b => { if (b.alive) b.update(dt, this); });

    // Cleanup
    this._collect();

    // Collisions
    this._collide();
  }

  _collect() {
    // entities
    for (const e of [...this.entities]) if (!e.alive) this.entities.delete(e);
    // bullets
    for (const b of [...this.bullets.alive]) {
      if (!b.alive) {
        this.bullets.release(b);
      }
    }
    // compact list for drawing
    this.bulletList = [...this.bullets.alive];
  }

  _collide() {
    const p = this.player;
    if (p && p.alive) {
      for (const b of this.bullets.alive) {
        if (b.team !== 'enemy') continue;
        if (circleHit(p, b)) { b.kill(); p.hit(this); }
      }
    }
    // player bullets vs enemies
    for (const b of this.bullets.alive) {
      if (b.team !== 'player') continue;
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (circleHit(b, e)) {
          b.kill(); e.damage(10);
        }
      }
    }
  }

  draw(ctx) {
    // Background
    const grd = ctx.createLinearGradient(0, 0, 0, this.height);
    grd.addColorStop(0, '#0a0a12'); grd.addColorStop(1, '#0e1220');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, this.width, this.height);

    // Bullets
    for (const b of this.bulletList) b.draw(ctx);

    // Entities on top
    for (const e of this.entities) e.draw(ctx);

    // UI
    if (this.player) {
      ctx.fillStyle = '#fff8';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillText(`LIVES: ${Math.max(0, this.player.lives)}`, 12, 18);
    }

    if (this.debug.collisions) {
      ctx.strokeStyle = '#0f08';
      ctx.lineWidth = 1;
      for (const b of this.bullets.alive) {
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.stroke();
      }
      for (const e of this.entities) {
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, TAU); ctx.stroke();
      }
    }
  }
}

export class Engine {
  constructor(canvas, { width = 480, height = 720, dpr = Math.min(2, window.devicePixelRatio || 1) } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._desired = { width, height };
    this.dpr = dpr;
    this.width = width * dpr;
    this.height = height * dpr;
    this._resize();

    this.input = new Input(canvas);

    this.running = false;
    this.acc = 0; this.last = 0;
    this.dt = 1 / 60;
    this.maxFrame = 1 / 10;

    window.addEventListener('resize', () => this._resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.acc = 0; this.last = performance.now(); }
    });
  }

  _resize() {
    const { width, height } = this._desired;
    const dpr = Math.min(2, window.devicePixelRatio || this.dpr);
    this.dpr = dpr;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width; this.height = height;
  }

  start(scene) {
    this.scene = scene;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const elapsed = Math.min(this.maxFrame, (now - this.last) / 1000);
      this.last = now;
      this.acc += elapsed;
      while (this.acc >= this.dt) {
        scene.update(this.dt);
        this.acc -= this.dt;
      }
      this.scene.draw(this.ctx);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }
}

// Helpers
export function circleHit(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  const rr = (a.r + b.r) * (a.r + b.r);
  return dx * dx + dy * dy <= rr;
}
