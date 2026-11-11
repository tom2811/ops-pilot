import nodemailer, { type Transporter } from "nodemailer";

export type MailerConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  replyTo?: string;
};

export type Mailer = {
  send(input: { to: string; subject: string; text: string; html?: string; messageId?: string }): Promise<string | undefined>;
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatEmailHtml(subject: string, text: string): string {
  const safeSubject = escapeHtml(subject);
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const formattedBlocks = blocks
    .map((block) => {
      const lines = block
        .split("\n")
        .map((l) => escapeHtml(l.trim()))
        .filter(Boolean);
      const isList = lines.every((l) => l.startsWith("- ") || l.startsWith("* "));
      if (isList) {
        const items = lines
          .map((l) => `<li style="margin-bottom: 6px;">${l.replace(/^[-*]\s*/, "")}</li>`)
          .join("");
        return `<ul style="margin: 12px 0; padding-left: 20px; color: #334155; line-height: 1.6;">${items}</ul>`;
      }
      return `<p style="margin: 0 0 14px 0; color: #334155; line-height: 1.6;">${lines.join("<br/>")}</p>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeSubject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 28px 14px; color: #0f172a;">
  <div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #cbd5e1; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
    <div style="background: #0f172a; padding: 18px 24px; border-bottom: 2px solid #2563eb;">
      <div style="font-size: 11px; font-weight: 700; color: #60a5fa; letter-spacing: 0.08em; text-transform: uppercase;">OpsPilot Service Desk</div>
      <div style="font-size: 16px; font-weight: 600; color: #ffffff; margin-top: 4px;">${safeSubject}</div>
    </div>
    <div style="padding: 24px 24px 16px 24px; font-size: 14px; color: #334155;">
      ${formattedBlocks}
    </div>
    <div style="padding: 14px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center;">
      Automated operational notification dispatched by OpsPilot Enterprise Service Desk.
    </div>
  </div>
</body>
</html>`;
}

export function createMailer(config: MailerConfig | null): Mailer | null {
  if (!config) return null;

  // When configured for Resend (or using a Resend API key), dispatch directly via
  // Resend HTTPS REST API (Port 443) to avoid cloud firewall restrictions on SMTP ports (25, 465, 587).
  if (config.host === "smtp.resend.com" || config.pass?.startsWith("re_")) {
    const apiKey = config.pass ?? "";
    return {
      async send(input) {
        const html = input.html || formatEmailHtml(input.subject, input.text);
        let recipient = input.to;
        if (config.from.includes("resend.dev") && recipient.includes("+") && recipient.endsWith("@gmail.com")) {
          // In Resend sandbox mode with onboarding@resend.dev, map plus-aliases to the primary sandbox owner inbox
          recipient = recipient.replace(/\+[^@]+@gmail\.com$/, "@gmail.com");
        }

        const payload: Record<string, unknown> = {
          from: config.from,
          to: [recipient],
          subject: input.subject,
          text: input.text,
          html,
        };
        if (config.replyTo) {
          payload.reply_to = config.replyTo;
        }
        if (input.messageId) {
          payload.headers = { "Message-ID": input.messageId };
        }

        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
          const errorMsg = body.message || `Resend API HTTP ${res.status}: ${res.statusText}`;
          const err = new Error(errorMsg);
          if (res.status >= 400 && res.status < 500) {
            // Client errors (e.g. invalid recipient, domain not verified) are permanent failures
            (err as unknown as { responseCode: number }).responseCode = 550;
          }
          throw err;
        }

        const data = (await res.json()) as { id?: string };
        return data.id;
      },
    };
  }

  const transport: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return {
    async send(input) {
      const html = input.html || formatEmailHtml(input.subject, input.text);
      const info = await transport.sendMail({
        from: config.from,
        replyTo: config.replyTo,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html,
        messageId: input.messageId,
      });
      return info.messageId;
    },
  };
}
