# easy-score

easy-score 是一款网页版 PDF 五线谱识别与播放器。镜像内包含 Web 应用、Audiveris 识谱引擎和本地音色，可把印刷乐谱转换为可查看、播放和导出的 MusicXML。

## 快速启动

当前稳定版本为 `1.0.1`。x86_64 / amd64 主机复制下面一行即可启动：

```sh
docker run -d --name easy-score -p 127.0.0.1:4173:4173 -v easy-score-data:/data jianqiao0313/easy-score:1.0.1
```

启动后打开 [http://localhost:4173](http://localhost:4173)。端口绑定到 `127.0.0.1`，只允许当前主机访问；如需提供远程访问，请在可信网络中配置反向代理。

Apple Silicon 或其他 ARM 主机需在镜像名前加 `--platform linux/amd64`，并使用支持模拟运行的 Docker 环境。长期运行需要自动重启时，可再加 `--restart unless-stopped`。

## 功能

- 上传印刷五线谱 PDF（最大 50 MB），通过 Audiveris 进行 OMR 识别。
- 在服务端保存原 PDF、识别结果和乐谱历史，刷新页面或更换浏览器后仍可重新打开。
- 使用钢琴或中音萨克斯采样音色播放识别后的乐谱。
- 支持播放、暂停、跳到上一小节或下一小节、拖动进度、速度、音量和节拍器控制。
- 支持乐谱自动排版，或固定每行显示 1–8 小节。
- 在浏览器中保存音色和每行小节数偏好。
- 对照原 PDF，并导出 MusicXML 继续校对。

OMR 可能出现错音、漏音或节奏偏差，建议始终对照原谱校验。中音萨克斯选项只改变音色，不会自动移调。

## 数据持久化与升级

容器将数据写入 `/data/jobs`。上面的命令使用名为 `easy-score-data` 的 Docker 数据卷；删除或重建容器不会删除该卷中的 PDF、识别结果和历史记录。

从旧版本升级到 `1.0.1`：

```sh
docker pull jianqiao0313/easy-score:1.0.1
docker stop easy-score
docker rm easy-score
```

再执行上面的单行启动命令，继续使用原 `easy-score-data` 数据卷，历史乐谱会保留。不要删除该数据卷。

查看数据卷：

```sh
docker volume inspect easy-score-data
```

## 环境变量

| 变量 | 容器默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP 服务监听地址 |
| `PORT` | `4173` | HTTP 服务端口；镜像健康检查使用 4173，建议保留默认值 |
| `DATA_DIR` | `/data` | 持久化数据根目录 |
| `OMR_TIMEOUT_MS` | `600000` | 每个识别处理阶段的超时时间，单位为毫秒 |
| `AUDIVERIS_BIN` | `/opt/audiveris/bin/Audiveris` | Audiveris 可执行文件路径 |
| `TESSDATA_PREFIX` | `/opt/tessdata` | Tesseract 英文 OCR 模型目录 |
| `POPPLER_BIN` | `/usr/bin/pdftoppm` | PDF 页面渲染程序路径 |
| `PYTHON_BIN` | `/usr/bin/python3` | 多页图像处理使用的 Python 路径 |

通常只需调整 `OMR_TIMEOUT_MS`。如需传入环境变量，可在 `docker run` 中增加例如 `-e OMR_TIMEOUT_MS=900000`。

## 开源协议与第三方组件

easy-score 自有代码与文档采用 [MIT License](https://github.com/jianqiao0313/easy-score/blob/main/LICENSE)，允许使用、修改、分发和商业使用；分发时需保留版权声明与许可证。第三方组件、音色、字体和用户上传的乐谱仍遵循各自的许可，整个 Docker 镜像并非统一采用 MIT。

- OpenSheetMusicDisplay 2.1.2：BSD-3-Clause，分发时保留版权、许可和免责声明，不得暗示上游背书。
- Audiveris 5.11.0：AGPL-3.0；Poppler：GPL。再分发相关二进制时需履行对应源码等义务；修改 AGPL 程序并向网络用户提供服务时，还需关注其源码提供要求。
- JSZip 3.10.1：本项目选择双许可中的 MIT；Pako 1.0.11：MIT 与 Zlib 均需遵守。
- Salamander 三角钢琴：Alexander Holm，CC BY 3.0；中音萨克斯：FluidR3 原始 MIT、MIDI.js 预渲染发行层 CC BY 3.0 US。保留各自的署名、许可与处理说明。
- 思源黑体 2.005R：SIL OFL 1.1；官方可变 WOFF2 本地分发，保留许可原文，未修改字体文件。记谱字形的独立许可见下方核查文档。

镜像包含 Audiveris 主项目的固定版本源码压缩包，但这不等同于已核实其全部捆绑依赖、Java 运行时及系统组件的对应源码完整性。具体来源、义务和待核实项见 [第三方许可证核查](https://github.com/jianqiao0313/easy-score/blob/main/THIRD_PARTY_NOTICES.md) 与 [npm 版本及许可证清单](https://github.com/jianqiao0313/easy-score/blob/main/docs/DEPENDENCY_LICENSES.md)。

`1.0.1` 镜像在 `/usr/share/doc/easy-score/` 保存应用许可证、声明、Node 许可证及系统包版本清单，在 `/opt/tessdata/LICENSE` 保存 OCR 模型许可证；npm 许可证及音色、字形声明可通过应用的 `/third-party-licenses.txt` 和 `/asset-licenses.txt` 下载。

## 项目链接

- [GitHub 源码](https://github.com/jianqiao0313/easy-score)
- [完整使用与开发文档](https://github.com/jianqiao0313/easy-score#readme)
- [Docker 构建文件](https://github.com/jianqiao0313/easy-score/blob/main/Dockerfile)
- [第三方组件与许可证](https://github.com/jianqiao0313/easy-score/blob/main/THIRD_PARTY_NOTICES.md)
