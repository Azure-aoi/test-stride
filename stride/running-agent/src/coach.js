import { formatPace } from "./metrics.js";
import { loadSkills } from "./skill-loader.js";
import {
  formatSevenDayPlan,
  generateSevenDayPlan
} from "./training-plan.js";

export function buildSystemPrompt() {
  const skills = loadSkills();
  return [
    "你是一个谨慎、具体的跑步训练分析助手。",
    "只能使用提供的结构化数据，不要编造没有出现的训练记录或身体指标。",
    "所有距离、配速、心率等基础数值都已由服务端计算，不要重新猜测。",
    "输出中文纯文本，分段清晰，不使用 Markdown 表格。",
    "建议要可执行，但不要提供医疗诊断、伤病治疗或用药建议。",
    "如果数据不足，明确说明缺少什么。",
    "生成训练计划时优先使用技能中的证据边界、决策顺序和输出格式。",
    "训练计划只能根据最近跑量、距离比赛天数、可训练日、伤病限制和用户明确偏好决定。禁止根据平均心率、心率区间或“心率偏高”标签选择模板、取消强度或减少强度次数。",
    "距离比赛超过 30 天时，每周至少安排两次可控的速度或节奏刺激；距离比赛 30 天以内时，减少短间歇，增加比赛配速跑和专项长距离。",
    "历史心率只用于建立个人心率档案和训练过程建议。强度课中可以建议跑者根据实时感觉降组、减速或停止，但不得因此提前删除计划中的强度课。",
    skills.prompt
  ].join("\n");
}

export function localCoachAnalysis({
  dashboard,
  activities,
  question,
  analysisNote = null,
  plan = null,
  constraints = null,
  memories = [],
  knowledge = [],
  heartRateProfile = null
}) {
  const current = dashboard.current;
  if (!current.runCount) {
    return "目前没有可用于分析的跑步记录。请先上传 CSV、GPX 或 TCX 文件，再提问训练趋势。";
  }

  const paceDelta = dashboard.changes.pacePct;
  const distanceDelta = dashboard.changes.distancePct;
  const paceText = formatPace(current.avgPaceSecPerKm);
  const changeSentence =
    paceDelta === null
      ? "上一周期数据不足，暂时无法判断配速变化。"
      : paceDelta < 0
        ? `平均配速较上一周期提升约 ${Math.abs(paceDelta)}%。`
        : paceDelta > 0
          ? `平均配速较上一周期慢约 ${paceDelta}%，可能以有氧积累为主。`
          : "平均配速与上一周期基本持平。";
  const volumeSentence =
    distanceDelta === null
      ? "跑量对比数据不足。"
      : distanceDelta > 20
        ? `跑量增长 ${distanceDelta}%，增幅较快，下一次应避免继续加量。`
        : distanceDelta < -20
          ? `跑量下降 ${Math.abs(distanceDelta)}%，适合把下一次训练控制在轻松区间。`
          : "跑量变化处于温和区间。";
  const windowLabel = analysisNote ? "所选历史 28 天窗口" : `最近 ${dashboard.days} 天`;

  const nextSession =
    constraints?.injuryLimited
      ? "优先遵守伤病限制，具体课程按本周计划执行；出现持续疼痛时停止当次训练。"
      : "按本周训练计划执行强度课。课中根据主观用力程度调整，心率只作为过程参考。";

  const sections = [
    `当前状态：${windowLabel}共跑 ${current.runCount} 次、${current.distanceKm} 公里，平均配速 ${paceText}/km，平均心率 ${current.avgHeartRate || "--"} bpm。训练节奏判断为“${dashboard.readiness.label}”。`,
    `${analysisNote ? `${analysisNote}\n\n` : ""}数据依据：${changeSentence}${volumeSentence}`,
    `下一次训练：${nextSession}`,
    "注意事项：这是基于训练记录的参考建议，不是医疗意见。如果出现持续疼痛、胸闷或眩晕，应停止训练并咨询专业人士。"
  ];
  if (heartRateProfile?.sampleCount) {
    const range =
      heartRateProfile.typicalLowBpm && heartRateProfile.typicalHighBpm
        ? `，个人常见区间约 ${heartRateProfile.typicalLowBpm}–${heartRateProfile.typicalHighBpm} bpm`
        : "";
    sections.push(
      `个人心率档案：基于最近 ${
        heartRateProfile.sampleCount
      } 次跑步，中位数 ${
        heartRateProfile.medianBpm || "--"
      } bpm${range}。${heartRateProfile.guidance || ""}`
    );
  }
  const constraintText = (constraints?.constraintLines || []).filter(Boolean);
  if (constraintText.length) {
    sections.push(`跑者约束：${constraintText.join("；")}。`);
  }
  if (
    memories?.length &&
    /记得|偏好|习惯|以前|根据我|目标|伤病|没空|时间/.test(question || "")
  ) {
    sections.push(
      `长期记忆：${memories
        .slice(0, 2)
        .map((item) => item.content)
        .join("；")}。`
    );
  }
  if (
    knowledge?.length &&
    /为什么|原则|如何|怎么|方法|恢复|减量|周期|节奏|间歇/.test(question || "")
  ) {
    const principle = String(knowledge[0]?.content || "")
      .replace(/\s+/g, " ")
      .slice(0, 160);
    if (principle) sections.push(`训练原则参考：${principle}`);
  }
  if (/计划|课表|安排|下周|本周|未来七天|接下来|准备|怎么练|如何练|训练建议/.test(question || "")) {
    sections.push(
      formatSevenDayPlan(
        plan ||
          generateSevenDayPlan(dashboard, {
            constraints,
            heartRateProfile
          })
      )
    );
  }
  return sections.join("\n\n");
}
