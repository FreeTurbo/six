#!/usr/bin/env node
/**
 * build.mjs —— 把高斯泼溅 PLY 打成网站用的 assets/model.bin + assets/model.json
 * ============================================================================
 * 用法：
 *   node tools/build.mjs <源文件.ply> [选项]
 *
 * 选项：
 *   --name <名称>     展示用名称（默认继承上次的值，新条目取文件名里的时间戳）
 *   --sh <0|1|2|3>    球谐阶数，默认 2（见下方体积对照）
 *   --id <标识>       model.json 里的 id，默认 model-1
 *   --flip / --noflip 是否绕 X 轴 180° 修正上下颠倒（默认继承上次的值，新条目为 true）
 *   --yaw <弧度>      默认水平角（默认继承上次的值）
 *   --pitch <弧度>    默认俯仰角（默认继承上次的值）
 *   --proj <目录>     项目根目录，默认脚本所在目录的上一级
 *
 * 说明：同一个 id 重新打包时，会**继承**上次的名称 / 朝向 / 默认视角，
 *       所以重跑本脚本不会冲掉手工微调（README 第 3 节）。
 *
 * 体积对照（以 227,933 点的模型为例，量化后 deflate）：
 *   SH0 = 5.0MB   SH1 = 7.0MB   SH2 = 9.7MB   SH3 = 14.8MB
 *   SH 每降一阶大约省 30% 体积，SH2 已能保留绝大部分视角相关效果。
 *
 * 产物：
 *   assets/model.bin   量化 + deflate 的模型数据（格式见 tools/pack.mjs 头部注释）
 *   assets/model.json  模型清单：名称、点数、取景范围、朝向、默认视角
 *
 * 说明：model.json 是「生成物 + 可手工微调」，改名称/朝向/默认视角不需要重新打包，
 *       直接编辑该文件即可（见 README「交接说明」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildPayload, parsePly } from './pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 参数解析 ---------------- */
const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('用法: node tools/build.mjs <源文件.ply> [--name 名称] [--sh 2] [--id model-1] [--keep]');
  process.exit(1);
}
const opt = (key, def) => {
  const i = argv.indexOf('--' + key);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const hasFlag = (key) => argv.includes('--' + key);
const given = (key) => argv.includes('--' + key);
const degree = parseInt(opt('sh', '2'), 10);
const projDir = path.resolve(opt('proj', path.join(HERE, '..')));
const assetsDir = path.join(projDir, 'assets');
const baseName = path.basename(src);

/* 默认名称：文件名里的 8 位时间戳 HHMMSS（VID_20260914_174313 → 17:43:13） */
function defaultName(file) {
  const m = /_(\d{2})(\d{2})(\d{2})(?:\.|_|$)/.exec(file);
  return m ? m[1] + ':' + m[2] + ':' + m[3] : path.basename(file, path.extname(file));
}
const name = opt('name', defaultName(baseName));
const id = opt('id', 'model-1');

/* ---------------- 打包 ---------------- */
console.log('读取源文件: ' + src);
const raw = fs.readFileSync(src);
console.log('原始大小: ' + (raw.length / 1048576).toFixed(2) + ' MB');

const t0 = Date.now();
const { payload, REC, count, restCount, props } = buildPayload(raw, { degree });
const deflated = zlib.deflateSync(payload, { level: 9, memLevel: 9 });
console.log('量化: ' + count.toLocaleString('en-US') + ' 点 × ' + REC + ' B/点（SH' + degree + '，' + restCount + ' 系数）= ' +
  (payload.length / 1048576).toFixed(2) + ' MB');
console.log('deflate: ' + (deflated.length / 1048576).toFixed(2) + ' MB  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');

/* ---------------- 取景范围：坐标的 1%~99% 分位 ---------------- */
/* 说明：原始 min/max 会被远处的「漂浮点」撑大，导致相机取景到一片空白，
 *       所以用分位数算一个稳健的包围盒，浏览器端用它做自动取景。            */
const P = parsePly(raw);
const qtl = (axis, p) => {
  const a = P.col(['x', 'y', 'z'][axis]);
  const b = Float64Array.from(a).sort();
  return b[Math.max(0, Math.min(b.length - 1, Math.floor(b.length * p)))];
};
const LO = [0, 1, 2].map((a) => +qtl(a, 0.01).toFixed(3));
const HI = [0, 1, 2].map((a) => +qtl(a, 0.99).toFixed(3));
const full = [0, 1, 2].map((a) => [qtl(a, 0), qtl(a, 1)]);
console.log('稳健范围: ' + LO.map((v, i) => ['x', 'y', 'z'][i] + '[' + v + ',' + HI[i] + ']').join(' '));
console.log('完整范围: ' + full.map((v, i) => ['x', 'y', 'z'][i] + '[' + v[0].toFixed(1) + ',' + v[1].toFixed(1) + ']').join(' '));

/* ---------------- 写产物 ---------------- */
fs.mkdirSync(assetsDir, { recursive: true });
const binPath = path.join(assetsDir, 'model.bin');
fs.writeFileSync(binPath, deflated);

/* 读入已有清单：同 id 的条目会被重新打包，但「人工调过的展示属性」要继承下来，
   否则重跑一次 build.mjs 就会把手工改过的名称/朝向/默认视角冲掉。 */
const jsonPath = path.join(assetsDir, 'model.json');
let out = { _readme: '本文件由 tools/build.mjs 生成；名称/朝向/默认视角可直接手工微调，不必重新打包。', models: [] };
if (fs.existsSync(jsonPath)) {
  try { out = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { /* 损坏就重写 */ }
  if (!Array.isArray(out.models)) out.models = [];
}
const prev = out.models.find((m) => m.id === id) || null;
if (prev && !hasFlag('keep')) console.log('检测到已有条目 id=' + id + '，将继承其展示属性（名称/朝向/默认视角）');

const entry = {
  id,
  name: given('name') || (prev && prev.name) || name,
  file: path.relative(projDir, binPath).split(path.sep).join('/'),
  count,
  shDegree: degree,
  /* 朝向：Brush 导出的 PLY 在 Spark 里默认是上下颠倒的，绕 X 轴转 180° 修正。
     默认继承上次的值（新条目默认 true）；也可用 --flip / --noflip 显式指定。
     判断依据与验证方法见 README 第 6.2 节。 */
  flipX: hasFlag('noflip') ? false : (hasFlag('flip') ? true : (prev ? !!prev.flipX : true)),
  /* 默认视角：yaw = 水平角（弧度，0 = 从 +Z 方向看），pitch = 俯仰角（弧度，π/2 = 水平） */
  yaw: given('yaw') ? +opt('yaw') : (prev && prev.yaw != null ? prev.yaw : Math.PI),
  pitch: given('pitch') ? +opt('pitch') : (prev && prev.pitch != null ? prev.pitch : 1.50),
  frame: {
    center: [0, 1, 2].map((k) => +((LO[k] + HI[k]) / 2).toFixed(3)),
    size: [0, 1, 2].map((k) => +(HI[k] - LO[k]).toFixed(3))
  },
  rawBounds: { min: LO, max: HI },
  source: baseName,
  generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  generator: 'tools/build.mjs (SH' + degree + ', ' + REC + ' B/point, deflate)'
};

/* 写回清单：同 id 的旧条目替换掉，其它条目的顺序与内容保持不变 */
out.models = out.models.filter((m) => m.id !== id);
out.models.push(entry);
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2) + '\n');

console.log('写出: ' + path.relative(projDir, binPath) + '  (' + (deflated.length / 1048576).toFixed(2) + ' MB)');
console.log('写出: ' + path.relative(projDir, jsonPath));
console.log('完成。本地预览: node tools/serve.mjs  或  python -m http.server');
