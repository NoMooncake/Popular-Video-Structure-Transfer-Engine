import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import { app } from "../src/app.js";
import { storageConfig } from "../src/config/storage.js";
import {
  assembleV2FinalVideo,
  attachProductionPromptsToMaterialCoverage,
  buildV2DeterministicMaterialCoverage,
  getAdaptiveSlotPlanningRules,
  normalizeV2TargetDurationSeconds
} from "../src/services/v2PipelineService.js";
import { extractJsonObject } from "../src/v2/providers/apiJsonClient.js";
import type { V2MaterialCoverage, V2PipelineRequest } from "../src/v2/types.js";

let server: Server;
let baseUrl: string;

const generatedFileIds: string[] = [];

const getServerPort = (httpServer: Server): number => {
  const address = httpServer.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  return address.port;
};

const hasFFmpegAndFFprobe = (): boolean => {
  return (
    spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0
  );
};

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });

  baseUrl = `http://127.0.0.1:${getServerPort(server)}`;
});

after(async () => {
  fs.mkdirSync(storageConfig.uploadDir, { recursive: true });

  for (const fileId of generatedFileIds) {
    const uploadedFiles = fs
      .readdirSync(storageConfig.uploadDir)
      .filter((filename) => filename.startsWith(`${fileId}-`));

    for (const filename of uploadedFiles) {
      fs.rmSync(path.join(storageConfig.uploadDir, filename), { force: true });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

const createUploadedTestVideo = (durationSeconds: number): string => {
  fs.mkdirSync(storageConfig.uploadDir, { recursive: true });
  const fileId = crypto.randomUUID();
  const videoPath = path.join(storageConfig.uploadDir, `${fileId}-sample.mp4`);

  execFileSync(
    "ffmpeg",
    [
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=360x640:rate=12:duration=${durationSeconds}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      videoPath
    ],
    { stdio: "ignore" }
  );

  generatedFileIds.push(fileId);
  return fileId;
};

const asRecordArray = (value: unknown): Array<Record<string, unknown>> => {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
};

const asRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

test(
  "v2 deterministic material coverage blocks short material from covering longer target",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(5);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "生成 18 秒广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 18,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        slots: [
          {
            slot_id: "slot_01",
            slot_type: "strong_hook",
            time_range: {
              start_seconds: 0,
              end_seconds: 9
            }
          },
          {
            slot_id: "slot_02",
            slot_type: "product_hero",
            time_range: {
              start_seconds: 9,
              end_seconds: 18
            }
          }
        ]
      },
      {
        usable_materials: [
          {
            material_id: "user_material_01",
            file_id: fileId,
            usable_for_slots: ["strong_hook", "product_hero"],
            inferred_type: "product_demo_video"
          }
        ],
        coverage_by_slot_type: [
          {
            slot_type: "strong_hook",
            material_refs: ["user_material_01"]
          },
          {
            slot_type: "product_hero",
            material_refs: ["user_material_01"]
          }
        ]
      }
    );

    assert.equal(coverage.materials_sufficient, false);
    assert.equal(coverage.requires_ai_completion, true);
    assert.equal(coverage.total_known_material_duration_seconds, 5);
    assert.equal(coverage.hard_constraints.total_duration_coverage_passed, false);
    assert.deepEqual(coverage.material_assets[0]?.frame_sample_timestamps_seconds, [
      0.75,
      2.5,
      4.25
    ]);
    assert.equal(coverage.slot_coverage[0]?.coverage_status, "partial");
    assert.equal(coverage.slot_coverage[0]?.matched_material_duration, 5);
    assert.equal(coverage.slot_coverage[1]?.coverage_status, "missing");
    assert.equal(coverage.slot_coverage[1]?.matched_material_duration, 0);
    assert.deepEqual(coverage.slot_coverage[1]?.available_generation_paths, [
      "direct_video_from_material_frame",
      "generate_image_then_video"
    ]);
    assert.deepEqual(coverage.slot_coverage[1]?.available_user_actions, [
      "generate_direct_video_from_material_frame",
      "generate_image_then_video"
    ]);
    assert.equal(
      asRecordArray(coverage.slot_coverage[1]?.direct_video_reference_materials)[0]
        ?.material_id,
      "user_material_01"
    );
    assert.match(
      String(asRecord(coverage.slot_coverage[1]?.recommended_video_prompt).prompt),
      /不要纯文字生成/
    );
    assert.equal(
      asRecord(coverage.slot_coverage[1]?.recommended_aigc_prompt).prompt_source,
      "deterministic_slot_fallback"
    );
    assert.match(
      String(asRecord(coverage.slot_coverage[1]?.recommended_aigc_prompt).prompt),
      /product_hero/
    );
  }
);

test(
  "v2 material coverage converts nested model fit slots into table-ready assignments",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(5);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          label: "ice_tea_material_01",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "生成 10 秒广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 10,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        fillable_architecture: {
          slots: [
            {
              slot_id: "strong_hook",
              slot_name: "强视觉开场",
              time_range: "0-3秒"
            },
            {
              slot_id: "product_hero",
              slot_name: "产品亮相",
              time_range: "3-6秒"
            },
            {
              slot_id: "cta",
              slot_name: "行动号召",
              time_range: "6-10秒"
            }
          ]
        },
        aigc_prompts: {
          picture_generation_prompts: [
            {
              slot_id: "cta",
              prompt_description: "生成 CTA 定版图",
              prompt: "一瓶冰红茶居中，背景清爽，预留点击购买按钮。"
            }
          ]
        }
      },
      {
        material_analysis: {
          usable_materials: [
            {
              source: "01",
              label: "冰块与产品特写",
              description: "瓶身在冰块中，清凉感十足。",
              fit_slots: ["strong_hook", "product_hero"],
              quality: "优秀"
            }
          ],
          material_to_slot_mapping: {
            strong_hook: "01素材（冰块特写）",
            product_hero: "01素材（瓶身特写）",
            cta: "需新建"
          }
        }
      }
    );

    assert.equal(coverage.slot_coverage.length, 3);
    assert.equal(coverage.slot_coverage[0]?.slot_type, "strong_hook");
    assert.equal(coverage.slot_coverage[0]?.coverage_status, "covered");
    assert.equal(coverage.slot_coverage[0]?.frontend_coverage_status, "fully_matched");
    assert.equal(coverage.slot_coverage[0]?.frontend_coverage_label, "完全匹配");
    assert.deepEqual(asRecord(coverage.slot_coverage[0]?.frontend_display), {
      migration_result_title: "强视觉开场",
      migration_result_description: "根据当前广告结构补足该槽位画面。",
      duration_text: "3s",
      shot_description: "待补充分镜描述",
      material_summary: "ice_tea_material_01 3s",
      copy: "待生成文案",
      material_status: "完全匹配"
    });
    assert.equal(coverage.slot_coverage[0]?.matched_material_duration, 3);
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.candidate_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.assigned_materials)[0]?.material_id,
      "user_material_01"
    );

    assert.equal(coverage.slot_coverage[1]?.slot_type, "product_hero");
    assert.equal(coverage.slot_coverage[1]?.coverage_status, "partial");
    assert.equal(
      coverage.slot_coverage[1]?.frontend_coverage_status,
      "structure_complete_duration_short"
    );
    assert.equal(
      coverage.slot_coverage[1]?.frontend_coverage_label,
      "结构完整，但时长不足"
    );
    assert.equal(
      asRecord(coverage.slot_coverage[1]?.frontend_display).material_status,
      "结构完整，但时长不足"
    );
    assert.equal(
      asRecord(coverage.slot_coverage[1]?.frontend_display).material_summary,
      "ice_tea_material_01 2s"
    );
    assert.equal(coverage.slot_coverage[1]?.matched_material_duration, 2);
    assert.equal(
      asRecordArray(coverage.slot_coverage[1]?.candidate_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(coverage.slot_coverage[1]?.gap_reason, "已匹配 2s，但该槽位需要 3s。");
    assert.deepEqual(coverage.slot_coverage[1]?.available_user_actions, [
      "accept_current_material_as_sufficient",
      "generate_direct_video_from_material_frame",
      "generate_image_then_video"
    ]);
    assert.deepEqual(coverage.slot_coverage[1]?.available_generation_paths, [
      "direct_video_from_material_frame",
      "generate_image_then_video"
    ]);
    assert.equal(coverage.slot_coverage[1]?.ai_completion_required_duration, 1);

    assert.equal(coverage.slot_coverage[2]?.slot_type, "cta");
    assert.equal(coverage.slot_coverage[2]?.coverage_status, "missing");
    assert.equal(coverage.slot_coverage[2]?.frontend_coverage_status, "material_insufficient");
    assert.equal(coverage.slot_coverage[2]?.frontend_coverage_label, "素材不够");
    assert.equal(
      asRecord(coverage.slot_coverage[2]?.frontend_display).material_summary,
      "空"
    );
    assert.deepEqual(coverage.slot_coverage[2]?.available_user_actions, [
      "generate_direct_video_from_material_frame",
      "generate_image_then_video"
    ]);
    assert.deepEqual(coverage.slot_coverage[2]?.available_generation_paths, [
      "direct_video_from_material_frame",
      "generate_image_then_video"
    ]);
    assert.equal(
      asRecord(coverage.slot_coverage[2]?.recommended_aigc_prompt).prompt,
      "一瓶冰红茶居中，背景清爽，预留点击购买按钮。"
    );
  }
);

test(
  "v2 material coverage reads provider payload slot mapping and result architecture",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(1.2);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          label: "ice_tea_material_01",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 10,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        result: {
          fillable_architecture: {
            slots: [
              {
                name: "strong_hook",
                slot_duration_seconds: 2
              },
            {
              slot_name: "usage_process_and_effect",
              slot_duration_seconds: 2
            },
            {
              slot_name: "cta",
              slot_duration_seconds: 2
            }
            ],
            aigc_supplement_plan: {
              missing_slot: "cta",
              image_generation_prompt: {
                slot_name: "cta",
                prompt: "生成冰红茶购买引导定版图。"
              }
            }
          }
        }
      },
      {
        payload: {
          analysis_result: {
            素材到槽位建议: [
              {
                slot: "strong_hook",
                material_label: "ice_tea_material_01"
              }
            ]
          },
          slot_material_mapping: {
            cta: {
              source: "missing",
              materials: []
            }
          },
          slot_mapping: {
            usage_process: {
              status: "可用素材",
              recommendation: "素材01提供了极佳的产品特写，也可作为使用过程辅助镜头。"
            }
          }
        }
      }
    );

    assert.equal(coverage.slot_coverage.length, 3);
    assert.equal(coverage.slot_coverage[0]?.slot_type, "strong_hook");
    assert.equal(coverage.slot_coverage[0]?.coverage_status, "partial");
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.candidate_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.assigned_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(coverage.slot_coverage[1]?.slot_type, "usage_process");
    assert.equal(
      asRecordArray(coverage.slot_coverage[1]?.candidate_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(coverage.slot_coverage[2]?.slot_type, "cta");
    assert.equal(
      asRecord(coverage.slot_coverage[2]?.recommended_aigc_prompt).prompt,
      "生成冰红茶购买引导定版图。"
    );
  }
);

test(
  "v2 material coverage reads final plan slot planning and object prompts",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId01 = createUploadedTestVideo(2);
    const fileId02 = createUploadedTestVideo(1.2);
    const fileId03 = createUploadedTestVideo(1.1);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId01,
          uri: `/api/upload/files/${fileId01}`,
          label: "ice_tea_material_01",
          role: "user_material" as const
        },
        {
          file_id: fileId02,
          uri: `/api/upload/files/${fileId02}`,
          label: "ice_tea_material_02",
          role: "user_material" as const
        },
        {
          file_id: fileId03,
          uri: `/api/upload/files/${fileId03}`,
          label: "ice_tea_material_03",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "做一个6-8秒的冰红茶宣传视频",
        product_name: "冰红茶"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 7,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        final_plan: {
          slot_planning: [
            {
              slot_id: 1,
              slot_name: "strong_hook",
              slot_label: "冰爽强 Hook",
              duration_seconds: 2,
              source_material: ["ice_tea_material_01"],
              visual_direction: "冰红茶瓶身在冰块中的极致特写。",
              subtitle_or_vo_direction: "闪现大字：冰爽。"
            },
            {
              slot_id: 2,
              slot_name: "usage_process",
              slot_label: "畅饮解渴",
              duration_seconds: 1.5,
              source_material: ["ice_tea_material_02"],
              visual_direction: "年轻男性户外大口豪饮。"
            },
            {
              slot_id: 3,
              slot_name: "product_hero",
              slot_label: "夏日氛围",
              duration_seconds: 1.5,
              source_material: ["ice_tea_material_03"],
              visual_direction: "年轻女性户外手持冰红茶。"
            },
            {
              slot_id: 4,
              slot_name: "cta",
              slot_label: "购买引导",
              duration_seconds: 1,
              source_material: ["ai_generate"],
              visual_direction: "标准化产品落版。"
            }
          ]
        },
        aigc_prompts: {
          cta_image_generation_prompt: {
            content: {
              基础设定: "为冰红茶广告生成CTA结尾落版图。",
              主体产品: "一瓶标准包装的冰红茶饮料。"
            }
          }
        }
      },
      {
        available_materials_analysis: [
          {
            material_index: 1,
            file_name: "ice_tea_material_01",
            applicable_slot_type: ["product_hero", "selling_point_proof"]
          },
          {
            material_index: 2,
            file_name: "ice_tea_material_02",
            applicable_slot_type: ["usage_process", "effect_comparison"]
          },
          {
            material_index: 3,
            file_name: "ice_tea_material_03",
            applicable_slot_type: ["usage_process", "cta"]
          }
        ],
        planned_structure: [
          {
            slot_label: "冰爽强 Hook",
            target_duration_seconds: 2,
            source_material: ["ice_tea_material_01"]
          }
        ]
      }
    );

    assert.equal(coverage.slot_coverage.length, 4);
    assert.equal(coverage.slot_coverage[0]?.slot_type, "strong_hook");
    assert.equal(coverage.slot_coverage[0]?.slot_name, "冰爽强 Hook");
    assert.equal(coverage.slot_coverage[0]?.visual_goal, "冰红茶瓶身在冰块中的极致特写。");
    assert.equal(coverage.slot_coverage[0]?.frontend_coverage_label, "完全匹配");
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.assigned_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(coverage.slot_coverage[2]?.frontend_coverage_label, "结构完整，但时长不足");
    assert.equal(
      asRecordArray(coverage.slot_coverage[2]?.assigned_materials)[0]?.material_id,
      "user_material_03"
    );
    assert.equal(coverage.slot_coverage[3]?.frontend_coverage_label, "素材不够");
    assert.match(
      String(asRecord(coverage.slot_coverage[3]?.recommended_aigc_prompt).prompt),
      /为冰红茶广告生成CTA结尾落版图/
    );
  }
);

test(
  "v2 material coverage reads result ad structure and analysis slot materials",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId01 = createUploadedTestVideo(1.2);
    const fileId02 = createUploadedTestVideo(1.1);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId01,
          uri: `/api/upload/files/${fileId01}`,
          label: "ice_tea_material_01",
          role: "user_material" as const
        },
        {
          file_id: fileId02,
          uri: `/api/upload/files/${fileId02}`,
          label: "ice_tea_material_02",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "做一个7秒冰红茶广告",
        product_name: "冰红茶"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 7,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        result: {
          ad_structure: {
            target_slot_count: 2,
            slots: [
              {
                slot_name: "产品惊艳亮相",
                slot_type: "product_hero",
                duration_seconds: 2,
                visual_direction: "使用用户提供的素材01，突出冰红茶瓶身和冰块质感。",
                material_to_fill: "使用用户现有素材：ice_tea_material_01。"
              },
              {
                slot_name: "快速使用演示",
                slot_type: "usage_process",
                duration_seconds: 3,
                visual_direction: "使用用户提供的素材02，展示人物户外畅饮。",
                material_to_fill: "使用用户现有素材：ice_tea_material_02。"
              }
            ]
          }
        }
      },
      {
        analysis: {
          slot_analysis: [
            {
              slot_type: "product_hero",
              materials: ["ice_tea_material_01"]
            },
            {
              slot_type: "usage_process",
              materials: ["ice_tea_material_02"]
            }
          ]
        },
        plan: {
          structure: [
            {
              slot_name: "product_hero",
              duration_seconds: 2,
              materials: ["ice_tea_material_01"]
            }
          ]
        }
      }
    );

    assert.equal(coverage.slot_coverage.length, 2);
    assert.equal(coverage.slot_coverage[0]?.slot_type, "product_hero");
    assert.equal(coverage.slot_coverage[0]?.slot_name, "产品惊艳亮相");
    assert.equal(coverage.slot_coverage[0]?.visual_goal, "使用用户提供的素材01，突出冰红茶瓶身和冰块质感。");
    assert.equal(coverage.slot_coverage[0]?.frontend_coverage_label, "结构完整，但时长不足");
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.assigned_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(coverage.slot_coverage[1]?.frontend_coverage_label, "结构完整，但时长不足");
    assert.equal(
      asRecordArray(coverage.slot_coverage[1]?.assigned_materials)[0]?.material_id,
      "user_material_02"
    );
  }
);

test(
  "v2 material coverage lets user accept duration-short material as sufficient",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(1.2);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 10,
        accepted_duration_short_slots: ["strong_hook"],
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        result: {
          fillable_architecture: {
            slots: [
              {
                slot_name: "strong_hook",
                slot_duration_seconds: 2
              }
            ]
          }
        }
      },
      {
        payload: {
          slot_material_mapping: {
            strong_hook: {
              materials: ["user_material_01"]
            }
          }
        }
      }
    );

    assert.equal(coverage.materials_sufficient, true);
    assert.equal(coverage.requires_ai_completion, false);
    assert.equal(coverage.slot_coverage[0]?.coverage_status, "partial");
    assert.equal(coverage.slot_coverage[0]?.frontend_coverage_status, "fully_matched");
    assert.equal(
      coverage.slot_coverage[0]?.user_duration_short_decision,
      "accepted_as_sufficient"
    );
    assert.equal(coverage.slot_coverage[0]?.needs_ai_completion, false);
    assert.equal(coverage.slot_coverage[0]?.ai_completion_required_duration, 0);
    assert.deepEqual(coverage.slot_coverage[0]?.available_user_actions, [
      "reopen_ai_completion"
    ]);
  }
);

test(
  "v2 material coverage reads production plan material hints",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(1.2);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          label: "ice_tea_material_01",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 10,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        slots: [
          {
            slot_id: "slot_01",
            slot_type: "product_hero",
            slot_duration_seconds: 1
          }
        ]
      },
      {
        production_plan: {
          payload: {
            fillable_architecture: {
              slots: [
                {
                  slot_type: "product_hero",
                  suggestion: "使用 user_material_01 的冰红茶产品特写。"
                }
              ]
            }
          }
        }
      }
    );

    assert.equal(coverage.slot_coverage[0]?.coverage_status, "covered");
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.candidate_materials)[0]?.material_id,
      "user_material_01"
    );
  }
);

test(
  "v2 material coverage reads source material labels from mapping output",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(1.2);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          label: "ice_tea_material_01",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 10,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        slots: [
          {
            slot_id: "slot_01",
            slot_type: "strong_hook",
            slot_duration_seconds: 1
          }
        ]
      },
      {
        materials_mapping: {
          strong_hook: {
            source_material: ["ice_tea_material_01（前段产品特写）"]
          }
        }
      }
    );

    assert.equal(coverage.slot_coverage[0]?.coverage_status, "covered");
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.assigned_materials)[0]?.material_id,
      "user_material_01"
    );
  }
);

test(
  "v2 material coverage reads available materials supported slots",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(1.2);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          label: "ice_tea_material_01",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 10,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        slots: [
          {
            slot_id: "slot_03",
            slot_type: "product_hero",
            slot_duration_seconds: 1
          }
        ]
      },
      {
        analysis_result: {
          available_materials: [
            {
              label: "ice_tea_material_01",
              slots_supported: ["product_hero", "usage_process"]
            }
          ]
        }
      }
    );

    assert.equal(coverage.slot_coverage[0]?.coverage_status, "covered");
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.candidate_materials)[0]?.material_id,
      "user_material_01"
    );
  }
);

test(
  "v2 material coverage reads specific suggestions with combined slots",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(1.2);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          label: "ice_tea_material_02",
          role: "user_material" as const
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 7,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        structure_slots: [
          {
            slot_name: "usage_process",
            time_range: "0-1s"
          }
        ]
      },
      {
        materials_analysis: {
          specific_suggestions: [
            {
              slot: "product_hero & usage_process",
              material_suggestion: "素材02（仰拍饮用特写）适合使用过程。"
            }
          ]
        }
      }
    );

    assert.equal(coverage.slot_coverage[0]?.coverage_status, "covered");
    assert.equal(
      asRecordArray(coverage.slot_coverage[0]?.assigned_materials)[0]?.material_id,
      "user_material_01"
    );
  }
);

test("v2 material coverage attaches production plan image prompts", () => {
  const coverage: V2MaterialCoverage = {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 15,
    total_known_material_duration_seconds: 4,
    hard_constraints: {
      total_duration_coverage_passed: false,
      notes: []
    },
    material_assets: [],
    slot_coverage: [
      {
        slot_id: "slot_01",
        slot_type: "strong_hook",
        frontend_coverage_status: "structure_complete_duration_short"
      },
      {
        slot_id: "slot_02",
        slot_type: "selling_point_proof",
        frontend_coverage_status: "material_insufficient"
      },
      {
        slot_id: "slot_03",
        slot_type: "cta",
        frontend_coverage_status: "material_insufficient"
      }
    ]
  };

  const enrichedCoverage = attachProductionPromptsToMaterialCoverage(coverage, {
    generation_prompt_package: {
      image_prompt_candidates: [
        {
          prompt_ref: "hook_image",
          slot_type: "strong_hook",
          prompt: "生成冰红茶强 Hook 关键帧，四张候选。"
        },
        {
          prompt_ref: "cta_image",
          target_slot: "cta",
          prompt: "生成冰红茶 CTA 购买引导图，四张候选。"
        }
      ],
      aigc_generation_plan: [
        {
          purpose: "补足强Hook与卖点证明环节的微距视觉元素",
          prompt: "生成4张冰红茶瓶身与冰块微距特写候选图。"
        }
      ]
    }
  });

  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt,
    "生成冰红茶强 Hook 关键帧，四张候选。"
  );
  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[1]?.recommended_aigc_prompt).prompt,
    "生成4张冰红茶瓶身与冰块微距特写候选图。"
  );
  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[2]?.recommended_aigc_prompt).prompt_ref,
    "cta_image"
  );
});

test("v2 material coverage attaches production plan video prompts", () => {
  const coverage: V2MaterialCoverage = {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 8,
    total_known_material_duration_seconds: 3,
    hard_constraints: {
      total_duration_coverage_passed: false,
      notes: []
    },
    material_assets: [],
    slot_coverage: [
      {
        slot_id: "slot_01",
        slot_type: "product_hero",
        frontend_coverage_status: "structure_complete_duration_short",
        recommended_video_prompt: {
          prompt_ref: "product_hero_image_to_video",
          prompt_source: "deterministic_slot_fallback",
          prompt: "后端兜底视频 prompt"
        }
      }
    ]
  };

  const enrichedCoverage = attachProductionPromptsToMaterialCoverage(coverage, {
    generation_prompt_package: {
      video_prompt_candidates: [
        {
          prompt_ref: "product_hero_image_to_video",
          slot_type: "product_hero",
          prompt: "模型返回的产品亮相图生视频 prompt"
        }
      ]
    }
  });

  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_video_prompt).prompt_source,
    "model_or_plan"
  );
  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_video_prompt).prompt,
    "模型返回的产品亮相图生视频 prompt"
  );
});

test("v2 material coverage reads payload prompt generators", () => {
  const coverage: V2MaterialCoverage = {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 10,
    total_known_material_duration_seconds: 4,
    hard_constraints: {
      total_duration_coverage_passed: false,
      notes: []
    },
    material_assets: [],
    slot_coverage: [
      {
        slot_id: "slot_07",
        slot_type: "cta",
        frontend_coverage_status: "material_insufficient",
        recommended_aigc_prompt: {
          prompt_ref: "cta_fallback",
          prompt_source: "deterministic_slot_fallback",
          prompt: "后端兜底 CTA prompt"
        }
      }
    ]
  };

  const enrichedCoverage = attachProductionPromptsToMaterialCoverage(coverage, {
    payload: {
      prompt_generators: [
        {
          slot_type: "cta",
          prompt: "模型 payload 里的 CTA 图片生成 prompt"
        }
      ]
    }
  });

  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt_source,
    "model_or_plan"
  );
  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt,
    "模型 payload 里的 CTA 图片生成 prompt"
  );
});

test("v2 material coverage reads payload generation plan section prompts", () => {
  const coverage: V2MaterialCoverage = {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 10,
    total_known_material_duration_seconds: 4,
    hard_constraints: {
      total_duration_coverage_passed: false,
      notes: []
    },
    material_assets: [],
    slot_coverage: [
      {
        slot_id: "slot_03",
        slot_type: "product_hero",
        frontend_coverage_status: "material_insufficient",
        recommended_aigc_prompt: {
          prompt_ref: "product_hero_fallback",
          prompt_source: "deterministic_slot_fallback",
          prompt: "后端兜底产品图 prompt"
        }
      }
    ]
  };

  const enrichedCoverage = attachProductionPromptsToMaterialCoverage(coverage, {
    payload: {
      generation_plan: {
        items: [
          {
            slot_name: "product_hero",
            prompt: {
              image_generation: {
                sections: {
                  基础设定: "竖屏产品主视觉",
                  主体产品: "冰红茶瓶装产品"
                }
              }
            }
          }
        ]
      }
    }
  });

  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt_source,
    "model_or_plan"
  );
  assert.match(
    String(asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt),
    /【基础设定】竖屏产品主视觉/
  );
});

test("v2 material coverage reads missing material image prompts", () => {
  const coverage: V2MaterialCoverage = {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 10,
    total_known_material_duration_seconds: 4,
    hard_constraints: {
      total_duration_coverage_passed: false,
      notes: []
    },
    material_assets: [],
    slot_coverage: [
      {
        slot_id: "slot_01",
        slot_type: "strong_hook",
        frontend_coverage_status: "material_insufficient",
        recommended_aigc_prompt: {
          prompt_ref: "strong_hook_fallback",
          prompt_source: "deterministic_slot_fallback",
          prompt: "后端兜底 hook prompt"
        }
      }
    ]
  };

  const enrichedCoverage = attachProductionPromptsToMaterialCoverage(coverage, {
    missing_material_prompts: {
      image_prompts: [
        {
          slot: "strong_hook",
          prompt: "模型 missing_material_prompts 里的冰块撞击开场 prompt"
        }
      ]
    }
  });

  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt_source,
    "model_or_plan"
  );
  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt,
    "模型 missing_material_prompts 里的冰块撞击开场 prompt"
  );
});

test("v2 material coverage replaces fallback prompts with production prompts", () => {
  const coverage: V2MaterialCoverage = {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 10,
    total_known_material_duration_seconds: 4,
    hard_constraints: {
      total_duration_coverage_passed: false,
      notes: []
    },
    material_assets: [],
    slot_coverage: [
      {
        slot_id: "slot_07",
        slot_type: "cta",
        frontend_coverage_status: "material_insufficient",
        recommended_aigc_prompt: {
          prompt_ref: "cta_fallback",
          prompt_source: "deterministic_slot_fallback",
          prompt: "后端兜底 CTA prompt"
        }
      }
    ]
  };

  const enrichedCoverage = attachProductionPromptsToMaterialCoverage(coverage, {
    assembly: {
      ai_generation_plan: {
        generative_slots: [
          {
            slot_type: "cta",
            image_prompts: [
              {
                prompt: "模型生成的冰红茶 CTA 结尾卡 prompt"
              }
            ]
          }
        ]
      }
    }
  });

  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt_source,
    "model_or_plan"
  );
  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt,
    "模型生成的冰红茶 CTA 结尾卡 prompt"
  );
});

test("v2 material coverage does not infer usage process from generic drinking goal", () => {
  const coverage: V2MaterialCoverage = {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 10,
    total_known_material_duration_seconds: 4,
    hard_constraints: {
      total_duration_coverage_passed: false,
      notes: []
    },
    material_assets: [],
    slot_coverage: [
      {
        slot_id: "slot_05",
        slot_type: "usage_process",
        frontend_coverage_status: "material_insufficient",
        recommended_aigc_prompt: {
          prompt_ref: "usage_process_fallback",
          prompt_source: "deterministic_slot_fallback",
          prompt: "后端兜底使用过程 prompt"
        }
      },
      {
        slot_id: "slot_07",
        slot_type: "cta",
        frontend_coverage_status: "material_insufficient",
        recommended_aigc_prompt: {
          prompt_ref: "cta_fallback",
          prompt_source: "deterministic_slot_fallback",
          prompt: "后端兜底 CTA prompt"
        }
      }
    ]
  };

  const enrichedCoverage = attachProductionPromptsToMaterialCoverage(coverage, {
    assembly: {
      ai_generation_plan: {
        generative_slots: [
          {
            slot_type: "cta",
            image_prompts: [
              {
                prompt:
                  "【基础设定】用于 CTA 槽位。目标是突出清爽、解渴、夏天饮用场景和购买欲。"
              }
            ]
          }
        ]
      }
    }
  });

  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[0]?.recommended_aigc_prompt).prompt_source,
    "deterministic_slot_fallback"
  );
  assert.equal(
    asRecord(enrichedCoverage.slot_coverage[1]?.recommended_aigc_prompt).prompt_source,
    "model_or_plan"
  );
});

test("v2 target duration keeps a 10 second user request", () => {
  assert.equal(normalizeV2TargetDurationSeconds(10), 10);
  assert.equal(normalizeV2TargetDurationSeconds(2), 5);
  assert.equal(normalizeV2TargetDurationSeconds(90), 60);
});

test("v2 adaptive slot planning asks short videos to merge modules", () => {
  assert.equal(getAdaptiveSlotPlanningRules(7).target_slot_count_range, "3-5");
  assert.match(String(getAdaptiveSlotPlanningRules(7).rule), /不能机械拆成7个模块/);
  assert.equal(getAdaptiveSlotPlanningRules(12).target_slot_count_range, "4-6");
  assert.equal(getAdaptiveSlotPlanningRules(20).target_slot_count_range, "6-7");
});

test("v2 provider JSON extraction repairs common model JSON issues", () => {
  assert.deepEqual(
    extractJsonObject(
      '```json\n{ unquoted_key: "value", "items": [1, 2,], }\n```',
      "test_json_repair"
    ),
    {
      unquoted_key: "value",
      items: [1, 2]
    }
  );

  assert.deepEqual(
    extractJsonObject('前置说明\n[{"slot":"hook"}]\n后置说明', "test_json_array"),
    {
      items: [
        {
          slot: "hook"
        }
      ]
    }
  );

  assert.equal(
    extractJsonObject('{"prompt":"第一行\n第二行"}', "test_json_newline").prompt,
    "第一行\n第二行"
  );
});

test("GET /api/v2/status exposes 4 as the default image candidate count", async () => {
  const response = await fetch(`${baseUrl}/api/v2/status`);
  const body = (await response.json()) as {
    image_candidate_count_default: number;
    image_candidate_count_max: number;
  };

  assert.equal(response.status, 200);
  assert.equal(body.image_candidate_count_default, 4);
  assert.equal(body.image_candidate_count_max, 6);
});

test("POST /api/v2/generation/video-trim-review rejects missing video URI", async () => {
  const response = await fetch(`${baseUrl}/api/v2/generation/video-trim-review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      target_duration_seconds: 2
    })
  });
  const body = (await response.json()) as {
    error: {
      code: string;
      message: string;
    };
  };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_v2_video_trim_review_input");
  assert.match(body.error.message, /video_uri is required/);
});

test("POST /api/v2/generation/image-to-video rejects text-only video generation", async () => {
  const response = await fetch(`${baseUrl}/api/v2/generation/image-to-video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      video_prompt: "只用文字直接生视频",
      allow_fallback: true
    })
  });
  const body = (await response.json()) as {
    error: {
      code: string;
      message: string;
    };
  };

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_v2_image_to_video_input");
  assert.match(body.error.message, /source image is required/);
});

test(
  "POST /api/v2/generation/image-to-video can use an existing material frame",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(1.2);
    const sourceVideoUri = path.join(storageConfig.uploadDir, `${fileId}-sample.mp4`);
    const response = await fetch(`${baseUrl}/api/v2/generation/image-to-video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source_video_uri: sourceVideoUri,
        video_prompt: "基于已有冰红茶素材截图生成补齐视频",
        generation_mode: "direct_from_material_frame",
        duration_seconds: 2,
        allow_fallback: true
      })
    });
    const body = (await response.json()) as {
      status: string;
      input: {
        image_uri: string;
        generation_mode: string;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, "mock_ready");
    assert.match(body.input.image_uri, /^data:image\/jpeg;base64,/);
    assert.equal(body.input.generation_mode, "direct_from_material_frame");
  }
);

test(
  "v2 final assembly concatenates slot videos with ffmpeg",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const firstFileId = createUploadedTestVideo(0.5);
    const secondFileId = createUploadedTestVideo(0.5);

    const result = await assembleV2FinalVideo({
      target_duration_seconds: 1,
      resolution: "360x640",
      fps: 24,
      slots: [
        {
          slot_id: "slot_01",
          slot_type: "strong_hook",
          video_uri: `/api/upload/files/${firstFileId}`,
          duration_seconds: 0.5
        },
        {
          slot_id: "slot_02",
          slot_type: "product_hero",
          video_uri: `/api/upload/files/${secondFileId}`,
          duration_seconds: 0.5
        }
      ]
    });

    assert.match(String(result.final_video_url), /^\/api\/v2\/assembly\/final-videos\//);
    assert.equal(result.planned_duration_seconds, 1);
    assert.deepEqual(result.audio_policy, {
      source_clip_audio: "muted",
      per_clip_bgm: "disabled",
      final_bgm: {
        selection_mode: "ai_selected_at_final_assembly",
        status: "pending_provider_integration"
      }
    });
    assert.ok(
      Math.abs(Number(result.final_duration_seconds) - 1) < 0.15,
      `expected final duration close to 1s, got ${result.final_duration_seconds}`
    );
  }
);

test("GET /api/v2/generation/trimmed-videos rejects unknown generated video", async () => {
  const response = await fetch(
    `${baseUrl}/api/v2/generation/trimmed-videos/missing.mp4`
  );
  const body = (await response.json()) as {
    error: {
      code: string;
    };
  };

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "trimmed_video_not_found");
});

test("GET /api/v2/assembly/final-videos rejects unknown final video", async () => {
  const response = await fetch(
    `${baseUrl}/api/v2/assembly/final-videos/missing.mp4`
  );
  const body = (await response.json()) as {
    error: {
      code: string;
    };
  };

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "final_video_not_found");
});
