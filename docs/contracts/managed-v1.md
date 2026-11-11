# managed-v1 呈现契约

状态：展示范围和行为已确认；以下是初始允许表及编码草案，不代表浏览器隔离已经通过验证。结构见 [bundle schema](schemas/core.schema.json) 的 bundle 定义。

## Bundle 与发布

bundle 字段为 profile、html、css、state、forms、behaviors、references、export。state 包含正式值 schema、草稿初值、compatibility_version；数字输入草稿允许字符串，因此 initial 按控件对应的草稿类型校验，而非直接套正式数值 schema。无输入状态也显式提供空对象声明。

preserve/reset 和 expected_state_revision 属于 View 操作，不放入可复用 bundle。preserve 检查同 View、schema 摘要及兼容版本并使用当前已保存值；reset 使用明确初值，丢弃输入必须本人确认。发布前存在未保存输入则先保存或阻止替换；最终版本变化结束原 Action 为冲突，不悄悄修改请求继续使用批准。

不安全或不支持的语法拒绝整个发布并报告位置，旧内容保留。允许的确定性转换仅包括解析/序列化、ID/class/keyframes 等局部命名、资源 URL 和链接路由；不静默删掉不支持内容后报告成功。

## 初始允许表

| 范围 | 初始候选允许集 | 强制限制 |
| --- | --- | --- |
| 语义排版 | section/article/header/footer/main/nav/aside/div/span/p/h1-h6/br/hr/blockquote/pre/code/em/strong/small/sub/sup/mark/ul/ol/li/dl/dt/dd/figure/figcaption | 不接管宿主 landmarks、焦点或窗口 |
| 表格 | table/caption/thead/tbody/tfoot/tr/th/td/colgroup/col | 列跨度与元素数有界 |
| 表单 | label/input/textarea/select/option/optgroup/button/fieldset/legend | 仅声明的控件类型；button 默认 type=button；禁止原生外联提交 |
| 图像与媒体 | img/picture/source/audio/video | 只用受管理资源；媒体原生控件，不自动播放 |
| SVG | svg/g/path/rect/circle/ellipse/line/polyline/polygon/text/tspan/defs/linearGradient/radialGradient/stop/clipPath | 几何、文字、变换、填充及本 View 片段引用；禁止 script/foreignObject/外链及跨资源 use |
| MathML | math/mrow/mi/mn/mo/mtext/ms/mspace/msup/msub/msubsup/mfrac/msqrt/mroot/mfenced/mtable/mtr/mtd/mover/munder/munderover | 只呈现，无 annotation-xml 活动内容 |
| 链接 | a | 局部锚点重写；http/https 链接仅经宿主受控用户点击处理，不自动导航或预取 |

禁止 script、iframe、object、embed、link、meta、base、内联 on* 事件、srcdoc、可执行 URL、任意内容安全策略覆盖。属性按元素显式登记：局部 id/class、文本 title/lang/dir、受限 aria/role、相应表单/表格/媒体/几何属性；不因任意 data-* 或 xmlns 属性存在而开放行为。href/src/poster 和 CSS url 统一验证；禁止下载和弹窗自动行为、autofocus 及正 tabindex 抢焦点。

此表是受限渲染器的实现输入，不是仅靠标签过滤的安全承诺。完整逐属性映射、浏览器解析差异、SVG 数值/路径复杂度和耗尽测试必须在 renderer 启用前落实。

## CSS 与布局

允许字体、颜色、边框、背景、盒模型、flex/grid、响应式 media 查询、局部伪类、作用域内 keyframes/动画。声明必须由 CSS 解析器检查，限定可识别的属性、值与 at-rule；未知语法拒绝。禁止 @import、远程 URL、全局宿主选择器和 position:fixed；absolute 定位仅在 View 容器内，层叠/裁剪/最大尺寸由宿主约束。局部 CSS 变量不能越出 View；keyframes、字体名称和选择器使用命名空间。

引用资源使用 `trellis-resource:<reference-name>`；宿主解析后按 references 表鉴权、登记引用并改写成受控资源 URL，不把真实路径提供给页面。字体同样是受管理资产，不从 CDN 获取。URL 片段必须指向本 View 已声明元素。

Surface layout 描述宿主 slots 中有序 groups；group 为 column 或 responsive_columns，含有序 View、列权重、枚举 gap/align。View 内 flex/grid 不受跨 View 分组模板限制。窄窗口按声明顺序折为单列；布局不得重复占用 View、引用不存在 View 或形成递归分组。创建后未显式布局的 View 按操作顺序追加到获准 slot。

## 行为与输入

行为通过 View 内唯一 element_id 绑定，字段使用 JSON Pointer；无通配符、函数、表达式或动态路径。只允许 schema 声明的固定字段，首版不支持动态重复表单。

| type | 含义 |
| --- | --- |
| input | text/textarea/number/checkbox/radio/select/multiselect/range，控件与字段类型匹配 |
| text | 只写文本节点，不解释 HTML |
| visible | 布尔字段控制显示 |
| toggle | 用户操作切换布尔字段 |
| class_toggle | 布尔字段切换已声明的本 View class |
| submit | 提交明确 form_id 的 fields，不提交全状态 |

同元素同属性重复写绑定拒绝；同字段多个兼容控件同步。radio 的 option_value 必须合法；选择控件只返回声明选项值，多选为选项数组。checkbox 为布尔。输入错误关联字段及对应控件，教学正确性不属于格式校验。

数字草稿保留原文；提交允许首尾空白和完整十进制/科学计数法，拒绝分隔符、单位、十六进制及非有限数。不能用 parseFloat 接受合法前缀；整数字段须 safe integer。可选空数值省略、必填空值报错，不把空值变 0。普通文本不裁剪。答案保存原始值和校验值以及当时内容版本。

草稿 500ms 防抖、持续输入最长 2s 发起保存；每 View 一个在途请求，新的修改合并在内存。以 expected_state_revision 保存局部字段；冲突保留本地未保存值和远端版本供用户选择，不自动合并。无额外浏览器持久库；后台断线保留内存，重连先复核，不能自动覆盖远端。正式提交只基于确认保存的状态版本。

## 预览与导出

资源预览复用当前已启用、经过验证的呈现 profile，不固定降级成源码/元数据。HTML 可实际呈现但必须验证；需要脚本的内容只走已验证独立区域。打开材料不执行代码/宏/插件，不自动转换。缺少渲染或解析能力时才显示缺口和原始元数据；不内置全格式解析套件。

export 片段有稳定 ID、learning/answer/feedback/mixed_personal/unclassified 类别，来源为本 View 元素根或独立静态 HTML/CSS。元素根不得重复或祖孙重叠；独立片段也经同一静态验证。已分类根之外的可见内容需纳入覆盖检查，未覆盖属于完整性问题，不默默遗漏。个人片段绑定当时正式答案/题目版本，不能导出未提交草稿。

导出移除行为及提交入口，展开折叠内容；输入控件不泄漏当前草稿，个人答案通过明确选择的版本绑定表示输出。片段内资源只打包实际需要的部分；改写内部 ID。允许已有音视频内嵌后原生离线播放，无 autoplay、自定义 JS 或自动转码；超限/不兼容按完整性规则处理。独立脚本区域只导出已保存静态表示。
