# WEA BIM Viewer · HY01 恒昌玖里 8539 照明设计

## 查看指南

这是一个在本机浏览器中运行的 BIM 查看与照明设计工具。模型和照明方案都在仓库里，下载后即可查看，**不需要安装 Archicad 或 Revit**。所有数据只在你的电脑上处理，不会上传到任何服务器。

### 打开方法
1. **下载**：在本页点 **Code → Download ZIP**，解压到任意文件夹（路径中最好不要有空格）。
2. **安装 Python 3.11**（只需一次）：从 [python.org](https://www.python.org/downloads/) 下载。Windows 安装时请勾选 *Add python.exe to PATH*。
3. **启动**：
   - **macOS**：双击 `启动WEA.command`。如果系统提示"无法验证开发者"，右键 → 打开。
   - **Windows**：双击 `启动WEA.bat`。
   - 首次启动会自动安装几何内核等依赖，需要联网，约 3–5 分钟。之后再启动只需几秒。
4. 浏览器会自动打开 `http://127.0.0.1:4277/`。如果没有自动打开，请手动输入这个地址。推荐使用 Chrome。

### 可以看什么
| 模块 | 内容 |
|---|---|
| **BIM Model Explorer** | 三维模型浏览：按楼层和专业显示或隐藏、剖切、材质贴图、房间人视（顶部「镜头」按钮可调焦距） |
| **Lighting Design** | 照明方案：左侧「方案」列表中可切换各个方案；「剖视 / 平面定位 / 室内透视 / 全局」等视图；实时照度热力图，以及每个房间的照度、均匀度、功率密度 |
| **MEP Routing** | 根据所选方案生成并预览电气图纸（照明控制、低压供电、照明配电平面与系统图），可下载 DXF |

### 查看你自己的模型
1. **导入 IFC**：点右上角「**＋ 导入 IFC**」，选择 .ifc 文件（≤ 250 MB）。几何会在本机由 IfcOpenShell 转换，大模型需要一两分钟，完成后自动显示。
   - 用 Archicad 导出时，请在「另存为 → IFC」中选择「**整个项目**」，这样房间（区域）、结构、机电都会包含在内。
   - 导入后会替换当前显示的模型。原来的模型文件仍在 `source/` 中，重新导入即可恢复。
2. **导入贴图（可选）**：IFC 本身不带贴图。在 Archicad 的 3D 窗口中「另存为 → **Wavefront (.obj)**」（选「构件 - 表面」「标准模型」、单位 mm），会生成一个文件夹，里面有 .obj、.mtl 和一个贴图子文件夹。然后在本工具里点「**导入贴图 (OBJ)**」，**选择整个文件夹**。程序会提取贴图，并从中推算每个材质的真实铺贴尺寸和方向，按材质名应用到当前模型。OBJ 和 IFC 需要来自同一个 Archicad 项目。
3. 照明方案按模型分别保存；同一项目重新导出的模型会自动沿用之前的方案。

### 打不开怎么办
| 现象 | 处理 |
|---|---|
| 启动窗口提示"未找到 Python 3.10" | 从 python.org 安装 **Python 3.11**（Windows 勾选 *Add python.exe to PATH*），然后重新双击启动文件 |
| 首次安装很久没有结束，或提示"部分组件安装失败" | 多为网络原因。启动脚本会自动改用清华镜像重试；也可以直接关掉窗口再启动一次，会接着安装。即使安装失败，也能查看模型 |
| 提示"端口 4277 已被占用" | WEA 可能已经在另一个窗口运行，直接用浏览器打开 http://127.0.0.1:4277/ 即可 |
| 浏览器没有自动打开 | 手动打开 http://127.0.0.1:4277/（使用期间不要关闭启动窗口） |
| Mac 提示"无法验证开发者" | 右键点 `启动WEA.command` → 打开 |
| 仍然不行 | 请把文件夹里的 `logs/wea.log` 和 `logs/install.log` 发给我们，里面记录了 Python 版本、组件安装情况和报错信息 |

### 说明
- 本工具和其中的方案属于**方案阶段的设计草图**。照度为模拟计算结果，灯具为通用模拟灯具，电气图纸须经电气专业复核后才能用于施工。
- 方案的修改只保存在你自己的电脑上，不会影响原始文件。

---

# WEA — 私宅机电自动化 | BIM Spatial Explorer

**研究原型版本：0.5 · 2026-10-31**

这是一套可直接在本机运行的 IFC 空间解析与三维浏览原型，预加载了用户提供的 Archicad IFC4 项目。**不是机电自动布线成品，也不是施工级 BIM 校核工具。**

## 运行（macOS / Windows / Linux）

需要 Python 3（建议 3.10+）。几何转换使用 **IfcOpenShell** 内核，安装到项目内独立的 `.venv`，不影响系统或 conda 环境；不需要 npm / Node.js。

**macOS：**双击 `启动WEA.command`。首次运行会自动创建 `.venv` 并安装 `requirements.txt`（ifcopenshell、numpy、shapely，需联网）。手动方式：

```bash
cd /路径/WEA
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

启动时终端会显示 `Geometry kernel: IfcOpenShell`。若 IfcOpenShell 不可用，服务会退回到旧的轻量 stdlib 转换器（几何不完整、可能出现共面闪烁），仅作应急。

浏览器打开 **http://127.0.0.1:4277/**。关闭终端中的服务用 `Ctrl+C`。如果端口 4277 被占用，可使用 `WEA_PORT=4280 python3 server.py`，并打开对应地址。

> 不要直接双击 `web/index.html`：模型需要由本地 HTTP 服务读取，不能通过 `file://` 加载。

## 当前已实现

- 已预加载 `HY01 恒昌玖里8539(1).ifc` 的真实 IFC4 几何转换结果。
- 3D WebGL2 视口：旋转、缩放、平移、重置、顶视；点击三维对象选中。
- 楼层、空间、构件类别筛选；搜索对象名称 / STEP Express ID。
- 构件信息面板：Express ID、GlobalId、名称、Tag、空间包围盒、IFC 属性集摘要。
- 定位选中、隔离选中、三维包围盒显示。
- 导出当前选中或可见构件的 JSON，供后续机电算法使用。
- **本机上传新的 `.ifc`**：点击右上角“导入 IFC”，本地 Python 解析后刷新模型，不会传到云端。
- IFC2X3 / IFC4 STEP 文件经 IfcOpenShell 解析与三角化；楼层标高及 3D 网格生成；模型浏览使用标准浏览器 WebGL2。

## 几何转换流程（通用，适用于任意导入的 IFC）

`tools/ifc_convert_ios.py`：

1. **IfcOpenShell 几何内核**：拉伸/扫掠实体、Boolean、Mapped item、带洞面、凹多边形均由 OpenCASCADE 正确求值；开洞在宿主构件上真正挖空。
2. **只取三维 Body 表示**：不画 Axis / FootPrint / Box 等辅助表示；Body 上下文缺失的构件自动回退到其他三维上下文。
3. **不重复绘制**：`IfcOpeningElement` 等减法特征、`IfcVirtualElement`、以及子构件自带几何的装配体父件（幕墙、楼梯、`IfcElementAssembly`）不渲染。
4. **大坐标本地化**：水平坐标超过 1 km（地理坐标模型）时自动平移到局部原点再写 float32，偏移量记录在 `model.json` 的 `origin`。
5. **共面重叠消解（解决 Z-fighting 的核心）**：同朝向、相距 ≤1.5 mm 且投影重叠的面（如重复建模的楼板/梁、复合墙各层外表面）会在深度缓冲中相互闪烁。转换时保留最靠前的面，裁掉其后方被覆盖的部分；从*其他*构件上裁下的部分作为“重复区段”另存，Viewer 仅在遮挡它的构件被隐藏/过滤时才绘制——既不闪烁，筛选时也不会出现破洞。统计见 `stats.coplanarOverlap`。

6. **材质**：IfcSurfaceStyle（颜色、透明度、高光、METAL 反射）逐三角形保留；IfcOpenShell 不处理的 `IfcIndexedColourMap` 逐面颜色由转换器按顶点几何匹配回原始面后补上。IFC 材料（IfcMaterial / 层集 / 型材集）名称写入构件属性。法线按 30° 折角平滑。

Viewer 侧不使用 Polygon Offset；近/远裁剪面根据相机与模型包围盒自适应，以充分利用深度精度。

## Viewer（web/main.js，基于 three.js）

渲染使用 [three.js](https://github.com/mrdoob/three.js)（MIT，r187，已随项目放在 `web/vendor/three`，无需 npm）：MeshStandardMaterial + RoomEnvironment 环境光 + ACES 色调映射 + GTAO 环境光遮蔽，OrbitControls 相机。

- **玻璃**：IFC 透明度 T（1−不透明度）的材质用 three.js `MeshPhysicalMaterial` 透射（transmission）渲染，薄壁、IOR 1.5、不折射：T ≥ 0.6 视为清玻璃，完全透射、IFC 颜色仅 25% 染色、粗糙度约 0.03；T 越低越接近磨砂（保留乳白漫射、透射模糊）。透射只采样一次背后场景，中空玻璃多层不会叠成乳白。不透明度为 0 的材质（如 IFC 空气体）不渲染、不可点选；玻璃不参与 AO。
- **全局视图**：照明房间面板的「全局」：在该楼层最低吊顶下剖切、框选整层，所有布灯房间的灯具与实时估算热力图同时显示（共用图例刻度）；统计仍针对当前房间。
- **渲染模式**：材质（IFC 表面样式 + 光照）/ 分类着色 / 白模 / X 光（建筑半透明、风管水管桥架以真实材质不透明显示）；AO 可开关。
- **图层**：楼层 × 分类两级。楼层可单独显示/隐藏、点名称“仅显示该层”；展开楼层可单独关闭该层的某一分类（例如只隐藏 40F 的楼板）。分类开关作用于全部楼层。楼层归属取自 IFC 空间结构（`IfcRelContainedInSpatialStructure`）。
- **单体可见性（类 CAD/Rhino）**：点击选择，Shift/⌘ 多选；`H` 隐藏选中、`I` 隔离选中（再次按退出）、`Shift+H` 全部显示；“隐藏对象”列表可逐个恢复。
- **专业划分（建筑 / 机电）**：转换器按 IFC 语义判定，优先级依次为 `IfcDistributionElement` 实体类型 → 归属 `IfcSystem`/`IfcDistributionSystem` → 带配电/流体端口 → 标准机电属性集（`Pset_Distribution*`、`Pset_Duct*`…）→ 分类编码关键词 → 名称。左侧“专业”可单独显示/仅显示建筑或机电；右侧面板可手动修正（按 GlobalId 存于浏览器 localStorage）。本模型：建筑 1870、机电 1028。
- **房间人视**：点击房间列表即进入该房间 1.6 m 视高的人视。视点由转换器计算：房间平面轮廓的“不可达极点”（shapely `polylabel`，L/U 形房间也在室内）→ 退到距墙 0.5 m 的角落、看向最远对角。拖动环视，WASD/方向键行走（Shift 加速），滚轮前后，Esc 退出。
- **镜头**：35 mm 等效焦距 12–135 mm（预设 16/20/24/35/50/85），人视视高 0.9–2.0 m。
- **高度剖切**：顶部/底部两个水平剖切面，可按楼层层高一键设置。很多模型（包括本项目）把吊顶和上方结构板也归在下层，此时把“顶部”拖到吊顶以下即可俯视管线。
- 可见性用逐构件状态数据纹理在 GPU 上过滤（同一份状态驱动渲染、拾取、AO），思路参考 That Open Engine 的 Hider/Classifier 与 xeokit 的对象可见性模型。

分类：IFC 实体类型（IfcWall / IfcSlab / IfcBeam / IfcColumn / IfcDuctSegment / IfcPipeSegment / IfcCableCarrierSegment …）直接映射；只有 `IfcBuildingElementProxy` 等无类型构件才使用名称 / Pset 启发式。

## Lighting Design Studio（照明前期设计，BETA）

左下角 ACTIVE MODULE 切换 **BIM Model Explorer / Lighting Design**。两个工作模式共用同一个场景、相机、控制器和模型数据，切换时不重新加载 IFC、不丢失相机。范围：前期布灯、参数调整、光照预览、直接照度估算、方案保存。**不包含**自动布线、回路、算量、下单、AC 写回。

**使用流程**：进入 Lighting Design → 左侧选择房间（剖视 / 顶视 / 室内透视）→ 灯具库选灯型 → 在视口中单击放置（剖视/顶视中点击地面会自动安装到正上方实测天花；人视中可直接点天花；射灯也可装墙面）→ 选择/移动/旋转/复制/删除/阵列，右侧精确编辑 → 观察光照预览与 Lux 热力图 → 保存 / 导出 JSON / 方案 A·B 对比。快捷键：⌘Z / ⇧⌘Z 撤销重做，⌘D 复制，Del 删除，Esc 取消工具。“选构件”模式下可点选 BIM 构件并按 H 隐藏遮挡物。

### 材质贴图（`tools/obj_textures.py` → `assets/surfaces.json` + `assets/textures/`）

Archicad 导出 IFC 时不带贴图，而且 IFC 几何没有贴图坐标；它导出的 **OBJ** 则带有完整的贴图原图、.mtl 中"材质 → 贴图"的对应关系，以及 Archicad 计算出的贴图坐标。
- **工具做什么**：从 OBJ 的贴图坐标反推每个材质的**真实铺贴尺寸**（1/|∇u|、1/|∇v|，按面积加权取中位数）和**方向**（水平面上的纹理走向角度；竖直面上 u 是横向还是竖向），分水平面和竖直面两组统计。贴图缩到 ≤1024 px 后存为 `assets/textures/<hash>.jpg`。同时合并接口读到的 Archicad 表面系数（`source/archicad/ac_surfaces.json`）。**几何缓存不做任何修改**。
- **viewer 怎么用**：在材质模式下，把所有贴图打包进一张 512 px 的二维纹理数组（带 mipmap），按材质名（忽略 `#RRGGBB` 后缀）对应到 IFC 材质，在 IFC 局部坐标中做三向投影（triplanar）：地面和天花按推算出的尺寸和角度铺贴，墙面按横向或竖向铺贴。贴图会替代原来的纯颜色，选中构件时仍然显示高亮色。
- **局限**：贴图的起点偏移没有还原（砖缝、拼花图案的位置可能和 Archicad 里错开一点）；Radiance 仿真仍然按材质的颜色和反射率计算，暂未使用贴图的平均色。
- **命令**：`.venv/bin/python tools/obj_textures.py source/archicad/obj/HY01_8539.obj assets --surfaces source/archicad/ac_surfaces.json`

### 室内外圈（`web/lighting/envelope.js`）

进入 Lighting Design 时，默认**只显示和计算从房间内部看得到的构件**（显示面板中的「仅室内外圈」开关，默认打开），包括墙、地、天花的完成面、固定家具、门窗和玻璃；没有饰面的地方保留结构。被完成面挡住的基层、龙骨、饰面后的结构、吊顶内的机电则被隐藏，也不进入 Radiance 仿真。
- **方法**（对任何 IFC 通用，不依赖图层名）：
  - 在每个房间内取若干采样点，分两个高度。
  - 用 GPU 向六个方向渲染构件编号（`viewer.visibleFrom`，复用拾取着色器）。渲染两遍：一遍含玻璃；一遍透过玻璃，这样透过窗户看到的外部遮挡物也会保留，日光计算不受影响。
  - 凡是从房间内部看到过的构件都保留。
- **不漏光由方法本身保证**：每条视线最终都会落在某个被保留的构件上；没有饰面的地方看到的是结构，结构就被保留。
- **哪些地方会用到**：3D 显示、平面定位的参照线、灯具安装面射线（只会装在外圈上）、Radiance 仿真（请求中的 `elementGuids`）。
- **耗时**：首次计算约 5 秒，示例模型有 132 个采样点；结果按模型指纹缓存在浏览器中，之后进入约 30–40 ms。导入新模型后会自动重新计算。
- **按图层排除**：转换器从 IfcPresentationLayerAssignment 读出每个构件的 CAD 图层（`element.layer`）。照明模式默认排除名称属于基层、龙骨、分缝、轴网、文档、隐藏、导入参照模型（IFC Model / IFC图层）的图层；可以在显示面板的「图层」里逐个勾选调整（保存在 `designerSettings.layerExclude`）。被排除的构件不显示、不遮挡外圈采样、不进入仿真。外圈的缓存按"模型指纹 + 排除图层"区分。
- **方案迁移**：重新导出或改名后的模型找不到同名方案时，会按 IFC 项目 GUID（`/api/lighting/find`）找到同一项目最近的方案，自动迁移并逐项校验；保存后存为当前模型名。
- **注意**：如果导出 IFC 时室内完成面图层是隐藏的，那么吊顶内的机电从房间里确实能看到，会被保留。这时应在 Archicad 中打开室内图层后重新导出。

### 视觉预览与照度计算分离

| | Visual Preview（`preview.js`） | Illuminance Analysis（`photometry.js` + `workspace.calculate`） |
|---|---|---|
| 目的 | 看光斑、方向、明暗、重叠、色温 | 估算工作面直接照度（lux） |
| 实现 | three.js SpotLight，物理单位（cd，decay 2），可选阴影 | 纯 JS 逐点计算，无 three.js 依赖，单元测试覆盖 |
| 共享 | 同一份灯具记录（坐标、朝向、光通量、光束角、调光、开关）和同一条光强分布 I(θ) | 同左 |
| 不共享 | 曝光、环境补光、色温颜色、阴影：仅影响画面，**不进入计算** | 计算结果只通过热力图显示，**不读取 Shader 亮度** |

视觉侧把 three.js 聚光衰减替换为与计算相同的 cosᵐθ（`main.js` 中 `LIGHTS_PARS_COSM`），因此画面上光斑大小与热力图一致。照明模式下 Viewer 直接渲染到屏幕（不经 AO 后处理），避免虚构的 AO 明暗干扰判断，热力图颜色也不被曝光改变。

### 两级照度计算：实时估算 + Radiance 专业仿真

右侧「照度分析」可切换：

- **实时估算**（拖动灯具时毫秒级更新）：仅直接光，用于快速试布置，界面标注“仅直接光”。
- **Radiance 仿真**（`tools/radiance_sim.py`，LBNL Radiance 经 [pyradiance](https://pypi.org/project/pyradiance/) 调用，本机后台运行）：
  - 几何：房间外扩 6 m 范围内所有构件（只读 `model.bin`，排除 IfcSpace、全透明“空气”材质、共面重复面），**计入遮挡与多次反射**（`rtrace -I`，环境光反弹）。
  - 灯具：与估算相同的 `fixtureEmitters()`（同一位置、朝向、光通量、调光、cosᵐ 配光），逐盏生成 IES LM-63 文件后用 `ies2rad` 转换；将来可直接换成厂家 IES。
  - 材质：不透明材质为 `plastic`，反射率默认由 IFC 显示颜色推算（显示色通常偏暗），**可在“材质反射率”表中按材质修改**并随方案保存；清玻璃为 `glass`（透射率 = IFC 透明度），磨砂为漫透射 `trans`。
  - **日光**：CIE 标准天空（`gensky`：晴天含直射日光 / 中间天空 / 阴天），日期、时间、纬度、经度、时区、正北（IFC TrueNorth + 手动修正）。位置默认取 IfcSite（本模型为北京，可能是模板默认值，界面提示确认）。
  - **人工照明与日光分开计算、可分别开关**（左侧“日光 开/关”同时控制预览太阳与仿真），结果给出人工 / 日光 / 合计 / 直接光估算四行的 Eavg、Emin、Emax、U0。
  - 精度档：草图（-ab 2）/ 标准（-ab 4，-ad 1024）/ 精细（-ab 6）。本机 8 核实测起居室 323 点：草图约 12–14 s，标准约 40 s。
  - 结果与当前方案、网格、设置绑定：任何修改后自动标为“已过期”，回退显示实时估算，不会把过期结果当成当前结论。
  - 采样点位于构件内部（五方向探测射线命中背面）或完全未受光（多为 IfcSpace 边界超出墙面落入夹层）时，不计入统计，热力图显示为灰色，并在报告中说明数量。
- **墙边排除带**：计算区域默认不含距墙 0.5 m 的边缘带（EN 12464-1 等常用做法），0–1 m 可调，估算与仿真共用同一网格。
- 验证：同一灯具下 Radiance 只算直接光与解析公式逐点相差 < 1%；`tests.py` 用合成 IFC 校验 Radiance 直接光 = I·cosα/r²、管道遮挡、日光开关、楼板内采样点识别。

**视觉预览中的日光**：按日期、时间、位置计算太阳方位（`sun.js`，与 gensky 结果相差 < 1°），用投射阴影的平行光显示直射阳光，窗外显示天空（经曝光补偿的天空球，保证透过玻璃与直接看到一致）。预览不含天空光与反射光，定量结果以 Radiance 为准。

### MEP Routing：弱电图纸（智能照明控制 + 低压灯具供电，DXF）

顶栏「MEP Routing」模块（`web/routing/workspace.js`）以 Lighting Design 的灯具方案（可选方案 A/B）为输入。「生成并预览弱电图纸」由当前方案（含未保存修改）生成 3 张 DXF，**在视口中预览**（服务端用 ezdxf 把同一份 DXF 渲染为 SVG：切换图纸、滚轮缩放、拖动平移、双击适应窗口），预览中可下载 zip；文件同时保存到 `designs/exports/<模型>_ELV_<时间>/`（`tools/elv_drawings.py`，开源 [ezdxf](https://ezdxf.mozman.at/)，MIT）：

| 图纸 | 内容 |
|---|---|
| 01 智能照明控制平面图 | 整层建筑底图（BIM 墙体在地面 +1.2 m 处剖切）、灯具图例、控制分组编号、控制面板、控制逻辑连线 |
| 02 低压供电平面图 | 低压灯具、恒压驱动电源（优先放在房间检修口旁）、低压线路（正交示意）、线径 / 长度 / 压降标注 |
| 03 系统图及表格 | 各房间面板 → 分组 → 灯具的控制逻辑、设备清单、控制分组表、默认场景表（全开/日常/氛围/夜灯/全关）、驱动与压降校核表、需人工确认事项 |

- 单位毫米、**IFC 世界坐标**，可与 Archicad 平面直接叠合；图层分开（`A-WALL`、`E-FIXT`、`E-CTRL-DEV`、`E-CTRL-LINK`、`E-LV-DRV`、`E-LV-WIRE`、`E-LEGEND`…），设备图层只含真实设备，便于在 CAD 中统计；中文字体样式 `WEA-CN`（simhei.ttf，可在 CAD 中替换）。
- 控制分组：默认每个房间按灯型分组，灯具属性中可指定“控制分组”。控制协议（DALI / KNX / 无线）未定时出逻辑图，不分配总线地址。
- 面板位置：房间门旁（门构件距房间边界 < 0.6 m）；无门房间取**通往相邻房间的开口**旁、有实墙的一端；均吸附到实际墙面、距地 1.3 m（可调），并标注“需确认”。
- 低压供电：线性灯默认 24 V 恒压，其余 220 V 一体驱动（灯具属性可改 220V / 24V / 12V）；每个低压分组一台驱动，额定 = 负载 × 1.2 向上取标准档；压降 ΔU = 2·L·I·ρ/A（铜 0.0175 Ω·mm²/m），按正交路由 + 0.5 m 估算长度，取满足限值（默认 3%）的最小截面。
- 均为方案阶段的设计草图，须经电气专业复核后方可用于施工。

### 照度估算方法与限制

- 光强分布（通用模拟灯具，无厂家光度数据，界面明确标注）：I(θ) = I0·cosᵐθ（θ ≥ 90° 为 0）。光束角为半峰全宽：cosᵐ(β/2) = 0.5 → m = ln0.5 / ln cos(β/2)；β = 120° 时 m = 1（朗伯）。
- 光通量守恒：Φ = ∫I dΩ = 2πI0/(m+1) → I0 = Φ(m+1)/2π；有效光通量 = Φ × 调光 × 开关。lm 不当作 cd，光束角不当作照度。
- 线性灯拆为 ≤ 0.25 m 间距的子光源，光通量均分（总量守恒）。
- 逐点直接照度 E = Σ I(θ)·cosα / r²，水平工作面（默认距完成地面 0.8 m，可调），网格默认 0.25 m（> 40 m² 时 0.5 m），采样点裁剪到房间平面（含内洞）。
- 统计：Eavg、Emin、Emax、U0 = Emin/Eavg、灯具数、运行功率（按调光线性估算）与安装功率、功率密度。
- 实时估算**未计入**遮挡、反射光、日光、维护系数，只统计本房间灯具；这些由 Radiance 仿真补足（仿真可选计入相邻房间灯具）。两者均未计维护系数，结果**不代表满足任何照明标准**，界面亦如此标注。仿真精度取决于材质反射率与灯具光度数据（目前为通用配光）。
- 增量计算：每盏灯的网格贡献按参数缓存，只重算被修改的灯；本模型起居室 483 点计算约 1 ms。

### 房间与安装面

- `tools/room_context.py` 从现有几何缓存（只读）计算每个 IfcSpace 的平面轮廓、地面标高、空间顶高，以及**实测天花**：在平面内按 0.25 m 网格向上找最低的朝下建筑表面，统计各高度覆盖率（例：起居室 2.50 m 吊顶 39% / 2.86 m 跌级 39%）。结果写入独立的 `assets/rooms.json`，**不修改 `model.json` / `model.bin`**。导入新 IFC 时自动生成。
- 覆盖率 < 60%、高度异常、空间由多块组成、未探测到天花时标记“需人工确认”；可在房间面板手动指定地面标高、安装面高度、点选矩形工作区域并确认。手动数据只存于照明方案，不写入 IFC。
- 放置时用 GPU 表面拾取（遵守可见性、剖切、透明规则；IfcSpace、玻璃、机电构件不能作为安装面）；移动后与重新打开方案时用 CPU 射线在 7 cm 内复核安装面，找不到即标记“失效 / 需人工确认”，**不移动灯具**。

### 平面定位（CAD 式绘图定位系统，`web/lighting/draft/`）

照明房间区的视图切到「平面定位」后，视口变成 2D 天花平面图（从上往下看，方向与平面图一致），用于按尺寸精确定灯位。编辑走同一份方案和同一个撤销栈，3D 预览与照度计算同步更新。

- **参照线**（`references.js`，从现有几何缓存只读提取，不依赖 IFC 实体类型，Archicad 全代理构件也适用）：
  - 墙 / 柱：在地面 +1.2 m 水平剖切三角面，得到墙体完成面线；
  - 其他构件：门窗、家具等的剖切线；
  - 吊顶边线：吊顶高度范围内朝下表面的网格边界边（跌级、灯槽、检修口、楼板边）；
  - 房间：IfcSpace 轮廓；
  - 轴网：IfcGrid 轴线（`room_context.py` 用 IfcOpenShell 读出 IfcPolyline / IfcIndexedPolyCurve / IfcTrimmedCurve，写入 `rooms.json` 的 `grids`；不支持的曲线类型计数报告，不做近似）。
  - 以上按图层开关；剖切线做共线合并。
- **对象捕捉**（`geom2d.js`，纯函数，有单元测试）：端点、中点、交点、垂足、最近点、灯具中心、定位原点；没有对象点时用**对齐追踪**（与已有灯具同一行 / 同一列，追踪线与边线相交时取交点），再没有时用**模数网格**（10 / 50 / 100 / 300 / 600 mm，从定位原点起算）。按住 Alt 临时关闭捕捉。
- **正交**：F8 切换，按住 Shift 临时正交。
- **定位原点**：「设原点」点选墙角或轴线交点；默认是 IFC 项目原点。属性面板的 X / Y 改为相对原点的毫米整数，可直接输入。
- **临时尺寸**：选中的灯（以及放置、拖动中的点）实时标出到左右上下最近参照的距离。参照可选「墙面 / 吊顶边」或「轴线」。**点击尺寸数字输入新值**（如 600），参照线不动，灯移动到该距离。
- **命令行**：在平面图中直接键入
  - `x,y`：相对定位原点的绝对坐标，单位 mm；
  - `@dx,dy`：相对选中的灯或上一盏放置的灯；
  - `@距离<角度`：极坐标；
  - 单个数值：沿光标方向的距离（直接距离输入）。
  - 在「添加」工具下以上输入为放置，否则为移动选中的灯。
- **安装面**：吸顶灯在平面图中放置或移动时，用 CPU 射线在该点向上找最低的天花表面，跌级处高度自动跟随；所属房间按落点更新。墙装灯仍在 3D 视图中点击墙面放置。
- **其他**：「测量」两点距离（ΔX / ΔY）；滚轮缩放，拖动空白处或右键平移，双击适应房间。
- **设置**：保存在 `designerSettings` 的 `planOrigin`（IFC 世界坐标）、`planStep`、`planSnap`、`planLayers`、`planOrtho`、`planDimRef`。
- **后续步骤**：
  - 均分（端距 = 间距 / 2、等于间距、指定端距；`geom2d.divide` 已实现并测试）、矩形均布、偏移、对齐 / 等距、取整检查；
  - 带尺寸标注链的灯位定位图（DXF + viewer 预览）。

### MEP Routing：强电照明回路（220 V，`tools/mains_circuits.py`）

「生成并预览电气图纸」现在输出 5 张 DXF，新增两张：**04 照明配电平面图**、**05 照明配电系统图**。
- **配电箱 AL1**：可以在「平面定位 → 配电箱」中指定位置（存在 `elvSettings.board`，不写 IFC）。未指定时自动放在**入户门**旁，判断方法是：房间边界上的门，门的一侧不在任何房间内。没有入户门时，退而选名称为玄关 / 门厅等的房间的门。自动推定的位置会标注"需确认"。
- **负载**：220 V 灯具按安装功率计入；低压灯具通过驱动计入，按驱动额定功率 ÷ 效率（0.9）。
- **回路划分**：从配电箱出发按最近邻顺序遍历房间（使同一回路的房间在空间上相邻），依次装入回路 WL1、WL2…。限制条件：
  - 单回路电流 ≤ 10 A（设计取值；GB 50034-2013 7.2.8 规定单相分支回路不宜超过 16 A、光源不宜超过 25 个）
  - 每回路 ≤ 25 个负载、≤ 8 个房间
  - 单个房间超限时自动拆分并报告
  - 以上参数都可以在 Routing 面板中修改
- **连线**：配电箱 → 首个灯具（回路首段，加粗，并标注 回路-导线-保护管-敷设，如 `WL1 BV-3×2.5-PC20-CC`）；房间内灯具按最小生成树连接；相邻房间之间从最近的一对灯具相连；控制面板 / 开关到灯具画开关线（虚线）。同一回路使用同一种颜色。
- **线径与压降**：线长 = 正交路由 + 配电箱竖向段 + 每个灯具 0.5 m。压降按负荷矩计算：ΔU = 2ρΣ(I·L)/A。截面不小于 2.5 mm²（GB 50096 分支回路要求），超过限值（默认 3%）时自动加大截面。
- **系统图**：进线 → 各回路断路器（16A 1P+N）→ 回路标注；回路负荷与压降表；需人工确认的事项列表。
- **限制**：所有线路都是**正交示意路由，未避让梁、风管与水管**（避障路由是下一步）。断路器与导线规格为方案估算，须经电气专业复核。

### AI 设计师（`web/ai/`，大模型接口待接入）

照明工具栏「✦ AI 设计师」打开对话面板。例如输入"我要一个明亮温馨风格的客厅，架设八个射灯和一个装饰吊灯"，会依次执行：读取房间 → 查标准，把风格量化为目标 → 生成 2–3 个思路不同的草稿方案 → 每个方案反复"布灯 → 计算 → 修正" → 写入设计说明与假设。
- 每个方案在面板中显示为一张卡片：照度、U0、功率密度、色温、是否达标。可以「在视图中打开」（3D）、打开「平面」，或「出图」（切到 MEP Routing 生成弱电 DXF 并预览）。
- **大模型只做决策，计算由 WEA 完成**：`tools.js` 把软件能力封装成 13 个函数调用工具（JSON Schema）：读取项目、读取房间、查标准与目标、查灯具库、新建方案、按坐标放置、行列均布、沿墙布置、对象上方布灯、调整、删除、计算照度、完成方案。
  - 照度来自 `photometry.js`，与实时估算相同；标准来自 `standards.js`。
  - 所有参数都经过校验；灯具必须能在 BIM 几何中找到真实的天花才会放置；坐标按 50 mm 模数取整。失败时把原因返回给模型，不会被静默修正。
- **安全边界在代码中强制执行**，不依赖提示词：AI 只能修改本次自己新建的草稿方案（来源标为 AI / 离线演示），不改用户已有方案，不写 IFC；每一步都可以撤销。
- **标准与目标**：`standards.js` 收录 GB 50034-2013 住宅照度标准值（表 5.2.1）和功率密度限值（表 6.3.1）。风格词（明亮、温馨、柔和、氛围、现代、简约、清爽、高级）对应的目标是 WEA 的设计经验值，可编辑；项目采用新版标准时替换这张数据表即可。
  - 方案可以通过 `target_overrides` 调整目标，但必须写明理由。例如分层照明不考核 U0，因为 GB 50034 对住宅没有规定 U0。
- **家具与陈设**：从 IFC 构件名称中识别沙发、茶几、电视、挂画、餐桌等（`context.js`，通用关键词）。识别不到时，设计师可以在「平面定位」中用「标注」点出位置（存在方案文件 `roomAnnotations` 中，不写 IFC），AI 布置吊灯、重点光时会使用这些位置。
- **服务商**：
  - `providers/demo.js`：**离线演示**，规则脚本驱动同一套工具，用于演示和测试，**不是大模型**。它能识别房间、风格词和"数量 + 灯型"，固定生成"均匀基础光 / 洗墙温馨 / 重点 + 氛围"三个方案；遇到自由对话会如实说明不支持。
  - `providers/openai.js`：OpenAI Chat Completions 函数调用的格式转换。请求经本机 `tools/ai_proxy.py`（`POST /api/ai/chat`）转发，**API Key 只保存在服务端**。
  - **接入方法**：把 `config/ai.example.json` 复制为 `config/ai.local.json`（已 git-ignore），填写 `apiKey` 与 `model`；也可以用环境变量 `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL`。然后重启 `server.py`，在面板中选择 OpenAI。格式转换已有单元测试，但**尚未与真实 API 联调**。
- **数据外发**：使用 OpenAI 时，只发送房间与方案的结构化摘要，不发送 IFC 原文件和贴图。面板中有提示。
- **多方案**：方案数量不再限于 A/B（`schemes` 以 A、B、C… 为键）。每个方案记录 `source`、`brief`、`targets`、`results`、`rationale`、`assumptions`；左侧方案列表支持新建、复制、重命名、删除，MEP Routing 可以选择任意方案出图。
- **多房间请求**（如"每个房间中心架设一个灯"）：`create_scheme` 的 `room_ids`（`["all"]` 表示全部可设计房间，自动排除整户空间和面积 < 1 m² 的空间），加上批量工具 `place_in_rooms`。房间中心取视觉中心，并避开嵌套在本房间里的较小房间。计算和完成方案时按房间分别给出结果，卡片上可以「全局查看」。只说"灯"、没说灯型时用**吸顶灯**（`ceiling`，宽配光，有平面符号和 DXF 图例）。
- **装饰吊灯**（`pendant`）：吊杆长度决定发光中心高度；配光为下照（光束角）加上照（Lambertian），按 `upRatio` 分配光通量；有平面符号和 DXF 图例。

### 坐标

`coords.js`：IFC 世界（Z-up，米）↔ IFC 局部（世界 − `model.origin`，地理坐标模型的平移）↔ 视口（three.js Y-up：(x, z, −y)）。方案只存 IFC 世界坐标；计算在 IFC 局部坐标进行；视口坐标只用于渲染。另存房间局部坐标（原点 = 房间包围盒最小角、地面标高）。

### 方案数据（`designs/<模型名>.lighting.json`，schemaVersion 1，不写入 IFC）

```text
sourceModel { name, schema, projectGuid, fingerprint (FNV-1a: 名称/schema/实体数/项目/IfcSpace GlobalId), origin, unit:'m' }
calculationSettings { workplaneHeight, gridSpacing, method, occlusion:false, interreflection:false, scope }
roomAnnotations { <IfcSpace GlobalId>: [{ id, kind, label, world[2] }] }   // 设计标注（沙发、茶几…）
designerSettings { exposure, ambient, shadows, beams, heatmap, sampleValues, snap, legendMax, isolateRoom, planOrigin, planStep, planSnap, planLayers, planOrtho, planDimRef }
activeScheme, schemes { A|B|C…: { name, fixtures[], source manual|ai|demo, brief, targets, results, rationale, assumptions } }, roomOverrides { <IfcSpace GlobalId>: { floor, ceiling, footprint, confirmed } }
fixture { fixtureId (稳定 ID), name, fixtureType downlight|spotlight|linear, catalogCode, roomId (IfcSpace GlobalId), roomExpressId, ifcProjectId,
          position { ifcWorld[3], roomLocal[3] }, mountHeight, rotation { aimTilt°, aimAzimuth°, bodyRotation° },
          mountReference { kind, surface, elementGuid, elementId, elementName, normal, status, message },
          photometricParameters { flux lm, power W, beamAngle °, cct K, dimming %, on, length m, distribution, photometrySource:'generic', ies:null },
          notes, designState }
```

`fixtureId / fixtureType / position / designState` 为后续路由模块预留的稳定接口（本版不实现路由）。载入时校验模型指纹、房间与安装面，失效项列入报告。

### 模块（`web/lighting/`）

| 文件 | 职责 |
|---|---|
| `photometry.js` | 光强分布、光通量守恒、发光点、逐点照度、网格裁剪、统计、参数校验、色温近似（纯函数） |
| `coords.js` | IFC 世界 / 局部 / 视口坐标映射 |
| `catalog.js` | 通用灯具库（筒灯 / 射灯 / 线性灯），预留 `ies` |
| `state.js` | 方案文档、撤销重做（滑块拖动合并）、选择 |
| `room.js` | 房间工作区（IfcSpace + 实测天花 + 手动覆盖） |
| `mount.js` | 安装面 CPU 射线复核 |
| `preview.js` | three.js 视觉预览（光源池、阴影、灯具与光束） |
| `heatmap.js` | Lux 热力图与色带 |
| `storage.js` | 保存 / 读取 / 导入 / 导出 / 校验 / 模型指纹 |
| `simulation.js` | Radiance 仿真请求（与估算同一网格与发光点）、任务轮询、结果过期判断 |
| `sun.js` / `daylight.js` | 太阳位置、正北旋转；预览中的直射阳光、阴影与天空球 |
| `workspace.js` | 工作模式、工具、交互、面板、计算调度 |
| `draft/geom2d.js` | 2D 几何、对象捕捉 / 对齐追踪 / 正交、临时尺寸、均分、命令行坐标解析（纯函数） |
| `draft/references.js` | 参照线：平面剖切、吊顶边线、轴网 |
| `draft/planview.js` | 平面定位视图（SVG）：绘制、交互、尺寸编辑、命令行、设计标注 |
| `../ai/standards.js` · `layout.js` · `context.js` | 标准与风格目标、布灯几何（墙、视觉中心、均布、沿墙、瞄准）、房间对象识别（纯函数） |
| `../ai/tools.js` · `agent.js` · `prompt.js` | AI 工具定义与执行、对话循环、系统提示词 |
| `../ai/providers/` · `panel.js` | 离线演示 / OpenAI 适配器；AI 面板与方案卡片 |

`main.js` 只新增了一个适配层（`viewer` 对象：表面拾取、几何只读访问、点击钩子、显示灯光开关、阴影、额外可见性过滤），BIM Explorer 行为不变。`server.py` 新增 `GET/POST /api/lighting`。

### 发光体（把 BIM 构件赋值为发光体，`web/lighting/luminous.js`）

异形发光膜、发光片、透光石材、造型灯带等，可以直接把 BIM 模型里已有的构件设为发光体。
- **操作**：在照明工具栏选「选构件」→ 点击构件 → 右侧点「**赋值为发光体**」。
  - **发光面**：朝向房间的面（默认）/ 全部 / 朝下 / 朝上 / 侧面；
  - **表面亮度**：单位 cd/m²，总光通量按 Φ = π·L·A 自动换算（单面发光、均匀漫射）；
  - 另可设置色温、调光、功率、供电（默认 24 V 外置驱动）、控制分组。
  - **移动 / 旋转**：
    - 在 3D 中按住发光体直接拖动（沿当前高度水平移动）。
    - 「移动」工具下用操作轴平移（含高度）；「旋转」工具下用旋转环绕自身中心转动（绿环 = 平面内转动，红 / 蓝环 = 倾斜）。
    - 也可以在平面定位中拖动或输入坐标，在属性栏输入高度偏移和角度，或「复位到原位置」/「清除旋转」。
    - 移动或旋转后，原构件在照明模式中隐藏，由跟随的副本代替；照度、遮挡、Radiance 都按新位置计算。设计数据只记录偏移和旋转，不改动 IFC。
- **计算**：
  - **实时估算**：发光面被切成不大于约 10 cm 的单元（最多 400 个），每个单元作为沿法线方向的漫射光源（cos¹），总光通量按面积分配、保持守恒。近场结果与矩形面光源的解析解相差在 2% 以内（有单元测试）。
  - **Radiance 仿真**：同一组面直接作为面光源（`light` 材质，亮度 L/179 W·sr⁻¹·m⁻²），与解析解相差在 5% 以内（有单元测试）。
- **显示**：发光面在 3D 中以真实亮度自发光（经曝光和色调映射），并按朝向合并为若干个预览光源；平面图中以填充区域加菱形符号表示；参与方案、AI 统计、出图（分组「发光体」）。
- **直接拖动灯具**：选择或移动工具下，在 3D 中按住任意灯具直接拖动，会沿天花和墙面吸附，热力图实时更新；拖动过程中暂停阴影重绘，松手后再更新一次。

### 实时预览的光源预算（性能）

WebGL 前向渲染中，每个像素都要把所有光源计算一遍，帧耗时随光源数量线性增长。实测：89 盏灯拆成 136 个发光点时，每帧约 1.2 s，全局视图约 3.9 s。
- **固定光源池**：预览只使用一个固定大小的光源池，默认 16 个，可在显示面板中选择 8 / 16 / 24 / 32。光源数量恒定，帧耗时不随灯具数增长，增加灯具时着色器也不需要重新编译。优化后同样的 89 盏灯约 19 ms/帧，全局视图约 59 ms。
- **分配规则**：按重要性分配光源。选中的灯优先，其次是当前房间的灯（权重 ×4），再按"光通量 /（1 + 到视点焦点距离²）"排序。镜头停下 120 ms 后重新分配，只调整光源参数，不重建任何几何。
- **剩余灯具**：分不到独立光源的灯，按房间合并为等效漫射光源（光通量相加，位置取光通量加权中心），占用最多 4 个名额。
- **线性灯**：在预览中合并为一个光源。
- **照度计算不受影响**：实时估算、热力图、Radiance 仿真仍然使用全部灯具的全部发光点。面板上会注明当前的分配情况。

### 已知限制与后续升级

- 阴影：WebGL 着色器的 varying/纹理单元有限，只给所选房间最亮的 6 个光源开阴影，其余光源在预览中会穿透构件（界面提示）。计算本身不计遮挡。
- 添加第 9、17…个光源时 three.js 需要重新编译着色器，会有一次短暂卡顿（光源按 8 个一组预分配）。
- 预览无间接光，环境补光仅为显示辅助。
- **IES / LDT 升级建议**：① 在 `photometricParameters.ies` 存厂家文件引用，解析为 I(C, γ) 表（IES LM-63 / EULUMDAT）；② `photometry.intensityAt` 改为按 C/γ 双线性插值，保持 E = I·cosα/r² 管线与单元测试不变；③ 视觉侧用 IES 衰减纹理替换 cosᵐ（three.js `IESSpotLight` 目前仅 WebGPU，WebGL 需自定义 `getSpotAttenuation` 查表）；④ 专业验证：导出到 Radiance（LBNL pyradiance）计算含遮挡与反射的照度，与 DIALux / Relux 结果对照；浏览器内可用 three-gpu-pathtracer（支持 IES 射灯）做渲染级预览。

## 当前项目解析结果

| 指标 | 解析结果 |
|---|---:|
| IFC Schema | IFC4 |
| 导出来源 | Archicad 28.2 |
| STEP 实体 | 414,006 |
| Proxy 构件 | 2,898 |
| 空间 IfcSpace | 22 |
| 楼层 IfcBuildingStorey | 4 |
| 机电系统 IfcSystem | 105 |
| 端口 IfcDistributionPort | 1,946 |
| 端口连接关系 | 689 |
| 渲染几何的产品（开洞已挖入宿主，不单独渲染） | 2,920 / 3,006 |
| 三角形（IfcOpenShell，共面消解后主几何） | 624,430 |
| 共面重叠消解 | 3,292 对构件 / 768 m²；构件自身分层 241 m² |

楼层：GDL (-6.3m)、38F (-3.3m)、39F (0m)、40F (+3.3m)。

## 重要技术限制

1. **代理构件分类不是结构性事实。** 源 IFC 把大量构件导出为 `IfcBuildingElementProxy`。UI 中的墙、板、梁、风管、水管、桥架等分类**通过名称 / Pset 启发式推断**，需要人工复核。
2. **几何来自 IfcOpenShell，但仍是显示用网格。** 曲面按默认弦高三角化；共面重叠消解会修改显示网格（被覆盖的面被裁掉），不应把 `model.bin` 当作施工级碰撞或算量依据——那应直接对 IFC 使用 IfcOpenShell / IfcClash。相距 1.5–3 mm 的同向面不一定被归并，依靠自适应裁剪面区分；楼梯等法向略有差异的斜面可能残留极少量（本模型约 0.1 m²）重叠。打开 IfcSpace 显示时，空间体与楼板顶面本身共面，按设计不做裁剪。
3. **包围盒是空间范围，不等于工程量。** 不能直接根据包围盒尺寸统计风管管材、开孔等材料用量。
4. **IFC 系统拓扑尚未转换成可编辑连线。** 显示了原始系统/端口关系计数，但尚未实现系统图或自动路由。
5. **未实现自动布线、照度模拟或写回 AC。** 这是 BIM 解析与 Web3D 基础阶段，路线生成、碰撞检测、自动算量、IFC/Archicad 写回均是后续研发。
6. 当前模型为用户提供的私有数据。**不要直接发布含 `source/*.ifc` 与 `assets/*` 的 ZIP 到公开代码仓库或公网服务器**。
7. 转换器的共面消解已用几何统计验证（剩余重叠面积、各构件表面覆盖守恒），**但未做浏览器截图级视觉验收**，请在本地 Chrome/Edge/Safari 实机确认。
8. 转换耗时：本模型约 50 秒（IfcOpenShell 约 20 秒 + 共面消解约 30 秒），导入大模型时请耐心等待。

## 使用真实 IFC 的注意事项

- 先在 Archicad 中尽量保留标准 IFC 分类、区域/Zone、正确坐标与属性，导出 IFC4。
- 本版上传上限 250MB；解析文件须使用 STEP 文本格式 `ISO-10303-21`，不支持 `.ifczip` 或 `.ifcxml`。
- 模型不会被发送到云端：浏览器只向本机 `127.0.0.1` 的 Python 服务上传，存储于 `source/imported.ifc`，覆盖前一份上传文件。
- 新模型导入生成的几何覆盖 `assets/model.bin` 和 `assets/model.json`；如需保留旧版本，提前复制整个 `assets` 文件夹。

## 代码结构

```text
WEA/
  server.py                 本机 HTTP Server + IFC 上传 API（优先使用 IfcOpenShell 转换器）
  requirements.txt          ifcopenshell / numpy / shapely
  web/
    index.html              界面结构
    style.css               Dark Contemporary 产品 UI
    main.js                 three.js 渲染 / 图层与单体可见性 / 剖切 / GPU 拾取 / 属性面板
    lighting/               Lighting Design Studio 模块（见上表）
    vendor/three/           three.js r187 及所用 addons（MIT，含 LICENSE；含 TransformControls）
  tools/
    ifc_convert_ios.py      IfcOpenShell 几何转换 + 共面重叠消解（主流程，输出确定性）
    room_context.py         房间工作区、实测天花、场地经纬度/正北 -> assets/rooms.json（只读几何缓存）
    radiance_sim.py         Radiance 照度仿真（遮挡 + 多次反射 + CIE 日光），server 经 /api/lighting/simulate 调用
    elv_drawings.py         弱电图纸（智能照明控制 + 低压供电）-> DXF，server 经 /api/lighting/elv 调用
    ai_proxy.py             AI 服务转发（/api/ai/status、/api/ai/chat），API Key 只在服务端（config/ai.local.json 或环境变量）
    pla_textures.py         从 Archicad 归档（.pla/.pln，只读）按签名恢复内嵌贴图；djpeg 严格校验，跨页损坏的放入 damaged/
    ifc_convert.py          旧版 stdlib 轻量转换器（应急回退；STEP 解析工具函数）
    audit_ifcopenshell.py   IfcOpenShell 可选核验入口（需单独安装）
  assets/
    model.json              IFC 元数据与构件清单
    model.bin               WEA_WEBGL_V2 几何包（分块：位置 / 法线 / 构件 / 遮挡者 / 材质，布局见 model.json 的 layout）
  source/
    HY01 恒昌玖里8539.ifc   仅作为本地参考输入；请勿公开上传
  tests.py                  离线测试
  启动WEA.command            macOS 启动脚本
```

## 开源技术路线与集成边界

此可运行版本为了避免本机安装依赖，**不直接引用 That Open 或 web-ifc 的运行时代码**，而是独立实现了 Python IFC STEP/Tessellation 解析和 WebGL2 Viewer。实际交付中包含一个可选的 **IfcOpenShell** 核验脚本：

```bash
python3 -m pip install ifcopenshell
python3 tools/audit_ifcopenshell.py "source/HY01 恒昌玖里8539.ifc"
```

后续准备采用以下已介绍的开源项目，并在统一的内部空间数据模型上替换当前简化实现：

- [IfcOpenShell](https://github.com/IfcOpenShell/IfcOpenShell)（LGPL 等，核验具体组件许可证）→ 全类型 IFC 几何、Pset、IFC 生成。
- [That Open Engine](https://github.com/ThatOpen/engine_components) 与 [web-ifc](https://github.com/ThatOpen/engine_web-ifc) → 浏览器 IFC 导入、构件交互。生产使用前须核验版本与许可证。
- [Fragments](https://github.com/ThatOpen/engine_fragment) → 预转换模型高效加载。
- [IfcClash](https://docs.ifcopenshell.org/ifcclash.html) → 生成路线后的碰撞与净距验证。
- [MEP-auto-routing](https://github.com/ngaymai/MEP-auto-routing) → A* 路由设计参考，不等于现成的可用于强电施工的算法。

这些项目**没有未经验证地混入首版构建产物**；这里的可运行部分是 WEA 自有代码。请勿将启发式类别或当前示意几何当成正式的 IFC 语义解析与施工检验结果。

## 验证指令

```bash
.venv/bin/python tests.py      # 含 IFC4 / IFC2X3 / 地理坐标 / 开洞 / 重复楼板 / 装配体 / 房间天花 / 转换确定性
node --test tests/lighting.test.mjs   # 照明计算：光通量守恒、光束角、平方反比、余弦、叠加、开关调光、偏轴、线性灯、网格裁剪、坐标
node --test tests/ai.test.mjs         # AI：吊灯配光、多方案、标准与目标、布灯几何、对象识别、需求解析、OpenAI 格式转换、离线演示驱动完整流程（含安全边界）
node --test tests/drafting.test.mjs   # 平面定位：交点 / 垂足 / 射线、共线合并、捕捉优先级、对齐追踪、模数、正交、临时尺寸、均分、坐标输入、剖切与吊顶边线、轴网
.venv/bin/python tools/ifc_convert_ios.py "source/HY01 恒昌玖里8539.ifc" assets
.venv/bin/python server.py
```

可用 `curl -I http://127.0.0.1:4277/` 检查本机服务。

## 后续 MVP

1. 使用 IfcOpenShell 校验完整几何、空间边界和 IFC 分类；建立真实阻碍/可通行空间。
2. 在三维空间中设置灯具、开关、配电箱、回路和可布线区域。
3. 基于约束的路径搜索 A* + 电气回路拓扑，计算导管、导线数量，并区分设计示意和可施工路径。
4. 碰撞检测、算量、可编辑 IFC 构件生成以及 Archicad 数据写回。

WEA · Prototype for a local-first private residence BIM / MEP automation workflow.
