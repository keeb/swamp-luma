# @keeb/luma

[Luma](https://luma.com) event sign-ups for swamp. Poll an event's guest list
for net new sign-ups and compose a daily summary — each written as plain
markdown text ready to post to a chat webhook (e.g. `@keeb/discord/webhook`).

## Model

| Model        | Method    | What it does                                                                 |
| ------------ | --------- | ---------------------------------------------------------------------------- |
| `@keeb/luma` | `events`  | Every event on the API key's calendar (id, name, start, url)                 |
|              | `signups` | Guest list poll; one message per sign-up not yet announced, in `messages`    |
|              | `ack`     | Mark the latest poll's sign-ups announced (run after posting)                |
|              | `digest`  | Sign-ups by status, change since the last digest, days left, in `text`       |

- **Sign-up** = a guest with `registered_at` set (approved, pending approval,
  waitlist, declined). Invited guests who never registered don't count.
- **New** = a guest id not in `everSeen`. Ids enter `everSeen` through `ack`,
  which you run after the chat posts succeed. If a post fails, skip `ack` and
  the next poll re-drafts the same sign-ups — nothing is lost. A partial
  failure (some posts land, one fails) re-posts the ones that landed.
- The first `signups` run seeds `everSeen` and emits no messages, so turning
  it on never replays the existing guest list.
- **Days left** = calendar days to the event's start, in the event's timezone.

## Setup

A Luma API key needs Luma Plus and is scoped to the calendar it was created on.

```bash
swamp vault create local_encryption luma
printf '%s' "$LUMA_API_KEY" | swamp vault put luma apiKey

swamp model create @keeb/luma meetup
# globalArguments:
#   apiKey: ${{ vault.get(luma, apiKey) }}
#   eventId: evt-…        # from `events`

swamp model method run meetup events
swamp model method run meetup signups
swamp model method run meetup digest
```

## Posting to chat

Poll every minute, post each new sign-up, then acknowledge:

```yaml
name: meetup-signups
trigger:
  schedule: "* * * * *"
jobs:
  - name: check
    steps:
      - name: signups
        task:
          type: model_method
          modelIdOrName: meetup
          methodName: signups
  # forEach.in resolves at job start, so posting is its own job.
  - name: announce
    dependsOn:
      - job: check
        condition:
          type: succeeded
    steps:
      - name: post
        forEach:
          item: message
          in: ${{ data.latest("meetup", "signups").attributes.messages }}
        concurrency: 1
        task:
          type: model_method
          modelIdOrName: meetup-discord
          methodName: send
          inputs:
            content: ${{ self.message }}
  # Only after every post succeeds.
  - name: ack
    dependsOn:
      - job: announce
        condition:
          type: succeeded
    steps:
      - name: ack
        task:
          type: model_method
          modelIdOrName: meetup
          methodName: ack
```

Daily summary: run `digest`, then post
`${{ data.latest("meetup", "digest").attributes.text }}`.

Example messages:

```
🎟️ New sign-up for Swamp Club Meetup: **Jane Doe** (Staff Engineer @ Acme). 23 signed up.

**Swamp Club Meetup**
Sign-ups: 23 (+4 since yesterday) — 19 approved, 3 pending approval, 1 waitlist.
12 days left.
```

Job title and company appear when the registration form asks the Company
question.

## License

MIT
