import type {
  SampleAnalysis,
  UploadedVideoFile,
  V2CanvasFinalVideoResult,
  V2MaterialCoverageSlot,
  V2PipelineResult
} from "../types";
import type {
  V2CanvasRevalidateResult,
  V2CanvasSession,
  V2ScriptSession
} from "../api/client";

export type MockVideoAnalysisState =
  | "empty"
  | "loading"
  | "matched"
  | "missing_material"
  | "duration_insufficient"
  | "error";

export const mockVideoAnalysisStates: Record<
  MockVideoAnalysisState,
  {
    label: string;
    tone: "neutral" | "green" | "red" | "yellow";
    message: string;
  }
> = {
  empty: {
    label: "等待上传",
    tone: "neutral",
    message: "上传参考视频和真实素材后即可预览结构迁移结果。"
  },
  loading: {
    label: "正在解析",
    tone: "neutral",
    message: "正在拆解样例结构、匹配素材并生成迁移草案。"
  },
  matched: {
    label: "已完全匹配",
    tone: "green",
    message: "结构槽位已经找到可用素材和关键帧。"
  },
  missing_material: {
    label: "缺少素材",
    tone: "red",
    message: "当前素材无法覆盖该镜头，需要补拍或 AI 补全。"
  },
  duration_insufficient: {
    label: "时长不足",
    tone: "yellow",
    message: "结构完整但可用素材时长不够，需要补足节奏。"
  },
  error: {
    label: "接口失败",
    tone: "red",
    message: "分析接口暂时不可用，请稍后重试。"
  }
};

const keyframes = [
  "https://www.figma.com/api/mcp/asset/7a9bb822-f69c-4344-9da9-27ec440b9d2e",
  "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1400&q=85",
  "https://www.figma.com/api/mcp/asset/45d15bc2-c541-433f-9c4c-2a1db76e627d",
  "https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&w=1400&q=85",
  "https://www.figma.com/api/mcp/asset/27f882c5-4b54-4e3e-b9b7-811c7dfe6429",
  "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=1400&q=85"
];

const sampleFile = (file: File | undefined, index: number): UploadedVideoFile => ({
  file_id: `mock_sample_${index + 1}`,
  filename: file?.name ?? `mock-reference-${index + 1}.mp4`,
  original_filename: file?.name ?? `参考样例 ${index + 1}.mp4`,
  path: keyframes[index % keyframes.length],
  mime_type: file?.type || "video/mp4",
  size: file?.size ?? 2480000
});

const materialFile = (file: File | undefined, index: number): UploadedVideoFile => ({
  file_id: `mock_material_${index + 1}`,
  filename: file?.name ?? `mock-material-${index + 1}.mp4`,
  original_filename: file?.name ?? `真实素材 ${index + 1}.mp4`,
  path: keyframes[(index + 1) % keyframes.length],
  mime_type: file?.type || "video/mp4",
  size: file?.size ?? 1860000
});

const slotCoverage: V2MaterialCoverageSlot[] = [
  {
    slot_id: "slot_01",
    slot_type: "risk_or_pain_hook",
    slot_name: "开头风险 Hook",
    visual_goal: "用强对比画面快速抓住用户注意力",
    copy_direction: "别急着照抄爆款结构，先看素材能不能撑住前三秒。",
    required_duration: 3,
    matched_material_duration: 3.2,
    missing_duration: 0,
    coverage_status: "covered",
    frontend_coverage_status: "fully_matched",
    frontend_coverage_label: "已完全匹配",
    frontend_display: {
      migration_result_title: "Hook",
      migration_result_description: "从用户上传素材中截取产品特写和使用前后对比，承接样例前三秒节奏。",
      duration_text: "0-3s",
      shot_description: "产品特写 + 风险提示标题",
      material_summary: "已匹配：产品包装特写、手持展示、标题留白关键帧",
      copy: "新手别直接抄爆款，先看素材缺口。"
    },
    assigned_materials: [
      {
        material_id: "mat_product_closeup",
        label: "产品包装特写",
        matched_material_duration: 3.2
      }
    ],
    direct_video_reference_materials: [
      {
        material_id: "mat_product_closeup",
        label: "关键帧 0.8s",
        uri: keyframes[0],
        duration_seconds: 3.2,
        frame_sample_timestamps_seconds: [0.2, 0.8, 1.6]
      }
    ]
  },
  {
    slot_id: "slot_02",
    slot_type: "pain_desire",
    slot_name: "需求痛点",
    visual_goal: "展示用户真实使用场景，解释为什么需要换结构",
    copy_direction: "素材要能说明场景、痛点和目标用户。",
    required_duration: 4,
    matched_material_duration: 0,
    missing_duration: 4,
    coverage_status: "missing",
    frontend_coverage_status: "material_insufficient",
    frontend_coverage_label: "匹配不到 / 缺素材",
    frontend_display: {
      migration_result_title: "痛点场景",
      migration_result_description: "样例需要真实使用场景，但当前只上传了静态产品素材。",
      duration_text: "3-7s",
      shot_description: "用户拿起产品并进入使用场景",
      material_summary: "缺失占位：需要使用场景、人物动作或环境交代",
      material_status: "缺少使用场景素材",
      copy: "没有场景，观众很难理解为什么要点进来。"
    },
    gap_reason: "缺少人物使用场景和环境镜头",
    available_user_actions: ["补充使用场景", "补充人物动作", "使用 AI 生成补全"],
    available_generation_paths: ["generate_image_then_video", "direct_video_from_material_frame"],
    recommended_aigc_prompt: {
      prompt_ref: "slot_02_image_prompt",
      prompt_source: "mock",
      prompt_description: "生成一个用户在桌面场景中拿起产品、准备使用的关键帧。",
      prompt: "竖屏短视频关键帧，明亮自然光，用户在桌面场景中拿起产品，画面留出标题空间。"
    },
    recommended_video_prompt: {
      prompt_ref: "slot_02_video_prompt",
      prompt_source: "mock",
      prompt_description: "补全 4 秒使用场景过渡镜头。",
      prompt: "生成一段 4 秒竖屏使用场景镜头，用户从桌面拿起产品，动作自然，节奏轻快。"
    }
  },
  {
    slot_id: "slot_03",
    slot_type: "product_reveal",
    slot_name: "产品露出",
    visual_goal: "展示产品卖点和包装信息",
    copy_direction: "把卖点压缩成可扫读字幕。",
    required_duration: 5,
    matched_material_duration: 2.6,
    missing_duration: 2.4,
    coverage_status: "partial",
    frontend_coverage_status: "structure_complete_duration_short",
    frontend_coverage_label: "结构完整但时长不够",
    frontend_display: {
      migration_result_title: "产品卖点",
      migration_result_description: "已有产品露出素材，但可用片段只有 2.6 秒，低于目标结构所需 5 秒。",
      duration_text: "7-12s",
      shot_description: "产品旋转展示 + 卖点字幕",
      material_summary: "当前可用 2.6s，目标 5s，差值 2.4s",
      material_status: "时长不足",
      copy: "核心卖点需要更完整的展示时间。"
    },
    gap_reason: "结构完整但产品展示时长不足 2.4 秒",
    available_user_actions: ["补拍素材", "放慢节奏", "AI 补全过渡镜头", "压缩原结构"],
    ai_completion_required_duration: 2.4,
    needs_ai_completion: true,
    assigned_materials: [
      {
        material_id: "mat_reveal_short",
        label: "产品露出短片段",
        matched_material_duration: 2.6
      }
    ],
    direct_video_reference_materials: [
      {
        material_id: "mat_reveal_short",
        label: "产品关键帧",
        uri: keyframes[2],
        duration_seconds: 2.6,
        frame_sample_timestamps_seconds: [0.3, 1.1, 2.2]
      }
    ],
    recommended_video_prompt: {
      prompt_ref: "slot_03_video_prompt",
      prompt_source: "mock",
      prompt_description: "沿用产品特写关键帧，补全慢速推近和转场。",
      prompt: "基于产品特写关键帧生成 2.4 秒过渡镜头，慢速推近，字幕留白，保持原素材光线。"
    }
  },
  {
    slot_id: "slot_04",
    slot_type: "proof_comparison",
    slot_name: "对比证明",
    visual_goal: "用横向对比让推荐理由更直观",
    copy_direction: "一屏讲清楚为什么选这个方案。",
    required_duration: 4,
    matched_material_duration: 4.1,
    missing_duration: 0,
    coverage_status: "covered",
    frontend_coverage_status: "fully_matched",
    frontend_coverage_label: "已完全匹配",
    frontend_display: {
      migration_result_title: "对比卡片",
      migration_result_description: "已匹配对比表素材，可直接迁移样例证明段落。",
      duration_text: "12-16s",
      shot_description: "卖点对比表 + 产品局部",
      material_summary: "已匹配：对比卡片、产品局部、标题字幕",
      copy: "对比之后，观众才知道为什么值得换。"
    },
    assigned_materials: [
      {
        material_id: "mat_compare_card",
        label: "卖点对比卡片",
        matched_material_duration: 4.1
      }
    ],
    direct_video_reference_materials: [
      {
        material_id: "mat_compare_card",
        label: "对比关键帧",
        uri: keyframes[3],
        duration_seconds: 4.1,
        frame_sample_timestamps_seconds: [0.5, 1.4, 3.2]
      }
    ]
  },
  {
    slot_id: "slot_05",
    slot_type: "decision_warning",
    slot_name: "避坑提醒",
    visual_goal: "加入明确的决策提醒，降低盲目跟风",
    copy_direction: "用红色提醒条强化风险。",
    required_duration: 3,
    matched_material_duration: 0,
    missing_duration: 3,
    coverage_status: "missing",
    frontend_coverage_status: "material_insufficient",
    frontend_coverage_label: "匹配不到 / 缺素材",
    frontend_display: {
      migration_result_title: "避坑提醒",
      migration_result_description: "缺少失败案例或反面示例镜头，需要占位卡片提示补充。",
      duration_text: "16-19s",
      shot_description: "错误做法示例 + 警示字幕",
      material_summary: "缺失占位：需要反面示例、错误使用场景或警示画面",
      material_status: "缺少反面示例素材",
      copy: "不是所有爆款结构都适合你的素材。"
    },
    gap_reason: "缺少错误示例 / 避坑画面",
    available_user_actions: ["补充错误示例", "补充产品特写", "使用 AI 生成补全"],
    recommended_aigc_prompt: {
      prompt_ref: "slot_05_image_prompt",
      prompt_source: "mock",
      prompt_description: "生成一张有警示感的错误示例占位关键帧。",
      prompt: "竖屏短视频警示关键帧，红色提示条，错误做法被清楚标注，产品保持真实质感。"
    },
    recommended_video_prompt: {
      prompt_ref: "slot_05_video_prompt",
      prompt_source: "mock",
      prompt_description: "补全 3 秒避坑提醒镜头。",
      prompt: "生成 3 秒避坑提醒镜头，红色字幕条出现，画面展示错误示例与正确选择的对比。"
    }
  },
  {
    slot_id: "slot_06",
    slot_type: "cta",
    slot_name: "行动引导",
    visual_goal: "收束内容并引导用户继续互动",
    copy_direction: "给出清晰行动指令。",
    required_duration: 3,
    matched_material_duration: 3,
    missing_duration: 0,
    coverage_status: "covered",
    frontend_coverage_status: "fully_matched",
    frontend_coverage_label: "已完全匹配",
    frontend_display: {
      migration_result_title: "CTA",
      migration_result_description: "结尾素材可复用，叠加评论区引导即可完成结构。",
      duration_text: "19-22s",
      shot_description: "产品收尾 + 评论引导",
      material_summary: "已匹配：产品收尾、手持展示、评论引导留白",
      copy: "把你的素材发来，我帮你看缺哪一段。"
    },
    assigned_materials: [
      {
        material_id: "mat_cta",
        label: "结尾产品展示",
        matched_material_duration: 3
      }
    ],
    direct_video_reference_materials: [
      {
        material_id: "mat_cta",
        label: "CTA 关键帧",
        uri: keyframes[4],
        duration_seconds: 3,
        frame_sample_timestamps_seconds: [0.3, 1.2, 2.6]
      }
    ]
  }
];

export const mockSampleAnalysis: SampleAnalysis = {
  id: "mock_sample_analysis",
  video: {
    duration_seconds: 22,
    width: 720,
    height: 1280,
    resolution: "720x1280",
    aspect_ratio: "9:16",
    fps: 30,
    codec: "h264",
    format: "mp4",
    cover_frame: {
      uri: keyframes[0],
      mime_type: "image/jpeg",
      width: 720,
      height: 1280
    }
  },
  shot_count: 6,
  keyframes: keyframes.map((uri, index) => ({
    frame_id: `mock_keyframe_${index + 1}`,
    time_seconds: index * 3 + 0.8,
    media: {
      uri,
      mime_type: "image/jpeg",
      width: 720,
      height: 1280
    }
  })),
  shots: slotCoverage.map((slot, index) => ({
    shot_id: `mock_shot_${index + 1}`,
    time_range: {
      start_seconds: index * 3,
      end_seconds: index * 3 + slot.required_duration,
      relative_start_percent: Math.round((index / slotCoverage.length) * 100),
      relative_end_percent: Math.round(((index + 1) / slotCoverage.length) * 100)
    },
    keyframe_refs: [`mock_keyframe_${index + 1}`],
    visual_tags: [slot.slot_type],
    description: slot.frontend_display?.shot_description ?? slot.visual_goal ?? slot.slot_name ?? "",
    confidence: 0.9
  }))
};

export const mockV2PipelineResult: V2PipelineResult = {
  id: "mock_v2_pipeline",
  version: "2.0.0",
  created_at: "2026-06-10T00:00:00.000Z",
  source: {
    type: "api_first_v2",
    multimodal_provider: "mock",
    image_provider: "mock",
    video_provider: "mock",
    fallback_used: false
  },
  input: {
    reference_video_count: 1,
    user_material_count: 3,
    text_asset_count: 1
  },
  stages: {
    reference_video_analyses: [],
    reference_analysis_tables: [
      {
        sample_index: 0,
        file_id: "mock_sample_1",
        source_label: "Mock 样例视频",
        rows: slotCoverage.map((slot, index) => ({
          row_id: `mock_row_${index + 1}`,
          duration: slot.frontend_display?.duration_text,
          sample_video: {
            frame_id: `mock_keyframe_${index + 1}`,
            time_seconds: index * 3 + 0.8,
            media: {
              uri: keyframes[index % keyframes.length],
              mime_type: "image/jpeg"
            }
          },
          shot_description: {
            title: slot.slot_name,
            description: slot.frontend_display?.shot_description
          },
          migration_possibility: slot.frontend_display?.migration_result_description
        }))
      }
    ],
    user_material_analysis: {
      status: "mock_ready"
    },
    fillable_architecture: {
      status: "mock_ready"
    },
    material_coverage: {
      materials_sufficient: false,
      requires_ai_completion: true,
      target_duration_seconds: 22,
      total_known_material_duration_seconds: 15.5,
      material_assets: [],
      slot_coverage: slotCoverage
    },
    production_plan: {
      status: "mock_ready"
    },
    image_candidates: []
  },
  summary: {
    status: "completed",
    needs_user_image_approval: true,
    can_generate_video_directly: false,
    target_duration_seconds: 22,
    notes: "Mock result covers matched, missing material, and duration-insufficient states."
  }
};

export const mockScriptSession: V2ScriptSession = {
  session_id: "mock_script_session",
  created_at: "2026-06-10T00:00:00.000Z",
  updated_at: "2026-06-10T00:00:00.000Z",
  source_pipeline_id: mockV2PipelineResult.id,
  target_duration_seconds: 22,
  user_request: {
    goal: "基于爆款结构迁移一条产品短视频"
  },
  slots: slotCoverage.map((slot, index) => ({
    slot_id: slot.slot_id,
    slot_type: slot.slot_type,
    slot_name: slot.slot_name,
    display_order: index + 1,
    required_duration: slot.required_duration,
    shot_description: slot.frontend_display?.shot_description ?? slot.visual_goal ?? "",
    voiceover_text: slot.frontend_display?.copy,
    copy: slot.frontend_display?.copy,
    material_folder_id: `${slot.slot_id}_materials`,
    editable_fields: ["required_duration", "voiceover_text", "material_ref"],
    locked_fields: ["shot_description", "visual", "packaging", "migration_result"],
    materials:
      slot.assigned_materials?.map((material) => ({
        material_id:
          material.material_id ??
          material.source_material_id ??
          material.file_id ??
          `${slot.slot_id}_material`,
        uri: slot.direct_video_reference_materials?.[0]?.uri ?? keyframes[index % keyframes.length],
        label: material.label,
        role: "user_material" as const,
        assigned_at: "2026-06-10T00:00:00.000Z"
      })) ?? []
  }))
};

export const mockCanvasSession: V2CanvasSession = {
  canvas_session_id: "mock_canvas_session",
  script_session_id: mockScriptSession.session_id,
  created_at: "2026-06-10T00:00:00.000Z",
  updated_at: "2026-06-10T00:00:00.000Z",
  target_duration_seconds: 22,
  nodes: slotCoverage.map((slot, index) => ({
    node_id: `${slot.slot_id}_slot`,
    node_type: "script_slot",
    slot_id: slot.slot_id,
    display_order: index + 1,
    data: {
      coverage_status: slot.frontend_coverage_status
    }
  })),
  edges: slotCoverage.slice(0, -1).map((slot, index) => ({
    edge_id: `${slot.slot_id}_to_${slotCoverage[index + 1].slot_id}`,
    source_node_id: `${slot.slot_id}_slot`,
    target_node_id: `${slotCoverage[index + 1].slot_id}_slot`,
    edge_type: "sequence",
    data: {}
  })),
  source: {
    type: "mock"
  }
};

export const mockCanvasRevalidateResult: V2CanvasRevalidateResult = {
  session_id: mockScriptSession.session_id,
  target_duration_seconds: 22,
  script_slots: mockScriptSession.slots,
  material_coverage: {
    materials_sufficient: false,
    requires_ai_completion: true,
    target_duration_seconds: 22,
    total_known_material_duration_seconds: 15.5,
    material_assets: [],
    slot_coverage: slotCoverage
  },
  canvas_session: mockCanvasSession,
  canvas_session_id: mockCanvasSession.canvas_session_id,
  cover_plan: {
    cover_title: "爆款结构迁移预览",
    cover_subtitle: "mock 数据完整覆盖 UI 状态",
    visual_direction: "使用匹配关键帧作为封面候选。"
  }
};

export const mockFinalVideoResult: V2CanvasFinalVideoResult = {
  canvas_session: mockCanvasSession,
  assembly_slots: slotCoverage.map((slot, index) => ({
    slot_id: slot.slot_id,
    slot_type: slot.slot_type,
    video_uri: slot.direct_video_reference_materials?.[0]?.uri ?? keyframes[index % keyframes.length],
    thumbnail_url: slot.direct_video_reference_materials?.[0]?.uri ?? keyframes[index % keyframes.length],
    duration_seconds: slot.required_duration,
    start_seconds: 0
  })),
  cover_plan: mockCanvasRevalidateResult.cover_plan,
  final_assembly: {
    assembly_id: "mock_final_assembly",
    final_duration_seconds: 22,
    target_duration_seconds: 22,
    planned_duration_seconds: 22,
    resolution: "720x1280",
    fps: 30,
    slots: slotCoverage.map((slot, index) => ({
      slot_id: slot.slot_id,
      slot_type: slot.slot_type,
      thumbnail_url: slot.direct_video_reference_materials?.[0]?.uri ?? keyframes[index % keyframes.length],
      duration_seconds: slot.required_duration,
      start_seconds: 0
    }))
  }
};

export const createMockWorkflowResult = ({
  materialFiles,
  sampleFiles
}: {
  materialFiles: File[];
  sampleFiles: File[];
}) => {
  const samples = sampleFiles.length > 0 ? sampleFiles.map(sampleFile) : [sampleFile(undefined, 0)];
  const materials =
    materialFiles.length > 0
      ? materialFiles.map(materialFile)
      : [materialFile(undefined, 0), materialFile(undefined, 1), materialFile(undefined, 2)];

  return {
    materialFiles: materials,
    sampleAnalysis: mockSampleAnalysis,
    sampleFile: samples[0],
    sampleFiles: samples,
    scriptSession: mockScriptSession,
    v2PipelineResult: mockV2PipelineResult
  };
};

export const mockImageCandidates = [
  "https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=1000&q=80",
  "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=1000&q=80",
  "https://images.unsplash.com/photo-1512496015851-a90fb38ba796?auto=format&fit=crop&w=1000&q=80",
  "https://images.unsplash.com/photo-1512207128881-1baee87126fb?auto=format&fit=crop&w=1000&q=80"
];
