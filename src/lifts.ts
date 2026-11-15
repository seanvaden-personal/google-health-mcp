/**
 * Strength-session log, stored in this Worker's KV beside the check-ins
 * (prefix untouched by delete_my_data's cache purge). One session per date.
 */
export type LiftExercise = {
  name: string;
  weight_lb: number | null;
  sets: number | null;
  reps: number | null;
  note: string | null;
};
export type LiftSession = { date: string; exercises: LiftExercise[]; note: string | null; at: string };

const prefix = (userId: string) => `lift1:${userId}:`;

export async function saveLift(kv: KVNamespace, userId: string, s: LiftSession): Promise<void> {
  await kv.put(prefix(userId) + s.date, JSON.stringify(s));
}

export async function listLifts(kv: KVNamespace, userId: string, start: string, end: string): Promise<LiftSession[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: prefix(userId), cursor });
    for (const k of page.keys) {
      const date = k.name.slice(prefix(userId).length);
      if (date >= start && date <= end) names.push(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const sessions = await Promise.all(names.map((n) => kv.get<LiftSession>(n, "json")));
  return sessions.filter((s): s is LiftSession => !!s).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function deleteLift(kv: KVNamespace, userId: string, date: string): Promise<void> {
  await kv.delete(prefix(userId) + date);
}
