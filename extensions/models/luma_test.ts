import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@systeminit/swamp-testing@0.20260604.20";
import { daysLeft, model } from "./luma.ts";

const EVENT = {
  id: "evt-example",
  name: "Example Meetup",
  url: "https://luma.com/example",
  start_at: "2026-10-29T01:00:00.000Z",
  timezone: "America/Los_Angeles",
};

function guest(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    user_name: `Guest ${id}`,
    user_email: `${id}@example.com`,
    user_first_name: null,
    user_last_name: null,
    approval_status: "approved",
    registered_at: "2026-10-09T20:00:00.000Z",
    registration_answers: null,
    ...extra,
  };
}

/** Serves /v1/events/get and a single-page /v1/events/guests/list. */
function luma(guests: unknown[]) {
  return (req: Request) => {
    if (req.headers.get("x-luma-api-key") !== "test-key") {
      return new Response("missing key", { status: 401 });
    }
    const path = new URL(req.url).pathname;
    if (path === "/v1/events/get") return Response.json(EVENT);
    if (path === "/v1/events/guests/list") {
      return Response.json({ entries: guests, has_more: false });
    }
    return new Response("not found", { status: 404 });
  };
}

const globalArgs = {
  apiKey: "test-key",
  eventId: "evt-example",
  baseUrl: "https://luma.example.com",
};

Deno.test("signups: first run seeds silently", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedFetch(
    luma([guest("g1"), guest("g2")]),
    () => model.methods.signups.execute({}, context as never),
  );
  const [r] = getWrittenResources();
  assertEquals(r.data.seeded, true);
  assertEquals(r.data.messages, []);
  assertEquals(r.data.everSeen, ["g1", "g2"]);
});

Deno.test("signups: announces only unseen guests, skips invited", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: {
      signups: { eventId: "evt-example", everSeen: ["g1"] },
    },
  });
  const company = [{
    question_type: "company",
    label: "Company",
    question_id: "q",
    value: { company: "Acme", job_title: "Engineer" },
  }];
  await withMockedFetch(
    luma([
      guest("g1"),
      guest("g2", { registration_answers: company }),
      guest("g3", { approval_status: "invited", registered_at: null }),
    ]),
    () => model.methods.signups.execute({}, context as never),
  );
  const [r] = getWrittenResources();
  assertEquals(r.data.seeded, false);
  assertEquals(r.data.messages, [
    "🎟️ New sign-up for Example Meetup: **Guest g2** (Engineer @ Acme). 2 signed up.",
  ]);
  // Not seen until acknowledged.
  assertEquals(r.data.everSeen, ["g1"]);
});

Deno.test("signups: unacknowledged sign-ups are re-drafted next poll", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: {
      signups: { eventId: "evt-example", everSeen: ["g1"] },
    },
  });
  const poll = () =>
    withMockedFetch(
      luma([guest("g1"), guest("g2")]),
      () => model.methods.signups.execute({}, context as never),
    );
  await poll(); // the post after this one "fails": no ack
  await poll();
  const [first, second] = getWrittenResources();
  assertEquals(first.data.messages, second.data.messages);
  assertEquals((second.data.messages as string[]).length, 1);
});

Deno.test("ack: marks pending sign-ups seen and clears messages", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: { signups: { eventId: "evt-example", everSeen: ["g1"] } },
  });
  await withMockedFetch(
    luma([guest("g1"), guest("g2")]),
    () => model.methods.signups.execute({}, context as never),
  );
  await model.methods.ack.execute({}, context as never);
  const acked = getWrittenResources()[1].data;
  assertEquals(acked.everSeen, ["g1", "g2"]);
  assertEquals(acked.messages, []);
  assertEquals(acked.newGuests, []);
  // Next poll: nothing new.
  await withMockedFetch(
    luma([guest("g1"), guest("g2")]),
    () => model.methods.signups.execute({}, context as never),
  );
  assertEquals(getWrittenResources()[2].data.messages, []);
});

Deno.test("ack: no-op when nothing is pending", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: {
      signups: { eventId: "evt-example", everSeen: ["g1"], newGuests: [] },
    },
  });
  const result = await model.methods.ack.execute({}, context as never);
  assertEquals(result.dataHandles, []);
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("signups: a different event re-seeds", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: { signups: { eventId: "evt-other", everSeen: [] } },
  });
  await withMockedFetch(
    luma([guest("g1")]),
    () => model.methods.signups.execute({}, context as never),
  );
  assertEquals(getWrittenResources()[0].data.messages, []);
});

Deno.test("signups: API error throws and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedFetch(
    () => new Response("unauthorized", { status: 401 }),
    () =>
      assertRejects(
        () => model.methods.signups.execute({}, context as never),
        Error,
        "401",
      ),
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("signups: missing eventId throws", async () => {
  const { context } = createModelTestContext({
    globalArgs: { apiKey: "k", baseUrl: "https://luma.example.com" },
  });
  await assertRejects(
    () => model.methods.signups.execute({}, context as never),
    Error,
    "eventId",
  );
});

Deno.test("digest: counts by status and delta vs prior", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: {
      digest: {
        eventId: "evt-example",
        total: 1,
        generatedAt: "2026-01-01T17:00:00.000Z",
      },
    },
  });
  await withMockedFetch(
    luma([guest("g1"), guest("g2"), guest("g3", { approval_status: "waitlist" })]),
    () => model.methods.digest.execute({}, context as never),
  );
  const [r] = getWrittenResources();
  assertEquals(r.data.total, 3);
  assertEquals(r.data.delta, 2);
  assertEquals(r.data.byStatus, { approved: 2, waitlist: 1 });
  const text = String(r.data.text);
  assertEquals(text.split("\n")[0], "**Example Meetup**");
  assertEquals(
    text.split("\n")[1],
    "Sign-ups: 3 (+2 since Jan 1) — 2 approved, 1 waitlist.",
  );
});

Deno.test("daysLeft: calendar days in the event's timezone", () => {
  // 6pm Pacific Oct 28 is 01:00Z Oct 29 — still Oct 28 locally.
  const start = "2026-10-29T01:00:00.000Z";
  const tz = "America/Los_Angeles";
  assertEquals(daysLeft(start, tz, Date.parse("2026-10-09T22:00:00Z")), 19);
  assertEquals(daysLeft(start, tz, Date.parse("2026-10-28T16:00:00Z")), 0);
  assertEquals(daysLeft(null, tz, Date.now()), null);
});
