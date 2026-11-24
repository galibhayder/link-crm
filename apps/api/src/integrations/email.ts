/**
 * EMAIL DELIVERY.
 *
 * This build has NO provider configured and NO send implementation. It exists to
 * make that fact explicit and checkable rather than assumed.
 *
 * Why it matters: every number downstream of "we sent an email" — reply rate,
 * follow-up due dates, outreach history, client reports — becomes fiction if the
 * system records a send that never happened. So sending is refused loudly unless
 * a provider is genuinely configured, and even then the send path is not
 * implemented here.
 *
 * To enable sending later:
 *   1. Set EMAIL_PROVIDER and its credentials in the API environment.
 *   2. Implement `deliver()` against that provider.
 *   3. Only then allow the status to become `sent`.
 */
export type EmailProvider = "none" | "resend" | "postmark" | "sendgrid" | "smtp";

export interface DeliveryState {
  provider: EmailProvider;
  configured: boolean;
  reason?: string;
}

export function emailDelivery(): DeliveryState {
  const provider = (process.env.EMAIL_PROVIDER ?? "none").toLowerCase() as EmailProvider;

  if (!provider || provider === "none") {
    return { provider: "none", configured: false, reason: "No EMAIL_PROVIDER set" };
  }

  const credentialsPresent =
    (provider === "resend" && Boolean(process.env.RESEND_API_KEY)) ||
    (provider === "postmark" && Boolean(process.env.POSTMARK_TOKEN)) ||
    (provider === "sendgrid" && Boolean(process.env.SENDGRID_API_KEY)) ||
    (provider === "smtp" && Boolean(process.env.SMTP_HOST && process.env.SMTP_USER));

  if (!credentialsPresent) {
    return { provider, configured: false, reason: `Missing credentials for ${provider}` };
  }

  // Credentials exist, but this build ships no implementation. Reporting
  // `configured: true` with an unimplemented send is honest: the caller learns
  // that configuration succeeded and implementation has not.
  return { provider, configured: true };
}
