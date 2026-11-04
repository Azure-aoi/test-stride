import fs from "node:fs";
import path from "node:path";

const knowledgeFiles = [
  "skills/elite-marathon-coach/SKILL.md",
  "skills/elite-marathon-coach/references/planning-rules.md",
  "skills/elite-marathon-coach/references/evidence.md",
  "skills/race-block-coach/SKILL.md",
  "skills/race-block-coach/references/race-periodization.md",
  "skills/race-block-coach/references/evidence.md"
];

const VECTOR_SIZE = 384;
let chunks = null;

function terms(text) {
  const compact = String(text || "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9]/g, "");
  const words = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g) || [];
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    const pair = compact.slice(index, index + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(pair)) grams.push(pair);
  }
  return [...new Set([...words, ...grams])].slice(0, 80);
}

function hashTerm(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function vectorFor(terms) {
  const vector = new Float32Array(VECTOR_SIZE);
  for (const term of terms) {
    const hash = hashTerm(term);
    const index = hash % VECTOR_SIZE;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(term.length, 6) * 0.1);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }
  return vector;
}

function cosine(a, b) {
  let score = 0;
  for (let index = 0; index < VECTOR_SIZE; index += 1) {
    score += a[index] * b[index];
  }
  return score;
}

function loadChunks() {
  if (chunks) return chunks;
  chunks = [];
  for (const relative of knowledgeFiles) {
    const file = path.join(process.cwd(), relative);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const sections = text.split(/\n(?=#{1,4}\s)/);
    for (const section of sections) {
      const clean = section.replace(/\s+/g, " ").trim();
      if (clean.length < 40) continue;
      for (let offset = 0; offset < clean.length; offset += 700) {
        const content = clean.slice(offset, offset + 900);
        const chunkTerms = terms(content);
        chunks.push({
          source: relative,
          heading: (section.match(/^#{1,4}\s+(.+)/) || [])[1] || relative,
          content,
          terms: chunkTerms,
          vector: vectorFor(chunkTerms)
        });
      }
    }
  }
  return chunks;
}

export function searchTrainingKnowledge(query, limit = 4) {
  const queryTerms = terms(query);
  const querySet = new Set(queryTerms);
  const queryVector = vectorFor(queryTerms);
  return loadChunks()
    .map((chunk) => {
      const overlap = chunk.terms.reduce(
        (score, term) => score + (querySet.has(term) ? 1 : 0),
        0
      );
      const lexicalScore =
        overlap / Math.max(1, Math.min(queryTerms.length, chunk.terms.length));
      const vectorScore = Math.max(0, cosine(queryVector, chunk.vector));
      const score = lexicalScore * 0.6 + vectorScore * 0.4;
      return {
        source: chunk.source,
        heading: chunk.heading,
        content: chunk.content,
        score: Number(score.toFixed(4)),
        lexicalScore: Number(lexicalScore.toFixed(4)),
        vectorScore: Number(vectorScore.toFixed(4))
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
