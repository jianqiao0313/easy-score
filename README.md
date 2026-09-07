# easy-score

<img src="public/easy-score.svg" alt="easy-score" width="120" />

网页版 PDF 五线谱识别与播放器。使用 Audiveris 识别印刷乐谱，以 OpenSheetMusicDisplay 显示五线谱，并通过 Web Audio 播放钢琴或中音萨克斯音色。

当前稳定版本：[1.0.1](https://github.com/jianqiao0313/easy-score/releases/tag/v1.0.1)。Docker 标签 `1.0.1` 对应此版本，`latest` 跟随 `main` 的最新构建。

## 使用 Docker 启动

镜像已发布到 [Docker Hub](https://hub.docker.com/r/jianqiao0313/easy-score)，包含完整识谱引擎和音色，无需额外安装 Java 或 Audiveris。

```sh
docker run -d --name easy-score -p 127.0.0.1:4173:4173 -v easy-score-data:/data jianqiao0313/easy-score:1.0.1
```

打开 [http://localhost:4173](http://localhost:4173)。PDF 和识别结果保存在 `easy-score-data` 数据卷中；更新镜像时保留该卷即可。

上面的单行命令适用于 x86_64 / amd64 主机。Apple Silicon 或其他 ARM 主机需在镜像名前加 `--platform linux/amd64`，并使用支持模拟运行的 Docker 环境。需要自动重启时，可再加 `--restart unless-stopped`。

默认端口只允许本机访问；需要远程访问时，可通过反向代理提供服务。应用没有账户和登录功能，适合个人使用或可信网络部署。

更新镜像时，将拉取和启动命令中的标签统一设置为目标版本（以下以 `1.0.1` 为例），并继续使用原数据卷：

```sh
docker pull jianqiao0313/easy-score:1.0.1
docker stop easy-score
docker rm easy-score
# 再次执行上面的 docker run 命令，继续使用原数据卷。
```

从源码构建镜像：

```sh
git clone https://github.com/jianqiao0313/easy-score.git
cd easy-score
docker compose up -d --build
```

也可以使用 `./scripts/docker-build.sh` 单独构建本地镜像。

## 如何使用

1. 上传印刷五线谱 PDF（最大 50 MB），等待识别完成。成功导入的乐谱会自动加入左侧“历史乐谱”，按导入时间倒序显示；点击即可重新打开、播放或查看原 PDF，无需重复识别。
2. 选择中音萨克斯或 Salamander 三角钢琴（明亮、清晰的 Yamaha C5 采样）。首次使用默认中音萨克斯，以后优先读取浏览器保存的选择。
3. 设置每行显示的小节数。默认“自动”会根据可用宽度自然排版并随窗口调整；手动选择 1–8 小节会固定每行数量和音符区域宽度，行首谱号、调号和拍号另留空间，最后一行不会拉伸。设置保存在当前浏览器的 `localStorage` 中。
4. 点击播放，可暂停、跳到上一小节或下一小节、拖动进度条，也可调整速度、音量和节拍器。
5. 切换到原始 PDF 对照，或导出 MusicXML 到制谱软件继续校对。

历史乐谱读取服务端本地数据目录中的记录（开发环境为 `.local/jobs`，Docker 为 `/data/jobs`），刷新页面、换浏览器或重启服务后仍可使用。保留 Docker 数据卷即可保留历史；识别失败或文件缺失的记录不会出现在列表中。

识别在你部署的服务器上运行。OMR 可能产生错音、漏音和节奏错误，清晰的印刷谱效果更好；手写谱和复杂排版可能无法正确识别。中音萨克斯选项只改变音色，不会自动移调。音色采样随应用提供，加载失败时会提示并使用合成音色。

## 本地开发

需要 Node.js 22.12 或更高版本，建议使用 Node.js 24。

```sh
npm ci
npm run dev
```

开发地址为 [http://127.0.0.1:4173](http://127.0.0.1:4173)，同一个服务提供前端和 API。

PDF 识别还需要 Audiveris。Apple Silicon macOS 可以运行：

```sh
./scripts/setup-omr.sh
```

脚本将 Audiveris 及英文 OCR 模型安装到 `.local/omr`，Audiveris 自带 Java。其他平台可自行安装 Audiveris，通过 `AUDIVERIS_BIN` 和 `TESSDATA_PREFIX` 指定路径，或使用 Docker。

安装 Poppler（`pdftoppm`）、Python 3 和 Pillow 可启用 350 DPI PDF 预处理及多页 TIFF 转换；缺少这些工具时会回退到 Audiveris 原生 PDF 处理。

```sh
npm test          # 自动化测试
npm run build     # 构建前端到 dist/
npm start         # 运行生产服务，需要先构建

# 服务启动后，用自己的 PDF 验证完整识谱流程：
node scripts/verify-live.mjs /path/to/score.pdf
```

## 配置与项目说明

| 环境变量 | 说明 |
| --- | --- |
| `HOST` / `PORT` | 本地默认 `127.0.0.1:4173`；镜像内监听 `0.0.0.0:4173` |
| `DATA_DIR` | 数据目录，本地默认 `.local`，镜像内为 `/data` |
| `AUDIVERIS_BIN` | Audiveris 可执行文件路径 |
| `TESSDATA_PREFIX` | 完整英文 OCR 模型目录，需支持传统识别，不能仅含 LSTM 模型 |
| `POPPLER_BIN` / `PYTHON_BIN` | 默认从 PATH 查找 `pdftoppm` / `python3` |
| `OMR_TIMEOUT_MS` | 每个识别处理阶段的超时，默认 `600000` 毫秒 |

- `server/`：上传接口、识别任务队列、PDF 预处理和 Audiveris 调用。
- `src/`：MusicXML 时间轴解析、音频播放、五线谱排版及界面交互。
- `public/fonts/`：随应用分发的思源黑体可变字体与 OFL 许可。
- `public/soundfonts/`：钢琴与中音萨克斯采样。
- `tests/`：解析、播放、偏好设置和服务测试。
- `Dockerfile`、`compose.yaml`、`docker/`：镜像构建、运行配置和容器识谱验证。

推送到 `main` 后，[GitHub Actions](https://github.com/jianqiao0313/easy-score/actions) 自动测试、构建并验证容器，再发布 `latest` 和 `sha-完整提交号` 镜像。版本标签 `v1.2.3` 会发布 `1.2.3` 和 `1.2` 标签；Pull Request 只验证，不发布。Fork 后若需发布到自己的 Docker Hub，请配置仓库变量 `DOCKERHUB_USERNAME` 和 Secret `DOCKERHUB_TOKEN`。

## 开源协议与第三方组件

easy-score 自有代码与文档采用 [MIT License](LICENSE)，允许使用、修改、分发和商业使用，分发时需保留版权声明与许可证。此授权不替代第三方代码、音色、字体及用户上传乐谱各自的许可证，也不表示整个 Docker 镜像都是 MIT。

第三方依赖并非全部为 MIT：OpenSheetMusicDisplay 2.1.2 为 BSD-3-Clause；Audiveris 5.11.0 为 AGPL-3.0；镜像中的 Poppler 使用 GPL。Salamander 钢琴采样采用 CC BY 3.0 Unported；中音萨克斯的预渲染发行层使用 CC BY 3.0 US，原始 Fluid SoundFont 使用 MIT；思源黑体使用 SIL OFL 1.1，均需保留相应署名和许可。JSZip 3.10.1 提供 MIT / GPL 双许可，本项目选择 MIT；Pako 1.0.11 需同时遵守 MIT 与 Zlib。

具体版本、商业使用与再分发要求、尚需核实的镜像源码范围，见 [第三方许可证核查](THIRD_PARTY_NOTICES.md)；所有 npm 锁定依赖见 [版本与许可证清单](docs/DEPENDENCY_LICENSES.md)。应用随附 [npm 许可证正文](public/third-party-licenses.txt) 与 [音色及字形声明](public/asset-licenses.txt)，构建后可通过 `/third-party-licenses.txt` 与 `/asset-licenses.txt` 获取。

升级依赖后执行 `node scripts/license-report.mjs` 更新清单，并人工复核许可变化；CI 用 `node scripts/license-report.mjs --check` 检查清单是否与锁文件一致。清单检查不能替代对捆绑代码、音色和镜像系统组件的核查。
