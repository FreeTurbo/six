#!/usr/bin/env node
/**
 * serve.mjs —— 本地静态预览服务器（零依赖）
 * ============================================================================
 * 为什么需要它：页面用了 ES 模块 + fetch 读取模型数据，直接双击 index.html
 * （file:// 协议）会被浏览器拦截。本地预览、或者验证改动时用这个。
 *
 * 用法：
 *   node tools/serve.mjs             # 默认 http://localhost:8080
 *   node tools/serve.mjs 3000        # 指定端口
 *
 * 部署到 GitHub Pages 后不需要它——那边本身就是 HTTP 服务。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.argv[2] || '8080', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

/* 可压缩的文本类型。.bin 本身已经是 deflate 过的，再压没有意义，故不在列表里。
   GitHub Pages 同样会对 .js/.css/.html 做 gzip —— 这里保持一致，本地测速才接近线上。 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.md']);

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  /* 防目录穿越 */
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + urlPath); return; }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const accept = String(req.headers['accept-encoding'] || '');
    const gzip = COMPRESSIBLE.has(ext) && st.size > 1024 && /\bgzip\b/.test(accept);
    if (!gzip) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(zlib.createGzip({ level: 9 })).pipe(res);
  });
}).listen(PORT, () => {
  console.log('本地预览: http://localhost:' + PORT + '/');
  console.log('根目录  : ' + ROOT);
  console.log('（已启用 gzip，与 GitHub Pages 行为一致；Ctrl+C 停止）');
});

