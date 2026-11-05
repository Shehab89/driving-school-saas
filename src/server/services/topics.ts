/**
 * Lesson topics. A topic is one of the school's skills. Each lesson can have
 * "planned" topics (what it will cover: set when it is booked, or by the
 * instructor beforehand) and "covered" topics (what was practised: set with
 * the feedback). Staff may set them on any lesson; an instructor only on
 * their own lessons.
 */
import { many, type Tx } from "@/lib/db";
import { PolicyError, ValidationError } from "@/lib/errors";
import type { Principal } from "../principal";
import { assertLessonAccess, lockLesson } from "./lessons";
import { audit } from "./audit";

export type TopicKind = "planned" | "covered";
export interface Topic { id: string; name: string; level_position: number; level_name: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All active topics of the school, in level order. */
export async function listTopics(tx: Tx, locale = "en") {
  return many<Topic>(
    tx,
    `SELECT sk.id, COALESCE(sk.name_translations->>$1, sk.name) AS name, ld.position AS level_position,
            COALESCE(ld.name_translations->>$1, ld.name) AS level_name
       FROM skills sk JOIN level_definitions ld ON ld.id = sk.level_id
      WHERE sk.is_active ORDER BY ld.position, sk.position, sk.name`,
    [locale],
  );
}

/** Replaces one kind of topics on a lesson. */
export async function setLessonTopics(tx: Tx, p: Principal, lessonId: string, kind: TopicKind, skillIds: string[]) {
  const ids = [...new Set(skillIds)];
  if (ids.length > 30) throw new ValidationError("Choose at most 30 topics.");
  if (ids.some((id) => !UUID.test(id))) throw new ValidationError("Unknown topic.");
  if (p.type === "ai_agent" || p.type === "webhook") throw new PolicyError("Not allowed.", "forbidden");
  const lesson = await lockLesson(tx, lessonId);
  assertLessonAccess(p, lesson, "operate");
  if (kind === "planned" && ["cancelled", "rescheduled"].includes(lesson.status)) {
    throw new PolicyError("This lesson is no longer planned.", "invalid_status");
  }
  if (ids.length) {
    const known = await many<{ id: string }>(tx, `SELECT id FROM skills WHERE id = ANY($1::uuid[]) AND is_active`, [ids]);
    if (known.length !== ids.length) throw new ValidationError("Unknown topic.");
  }
  await tx.query(`DELETE FROM lesson_topics WHERE lesson_id = $1 AND kind = $2`, [lessonId, kind]);
  if (ids.length) {
    await tx.query(
      `INSERT INTO lesson_topics (school_id, lesson_id, skill_id, kind, created_by)
       SELECT $1, $2, unnest($3::uuid[]), $4, $5`,
      [p.schoolId, lessonId, ids, kind, p.type === "user" ? p.actor.userId : null],
    );
  }
  await audit(tx, p, `lesson.topics_${kind}`, "lesson", lessonId, { topics: ids });
}

/** Topics for many lessons: lessonId -> { planned, covered } with names. */
export async function topicsForLessons(tx: Tx, lessonIds: string[], locale = "en") {
  const out = new Map<string, { planned: Array<{ id: string; name: string }>; covered: Array<{ id: string; name: string }> }>();
  if (!lessonIds.length) return out;
  const rows = await many<{ lesson_id: string; kind: TopicKind; id: string; name: string }>(
    tx,
    `SELECT lt.lesson_id, lt.kind, sk.id, COALESCE(sk.name_translations->>$2, sk.name) AS name
       FROM lesson_topics lt JOIN skills sk ON sk.id = lt.skill_id JOIN level_definitions ld ON ld.id = sk.level_id
      WHERE lt.lesson_id = ANY($1::uuid[]) ORDER BY ld.position, sk.position`,
    [lessonIds, locale],
  );
  for (const r of rows) {
    const e = out.get(r.lesson_id) ?? { planned: [], covered: [] };
    e[r.kind].push({ id: r.id, name: r.name });
    out.set(r.lesson_id, e);
  }
  return out;
}

/** When a lesson is moved, its planned topics move with it. */
export async function carryPlannedTopics(tx: Tx, fromLessonId: string, toLessonId: string) {
  await tx.query(
    `INSERT INTO lesson_topics (school_id, lesson_id, skill_id, kind, created_by)
     SELECT school_id, $2, skill_id, 'planned', created_by FROM lesson_topics WHERE lesson_id = $1 AND kind = 'planned'
     ON CONFLICT DO NOTHING`,
    [fromLessonId, toLessonId],
  );
}
