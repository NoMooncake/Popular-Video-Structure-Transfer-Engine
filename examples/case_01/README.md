# Case 01：宠物猫粮种草拔草结构迁移

## Purpose

这个目录用于保存第一版 MVP demo case。当前 case 用宠物猫粮作为主 demo，参考多条 2-5 分钟种草 / 拔草视频的结构，验证从样例结构抽取到新内容迁移的 P0 闭环。

该 case 不是最终写死内容。后续可以替换为服饰、美妆、数码、食品、生活用品或 AI 工具等其他品类。

## Directory Structure

```text
examples/case_01/
├── README.md
├── demo_case.json
├── assets/
│   ├── sample/
│   │   └── .gitkeep
│   └── user/
│       └── .gitkeep
├── sample_analysis.mock.json
├── structure_blueprint.mock.json
├── material_analysis.mock.json
├── gap_report.mock.json
└── timeline_plan.mock.json
```

`sample_analysis.mock.json`、`structure_blueprint.mock.json`、`material_analysis.mock.json`、`gap_report.mock.json` 和 `timeline_plan.mock.json` 是 T03 创建的 mock fixtures，用于在真实后端 AI 和真实样例视频就绪前串起完整 P0 流程。

## Current Status

- 真实样例视频还没有进入仓库。
- T01 定义 demo case，T02 定义核心 JSON Schema，T03 提供可校验的 mock fixtures。
- 当前使用字幕内容和结构假设作为 reference。
- 不要把大视频文件直接提交到 GitHub，除非团队明确决定。

## P0 Flow

```text
demo_case.json
→ sample_analysis
→ structure_blueprint
→ material_analysis
→ gap_report
→ timeline_plan
→ storyboard / visual preview / rendered demo
```

## How to Replace Real Videos Later

1. 把真实样例视频放到 `assets/sample/`，或只在 `demo_case.json` 里记录外部链接。
2. 更新 `demo_case.json` 的 `source_sample.reference_videos`。
3. 保留 `target_content`，除非 demo 主题也要换。
4. 重新跑视频解析和结构拆解。
5. 对比真实拆解结果和当前 structure assumption。

## Developer Notes

- 不要提交 API key。
- 不要提交 `.env`。
- 不要提交大视频文件。
- 当前 case 需要保持 multi-category 兼容，不要写死成只能处理猫粮。
- 字段命名尽量和后续 schema 兼容。
- 样例视频只用于结构学习，不用于复制原视频画面、字幕或具体表达。
