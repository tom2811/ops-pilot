import type { FastifyInstance } from "fastify";
import { loginSchema } from "@opspilot/core";
import { verifyPassword } from "@opspilot/core/password";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getLoginUser,
  getMemberships,
  getSessionUser,
  requireAuth,
  setSessionCookie,
} from "../auth.js";
import { AppError } from "../errors.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const user = await getLoginUser(input.email.toLowerCase());
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new AppError(401, "Invalid email or password");
    }

    const session = await createSession(user.id);
    setSessionCookie(reply, session.token, session.expiresAt);
    const memberships = await getMemberships(user.id);
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      memberships,
    };
  });

  app.post("/logout", async (req, reply) => {
    await deleteSession(req);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/me", { preHandler: requireAuth }, async (req) => {
    const user = req.authUser;
    if (!user) throw new AppError(401, "Unauthorized");
    return { user, memberships: await getMemberships(user.id) };
  });
}
