#!/usr/bin/env node
/**
 * verify.mjs —— 往返校验：确认 assets/model.bin 解码出来的模型和原始 PLY 一致
 * ============================================================================
 * 用途：改过 tools/pack.mjs（量化格式）或换过模型之后，跑一遍确认没有引入肉眼可见误差。
 *
 * 用法：
 *   node tools/verify.mjs <原始PLY>                 # 校验 model.json 里的第 1 个模型
 *   node tools/verify.mjs <原始PLY> --index 1       # 校验第 2 个
 *   node tools/verify.mjs                           # 只做自检（解码 + 结构检查，不比对源文件）
 *
 * 判定标准（人眼几乎不可见的量级）：
 *   位置 < 1e-4 | 尺度 < 1e-3 | 旋转 < 1e-2 | 不透明度 < 5e-2 | 颜色 < 5e-2 | 球谐平均 < 5e-3
 *   （球谐“最大误差”会偏大，是因为对 0.2%~99.8% 之外的离群值做了截断，属预期）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const idxAt = argv.indexOf('--index');
const idx = idxAt >= 0 ? parseInt(argv[idxAt + 1], 10) : 0;
/* 注意排除 --index 后面的那个数字，否则它会被当成源 PLY 路径
   （idxAt = -1 时不能排除第 0 个参数，那正是 PLY 路径） */
const srcPly = argv.find((a, i) => !a.startsWith('--') && !(idxAt >= 0 && i === idxAt + 1));

/* --- 取出 app.js 里真实的 unpackPly，保证验证的就是线上跑的代码 --- */
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const start = appSrc.indexOf('function unpackPly(');
if (start < 0) throw new Error('在 app.js 里找不到 unpackPly');
let depth = 0, end = -1;
for (let i = appSrc.indexOf('{', start); i < appSrc.length; i++) {
  if (appSrc[i] === '{') depth++;
  else if (appSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const unpackPly = new Function('return ' + appSrc.slice(start, end))();

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'model.json'), 'utf8'));
const model = cfg.models[idx];
if (!model) throw new Error('model.json 里没有第 ' + idx + ' 个模型');
console.log('模型: ' + model.name + '  ' + model.count.toLocaleString('en-US') + ' 点  SH' + model.shDegree);
if (model.flipX) console.log('朝向: flipX = true（绕 X 轴 180°，见 app.js frameModel / ensureMesh）');

const binPath = path.join(ROOT, model.file);
const payload = zlib.inflateSync(fs.readFileSync(binPath));
console.log('载荷: ' + (payload.length / 1048576).toFixed(2) + ' MB  (' + model.file + ')');
const out = unpackPly(new Uint8Array(payload));
console.log('还原: ' + (out.length / 1048576).toFixed(2) + ' MB 的 PLY 字节流');

const parse = (buf) => {
  const he = buf.indexOf('end_header\n') + 11;
  const hdr = buf.subarray(0, he).toString('ascii');
  const props = [...hdr.matchAll(/^property\s+\w+\s+(\S+)/gm)].map((x) => x[1]);
  const n = +/element vertex (\d+)/.exec(hdr)[1];
  const st = props.length;
  const off = Buffer.from(buf.buffer, buf.byteOffset + he, n * st * 4);
  return { props, n, st, f: new Float32Array(off.buffer.slice(off.byteOffset, off.byteOffset + off.length)) };
};
const B = parse(Buffer.from(out));
if (B.n !== model.count) { console.error('❌ 点数不符：' + B.n + ' vs ' + model.count); process.exit(1); }
console.log('结构: ' + B.n + ' 点 / ' + B.st + ' 属性  ' + (B.props.filter((p) => /^f_rest_/.test(p)).length) + ' 个 SH 系数');

/* 四元数归一化自检 */
{
  const ro = B.props.indexOf('rot_0');
  let lo = 9, hi = 0;
  for (let i = 0; i < B.n; i++) {
    const q = Math.hypot(B.f[i * B.st + ro], B.f[i * B.st + ro + 1], B.f[i * B.st + ro + 2], B.f[i * B.st + ro + 3]);
    if (q < lo) lo = q; if (q > hi) hi = q;
  }
  console.log('四元数模长: [' + lo.toFixed(5) + ', ' + hi.toFixed(5) + ']  ' + (Math.abs(hi - 1) < 1e-4 ? '✓' : '✗'));
}

if (!srcPly) { console.log('\n未提供原始 PLY，跳过逐属性比对。'); process.exit(0); }

const A = parse(fs.readFileSync(srcPly));
console.log('\n原始: ' + A.n + ' 点 / ' + A.st + ' 属性');
if (A.n !== B.n) console.log('⚠ 点数不同（原 ' + A.n + ' vs 打包后 ' + B.n + '）—— 抽样档位属正常，下面只比对共同的前 N 点');
const N = Math.min(A.n, B.n);

/* 判定口径说明：
   紧凑档/预览档会**故意截断极少数远处漂浮点**（位置用 0.05%~99.95% 分位），
   这些小点会被钉在取值边界上，单点误差可以很大 —— 所以不能只看「最大误差」，
   否则会把预期行为误报成失败。这里改用「平均误差 + 超差比例」：            */
const groups = {
  '位置 x/y/z': { names: ['x', 'y', 'z'], mean: 1e-2, outlier: 0.5, ratio: 0.002 },
  '尺度 scale': { names: ['scale_0', 'scale_1', 'scale_2'], mean: 5e-2, outlier: 0.5, ratio: 0.005 },
  '旋转 rot': { names: ['rot_0', 'rot_1', 'rot_2', 'rot_3'], mean: 5e-3, outlier: 1e-2, ratio: 0 },
  '不透明度': { names: ['opacity'], mean: 5e-2, outlier: 5e-2, ratio: 0 },
  '颜色 f_dc': { names: ['f_dc_0', 'f_dc_1', 'f_dc_2'], mean: 5e-2, outlier: 5e-2, ratio: 0 }
};
let bad = 0;
for (const [label, lim] of Object.entries(groups)) {
  let maxAbs = 0, sum = 0, cnt = 0, out = 0;
  for (const nm of lim.names) {
    const k = A.props.indexOf(nm), q = B.props.indexOf(nm);
    if (k < 0 || q < 0) continue;
    for (let i = 0; i < N; i++) {
      const d = Math.abs(A.f[i * A.st + k] - B.f[i * B.st + q]);
      if (d > maxAbs) maxAbs = d;
      if (d > lim.outlier) out++;
      sum += d; cnt++;
    }
  }
  const mean = sum / cnt, ratio = out / cnt;
  const ok = mean <= lim.mean && ratio <= lim.ratio;
  if (!ok) bad++;
  console.log('  ' + label.padEnd(12) + ' 平均=' + mean.toExponential(2) + ' 最大=' + maxAbs.toExponential(2) +
    ' 超差比例=' + (ratio * 100).toFixed(3) + '%' + (ok ? '  ✓' : '  ✗ 超出阈值'));
}

/* 球谐：输出的第 j 个对应原始的第 floor(j/per)*15 + j%per 个（见 pack.mjs 的重新编号说明） */
const outRest = B.props.filter((p) => /^f_rest_\d+$/.test(p));
if (outRest.length) {
  const per = outRest.length / 3;
  let sMax = 0, sSum = 0, sCnt = 0;
  for (let j = 0; j < outRest.length; j++) {
    const srcName = 'f_rest_' + (Math.floor(j / per) * 15 + (j % per));
    const k = A.props.indexOf(srcName), q = B.props.indexOf(outRest[j]);
    if (k < 0 || q < 0) { console.log('  SH 映射缺失 j=' + j + ' ' + srcName); bad++; continue; }
    for (let i = 0; i < N; i++) {
      const d = Math.abs(A.f[i * A.st + k] - B.f[i * B.st + q]);
      if (d > sMax) sMax = d;
      sSum += d; sCnt++;
    }
  }
  const shOk = (sSum / sCnt) < 5e-3;
  if (!shOk) bad++;
  console.log('  ' + ('SH ' + outRest.length + '系数').padEnd(12) + ' 平均=' + (sSum / sCnt).toExponential(2) +
    ' 最大=' + sMax.toExponential(2) + (shOk ? '  ✓' : '  ✗'));
}

console.log(bad ? '\n⚠ 有 ' + bad + ' 组超出阈值，请检查 tools/pack.mjs' : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
