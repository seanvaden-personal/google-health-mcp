/**
 * Daily how-you-feel check-ins, stored in this Worker's own KV under a prefix
 * that delete_my_data's cache purge does not touch. One entry per date; the
 * values ride in KV metadata so a single list call reads them all.
 */
export type Checkin = {
  date: string;
  knee: number | null;
  elbow: number | null;
  energy: number | null;
  stress: number | null;
  note: string | null;
  at: string;
};

const prefix = (userId: string) => `ci1:${userId}:`;

export async function saveCheckin(kv: KVNamespace, userId: string, c: Checkin): Promise<void> {
  await kv.put(prefix(userId) + c.date, JSON.stringify(c), { metadata: c });
}

export async function listCheckins(kv: KVNamespace, userId: string, start: string, end: string): Promise<Checkin[]> {
  const out: Checkin[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list<Checkin>({ prefix: prefix(userId), cursor });
    for (const k of page.keys) {
      const date = k.name.slice(prefix(userId).length);
      if (date < start || date > end) continue;
      if (k.metadata) out.push(k.metadata);
      else {
        const v = await kv.get<Checkin>(k.name, "json");
        if (v) out.push(v);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function deleteCheckin(kv: KVNamespace, userId: string, date: string): Promise<void> {
  await kv.delete(prefix(userId) + date);
}
