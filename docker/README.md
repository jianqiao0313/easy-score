# easy-score

easy-score 是一款网页版 PDF 五线谱识别与播放器。镜像内包含 Web 应用、Audiveris 识谱引擎和本地音色，可把印刷乐谱转换为可查看、播放和导出的 MusicXML。

## 快速启动

当前稳定版本为 `1.0.0`，镜像平台为 `linux/amd64`：

```sh
docker run -d --name easy-score \
  --restart unless-stopped \
  --platform linux/amd64 \
  -p 127.0.0.1:4173:4173 \
  -v easy-score-data:/data \
  jianqiao0313/easy-score:1.0.0
```

启动后打开 [http://localhost:4173](http://localhost:4173)。端口绑定到 `127.0.0.1`，只允许当前主机访问；如需提供远程访问，请在可信网络中配置反向代理。

## 功能

- 上传印刷五线谱 PDF，通过 Audiveris 进行 OMR 识别。
- 在服务端保存原 PDF、识别结果和乐谱历史，刷新页面或更换浏览器后仍可重新打开。
- 使用钢琴或中音萨克斯采样音色播放识别后的乐谱。
- 支持播放、暂停、回到开头、跳到下一小节、拖动进度、速度、音量和节拍器控制。
- 支持乐谱自动排版，或固定每行显示 1–8 小节。
- 在浏览器中保存音色和每行小节数偏好。
- 对照原 PDF，并导出 MusicXML 继续校对。

OMR 可能出现错音、漏音或节奏偏差，建议始终对照原谱校验。中音萨克斯选项只改变音色，不会自动移调。

## 数据持久化与升级

容器将数据写入 `/data/jobs`。上面的命令使用名为 `easy-score-data` 的 Docker 数据卷；删除或重建容器不会删除该卷中的 PDF、识别结果和历史记录。

升级时先拉取目标版本，停止并删除旧容器，然后使用相同的 `-v easy-score-data:/data` 参数和新版本镜像重新执行启动命令。不要删除 `easy-score-data` 数据卷。

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

## 项目链接

- [GitHub 源码](https://github.com/jianqiao0313/easy-score)
- [完整使用与开发文档](https://github.com/jianqiao0313/easy-score#readme)
- [Docker 构建文件](https://github.com/jianqiao0313/easy-score/blob/main/Dockerfile)
- [第三方组件与许可证](https://github.com/jianqiao0313/easy-score/blob/main/THIRD_PARTY_NOTICES.md)
