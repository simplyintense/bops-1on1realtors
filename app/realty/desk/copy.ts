/**
 * What an agent sees on the desk, as plain functions (no React), so a test can check it. Owners keep the score, the feed's status
 * line and the section's full copy; an agent gets the neutral words and no number, and nothing about the live feed.
 */

/** The label on a lead card: an owner sees the score; an agent sees "Strong match" (no number). */
export function leadLabel(owner: boolean, score: number): string {
  return owner ? `Lead · score ${score}` : "Strong match";
}

/** The lead section's one-line copy. The number (75) is the owners' copy only. */
export function leadsSectionCopy(owner: boolean): string {
  return owner
    ? "Strong matches (75 and above) for the listings you hold in the 1on1 CRM: who asked, the listing, and a suggested message. Owners see every card; a listing with no agent is the office's."
    : "Strong matches for the listings you hold in the 1on1 CRM: who asked, the listing, and a suggested message.";
}

/** Whether the desk shows the live feed's status line (last message, webhook state): owners only. */
export function showFeedStatus(owner: boolean): boolean {
  return owner;
}
