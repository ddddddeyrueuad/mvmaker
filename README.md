# MV 自动生成工坊（MVMaker）

输入一首歌，自动产出一条 MV。桌面应用（Electron），全链路本地驱动，AI 环节走 Agnes OpenAI 兼容网关。

音频切片 → MERT 情绪分析 → 分镜大纲 → 文生图 → 图生视频 → ffmpeg 合成

<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.45-blue" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows%20x64-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

## 下载

最新版安装包（206 MB，NSIS one-click，per-user 安装免管理员）：

**[Releases · v1.1.45](https://github.com/ddddddeyrueuad/mvmaker/releases/latest)**

安装包已内置 ffmpeg 与后端运行时，无需另行准备环境。

## 配置

需要自备 **Agnes API Key**（OpenAI 兼容网关），二选一：

1. **界面输入**（推荐）—— 启动后在「API Key」输入框填写，优先于配置文件
2. **配置文件** —— 复制模板并填写

```bash
cp server/.env.example server/.env
```

```ini
AGNES_API_KEY=your-key-here
```

> `server/.env` 已被 `.gitignore` 排除，不会误提交。

**MERT 情绪分析**为可选本地模块，不启用则跳过，不影响主链路。启用需自行安装 torch / transformers / librosa 并下载模型，路径由 `MERT_MODEL_PATH` 指定。

## 从源码运行

```bash
# 1. 安装依赖
npm install
npm --prefix server install

# 2. 配置（见上）
cp server/.env.example server/.env

# 3. 离线回归测试（不依赖外部服务）
npm run verify

# 4. 开发模式
npm run dev          # 启动后端 3001
npm --prefix client run dev   # 启动前端 5173

# 5. 打包
npm run build        # 产物在 release/
```

## 架构

```
client/          React18 + Vite，五步向导
  src/steps/     Step1 上传 → Step2 分镜 → Step3 出图 → Step4 视频 → Step5 合成
server/          Express 后端
  src/services/  agnesHttp / llm / mert / t2i / i2v / compose
                 storyboard / styles / camera / mapping
  src/utils/     ffmpeg 封装、输出目录
electron/        主进程、server 运行时自解压
```

生成链路上的 AI 调用全部收敛在 `server/src/services/`：

| 服务 | 职责 |
|---|---|
| `llm.js` | 分镜大纲、镜头提示词、中文补全（带自愈重试） |
| `mert.js` | 本地情绪/能量/亮度/语速分析 → 视觉映射 |
| `t2i.js` | 文生图，含 content-policy 净化与重试 |
| `i2v.js` | 图生视频，两阶段异步轮询 |
| `compose.js` | ffmpeg 合成 |
| `storyboard.js` | 大纲编排、人物场景配额、连续性锁定 |
| `styles.js` | 风格库与跨风格隔离 |
| `camera.js` / `mapping.js` | 运镜与景别决策 |

## 回归测试

`npm run verify` 串联全部离线验证，不需要 API Key：

| 命令 | 覆盖 |
|---|---|
| `verify:json` | JSON 截断修复与解析自愈 |
| `verify:story` | 故事大纲编排、场景多样性 |
| `verify:chunk` | 分块大纲生成 |
| `verify:content` | 分镜内容质量校验 |
| `verify:quote` | 裸引号修复与回声退化检测 |
| `verify:zh` | 中文提示词补全 |
| `verify:style` | 跨风格隔离（选 A 不出现 B/C/D） |
| `verify:selfheal` | 端到端自愈（mock Agnes + mock MERT） |

CI 配置见 `.github/workflows/verify.yml`，在 Ubuntu / macOS 上跑。

## 实现要点

- **分块大纲**：CHUNK=10 逐块生成，规避推理模型大输出退化导致的空内容
- **JSON 自愈链**：截断修复 → 裸引号转义 → 回声短路检测；多轮差异化重生成（低温 + json 约束 / 高温 + 纯文本）打破回声循环
- **i2v 两阶段**：`task_id` → 轮询 → `video_id` → 取下载地址（网关完成响应不直接给 URL）
- **风格隔离**：选定风格后剥离其余风格特征词，避免风格污染
- **人物配额**：按段落分配主角 / 双人 / 纯景比例（纯景只落在有风景信号的段落）
- **连续性锁定**：角色描述、服装、主角锁定行贯穿全片

## 免责声明

本项目为个人作品，仅供学习交流。使用者需自备 API Key 并遵守所用服务商的条款；生成内容的版权与合规责任由使用者自行承担。
