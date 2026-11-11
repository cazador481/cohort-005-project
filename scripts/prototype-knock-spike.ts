// PROTOTYPE (throwaway): answers "Does Knock hold up against Cadence?" (issue #20).
// Run: npx tsx --env-file=.env scripts/prototype-knock-spike.ts
// Needs in the Knock Development env: workflows `discussion-reply` and
// `new-enrollment` (API-call trigger, one In-app feed step each, committed),
// `new-enrollment` in category `enrollment`, and an environment default
// preference set: categories.enrollment.channel_types.in_app_feed = false.
import Knock, { signUserToken } from "@knocklabs/node";

const API = "https://api.knock.app/v1";
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const knock = new Knock({ apiKey: env("KNOCK_SECRET_API_KEY") });
const PUBLIC = env("KNOCK_PUBLIC_API_KEY");
const CHANNEL = env("KNOCK_FEED_CHANNEL_ID");
const SIGNING_KEY = env("KNOCK_SIGNING_KEY");

// Cadence users straight from the seed DB (comment 2: Sarah(2) replied to Emma(5)).
const EMMA = { id: "5", name: "Emma Wilson", email: "emma.wilson@example.com" };
const SARAH = { id: "2", name: "Sarah Chen", email: "sarah.chen@example.com" };
const JAMES = { id: "6", name: "James Park", email: "james.park@example.com" };

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// What the browser feed client does: public key + signed user token.
async function feedApi(
  path: string,
  userId: string,
  { token, method = "GET", body }: { token?: string | null; method?: string; body?: unknown } = {}
) {
  const t = token === undefined ? await signUserToken(userId, { signingKey: SIGNING_KEY }) : token;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PUBLIC}`,
      "X-Knock-User-Token": t ?? "",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const feed = (userId: string, token?: string | null) =>
  feedApi(`/users/${userId}/feeds/${CHANNEL}?page_size=20`, userId, { token });

async function poll<T>(fn: () => Promise<T | null>, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function main() {
  // sync recipients
  for (const u of [EMMA, SARAH, JAMES]) {
    await knock.users.update(u.id, { name: u.name, email: u.email });
  }
  await knock.users.unsetPreferences(JAMES.id, "default").catch(() => {});
  await knock.users.unsetPreferences(EMMA.id, "default").catch(() => {});

  // ── 1. signed user tokens ────────────────────────────────────────────────
  const emmaTok = await signUserToken(EMMA.id, { signingKey: SIGNING_KEY });
  const jamesTok = await signUserToken(JAMES.id, { signingKey: SIGNING_KEY });
  const own = await feed(EMMA.id, emmaTok);
  const noTok = await feed(EMMA.id, "");
  const crossTok = await feed(EMMA.id, jamesTok);
  check("1a own token → feed 200", own.status === 200, `status ${own.status}`);
  check("1b no token rejected (enforcement on)", noTok.status >= 400, `status ${noTok.status}`);
  check("1c James's token cannot read Emma's feed", crossTok.status >= 400, `status ${crossTok.status}`);

  // ── 2. triggering via Node SDK ───────────────────────────────────────────
  const before = own.json?.meta?.total_count ?? 0;
  const jamesBefore = (await feed(JAMES.id, jamesTok)).json?.meta?.total_count ?? 0;
  const run = await knock.workflows.trigger("discussion-reply", {
    recipients: [EMMA.id],
    actor: SARAH.id,
    data: { lessonTitle: "Intro", replyExcerpt: "Great question! (spike)" },
  });
  const arrived = await poll(async () => {
    const f = await feed(EMMA.id, emmaTok);
    return (f.json?.meta?.total_count ?? 0) > before ? f : null;
  });
  check("2 trigger → entry in Emma's feed", !!arrived, `workflow_run_id ${run.workflow_run_id}`);
  const jamesFeed = await feed(JAMES.id, jamesTok);
  check("2b Emma's Notification stays out of James's feed", (jamesFeed.json?.meta?.total_count ?? 0) === jamesBefore, `James total ${jamesBefore} → ${jamesFeed.json?.meta?.total_count}`);

  // ── 3. headless feed API ─────────────────────────────────────────────────
  const f = arrived ?? (await feed(EMMA.id, emmaTok));
  const entry = f.json?.entries?.[0];
  check("3a list items", !!entry?.id, `id ${entry?.id}`);
  check("3b unread count", (f.json?.meta?.unread_count ?? 0) >= 1, `unread ${f.json?.meta?.unread_count}`);
  if (entry?.id) {
    const seen = await feedApi(`/messages/${entry.id}/seen`, EMMA.id, { method: "PUT", token: emmaTok });
    const read = await feedApi(`/messages/${entry.id}/read`, EMMA.id, { method: "PUT", token: emmaTok });
    const after = await feed(EMMA.id, emmaTok);
    check("3c mark seen", seen.status === 200 && !!seen.json?.seen_at, `status ${seen.status}`);
    check("3d mark read lowers unread", read.status === 200 && after.json.meta.unread_count < f.json.meta.unread_count, `unread ${f.json.meta.unread_count} → ${after.json?.meta?.unread_count}`);
  }

  // ── 4. opt-in preference (off by default) ───────────────────────────────
  const jb = (await feed(JAMES.id, jamesTok)).json?.meta?.total_count ?? 0;
  await knock.workflows.trigger("new-enrollment", { recipients: [JAMES.id], actor: EMMA.id, data: { courseTitle: "Spike course" } });
  await new Promise((r) => setTimeout(r, 6000));
  const offByDefault = ((await feed(JAMES.id, jamesTok)).json?.meta?.total_count ?? 0) === jb;
  check("4a new-enrollment off by default", offByDefault);
  // Opt in on exactly one category × channel cell.
  await knock.users.setPreferences(JAMES.id, "default", {
    __persistence_strategy__: "merge",
    categories: { enrollment: { channel_types: { in_app_feed: true } } },
  });
  await knock.workflows.trigger("new-enrollment", { recipients: [JAMES.id], actor: EMMA.id, data: { courseTitle: "Spike course" } });
  const optedIn = await poll(async () => {
    const x = await feed(JAMES.id, jamesTok);
    return (x.json?.meta?.total_count ?? 0) > jb ? x : null;
  });
  check("4b opt-in delivers", !!optedIn);

  const failed = results.filter((r) => !r[1]);
  console.log(failed.length ? `\n${failed.length} check(s) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
