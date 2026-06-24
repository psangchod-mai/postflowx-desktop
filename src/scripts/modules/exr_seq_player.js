// scripts/modules/exr_seq_player.js
// EXR image-sequence player — WebGL2 canvas + ACES tone mapping + worker decode pool

const WORKER_COUNT = 2;
const CACHE_MAX    = 4;  // max decoded frames kept in memory
const PREFETCH     = 2;  // frames to start decoding ahead while playing

// ── GLSL shaders ─────────────────────────────────────────────────────────────
const VS_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  // flip Y: WebGL origin is bottom-left, image origin is top-left
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
}`;

const FS_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float     u_exposure;
in  vec2 v_uv;
out vec4 fragColor;

// Simplified ACES filmic tone mapping (Narkowicz 2015)
vec3 aces(vec3 x){
  return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
}

void main(){
  vec4  hdr  = texture(u_tex, v_uv);
  vec3  lin  = hdr.rgb * pow(2.0, u_exposure);
  vec3  sdr  = aces(lin);
  // Approximate sRGB transfer function (gamma 2.2)
  fragColor  = vec4(pow(max(sdr, 0.0), vec3(1.0/2.2)), hdr.a);
}`;

// ── ExrSeqPlayer ─────────────────────────────────────────────────────────────
export class ExrSeqPlayer {
  constructor(canvas) {
    this._canvas   = canvas;
    this._files    = [];        // File[] in playback order
    this._fps      = 24;
    this._frame    = 0;
    this._playing  = false;
    this._exposure = 0.0;       // stops

    // WebGL2 state
    this._gl    = null;
    this._prog  = null;
    this._vao   = null;
    this._tex   = null;
    this._uExp  = null;
    this._texW  = 0;
    this._texH  = 0;

    // Worker pool
    this._workers  = [];        // Worker[]
    this._free     = [];        // indices of idle workers
    this._jobMap   = new Map(); // jobId → { resolve, reject }
    this._jobSeq   = 0;
    this._queue    = [];        // pending { id, file, resolve, reject }

    // Frame store
    this._cache    = new Map(); // frameIdx → { rgba, w, h }
    this._inflight = new Map(); // frameIdx → Promise<{rgba,w,h}>

    // Playback loop
    this._rafId    = null;
    this._lastTs   = null;
    this._accumMs  = 0;

    /** Optional callback: called each time the current frame index changes during playback.
     *  Signature: (frameIndex: number, totalFrames: number) => void */
    this.onFrameChange = null;

    this._initGL();
    this._initWorkers();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Load a sorted array of EXR File objects and display frame 0. */
  async load(files, fps = 24) {
    this.pause();
    this._files   = files;
    this._fps     = Math.max(1, fps);
    this._frame   = 0;
    this._accumMs = 0;
    this._cache.clear();
    this._inflight.clear();
    if (files.length > 0) await this.seekFrame(0);
  }

  play() {
    if (this._playing || this._files.length === 0) return;
    this._playing = true;
    this._lastTs  = null;
    this._rafId   = requestAnimationFrame(ts => this._tick(ts));
  }

  pause() {
    this._playing = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._lastTs = null;
  }

  async seekFrame(n) {
    if (this._files.length === 0) return;
    n = Math.max(0, Math.min(n, this._files.length - 1));
    this._frame   = n;
    this._accumMs = 0;
    const frm = await this._getFrame(n);
    if (frm) { this._upload(frm); this._draw(); }
    this._kickPrefetch(n);
  }

  /** Adjust exposure in stops (0 = scene-linear as-is). */
  setExposure(stops) {
    this._exposure = stops;
    if (this._texW > 0) this._draw();
  }

  get currentFrame() { return this._frame; }
  get frameCount()   { return this._files.length; }
  get fps()          { return this._fps; }

  destroy() {
    this.pause();
    this._workers.forEach(w => w.terminate());
    this._workers = [];
    this._free    = [];
    this._jobMap.clear();
    this._queue   = [];
    const gl = this._gl;
    if (gl) {
      if (this._tex)  gl.deleteTexture(this._tex);
      if (this._prog) gl.deleteProgram(this._prog);
      if (this._vao)  gl.deleteVertexArray(this._vao);
    }
    this._gl = null;
  }

  // ── WebGL2 ──────────────────────────────────────────────────────────────────

  _initGL() {
    const gl = this._canvas.getContext('webgl2', {
      alpha: false, antialias: false, premultipliedAlpha: false, depth: false
    });
    if (!gl) throw new Error('ExrSeqPlayer: WebGL2 not available');
    this._gl = gl;

    const vert = _compileShader(gl, gl.VERTEX_SHADER,   VS_SRC);
    const frag = _compileShader(gl, gl.FRAGMENT_SHADER, FS_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert); gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('ExrSeqPlayer: link error: ' + gl.getProgramInfoLog(prog));
    gl.deleteShader(vert); gl.deleteShader(frag);
    this._prog = prog;
    this._uExp = gl.getUniformLocation(prog, 'u_exposure');

    // Fullscreen triangle-pair
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1,  -1,1,
      -1, 1,  1,-1,   1,1
    ]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this._vao = vao;

    this._tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _upload({ rgba, w, h }) {
    const gl = this._gl;
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    if (w !== this._texW || h !== this._texH) {
      // Allocate new storage; also resize canvas to match EXR dimensions
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, rgba);
      this._canvas.width  = w;
      this._canvas.height = h;
      this._texW = w; this._texH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _draw() {
    const gl = this._gl;
    if (!gl || this._texW === 0) return;
    gl.viewport(0, 0, this._texW, this._texH);
    gl.useProgram(this._prog);
    gl.uniform1f(this._uExp, this._exposure);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  // ── Worker pool ─────────────────────────────────────────────────────────────

  _initWorkers() {
    const url = new URL('../workers/exr_decode_worker.js', import.meta.url);
    for (let i = 0; i < WORKER_COUNT; i++) {
      const w = new Worker(url); // classic worker (no ES module syntax in worker)
      w.addEventListener('message', ({ data }) => this._onMsg(i, data));
      w.addEventListener('error',   e           => this._onErr(i, e));
      this._workers.push(w);
      this._free.push(i);
    }
  }

  _onMsg(wi, msg) {
    const job = this._jobMap.get(msg.id);
    if (!job) return;
    this._jobMap.delete(msg.id);
    this._free.push(wi);
    this._drain();
    if (msg.error) job.reject(new Error(msg.error));
    else           job.resolve({ rgba: msg.data, w: msg.width, h: msg.height });
  }

  _onErr(wi, e) {
    // Reject all in-flight jobs and respawn the crashed worker
    for (const [id, job] of this._jobMap) {
      this._jobMap.delete(id);
      job.reject(new Error('EXR worker error'));
    }
    this._free.push(wi);
    try { this._workers[wi].terminate(); } catch {}
    const url = new URL('../workers/exr_decode_worker.js', import.meta.url);
    const w   = new Worker(url);
    w.addEventListener('message', ({ data }) => this._onMsg(wi, data));
    w.addEventListener('error',   ev           => this._onErr(wi, ev));
    this._workers[wi] = w;
  }

  _drain() {
    while (this._free.length > 0 && this._queue.length > 0) {
      const wi   = this._free.pop();
      const task = this._queue.shift();
      this._jobMap.set(task.id, { resolve: task.resolve, reject: task.reject });
      task.file.arrayBuffer().then(buf => {
        this._workers[wi].postMessage({ id: task.id, buffer: buf }, [buf]);
      }).catch(err => {
        this._jobMap.delete(task.id);
        this._free.push(wi);
        task.reject(err);
      });
    }
  }

  _dispatchFile(file) {
    return new Promise((resolve, reject) => {
      const id = ++this._jobSeq;
      this._queue.push({ id, file, resolve, reject });
      this._drain();
    });
  }

  // ── Frame cache ─────────────────────────────────────────────────────────────

  _getFrame(n) {
    if (this._cache.has(n))    return Promise.resolve(this._cache.get(n));
    if (this._inflight.has(n)) return this._inflight.get(n);
    const p = this._dispatchFile(this._files[n]).then(frm => {
      this._inflight.delete(n);
      this._evict();
      this._cache.set(n, frm);
      return frm;
    }).catch(err => {
      this._inflight.delete(n);
      throw err;
    });
    this._inflight.set(n, p);
    return p;
  }

  _evict() {
    if (this._cache.size <= CACHE_MAX) return;
    // Map preserves insertion order — evict the oldest entry
    const oldest = this._cache.keys().next().value;
    this._cache.delete(oldest);
  }

  _kickPrefetch(from) {
    for (let i = 1; i <= PREFETCH; i++) {
      const n = from + i;
      if (n < this._files.length && !this._cache.has(n) && !this._inflight.has(n)) {
        this._getFrame(n).catch(() => {}); // background, ignore failures
      }
    }
  }

  // ── RAF playback loop ───────────────────────────────────────────────────────

  _tick(ts) {
    if (!this._playing) return;
    this._rafId = requestAnimationFrame(t => this._tick(t));

    const elapsed = this._lastTs === null ? 0 : ts - this._lastTs;
    this._lastTs  = ts;
    // Clamp elapsed to prevent runaway accumulation after tab switch etc.
    this._accumMs += Math.min(elapsed, 200);

    const msPerFrame = 1000 / this._fps;
    let frameChanged = false;
    while (this._accumMs >= msPerFrame) {
      this._accumMs -= msPerFrame;
      this._frame = (this._frame + 1) % this._files.length;
      frameChanged = true;
    }
    if (frameChanged && this.onFrameChange)
      this.onFrameChange(this._frame, this._files.length);

    const n = this._frame;
    if (this._cache.has(n)) {
      this._upload(this._cache.get(n));
      this._draw();
    } else if (!this._inflight.has(n)) {
      // Frame missing — decode urgently (may show stale frame briefly)
      this._getFrame(n).then(frm => {
        if (frm && n === this._frame) { this._upload(frm); this._draw(); }
      }).catch(() => {});
    }

    this._kickPrefetch(n);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('ExrSeqPlayer shader compile: ' + gl.getShaderInfoLog(s));
  return s;
}
