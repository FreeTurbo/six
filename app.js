/**
 * app.js —— 高斯泼溅（3D Gaussian Splatting）在线查看器
 * ============================================================================
 * 依赖：
 *   three.js r180        assets/three.module.js
 *   Spark 2.2.0 (MIT)    assets/spark.module.js   （World Labs 的 3DGS 渲染器）
 *   裸说明符由 index.html 里的 importmap 映射，不要改成 CDN，否则离线/内网不可用。
 *
 * 数据流：
 *   assets/model.json   模型清单（名称 / 点数 / 取景范围 / 朝向 / 默认视角）
 *        ↓                ★ 启动时只读这个（几 KB），模型数据按需下载
 *   assets/model.bin    deflate(量化载荷)  ——  格式见 tools/pack.mjs 头部注释
 *        ↓  fetch（带进度）→ DecompressionStream('deflate')
 *   量化载荷 → unpackPly() → 标准 3DGS PLY 的字节流（Float32 布局）
 *        ↓  new SplatMesh({ fileBytes })
 *   Spark 解析 → GPU 上的高斯 → 每帧由 SparkRenderer 排序渲染
 *
 * 模块索引：
 *   [1] 工具函数        错误/提示 / 解压 / 解码 / 去雾 / 兼容降级
 *   [2] 主流程          环境自检 → 清单 → 渲染器 → 相机 → 模型 → 输入 → 界面 → 循环
 *   [3] 兼容性与画质    色彩空间显式声明、像素比上限、首帧色彩自检 + 自动降级
 * ============================================================================
 */

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

/* ==========================================================================
 * [0] 常量
 * ========================================================================== */

const CONFIG_URL = './assets/model.json';

/** 去雾阈值：尺度（对数域）超过它的低透明度高斯会被判为「雾」。exp(-1.6) ≈ 0.2 世界单位。
 *  本项目模型有约 3.3% 这样的点，叠加后会把画面糊成白雾。想调松紧改这一个数即可。 */
const HAZE_LOG_SCALE = -1.6;

/** 首帧色彩自检：高饱和像素占比超过该值就认为渲染异常，自动切到兼容模式。 */
const SATURATION_ALERT = 0.22;
/** 兼容模式偏好的持久化键（用户手动切换过就记住） */
const COMPAT_KEY = 'splat-viewer.compat';

/** 交互灵敏度 */
const ROTATE_SPEED = 0.005;        // 弧度 / 像素
const ZOOM_SPEED = 0.0012;         // 每 wheel delta 的指数系数
const AUTO_ROTATE_SPEED = 0.0025;  // 弧度 / 帧

const $ = (id) => document.getElementById(id);

/* ==========================================================================
 * [1] 工具函数
 * ========================================================================== */

let fatal = false;
/** 统一的致命错误出口：显示可读的错误面板（而不是白屏） */
function fatalError(title, detail, hint) {
  if (fatal) return;
  fatal = true;
  $('errorTitle').textContent = title;
  $('errorDetail').innerHTML = detail || '';
  $('errorHint').innerHTML = hint || '';
  $('error').classList.add('show');
  $('loading').classList.add('hide');
  console.error('[viewer]', title, detail);
}

/** 轻量提示条 */
let toastTimer = 0;
function showToast(msg, ms = 4200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const setStatus = (text, pct) => {
  $('status').textContent = text;
  if (pct != null) $('bar').style.width = (Math.max(0, Math.min(1, pct)) * 100).toFixed(1) + '%';
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 下载 + deflate 解压 assets/*.bin（带进度回调） */
async function fetchDeflated(url, onProgress) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('模型数据下载失败：HTTP ' + res.status + ' ' + res.statusText);
  const total = Number(res.headers.get('content-length') || 0);
  let raw;
  if (!res.body || !total) {
    raw = new Uint8Array(await res.arrayBuffer());
    onProgress && onProgress(1);
  } else {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress && onProgress(Math.min(1, loaded / total));
    }
    raw = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) { raw.set(c, off); off += c.length; }
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 DecompressionStream，请使用较新的 Chrome / Edge / Safari');
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * unpackPly —— 量化载荷 → 标准 3DGS PLY 字节流
 * 载荷格式见 tools/pack.mjs 头部注释；读取顺序必须与 pack.mjs 的 GROUPS 完全一致。
 */
function unpackPly(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const metaLen = dv.getUint32(p, true); p += 4;
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(p, p + metaLen))); p += metaLen;
  const nRange = dv.getUint32(p, true); p += 4;
  const ranges = new Float64Array(nRange * 2);
  for (let i = 0; i < nRange * 2; i++) { ranges[i] = dv.getFloat32(p, true); p += 4; }
  const rec = buf.subarray(p);

  const { props, count } = meta;
  const stride = props.length;
  const off = {};                                   // 属性名 → 该点记录内的 float 下标
  for (let i = 0; i < stride; i++) off[props[i]] = i;

  const headerBytes = new TextEncoder().encode(meta.header);
  const floats = new Float32Array(count * stride);

  /* 预先把每个 group 的属性下标与范围下标解开，避免在百万级循环里做字符串查表 */
  const groups = meta.groups.map((g) => ({
    type: g.type,
    idx: Int32Array.from(g.props, (n) => off[n]),
    rb: g.range == null ? -1 : g.range
  }));

  let q = 0;
  for (let k = 0; k < count; k++) {
    const fo = k * stride;
    for (let gi = 0; gi < groups.length; gi++) {
      const { type, idx, rb } = groups[gi];
      for (let j = 0; j < idx.length; j++) {
        let val, lo, hi;
        if (type === 'u24') {
          val = rec[q] | (rec[q + 1] << 8) | (rec[q + 2] << 16); q += 3;
          lo = ranges[(rb + j) * 2]; hi = ranges[(rb + j) * 2 + 1];
          floats[fo + idx[j]] = lo + (val / 16777215) * (hi - lo);
        } else if (type === 'u16') {
          val = rec[q] | (rec[q + 1] << 8); q += 2;
          lo = ranges[(rb + j) * 2]; hi = ranges[(rb + j) * 2 + 1];
          floats[fo + idx[j]] = lo + (val / 65535) * (hi - lo);
        } else if (type === 'q8') {
          floats[fo + idx[j]] = rec[q++] / 127.5 - 1;   // 旋转：固定 [-1,1]
        } else {
          val = rec[q++];
          lo = ranges[(rb + j) * 2]; hi = ranges[(rb + j) * 2 + 1];
          floats[fo + idx[j]] = lo + (val / 255) * (hi - lo);
        }
      }
    }
  }

  /* 旋转重新归一化（8bit 量化后模长会偏离 1，不归一化高斯会被拉长） */
  const ro = off['rot_0'];
  for (let k = 0; k < count; k++) {
    const b = k * stride + ro;
    const x = floats[b], y = floats[b + 1], z = floats[b + 2], w = floats[b + 3];
    const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    floats[b] = x / len; floats[b + 1] = y / len; floats[b + 2] = z / len; floats[b + 3] = w / len;
  }

  const out = new Uint8Array(headerBytes.length + floats.byteLength);
  out.set(headerBytes, 0);
  out.set(new Uint8Array(floats.buffer), headerBytes.length);
  return out;
}

/* ------------------------------------------------- 解码（可放 Worker） */
/* unpackPly 是纯函数、不引用外部变量，所以可以直接把源码塞进 Worker 里跑，
   避免 20~30 万点的解码卡住主线程的动画与交互（手机上尤其明显）。
   Worker 创建失败时自动退回主线程。 */
let decodeWorker = null, decodeSeq = 0;
function getDecodeWorker() {
  if (decodeWorker !== null) return decodeWorker;
  try {
    const src = 'const unpackPly=' + unpackPly.toString() + ';\n' +
      'self.onmessage=function(e){var d=e.data;try{' +
      'var out=unpackPly(new Uint8Array(d.buf));' +
      'self.postMessage({id:d.id,ok:true,buf:out.buffer},[out.buffer]);' +
      '}catch(err){self.postMessage({id:d.id,ok:false,msg:String((err&&err.message)||err)});}};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    decodeWorker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[viewer] 无法创建解码 Worker，退回主线程：', e);
    decodeWorker = false;
  }
  return decodeWorker;
}
function decodePayload(payload) {
  const w = getDecodeWorker();
  if (!w) return Promise.resolve(unpackPly(payload));
  return new Promise((resolve, reject) => {
    const id = ++decodeSeq;
    const onMsg = (ev) => {
      if (!ev.data || ev.data.id !== id) return;
      w.removeEventListener('message', onMsg);
      if (ev.data.ok) resolve(new Uint8Array(ev.data.buf));
      else reject(new Error(ev.data.msg));
    };
    w.addEventListener('message', onMsg);
    /* 独占整块 ArrayBuffer 时直接转移（零拷贝），否则先切一份再转移 */
    let transfer = payload.buffer;
    if (payload.byteOffset !== 0 || payload.byteLength !== payload.buffer.byteLength) {
      transfer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    }
    w.postMessage({ id, buf: transfer }, [transfer]);
  });
}

/* ------------------------------------------------------- PLY 表头解析 */
const TYPE_SIZE = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, char: 1, int8: 1, int: 4, int32: 4, uint: 4, uint32: 4, short: 2, int16: 2, ushort: 2, uint16: 2 };

/** 解析 PLY 文本头，得到属性名与字节偏移（按 header 里的声明顺序） */
function plyLayout(u8) {
  let head = '';
  const lim = Math.min(u8.length, 65536);
  for (let i = 0; i < lim; i++) head += String.fromCharCode(u8[i]);
  const at = head.indexOf('end_header');
  if (at < 0) return null;
  const nl = head.indexOf('\n', at);
  if (nl < 0) return null;
  const header = head.slice(0, nl + 1);
  const props = [];
  const re = /^property\s+(\w+)\s+(\S+)/gm;
  let m;
  while ((m = re.exec(header))) props.push({ type: m[1], name: m[2] });
  const cm = /element\s+vertex\s+(\d+)/.exec(header);
  if (!cm) return null;
  const offsets = {};
  let off = 0;
  for (const pr of props) { offsets[pr.name] = off; off += (TYPE_SIZE[pr.type] || 4); }
  return { header, props, count: parseInt(cm[1], 10), stride: off, offsets, dataStart: nl + 1 };
}

/**
 * 兼容模式：把球谐系数（f_rest_*）全部清零，等价于「只用 DC 颜色」。
 * 为什么需要：球谐承载视角相关颜色，要在着色器里按视线方向求值，
 * 对 GPU 的浮点精度/纹理路径更敏感；个别安卓机型会把这一项算花，
 * 表现为整屏彩虹色（几何却是对的）。清零后退化成最稳的逐点固定颜色。
 */
function stripSh(u8) {
  const L = plyLayout(u8);
  if (!L) return null;
  const restOff = L.props.filter((p) => /^f_rest_\d+$/.test(p.name)).map((p) => L.offsets[p.name]);
  if (!restOff.length) return null;
  const copy = u8.slice();
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let k = 0; k < L.count; k++) {
    const base = L.dataStart + k * L.stride;
    for (let j = 0; j < restOff.length; j++) dv.setFloat32(base + restOff[j], 0, true);
  }
  return copy;
}

/**
 * 去雾：丢掉「超大低透明度」高斯（三轴对数尺度最大值 > maxLogScale）。
 * 返回 { bytes, count, total }。
 */
function filterHaze(u8, maxLogScale) {
  const L = plyLayout(u8);
  if (!L || L.offsets.scale_0 === undefined) return null;
  const so = [L.offsets.scale_0, L.offsets.scale_1, L.offsets.scale_2];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const keep = new Uint8Array(L.count);
  let kept = 0;
  for (let k = 0; k < L.count; k++) {
    const base = L.dataStart + k * L.stride;
    let mx = -1e30;
    for (let j = 0; j < 3; j++) { const v = dv.getFloat32(base + so[j], true); if (v > mx) mx = v; }
    if (mx <= maxLogScale) { keep[k] = 1; kept++; }
  }
  const header = L.header.replace(/element\s+vertex\s+\d+/, 'element vertex ' + kept);
  const hb = new TextEncoder().encode(header);
  const out = new Uint8Array(hb.length + kept * L.stride);
  out.set(hb, 0);
  let w = hb.length;
  for (let k = 0; k < L.count; k++) {
    if (!keep[k]) continue;
    out.set(u8.subarray(L.dataStart + k * L.stride, L.dataStart + (k + 1) * L.stride), w);
    w += L.stride;
  }
  return { bytes: out, count: kept, total: L.count };
}

/* ==========================================================================
 * [2] 主流程
 * ========================================================================== */

const app = {
  models: [],          // 来自 model.json
  state: [],           // 每个模型的运行期状态（懒加载：未切换到的模型保持为空）
  current: -1,
  compat: false,       // 兼容模式（关闭球谐）
  cleanMode: false,    // 去雾开关
  busy: false,
  autoRotate: false,
  hintHidden: false,
  checked: false       // 是否已做过首帧色彩自检
};

async function main() {
  /* ------------------------------------------------------ [2.1] 环境自检 */
  if (location.protocol === 'file:') {
    /* 正常情况下这段不会执行到：file:// 下模块脚本已被浏览器拦下，
       提示由 index.html 里的内联脚本给出。这里兜底 Firefox 等
       「允许 file:// 加载模块、但 fetch 仍被拦截」的浏览器。 */
    if (window.__showProtocolHelp) window.__showProtocolHelp();
    return;
  }

  /* ------------------------------------------------------ [2.2] 模型清单 */
  let cfg;
  try {
    const res = await fetch(CONFIG_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    cfg = await res.json();
  } catch (e) {
    fatalError('读不到模型清单',
      '无法加载 <code>' + CONFIG_URL + '</code>：' + (e.message || e),
      '确认文件存在，且是用 <code>tools/build.mjs</code> 生成后一起提交的。');
    return;
  }
  app.models = (cfg.models || []).filter((m) => m && m.file);
  /* 每个模型两档：lite（预览，体积约 1/8）/ full（完整）。未切换到的模型两档都是空的。 */
  app.state = app.models.map(() => ({
    lite: { mesh: null, bytes: null },
    full: { mesh: null, bytes: null },
    active: null,          // 当前显示的档位 'lite' | 'full'
    upgrading: false,      // 是否正在后台升级到完整档
    noSh: {},              // 兼容模式副本缓存 { full: Uint8Array }
    clean: null, cleanCount: 0, cleanFrom: null   // 去雾副本及其来源档位
  }));
  if (!app.models.length) {
    fatalError('模型清单是空的', '<code>assets/model.json</code> 里没有任何模型条目。',
      '用 <code>node tools/build.mjs 你的模型.ply</code> 生成一个。');
    return;
  }
  app.compat = readCompatPref();

  /* --------------------------------------------- [2.3] 渲染器与色彩空间 */
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    /* 不用 high-performance：部分安卓会因此走到有问题的驱动路径 */
    powerPreference: 'default',
    preserveDrawingBuffer: false,
    stencil: false
  });
  renderer.setPixelRatio(pickPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 1);
  /* 显式声明色彩空间：个别设备/浏览器对画布的色彩空间处理不一致，
     会导致整屏偏色（把原本的雾状高斯放大成彩虹）。这里固定为 sRGB。 */
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const gl = renderer.getContext();
  try { if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb'; } catch (e) { /* 老浏览器忽略 */ }
  try { if ('unpackColorSpace' in gl) gl.unpackColorSpace = 'srgb'; } catch (e) { /* 老浏览器忽略 */ }
  logGpuInfo(gl);
  $('stage').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 3000);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  /* ------------------------------------------------------ [2.4] 相机 */
  /* 用「偏移向量 + 上方向」而不是欧拉角，这样可以无限制地自由旋转
     （球坐标的 phi 会被卡在天顶/天底，翻过头顶还会突然跳变）。 */
  const cam = {
    target: new THREE.Vector3(),
    offset: new THREE.Vector3(0, 0, 1),   // target → 相机
    up: new THREE.Vector3(0, 1, 0),
    minRadius: 0.1,
    maxRadius: 1000
  };
  const HOME_OFFSET = new THREE.Vector3();
  const HOME_UP = new THREE.Vector3(0, 1, 0);

  function applyCamera() {
    camera.up.copy(cam.up);
    camera.position.copy(cam.target).add(cam.offset);
    camera.lookAt(cam.target);
  }
  /** 球坐标摆位（仅用于初始取景 / 重置 / 自动化测试） */
  function setView(theta, phi, r) {
    const sp = Math.sin(phi);
    cam.offset.set(r * sp * Math.sin(theta), r * Math.cos(phi), r * sp * Math.cos(theta));
    cam.up.set(0, 1, 0);
    applyCamera();
  }
  const _q = new THREE.Quaternion(), _qs = new THREE.Quaternion();
  const _up = new THREE.Vector3(), _right = new THREE.Vector3();
  /** 自由轨道旋转：绕相机自身的上/右轴转动，无角度限制、无翻转跳变 */
  function orbit(dx, dy) {
    _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    _qs.setFromAxisAngle(_up, -dx * ROTATE_SPEED);
    _q.setFromAxisAngle(_right, -dy * ROTATE_SPEED);
    _qs.multiply(_q);
    cam.offset.applyQuaternion(_qs);
    cam.up.applyQuaternion(_qs).normalize();
    applyCamera();
  }
  function zoomBy(factor) {
    const r = Math.max(cam.minRadius, Math.min(cam.maxRadius, cam.offset.length() * factor));
    cam.offset.setLength(r);
    applyCamera();
  }
  /** 平移：沿屏幕右/上方向移动观察目标 */
  function pan(dx, dy) {
    const scale = cam.offset.length() * Math.tan((camera.fov * Math.PI / 180) / 2) * 2 / window.innerHeight;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    cam.target.addScaledVector(right, -dx * scale);
    cam.target.addScaledVector(up, dy * scale);
    applyCamera();
  }

  /* ------------------------------------------------- [2.5] 模型管理 */
  /**
   * 模型朝向四元数（按模型缓存）。
   * 优先用 model.json 里的 `orient`（xyzw 四元数，能表达任意朝向修正）；
   * 没有就退回 `flipX`（绕 X 轴 180° —— Brush 导出的 PLY 在 Spark 里默认上下颠倒）。
   * orient 的来历与计算方法见 README 6.2。
   */
  const _orientCache = [];
  function modelQuat(i) {
    if (!_orientCache[i]) {
      const m = app.models[i];
      const q = new THREE.Quaternion();
      if (Array.isArray(m.orient) && m.orient.length === 4) q.fromArray(m.orient);
      else if (m.flipX) q.set(1, 0, 0, 0);
      _orientCache[i] = q;
    }
    return _orientCache[i];
  }

  /** 取景 + 应用朝向修正 */
  function frameModel(i) {
    const m = app.models[i];
    const sz = m.frame.size;
    /* 朝向修正会把整个模型转过去，取景中心要跟着转（纯旋转不改变包围盒尺寸） */
    cam.target.set(m.frame.center[0], m.frame.center[1], m.frame.center[2]).applyQuaternion(modelQuat(i));

    const rad = Math.max(sz[0], sz[1], sz[2]) * 0.5 || 1;
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.6, camera.aspect));
    const fit = Math.max((sz[1] / 2) / Math.tan(vFov / 2), (sz[0] / 2) / Math.tan(hFov / 2)) * 1.06 + sz[2] * 0.25;

    cam.minRadius = rad * 0.02;
    cam.maxRadius = rad * 60;
    setView(m.yaw != null ? m.yaw : Math.PI, m.pitch != null ? m.pitch : 1.5, fit);
    HOME_OFFSET.copy(cam.offset);
    HOME_UP.set(0, 1, 0);
  }

  function applyVisibility() {
    for (let i = 0; i < app.state.length; i++) {
      const st = app.state[i];
      const isCur = i === app.current;
      const cleanOn = isCur && app.cleanMode && !!st.clean && st.cleanFrom === st.active;
      for (const tier of ['lite', 'full']) {
        if (st[tier].mesh) st[tier].mesh.visible = isCur && st.active === tier && !cleanOn;
      }
      if (st.clean) st.clean.visible = cleanOn;
    }
  }

  /** HUD 文案：点数 + 当前档位/去雾/兼容状态 */
  function updateHud() {
    if (app.current < 0) return;
    const m = app.models[app.current];
    const st = app.state[app.current];
    const lite = st.active === 'lite';
    const n = (app.cleanMode && st.clean) ? st.cleanCount : (lite ? (m.liteCount || m.count) : m.count);
    const tags = [];
    if (app.cleanMode && st.clean) tags.push('已去雾');
    if (app.compat && !lite) tags.push('兼容模式');
    if (lite) tags.push(st.upgrading ? '预览 · 正在加载高清' : '预览');
    $('count').textContent = n.toLocaleString('en-US') + ' 个高斯点' + (tags.length ? ' · ' + tags.join(' · ') : '');
    const rows = $('mlist').children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('on', i === app.current);
  }

  /** 列表行右侧的小字：点数 / 下载进度 */
  function setRowMeta(i, text) {
    const row = $('mlist').children[i];
    if (!row) return;
    const el = row.querySelector('.mmeta');
    if (el) el.textContent = text;
  }
  function defaultRowMeta(i) {
    const m = app.models[i];
    setRowMeta(i, m.count.toLocaleString('en-US') + ' 点');
  }

  /**
   * 取某一档的字节流（需要时先下载 + 解码）。
   * tier = 'lite'（预览，约 1/8 体积）或 'full'（完整精度）。
   */
  async function loadTierBytes(i, tier, onProgress) {
    const st = app.state[i];
    const slot = st[tier];
    if (slot.bytes) return slot.bytes;
    const file = tier === 'lite' ? app.models[i].fileLite : app.models[i].file;
    const payload = await fetchDeflated(file, onProgress);
    slot.bytes = await decodePayload(payload);
    return slot.bytes;
  }

  /** 用某一档的字节流构建 SplatMesh（不销毁其它档位，便于瞬时切换） */
  async function buildTierMesh(i, tier) {
    const st = app.state[i];
    const m = app.models[i];
    const slot = st[tier];
    if (slot.mesh) return slot.mesh;

    let bytes = slot.bytes;
    /* 兼容模式：完整档的球谐清零（预览档本来就没有球谐） */
    if (app.compat && tier === 'full') {
      bytes = st.noSh.full || (st.noSh.full = stripSh(bytes));
    }
    const mesh = new SplatMesh({ fileBytes: bytes, fileName: m.name + '-' + tier + '.ply' });
    /* 朝向修正：绕 X 轴 180°（Brush 导出的 PLY 在 Spark 里默认上下颠倒，见 README 6.2） */
    mesh.quaternion.copy(modelQuat(i));
    /* 先隐藏：构建期间新旧两档会同时在场景里，避免叠加出重影 */
    mesh.visible = false;
    scene.add(mesh);

    if (mesh.initialized && typeof mesh.initialized.then === 'function') {
      try { await mesh.initialized; } catch (e) { throw new Error('高斯点云解析失败：' + ((e && e.message) || e)); }
    } else {
      await wait(2500);
    }
    let got = 0;
    try { got = mesh.getNumSplats ? mesh.getNumSplats() : 0; } catch (e) { got = 0; }
    if (!got && mesh.packedSplats) got = mesh.packedSplats.numSplats || 0;
    if (!got) throw new Error('高斯点云解析失败：结果为 0 个点（检查 PLY 表头与 f_rest 编号是否连续）');

    slot.mesh = mesh;
    return mesh;
  }

  function disposeTier(i, tier) {
    const slot = app.state[i][tier];
    if (slot.mesh) { scene.remove(slot.mesh); try { slot.mesh.dispose(); } catch (e) { } slot.mesh = null; }
    slot.bytes = null;
  }

  /**
   * 是否需要自动升级到完整档。
   * 尊重「省流量」设置与极慢的网络：这类情况下只加载预览档。
   */
  function shouldAutoUpgrade() {
    if (location.hash.indexOf('nolazy') >= 0) return true;    // 调试用：跳过预览档策略
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) {
      if (c.saveData) return false;
      if (/^(slow-2g|2g)$/.test(c.effectiveType || '')) return false;
    }
    return true;
  }

  /** 后台把预览档升级为完整档：不阻塞操作，构建完成后无缝替换 */
  async function upgradeToFull(i, silent) {
    const st = app.state[i];
    const m = app.models[i];
    if (!m.fileLite || st.full.mesh || st.upgrading) return;
    st.upgrading = true;
    updateHud();
    try {
      await loadTierBytes(i, 'full', (p) => setRowMeta(i, '高清 ' + Math.round(p * 100) + '%'));
      setRowMeta(i, '准备中…');
      await buildTierMesh(i, 'full');
      st.active = 'full';
      /* 预览档用完即弃，省内存与显存 */
      disposeTier(i, 'lite');
      if (app.cleanMode) await rebuildClean();
      applyVisibility();
      updateHud();
      /* 首次拿到完整档时做一次色彩自检（预览档没有球谐，检查没意义） */
      if (!app.checked) { app.checked = true; await firstFrameCheck(); }
      if (!silent && app.current === i) showToast('已切换为完整精度', 2200);
    } catch (e) {
      console.warn('[viewer] 后台升级失败，继续使用预览档：', e);
    }
    st.upgrading = false;
    defaultRowMeta(i);
    updateHud();
  }

  /** 切换 / 首次加载模型：优先用预览档快速出画面，随后后台升级 */
  async function selectModel(i, first) {
    if (app.busy || (i === app.current && !first) || !app.models[i]) return;
    app.busy = true;
    const m = app.models[i];
    const st = app.state[i];
    const row = $('mlist').children[i];
    const needLoad = !st.lite.mesh && !st.full.mesh;
    if (needLoad) { showLoading('正在加载「' + m.name + '」'); row && row.classList.add('busy'); }
    try {
      if (needLoad) {
        /* 有预览档就先上预览档：约 1 MB，手机也能秒开 */
        if (m.fileLite) {
          setStatus('正在下载预览…', 0.05);
          await loadTierBytes(i, 'lite', (p) => setStatus('正在下载预览…', 0.05 + p * 0.7));
          setStatus('正在构建高斯…', 0.8);
          await nextFrame();
          await buildTierMesh(i, 'lite');
          st.active = 'lite';
        } else {
          setStatus('正在下载模型数据…', 0.05);
          await loadTierBytes(i, 'full', (p) => setStatus('正在下载模型数据…', 0.05 + p * 0.7));
          setStatus('正在构建高斯…', 0.8);
          await nextFrame();
          await buildTierMesh(i, 'full');
          st.active = 'full';
        }
      }
      app.current = i;
      frameModel(i);
      if (!first) app.cleanMode = false;
      syncButtons();
      applyVisibility();
      updateHud();
      document.title = m.name + ' · 高斯泼溅模型展示';
      if (needLoad && !app.checked) { app.checked = true; await firstFrameCheck(); }
    } catch (e) {
      fatalError('模型加载失败', (e && e.message) || String(e),
        '检查 <code>' + (app.models[i].file || '') + '</code> 是否完整、是否与 <code>model.json</code> 配套。');
    }
    row && row.classList.remove('busy');
    app.busy = false;
    if (needLoad) hideLoading();
    /* 首屏已经出来了，再开始后台拉完整档 */
    if (st.active === 'lite' && !st.full.mesh && shouldAutoUpgrade()) upgradeToFull(i);
  }

  /**
   * [3] 首帧色彩自检 —— 个别机型会把球谐算花（几何正常、颜色变成彩虹）。
   *
   * 关键点：**不能只看绝对饱和度**。这个模型本身偏雾、竖屏取景时整屏都是彩色，
   * 直接卡阈值会误判。所以采用「自身对照」：
   *   1. 先量一次当前（带球谐）画面的高饱和像素占比 s1；
   *   2. 只有 s1 偏高时才额外构建一份「清空球谐」的同一模型，量出 s2；
   *   3. 仅当 s2 明显比 s1 干净（< 60%）才判定为显卡把球谐算坏了，切到兼容模式。
   * 这样彩色模型不会误伤，坏掉的设备也一定能被识别出来。
   */
  async function firstFrameCheck() {
    if (location.hash.indexOf('nocheck') >= 0) return;
    const i = app.current;
    const st = app.state[i];
    const slot = st.full;
    if (app.compat || st.active !== 'full' || !slot.mesh || !slot.bytes) return;

    const s1 = measureSaturation();
    if (s1 == null || s1 <= SATURATION_ALERT) return;          // 画面看着正常
    console.warn('[viewer] 首帧高饱和像素 ' + (s1 * 100).toFixed(1) + '%，做对照检测…');

    let probe = null;
    try {
      const noSh = st.noSh.full || (st.noSh.full = stripSh(slot.bytes));
      probe = new SplatMesh({ fileBytes: noSh, fileName: app.models[i].name + '-probe.ply' });
      probe.quaternion.copy(modelQuat(i));
      probe.visible = false;
      scene.add(probe);
      if (probe.initialized && typeof probe.initialized.then === 'function') await probe.initialized;
      else await wait(2500);
      slot.mesh.visible = false;
      probe.visible = true;
      const s2 = measureSaturation();
      console.warn('[viewer] 对照：带球谐 ' + (s1 * 100).toFixed(1) + '% vs 无球谐 ' + (s2 == null ? '?' : (s2 * 100).toFixed(1) + '%'));
      if (s2 != null && s2 < s1 * 0.6) {
        /* 确认是球谐被算坏：直接复用这份对照网格作为兼容版本 */
        scene.remove(slot.mesh);
        try { slot.mesh.dispose(); } catch (e) { }
        slot.bytes = noSh;
        slot.mesh = probe;
        probe = null;
        app.compat = true;
        writeCompatPref(true);
        if (st.clean) { scene.remove(st.clean); try { st.clean.dispose(); } catch (e) { } st.clean = null; app.cleanMode = false; }
        syncButtons(); applyVisibility(); updateHud();
        showToast('检测到显卡渲染异常，已自动开启「兼容模式」（关闭视角相关颜色）', 6500);
      } else {
        /* 只是画面本身色彩丰富，恢复原样 */
        probe.visible = false;
        scene.remove(probe);
        try { probe.dispose(); } catch (e) { }
        probe = null;
        slot.mesh.visible = true;
        applyVisibility();
      }
    } catch (e) {
      console.warn('[viewer] 对照检测失败：', e);
      if (probe) { scene.remove(probe); try { probe.dispose(); } catch (e2) { } }
      if (slot.mesh) slot.mesh.visible = st.active === 'full';
      applyVisibility();
    }
  }

  /** 抽样读取画布像素，返回高饱和像素占比（0~1）；读取失败返回 null */
  function measureSaturation() {
    try {
      renderer.render(scene, camera);          // 保证当前帧已绘制
      const W = renderer.domElement.width, H = renderer.domElement.height;
      const tile = 32;
      const px = new Uint8Array(tile * tile * 4);
      const pts = [[0.2, 0.2], [0.5, 0.2], [0.8, 0.2], [0.2, 0.5], [0.5, 0.5], [0.8, 0.5], [0.2, 0.8], [0.5, 0.8], [0.8, 0.8]];
      let sat = 0, n = 0;
      for (const [fx, fy] of pts) {
        const x = Math.max(0, Math.min(W - tile, Math.round(W * fx - tile / 2)));
        const y = Math.max(0, Math.min(H - tile, Math.round(H * fy - tile / 2)));
        gl.readPixels(x, y, tile, tile, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < tile * tile; i++) {
          const o = i * 4;
          const mx = Math.max(px[o], px[o + 1], px[o + 2]);
          const mn = Math.min(px[o], px[o + 1], px[o + 2]);
          if (mx > 40 && mx - mn > 90) sat++;
          n++;
        }
      }
      return n ? sat / n : null;
    } catch (e) {
      console.warn('[viewer] 色彩自检失败：', e);
      return null;
    }
  }

  /** 兼容模式开关（手动）：只影响完整档（预览档本来就没有球谐） */
  async function setCompat(on, silent) {
    if (app.busy || app.current < 0 || app.compat === on) { syncButtons(); return; }
    const i = app.current, st = app.state[i];
    /* 预览档没有球谐可关，直接记住偏好即可 */
    if (st.active !== 'full' || !st.full.bytes) {
      app.compat = on;
      writeCompatPref(on);
      syncButtons(); updateHud();
      if (!silent) showToast(on ? '已开启兼容模式（将在加载完整精度时生效）' : '已关闭兼容模式');
      return;
    }
    app.busy = true;
    app.compat = on;
    showLoading(on ? '正在生成兼容版本' : '正在恢复');
    await nextFrame();
    try {
      const slot = st.full;
      if (on) {
        slot.bytes = st.noSh.full || (st.noSh.full = stripSh(slot.bytes));
      } else {
        /* 关掉兼容：重新下载/解码一次原始完整档（副本已释放） */
        slot.bytes = null;
        await loadTierBytes(i, 'full');
        st.noSh.full = null;
      }
      if (slot.mesh) { scene.remove(slot.mesh); try { slot.mesh.dispose(); } catch (e) { } slot.mesh = null; }
      await buildTierMesh(i, 'full');
    } catch (e) {
      fatalError('兼容模式切换失败', (e && e.message) || String(e));
    }
    writeCompatPref(app.compat);
    if (st.clean) { scene.remove(st.clean); try { st.clean.dispose(); } catch (e) { } st.clean = null; app.cleanMode = false; }
    syncButtons(); applyVisibility(); updateHud();
    hideLoading();
    app.busy = false;
    if (!silent) showToast(app.compat ? '已开启兼容模式：关闭视角相关颜色，画面更稳但略平' : '已关闭兼容模式');
  }

  /** 去雾开关：懒生成过滤后的副本（基于当前显示的档位） */
  async function setClean(on) {
    if (app.busy || app.current < 0) return;
    const i = app.current, st = app.state[i];
    if (on && (!st.clean || st.cleanFrom !== st.active) && st[st.active] && st[st.active].bytes) {
      app.busy = true;
      const btn = $('btn-clean');
      btn.classList.add('busy');
      await nextFrame();
      if (st.clean) { scene.remove(st.clean); try { st.clean.dispose(); } catch (e) { } st.clean = null; }
      const res = filterHaze(st[st.active].bytes, HAZE_LOG_SCALE);
      if (res) {
        st.cleanCount = res.count;
        st.cleanFrom = st.active;
        const mesh = new SplatMesh({ fileBytes: res.bytes, fileName: 'clean.ply' });
        mesh.quaternion.copy(modelQuat(i));
        scene.add(mesh);
        st.clean = mesh;
        if (mesh.initialized && typeof mesh.initialized.then === 'function') {
          try { await mesh.initialized; } catch (e) { /* 失败则回落到原始模型 */ }
        } else { await wait(2500); }
      }
      btn.classList.remove('busy');
      app.busy = false;
    }
    app.cleanMode = !!on && !!st.clean;
    syncButtons(); applyVisibility(); updateHud();
  }

  /** 档位切换后重建去雾副本（升级到完整档时用） */
  async function rebuildClean() {
    const st = app.state[app.current];
    if (!st.clean) return;
    scene.remove(st.clean);
    try { st.clean.dispose(); } catch (e) { }
    st.clean = null;
    const was = app.cleanMode;
    app.cleanMode = false;
    if (was) await setClean(true);
  }

  function syncButtons() {
    $('btn-clean').classList.toggle('on', app.cleanMode);
    $('btn-clean').setAttribute('aria-pressed', app.cleanMode ? 'true' : 'false');
    $('btn-compat').classList.toggle('on', app.compat);
    $('btn-compat').setAttribute('aria-pressed', app.compat ? 'true' : 'false');
    $('btn-auto').classList.toggle('on', app.autoRotate);
  }

  /* --------------------------------------------------- [2.6] 加载遮罩 */
  function showLoading(text) {
    const el = $('loading');
    el.style.display = 'flex';
    setStatus(text || '正在准备…', 0.01);
    requestAnimationFrame(() => el.classList.remove('hide'));
  }
  function hideLoading() {
    const el = $('loading');
    el.classList.add('hide');
    setTimeout(() => { el.style.display = 'none'; }, 700);
  }

  /* ------------------------------------------------------ [2.7] 输入 */
  const el = renderer.domElement;
  const pointers = new Map();
  let dragging = false;
  let mode = 0;               // 1 = 旋转, 2 = 平移, 3 = 双指
  const last = { x: 0, y: 0 };
  let pinchDist = 0;

  const list = () => Array.from(pointers.values());
  const twoDist = () => { const p = list(); return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
  const twoMid = () => { const p = list(); return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }; };

  /* 右键完全不参与交互：Edge 会把右键拖拽识别成“手势”，体验冲突。
     平移改为：鼠标中键 / Shift + 左键 / 触屏双指。 */
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;               // 右键：不做任何事
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragging = true;
      el.classList.add('dragging');
      mode = (e.button === 1 || e.shiftKey) ? 2 : 1;
      last.x = e.clientX; last.y = e.clientY;
      hideHint();
    } else if (pointers.size === 2) {
      mode = 3;
      pinchDist = twoDist();
      const mid = twoMid();
      last.x = mid.x; last.y = mid.y;
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 3 && pointers.size >= 2) {
      const d = twoDist();
      if (pinchDist > 0 && d > 1) zoomBy(pinchDist / d);
      pinchDist = d;
      const mid = twoMid();
      pan(mid.x - last.x, mid.y - last.y);
      last.x = mid.x; last.y = mid.y;
      return;
    }
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    last.x = e.clientX; last.y = e.clientY;
    if (mode === 1) orbit(dx, dy);
    else if (mode === 2) pan(dx, dy);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) { dragging = false; mode = 0; el.classList.remove('dragging'); }
    else if (pointers.size === 1) {
      mode = 1;
      const p = list()[0];
      last.x = p.x; last.y = p.y;
    }
  }
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(Math.exp(e.deltaY * ZOOM_SPEED));
  }, { passive: false });

  el.addEventListener('dblclick', () => resetView());   // 触屏用户没有 R 键

  function resetView() {
    cam.offset.copy(HOME_OFFSET);
    cam.up.copy(HOME_UP);
    applyCamera();
  }
  function hideHint() {
    if (app.hintHidden) return;
    app.hintHidden = true;
    $('hint').classList.add('fade');
  }

  /* ------------------------------------------------------- [2.8] 界面 */
  $('btn-reset').addEventListener('click', resetView);
  $('btn-auto').addEventListener('click', () => {
    app.autoRotate = !app.autoRotate;
    syncButtons();
  });
  $('btn-clean').addEventListener('click', () => setClean(!app.cleanMode));
  $('btn-compat').addEventListener('click', () => setCompat(!app.compat));
  $('btn-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'r' || e.key === 'R') resetView();
    else if (e.key === ' ') { e.preventDefault(); $('btn-auto').click(); }
    else if (e.key === 'f' || e.key === 'F') $('btn-full').click();
  });

  /* 触屏 / 鼠标分别给不同的操作提示 */
  const isTouch = matchMedia('(hover: none)').matches || 'ontouchstart' in window;
  $('hint').textContent = isTouch
    ? '单指旋转 · 双指缩放 / 平移 · 双击复位'
    : '左键拖拽旋转 · 滚轮缩放 · 中键或 Shift+左键平移 · 空格自动旋转';

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pickPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ------------------------------------------- [2.9] 玻璃高光跟随指针 */
  document.querySelectorAll('.glass').forEach((panel) => {
    panel.addEventListener('pointermove', (e) => {
      const r = panel.getBoundingClientRect();
      panel.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      panel.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
    });
    panel.addEventListener('pointerleave', () => {
      panel.style.setProperty('--mx', '50%');
      panel.style.setProperty('--my', '0%');
    });
  });

  /* --------------------------------------------------- [2.10] 渲染循环 */
  renderer.setAnimationLoop(() => {
    if (app.autoRotate && !dragging) {
      _q.setFromAxisAngle(cam.up, AUTO_ROTATE_SPEED);
      cam.offset.applyQuaternion(_q);
      applyCamera();
    }
    renderer.render(scene, camera);
    if (!app.hintHidden && performance.now() > 9000) hideHint();
  });

  /* ------------------------------------------------ [2.11] 模型列表 UI */
  /* 列表按 model.json 生成；模型数据不在启动时下载，点哪一行才加载哪一行。 */
  app.models.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mrow';
    b.setAttribute('role', 'option');
    b.title = m.name + '（' + m.count.toLocaleString('en-US') + ' 个高斯点）';
    const dot = document.createElement('span'); dot.className = 'mdot';
    const box = document.createElement('span'); box.className = 'mtext';
    const nm = document.createElement('span'); nm.className = 'mname'; nm.textContent = m.name;
    const mt = document.createElement('span'); mt.className = 'mmeta';
    mt.textContent = m.count.toLocaleString('en-US') + ' 点';
    box.append(nm, mt);
    b.append(dot, box);
    b.addEventListener('click', () => selectModel(i));
    $('mlist').appendChild(b);
  });

  /* ------------------------------------------------ [2.12] 调试接口 */
  /* 供自动化测试与排障使用（控制台里也能直接查状态） */
  window.__viewer = {
    THREE, scene, camera, renderer, spark, app, cam,
    /** 当前显示的 mesh（预览档或完整档） */
    get splats() {
      const st = app.current >= 0 ? app.state[app.current] : null;
      return st && st.active ? st[st.active].mesh : null;
    },
    selectModel, setView, orbit, zoomBy, pan, applyCamera, frameModel, setClean, setCompat, resetView,
    measureSaturation, stripSh, upgradeToFull, loadTierBytes, buildTierMesh,
    /** 当前显示档位的点数 */
    numSplats() {
      const st = app.current >= 0 ? app.state[app.current] : null;
      if (!st || !st.active) return 0;
      const mesh = st[st.active].mesh;
      try {
        if (mesh && mesh.getNumSplats && mesh.getNumSplats()) return mesh.getNumSplats();
        if (mesh && mesh.packedSplats && mesh.packedSplats.numSplats) return mesh.packedSplats.numSplats;
      } catch (e) { /* ignore */ }
      const m = app.models[app.current];
      return st.active === 'lite' ? (m.liteCount || m.count) : m.count;
    }
  };

  /* ------------------------------------------------------ [2.13] 起飞 */
  /* 只加载第一个模型，其余等用户切换时再下载 */
  await selectModel(0, true);
  syncButtons();
  if (location.hash.indexOf('haze') >= 0) { try { await setClean(true); } catch (e) { } }
  if (location.hash.indexOf('autorotate') >= 0) $('btn-auto').click();
}

/* ==========================================================================
 * [3] 设备相关的小工具
 * ========================================================================== */

/** 像素比上限：同时限制 DPR 与「总像素数」，避免中低端手机显存/填充率吃紧 */
function pickPixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const maxPixels = coarse ? 2.2e6 : 5.0e6;
  let r = Math.min(dpr, 2);
  while (w * h * r * r > maxPixels && r > 0.75) r -= 0.1;
  return Math.max(0.75, Math.round(r * 20) / 20);
}

/** 打印 GPU 与精度信息，方便交接时远程排障（用户截图控制台即可） */
function logGpuInfo(gl) {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    console.info('[viewer] GPU:', dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      '| highp:', hp ? hp.precision : '?', '| 画布:', gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight,
      '| DPR:', window.devicePixelRatio, '| colorBufferFloat:', !!gl.getExtension('EXT_color_buffer_float'));
  } catch (e) { /* 忽略 */ }
}

function readCompatPref() {
  try { return localStorage.getItem(COMPAT_KEY) === '1'; } catch (e) { return false; }
}
function writeCompatPref(on) {
  try { on ? localStorage.setItem(COMPAT_KEY, '1') : localStorage.removeItem(COMPAT_KEY); } catch (e) { /* 忽略 */ }
}

main().catch((e) => {
  fatalError('初始化失败', (e && e.stack) ? String(e.stack).split('\n').slice(0, 3).join('<br>') : String(e));
});


