# 第三方组件与许可证核查

核查日期：2026-09-07。easy-score 自有代码与文档采用 [MIT](LICENSE)；本文件所列第三方组件保留其原有许可，用户上传的乐谱不因导入应用而获得再分发许可。MIT 不会将整个 Docker 镜像重新许可为 MIT。

## 核查范围与结论

**依赖并非全部采用 MIT。** 本次检查了 `package-lock.json` 的全部 144 个依赖条目（含开发、可选和不同平台包），核对主要运行依赖的实际许可证文件，并检查 Dockerfile 指定的识谱引擎、OCR 模型、音色和运行时来源。完整 npm 元数据清单见 [DEPENDENCY_LICENSES.md](docs/DEPENDENCY_LICENSES.md)。该清单不是整个镜像的完整 SBOM，也不能证明包内每个嵌入资源均遵循 package.json 的单一许可证标记。

没有在已核对的 npm 许可证条款中发现需要购买商业版、按用户数付费、限制个人使用或限制应用版本的条件。MIT、BSD、ISC、Apache、Zlib 等仍有声明保留等要求；AGPL/GPL 的源码义务不能以商业使用许可替代。升级到其他版本时应重新核对，不将当前结论外推到未来版本或上游另外提供的商业产品。

## npm 主要组件与准确版本

以 `npm ci` 使用的锁文件版本为准，区别于 package.json 中的 `^` 版本范围。

| 组件 | 锁定版本 | 许可 | 使用 / 再分发要求 |
| --- | --- | --- | --- |
| [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay/blob/2.1.2/LICENSE) | 2.1.2 | BSD-3-Clause | 保留 PhonicScore 版权、许可条件与免责声明；二进制分发也需随附；不得暗示上游背书。 |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom/blob/0.8.15/LICENSE) | 0.8.15 | MIT | 保留版权和许可。 |
| [fflate](https://github.com/101arrowz/fflate/blob/v0.8.3/LICENSE) | 0.8.3 | MIT | 保留版权和许可。 |
| [IconPark SVG](https://github.com/bytedance/IconPark/blob/bed2e8d1e451ffc66cbc4def3ba54fcc1f318d9e/packages/svg/LICENSE) | 1.4.2 | Apache-2.0 | 页面按钮按需使用官方 SVG 图标；保留完整许可和版权声明。包内未附单独 NOTICE，SVG 路径未修改，仅配置颜色、尺寸与描边。 |
| VexFlow | 1.2.93 | MIT（代码） | 保留版权和许可；嵌入记谱字体需独立核对。 |
| [JSZip](https://github.com/Stuk/jszip/blob/v3.10.1/LICENSE.markdown) | 3.10.1 | MIT OR GPL-3.0-or-later | 本项目选择 MIT；不是必须同时遵守 GPL。 |
| [Pako](https://github.com/nodeca/pako/blob/1.0.11/lib/zlib/README) | 1.0.11 | MIT AND Zlib | 两者同时适用。保留声明，不歪曲来源，修改过的源码需明确标注。 |
| Vite（构建工具） | 7.3.6 | MIT（主包） | 保留许可；其自身捆绑组件保留独立许可，见安装包 LICENSE.md。 |

锁文件还包含 ISC、BSD-2-Clause、Apache-2.0、BlueOak-1.0.0 等许可，部分来自可选原生构建工具，不能把锁文件条目数等同于浏览器实际下载的包数。`expand-template` 与 `rc` 的许可表达式也包含可选的 MIT 路径，本项目选择 MIT。

- [MIT](https://opensource.org/license/mit)、[ISC](https://opensource.org/license/isc)：保留版权和许可文本。
- [BSD-3-Clause](https://opensource.org/license/bsd-3-clause)：保留版权、条款与免责声明，禁止未经许可的背书；BSD-2-Clause 不含第三项背书条款。
- [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)：附带许可证，保留适用的版权、专利和署名，保留适用的上游 NOTICE，标记修改；含专利授权及专利诉讼终止条款，不授予商标使用权。
- [BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0)：向接收副本者提供该许可文本或链接，并注意其专利条款。

运行依赖的实际版权及许可证正文集中保存在 [public/third-party-licenses.txt](public/third-party-licenses.txt)，随前端构建发布；生产 `node_modules` 同时保留 npm 包自带的文件。这个集合只覆盖脚本明确收集的文件，不声称覆盖全部可选、构建、字体或上游内嵌组件。

## 钢琴与中音萨克斯音色

`public/soundfonts/piano.json` 和 `saxophone.json` 来自 MIDI.js Soundfonts 的 FluidR3_GM acoustic grand piano 与 alto saxophone MP3。音色没有应用包式的语义版本号，需按资源来源和内容摘要核对，不能用 npm 许可证扫描代替。

- 原始 Fluid (R3) SoundFont：Frank Wen，原始 README / COPYING 声明为 MIT。保留其版权和完整许可，来源见 [Fluid SoundFont COPYING](https://github.com/pianobooster/fluid-soundfont/blob/master/COPYING)。
- 使用的预渲染样本发行层：Benjamin Gleitzman 及 MIDI.js Soundfonts 贡献者，其 [README](https://github.com/gleitz/midi-js-soundfonts/blob/gh-pages/README.md) 将 FluidR3_GM 样本列为 [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/legalcode.en)。本项目同时保留该署名、许可链接与修改说明，未把此发行层改称为 MIT。
- 两层均允许商业使用；分发这些音色时仍需保留适用的版权、署名与许可证，不得暗示作者认可衍生产品。CC BY 3.0 US 还要求说明衍生修改，不能添加限制接收者行使许可权利的法律或技术措施。
- 本项目的修改：去掉 JavaScript 变量赋值包装，将样本映射序列化为 JSON；音频字节未作修改。

样本来源：[钢琴](https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js)、[中音萨克斯](https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/alto_sax-mp3.js)。完整原始 MIT 文本及样本署名见 [音色许可证](public/asset-licenses.txt)，该文件也随前端发布。源文件原始导入提交未记录；当前本地分发文件的 SHA-256：

- `piano.json`：`3ecf74e2f674056f1a1b82830b228b5d788e9036afc7eb290adc1fffeea7dca1`。
- `saxophone.json`：`aab5e8b4a0d7a3b6a5c28f8639414bb760dcee47eb421a77728f6482509aa90e`。

## 记谱字形与上游打包缺口

VexFlow 1.2.93 的 `src/fonts/gonville_all.js` 与 `gonville_original.js` 含 Gonville-18 `Version 0.1.8904` 元数据，声明 `No copyright is claimed on this font file.`，其中许可说明和链接字段为空。该声明已保存在 [asset-licenses.txt](public/asset-licenses.txt)，来源为 [对应版本的字形文件](https://github.com/0xfe/vexflow/blob/1.2.93/src/fonts/gonville_all.js)。不能据此将所有记谱字体统一标成 MIT、GPL 或 OFL；`vexflow_font.js` 和 `microtonal.js` 中未找到相同的独立字体声明，其原始字体授权链仍需进一步核实。

OSMD 2.1.2 的压缩文件引用 `opensheetmusicdisplay.min.js.LICENSE.txt`，但 npm 安装包中没有该文件。本项目已另外随附 OSMD 的完整 BSD 声明及锁定运行依赖的许可证；这不代表已还原上游缺失文件的全部内容，压缩包内嵌资源仍属于本次核查的未闭合项。

## 识谱引擎、运行时与 Docker 系统组件

| 组件 | 当前来源 / 版本 | 许可情况与要求 |
| --- | --- | --- |
| [Audiveris](https://github.com/Audiveris/audiveris/tree/9e1e55cd2746037d059345881c53e6a6754bffbd) | 官方 5.11.0 安装包；源码提交 `9e1e55cd2746037d059345881c53e6a6754bffbd` | GNU AGPL v3；保留许可与声明，分发二进制需按许可提供对应源码；修改该程序并通过网络提供交互时还需遵守第 13 条。 |
| [Node.js](https://github.com/nodejs/node/blob/v24.18.0/LICENSE) | 24.18.0 | 主项目 MIT，捆绑库另有 BSD、Apache、ICU 等许可；保留完整 Node LICENSE，不能只复制开头的 MIT。 |
| [Tesseract tessdata](https://github.com/tesseract-ocr/tessdata/blob/ced78752cc61322fb554c280d13360b35b8684e4/LICENSE) | Docker 固定提交 `ced78752cc61322fb554c280d13360b35b8684e4` 的 eng.traineddata | Apache-2.0；模型原样提供，并附完整许可证。macOS 安装脚本目前取 main，实际版本会随安装时间变化。 |
| [Poppler / pdftoppm](https://poppler.freedesktop.org/) | Ubuntu 24.04 的 poppler-utils | GPL 系列许可，具体文件与依赖许可按发行包 copyright 核对；再分发需履行适用源码义务。 |
| Python / Pillow / 字体 / 系统库 | Ubuntu 24.04 仓库安装 | 各自许可，包括 PSF、HPND、字体许可及 GPL/LGPL 等；不能从基础镜像名称推断为 MIT。实际版本以镜像内清单为准。 |

Audiveris 通过命令行子进程接收文件并输出 MusicXML，项目未修改其源码。但“独立进程”本身不是免除 AGPL 的法律判据，仍需结合通信方式、耦合程度和是否形成组合程序判断。MIT 自有代码声明不能覆盖或解除相关 copyleft 义务。参见 [GNU 关于聚合与组合程序的说明](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation) 及 [AGPL v3 正文](https://www.gnu.org/licenses/agpl-3.0.html)。

### 已保留的文件与待核实项

本次补充后的镜像保留：

- `/usr/share/doc/easy-score/LICENSE`、`THIRD_PARTY_NOTICES.md`、`AUDIVERIS.md`、`NODE_LICENSE`。
- `/usr/share/doc/easy-score/debian-packages.tsv`：安装的 Debian 包及源包版本，便于匹配源码；它不是源码压缩包。
- `/opt/tessdata/LICENSE`，以及发行包的 `/usr/share/doc/<包名>/copyright` 和 Audiveris 安装内容中的许可文件。
- `/usr/share/source/audiveris/audiveris-5.11.0.tar.gz`：固定提交的 Audiveris **主项目源码**，详见 [docker/AUDIVERIS.md](docker/AUDIVERIS.md)。

**尚未证明完整的对应源码提供义务已经满足。** 上述 Audiveris tarball 不自动包含官方安装器的全部 Java / 原生依赖和 JRE 源码，也没有为每个 GPL/LGPL 系统包附带精确匹配的源码。公开 Docker 镜像是二进制再分发；仅有上游链接、包版本清单或“未修改”说明不能替代适用许可证要求的源码提供方式。继续再分发或制作闭源商业集成前，需要按实际镜像 digest 补全这些组件的许可证、对应源码、构建信息与提供方式核查；如组合边界不明确，应取得针对该集成方式的许可判断。

本次未逐项审计 Audiveris 捆绑 JAR / 原生库 / JRE 和所有 Ubuntu 传递依赖。系统包安装未固定精确版本，镜像重建可能改变这些组件；旧 `1.0.0` 镜像也未被本次文档提交重新打包。以上是已确认的审计边界，不应对外宣称“全依赖 MIT”或“镜像已全面通过许可证合规认证”。

## 用户乐谱与 Logo

用户提供的 四驱小子 BeTop PDF 及识别结果属于本地测试数据，不是公开授权示例，未进入公共仓库或 Docker 镜像。使用者需自行确认其上传、演奏和传播乐谱的权利。

`public/easy-score.svg` 为项目所有者提供的原始 Logo，未作修改。第三方许可证不会授予对项目名称或 Logo 的商标背书权利。

## 后续依赖升级

运行 `npm ci` 后执行 `node scripts/license-report.mjs`，提交更新的清单与许可证正文；`--check` 可检查是否与当前安装及锁文件一致。该检查不是“许可自动批准”。升级音色、Audiveris、Node、OCR 模型或基础镜像时，另行核对相应发行版实际文件和源码，不仅检查 npm 的 license 字段。
