# easy-score

<img src="public/easy-score.svg" alt="easy-score logo" width="120" />

网页版 PDF 五线谱识别与播放器。使用 Audiveris 将印刷乐谱转换为 MusicXML，再以钢琴或中音萨克斯采样播放，支持节拍器、变速、暂停、定位、原始 PDF 对照和 MusicXML 导出。

## Docker 运行

镜像包含 Node.js、Audiveris 5.11.0、Java、英文 OCR 模型、Poppler 和 Python/Pillow，启动后即可识谱，无需另装引擎。目前支持 **linux/amd64**；Apple Silicon 通过 Docker 的 amd64 模拟运行。

首次发布需要先完成下方 Docker Hub 配置。发布后运行（替换命名空间）：

```sh
export DOCKERHUB_USERNAME=你的DockerHub用户名
docker run -d --name easy-score --restart unless-stopped \
  --platform linux/amd64 \
  -p 127.0.0.1:4173:4173 \
  -v easy-score-data:/data \
  "$DOCKERHUB_USERNAME/easy-score:latest"
```

打开 [http://localhost:4173](http://localhost:4173)。上传的 PDF 和识别结果保存在命名卷 `easy-score-data`，更新或替换容器时保留该卷即可。公开仓库和镜像不包含本机测试用的私人谱子、识别结果或截图。

本地构建与运行：

```sh
./scripts/docker-build.sh
docker compose up -d --build
```

Compose 默认只向本机开放 4173 端口。需要远程访问时，可在自己的反向代理后开放服务。应用暂不包含账户、访问控制、任务保留策略或多实例任务队列，上传内容会发送到你部署的识谱服务。

## GitHub Actions → Docker Hub

仓库：[jianqiao0313/easy-score](https://github.com/jianqiao0313/easy-score)。工作流位于 [.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)。

在仓库 [Actions secrets and variables](https://github.com/jianqiao0313/easy-score/settings/secrets/actions) 配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Repository variable | `DOCKERHUB_USERNAME` | Docker Hub 用户名/命名空间 |
| Repository secret | `DOCKERHUB_TOKEN` | 对目标仓库有写入权限的 Docker Hub Access Token |

使用该账号自己的命名空间，并在 Docker Hub 创建 `easy-score` 仓库。用户名也可使用同名 Repository secret；变量优先。令牌只保存在 GitHub Secrets，不应写进代码、Dockerfile 或聊天消息。

配置用户名也可使用 GitHub CLI：

```sh
gh variable set DOCKERHUB_USERNAME --repo jianqiao0313/easy-score --body 你的DockerHub用户名
# 交互输入令牌，不把令牌写入命令行或 Shell 历史：
gh secret set DOCKERHUB_TOKEN --repo jianqiao0313/easy-score
```

触发规则：

- 推送到 `main`：测试、构建镜像、验证容器，随后发布 `latest` 和 `sha-完整提交号`。
- 推送 `v1.2.3` 等版本标签：发布 `1.2.3`、`1.2` 和提交标签，不覆盖 `latest`。
- 面向 `main` 的 Pull Request：执行测试、镜像构建和容器验证，不登录或发布 Docker Hub。
- Actions 页面支持手动运行；只有通过验证的镜像才会发布。缺少发布凭据时会明确失败并说明配置项。

本地 `git commit` 后还需 `git push origin main` 才会触发 GitHub。发布步骤对刚验证过的同一个镜像添加标签并推送，无需在 Docker Hub 再设置自动构建。

容器验证会实际上传 Audiveris 官方仓库的 `Dichterliebe01.pdf`，等待识别完成并读取 MusicXML；测试文件固定源代码提交和 SHA-256，不使用用户私人谱子。

## 本地开发

要求 Node.js 22.12+，建议 Node.js 24：

```sh
npm ci
./scripts/setup-omr.sh
npm run dev
```

[http://127.0.0.1:4173](http://127.0.0.1:4173)。安装脚本适用于 Apple Silicon macOS，将 Audiveris 和英文 OCR 模型放到 `.local/omr`，附带 Java。其他平台推荐 Docker，或通过 `AUDIVERIS_BIN` 指定自行安装的引擎。

优先使用 Poppler `pdftoppm` 以 350 DPI 渲染，多页 PDF 使用 Python/Pillow 合成为多页 TIFF。本地缺少工具时会回退到 Audiveris 原生 PDF 识别并显示提示，不会静默丢页。

```sh
npm run build
npm start
npm test
# 可选：使用自己的 PDF 验证完整识谱链路（要求服务已启动）：
node scripts/verify-live.mjs /path/to/score.pdf
```

| 环境变量 | 默认值/作用 |
| --- | --- |
| `HOST` | 本地 `127.0.0.1`；镜像设置为 `0.0.0.0` |
| `PORT` | `4173` |
| `DATA_DIR` | 本地 `.local`；镜像 `/data`，含 `jobs` 和可选 `demo` |
| `AUDIVERIS_BIN` | Audiveris 可执行文件路径 |
| `TESSDATA_PREFIX` | 完整英文 OCR 模型目录，不能使用只有 LSTM 的 fast 模型 |
| `POPPLER_BIN` / `PYTHON_BIN` | 默认从 PATH 查找 `pdftoppm` / `python3` |
| `OMR_TIMEOUT_MS` | 每个处理阶段的进程超时，默认 `600000` 毫秒 |

## 使用与识别限制

1. 上传自己的印刷五线谱 PDF（最多 20 MB），等待识别。
2. 选择钢琴或萨克斯音色，按需开启节拍器、调整速度，再点击播放。
3. 对照原始 PDF 校验；可下载 MusicXML 在制谱软件中修改。

OMR 可能出现错音、漏音、节奏和延音线错误，手写谱、复杂排版和低质量扫描不保证可用。未支持的 MusicXML 导航会显示说明。萨克斯选项仅更换音色，不自动改变原谱调性。

开发阶段用户样谱已验证：39 小节、167 BPM、156 拍、125 个延音线合并后的发声事件。原谱未打印拍号，按 4/4 处理并显示提示。双页验证得到 78 小节、312 拍。样谱没有随公开项目分发；只有部署者自行配置真实示例后，网页才显示示例入口。

## 项目结构

- `server/`：HTTP 接口、识谱队列、PDF 预处理和 Audiveris 进程。
- `src/musicxml.mjs`、`src/audio.mjs`：音符时间轴与采样播放。
- `src/main.js`、`src/style.css`：界面交互与乐谱渲染。
- `public/easy-score.svg`：用户提供的原始 Logo。
- `public/soundfonts/`：本地音色采样。
- `Dockerfile`、`docker/`、`scripts/docker-build.sh`：镜像构建与验证。
- `tests/`：解析、播放与服务测试。

第三方来源、许可证和 Audiveris 对应源代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
