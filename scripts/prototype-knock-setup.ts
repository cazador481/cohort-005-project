// PROTOTYPE (throwaway): Knock Development setup for "Does Knock hold up against Cadence?" (issue #20).
// Run: npm run prototype:knock-setup   (needs KNOCK_SERVICE_TOKEN in .env)
// Creates + commits the two catalogue workflows the spike triggers, and sets the
// environment default so the `enrollment` category is off on the in-app feed.
const MAPI = "https://control.knock.app/v1";
const token = process.env.KNOCK_SERVICE_TOKEN;
if (!token) throw new Error("missing KNOCK_SERVICE_TOKEN");

async function mapi(method: string, path: string, body?: unknown) {
  const res = await fetch(`${MAPI}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const inApp = (markdown_body: string) => ({
  type: "channel",
  ref: "in_app_feed_1",
  name: "In-app feed",
  channel_key: "in-app",
  template: { markdown_body, action_url: "{{ vars.app_url }}" },
});

const workflows = {
  "discussion-reply": {
    name: "Discussion Reply",
    categories: ["discussion"],
    steps: [inApp("**{{ actor.name }}** replied to your question on *{{ data.lessonTitle }}*: {{ data.replyExcerpt }}")],
  },
  "new-enrollment": {
    name: "New Enrollment",
    categories: ["enrollment"],
    steps: [inApp("**{{ actor.name }}** enrolled in *{{ data.courseTitle }}*")],
  },
};

for (const name of ["discussion", "enrollment"]) {
  await mapi("PUT", `/preference_categories/${name}`);
}

for (const [key, workflow] of Object.entries(workflows)) {
  const r = await mapi(
    "PUT",
    `/workflows/${key}?environment=development&commit=true&commit_message=${encodeURIComponent("Knock spike (#20)")}`,
    { workflow }
  );
  console.log(`workflow ${key}: active=${r.workflow.active} valid=${r.workflow.valid} categories=${r.workflow.categories}`);
}

// PUT replaces the whole default set, so merge into whatever is there.
const current = await mapi("GET", "/environments/development/defaults").catch(() => null);
const existing = current?.preference_set ?? {};
const preference_set = {
  ...existing,
  categories: { ...(existing.categories ?? {}), enrollment: { channel_types: { in_app_feed: false } } },
};
const d = await mapi("PUT", "/environments/development/defaults", { preference_set });
console.log("environment defaults:", JSON.stringify(d.preference_set));
