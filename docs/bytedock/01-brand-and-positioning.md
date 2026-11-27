# 01 · ByteDock 品牌与产品独立定位规范

> 本文档为 ByteDock 独立品牌与去商标耦合规范（已脱敏收编至仓库 `docs/bytedock/`）。

---

## 一、最终品牌定型：`ByteDock`

### 1. 名称拆解与品牌意象

- **`Byte`（字节）**：最经典的计算机基础词，零英文门槛、一眼即是写代码与软件工程产品；同时读音与 **`Bite`（咬一口）** 完全相同，自然接住 **`byte.didyou.eat`** 的彩蛋。
- **`Dock`（扩展坞 / 停靠台 / 船坞）**：一个统一、稳固的全栈底座——多厂商模型 Agent、QQ/飞书/GitHub Bot、热重载插件、全端面板、工作区配方插上来即可协同工作，天然兜得住桌面 GUI + 移动端 + 多机远程 + 插件生态的大格局（避免了 `*mux` 强绑定纯终端工具的认知上限，也避开了 2026 年 `cmux/amux/dmux/devmux/codemux/AgentMux` 扎堆的脸盲问题）。

### 2. 品牌核心定位与对外叙事

- **中文定位**：**面向研发的全栈多 Agent 扩展坞** —— 零遥测可审计、免出包热重载插件、真工程级多 Agent 协作、本土 Bot 闭环、Windows 一等公民。
- **英文定位参考**：_ByteDock — The open, zero-telemetry, hot-reloadable multi-agent dock for full-stack development._
- **市场切入窗口（反击官方 T3 Code 痛点）**：
  - 官方 `pingdotgg/t3code` 于 2026 年 11 月下旬爆发严重信任危机（默认 PostHog 遥测并悄悄删除“零遥测”承诺、读取 `~/.claude.json` 与 `~/.codex/auth.json` 生成账号哈希、Relay tracing 曾暴露 `git.cwd` 绝对路径、针对 Fork 强硬商标与闭源言论）。
  - `ByteDock` 既**彻底遵守 MIT + 去商标规范（完全去除 `T3` 前缀与官方 Logo）**，又把**可验证零遥测（Egress Guard 出站白名单防火墙 + 凭证隔离 + CI 禁遥测门禁）**做成看得见的头号信任牌。

---

## 二、全栈命名与资产规范（实测验证结果）

| 资产项                       | 推荐值                                                                                | 实测状态与备注                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **产品显示名**               | `ByteDock`                                                                            | 全网 AI 编程赛道 **0 撞车**                                                                                                                            |
| **官网 / 宣传站**            | `https://byte.didyou.eat`                                                             | 谐音 _bite, did you eat?_，与 `share.didyou.eat` 家族统一                                                                                              |
| **npm 裸包 / CLI**           | `bytedock`（`npx bytedock`）                                                          | 2026-11-26 实测 npm `bytedock` **空闲未注册**（建议尽早占位）                                                                                          |
| **npm Scope（内部/SDK 包）** | `@bytedock/*`（如 `@bytedock/plugin-sdk`、`@bytedock/client`、`@bytedock/contracts`） | 用于插件 SDK、客户端 SDK 与内部 monorepo 包                                                                                                            |
| **GitHub 组织 / 仓库**       | `bytedock-dev/bytedock` 或 `bytedock-ai/bytedock`                                     | 实测 `github.com/ByteDock` 被一个 2023 年停更的 3 仓库组织占用，全 GitHub 同名仓库仅 12 个且全 0★；`bytedock-dev` 与 `bytedock-ai` 均实测 **404 空闲** |
| **本地数据目录**             | `~/.bytedock/`                                                                        | 与官方 `~/.t3` 及旧 `~/.t3-plus` 完全隔离共存，互不损坏数据库                                                                                          |
| **插件目录与配置**           | `~/.bytedock/plugins/` · `~/.bytedock/plugins.yml`                                    | 支持开发态目录监听热重载与 Profile 场景化开关                                                                                                          |
| **插件清单文件名**           | `bytedock-plugin.json`                                                                | 强 Effect Schema 校验，含 4 级权限声明                                                                                                                 |
| **工作区配方文件**           | `bytedock.recipe.yaml`（项目根目录 `.bytedock/`）                                     | 可随 Git 仓库分享插件集、角色模板、模型分层与自动化工作流                                                                                              |
| **插件隔离数据目录**         | `~/.bytedock/plugins-data/<pluginId>.sqlite`                                          | 插件禁止触碰主库 `statev2.sqlite` 表结构                                                                                                               |
| **Windows 应用标识 / AUMID** | `dev.bytedock.desktop`                                                                | 独立 Windows 通知、安装目录、自动更新源与 Defender 排除项                                                                                              |
| **默认主题与视觉基因**       | `ByteDock Dark / Light`（深灰底 + 高辨识度柑橘橙高亮 `#f97316`）                      | 彻底区分于官方黑白视觉，同时也与 Docker 蓝 / 字节跳动蓝拉开视觉辨识度                                                                                  |
| **Logo 视觉方向**            | 暗色圆角底板 + 柑橘橙几何“字节扩展坞/插槽（Dock Bay + Byte Block）”极简图标           | 适配 Windows 托盘、macOS Dock、Web Favicon 与 Mobile App Icon                                                                                          |

---

## 三、彻底“去 T3 化”与商标合规清单（Milestone 0 执行项）

依据原仓库 [TRADEMARK.md](file:///D:/Project/AgentLearn/t3code/TRADEMARK.md) 与 [README.md](file:///D:/Project/AgentLearn/t3code/README.md#L154-L165)，MIT 仅授权源码，不包含 `T3 Code` 名称、Logo、图标与外观包装。在公开发布前必须完成：

1. **品牌文本与标识替换**：
   - 替换桌面应用名、窗口标题、安装器名称（NSIS / DMG / AppImage）、协议头（`t3://` → `bytedock://`）、应用图标与 Wordmark。
   - CLI 入口命令与帮助文档全面切换为 `bytedock`，README 明确声明“独立开源项目，基于 MIT 协议源码演进，与 T3 Tools, Inc. 无隶属关系”。
2. **数据与配置目录隔离**：
   - 默认运行目录由 `~/.t3` / `~/.t3-plus` 切换为 `~/.bytedock`（保留一次性只读导入向导供老用户迁移已有项目列表与配置，绝不直接改写 `~/.t3/userdata`）。
3. **发布与更新源独立**：
   - 自动更新检查源、GitHub Release 仓库、Linux 安装脚本与托管前端入口全部指向 `ByteDock` 自主基础设施（后续可按需统一切换至正式发布组织）。
4. **隐私与遥测清零门禁**：
   - 延续 commit `6db337e551` 的零出站遥测基线，在 CI 中固化静态检测规则，禁止任何上游移植带回 PostHog / Sentry / Clerk 商业追踪或未授权读取外部 CLI 认证文件的逻辑。
