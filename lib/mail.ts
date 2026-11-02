/**
 * lib/mail.ts -- the one way the server sends an email.
 *
 * The portal's notifications are computed in the browser and shown on the page; this
 * module is how the important ones (the regularisation / loss-of-pay warnings) also
 * reach a person who is not looking at the page. It is deliberately thin: it owns the
 * SMTP transport and nothing else. Deciding WHO to mail and WHAT the message says is
 * the /api/notify route's job -- this file must never be handed a recipient it was
 * told to trust, which is why `to` here is only ever an address the route already
 * resolved from the server's own roster copy.
 *
 * Two safety properties are load-bearing:
 *   1. If mail is not configured (config().mail.enabled === false) every send is a
 *      silent no-op, not an error. A deployment without an App Password is a normal
 *      deployment, not a broken one; the page keeps working and simply does not mail.
 *   2. The transport is created once and reused. nodemailer keeps a connection pool,
 *      and building it per send on a one-CPU container turns a burst of notifications
 *      into a burst of TLS handshakes.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config";

/** The cached transporter, rebuilt only if the SMTP configuration changes. */
let cached: { transporter: Transporter; key: string } | null = null;

function transporter(): Transporter | null {
  const mail = config().mail;
  if (!mail.enabled) return null;
  // The key deliberately excludes the password's shape but includes host/port/user, so
  // a re-configured (test) environment gets a fresh transport rather than a stale one.
  const key = `${mail.host}:${mail.port}:${mail.secure}:${mail.user}`;
  if (cached && cached.key === key) return cached.transporter;
  const created = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    auth: { user: mail.user, pass: mail.pass },
    // A person waiting on a punch screen must not be blocked behind a slow SMTP peer.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cached = { transporter: created, key };
  return created;
}

/** True when outbound email is configured and switched on. Callers short-circuit on it. */
export function isMailEnabled(): boolean {
  return config().mail.enabled;
}

export interface MailInput {
  /** A single recipient address, already validated by the caller. */
  to: string;
  subject: string;
  /** Plain-text body. The Gmail client shows this for a notification; no HTML needed. */
  text: string;
}

/**
 * Send one notification email. Throws on a real SMTP failure so the route can report
 * it; returns false (nothing sent, nothing thrown) when mail is simply not configured,
 * which is the expected state in a build that has no App Password.
 */
export async function sendNotificationMail(input: MailInput): Promise<boolean> {
  const tr = transporter();
  if (!tr) return false;
  const mail = config().mail;
  await tr.sendMail({
    from: mail.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  return true;
}
