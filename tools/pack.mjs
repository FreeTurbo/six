/**
 * pack.mjs —— 高斯泼溅 PLY 的量化打包 / 解包核心
 * ============================================================================
 * 这是「构建期」使用的模块（Node 环境），负责把动辄几十 MB 的标准 3DGS PLY
 * 压成几 MB 的紧凑二进制载荷；浏览器端由 app.js 里的 unpackPly() 还原。
 *
 * 为什么不用现成的 .spz / .splat：
 *   - .spz 需要自己实现编码器，且必须与 Spark 的解码器逐字节对齐，风险高；
 *   - .splat 会丢掉球谐（SH），视角相关效果全没了。
 *   自己量化 + deflate，编码器与解码器都在本仓库里，格式可控、可回归验证。
 *
 * ---------------------------------------------------------------------------
 * 载荷（assets/model.bin，deflate 压缩后）的二进制布局
 * ---------------------------------------------------------------------------
 *   [0..3]        uint32LE  metaLen    —— meta JSON 字节数（已 4 字节对齐）
 *   [4 .. 4+metaLen]         meta JSON —— UTF-8
 *   [...]         uint32LE  rangeCount —— 范围表条目数
 *   [...]         float32LE × rangeCount × 2 —— 每个属性的 [min, max]
 *   [...]         量化记录区            —— 每个高斯定长 REC 字节
 *
 * meta JSON 结构：
 *   {
 *     count:      高斯点数,
 *     header:     还原时写回 PLY 的文本头（含 end_header\n）,
 *     props:      属性名数组，顺序 = PLY 文件中的列顺序,
 *     rangeCount: 范围表条目数,
 *     groups:     [ { type:'u24'|'u16'|'q8'|'u8', props:[...], range: 起始下标|null } ]
 *                 —— 解码时按 groups 顺序逐个属性读取记录区
 *   }
 *
 * 记录区字段顺序与位宽（= groups 顺序）：
 *   u24 × 3   位置 x, y, z         定点，值域 = 该属性的 [min,max]，精度约 1e-6
 *   u16 × 3   尺度 scale_0..2      对数域定点，精度约 1e-4
 *   q8  × 4   旋转 rot_0..3        固定 [-1,1]，解码后重新归一化（角度误差 ≈ 0.3°）
 *   u8  × 1   不透明度             对数几率域（logit），误差 < 2%
 *   u8  × 3   颜色 f_dc_0..2       DC 项，误差 < 1.5%
 *   u8  × K   球谐 f_rest_0..K-1   每通道保留前 (D+1)²-1 个系数，通道优先
 *
 * 球谐阶数 D 与系数个数 K：D=0 → 0；D=1 → 9；D=2 → 24；D=3 → 45
 *
 * ⚠ 重要坑（务必保留此注释）：
 *   Spark 的 PLY 加载器要求 f_rest_* 必须从 0 开始**连续编号**，它只数到第一个
 *   断号为止。原始 Brush/INRIA 导出的 PLY 里 f_rest 是按字典序排列的
 *   （f_rest_0, f_rest_1, f_rest_10, f_rest_11 ...），一旦只保留部分系数
 *   （例如 D=2 时保留 0-7、15-22、30-37），名字就会出现断号，Spark 直接抛
 *   "Invalid number of f_rest properties: N" 并加载出 0 个点（画面全黑且不报错）。
 *   因此这里在输出 header 时把保留下来的系数**重新连续编号**为 f_rest_0..K-1，
 *   顺序仍是「通道优先」（R 的系数在前，然后 G、B），与标准 3DGS 布局一致。
 *
 *   实测 Spark 只接受 f_rest 个数 = 0 / 9 / 24 / 45（连续编号），其余一律拒绝。
 *
 * ---------------------------------------------------------------------------
 * 档位（profile）—— 用于「先快速进画面，再后台升级到高清」
 * ---------------------------------------------------------------------------
 *   full  位置 u24 + 尺度 u16 + 旋转 q8 + 不透明度 u8 + 颜色 u8×3 + 球谐 u8×K
 *         本项目 22.8 万点、SH2 → 约 9.7 MB，画质最好
 *   lite  位置 u16 + 尺度 u8  + 旋转 q8 + 不透明度 u8 + 颜色 u8×3（不含球谐）
 *         只保留一部分点（默认为总数 35%，按空间均匀抽样，避免局部空洞）
 *         → 约 1 MB，用于首屏秒开；随后由浏览器后台下载 full 并无缝替换
 *
 *   lite 的位置用 0.05%~99.95% 分位（把极少数远处漂浮点截断）以换取更高精度，
 *   其余属性用 0.2%~99.8% 分位，避免离群值吃掉动态范围。
 */

export const SH_COEFS = { 0: 0, 1: 9, 2: 24, 3: 45 };   // 每通道 (D+1)²-1 个系数

/** 档位定义：记录区字段顺序不变，只改位宽、取值范围与是否带球谐 */
export const PROFILES = {
  full: {
    label: '完整',
    types: { pos: 'u24', scale: 'u16', rot: 'q8', opacity: 'u8', dc: 'u8', rest: 'u8' },
    range: { pos: 'full', scale: 'full', rot: null, opacity: 'full', dc: 'full', rest: 'robust' }
  },
  compact: {
    /* 点数特别多的大模型用这一档：位置 16bit、尺度 8bit，每个点比 full 省 9 字节。
       位置用 0.05%~99.95% 分位，只截断极少数远处漂浮点，换来更高的有效精度。 */
    label: '紧凑',
    types: { pos: 'u16', scale: 'u8', rot: 'q8', opacity: 'u8', dc: 'u8', rest: 'u8' },
    range: { pos: 'tight', scale: 'robust', rot: null, opacity: 'full', dc: 'full', rest: 'robust' }
  },
  lite: {
    label: '预览',
    types: { pos: 'u16', scale: 'u8', rot: 'q8', opacity: 'u8', dc: 'u8', rest: null },
    range: { pos: 'tight', scale: 'robust', rot: null, opacity: 'full', dc: 'full', rest: null }
  }
};

/** 解析标准 3DGS PLY（binary_little_endian），返回表头、属性表与 float 视图 */
export function parsePly(buf) {
  const headEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
  if (headEnd <= 0) throw new Error('不是合法的 PLY：找不到 end_header');
  const header = buf.subarray(0, headEnd).toString('ascii');
  const props = [...header.matchAll(/^property\s+\w+\s+(\S+)/gm)].map((m) => m[1]);
  const count = parseInt(/element vertex (\d+)/.exec(header)[1], 10);
  const stride = props.length;
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset + headEnd, buf.byteOffset + headEnd + count * stride * 4));
  const col = (name) => {
    const i = props.indexOf(name);
    if (i < 0) throw new Error('PLY 缺少属性 ' + name);
    const a = new Float64Array(count);
    for (let k = 0; k < count; k++) a[k] = f[k * stride + i];
    return a;
  };
  return { header, props, count, stride, f, col, dataStart: headEnd };
}

const rangeFull = (a) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; } return [lo, hi]; };
/* 稳健范围：个别离群值会毁掉整条系数的精度，取 0.2%~99.8% 分位并截断 */
const rangeRobust = (a) => {
  const b = Float64Array.from(a).sort();
  return [b[Math.floor(b.length * 0.002)], b[Math.min(b.length - 1, Math.floor(b.length * 0.998))]];
};
/* 更紧的范围：给低比特位宽的位置用，牺牲极少数远处漂浮点换取精度 */
const rangeTight = (a) => {
  const b = Float64Array.from(a).sort();
  return [b[Math.floor(b.length * 0.0005)], b[Math.min(b.length - 1, Math.floor(b.length * 0.9995))]];
};
const RANGE_FN = { full: rangeFull, robust: rangeRobust, tight: rangeTight };

/**
 * 空间均匀抽样：把坐标量化到 10bit 网格后按 Morton 码排序，再等间隔取点。
 * 比随机抽样更均匀（不会出现局部空洞），也比按不透明度排序更「保形」
 * ——预览版要和完整版看起来是同一个模型，只是密度低一些。
 * 返回按 Morton 码排好序的下标数组；不需要抽样时返回 null。
 */
export function mortonSample(P, maxPoints) {
  const { count, stride, f, props } = P;
  if (!maxPoints || count <= maxPoints) return null;
  const ix = props.indexOf('x'), iy = props.indexOf('y'), iz = props.indexOf('z');
  /* 用 0.1%~99.9% 分位做量化范围，避免个别漂浮点把网格撑爆 */
  const box = [ix, iy, iz].map((i) => {
    const a = new Float64Array(count);
    for (let k = 0; k < count; k++) a[k] = f[k * stride + i];
    const b = Float64Array.from(a).sort();
    return [b[Math.floor(count * 0.001)], b[Math.min(count - 1, Math.floor(count * 0.999))]];
  });
  const keys = new Float64Array(count);
  const order = new Uint32Array(count);
  const part1by2 = (v) => {           // 把 10bit 均匀铺开到 30bit（Morton 交错）
    v &= 0x3ff;
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    v = (v | (v << 2)) & 0x09249249;
    return v;
  };
  for (let k = 0; k < count; k++) {
    const qx = Math.min(1023, Math.max(0, Math.round((f[k * stride + ix] - box[0][0]) / ((box[0][1] - box[0][0]) / 1023 || 1))));
    const qy = Math.min(1023, Math.max(0, Math.round((f[k * stride + iy] - box[1][0]) / ((box[1][1] - box[1][0]) / 1023 || 1))));
    const qz = Math.min(1023, Math.max(0, Math.round((f[k * stride + iz] - box[2][0]) / ((box[2][1] - box[2][0]) / 1023 || 1))));
    keys[k] = part1by2(qx) | (part1by2(qy) << 1) | (part1by2(qz) << 2);
    order[k] = k;
  }
  const idx = Array.from(order).sort((a, b) => keys[a] - keys[b]);
  const step = count / maxPoints;
  const out = new Uint32Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) out[i] = idx[Math.min(count - 1, Math.floor(i * step))];
  return out;
}

/** 按球谐阶数挑出要保留的 f_rest 属性名（每通道前 K 个系数，通道优先） */
export function restNamesFor(degree, props) {
  const per = (degree + 1) * (degree + 1) - 1;
  const out = [];
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0; i < per; i++) {
      const nm = 'f_rest_' + (ch * 15 + i);
      if (props.indexOf(nm) < 0) throw new Error('PLY 缺少 ' + nm + '（源文件球谐阶数不足？）');
      out.push(nm);
    }
  }
  return out;
}

/**
 * PLY Buffer → { payload, REC, count, degree, restCount, props, profile, srcCount }
 *
 * 选项：
 *   degree    球谐阶数（0~3），仅 profile='full' 时生效
 *   profile   'full' | 'lite'，见文件头的档位说明
 *   maxPoints 只对 lite 生效：最多保留多少个点（默认取总数的 35%）
 */
export function buildPayload(plyBuf, { degree = 2, profile = 'full', maxPoints = 0 } = {}) {
  const P = parsePly(plyBuf);
  const { props, stride, f, col } = P;
  const prof = PROFILES[profile];
  if (!prof) throw new Error('未知档位：' + profile);

  /* 预览档默认按总数 35% 抽样；完整档不抽样 */
  const keepIdx = profile === 'lite'
    ? mortonSample(P, maxPoints || Math.max(20000, Math.round(P.count * 0.35)))
    : null;
  const count = keepIdx ? keepIdx.length : P.count;
  const pick = (k) => (keepIdx ? keepIdx[k] : k);          // 逻辑下标 → 源下标

  const restSrc = prof.types.rest ? restNamesFor(degree, props) : [];
  const restOut = restSrc.map((_, i) => 'f_rest_' + i);     // 重新连续编号（见文件头说明）

  const GROUPS = [
    { type: prof.types.pos, props: ['x', 'y', 'z'], mode: prof.range.pos },
    { type: prof.types.scale, props: ['scale_0', 'scale_1', 'scale_2'], mode: prof.range.scale },
    { type: 'q8', props: ['rot_0', 'rot_1', 'rot_2', 'rot_3'] },
    { type: 'u8', props: ['opacity'], mode: prof.range.opacity },
    { type: 'u8', props: ['f_dc_0', 'f_dc_1', 'f_dc_2'], mode: prof.range.dc },
    { type: 'u8', props: restSrc, out: restOut, mode: 'robust' }
  ];
  if (!restSrc.length) GROUPS.pop();

  const RANGES = [], rangeBase = [];
  for (const g of GROUPS) {
    if (g.type === 'q8') { rangeBase.push(null); continue; }
    rangeBase.push(RANGES.length);
    for (const p of g.props) {
      const c = col(p);
      /* 抽样时只统计被保留下来的点，范围更贴合实际数据 */
      const src = keepIdx ? Float64Array.from(keepIdx, (k) => c[k]) : c;
      RANGES.push((RANGE_FN[g.mode] || rangeFull)(src));
    }
  }

  const widths = { u24: 3, u16: 2, q8: 1, u8: 1 };
  let REC = 0;
  for (const g of GROUPS) REC += g.props.length * widths[g.type];

  const rec = Buffer.alloc(count * REC);
  const u8e = (v, lo, hi) => { const t = (v - lo) / (hi - lo || 1); return t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255); };
  const u16e = (v, lo, hi) => { const t = (v - lo) / (hi - lo || 1); return t <= 0 ? 0 : t >= 1 ? 65535 : Math.round(t * 65535); };
  const u24e = (v, lo, hi) => { const t = (v - lo) / (hi - lo || 1); return t <= 0 ? 0 : t >= 1 ? 16777215 : Math.round(t * 16777215); };
  const ENC = { u8: u8e, u16: u16e, u24: u24e };
  const BYTES = { u8: 1, u16: 2, u24: 3 };

  const idx = GROUPS.map((g) => g.props.map((n) => props.indexOf(n)));
  const rb = rangeBase;
  for (let k = 0; k < count; k++) {
    const o = pick(k) * stride;
    let w = k * REC;
    for (let gi = 0; gi < GROUPS.length; gi++) {
      const g = GROUPS[gi];
      if (g.type === 'q8') {
        for (let j = 0; j < 4; j++) rec[w++] = Math.max(0, Math.min(255, Math.round((f[o + idx[gi][j]] + 1) * 127.5)));
        continue;
      }
      const enc = ENC[g.type], nb = BYTES[g.type];
      for (let j = 0; j < g.props.length; j++) {
        const v = enc(f[o + idx[gi][j]], RANGES[rb[gi] + j][0], RANGES[rb[gi] + j][1]);
        for (let b = 0; b < nb; b++) rec[w++] = (v >> (8 * b)) & 255;
      }
    }
  }

  /* 重新生成表头：只保留用到的属性，f_rest 连续编号 */
  const outDegree = restSrc.length ? degree : 0;
  const comments = P.header.split('\n').filter((l) => l.startsWith('comment'))
    .map((l) => (/SH degree/.test(l) ? 'comment SH degree: ' + outDegree : l));
  const orderedProps = ['f_dc_0', 'f_dc_1', 'f_dc_2']
    .concat(restOut)
    .concat(['opacity', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'scale_0', 'scale_1', 'scale_2', 'x', 'y', 'z']);
  const header = ['ply', 'format binary_little_endian 1.0']
    .concat(comments)
    .concat(['element vertex ' + count])
    .concat(orderedProps.map((p) => 'property float ' + p))
    .concat(['end_header', '']).join('\n');

  const meta = {
    count, header, props: orderedProps,
    groups: GROUPS.map((g, i) => ({ type: g.type, props: g.out || g.props, range: g.type === 'q8' ? null : rb[i] })),
    rangeCount: RANGES.length
  };
  let metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const pad = (4 - (metaBuf.length % 4)) % 4;
  if (pad) metaBuf = Buffer.concat([metaBuf, Buffer.alloc(pad, 32)]);
  const rangeBuf = Buffer.alloc(RANGES.length * 8);
  RANGES.forEach((r, i) => { rangeBuf.writeFloatLE(r[0], i * 8); rangeBuf.writeFloatLE(r[1], i * 8 + 4); });
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(metaBuf.length, 0);
  const cntBuf = Buffer.alloc(4); cntBuf.writeUInt32LE(RANGES.length, 0);
  const payload = Buffer.concat([lenBuf, metaBuf, cntBuf, rangeBuf, rec]);
  return { payload, REC, count, degree: outDegree, restCount: restSrc.length, props: orderedProps, profile, srcCount: P.count };
}
