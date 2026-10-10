import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing@0.20260604.20";

// One Luma event's sign-ups. The API key is scoped to the calendar it was
// created on; `events` lists that calendar so you can find the evt- id.
//
//   sign-up — a guest with `registered_at` set (any status: approved,
//             pending_approval, waitlist, declined). Invited-but-never-
//             registered guests are not sign-ups.
//   new     — a sign-up whose guest id is not in `everSeen`. Ids enter
//             `everSeen` through `ack`, after their messages post.
//             The first run for an event seeds `everSeen` silently, so turning
//             this on never replays the existing guest list into chat.

const GlobalArgsSchema = z.object({
  apiKey: z.string().meta({ sensitive: true }).describe(
    "Luma API key (x-luma-api-key); calendar-scoped",
  ),
  eventId: z.string().optional().describe("Luma event id (evt-…)"),
  baseUrl: z.string().default("https://public-api.luma.com").describe(
    "Luma API base URL",
  ),
});

const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  startAt: z.string().nullable(),
  timezone: z.string(),
});

const GuestSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  status: z.string(),
  registeredAt: z.string().nullable(),
});

const EventsSchema = z.object({
  generatedAt: z.string(),
  events: z.array(EventSchema),
});

const SignupsSchema = z.object({
  generatedAt: z.string(),
  eventId: z.string(),
  event: EventSchema,
  seeded: z.boolean(),
  counts: z.object({ signups: z.number(), going: z.number() }),
  newGuests: z.array(GuestSchema),
  messages: z.array(z.string()),
  guests: z.array(GuestSchema),
  everSeen: z.array(z.string()),
});

const DigestSchema = z.object({
  generatedAt: z.string(),
  eventId: z.string(),
  event: EventSchema,
  total: z.number(),
  delta: z.number().nullable(),
  priorAt: z.string().nullable(),
  byStatus: z.record(z.string(), z.number()),
  daysLeft: z.number().nullable(),
  text: z.string(),
});

type Doc = Record<string, unknown>;
type Ctx = { globalArgs: z.infer<typeof GlobalArgsSchema> };
type Event = z.infer<typeof EventSchema>;
type Guest = z.infer<typeof GuestSchema>;
const DAY_MS = 86400000;

async function luma(
  context: Ctx,
  path: string,
  query: Record<string, string> = {},
): Promise<Doc> {
  const url = `${
    context.globalArgs.baseUrl.replace(/\/$/, "")
  }${path}?${new URLSearchParams(query)}`;
  for (let attempt = 0;; attempt++) {
    const res = await fetch(url, {
      headers: {
        "x-luma-api-key": context.globalArgs.apiKey,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    // One retry on rate limiting, honoring Retry-After (capped at 10s).
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `Luma GET ${path} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    const body = JSON.parse(text);
    if (!body || typeof body !== "object") {
      throw new Error(`Luma GET ${path} returned a non-object body`);
    }
    return body as Doc;
  }
}

async function lumaAll(
  context: Ctx,
  path: string,
  query: Record<string, string>,
): Promise<Doc[]> {
  const out: Doc[] = [];
  let cursor: string | undefined;
  do {
    const page = await luma(context, path, {
      ...query,
      pagination_limit: "100",
      ...(cursor ? { pagination_cursor: cursor } : {}),
    });
    if (!Array.isArray(page.entries)) {
      throw new Error(`Luma GET ${path} returned no entries array`);
    }
    out.push(...(page.entries as Doc[]));
    cursor = page.has_more ? (page.next_cursor as string) : undefined;
  } while (cursor);
  return out;
}

function eventIdOf(context: Ctx): string {
  const id = context.globalArgs.eventId;
  if (!id) {
    throw new Error(
      "set globalArguments.eventId (run `events` to list the calendar's evt- ids)",
    );
  }
  return id;
}

function eventRow(e: Doc, fallbackId = ""): Event {
  return {
    id: String(e.id ?? fallbackId),
    name: String(e.name ?? fallbackId),
    url: (e.url as string) ?? null,
    startAt: (e.start_at as string) ?? null,
    timezone: (e.timezone as string) ?? "UTC",
  };
}

async function getEvent(context: Ctx, eventId: string): Promise<Event> {
  const body = await luma(context, "/v1/events/get", { event_id: eventId });
  return eventRow(((body.event as Doc) ?? body) as Doc, eventId);
}

async function getSignups(context: Ctx, eventId: string): Promise<Guest[]> {
  const entries = await lumaAll(context, "/v1/events/guests/list", {
    event_id: eventId,
    sort_column: "registered_at",
    sort_direction: "asc nulls last",
  });
  return entries.map(guestRow).filter((g) => g.registeredAt);
}

function guestRow(g: Doc): Guest {
  const answers = (g.registration_answers as Doc[] | null) ?? [];
  const co = answers.find((a) => a.question_type === "company")?.value as
    | Doc
    | undefined;
  return {
    id: String(g.id),
    name: (g.user_name as string) ??
      [g.user_first_name, g.user_last_name].filter(Boolean).join(" "),
    email: (g.user_email as string) ?? null,
    company: (co?.company as string) ?? null,
    jobTitle: (co?.job_title as string) ?? null,
    status: String(g.approval_status),
    registeredAt: (g.registered_at as string) ?? null,
  };
}

/** YYYY-MM-DD of an instant in a timezone. */
function localDay(t: number, timezone: string): string {
  return new Date(t).toLocaleDateString("en-CA", { timeZone: timezone });
}

/** Calendar days from today to the event's start day, in the event's timezone. */
export function daysLeft(
  startAt: string | null,
  timezone: string,
  now: number,
): number | null {
  if (!startAt) return null;
  return Math.round(
    (Date.parse(localDay(Date.parse(startAt), timezone)) -
      Date.parse(localDay(now, timezone))) / DAY_MS,
  );
}

/** Luma event sign-ups: list calendar events, poll for net new sign-ups, compose a daily digest. */
export const model = {
  type: "@keeb/luma",
  version: "2026.10.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    events: {
      description:
        "The calendar's events (id, name, start, url) — find the evt- id to set as eventId.",
      schema: EventsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    signups: {
      description:
        "One poll of the event's guest list: every sign-up, the ones not yet announced, one chat message per such sign-up in `messages`, and `everSeen` — every guest id announced (or seeded), carried forward so each sign-up is announced once `ack` confirms the post.",
      schema: SignupsSchema,
      lifetime: "infinite",
      garbageCollection: 200,
    },
    digest: {
      description:
        "Daily sign-up count and days left for the event. `text` is the chat post (markdown); `total` feeds the next digest's delta.",
      schema: DigestSchema,
      lifetime: "infinite",
      garbageCollection: 400,
    },
  },
  methods: {
    events: {
      description: "List the events on the API key's calendar.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        context.logger.info("Listing calendar events");
        const entries = await lumaAll(context, "/v1/calendars/events/list", {});
        const events = entries.map((x) =>
          eventRow(((x.event as Doc) ?? x) as Doc)
        );
        context.logger.info("{n} events on the calendar", {
          n: events.length,
        });
        const handle = await context.writeResource("events", "events", {
          generatedAt: new Date().toISOString(),
          events,
        });
        return { dataHandles: [handle] };
      },
    },
    signups: {
      description:
        "Poll the event's guest list and emit one chat message per sign-up not yet announced. The first run for an event seeds everSeen and emits nothing. Run `ack` after posting; until then the same sign-ups are re-drafted each poll.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const eventId = eventIdOf(context);
        context.logger.info("Polling sign-ups for {eventId}", { eventId });
        const prior = await context.readResource("signups") as
          | z.infer<typeof SignupsSchema>
          | null;
        // A different event on the same instance starts its own seed.
        const seeding = !prior || prior.eventId !== eventId;
        const everSeen = new Set<string>(seeding ? [] : prior.everSeen);

        const event = await getEvent(context, eventId);
        const guests = await getSignups(context, eventId);

        const fresh = seeding ? [] : guests.filter((g) => !everSeen.has(g.id));
        // New sign-ups enter everSeen only via `ack`, after their messages
        // post — a failed post leaves them to be re-drafted next poll.
        if (seeding) { for (const g of guests) everSeen.add(g.id); }
        const going = guests.filter((g) => g.status === "approved").length;
        const messages = fresh.map((g) => {
          const who = [g.jobTitle, g.company].filter(Boolean).join(" @ ");
          return `🎟️ New sign-up for ${event.name}: **${g.name || g.email}**${
            who ? ` (${who})` : ""
          }. ${guests.length} signed up.`;
        });

        context.logger.info("{event}: {n} sign-ups, {fresh} new{seed}", {
          event: event.name,
          n: guests.length,
          fresh: fresh.length,
          seed: seeding ? " (seeded)" : "",
        });
        const handle = await context.writeResource("signups", "signups", {
          generatedAt: new Date().toISOString(),
          eventId,
          event,
          seeded: seeding,
          counts: { signups: guests.length, going },
          newGuests: fresh,
          messages,
          guests,
          everSeen: [...everSeen].sort(),
        });
        return { dataHandles: [handle] };
      },
    },
    ack: {
      description:
        "Mark the latest poll's new sign-ups as announced: add them to everSeen and clear messages. Run after the chat posts succeed. No-op when nothing is pending.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const prior = await context.readResource("signups") as
          | z.infer<typeof SignupsSchema>
          | null;
        if (!prior?.newGuests?.length) {
          context.logger.info("Nothing pending to acknowledge");
          return { dataHandles: [] };
        }
        context.logger.info("Acknowledging {n} announced sign-ups", {
          n: prior.newGuests.length,
        });
        const everSeen = new Set<string>(prior.everSeen);
        for (const g of prior.newGuests) everSeen.add(g.id);
        const handle = await context.writeResource("signups", "signups", {
          ...prior,
          generatedAt: new Date().toISOString(),
          newGuests: [],
          messages: [],
          everSeen: [...everSeen].sort(),
        });
        return { dataHandles: [handle] };
      },
    },
    digest: {
      description:
        "Compose the daily summary: total sign-ups by status, change since the last digest, and days left until the event.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const eventId = eventIdOf(context);
        context.logger.info("Composing digest for {eventId}", { eventId });
        const stored = await context.readResource("digest") as
          | z.infer<typeof DigestSchema>
          | null;
        const prior = stored?.eventId === eventId ? stored : null;

        const now = Date.now();
        const event = await getEvent(context, eventId);
        const guests = await getSignups(context, eventId);
        const byStatus: Record<string, number> = {};
        for (const g of guests) {
          byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
        }
        const total = guests.length;
        const delta = prior ? total - prior.total : null;
        const left = daysLeft(event.startAt, event.timezone, now);

        let since = "";
        if (prior) {
          const priorDay = localDay(
            Date.parse(prior.generatedAt),
            event.timezone,
          );
          since = priorDay === localDay(now - DAY_MS, event.timezone)
            ? "since yesterday"
            : `since ${
              new Date(prior.generatedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: event.timezone,
              })
            }`;
        }
        const statusLine = Object.entries(byStatus)
          .sort((a, b) => b[1] - a[1])
          .map(([s, n]) => `${n} ${s.replace(/_/g, " ")}`).join(", ");
        const when = left === null
          ? "No start date set."
          : left > 1
          ? `${left} days left.`
          : left === 1
          ? "1 day left."
          : left === 0
          ? "It's today."
          : `Happened ${-left} day${left === -1 ? "" : "s"} ago.`;
        const text = [
          `**${event.name}**`,
          `Sign-ups: ${total}${
            delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta} ${since})`
          }${statusLine ? ` — ${statusLine}` : ""}.`,
          when,
        ].join("\n");

        context.logger.info("{event}: {total} sign-ups, {left} days left", {
          event: event.name,
          total,
          left,
        });
        const handle = await context.writeResource("digest", "digest", {
          generatedAt: new Date(now).toISOString(),
          eventId,
          event,
          total,
          delta,
          priorAt: prior?.generatedAt ?? null,
          byStatus,
          daysLeft: left,
          text,
        });
        return { dataHandles: [handle] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
