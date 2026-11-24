import { describe, expect, it } from "vitest";
import {
  canTransitionDraft,
  clientMaySeeDraft,
  countWords,
  DRAFT_TRANSITION_AUTHORITY,
  isOpenDraftStatus,
} from "./content.js";

/**
 * CONTENT WORKFLOW RULES.
 *
 * The approval step is the reason this module exists. If a writer can move a
 * draft straight to `approved`, the review never happens and the whole workflow is
 * decoration — so the transition table and the authority split are tested
 * explicitly.
 */

describe("canTransitionDraft", () => {
  it("allows the happy path", () => {
    expect(canTransitionDraft("draft", "in_review")).toBe(true);
    expect(canTransitionDraft("in_review", "approved")).toBe(true);
    expect(canTransitionDraft("approved", "published")).toBe(true);
  });

  it("refuses to approve a draft that was never submitted", () => {
    // The critical rule: skipping review would let a writer approve their own work.
    expect(canTransitionDraft("draft", "approved")).toBe(false);
    expect(canTransitionDraft("revision_requested", "approved")).toBe(false);
  });

  it("allows a revision request from review", () => {
    expect(canTransitionDraft("in_review", "revision_requested")).toBe(true);
  });

  it("allows a resubmit after revision", () => {
    expect(canTransitionDraft("revision_requested", "in_review")).toBe(true);
  });

  it("allows revisiting approved content before publication", () => {
    expect(canTransitionDraft("approved", "revision_requested")).toBe(true);
  });

  it("treats published as terminal", () => {
    expect(canTransitionDraft("published", "draft")).toBe(false);
    expect(canTransitionDraft("published", "in_review")).toBe(false);
    expect(canTransitionDraft("published", "approved")).toBe(false);
  });

  it("refuses backwards moves that would lose the review trail", () => {
    expect(canTransitionDraft("in_review", "draft")).toBe(false);
    expect(canTransitionDraft("approved", "draft")).toBe(false);
  });

  it("refuses an unknown target status", () => {
    expect(canTransitionDraft("draft", "banana")).toBe(false);
  });
});

describe("transition authority", () => {
  it("requires approval authority to approve or publish", () => {
    expect(DRAFT_TRANSITION_AUTHORITY.approved).toBe("approve");
    expect(DRAFT_TRANSITION_AUTHORITY.published).toBe("approve");
  });

  it("requires approval authority to request a revision", () => {
    // Requesting changes is a reviewer's act, not the writer's.
    expect(DRAFT_TRANSITION_AUTHORITY.revision_requested).toBe("approve");
  });

  it("requires only write authority to submit", () => {
    expect(DRAFT_TRANSITION_AUTHORITY.in_review).toBe("write");
  });
});

describe("countWords", () => {
  it("counts whitespace-separated tokens", () => {
    expect(countWords("one two three")).toBe(3);
  });

  it("collapses runs of whitespace", () => {
    expect(countWords("  one   two \n\t three  ")).toBe(3);
  });

  it("returns zero for empty or whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });

  it("counts a single word", () => {
    expect(countWords("hello")).toBe(1);
  });
});

describe("visibility and queue rules", () => {
  it("shows a client only approved or published drafts", () => {
    // Showing work in review would invite feedback on a draft about to change;
    // showing revision_requested would expose the agency's internal corrections.
    expect(clientMaySeeDraft("approved")).toBe(true);
    expect(clientMaySeeDraft("published")).toBe(true);
    expect(clientMaySeeDraft("draft")).toBe(false);
    expect(clientMaySeeDraft("in_review")).toBe(false);
    expect(clientMaySeeDraft("revision_requested")).toBe(false);
  });

  it("treats draft, revision_requested and in_review as open work", () => {
    expect(isOpenDraftStatus("draft")).toBe(true);
    expect(isOpenDraftStatus("revision_requested")).toBe(true);
    expect(isOpenDraftStatus("in_review")).toBe(true);
  });

  it("does not treat approved or published as open", () => {
    expect(isOpenDraftStatus("approved")).toBe(false);
    expect(isOpenDraftStatus("published")).toBe(false);
  });
});
