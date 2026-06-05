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
  normalizeV2TargetDurationSeconds
} from "../src/services/v2PipelineService.js";
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
    assert.equal(coverage.slot_coverage[1]?.matched_material_duration, 2);
    assert.equal(
      asRecordArray(coverage.slot_coverage[1]?.candidate_materials)[0]?.material_id,
      "user_material_01"
    );
    assert.equal(coverage.slot_coverage[1]?.gap_reason, "已匹配 2s，但该槽位需要 3s。");
    assert.deepEqual(coverage.slot_coverage[1]?.available_user_actions, [
      "accept_current_material_as_sufficient",
      "generate_ai_for_missing_duration"
    ]);
    assert.equal(coverage.slot_coverage[1]?.ai_completion_required_duration, 1);

    assert.equal(coverage.slot_coverage[2]?.slot_type, "cta");
    assert.equal(coverage.slot_coverage[2]?.coverage_status, "missing");
    assert.equal(coverage.slot_coverage[2]?.frontend_coverage_status, "material_insufficient");
    assert.deepEqual(coverage.slot_coverage[2]?.available_user_actions, [
      "generate_ai_for_missing_material"
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
