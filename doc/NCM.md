# NCM — Node Capability Manifest（节点能力清单）

> **归属**：本文属于「**下一代开源硬件（塞尔达开源生态 · AiPi-NodeMCU-Hub）**」项目的技术规范线。
> NCM 就是该项目里**逻辑执行器**识别节点、以及 MCU 经 **emMCP / UART-MCP** 对外描述自身能力时
> 用的那份结构 —— 它不新增字段，只是给"MCP 工具描述结构的节点侧用法"一个名字。
>
> **归档位置（2026-09）**：已推送到 Memory Hub 知识库 —— `wiki_id = wiki-hvts21ot`，
> 名称「NCM 节点能力清单（Node Capability Manifest）」，`status = ready`（14 页，由本页素材
> ingest 生成），`visibility = team`，已 allocate 到 `agt-opv6hie5ru`（该 Agent 下现有两个知识资产：
> 项目 wiki `wiki-qudd3woh` + 本规范 `wiki-hvts21ot`）。**项目 wiki 那 170 页一页未动。**
>
> **一句话**：NCM 是**「按已固化的 UART-MCP 结构描述节点能力」这件事的名字**。
> 它**不定义字段、不新增字段、不改字段**，也不含传输与会话 —— 所以它是**用法（profile）**，
> **不是协议**，**不是新 schema**。
>
> ⚠️ 唯一的硬约束：**字段一律以 UART-MCP / MCP 为准**。一旦为了"多描述一点"去加字段
> （例如加 `unit` / `kind` / `range` 字段），就会与 UART-MCP 不一致 —— 那正是本文档要禁止的事。

---

## 1. 结构（已固化 · 不得改动）

由 `emMCP.c` 实际生成（`emMCP.h` 定义类型），`tools/list` 的外壳与 MCP 同形：

```json
{
  "tools": [
    {
      "name": "<工具名>",
      "description": "<功能描述>",
      "inputSchema": {
        "properties": {
          "<属性名>": { "description": "...", "type": "number" }
        },
        "methods": {
          "<方法名>": {
            "description": "...",
            "parameters": {
              "<参数名>": { "description": "...", "type": "string" }
            }
          }
        }
      }
    }
  ]
}
```

`type` 取值（`mcp_sever_type_str[]`）：
`true` / `false` / `null` / `number` / `string` / `array` / `object` / `text` / `boolean`

## 2. 六项对号（你描述的东西 ↔ 结构里的键）

| 说的东西 | 落在哪 | 说明 |
|---|---|---|
| Node 名称 | `tools[].name` | — |
| 功能描述 | `tools[].description` | 给人看；**首句**说"做什么/什么时候用" |
| **读取指令** | `inputSchema.properties.*` | 每个属性 = `description` + `type` |
| **控制指令** | `inputSchema.methods.*` | 每个方法 = `description` + `parameters` |
| 类型 | `type` | 上表 9 个取值之一 |
| 版本 | `emMCPVersion` | **载具自带**（工具级没有版本字段） |

**读法（本文档唯一新增的约定，不是字段）**：
`properties` = 读、`methods` = 控制。任何一方都不许拿来放"另一种语义"的东西。

## 3. 四条纪律

1. **字段零增删改**：只允许使用 §1 里出现的键；新增/改名/换语义一律不允许
   （要加，就得先改 UART-MCP，那不在 NCM 的权限内）。
2. **读法固定**：`properties` = 读、`methods` = 控制（§2）。
3. **结构化信息走文本**：单位 / 范围 / 枚举 / 默认值**不占字段**，写在 `description` 里（§4）。
4. **文案纪律**：
   - ✅ 「NCM（节点能力清单）· 采用 MCP `tools/list` 结构」
   - ❌ 「基于 MCP 协议的节点协议」（没有传输与会话，不配叫协议）
   - ❌ 「内置 AI / 本地模型」（消费者是逻辑执行器，链路里没有模型）
   - ❌ 「MCP 兼容」（见 §6，准确性只到"结构同形"）

## 4. 结构化信息的文本格式（**方案 A：写进 `description`**）

### 4.1 语法

- 标签一律放在 `description` 的**末尾**；首句保持是人话（与 MCP 对 description 的期待一致）。
- 形式：`[键:值]`，**键固定小写**，多个标签**空格分隔**（顺序无关）。
- 值里**禁止出现 `[` 和 `]`**（保持解析器极简；要表达就换措辞）。
- 同一个键在一条 `description` 里**最多出现一次**；重复 = 声明错误。

### 4.2 标签集（最小集，别急着扩）

| 键 | 含义 | 值格式 | 例子 |
|---|---|---|---|
| `unit` | 单位 | 原样字符串（`°C`、`%`、`ms`） | `[unit:°C]` |
| `range` | 取值范围（**闭区间**） | `min..max`，按 `type` 解释 | `[range:-40..125]` |
| `enum` | 枚举 | 用 `\|` 分隔 | `[enum:auto\|manual\|off]` |
| `default` | 默认值 | 单个值 | `[default:auto]` |
| `step` | 步长（可选） | 数字 | `[step:0.1]` |

### 4.3 示例

```
"读温度 [unit:°C][range:-40..125][step:0.1]"
"设置亮度 [unit:%][range:0..100][default:100]"
"设置工作模式 [enum:auto|manual|off][default:auto]"
```

### 4.4 解析规则（给逻辑执行器，建议做成纯函数 + 单测）

1. 正则：`\[(unit|range|enum|default|step):([^\]]*)\]`，按出现顺序取，**顺序无关**。
2. 缺省 = **未声明**，**不许猜**（不要给 `number` 编一个默认范围）。项目纪律同源：
   "没给出的就是 `null`，不能拿一个具体值冒充不知道"。
3. `range` 拆 `..`，两端按 `type` 转换；`min > max` = 声明错误。
4. `enum` 的每个值都要与 `type` 相容；`enum` 与 `range` **同时出现 = 声明错误**（二者互斥）。
5. `default` 若不落在 `range`/`enum` 内 = **声明错误**（报错，不要"夹住"）。
6. 解析失败一律**报错并保留原文**，不要静默丢弃（否则节点说它限制 0~100，执行器却当没限制）。

### 4.5 长度预算

标签部分建议控制在 **64 字节以内**。⚠️ **`description` 的硬上限以模组侧 / UART-MCP 的实现为准
（待核对）** —— 超了会被截断，而截断的 `description` 可能正好丢掉标签。

## 5. 与 AI 侧的关系

- **同一份报文、同一个结构**：不需要"转换"（这也正是选 A 的原因 —— 不引入第二份真相）。
- `description` 变长一点，对 AI 侧只有"描述更详细"这一个影响。
- 若某天要把这份清单喂给**较真的 MCP 客户端**，需要的不是改 NCM，而是**另加一层规范化**
  （把 `inputSchema` 的方言补成 JSON Schema：加 `type:"object"`、把 `properties/methods`
  映到 `properties`、把 `range/enum` 提到 schema 层）。**那一层属于适配，不属于 NCM。**

## 6. 兼容性声明（诚实版）

| 层 | 与 MCP 的关系 |
|---|---|
| 外壳 `{"tools":[{name,description,inputSchema}]}` | ✅ **同形**（等于 MCP `tools/list`） |
| `inputSchema` 内部 | ❌ **自有方言**：`properties` + `methods` + 自有 `type` 枚举，**不是 JSON Schema** |
| 传输 / 会话 | ❌ 走 **UART + JSON**，不是 MCP 的 stdio / Streamable HTTP |

→ 因此对外只能说「**采用 MCP `tools/list` 结构**」，**不要说"符合 MCP 协议"**。

## 7. 已知问题（不建议单方面改，先确认模组侧解析）

`mcp_sever_type_str[]` 与类型枚举**错位两位**（`emMCP.h:44-56` vs `emMCP.c:34-36`）：

- `MCP_SERVER_TOOL_TYPE_FALSE = 0` → 报文里输出 `"true"`
- `MCP_SERVER_TOOL_TYPE_TRUE = 1` → 报文里输出 `"false"`
- 从 `NULL`(2) 起才是对的

也就是说**布尔类型在报文里是反的**。⚠️ 是否修、什么时候修，取决于 AI 模组侧是否已依赖这两个字符串
（结构已固化 ⇒ **即使是 bug 也不能单方面改**）。在修好之前：**别用布尔属性/参数**，
需要开关语义就用 `enum:on|off` 表达。

## 8. 待核对

1. `description` 的**硬长度上限**（模组侧 / UART-MCP 实现）；
2. `enum` 的值里若出现空格或逗号，是否要被允许（当前约定：只禁 `[` `]`，其余原样）；
3. Hub 侧是否缓存解析结果（缓存要与清单版本一起失效）。
