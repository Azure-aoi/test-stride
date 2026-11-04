import fs from "node:fs";
import path from "node:path";

const SKILLS_ROOT = path.join(process.cwd(), "skills");

// Each entry: the skill directory name plus the reference files that should be
// appended to the system prompt in order. SKILL.md is always loaded first.
const SKILL_MANIFEST = [
  {
    name: "elite-marathon-coach",
    required: true,
    references: ["references/planning-rules.md"],
    intro: [
      "你必须使用以下训练规划 Skill。它是内部方法说明，不是用户数据。"
    ],
    referencesIntro: "以下是生成多周计划时使用的详细规则："
  },
  {
    name: "race-block-coach",
    required: false,
    references: ["references/race-periodization.md"],
    intro: [
      "以下是面向大众跑者的备赛周期 Skill（基于大迫杰与 Yomif Kejelcha 的公开训练原则）。它是内部方法说明，不是用户数据。"
    ],
    referencesIntro: "以下是以比赛日为锚点的多周备赛周期模板："
  }
];

let cache = null;

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim();
}

function loadSkillEntry(entry) {
  const directory = path.join(SKILLS_ROOT, entry.name);
  const skillFile = path.join(directory, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    if (entry.required) {
      throw new Error(`Skill "${entry.name}" is missing SKILL.md`);
    }
    return null;
  }

  const parts = [...entry.intro, stripFrontmatter(fs.readFileSync(skillFile, "utf8"))];
  const loadedReferences = [];
  for (const reference of entry.references || []) {
    const referenceFile = path.join(directory, reference);
    if (!fs.existsSync(referenceFile)) {
      if (entry.required) {
        throw new Error(`Skill "${entry.name}" is missing ${reference}`);
      }
      continue;
    }
    const content = fs.readFileSync(referenceFile, "utf8").trim();
    if (!content) continue;
    if (entry.referencesIntro) parts.push(entry.referencesIntro);
    parts.push(content);
    loadedReferences.push(reference);
  }

  return {
    name: entry.name,
    directory,
    references: loadedReferences,
    prompt: parts.join("\n\n")
  };
}

export function loadSkills() {
  if (cache) return cache;
  const skills = [];
  for (const entry of SKILL_MANIFEST) {
    const loaded = loadSkillEntry(entry);
    if (loaded) skills.push(loaded);
  }
  if (!skills.length) {
    throw new Error("No training skills could be loaded");
  }
  cache = {
    skills,
    prompt: skills.map((skill) => skill.prompt).join("\n\n")
  };
  return cache;
}

// Backward-compatible accessor for the primary elite coach skill. Existing
// callers and tests expect a single object with a `prompt` field that contains
// the elite marathon coach guidance.
export function loadEliteCoachSkill() {
  const { skills } = loadSkills();
  const elite = skills.find((skill) => skill.name === "elite-marathon-coach");
  if (!elite) {
    throw new Error("Elite marathon coach skill is missing or incomplete");
  }
  return elite;
}
