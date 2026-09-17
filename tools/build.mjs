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
 *   --profile <档位>  full（默认，位置 24bit/尺度 16bit）或 compact（位置 16bit/尺度 8bit，更小）
 *   --id <标识>       model.json 里的 id，默认 model-1
 *   --file <文件名>   完整档输出文件名，默认 <id>.bin
 *   --lite-ratio <r>  预览档保留比例，默认 0.35
 *   --lite-points <n> 预览档保留点数（优先于 --lite-ratio）
 *   --no-lite         不生成预览档
 *   --flip / --noflip 是否绕 X 轴 180° 修正上下颠倒（默认继承上次的值，新条目为 true）
 *   --yaw <弧度>      默认水平角（默认继承上次的值）
 *   --pitch <弧度>    默认俯仰角（默认继承上次的值）
 *   --proj <目录>     项目根目录，默认脚本所在目录的上一级
 *
 * 说明：同一个 id 重新打包时，会**继承**上次的名称 / 朝向 / 默认视角，
 *       所以重跑本脚本不会冲掉手工微调（README 第 3 节）。
 *
 * 体积对照（以 227,933 点的模型为例，量化后 deflate）：
 *   完整档 SH0=5.0MB  SH1=7.0MB  SH2=9.7MB  SH3=14.8MB（SH 每降一阶约省 30%）
 *   预览档 约 1.0MB（8 万点、无球谐、16bit 位置）—— 手机首屏秒开用
 *
 * 产物：
 *   assets/<id>.bin        完整精度（默认 SH2 + 24bit 位置）
 *   assets/<id>.lite.bin   预览档（默认总数的 35%，无球谐、16bit 位置），--no-lite 可跳过
 *   assets/model.json      模型清单：名称、点数、取景范围、朝向、默认视角、两档文件名
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
const profile = opt('profile', 'full');   // full | compact
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

/* ---------------- 打包（完整档 + 预览档） ---------------- */
console.log('读取源文件: ' + src);
const raw = fs.readFileSync(src);
console.log('原始大小: ' + (raw.length / 1048576).toFixed(2) + ' MB');

const MB1 = (n) => (n / 1048576).toFixed(2) + ' MB';
const t0 = Date.now();
const full = buildPayload(raw, { degree, profile });
const fullDef = zlib.deflateSync(full.payload, { level: 9, memLevel: 9 });
console.log('完整档: ' + full.count.toLocaleString('en-US') + ' 点 × ' + full.REC + ' B/点（SH' + full.degree +
  '，' + full.restCount + ' 系数）载荷 ' + MB1(full.payload.length) + ' → deflate ' + MB1(fullDef.length));

let lite = null, liteDef = null;
if (!hasFlag('no-lite')) {
  const ratio = parseFloat(opt('lite-ratio', '0.35'));
  const maxPoints = opt('lite-points', '') ? parseInt(opt('lite-points'), 10) : Math.round(full.srcCount * ratio);
  lite = buildPayload(raw, { profile: 'lite', maxPoints });
  liteDef = zlib.deflateSync(lite.payload, { level: 9, memLevel: 9 });
  console.log('预览档: ' + lite.count.toLocaleString('en-US') + ' 点 × ' + lite.REC + ' B/点（无球谐、16bit 位置）载荷 ' +
    MB1(lite.payload.length) + ' → deflate ' + MB1(liteDef.length) + '   （完整档的 ' +
    (liteDef.length / fullDef.length * 100).toFixed(0) + '%）');
}
console.log('总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

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
const fullRange = [0, 1, 2].map((a) => [qtl(a, 0), qtl(a, 1)]);
console.log('稳健范围: ' + LO.map((v, i) => ['x', 'y', 'z'][i] + '[' + v + ',' + HI[i] + ']').join(' '));
console.log('完整范围: ' + fullRange.map((v, i) => ['x', 'y', 'z'][i] + '[' + v[0].toFixed(1) + ',' + v[1].toFixed(1) + ']').join(' '));

/* ---------------- 写产物 ---------------- */
fs.mkdirSync(assetsDir, { recursive: true });
const fullName = opt('file', id + '.bin');
const binPath = path.join(assetsDir, fullName);
fs.writeFileSync(binPath, fullDef);
let litePath = null;
if (lite) {
  litePath = path.join(assetsDir, id + '.lite.bin');
  fs.writeFileSync(litePath, liteDef);
}

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
  /* 注意：这里必须用 opt() 取「值」，不能写成 given()（那是返回布尔值的判断），
     否则命令行传了 --name 之后写进清单的就变成 true 了。 */
  name: opt('name', '') || (prev && prev.name) || name,
  file: path.relative(projDir, binPath).split(path.sep).join('/'),
  count: full.count,
  shDegree: full.degree,
  /* 预览档（手机首屏秒开用）：app.js 会先加载它，随后在后台下载上面的完整档并无缝替换 */
  fileLite: lite ? path.relative(projDir, litePath).split(path.sep).join('/') : null,
  liteCount: lite ? lite.count : null,
  liteBytes: lite ? liteDef.length : null,
  bytes: fullDef.length,
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
  generator: 'tools/build.mjs (full SH' + full.degree + '/' + full.REC + 'B, lite ' +
    (lite ? lite.REC + 'B×' + Math.round(lite.count / full.srcCount * 100) + '%' : 'off') + ', deflate)'
};

/* 写回清单：同 id 的旧条目替换掉，其它条目的顺序与内容保持不变 */
out.models = out.models.filter((m) => m.id !== id);
out.models.push(entry);
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2) + '\n');

console.log('写出: ' + path.relative(projDir, binPath) + '  (' + MB1(fullDef.length) + ')');
if (litePath) console.log('写出: ' + path.relative(projDir, litePath) + '  (' + MB1(liteDef.length) + ')');
console.log('写出: ' + path.relative(projDir, jsonPath));
console.log('完成。本地预览: node tools/serve.mjs  或  python -m http.server');

