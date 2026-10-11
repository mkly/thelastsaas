import type { AppServices } from "../src/services";

export async function verifyTestUser(
  services: AppServices,
  email: string,
): Promise<void> {
  await services.prisma.user.update({
    where: { email },
    data: { emailVerified: true },
  });
}

// For route fixtures that do not exercise signup/login. The stored session still
// passes through the real BetterAuth bearer plugin and application middleware.
export async function seedTestSession(
  services: AppServices,
  email: string,
  name: string,
): Promise<string> {
  const token = crypto.randomUUID();
  await services.prisma.user.create({
    data: {
      id: crypto.randomUUID(),
      email,
      name,
      emailVerified: true,
      sessions: {
        create: {
          id: crypto.randomUUID(),
          token,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          userAgent: "lastsaas-cli",
        },
      },
    },
  });
  return token;
}
