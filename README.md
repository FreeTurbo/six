# 高斯泼溅模型展示（Web 查看器）

用 three.js + [Spark](https://sparkjs.dev/)（World Labs 的 3DGS 渲染器）做的单页展示站，
展示一个由手机视频训练出来的高斯泼溅（3D Gaussian Splatting）模型。

**当前模型**：楼梯间 · 17:43 —— 227,933 个高斯点，源文件 `VID_20260914_174313.ply`（Brush 导出）
**整站体积**：约 13 MB（其中 HTML 只有 3 KB，模型数据 9.7 MB 单独存放）
**兼容**：Chrome / Edge 103+、Safari 16.4+（需要 `DecompressionStream`）

---

## 1. 目录结构

```
高斯泼溅模型展示/
├── index.html              页面结构 + 引擎的 importmap（3 KB）
├── style.css               界面样式：液态玻璃质感、动效、响应式（桌面 + 移动）
├── app.js                  查看器逻辑：[1]工具 [2]相机 [3]模型管理 [4]界面联动
├── assets/
│   ├── model.json          ★ 模型清单：名称 / 点数 / 朝向 / 默认视角 / 取景范围
│   ├── model.bin           ★ 量化 + deflate 的模型数据（9.7 MB，格式见 tools/pack.mjs）
│   ├── three.module.js     three.js r180（705 KB）
│   ├── Pass.js             three.js addons（Spark 依赖，4 KB）
│   └── spark.module.js     Spark 2.2.0（2.7 MB，MIT）
├── tools/
│   ├── build.mjs           PLY → model.bin + model.json（换模型就用它）
│   ├── pack.mjs            量化打包核心 + 二进制格式说明（★ 改格式前必读）
│   ├── verify.mjs          往返校验：确认 model.bin 解码结果与原始 PLY 一致
│   └── serve.mjs           本地静态预览服务器（零依赖）
└── README.md               本文件
```

`★` 标记的两个文件是「数据」；其余都是「代码」。

---

## 2. 快速开始

### 本地预览

页面用了 ES 模块 + `fetch`，**双击 index.html 打不开**（`file://` 会被浏览器拦截，页面会给出提示）。
起一个本地服务器即可：

```bash
node tools/serve.mjs          # 然后浏览器打开 http://localhost:8080/
node tools/serve.mjs 3000     # 换端口
# 或者用 Python：
python -m http.server 8080
```

### 部署到 GitHub Pages

1. 把本目录下所有文件提交到仓库（不需要构建，产物已经是最终状态）。
2. 仓库 Settings → Pages → Source 选分支根目录（`/`）。
3. 打开 `https://<用户名>.github.io/<仓库名>/` 即可。

> GitHub 单文件上限 100 MB，本仓库最大文件是 9.7 MB 的 `model.bin`，没有压力。

### 一键上传（改完文件后）

双击项目根目录的 **`上传到GitHub.bat`**（或桌面上的「上传到GitHub」快捷方式）即可。
脚本会自动完成「扫描改动 → 提交 → 推送」，推送后 GitHub Pages 约 1 分钟重新部署。
没有改动时它只会提示一句，不会产生空提交。

命令行等价写法：

```powershell
powershell -ExecutionPolicy Bypass -File tools\push.ps1
powershell -ExecutionPolicy Bypass -File tools\push.ps1 -Message "自定义提交说明"
```

**首次使用要授权一次**：Git Credential Manager 会弹出「Connect to GitHub」窗口，
选 `Sign in with your browser`，在浏览器里点 Authorize。之后凭据存在 Windows 凭据管理器里，不再询问。

> ⚠️ 国内网络直连 `github.com` 经常不通（表现为 push 卡住或 `Failed to connect ... :443`）。
> 遇到就先开加速器（如 Watt Toolkit）再重试。

---

## 3. 换模型 / 加模型

```bash
# 换成新模型（会覆盖 model.bin，并更新 model.json 里的对应条目）
node tools/build.mjs 你的模型.ply

# 常用选项
node tools/build.mjs 模型.ply --name "展厅 · 09:30"    # 展示名称
node tools/build.mjs 模型.ply --sh 1                   # 球谐降到 1 阶（体积更小）
node tools/build.mjs 模型.ply --id model-2             # 追加为另一个模型（保留已有条目）
node tools/build.mjs 模型.ply --flip / --noflip        # 显式指定朝向

# 校验（推荐每次打包后跑一次）
node tools/verify.mjs 你的模型.ply
```

打包完成后：

* `assets/model.bin` 被替换；
* `assets/model.json` 里的 `count / frame / rawBounds` 等自动更新；
* **同一个 `id` 重新打包时，`name / flipX / yaw / pitch` 会继承上次的值**，
  所以重跑脚本不会冲掉手工微调；想改这些值既可以直接编辑 `model.json`，也可以用上面的命令行参数覆盖。
* 但**朝向本身仍需人工确认一次**（换模型后跑一遍看看有没有上下颠倒 / 侧躺），见第 6.2 节。

### 模型清单字段（可直接手工编辑，不必重新打包）

| 字段 | 说明 |
|---|---|
| `name` | 展示名称，显示在左上角 HUD |
| `file` | 数据文件路径（相对站点根目录） |
| `count` | 点数，仅用于显示 |
| `flipX` | 是否绕 X 轴 180°（修正上下颠倒），见 6.2 |
| `yaw` | 默认水平角，弧度。`0` = 从 +Z 方向看，`π` = 从 −Z 方向看 |
| `pitch` | 默认俯仰角，弧度。`π/2 ≈ 1.571` 为水平，越小越俯视 |
| `frame` | 自动取景用的稳健包围盒（坐标 1%~99% 分位），由打包脚本算出 |

> 有 2 个及以上模型时，右上角会自动出现「模型列表」；只有 1 个时该面板隐藏（`app.js` [2.10] 节，判据 `app.models.length > 1`）。

---

## 4. 数据格式

`assets/model.bin` 是 **deflate 压缩后的量化载荷**，浏览器端用 `DecompressionStream` 解压、
再由 `app.js` 的 `unpackPly()` 还原成标准 3DGS PLY 字节流交给 Spark。
完整二进制布局、字段位宽、量化精度写在 **`tools/pack.mjs` 文件头注释**里，改格式前务必先读。

一句话版本：每个高斯 47 字节（位置 24bit×3、尺度 16bit×3、旋转 8bit×4、不透明度 8bit、颜色 8bit×3、球谐 8bit×24），
相比原始 PLY 的 236 字节/点 压缩到 1/5，实测误差见 `tools/verify.mjs` 输出（位置 3.8e-6、旋转约 0.3°）。

球谐阶数与体积的取舍（以本项目 22.8 万点为例，单位 MB）：

| 阶数 | 系数/通道 | model.bin |
|---|---|---|
| SH0 | 0 | 5.0 |
| SH1 | 3 | 7.0 |
| **SH2（当前）** | **8** | **9.7** |
| SH3 | 15 | 14.8 |

---

## 5. 界面与交互

| 操作 | 桌面 | 移动端 |
|---|---|---|
| 旋转 | 左键拖拽 | 单指拖拽 |
| 缩放 | 滚轮 | 双指捏合 |
| 平移 | **中键拖拽** 或 **Shift + 左键拖拽** | 双指拖拽 |
| 复位 | 「重置视角」按钮 / `R` 键 / 双击画布 | 双击画布 |
| 自动旋转 | 「自动旋转」按钮 / 空格 | 按钮 |
| 全屏 | 「全屏」按钮 / `F` 键 | 按钮 |
| 去雾 | 「去雾」按钮 | 按钮 |

* **右键已完全禁用**（不旋转、不平移、屏蔽右键菜单）——Edge 会把右键拖拽识别成鼠标手势，体验冲突。平移改用中键 / Shift+左键。
* 旋转**无角度限制**：可以一直往上翻越过天顶继续转，不会卡住也不会突然跳变
  （实现上是绕相机自身的上/右轴做四元数旋转，而不是被 `phi` 夹住的球坐标）。
* 桌面端 URL 加 `#haze` 可默认开启去雾；`#autorotate` 可默认自动旋转。

---

## 6. 关键设计决策与踩坑记录

### 6.1 为什么不用内联单文件

早期版本把 three.js、Spark、模型数据全部 base64 内联进 HTML，做出来 29 MB。
现在拆成 `assets/` 外链：HTML 只有 3 KB、便于 diff 与协作，模型数据也能被浏览器缓存。

### 6.2 朝向：为什么 `flipX = true`（★ 换模型后必看）

Brush（以及多数 3DGS 训练器）导出的 PLY 保留 COLMAP 世界坐标系，
而 **COLMAP 的相机坐标系是 y 轴朝下**，所以模型的“上”其实是 **−Y**。
在 three.js（+Y 朝上）里直接加载，模型就是**上下颠倒**的。

本项目不是靠肉眼猜的，而是用源数据算出来的：

1. 解析 `sparse/0/images.bin` 里 300 张图的相机位姿，对每张求世界 up = `Rᵀ·(0,−1,0)` 后取平均，
   得到 `[-0.014, -1.000, 0.025]` —— 即世界 up 就是 **−Y**（300 张一致性极高，说明拍摄时手机是端平的）。
2. 用 3D 直方图互相关把 PLY 点云和 COLMAP `points3D.bin` 做轴向匹配，
   最佳结果是 `PLY(x,y,z) → COLMAP(x,y,z)` 且符号全为正（相似度 0.873，次优仅 0.565），
   说明 **PLY 与 COLMAP 是同一个坐标系，没有轴交换也没有缩放**。
3. 结论：需要绕 X 轴转 180°（`quaternion.set(1,0,0,0)`）。默认视角则从翻转后的相机位姿反推：
   `yaw = 0.1767`、`pitch = 1.6268`，用该机位渲染的结果与源视频抽帧**逐像素吻合**，朝向确认无误。

> 换成别的模型时如果发现「侧躺」或「镜像」，说明该模型的世界系不同：
> 改 `model.json` 的 `flipX`，或在 `app.js` 的 `ensureMesh()` 里换成对应四元数
> （绕 Z 轴 180° = `set(0,0,0,1)` 与 `set(1,0,0,0)` 只差一个水平旋转角，调整 `yaw` 即可）。

### 6.3 `f_rest_*` 必须连续编号（★ 改量化参数前必看）

Spark 的 PLY 加载器要求球谐属性名为 `f_rest_0 … f_rest_{K-1}` **连续**，它只数到第一个断号为止。
而 Brush/INRIA 导出的 PLY 里这些属性是按**字典序**排列的
（`f_rest_0, f_rest_1, f_rest_10, f_rest_11, …, f_rest_9`），
一旦我们只保留部分系数（比如 SH2 保留 0-7、15-22、30-37），名字就会出现断号，
Spark 直接抛 `Invalid number of f_rest properties: N` 并且**静默加载出 0 个点**（画面全黑、控制台不报错）。

因此 `tools/pack.mjs` 在输出 PLY 表头时会把保留下来的系数**重新连续编号**为 `f_rest_0..K-1`
（顺序仍是通道优先 R→G→B，与标准 3DGS 布局一致）。
另外 `app.js` 在 `ensureMesh()` 里对解析结果做了「点数为 0 就报错」的兜底，避免再次静默黑屏。

实测 Spark 只接受 `f_rest` 个数 = 0 / 9 / 24 / 45（即 SH 0/1/2/3 阶），其余一律拒绝。

### 6.4 去雾功能

这个模型有约 3.3% 的高斯半径异常大（0.5~17 个世界单位，而场景本身才 20 单位高）且不透明度低，
叠加后把整个画面糊成白雾（用另外两套独立渲染器验证过，是数据本身的特性，不是渲染器问题）。
「去雾」按钮会按「三轴对数尺度的最大值 > −1.6」过滤掉这些点（22.8 万 → 18.8 万），画面立刻清晰。
阈值是 `app.js` 顶部的 `HAZE_LOG_SCALE`。该副本**懒加载**：第一次点击才生成，切换模型会重置为关闭。

### 6.5 取景范围用分位数而不是 min/max

模型的原始包围盒被远处零星「漂浮点」撑得很大（X 跨度 66、Z 跨度 67，而实际场景只有 20 左右），
直接用 min/max 取景会让相机退到很远，画面里只有一个小点。
`tools/build.mjs` 改算坐标的 **1%~99% 分位**存进 `model.json` 的 `frame`，
`app.js` 的 `frameModel()` 再按视口宽高比算出取景距离。

---

## 7. 已知问题与限制

* **模型本身偏糊**：源视频拍摄时分辨率/光照有限，加上 6.4 说的雾状高斯，属于数据质量，不是查看器问题。
* **首次加载约 3~6 秒**（下载 9.7 MB + 解压 + 上传 GPU），之后的刷新走浏览器缓存会快很多。
* **内存占用**：解码后的 PLY 字节流常驻内存（约 33 MB），用于「去雾」重新过滤。移动端低内存设备可能吃紧。
* 不支持 WebGL2 或 `DecompressionStream` 的老浏览器会显示明确的错误面板，不会白屏。
* 没有做 WebXR / 手势（VR）支持。

---

## 8. 变更日志

| 版本 | 变更 |
|---|---|
| v4（当前） | 只保留「楼梯间」模型；改为 `index.html + style.css + app.js + assets/` 分离结构，HTML 从 20 MB 降到 3 KB；UI 重做为液态玻璃质感并加入动效；桌面端与移动端分别适配；禁用右键平移；**修正模型上下颠倒**（经 COLMAP 位姿与源照片比对验证）；补 favicon、错误面板、调试接口、`tools/` 工具链与本文件 |
| v3 | 双模型 + 右上角切换列表；为塞进 25 MB 把球谐从 3 阶降到 2 阶；修复 `f_rest` 断号导致 Spark 静默加载 0 点的问题 |
| v2 | 引入量化 + deflate（29.7 MB → 8.6 MB）；去雾开关默认关闭；视角旋转取消天顶限制 |
| v1 | 单文件内联版，双击即可打开（29.7 MB） |

---

## 9. 排障速查

| 现象 | 原因 / 处理 |
|---|---|
| 打开是白屏，提示 `file://` | 用了双击打开。起本地服务器，见第 2 节 |
| 一直卡在「正在下载模型数据」 | `assets/model.bin` 路径不对或没上传；看浏览器网络面板 |
| 提示「高斯点云解析失败：结果为 0 个点」 | PLY 表头问题，多半是 `f_rest` 编号不连续，见 6.3 |
| 模型侧躺 / 上下颠倒 | 朝向问题，见 6.2 |
| 模型很小、缩在画面中间 | `model.json` 的 `frame` 不对，重新跑 `build.mjs` |
| 改了 `pack.mjs` 后画面异常 | 跑 `node tools/verify.mjs <原始PLY>` 看误差表 |
| 想调试相机/模型状态 | 控制台里有 `__viewer`（`__viewer.cam`、`__viewer.splats`、`__viewer.numSplats()`），URL 加 `#debug` 还会多一个状态面板 |

---

## License / 第三方

* [three.js](https://threejs.org/) — MIT
* [Spark](https://github.com/sparkjsdev/spark)（World Labs）— MIT
* 模型数据与源视频版权归模型作者所有。
