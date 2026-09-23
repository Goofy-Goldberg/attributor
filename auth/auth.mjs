import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, emailOTP, genericOAuth, jwt } from "better-auth/plugins";
import nodemailer from "nodemailer";
import pg from "pg";

import { emailDomainAllowed, identityAllowed } from "./policy.mjs";

const devMode = process.env.AUTH_DEV_MODE === "true";
function developmentSecret() {
  const path = process.env.AUTH_DEV_SECRET_FILE || "./.dev-secret";
  mkdirSync(dirname(path), { recursive: true });
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const generated = randomBytes(32).toString("hex");
    try {
      writeFileSync(path, generated, { flag: "wx", mode: 0o600 });
      return generated;
    } catch (writeError) {
      if (writeError.code === "EEXIST") {
        return readFileSync(path, "utf8").trim();
      }
      throw writeError;
    }
  }
}

const secret = process.env.BETTER_AUTH_SECRET || (devMode ? developmentSecret() : "");
const baseURL = process.env.BETTER_AUTH_URL || (devMode ? "http://localhost:5173" : "");
if (!secret || !baseURL || !process.env.DATABASE_URL) {
  throw new Error("BETTER_AUTH_SECRET, BETTER_AUTH_URL, and DATABASE_URL are required.");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=auth",
});

const mailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      requireTLS: process.env.SMTP_STARTTLS !== "false" && process.env.SMTP_SECURE !== "true",
      auth: process.env.SMTP_USERNAME
        ? { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD || "" }
        : undefined,
    })
  : null;

async function sendCode(email, otp) {
  if (!mailTransport) {
    throw new Error("Sign-in email is not configured.");
  }
  await mailTransport.sendMail({
    from: process.env.AUTH_MAIL_FROM || process.env.ALERT_EMAIL_FROM || "IP Intel <no-reply@stratc.org>",
    to: email,
    subject: "Your IP Intel sign-in code",
    text: `Your IP Intel sign-in code is ${otp}. It expires in 5 minutes. If you did not request it, ignore this email.`,
  });
}

const mattermostSettings = [
  process.env.MATTERMOST_URL,
  process.env.MATTERMOST_OAUTH_CLIENT_ID,
  process.env.MATTERMOST_OAUTH_CLIENT_SECRET,
];
if (mattermostSettings.some(Boolean) && !mattermostSettings.every(Boolean)) {
  throw new Error("Set all Mattermost OAuth settings together, or leave all unset.");
}
const mattermostURL = mattermostSettings.every(Boolean)
  ? process.env.MATTERMOST_URL.replace(/\/$/, "")
  : null;

const plugins = [
  admin({ defaultRole: "user" }),
  emailOTP({
    async sendVerificationOTP({ email, otp, type }) {
      if (type !== "sign-in" || !emailDomainAllowed(email)) {
        throw new APIError("FORBIDDEN", { message: "Use a permitted work email address." });
      }
      await sendCode(email, otp);
    },
    expiresIn: 300,
    allowedAttempts: 3,
    storeOTP: "hashed",
  }),
  jwt({
    jwt: {
      expirationTime: "15m",
      definePayload: ({ user }) => ({ id: user.id, email: user.email, role: user.role || "user" }),
    },
  }),
];

if (mattermostURL) {
  plugins.push(
    genericOAuth({
      config: [
        {
          providerId: "mattermost",
          clientId: process.env.MATTERMOST_OAUTH_CLIENT_ID,
          clientSecret: process.env.MATTERMOST_OAUTH_CLIENT_SECRET,
          authorizationUrl: `${mattermostURL}/oauth/authorize`,
          tokenUrl: `${mattermostURL}/oauth/access_token`,
          userInfoUrl: `${mattermostURL}/api/v4/users/me`,
          authentication: "post",
          pkce: true,
          async getUserInfo(tokens) {
            const response = await fetch(`${mattermostURL}/api/v4/users/me`, {
              headers: { Authorization: `Bearer ${tokens.accessToken}` },
            });
            if (!response.ok) {
              return null;
            }
            const user = await response.json();
            if (!user.id || !user.email || user.delete_at) {
              return null;
            }
            return {
              id: user.id,
              email: user.email,
              name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username,
              // Mattermost authenticated this account. We do not implicitly
              // link it to an existing IP Intel user with the same email.
              emailVerified: true,
            };
          },
        },
      ],
    }),
  );
}

export const auth = betterAuth({
  baseURL,
  secret,
  database: pool,
  advanced: { database: { validateSchema: false } },
  account: { accountLinking: { disableImplicitLinking: true } },
  user: { validateUserInfo: identityAllowed },
  hooks: {
    before: createAuthMiddleware((ctx) => {
      if (
        (ctx.path === "/email-otp/send-verification-otp" || ctx.path === "/sign-in/email-otp") &&
        !emailDomainAllowed(ctx.body?.email)
      ) {
        throw new APIError("FORBIDDEN", { message: "Use a permitted work email address." });
      }
    }),
  },
  plugins,
});

export const mattermostEnabled = Boolean(mattermostURL);
