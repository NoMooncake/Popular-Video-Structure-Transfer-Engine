import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

import { app } from "../src/app.js";
import { config } from "../src/config/index.js";
import { storageConfig } from "../src/config/storage.js";
import {
  analyzeV2ReferenceVideos,
  assembleV2FinalVideo,
  attachProductionPromptsToMaterialCoverage,
  buildV2DeterministicMaterialCoverage,
  buildV2ReferenceAnalysisTables,
  getAdaptiveSlotPlanningRules,
  isErroredV2ReferenceAnalysisOutput,
  normalizeTrimRecommendation,
  normalizeV2TargetDurationSeconds
} from "../src/services/v2PipelineService.js";
import {
  extractJsonObject,
  normalizeVolcengineVideoDurationSeconds
} from "../src/v2/providers/apiJsonClient.js";
import type { V2MaterialCoverage, V2PipelineRequest } from "../src/v2/types.js";

let server: Server;
let baseUrl: string;

const generatedFileIds: string[] = [];
const generatedTempPaths: string[] = [];

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

  for (const tempPath of generatedTempPaths) {
    fs.rmSync(tempPath, { force: true });
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

const createTestAudio = (durationSeconds: number): string => {
  fs.mkdirSync(storageConfig.outputDir, { recursive: true });
  const audioPath = path.join(storageConfig.outputDir, `${crypto.randomUUID()}-bgm.m4a`);

  execFileSync(
    "ffmpeg",
    [
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${durationSeconds}:sample_rate=44100`,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-y",
      audioPath
    ],
    { stdio: "ignore" }
  );

  generatedTempPaths.push(audioPath);
  return audioPath;
};

const asRecordArray = (value: unknown): Array<Record<string, unknown>> => {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
};

const asRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

test("v2 volcengine video duration is normalized to supported provider lengths", () => {
  assert.equal(normalizeVolcengineVideoDurationSeconds(1.417), 5);
  assert.equal(normalizeVolcengineVideoDurationSeconds(5), 5);
  assert.equal(normalizeVolcengineVideoDurationSeconds(5.1), 10);
  assert.equal(normalizeVolcengineVideoDurationSeconds(12), 10);
});

test("v2 generated video trim keeps AI-selected start but clamps to target duration", () => {
  const recommendation = normalizeTrimRecommendation(
    {
      recommended_start_seconds: 3,
      recommended_end_seconds: 5.125,
      recommended_duration_seconds: 2.125,
      quality_status: "good"
    },
    1.917,
    5.125
  );

  assert.equal(recommendation.recommended_start_seconds, 3);
  assert.equal(recommendation.recommended_end_seconds, 4.917);
  assert.equal(recommendation.recommended_duration_seconds, 1.917);
});

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
      "add_material",
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
  "v2 material coverage assigns user material segments and exposes reference superscripts",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(8);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          role: "user_material" as const,
          label: "ice_tea_user_clip.mp4"
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "生成冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 5,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        editable_slots: [
          {
            slot_id: "slot_01",
            slot_type: "product_hero",
            duration_seconds: 2,
            visual_direction: "产品瓶身冰镇特写"
          },
          {
            slot_id: "slot_02",
            slot_type: "usage_process",
            duration_seconds: 3,
            visual_direction: "年轻人饮用冰红茶"
          }
        ]
      },
      {
        analysis: {
          material_analysis: {
            material_segments: [
              {
                material_id: "user_material_01",
                segment_id: "seg_product",
                start_time: 0,
                end_time: 2,
                duration_seconds: 2,
                visual_description: "冰红茶瓶身和水珠特写",
                candidate_slot_types: ["product_hero"],
                recommended_usage: "裁切 + 加产品标题"
              },
              {
                material_id: "user_material_01",
                segment_id: "seg_drink",
                start_time: 2,
                end_time: 5,
                duration_seconds: 3,
                visual_description: "年轻人拿起冰红茶饮用",
                candidate_slot_types: ["usage_process"],
                recommended_usage: "快速剪辑 + 保留喝饮料动作"
              }
            ]
          }
        }
      },
      [
        {
          sample_index: 1,
          rows: [
            {
              source_slot_type: "product_hero"
            }
          ]
        },
        {
          sample_index: 3,
          rows: [
            {
              source_slot_type: "usage_process"
            }
          ]
        }
      ]
    );

    const firstSlot = asRecord(coverage.slot_coverage[0]);
    const secondSlot = asRecord(coverage.slot_coverage[1]);
    assert.equal(firstSlot.coverage_status, "covered");
    assert.equal(secondSlot.coverage_status, "covered");
    assert.equal(asRecordArray(firstSlot.assigned_materials)[0]?.segment_id, "seg_product");
    assert.equal(asRecordArray(secondSlot.assigned_materials)[0]?.segment_id, "seg_drink");
    assert.match(String(asRecord(firstSlot.frontend_display).material_summary), /0 - 2s/);
    assert.match(String(asRecord(secondSlot.frontend_display).material_summary), /快速剪辑/);
    assert.deepEqual(firstSlot.source_reference_indices, [1]);
    assert.equal(asRecord(firstSlot.frontend_display).source_reference_superscript, "¹");
    assert.deepEqual(asRecord(asRecord(firstSlot.frontend_display).add_material_button), {
      visible: true,
      label: "添加素材",
      action: "add_material"
    });
    assert.equal(
      Array.isArray(firstSlot.available_user_actions) &&
        firstSlot.available_user_actions.includes("add_material"),
      true
    );
    assert.deepEqual(secondSlot.source_reference_indices, [3]);
    assert.equal(asRecord(secondSlot.frontend_display).source_reference_superscript, "³");
  }
);

test(
  "v2 material coverage reads synthesized payload slot sequence",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(4);
    const normalized = {
      reference_videos: [],
      reference_file_ids: [],
      user_materials: [
        {
          file_id: fileId,
          uri: `/api/upload/files/${fileId}`,
          role: "user_material" as const,
          label: "ice_tea_payload_clip.mp4"
        }
      ],
      user_material_file_ids: [],
      text_assets: [],
      user_request: {
        goal: "生成冰红茶广告"
      },
      options: {
        image_candidate_count: 4,
        generate_image_candidates: false,
        target_duration_seconds: 4,
        allow_fallback: true
      }
    } satisfies Required<V2PipelineRequest>;

    const coverage = await buildV2DeterministicMaterialCoverage(
      normalized,
      {
        payload: {
          synthesized_structure: {
            slot_sequence: [
              {
                slot_index: 1,
                slot_type: "strong_hook",
                duration_seconds: 2,
                source_reference_indices: [2],
                description: "冰镇瓶身和水珠微距强开场",
                visual_direction: "微距特写冰红茶瓶身，冰块飞溅，冷凝水珠清晰。",
                copy_direction: "这一口，立刻降温。"
              }
            ]
          }
        }
      },
      {
        material_analysis: {
          material_segments: [
            {
              material_id: "user_material_01",
              segment_id: "seg_hook",
              start_time: 0,
              end_time: 2,
              duration_seconds: 2,
              visual_description: "冰红茶瓶身、水珠和冰块特写",
              candidate_slot_types: ["strong_hook"],
              recommended_usage: "裁切 + 强化冰感"
            }
          ]
        }
      }
    );

    const firstSlot = asRecord(coverage.slot_coverage[0]);

    assert.equal(coverage.slot_coverage.length, 1);
    assert.equal(firstSlot.slot_id, "slot_01");
    assert.equal(firstSlot.slot_type, "strong_hook");
    assert.equal(firstSlot.coverage_status, "covered");
    assert.equal(
      asRecord(firstSlot.frontend_display).shot_description,
      "微距特写冰红茶瓶身，冰块飞溅，冷凝水珠清晰。"
    );
    assert.equal(asRecord(firstSlot.frontend_display).copy, "这一口，立刻降温。");
    assert.deepEqual(firstSlot.source_reference_indices, [2]);
    assert.equal(asRecord(firstSlot.frontend_display).source_reference_superscript, "²");
    assert.equal(asRecordArray(firstSlot.assigned_materials)[0]?.segment_id, "seg_hook");
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
      material_status: "完全匹配",
      add_material_button: {
        visible: true,
        label: "添加素材",
        action: "add_material"
      }
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
      "add_material",
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
      "add_material",
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
      "add_material",
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
  assert.match(String(getAdaptiveSlotPlanningRules(7).rule), /用户需求/);
  assert.equal(getAdaptiveSlotPlanningRules(12).target_slot_count_range, "4-6");
  assert.match(
    String(getAdaptiveSlotPlanningRules(12).rule),
    /不要把用户原始素材的镜头长短当作成片节奏结论/
  );
  assert.equal(getAdaptiveSlotPlanningRules(20).target_slot_count_range, "6-7");
  assert.match(
    String(getAdaptiveSlotPlanningRules(20).rule),
    /不能单独决定最终广告节奏/
  );
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

test("v2 reference analysis tables bind timeline rows to extracted frame URIs", () => {
  const tables = buildV2ReferenceAnalysisTables(
    [
      {
        reference_video_analysis: {
          slot_timeline: [
            {
              slot_id: "ref_slot_01",
              slot_type: "strong_hook",
              start_time: "00:00",
              end_time: "00:02",
              visual_description: "冰镇产品强特写，水珠和冰块制造清爽感。",
              migration_possibility: "可迁移为新广告的冰爽产品开场。"
            },
            {
              slot_id: "ref_slot_02",
              slot_type: "product_hero",
              start_time: "00:02",
              end_time: "00:05",
              visual_description: "产品旋转展示，突出包装和质感。",
              migration_possibility: "可迁移为新商品的主体亮相。"
            }
          ]
        }
      }
    ],
    [
      {
        file_id: "reference-file-id",
        uri: "/tmp/reference.mp4",
        role: "reference_sample",
        label: "样例视频 1"
      }
    ],
    [
      [
        {
          frame_id: "reference_frame_01",
          source_uri: "/tmp/reference.mp4",
          source_label: "样例视频 1",
          time_seconds: 1,
          file_path: "/tmp/reference_01.jpg",
          public_uri: "/api/v2/reference-frames/run/reference_01.jpg",
          mime_type: "image/jpeg",
          data_url: "data:image/jpeg;base64,aaa"
        },
        {
          frame_id: "reference_frame_02",
          source_uri: "/tmp/reference.mp4",
          source_label: "样例视频 1",
          time_seconds: 4,
          file_path: "/tmp/reference_02.jpg",
          public_uri: "/api/v2/reference-frames/run/reference_02.jpg",
          mime_type: "image/jpeg",
          data_url: "data:image/jpeg;base64,bbb"
        }
      ]
    ],
    20
  );

  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0]?.columns, ["时长", "样例视频", "分镜描述", "迁移可能性"]);
  assert.equal(tables[0]?.file_id, "reference-file-id");

  const rows = asRecordArray(tables[0]?.rows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.duration, "0 - 2s");
  assert.equal(asRecord(asRecord(rows[0]?.sample_video).media).uri, "/api/v2/reference-frames/run/reference_01.jpg");
  assert.equal(asRecord(asRecord(rows[1]?.sample_video).media).uri, "/api/v2/reference-frames/run/reference_02.jpg");
  assert.equal(asRecord(rows[0]?.shot_description).title, "强 Hook");
  assert.equal(rows[0]?.migration_possibility, "高度可迁移。可迁移为新广告的冰爽产品开场。");
  assert.equal(rows[1]?.migration_possibility, "高度可迁移。可迁移为新商品的主体亮相。");
});

test(
  "v2 reference analysis retries provider error output with attached frames",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    assert.equal(
      isErroredV2ReferenceAnalysisOutput({
        error: "The request was rejected because it was considered high risk"
      }),
      true
    );

    const providerCalls: Array<Record<string, unknown>> = [];
    const mockProvider = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        providerCalls.push(JSON.parse(body) as Record<string, unknown>);
        const content =
          providerCalls.length === 1
            ? {
                error: "The request was rejected because it was considered high risk"
              }
            : {
                reference_video_analysis: {
                  slot_timeline: [
                    {
                      slot_type: "strong_hook",
                      start_time: 0,
                      end_time: 2,
                      duration_seconds: 2,
                      visual_description: "瓶盖打开，饮料气泡和冰爽质感形成开场冲击。",
                      copywriting: "冰爽开场",
                      analysis: "用强特写快速建立清爽记忆点。",
                      migration_possibility: "高，可迁移为冰红茶开瓶特写和清爽气泡。"
                    }
                  ],
                  content_logic: "开瓶强特写 -> 气泡质感"
                }
              };

        response.writeHead(200, {
          "Content-Type": "application/json"
        });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(content)
                }
              }
            ]
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      mockProvider.listen(0, "127.0.0.1", resolve);
    });

    const mutableConfig = config as unknown as {
      providers: {
        v2: {
          multimodal: {
            provider: string;
            apiBaseUrl?: string;
            apiPath: string;
            model?: string;
            apiKey?: string;
            enabled: boolean;
          };
        };
      };
    };
    const previousProvider = {
      ...mutableConfig.providers.v2.multimodal
    };

    try {
      const providerPort = getServerPort(mockProvider);
      Object.assign(mutableConfig.providers.v2.multimodal, {
        provider: "mock",
        apiBaseUrl: `http://127.0.0.1:${providerPort}`,
        apiPath: "/chat/completions",
        model: "mock-model",
        apiKey: "test-key",
        enabled: true
      });

      const fileId = createUploadedTestVideo(4);
      const videoPath = path.join(storageConfig.uploadDir, `${fileId}-sample.mp4`);
      const result = await analyzeV2ReferenceVideos({
        user_request: {
          goal: "生成一个冰红茶的宣传视频"
        },
        reference_videos: [
          {
            file_id: fileId,
            uri: videoPath,
            role: "reference_sample",
            label: "新增样例"
          }
        ],
        user_materials: [],
        options: {
          target_duration_seconds: 20,
          allow_fallback: false,
          generate_image_candidates: false
        }
      });

      assert.equal(providerCalls.length, 2);

      const retryMessage = asRecordArray(providerCalls[1]?.messages)[1];
      const retryContent = asRecordArray(retryMessage?.content);
      assert.equal(
        retryContent.filter((part) => part.type === "image_url").length,
        6
      );
      assert.equal(
        retryContent.filter((part) => part.type === "video_url").length,
        0
      );

      const tables = asRecordArray(asRecord(result.stages).reference_analysis_tables);
      const rows = asRecordArray(tables[0]?.rows);
      assert.equal(rows.length, 1);
      assert.equal(asRecord(rows[0]?.shot_description).title, "强 Hook");
      assert.equal(
        rows[0]?.migration_possibility,
        "高度可迁移。可迁移为冰红茶开瓶特写和清爽气泡。"
      );
    } finally {
      Object.assign(mutableConfig.providers.v2.multimodal, previousProvider);
      await new Promise<void>((resolve, reject) => {
        mockProvider.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  }
);

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
  "v2 script session saves edited duration and canvas revalidates against slot materials",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const firstFileId = createUploadedTestVideo(1);
    const secondFileId = createUploadedTestVideo(1);

    const createResponse = await fetch(`${baseUrl}/api/v2/script-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_request: {
          goal: "冰红茶宣传片",
          product_name: "冰红茶"
        },
        target_duration_seconds: 2,
        slots: [
          {
            slot_id: "slot_01",
            slot_type: "product_hero",
            slot_name: "产品亮相",
            duration_seconds: 2,
            shot_description: "冰红茶瓶身和冰块特写。",
            copy: "冰爽一下。",
            materials: [
              {
                material_id: "ice_tea_clip_01",
                file_id: firstFileId,
                uri: `/api/upload/files/${firstFileId}`,
                label: "ice_tea_clip_01"
              }
            ]
          }
        ]
      })
    });
    const created = (await createResponse.json()) as {
      session_id: string;
      slots: Array<{
        slot_id: string;
        required_duration: number;
        shot_description: string;
      }>;
    };

    assert.equal(createResponse.status, 201);
    assert.equal(created.slots[0]?.required_duration, 2);
    assert.equal(created.slots[0]?.shot_description, "产品亮相¹\n冰红茶瓶身和冰块特写。");

    const lockedResponse = await fetch(
      `${baseUrl}/api/v2/script-sessions/${created.session_id}/slots/slot_01`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          shot_description: "用户试图修改分镜"
        })
      }
    );
    const lockedBody = (await lockedResponse.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    assert.equal(lockedResponse.status, 400);
    assert.equal(lockedBody.error.code, "invalid_v2_script_slot_input");
    assert.match(lockedBody.error.message, /locked/);

    const updateResponse = await fetch(
      `${baseUrl}/api/v2/script-sessions/${created.session_id}/slots/slot_01`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          required_duration: 0.5,
          voiceover_text: "清凉马上回来。"
        })
      }
    );
    const updated = (await updateResponse.json()) as {
      target_duration_seconds: number;
      slots: Array<{
        required_duration: number;
        voiceover_text: string;
      }>;
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.target_duration_seconds, 0.5);
    assert.equal(updated.slots[0]?.required_duration, 0.5);
    assert.equal(updated.slots[0]?.voiceover_text, "清凉马上回来。");

    const shortRevalidateResponse = await fetch(`${baseUrl}/api/v2/canvas/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: created.session_id,
        use_multimodal_provider: false
      })
    });
    const shortRevalidate = (await shortRevalidateResponse.json()) as {
      material_candidate_pool: {
        candidate_pool_id: string;
        summary: Record<string, unknown>;
        refinement: Record<string, unknown>;
      };
      material_segments: Array<Record<string, unknown>>;
      material_coverage: {
        slot_coverage: Array<Record<string, unknown>>;
        matching_source: string;
      };
      canvas_nodes: Array<Record<string, unknown>>;
      canvas_session_id: string;
      canvas_session: {
        canvas_session_id: string;
        nodes: Array<Record<string, unknown>>;
        edges: Array<Record<string, unknown>>;
      };
      cover_plan: Record<string, unknown>;
    };

    assert.equal(shortRevalidateResponse.status, 200);
    assert.equal(shortRevalidate.material_candidate_pool.summary.segment_count, 1);
    assert.equal(shortRevalidate.material_candidate_pool.summary.frame_count, 3);
    assert.match(
      String(shortRevalidate.material_candidate_pool.refinement.status),
      /^deterministic_fallback$/
    );
    assert.equal(shortRevalidate.canvas_nodes[0]?.coverage_status, "fully_matched");
    assert.equal(shortRevalidate.cover_plan.cover_title, "冰红茶，一眼心动");
    assert.ok(Array.isArray(shortRevalidate.cover_plan.cover_copy_options));
    assert.deepEqual(shortRevalidate.cover_plan.video_title_recommendations, [
      "冰红茶，一眼心动",
      "冰红茶，一口入夏",
      "热到融化？来口冰红茶",
      "这个夏天，就要冰红茶",
      "冰红茶清爽时刻"
    ]);
    assert.deepEqual(shortRevalidate.cover_plan.video_description_recommendations, [
      "夏天热到没电？来一口冰红茶，把清爽感拉满。",
      "冰红茶冰爽登场，水珠、冰块和畅快口感一起唤醒夏日好心情。",
      "从炎热到清爽，只差一口冰红茶。适合夏日聚会、通勤和休闲时刻。",
      "这一支冰红茶短片，用冰感特写和畅饮瞬间记录夏天最想要的清爽。"
    ]);
    assert.match(
      String(asRecord(shortRevalidate.cover_plan.bgm_plan).prompt),
      /冰红茶/
    );
    assert.equal(asRecord(shortRevalidate.cover_plan.bgm_plan).duration_seconds, 0.5);
    assert.match(
      String(asRecord(shortRevalidate.cover_plan.cover_image_prompt).prompt),
      /冰红茶/
    );
    assert.doesNotMatch(
      String(asRecord(shortRevalidate.cover_plan.cover_image_prompt).prompt),
      /\/Users\/|\/Volumes\/|等待多模态|候选素材|进一步确认/u
    );
    assert.doesNotMatch(
      String(asRecord(shortRevalidate.cover_plan.cover_image_prompt).prompt),
      /。。/u
    );
    assert.match(
      String(asRecord(shortRevalidate.cover_plan.recommended_source).frame_uri),
      /^\/api\/v2\/material-candidate-pools\//
    );
    assert.match(shortRevalidate.canvas_session_id, /^v2_canvas_/);
    assert.equal(
      shortRevalidate.canvas_session.canvas_session_id,
      shortRevalidate.canvas_session_id
    );
    assert.ok(
      shortRevalidate.canvas_session.nodes.some(
        (node) => node.node_type === "script_slot"
      )
    );
    assert.ok(
      shortRevalidate.canvas_session.nodes.some(
        (node) => node.node_type === "material_segment"
      )
    );
    const savedCanvasResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${shortRevalidate.canvas_session_id}`
    );
    const savedCanvas = (await savedCanvasResponse.json()) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    assert.equal(savedCanvasResponse.status, 200);
    assert.equal(savedCanvas.nodes.length, shortRevalidate.canvas_session.nodes.length);
    const updatedCanvasResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${shortRevalidate.canvas_session_id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          nodes: [
            {
              ...savedCanvas.nodes[0],
              position: {
                x: 120,
                y: 80
              }
            },
            ...savedCanvas.nodes.slice(1)
          ],
          edges: savedCanvas.edges
        })
      }
    );
    const updatedCanvas = (await updatedCanvasResponse.json()) as {
      nodes: Array<Record<string, unknown>>;
    };
    assert.equal(updatedCanvasResponse.status, 200);
    assert.deepEqual(asRecord(updatedCanvas.nodes[0]?.position), { x: 120, y: 80 });
    assert.equal(shortRevalidate.material_coverage.matching_source, "refined_material_segments");
    assert.equal(shortRevalidate.material_coverage.slot_coverage[0]?.required_duration, 0.5);
    assert.equal(
      shortRevalidate.material_coverage.slot_coverage[0]?.matching_source,
      "refined_material_segments"
    );
    assert.equal(
      asRecordArray(shortRevalidate.material_coverage.slot_coverage[0]?.assigned_segments)
        .length,
      1
    );
    assert.equal(asRecordArray(shortRevalidate.canvas_nodes[0]?.assigned_segments).length, 1);
    assert.equal(shortRevalidate.material_segments.length, 1);
    assert.equal(
      shortRevalidate.material_segments[0]?.segmentation_source,
      "coherent_whole_material_segment"
    );
    assert.equal(
      shortRevalidate.material_segments[0]?.pacing_inference_source,
      "user_request_first_material_pacing_not_authoritative"
    );
    assert.deepEqual(
      shortRevalidate.material_segments[0]?.high_frequency_frame_timestamps_seconds,
      [0, 0.5, 1]
    );
    assert.ok(Array.isArray(shortRevalidate.material_segments[0]?.visual_tags));
    assert.ok(Array.isArray(shortRevalidate.material_segments[0]?.usable_slot_types));
    assert.equal(typeof shortRevalidate.material_segments[0]?.quality_score, "number");
    assert.equal(typeof shortRevalidate.material_segments[0]?.content_summary, "string");
    const frames = asRecordArray(shortRevalidate.material_segments[0]?.frames);
    assert.equal(frames.length, 3);
    assert.match(String(frames[0]?.uri), /^\/api\/v2\/material-candidate-pools\//);
    assert.equal(frames[0]?.extraction_status, "extracted");

    const frameResponse = await fetch(`${baseUrl}${String(frames[0]?.uri)}`);
    assert.equal(frameResponse.status, 200);
    assert.match(frameResponse.headers.get("content-type") || "", /image\/jpeg/);

    const poolResponse = await fetch(
      `${baseUrl}/api/v2/material-candidate-pools/${shortRevalidate.material_candidate_pool.candidate_pool_id}`
    );
    const pool = (await poolResponse.json()) as {
      summary: Record<string, unknown>;
    };
    assert.equal(poolResponse.status, 200);
    assert.equal(pool.summary.frame_count, 3);

    const directPoolResponse = await fetch(
      `${baseUrl}/api/v2/material-candidate-pools/from-script-session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          session_id: created.session_id,
          candidate_pool_id: `${created.session_id}_direct_test_pool`,
          use_multimodal_provider: false
        })
      }
    );
    const directPool = (await directPoolResponse.json()) as {
      summary: Record<string, unknown>;
      refinement: Record<string, unknown>;
      material_segments: Array<Record<string, unknown>>;
    };
    assert.equal(directPoolResponse.status, 201);
    assert.equal(directPool.summary.segment_count, 1);
    assert.equal(directPool.refinement.status, "deterministic_fallback");
    assert.equal(directPool.material_segments[0]?.refinement_source, "deterministic_fallback");

    await fetch(`${baseUrl}/api/v2/script-sessions/${created.session_id}/slots/slot_01`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        required_duration: 2
      })
    });

    const longRevalidateResponse = await fetch(`${baseUrl}/api/v2/canvas/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: created.session_id,
        use_multimodal_provider: false
      })
    });
    const longRevalidate = (await longRevalidateResponse.json()) as {
      canvas_nodes: Array<Record<string, unknown>>;
      canvas_session_id: string;
      canvas_session: {
        nodes: Array<Record<string, unknown>>;
      };
    };
    assert.equal(longRevalidateResponse.status, 200);
    assert.equal(
      longRevalidate.canvas_nodes[0]?.coverage_status,
      "structure_complete_duration_short"
    );
    assert.equal(longRevalidate.canvas_nodes[0]?.missing_duration, 1);
    assert.match(
      String(asRecord(longRevalidate.canvas_nodes[0]?.recommended_video_prompt).prompt),
      /冰红茶/
    );
    assert.match(
      String(asRecord(longRevalidate.canvas_nodes[0]?.recommended_video_prompt).prompt),
      /最终剪入缺口时长约 1s/
    );
    assert.match(
      String(asRecord(longRevalidate.canvas_nodes[0]?.recommended_aigc_prompt).prompt),
      /冰红茶/
    );
    assert.equal(asRecordArray(longRevalidate.canvas_nodes[0]?.assigned_segments).length, 1);
    const longMissingNode = longRevalidate.canvas_session.nodes.find(
      (node) => node.node_type === "missing_material"
    );
    assert.equal(asRecord(longMissingNode?.data).prompt_ready, true);
    assert.equal(
      asRecord(asRecord(longMissingNode?.data).gap_display).title,
      "缺少必要素材，试试AI补齐吧！"
    );

    const promptNodeResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${longRevalidate.canvas_session_id}/prompt-nodes`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          slot_id: "slot_01",
          prompt_type: "video",
          prompt: "冰红茶冰块飞溅，镜头快速推近瓶身，补足清凉冲击。"
        })
      }
    );
    const promptNodeBody = (await promptNodeResponse.json()) as {
      prompt_node: Record<string, unknown>;
    };
    assert.equal(promptNodeResponse.status, 201);
    assert.equal(promptNodeBody.prompt_node.node_type, "video_prompt");

    const imagePromptNodeResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${longRevalidate.canvas_session_id}/prompt-nodes`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          slot_id: "slot_01",
          prompt_type: "image",
          prompt: "冰红茶瓶身、冰块和水珠的竖屏广告关键画面。"
        })
      }
    );
    assert.equal(imagePromptNodeResponse.status, 201);

    const imageCandidatesResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${longRevalidate.canvas_session_id}/image-candidates`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          slot_id: "slot_01",
          count: 4,
          use_image_provider: false,
          allow_fallback: true
        })
      }
    );
    const imageCandidatesBody = (await imageCandidatesResponse.json()) as {
      image_candidate_nodes: Array<Record<string, unknown>>;
    };
    assert.equal(imageCandidatesResponse.status, 201);
    assert.equal(imageCandidatesBody.image_candidate_nodes.length, 4);
    assert.equal(imageCandidatesBody.image_candidate_nodes[0]?.node_type, "image_candidate");

    const gapVideoResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${longRevalidate.canvas_session_id}/gap-video`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          slot_id: "slot_01",
          use_video_provider: false,
          allow_fallback: true
        })
      }
    );
    const gapVideoBody = (await gapVideoResponse.json()) as {
      generated_video_node: Record<string, unknown>;
      generation_result: Record<string, unknown>;
    };
    assert.equal(gapVideoResponse.status, 200);
    assert.equal(gapVideoBody.generated_video_node.node_type, "generated_video");
    assert.equal(gapVideoBody.generation_result.status, "mock_ready");
    assert.equal(asRecord(gapVideoBody.generated_video_node.data).target_duration_seconds, 1);
    assert.equal(asRecord(gapVideoBody.generated_video_node.data).missing_duration, 1);

    const reviewTrimResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${longRevalidate.canvas_session_id}/generated-videos/review-trim`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          generated_video_node_id: gapVideoBody.generated_video_node.node_id,
          video_uri: path.join(storageConfig.uploadDir, `${firstFileId}-sample.mp4`),
          target_duration_seconds: 0.5,
          use_multimodal_provider: false,
          allow_fallback: true
        })
      }
    );
    const reviewTrimBody = (await reviewTrimResponse.json()) as {
      generated_video_node: Record<string, unknown>;
      usable_video_uri: string;
    };
    assert.equal(reviewTrimResponse.status, 200);
    assert.match(reviewTrimBody.usable_video_uri, /^\/api\/v2\/generation\/trimmed-videos\//);
    assert.equal(asRecord(reviewTrimBody.generated_video_node.data).trim_status, "trimmed");

    const addMaterialResponse = await fetch(
      `${baseUrl}/api/v2/script-sessions/${created.session_id}/slots/slot_01/materials`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file_ids: [secondFileId]
        })
      }
    );
    assert.equal(addMaterialResponse.status, 201);

    const completedRevalidateResponse = await fetch(`${baseUrl}/api/v2/canvas/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: created.session_id,
        use_multimodal_provider: false
      })
    });
    const completedRevalidate = (await completedRevalidateResponse.json()) as {
      canvas_nodes: Array<Record<string, unknown>>;
      material_segments: Array<Record<string, unknown>>;
      canvas_session_id: string;
    };
    assert.equal(completedRevalidateResponse.status, 200);
    assert.equal(completedRevalidate.canvas_nodes[0]?.coverage_status, "fully_matched");
    assert.equal(completedRevalidate.material_segments.length, 2);
    assert.equal(asRecordArray(completedRevalidate.canvas_nodes[0]?.assigned_segments).length, 2);
    assert.deepEqual(
      new Set(
        asRecordArray(completedRevalidate.canvas_nodes[0]?.assigned_segments).map(
          (segment) => segment.file_id
        )
      ),
      new Set([firstFileId, secondFileId])
    );

    await fetch(`${baseUrl}/api/v2/script-sessions/${created.session_id}/slots/slot_01`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        required_duration: 2.4
      })
    });

    const tinyGapRevalidateResponse = await fetch(`${baseUrl}/api/v2/canvas/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: created.session_id,
        use_multimodal_provider: false
      })
    });
    const tinyGapRevalidate = (await tinyGapRevalidateResponse.json()) as {
      canvas_nodes: Array<Record<string, unknown>>;
      canvas_session: {
        nodes: Array<Record<string, unknown>>;
      };
    };
    assert.equal(tinyGapRevalidateResponse.status, 200);
    assert.equal(tinyGapRevalidate.canvas_nodes[0]?.coverage_status, "fully_matched");
    assert.equal(tinyGapRevalidate.canvas_nodes[0]?.missing_duration, 0);
    assert.equal(tinyGapRevalidate.canvas_nodes[0]?.ignored_missing_duration, 0.4);
    assert.equal(
      tinyGapRevalidate.canvas_session.nodes.some(
        (node) => node.node_type === "missing_material"
      ),
      false
    );

    await fetch(`${baseUrl}/api/v2/script-sessions/${created.session_id}/slots/slot_01`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        required_duration: 2
      })
    });

    const canvasAssemblyResponse = await fetch(
      `${baseUrl}/api/v2/canvas-sessions/${completedRevalidate.canvas_session_id}/final-video`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          target_duration_seconds: 2,
          resolution: "360x640",
          fps: 12
        })
      }
    );
    const canvasAssembly = (await canvasAssemblyResponse.json()) as {
      assembly_slots: Array<Record<string, unknown>>;
      final_assembly: Record<string, unknown>;
    };
    assert.equal(canvasAssemblyResponse.status, 200);
    assert.equal(canvasAssembly.assembly_slots.length, 2);
    assert.match(String(canvasAssembly.final_assembly.final_video_url), /^\/api\/v2\/assembly\/final-videos\//);
  }
);

test(
  "v2 canvas material allocation does not reuse overlapping source ranges across slots",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const fileId = createUploadedTestVideo(8);

    const createResponse = await fetch(`${baseUrl}/api/v2/script-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_request: {
          goal: "冰红茶宣传片",
          product_name: "冰红茶"
        },
        target_duration_seconds: 8,
        slots: [
          {
            slot_id: "slot_01",
            slot_type: "product_hero",
            duration_seconds: 4,
            shot_description: "倒入冰红茶的完整动作前半段。",
            materials: [
              {
                material_id: "same_clip_slot_01",
                file_id: fileId,
                uri: `/api/upload/files/${fileId}`,
                label: "same_clip.mp4"
              }
            ]
          },
          {
            slot_id: "slot_02",
            slot_type: "usage_process",
            duration_seconds: 4,
            shot_description: "继续使用冰红茶素材。",
            materials: [
              {
                material_id: "same_clip_slot_02",
                file_id: fileId,
                uri: `/api/upload/files/${fileId}`,
                label: "same_clip.mp4"
              }
            ]
          }
        ]
      })
    });
    const created = (await createResponse.json()) as { session_id: string };
    assert.equal(createResponse.status, 201);

    const revalidateResponse = await fetch(`${baseUrl}/api/v2/canvas/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: created.session_id,
        use_multimodal_provider: false
      })
    });
    const revalidated = (await revalidateResponse.json()) as {
      material_segments: Array<Record<string, unknown>>;
      material_coverage: {
        slot_coverage: Array<Record<string, unknown>>;
      };
    };
    assert.equal(revalidateResponse.status, 200);
    assert.equal(revalidated.material_segments.length, 2);
    assert.ok(
      revalidated.material_segments.every(
        (segment) => segment.segmentation_source === "coherent_whole_material_segment"
      )
    );

    const firstCoverage = asRecord(revalidated.material_coverage.slot_coverage[0]);
    const secondCoverage = asRecord(revalidated.material_coverage.slot_coverage[1]);
    assert.equal(firstCoverage.coverage_status, "covered");
    assert.equal(firstCoverage.matched_material_duration, 4);
    assert.equal(asRecordArray(firstCoverage.assigned_segments).length, 1);
    assert.equal(secondCoverage.coverage_status, "missing");
    assert.equal(secondCoverage.matched_material_duration, 0);
    assert.equal(asRecordArray(secondCoverage.assigned_segments).length, 0);
    assert.equal(secondCoverage.missing_duration, 4);
  }
);

test(
  "v2 script slot order is persisted before canvas revalidation",
  { skip: hasFFmpegAndFFprobe() ? false : "ffmpeg and ffprobe are required" },
  async () => {
    const hookFileId = createUploadedTestVideo(1);
    const ctaFileId = createUploadedTestVideo(1);

    const createResponse = await fetch(`${baseUrl}/api/v2/script-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        user_request: {
          goal: "6 秒冰红茶广告"
        },
        target_duration_seconds: 2,
        slots: [
          {
            slot_id: "slot_01",
            slot_type: "hook",
            duration_seconds: 1,
            shot_description: "开场冰块冲击。",
            materials: [
              {
                material_id: "hook_clip",
                file_id: hookFileId,
                uri: `/api/upload/files/${hookFileId}`
              }
            ]
          },
          {
            slot_id: "slot_02",
            slot_type: "cta",
            duration_seconds: 1,
            shot_description: "结尾饮用动作。",
            materials: [
              {
                material_id: "cta_clip",
                file_id: ctaFileId,
                uri: `/api/upload/files/${ctaFileId}`
              }
            ]
          }
        ]
      })
    });
    const created = (await createResponse.json()) as {
      session_id: string;
      slots: Array<Record<string, unknown>>;
    };
    assert.equal(createResponse.status, 201);
    assert.deepEqual(
      created.slots.map((slot) => slot.slot_id),
      ["slot_01", "slot_02"]
    );
    assert.deepEqual(
      created.slots.map((slot) => slot.display_order),
      [1, 2]
    );

    const reorderResponse = await fetch(
      `${baseUrl}/api/v2/script-sessions/${created.session_id}/slot-order`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          slot_ids: ["slot_02", "slot_01"]
        })
      }
    );
    const reordered = (await reorderResponse.json()) as {
      slots: Array<Record<string, unknown>>;
    };
    assert.equal(reorderResponse.status, 200);
    assert.deepEqual(
      reordered.slots.map((slot) => slot.slot_id),
      ["slot_02", "slot_01"]
    );
    assert.deepEqual(
      reordered.slots.map((slot) => slot.display_order),
      [1, 2]
    );

    const revalidateResponse = await fetch(`${baseUrl}/api/v2/canvas/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: created.session_id,
        extract_frames: false,
        use_multimodal_provider: false
      })
    });
    const revalidated = (await revalidateResponse.json()) as {
      script_slots: Array<Record<string, unknown>>;
      canvas_nodes: Array<Record<string, unknown>>;
      material_segments: Array<Record<string, unknown>>;
    };

    assert.equal(revalidateResponse.status, 200);
    assert.deepEqual(
      revalidated.script_slots.map((slot) => slot.slot_id),
      ["slot_02", "slot_01"]
    );
    assert.deepEqual(
      revalidated.canvas_nodes.map((node) => node.slot_id),
      ["slot_02", "slot_01"]
    );
    assert.equal(revalidated.material_segments[0]?.assigned_slot_id, "slot_02");
    assert.equal(revalidated.material_segments[0]?.script_order_index, 0);
    assert.equal(revalidated.material_segments[0]?.display_order, 1);
  }
);

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
        use_video_provider: false,
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
    const bgmAudioPath = createTestAudio(1);

    const result = await assembleV2FinalVideo({
      target_duration_seconds: 1,
      resolution: "360x640",
      fps: 24,
      generate_bgm: true,
      bgm_prompt: "清爽夏日冰红茶广告背景音乐，无人声主唱。",
      bgm_audio_uri: bgmAudioPath,
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
    assert.equal(asRecord(result.audio_policy).source_clip_audio, "muted");
    assert.equal(asRecord(result.audio_policy).per_clip_bgm, "disabled");
    const finalBgm = asRecord(asRecord(result.audio_policy).final_bgm);
    const bgmProviderResult = asRecord(finalBgm.provider_result);
    assert.equal(finalBgm.status, "mixed");
    assert.equal(finalBgm.prompt, "清爽夏日冰红茶广告背景音乐，无人声主唱。");
    assert.equal(finalBgm.audio_stream_present, true);
    assert.equal(bgmProviderResult.status, "provided");
    assert.equal(asRecord(bgmProviderResult.source).type, "provided_audio");
    assert.equal(bgmProviderResult.audio_path, bgmAudioPath);
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
