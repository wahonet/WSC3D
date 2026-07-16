/**
 * 知识库持久化层。
 *
 * 五个 JSON 文件落在 `data/knowledge/`（入库，视作研究数据）：
 *   categories.json / concepts.json / terms.json / sources.json / segments.json / relations.json
 * 沿用 IIML 服务的可靠性策略：
 * - ajv 2020 文件级 schema 校验（写入前）
 * - 写入前备份到 `.history/{name}/{ISO_TS}.json`，每文件保留最近 20 份
 * - JSON 缩进 2 空格 + 末尾换行，git diff 友好
 * - 引用完整性在 CRUD 入口检查（conceptId / sourceId / segmentId 必须存在）
 */

import * as Ajv2020Module from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  KB_RELATION_KINDS,
  newKbId,
  nowIso,
  type KbCategory,
  type KbConcept,
  type KbData,
  type KbMention,
  type KbRelation,
  type KbSegment,
  type KbSource,
  type KbTerm
} from "./kb-types.js";

type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown };
const Ajv2020 = (Ajv2020Module as unknown as {
  default: new (options: { allErrors: boolean }) => {
    compile: (schema: AnySchema) => ValidateFn;
    errorsText: (errors: unknown) => string;
  };
}).default;
const ajv = new Ajv2020({ allErrors: true });

const HISTORY_LIMIT = 20;

export function kbDir(projectRoot: string): string {
  return path.join(projectRoot, "data", "knowledge");
}

// ---------- 文件级 schema ----------

const idString = { type: "string", minLength: 1 } as const;

const fileSchemas: Record<string, AnySchema> = {
  categories: {
    type: "object",
    required: ["categories"],
    additionalProperties: true,
    properties: {
      categories: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name"],
          additionalProperties: true,
          properties: { id: idString, name: idString, parentId: { type: "string", nullable: true } }
        }
      }
    }
  },
  concepts: {
    type: "object",
    required: ["concepts"],
    additionalProperties: true,
    properties: {
      concepts: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label", "categoryId", "conceptType"],
          additionalProperties: true,
          properties: {
            id: idString,
            label: idString,
            categoryId: idString,
            conceptType: { type: "string", enum: ["entity", "theme_or_story", "behavior", "relation", "attribute", "other"] }
          }
        }
      }
    }
  },
  terms: {
    type: "object",
    required: ["terms"],
    additionalProperties: true,
    properties: {
      terms: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "form", "conceptId"],
          additionalProperties: true,
          properties: { id: idString, form: idString, conceptId: idString }
        }
      }
    }
  },
  sources: {
    type: "object",
    required: ["sources"],
    additionalProperties: true,
    properties: {
      sources: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "title"],
          additionalProperties: true,
          properties: { id: idString, title: idString }
        }
      }
    }
  },
  segments: {
    type: "object",
    required: ["segments"],
    additionalProperties: true,
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "sourceId", "text", "mentions"],
          additionalProperties: true,
          properties: {
            id: idString,
            sourceId: idString,
            text: idString,
            mentions: {
              type: "array",
              items: {
                type: "object",
                required: ["conceptId"],
                additionalProperties: true,
                properties: { conceptId: idString }
              }
            }
          }
        }
      }
    }
  },
  relations: {
    type: "object",
    required: ["relations"],
    additionalProperties: true,
    properties: {
      relations: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "kind", "sourceConceptId", "targetConceptId", "confidence", "method"],
          additionalProperties: true,
          properties: {
            id: idString,
            kind: { type: "string", enum: [...KB_RELATION_KINDS] },
            sourceConceptId: idString,
            targetConceptId: idString,
            confidence: { type: "string", enum: ["high", "medium", "unspecified"] },
            method: { type: "string", enum: ["manual", "auto"] }
          }
        }
      }
    }
  }
};

const validators = new Map<string, ValidateFn>();
function validatorFor(name: string): ValidateFn {
  let fn = validators.get(name);
  if (!fn) {
    fn = ajv.compile(fileSchemas[name]);
    validators.set(name, fn);
  }
  return fn;
}

// ---------- 读写原语 ----------

async function readCollection<T>(projectRoot: string, name: string, key: string): Promise<T[]> {
  const filePath = path.join(kbDir(projectRoot), `${name}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const list = parsed[key];
    return Array.isArray(list) ? (list as T[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeCollection<T>(projectRoot: string, name: string, key: string, items: T[]): Promise<void> {
  const payload = { [key]: items } as Record<string, unknown>;
  const validate = validatorFor(name);
  if (!validate(payload)) {
    throw new Error(`invalid_kb_${name}: ${ajv.errorsText(validate.errors)}`);
  }
  const dir = kbDir(projectRoot);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.json`);
  await backupExisting(dir, name, filePath).catch((err) => {
    console.warn(`[kb] backup failed for ${name}: ${(err as Error).message}`);
  });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function backupExisting(dir: string, name: string, filePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  const historyDir = path.join(dir, ".history", name);
  await mkdir(historyDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(path.join(historyDir, `${ts}.json`), raw, "utf8");
  const entries = (await readdir(historyDir)).filter((n) => n.endsWith(".json")).sort();
  if (entries.length > HISTORY_LIMIT) {
    const toDelete = entries.slice(0, entries.length - HISTORY_LIMIT);
    await Promise.all(toDelete.map((n) => unlink(path.join(historyDir, n))));
  }
}

// ---------- 快照 ----------

export async function loadKb(projectRoot: string): Promise<KbData> {
  const [categories, concepts, terms, sources, segments, relations] = await Promise.all([
    readCollection<KbCategory>(projectRoot, "categories", "categories"),
    readCollection<KbConcept>(projectRoot, "concepts", "concepts"),
    readCollection<KbTerm>(projectRoot, "terms", "terms"),
    readCollection<KbSource>(projectRoot, "sources", "sources"),
    readCollection<KbSegment>(projectRoot, "segments", "segments"),
    readCollection<KbRelation>(projectRoot, "relations", "relations")
  ]);
  return { categories, concepts, terms, sources, segments, relations };
}

export async function saveCategories(projectRoot: string, categories: KbCategory[]): Promise<void> {
  await writeCollection(projectRoot, "categories", "categories", categories);
}

// ---------- Concept ----------

export type ConceptInput = {
  label: string;
  categoryId: string;
  subcategoryId?: string;
  conceptType?: KbConcept["conceptType"];
  description?: string;
};

export async function createConcept(projectRoot: string, input: ConceptInput): Promise<KbConcept> {
  const kb = await loadKb(projectRoot);
  assertCategory(kb, input.categoryId, input.subcategoryId);
  const label = input.label.trim();
  if (!label) throw new Error("concept_label_required");
  if (kb.concepts.some((c) => c.label === label)) {
    throw new Error(`concept_label_exists: ${label}`);
  }
  const concept: KbConcept = {
    id: newKbId("concept"),
    label,
    categoryId: input.categoryId,
    subcategoryId: input.subcategoryId,
    conceptType: input.conceptType ?? "entity",
    description: input.description?.trim() || undefined,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  // 规范名同时登记为首选词形，检索与字面匹配都只看 terms
  const term: KbTerm = { id: newKbId("term"), form: label, conceptId: concept.id, createdAt: nowIso() };
  await writeCollection(projectRoot, "concepts", "concepts", [...kb.concepts, concept]);
  await writeCollection(projectRoot, "terms", "terms", [...kb.terms, term]);
  return concept;
}

export async function updateConcept(
  projectRoot: string,
  id: string,
  patch: Partial<ConceptInput>
): Promise<KbConcept> {
  const kb = await loadKb(projectRoot);
  const index = kb.concepts.findIndex((c) => c.id === id);
  if (index < 0) throw new Error(`concept_not_found: ${id}`);
  const current = kb.concepts[index];
  if (patch.categoryId || patch.subcategoryId !== undefined) {
    assertCategory(kb, patch.categoryId ?? current.categoryId, patch.subcategoryId ?? current.subcategoryId);
  }
  const next: KbConcept = {
    ...current,
    label: patch.label?.trim() || current.label,
    categoryId: patch.categoryId ?? current.categoryId,
    subcategoryId: patch.subcategoryId === undefined ? current.subcategoryId : patch.subcategoryId || undefined,
    conceptType: patch.conceptType ?? current.conceptType,
    description: patch.description === undefined ? current.description : patch.description.trim() || undefined,
    updatedAt: nowIso()
  };
  const nextConcepts = kb.concepts.slice();
  nextConcepts[index] = next;
  await writeCollection(projectRoot, "concepts", "concepts", nextConcepts);
  return next;
}

/** 删除概念：级联删除其词形、关系，并从文段提及里移除 */
export async function deleteConcept(projectRoot: string, id: string): Promise<void> {
  const kb = await loadKb(projectRoot);
  if (!kb.concepts.some((c) => c.id === id)) throw new Error(`concept_not_found: ${id}`);
  await writeCollection(projectRoot, "concepts", "concepts", kb.concepts.filter((c) => c.id !== id));
  await writeCollection(projectRoot, "terms", "terms", kb.terms.filter((t) => t.conceptId !== id));
  await writeCollection(
    projectRoot,
    "relations",
    "relations",
    kb.relations.filter((r) => r.sourceConceptId !== id && r.targetConceptId !== id)
  );
  const touched = kb.segments.filter((s) => s.mentions.some((m) => m.conceptId === id));
  if (touched.length > 0) {
    const nextSegments = kb.segments.map((s) =>
      s.mentions.some((m) => m.conceptId === id)
        ? { ...s, mentions: s.mentions.filter((m) => m.conceptId !== id), updatedAt: nowIso() }
        : s
    );
    await writeCollection(projectRoot, "segments", "segments", nextSegments);
  }
}

function assertCategory(kb: KbData, categoryId: string, subcategoryId?: string): void {
  const category = kb.categories.find((c) => c.id === categoryId);
  if (!category || category.parentId) throw new Error(`category_not_found: ${categoryId}`);
  if (subcategoryId) {
    const sub = kb.categories.find((c) => c.id === subcategoryId);
    if (!sub || sub.parentId !== categoryId) throw new Error(`subcategory_not_found: ${subcategoryId}`);
  }
}

// ---------- Term ----------

export async function createTerm(
  projectRoot: string,
  input: { form: string; conceptId: string; script?: KbTerm["script"]; note?: string }
): Promise<KbTerm> {
  const kb = await loadKb(projectRoot);
  if (!kb.concepts.some((c) => c.id === input.conceptId)) throw new Error(`concept_not_found: ${input.conceptId}`);
  const form = input.form.trim();
  if (!form) throw new Error("term_form_required");
  if (kb.terms.some((t) => t.form === form && t.conceptId === input.conceptId)) {
    throw new Error(`term_exists: ${form}`);
  }
  const term: KbTerm = {
    id: newKbId("term"),
    form,
    conceptId: input.conceptId,
    script: input.script,
    note: input.note?.trim() || undefined,
    createdAt: nowIso()
  };
  await writeCollection(projectRoot, "terms", "terms", [...kb.terms, term]);
  return term;
}

export async function deleteTerm(projectRoot: string, id: string): Promise<void> {
  const kb = await loadKb(projectRoot);
  const term = kb.terms.find((t) => t.id === id);
  if (!term) throw new Error(`term_not_found: ${id}`);
  const siblings = kb.terms.filter((t) => t.conceptId === term.conceptId);
  if (siblings.length <= 1) throw new Error("cannot_delete_last_term");
  await writeCollection(projectRoot, "terms", "terms", kb.terms.filter((t) => t.id !== id));
}

// ---------- Source ----------

export async function createSource(
  projectRoot: string,
  input: { title: string; year?: string; author?: string; type?: string; note?: string }
): Promise<KbSource> {
  const kb = await loadKb(projectRoot);
  const title = input.title.trim();
  if (!title) throw new Error("source_title_required");
  const source: KbSource = {
    id: newKbId("source"),
    title,
    year: input.year?.trim() || undefined,
    author: input.author?.trim() || undefined,
    type: input.type?.trim() || undefined,
    note: input.note?.trim() || undefined,
    createdAt: nowIso()
  };
  await writeCollection(projectRoot, "sources", "sources", [...kb.sources, source]);
  return source;
}

export async function updateSource(
  projectRoot: string,
  id: string,
  patch: Partial<Omit<KbSource, "id" | "createdAt">>
): Promise<KbSource> {
  const kb = await loadKb(projectRoot);
  const index = kb.sources.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`source_not_found: ${id}`);
  const next: KbSource = { ...kb.sources[index], ...patch, id, createdAt: kb.sources[index].createdAt };
  const nextSources = kb.sources.slice();
  nextSources[index] = next;
  await writeCollection(projectRoot, "sources", "sources", nextSources);
  return next;
}

export async function deleteSource(projectRoot: string, id: string): Promise<void> {
  const kb = await loadKb(projectRoot);
  if (!kb.sources.some((s) => s.id === id)) throw new Error(`source_not_found: ${id}`);
  const used = kb.segments.filter((s) => s.sourceId === id).length;
  if (used > 0) throw new Error(`source_in_use: ${used} segments`);
  await writeCollection(projectRoot, "sources", "sources", kb.sources.filter((s) => s.id !== id));
}

// ---------- Segment ----------

export type SegmentInput = {
  sourceId: string;
  page?: string;
  locator?: string;
  text: string;
  mentions?: KbMention[];
  note?: string;
};

export async function createSegment(projectRoot: string, input: SegmentInput): Promise<KbSegment> {
  const kb = await loadKb(projectRoot);
  if (!kb.sources.some((s) => s.id === input.sourceId)) throw new Error(`source_not_found: ${input.sourceId}`);
  const text = input.text.trim();
  if (!text) throw new Error("segment_text_required");
  const mentions = normalizeMentions(kb, input.mentions ?? []);
  const segment: KbSegment = {
    id: newKbId("segment"),
    sourceId: input.sourceId,
    page: input.page?.trim() || undefined,
    locator: input.locator?.trim() || undefined,
    text,
    mentions,
    note: input.note?.trim() || undefined,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await writeCollection(projectRoot, "segments", "segments", [...kb.segments, segment]);
  return segment;
}

export async function updateSegment(projectRoot: string, id: string, patch: Partial<SegmentInput>): Promise<KbSegment> {
  const kb = await loadKb(projectRoot);
  const index = kb.segments.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`segment_not_found: ${id}`);
  if (patch.sourceId && !kb.sources.some((s) => s.id === patch.sourceId)) {
    throw new Error(`source_not_found: ${patch.sourceId}`);
  }
  const current = kb.segments[index];
  const next: KbSegment = {
    ...current,
    sourceId: patch.sourceId ?? current.sourceId,
    page: patch.page === undefined ? current.page : patch.page.trim() || undefined,
    locator: patch.locator === undefined ? current.locator : patch.locator.trim() || undefined,
    text: patch.text === undefined ? current.text : patch.text.trim() || current.text,
    mentions: patch.mentions === undefined ? current.mentions : normalizeMentions(kb, patch.mentions),
    note: patch.note === undefined ? current.note : patch.note.trim() || undefined,
    updatedAt: nowIso()
  };
  const nextSegments = kb.segments.slice();
  nextSegments[index] = next;
  await writeCollection(projectRoot, "segments", "segments", nextSegments);
  return next;
}

export async function deleteSegment(projectRoot: string, id: string): Promise<void> {
  const kb = await loadKb(projectRoot);
  if (!kb.segments.some((s) => s.id === id)) throw new Error(`segment_not_found: ${id}`);
  await writeCollection(projectRoot, "segments", "segments", kb.segments.filter((s) => s.id !== id));
  // 关系里引用该文段的证据一并清理（关系本身保留）
  const touched = kb.relations.filter((r) => r.evidenceSegmentIds?.includes(id));
  if (touched.length > 0) {
    const nextRelations = kb.relations.map((r) =>
      r.evidenceSegmentIds?.includes(id)
        ? { ...r, evidenceSegmentIds: r.evidenceSegmentIds.filter((s) => s !== id) }
        : r
    );
    await writeCollection(projectRoot, "relations", "relations", nextRelations);
  }
}

function normalizeMentions(kb: KbData, mentions: KbMention[]): KbMention[] {
  const seen = new Set<string>();
  const result: KbMention[] = [];
  for (const mention of mentions) {
    if (!mention?.conceptId || seen.has(mention.conceptId)) continue;
    if (!kb.concepts.some((c) => c.id === mention.conceptId)) {
      throw new Error(`mention_concept_not_found: ${mention.conceptId}`);
    }
    seen.add(mention.conceptId);
    result.push({ conceptId: mention.conceptId, matchedForm: mention.matchedForm, auto: mention.auto });
  }
  return result;
}

// ---------- Relation ----------

export async function createRelation(
  projectRoot: string,
  input: {
    kind: KbRelation["kind"];
    sourceConceptId: string;
    targetConceptId: string;
    confidence?: KbRelation["confidence"];
    weight?: number;
    evidenceSegmentIds?: string[];
    note?: string;
  }
): Promise<KbRelation> {
  const kb = await loadKb(projectRoot);
  for (const conceptId of [input.sourceConceptId, input.targetConceptId]) {
    if (!kb.concepts.some((c) => c.id === conceptId)) throw new Error(`concept_not_found: ${conceptId}`);
  }
  if (input.sourceConceptId === input.targetConceptId) throw new Error("relation_self_loop");
  for (const segmentId of input.evidenceSegmentIds ?? []) {
    if (!kb.segments.some((s) => s.id === segmentId)) throw new Error(`segment_not_found: ${segmentId}`);
  }
  const duplicate = kb.relations.some(
    (r) => r.kind === input.kind && r.sourceConceptId === input.sourceConceptId && r.targetConceptId === input.targetConceptId
  );
  if (duplicate) throw new Error("relation_exists");
  const relation: KbRelation = {
    id: newKbId("rel"),
    kind: input.kind,
    sourceConceptId: input.sourceConceptId,
    targetConceptId: input.targetConceptId,
    confidence: input.confidence ?? "unspecified",
    weight: input.weight,
    method: "manual",
    evidenceSegmentIds: input.evidenceSegmentIds?.length ? input.evidenceSegmentIds : undefined,
    note: input.note?.trim() || undefined,
    createdAt: nowIso()
  };
  await writeCollection(projectRoot, "relations", "relations", [...kb.relations, relation]);
  return relation;
}

export async function deleteRelation(projectRoot: string, id: string): Promise<void> {
  const kb = await loadKb(projectRoot);
  if (!kb.relations.some((r) => r.id === id)) throw new Error(`relation_not_found: ${id}`);
  await writeCollection(projectRoot, "relations", "relations", kb.relations.filter((r) => r.id !== id));
}
