# Canvas Authoring

![Canvas Authoring icon](./icon.svg)

Canvas Authoring adds mind-map-style node creation, orthogonal links, font colors, duplication, clipboard tools, and a Claude Canvas theme. The theme is enabled by default and can be turned off in the plugin settings.

## Features

- **Mind-map-style connections:** Add child and sibling nodes with clean orthogonal links. Add follow-up nodes with native directional arrows.
- **Claude Canvas theme:** Use a light canvas, soft pastel cards, warm gray links, and clear selection states. The theme starts enabled and can be toggled off in settings.
- **Font colors and transparent cards:** Set or reset text color independently from card color; make annotation cards transparent.
- **Node and group editing:** Duplicate selections, preserve internal links, and add annotations without rearranging existing nodes.
- **Clipboard and navigation:** Copy useful text from nodes, exchange group data, and create links that jump to a specific Canvas node.

## Installation

1. Open **Settings → Community plugins → Browse** in Obsidian.
2. Search for **Canvas Authoring** and select **Install**.
3. Enable **Canvas Authoring** in **Settings → Community plugins**.

For a manual or development install, create `.obsidian/plugins/canvas-authoring/` in your vault and copy `main.js`, `manifest.json`, and `styles.css` from a GitHub release into that folder. Then enable the plugin in Obsidian.

## Usage

- Select a text or file node and press **Tab** to add a child node.
- Select a node with a single arrowless incoming edge and press **Enter** to add a sibling.
- Use the command palette or a node context menu to add a follow-up node, annotation, or duplicate.
- Use the green handles around a selected node to add and connect a child.
- Open **Settings → Community plugins → Canvas Authoring** to turn **Claude Canvas Theme** off or back on.
- Use the context menus and command palette for node links, group import/export, clipboard actions, text color, and font scale.

Canvas Authoring relies on Obsidian's internal Canvas runtime APIs, which may change between Obsidian releases. Back up your vault before major Obsidian upgrades and review Canvas behavior after updating.

独立的 Obsidian Canvas 扩展，不依赖 Advanced Canvas。Claude Canvas 外观主题已集成在插件内，默认开启，也可在插件设置中关闭。

在 Obsidian 社区插件市场安装 Canvas Authoring 并启用。开发版安装时将 `dist/` 中的 `main.js`、`manifest.json` 和 `styles.css` 放入 Vault 的 `.obsidian/plugins/canvas-authoring/`，然后在第三方插件设置中启用。更新后重新加载插件。

- 选中一个文字或文件节点，Tab 添加较小的子节点，无箭头折线连接。
- 选中只有一条无箭头入线的节点，Enter 从该入线的来源节点添加同级节点，并继承连接方向。这只是绘图操作，不要求整张图为树。
- 命令面板与节点右键菜单提供以上操作以及“添加后续节点”（原生曲线箭头）。后续节点命令可在 Obsidian 设置里绑定快捷键。
- 编辑文本时不拦截按键。新建节点纵向避让已有卡片，不重排旧节点。

只使用原生 `.canvas` 字段：两端无箭头表示关联，用折线显示；有箭头表示有方向的推进，使用原生曲线。无箭头连线不强制表达父子关系，不做树结构约束。不存储 `authoringRelation` 或自定义线型字段。禁用插件后内容和连线保留，折线恢复原生曲线。原生省略值按 fromEnd=none、toEnd=arrow 读取。

Canvas 的运行时 API 不属于 Obsidian 公共 API，升级 Obsidian 后需检查创建、撤销/重做、保存重开、拖动后的折线和文本编辑快捷键。Claude Canvas 主题只使用本地 CSS，不请求网络资源，也不修改 Canvas 文件数据。

选中节点后，边框四个方向出现绿色“＋”，点击向对应方向添加子节点。绿色“＋”也可拖拽：拖到现有节点建立无箭头关联，拖到空白处弹出原生新建节点菜单，选择后自动连接；取消不留下悬空线。拖拽沿用原生吸附、拖动平移和取消操作。按钮偏离边的中点，保留原生蓝色连接点。上下分支使用纵向折线，左右分支使用横向折线。安装时也需复制 `styles.css`。

选中文字节点后，工具栏 T 或右键“文字颜色”可调整 `fontColor`；选择“默认”删除字段，沿用正文默认色。原生颜色面板新增透明选项，`color: "transparent"` 表示隐藏卡片底色和边框；其它原生颜色仍按原生方式控制边框和底色。透明是本插件支持的扩展值。

“添加备注”创建同一个原生 text 节点，组合 `authoringStyle: "annotation"`、`color: "transparent"`，不设置 `fontColor`，沿用默认正文颜色。`authoringStyle` 仅表达这是备注／评论，不决定外观，不作为游戏流程或行动；正文仍自由书写。右键“作为备注／评论”可独立切换这一标记，颜色不随之改变。原有备注的旧外观数据已转换，说明标记保留。关闭插件后文本与位置保留，扩展外观不再显示。


Command/Ctrl+D 生成副本（可在快捷键设置修改），保留文字、尺寸和样式。单节点不复制外部连线；多节点只复制选区内部连线，不区分箭头类型。复制分组包含完全落在框内的节点；跨框节点不自动纳入。副本在原位置朝当前视口中心方向横纵各错开 32，允许与已有内容重叠，不再向远处寻找空位。复制后选中副本，保持当前视角与缩放，方便直接拖动；原节点不移动，不自动进入文字编辑。

### 分组剪贴板往返

分组右键“复制分组数据”将原生 `{nodes, edges}` JSON 写到纯文本剪贴板，便于发送给其他人或 Agent。包含分组、完全在框内的节点（包括嵌套分组和独立备注）、内部连线及扩展样式；跨边界节点与外部连线不带走。文件节点仅保存引用，不打包图片或笔记正文。

修改 JSON 中的文字后，在画板空白处右键“从剪贴板粘贴分组”；也可使用同名命令。接受原始 JSON 或完整的 JSON 代码块。导入前检查节点、尺寸、ID 与连线引用，错误数据不写入画板。始终创建新 ID，不覆盖原稿，保留相对布局并避让已有内容。右键使用点击位置，命令默认追加到画板下方；完成后选中并聚焦副本。替换原稿由作者审阅后手动决定。

### 普通复制与节点数据

Command/Ctrl+C 和右键“复制”用于复制内容，不再向外部软件默认输出 JSON。文字编辑中仍只复制选中的文字。

- 文字、备注：正文 Markdown 与富文本。
- 单张图片：图片像素（系统剪贴板 PNG）；GIF 等格式按静态图片复制。
- Markdown 笔记引用：笔记正文；章节／块引用只复制对应部分，找不到引用时提示错误，不退回复制整篇。
- 网页：网址；其它文件：文件名与 Obsidian 打开链接，不打包文件。链接需要在装有对应 Vault 的环境打开。
- 分组、多选：按分组层级、从上到下、同一行从左到右合并内容；备注保留，不推断流程含义。富文本包含图片，纯文本包含图片名称与链接。外部应用是否接受混合富文本由目标应用决定。

普通复制保留原生 Canvas 私有剪贴板数据；异步图片／富文本写入时，在 HTML 的不可见注释中携带同一节点片段。本插件在 Canvas 内粘贴时还原节点、相对位置、样式和内部连线；外部显示的正文不含这些数据。HTML 被其它软件过滤后，不保证还能恢复原始节点。

“复制节点数据／复制分组数据”明确输出原生 `{nodes, edges}` JSON，供 Agent 阅读修改与导回；不会复制图片文件本体。“从剪贴板粘贴内容”支持带分组或不带分组的节点 JSON。暂不提供整块白板复制为图片。

### 节点跳转引用

右键任意节点或分组“复制跳转链接”（或选中一个节点后使用同名命令），得到 `[[目录/文件.canvas#node=稳定ID|标题]]`。粘贴到普通文字节点或 Markdown 笔记，点击渲染后的链接即可打开目标画板、选中并聚焦该节点。支持同图和跨图，不保存坐标，不生成导航连线。删除目标后明确提示引用失效，不猜测同名节点。ID 不变时移动节点不会影响引用；跨文件移动或重命名后应检查自定义片段链接，不能保证插件关闭时的节点定位。

独立详细稿优先使用原生文件链接 `[[目录/详情.canvas|查看详情]]`，这样关闭本插件仍能打开文件。仅需要精确定位时添加 `#node=...`；插件关闭后精确定位不保证生效，正文与文件仍然保留。

### 外部文字粘贴尺寸

从外部粘贴文字到画板空白处时，按当前正文字体测量源文本，短笔记收窄，普通段落与长文使用不同阅读宽度，高度复用原生双击底边的适应逻辑计算。宽度限制为 200–600，高度限制为 48–600（画板坐标，与缩放无关）；长文超出部分沿用原生节点的滚动和编辑。宽度按源文本选择，等待节点自身预览渲染后调用原生底边适应方法，不再另外渲染一份 Markdown 测量；自动粘贴仍保留高度上限，手动双击底边不受该上限限制。

只在粘贴新建文字节点时计算一次，后续编辑不自动改尺寸。复制节点、插件携带的节点片段、分组导入和生成副本继续保留原尺寸；图片、附件和网址继续使用原生粘贴行为。更新 Obsidian 后需检查原生 `handlePaste` 的文字分支仍同步调用 `createTextNode`。

### 外部富文本粘贴

在画板空白处粘贴外部富文本，新建文字节点时优先使用剪贴板的 Markdown；否则使用 Obsidian 编辑器同款 HTML→Markdown 转换，保留其支持的表格、标题、列表、链接、强调、引用和代码块。尺寸按转换后的 Markdown 计算。遵循 Obsidian 的“自动转换 HTML”设置；从 Obsidian 编辑器复制的 Markdown 源文不重复转换。节点复制、图片／附件和原生网址节点的粘贴路径不变。

格式保留范围由 Obsidian 的 Markdown 转换能力决定，不保留网页字体、颜色、复杂排版与交互组件。若来源只提供纯文本，或内容在之前的复制环节已被摊平，不推断恢复表格结构。

拖拽连线到空白处的原生菜单也提供“添加备注”，按落点创建并连接透明备注。新建备注默认使用正文颜色，之后可自由修改文字颜色；已有备注不批量改色。

### Claude Canvas 主题

在“设置 → 第三方插件 → Canvas Authoring”中启用“Claude Canvas 主题”。主题只影响 Canvas：近白无点阵画布、默认白色便签、六种淡彩卡片、柔和阴影、暖灰连线、蓝色选中边框；节点和分组底色均跟随所选颜色。透明备注、自定义文字颜色及原有节点数据保留。关闭开关即可恢复原主题，浅色画布独立于应用的深浅模式。

沿用 Obsidian 的六种原生颜色槽，不增加新的颜色数据或修改节点尺寸；截图中的额外颜色选项与富文本工具栏不属于该外观片段。

Claude 主题只映射原生颜色值：无颜色为白色，`1` 淡红、`2` 淡橙、`3` 淡黄、`4` 淡绿、`5` 淡青、`6` 淡紫，`transparent` 保持透明。节点、分组和底色选择面板使用同一套淡彩；文字颜色使用较深的同色系。不会新增颜色 ID 或改写 Canvas 数据。

新建备注正文为空。空白透明文字节点显示灰色“双击输入文字”占位提示，进入编辑时隐藏；提示不写入 Markdown，也不参与复制、导出与保存。已有正文不自动删除。

备注创建沿用原生文字节点的默认尺寸；通过框选区域创建时沿用该区域尺寸，不再单独设置备注宽高。

编辑文字时编辑器沿用节点纸面底色，透明备注保持透明，不再切换到白底。

复制包含分组时，副本整体放到上下左右最近的空白区域，避开现有节点与分组；完成后平移视口至副本中心，保持缩放。普通节点继续近距离错位复制。

文字节点右键“字号比例”支持 1×、3×、5×，存为 `fontScale`（省略为 1）。预览与编辑共用字号，缩小时按画布缩放乘字号比例决定是否简化。沿用原生适应高度，复制时保留该属性。
