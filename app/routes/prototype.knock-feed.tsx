// PROTOTYPE (throwaway): answers "Does Knock hold up against Cadence?" (issue #20).
// Proves check 1 in the real app: the server signs an RS256 Knock user token for
// whichever user the DevUI switcher selected, and the BROWSER reads that user's
// feed with it. Switch user in the DevUI panel → this page shows a different feed.
// Not the Feed's look (that's issue #18). Never merge.
import { useCallback, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import Knock, { signUserToken } from "@knocklabs/node";
import type { Route } from "./+types/prototype.knock-feed";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { users } from "~/db/schema";
import { eq } from "drizzle-orm";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} in .env`);
  return v;
};

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw new Response("Select a user from the DevUI panel", { status: 401 });
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  const token = await signUserToken(String(userId), {
    signingKey: env("KNOCK_SIGNING_KEY"),
    expiresInSeconds: 3600,
  });
  return {
    user: { id: userId, name: user?.name, email: user?.email, role: user?.role },
    token,
    publicKey: env("KNOCK_PUBLIC_API_KEY"),
    channelId: env("KNOCK_FEED_CHANNEL_ID"),
  };
}

// Fire a real catalogue Notification (Discussion Reply → question author) at the
// current user, actor = some other user, so it lands in this user's feed.
export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw new Response("no user", { status: 401 });
  const knock = new Knock({ apiKey: env("KNOCK_SECRET_API_KEY") });
  const me = db.select().from(users).where(eq(users.id, userId)).get()!;
  const actor = db.select().from(users).all().find((u) => u.id !== userId)!;
  for (const u of [me, actor]) {
    await knock.users.update(String(u.id), { name: u.name, email: u.email });
  }
  const run = await knock.workflows.trigger("discussion-reply", {
    recipients: [String(userId)],
    actor: String(actor.id),
    data: { lessonTitle: "Prototype lesson", replyExcerpt: `Reply from ${actor.name} (prototype)` },
  });
  return { workflowRunId: run.workflow_run_id };
}

type FeedEntry = {
  id: string;
  inserted_at: string;
  read_at: string | null;
  seen_at: string | null;
  source: { key: string };
  data: Record<string, unknown>;
  blocks?: { name: string; rendered: string }[];
};
type FeedResponse = { entries: FeedEntry[]; meta: { total_count: number; unread_count: number; unseen_count: number } };

export default function KnockFeedPrototype({ loaderData }: Route.ComponentProps) {
  const { user, token, publicKey, channelId } = loaderData;
  const trigger = useFetcher<typeof action>();
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [log, setLog] = useState<string[]>([]);

  // Exactly what a production browser client does: public key + signed user token.
  const knockFetch = useCallback(
    async (path: string, method = "GET") => {
      const res = await fetch(`https://api.knock.app/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${publicKey}`,
          "X-Knock-User-Token": token,
          "Content-Type": "application/json",
        },
      });
      const json = await res.json().catch(() => null);
      setLog((l) => [`${method} ${path} → ${res.status}`, ...l].slice(0, 12));
      return { status: res.status, json };
    },
    [publicKey, token]
  );

  const load = useCallback(async () => {
    const r = await knockFetch(`/users/${user.id}/feeds/${channelId}?page_size=20`);
    setFeed(r.status === 200 ? r.json : null);
  }, [knockFetch, user.id, channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (trigger.data) setTimeout(() => void load(), 3000);
  }, [trigger.data, load]);

  const mark = async (id: string, status: "seen" | "read" | "unread") => {
    await knockFetch(`/messages/${id}/${status}`, status === "unread" ? "DELETE" : "PUT");
    // "unread" is DELETE /messages/:id/read
    await load();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 font-mono text-sm">
      <div className="rounded border-2 border-dashed border-amber-500 bg-amber-50 p-3">
        PROTOTYPE — Knock spike (issue #20). Throwaway; never merge.
      </div>
      <section>
        <h2 className="font-bold">Current DevUI user</h2>
        <pre>{JSON.stringify(user, null, 2)}</pre>
        <p className="break-all text-xs text-muted-foreground">token sub: {user.id} · token: {token.slice(0, 40)}…</p>
      </section>
      <section className="flex gap-2">
        <button className="rounded border px-3 py-1" onClick={() => void load()}>Reload feed</button>
        <trigger.Form method="post">
          <button className="rounded border px-3 py-1" disabled={trigger.state !== "idle"}>
            Trigger Discussion Reply → me
          </button>
        </trigger.Form>
        {trigger.data && <span>run {trigger.data.workflowRunId}</span>}
      </section>
      <section>
        <h2 className="font-bold">
          Feed — total {feed?.meta.total_count ?? "?"} · unread {feed?.meta.unread_count ?? "?"} · unseen{" "}
          {feed?.meta.unseen_count ?? "?"}
        </h2>
        <ul className="space-y-2">
          {feed?.entries.map((e) => (
            <li key={e.id} className="rounded border p-2">
              <div>
                {e.source.key} · {e.inserted_at} · {e.read_at ? "read" : "UNREAD"} · {e.seen_at ? "seen" : "UNSEEN"}
              </div>
              <div className="text-muted-foreground">{JSON.stringify(e.data)}</div>
              <div className="mt-1 flex gap-2">
                <button className="rounded border px-2" onClick={() => void mark(e.id, "seen")}>mark seen</button>
                <button className="rounded border px-2" onClick={() => void mark(e.id, "read")}>mark read</button>
                <button className="rounded border px-2" onClick={() => void mark(e.id, "unread")}>mark unread</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="font-bold">Knock calls (from the browser)</h2>
        <pre>{log.join("\n")}</pre>
      </section>
    </div>
  );
}
