const dns = require('node:dns');
const nodemailer = require('nodemailer');

/**
 * Resolve mail hosts to IPv4 first.
 *
 * Node 17+ returns DNS results in whatever order the resolver gives, which on this network puts
 * Gmail's IPv6 address first — and the route to it is dead, so every send failed with
 * ECONNREFUSED against an address like 2404:6800:4000:1025::6d before IPv4 was ever tried. This
 * only reorders the candidates; it does not disable IPv6 anywhere else in the process.
 */
dns.setDefaultResultOrder('ipv4first');

/**
 * Outbound mail for this app.
 *
 * SMTP is optional on purpose. The dev machine has no mail server, and a business that has not
 * handed over Gmail credentials yet must still be able to run the app — so when SMTP is unset the
 * message is written to the console instead of thrown away, which is how a password-reset link is
 * recovered during setup.
 */

// Branding for the message body. Only these two lines differ between the apps that share this file.
const APP_NAME = 'Arihant Enterprise';
const BRAND_COLOR = '#0f172a';

const isMailConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let cachedTransporter = null;

/**
 * One pooled transporter for the process, not one per message.
 *
 * Gmail's TLS handshake and AUTH exchange cost more than the send itself — building a fresh
 * connection per reset email was most of the delay people saw between asking for a link and
 * receiving it. Pooling keeps the authenticated connection open so the second and later messages
 * skip all of it.
 */
const getTransporter = () => {
  if (!isMailConfigured()) return null;
  if (cachedTransporter) return cachedTransporter;

  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is TLS from the first byte; 587 negotiates STARTTLS, which is one extra round trip.
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return cachedTransporter;
};

/**
 * How long the pooled connection is allowed to sit idle before it is pinged.
 *
 * Gmail hangs up on an idle SMTP session after a few minutes, and once it has, the next message
 * pays the full TLS + AUTH handshake again — measured at 1.5s on 465 and 2.1s on 587, which is
 * most of the delay between pressing "Send OTP" and the mail arriving. Pinging inside that window
 * keeps the authenticated socket open, so a send is just the DATA transaction.
 */
const KEEPALIVE_MS = 4 * 60 * 1000;
let keepAliveTimer = null;

/**
 * What the last connection attempt said.
 *
 * `null` means nothing has been tried yet. This exists because of a sharp edge in the response
 * budget below: Gmail rejects a wrong username or password after about 1.3 seconds, which is
 * just slow enough to fall outside the budget and be reported to the user as "code sent". A
 * mistyped SMTP_PASS would then look like a working reset flow whose mail never arrives. Boot
 * and the keepalive both already know the answer, so the send path asks them instead of
 * rediscovering it on every request.
 */
let lastConnectionError = null;

const noteConnection = (err) => {
  lastConnectionError = err ? err.message : null;
};

/**
 * Opens and authenticates the first connection at boot rather than making the first person to
 * ask for a reset code wait for it, then keeps that connection warm. Failure is logged, never
 * thrown — a wrong SMTP password must not stop the server starting, it must only stop mail.
 */
const warmUpMailer = () => {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[MAIL] SMTP not configured — messages will be printed to the console.');
    return;
  }

  transporter
    .verify()
    .then(() => {
      noteConnection(null);
      console.log('[MAIL] SMTP connection ready');
    })
    .catch((err) => {
      noteConnection(err);
      console.error('[MAIL] SMTP connection failed:', err.message);
      // This one is almost never a code or credentials problem, and the raw message does not say
      // so. Antivirus mail shields (Avast, AVG, ESET, Kaspersky) terminate the TLS session and
      // re-sign it with their own root, which Node refuses because that root is not in its
      // bundled store.
      if (/unable to verify the first certificate|self[- ]signed certificate/i.test(err.message)) {
        console.error(
          '[MAIL] The certificate was issued by something other than the mail server — an ' +
            'antivirus "mail shield" is intercepting SMTP. Exclude the mail host from its ' +
            'outbound-mail scanning, or trust its root CA and start Node with --use-system-ca.'
        );
      }
    });

  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    // Nothing waits on this, and the next real send would reconnect by itself — but the result
    // is still worth recording, because it is what lets a send fail fast instead of timing out.
    transporter.verify().then(
      () => noteConnection(null),
      (err) => noteConnection(err)
    );
  }, KEEPALIVE_MS);
  // Not a reason to keep the process alive on its own.
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
};

/**
 * Awaited by its callers, unlike the fire-and-forget send this replaced.
 *
 * A reset link that never left the building used to report "email sent" anyway, because the send
 * was a dangling promise whose rejection only reached the server log. The caller decides what to
 * tell the user; it can only do that if it learns the send failed.
 */
const sendMail = async ({ to, subject, text, html, attachments, cc, bcc }) => {
  const transporter = getTransporter();

  if (!transporter) {
    console.log('================ [MAIL NOT CONFIGURED] ================');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text || html);
    console.log('=======================================================');
    return { sent: false, reason: 'smtp-not-configured' };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"${APP_NAME}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
    ...(attachments ? { attachments } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
  });
  return { sent: true };
};

/**
 * How long a caller will wait for the SMTP transaction before answering its own request anyway.
 *
 * Everything that goes wrong with SMTP goes wrong fast: a bad password, a blocked port and an
 * unreachable host all fail inside this window, so those are still reported to the user as
 * failures. What this window lets through is the opposite case — a send that is simply taking its
 * time — and for that, holding the HTTP response open buys nothing: the code is already stored,
 * the mail is already on its way, and the person is looking at a spinner instead of the box they
 * need to type the code into.
 *
 * A send that passes this point and THEN fails is reported only to the log. That is the trade:
 * a rare silent failure, against every reset request feeling instant.
 */
const SEND_RESPONSE_BUDGET_MS = 1200;

const sendMailWithin = async (budgetMs, options) => {
  // Known-bad credentials or an unreachable server: say so rather than letting the budget below
  // turn a configuration mistake into a cheerful "code sent" that never arrives.
  //
  // Re-checked rather than trusted outright, because the last word may have come from a keepalive
  // ping that caught a momentary network blip — and refusing every reset for the four minutes
  // until the next ping would be a worse bug than the one this guards against. A wrong password
  // fails this check again in about a second; a recovered connection passes it and carries on.
  if (lastConnectionError) {
    const transporter = getTransporter();
    try {
      if (transporter) await transporter.verify();
      noteConnection(null);
    } catch (err) {
      noteConnection(err);
      throw new Error(`SMTP is not usable: ${err.message}`);
    }
  }

  let budgetExpired = false;
  let settled = false;

  // The catch is attached now, not later: once Promise.race stops watching this promise, a
  // rejection with no handler would take the process down.
  const guarded = sendMail(options)
    .then((result) => {
      settled = true;
      return result;
    })
    .catch((err) => {
      settled = true;
      // Remembered so the next request fails immediately instead of waiting out the budget again.
      if (/invalid login|auth|ECONN|ETIMEDOUT|ENOTFOUND|EAUTH/i.test(err.message)) noteConnection(err);
      // Inside the budget the caller is still listening, so the failure is theirs to report.
      // Past it, the response has already gone out and the log is the only place left.
      if (!budgetExpired) throw err;
      console.error(`[MAIL] send to ${options.to} failed after the response was sent:`, err.message);
      return { sent: false, reason: 'late-failure' };
    });

  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      budgetExpired = true;
      resolve({ sent: settled, pending: !settled });
    }, budgetMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([guarded, timeout]);
};

const esc = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Shared shell for every message this app sends.
 *
 * Table-based and inline-styled on purpose: Outlook and most Indian webmail clients drop <style>
 * blocks and ignore flex/grid, so anything built the way the app's own pages are built arrives as
 * an unstyled column of text.
 */
const wrap = (heading, bodyHtml) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:#f4f5f7;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <tr>
        <td style="background:${BRAND_COLOR};padding:20px 28px">
          <div style="color:#ffffff;font-size:17px;font-weight:bold;letter-spacing:.2px">${esc(APP_NAME)}</div>
          <div style="color:rgba(255,255,255,.72);font-size:12px;margin-top:2px">${esc(heading)}</div>
        </td>
      </tr>
      <tr><td style="padding:28px;color:#111827;font-size:14px;line-height:1.6">${bodyHtml}</td></tr>
      <tr>
        <td style="padding:16px 28px;background:#fafafa;border-top:1px solid #f0f0f0;color:#9ca3af;font-size:11px">
          This is an automated message from ${esc(APP_NAME)}. Please do not reply.
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;

/**
 * The password-reset code.
 *
 * The digits are spaced out and set large because the whole job of this message is to be read off
 * one screen and typed into another. They are also repeated in the plain-text part: a client that
 * refuses HTML would otherwise show a reset email with no code in it.
 */
const sendPasswordResetOtpMail = async ({ to, name, otp, expiresInMinutes }) =>
  sendMailWithin(SEND_RESPONSE_BUDGET_MS, {
    to,
    subject: `${otp} is your ${APP_NAME} password reset code`,
    text: [
      `Hello ${name || ''},`.trim(),
      '',
      `Your ${APP_NAME} password reset code is: ${otp}`,
      '',
      `The code stops working in ${expiresInMinutes} minutes and can be used once.`,
      'If you did not ask for this, ignore this email - your password has not changed.',
    ].join('\n'),
    html: wrap(
      'Password reset',
      `
        <p style="margin:0 0 14px">Hello ${esc(name) || 'there'},</p>
        <p style="margin:0 0 20px">
          A password reset was requested for your ${esc(APP_NAME)} account.
          Enter this code to set a new password.
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#f4f6f8;border:1px solid #e5e7eb;border-radius:10px;margin:0 0 22px">
          <tr><td align="center" style="padding:22px 16px">
            <div style="font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:bold;
                        letter-spacing:10px;color:${BRAND_COLOR};line-height:1">${esc(otp)}</div>
            <div style="margin-top:10px;color:#6b7280;font-size:11px;letter-spacing:.4px;text-transform:uppercase">
              Password reset code
            </div>
          </td></tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#f9fafb;border-left:3px solid ${BRAND_COLOR};border-radius:4px">
          <tr><td style="padding:12px 14px;color:#4b5563;font-size:12px;line-height:1.5">
            The code stops working in <strong>${esc(expiresInMinutes)} minutes</strong> and can be used once.<br />
            Never share it with anyone &mdash; ${esc(APP_NAME)} will never ask you for it.<br />
            If you did not ask for this, ignore this email &mdash; your password has not changed.
          </td></tr>
        </table>`
    ),
  });

module.exports = {
  isMailConfigured,
  // Alias: some of these apps import it under the shorter name.
  isConfigured: isMailConfigured,
  warmUpMailer,
  sendMail,
  sendMailWithin,
  sendPasswordResetOtpMail,
  wrapEmailBody: wrap,
  APP_NAME,
};
