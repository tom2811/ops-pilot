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
  send(input: { to: string; subject: string; text: string; messageId?: string }): Promise<string | undefined>;
};

export function createMailer(config: MailerConfig | null): Mailer | null {
  if (!config) return null;

  // When configured for Resend (or using a Resend API key), dispatch directly via
  // Resend HTTPS REST API (Port 443) to avoid cloud firewall restrictions on SMTP ports (25, 465, 587).
  if (config.host === "smtp.resend.com" || config.pass?.startsWith("re_")) {
    const apiKey = config.pass ?? "";
    return {
      async send(input) {
        const payload: Record<string, unknown> = {
          from: config.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
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
      const info = await transport.sendMail({
        from: config.from,
        replyTo: config.replyTo,
        to: input.to,
        subject: input.subject,
        text: input.text,
        messageId: input.messageId,
      });
      return info.messageId;
    },
  };
}
