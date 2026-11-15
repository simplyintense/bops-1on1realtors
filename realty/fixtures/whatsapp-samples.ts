/**
 * Sample WhatsApp group messages for the replay (realty/node/replay.ts, the owners' "Replay samples" button on the
 * digest) and the live-matching tests. Made up, in the way 1on1's agents write: no real people, numbers or groups.
 * The sender numbers are in the fictional 555-01xx range. Portable: plain data.
 */

export type SampleMessage = { id: string; sender: string; body: string; expect: "buyer_request" | "cobroke_listing" | "other" };

/** The sample group's chat id. Only the replay's own temporary store ever has a consent record for it. */
export const SAMPLE_CHAT = "120363000000000001@g.us";

export const SAMPLE_MESSAGES: SampleMessage[] = [
  {
    id: "sample-westmoorings-rent",
    sender: "18685550101@c.us",
    body: "Good morning team! Client looking for a 2 bed apartment to rent in Westmoorings, budget up to 9k a month. Fully furnished preferred.",
    expect: "buyer_request",
  },
  {
    id: "sample-diego-martin-buy",
    sender: "18685550102@c.us",
    body: "Anyone have a 3 bedroom house for sale in Diego Martin? Buyer is pre-approved, budget TT$1.8M.",
    expect: "buyer_request",
  },
  {
    id: "sample-chaguanas-townhouse",
    sender: "18685550103@c.us",
    body: "Seeking a townhouse in Chaguanas to purchase, 3 bed, around 1.2 million TTD. Please DM.",
    expect: "buyer_request",
  },
  {
    id: "sample-maraval-listing",
    sender: "18685550104@c.us",
    body: "Just listed: 3 bed townhouse in Maraval TT$1.2M co-broke 50/50",
    expect: "cobroke_listing",
  },
  {
    id: "sample-chatter",
    sender: "18685550105@c.us",
    body: "Happy Friday all, viewing went well today!",
    expect: "other",
  },
];

/** A Periskope message.created envelope for one sample, the shape the webhook takes. */
export function sampleEnvelope(m: SampleMessage, chatId = SAMPLE_CHAT): Record<string, unknown> {
  return {
    event_type: "message.created",
    data: { message_id: m.id, chat_id: chatId, sender_phone: m.sender, body: m.body, from_me: false, message_type: "chat", has_media: false },
  };
}
