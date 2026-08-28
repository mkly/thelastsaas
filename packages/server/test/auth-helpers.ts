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
