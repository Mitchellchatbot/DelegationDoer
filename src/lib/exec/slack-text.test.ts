import { describe, expect, it } from "vitest";

import { slackTextToPlain } from "@/lib/exec/slack-text";
import { safeMrkdwn } from "@/lib/exec/slack-ui";

// P6 §5.6 (Area B): his DM text in Slack's wire format → the plain question (§3.6.1).

describe("slackTextToPlain", () => {
  it("TX01 mentions, channels and special mentions become plain names", () => {
    expect(slackTextToPlain("ask <@U0JANE> and <@W0BOB|bob>")).toBe("ask @U0JANE and @bob");
    expect(slackTextToPlain("see <#C0GEN|general> and <#C0RANDOM>")).toBe("see #general and #C0RANDOM");
    expect(slackTextToPlain("<!here> <!channel> <!everyone> <!here|here>")).toBe("@here @channel @everyone @here");
    expect(slackTextToPlain("ping <!subteam^S0SALES|@sales-team> now")).toBe("ping @sales-team now");
    expect(slackTextToPlain("ping <!subteam^S0SALES>")).toBe("ping @S0SALES");
    expect(slackTextToPlain("due <!date^1793977200^{date_short}|Nov 7, 2026> ok")).toBe("due Nov 7, 2026 ok");
  });

  it("TX01 links with and without labels; a label equal to its url is the url once", () => {
    expect(slackTextToPlain("read <https://operations.scaledai.org/tasks/t_1|the task>")).toBe("read the task (https://operations.scaledai.org/tasks/t_1)");
    expect(slackTextToPlain("read <https://example.com/a>")).toBe("read https://example.com/a");
    expect(slackTextToPlain("mail <mailto:jane@example.com|jane@example.com>")).toBe("mail jane@example.com (mailto:jane@example.com)");
    expect(slackTextToPlain("<https://x.io|https://x.io>")).toBe("https://x.io");
  });

  it("TX01 entities are decoded last, so a decoded < > never starts a control sequence", () => {
    expect(slackTextToPlain("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(slackTextToPlain("&lt;@U0JANE&gt; typed by hand")).toBe("<@U0JANE> typed by hand");
    expect(slackTextToPlain("<https://x.io/?a=1&amp;b=2|q &amp; a>")).toBe("q & a (https://x.io/?a=1&b=2)");
  });

  it("TX02 CRLF and lone CR become LF; the text is trimmed", () => {
    expect(slackTextToPlain("  line one\r\nline two\rline three\n  ")).toBe("line one\nline two\nline three");
  });

  it("TX03 decoding is one level only: &amp;lt; → &lt;", () => {
    expect(slackTextToPlain("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
    expect(slackTextToPlain("&amp;amp;")).toBe("&amp;");
  });

  it("TX04 a 5,000-character input comes back whole (the job checks the 4,000 cap)", () => {
    const long = "q".repeat(5_000);
    expect(slackTextToPlain(long)).toHaveLength(5_000);
  });

  it("TX05 no mention becomes a live mention when re-rendered through safeMrkdwn", () => {
    for (const wire of ["<!here> now", "&lt;!channel&gt;", "<@U0JANE|jane> <#C0GEN|general>", "&lt;@U0JANE&gt; &lt;!subteam^S1|@team&gt;", "<https://evil.example|DD>"]) {
      const rendered = safeMrkdwn(slackTextToPlain(wire));
      expect(rendered, wire).not.toMatch(/<[@#!]/);
      expect(rendered, wire).not.toContain("<");
      expect(rendered, wire).not.toContain(">");
    }
  });

  it("TX06 empty (or not a string) → \"\"", () => {
    expect(slackTextToPlain("")).toBe("");
    expect(slackTextToPlain("   \r\n ")).toBe("");
    expect(slackTextToPlain(undefined as unknown as string)).toBe("");
  });
});
