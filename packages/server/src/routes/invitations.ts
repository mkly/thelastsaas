import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnvironment } from "../env";
import { requirePermission } from "../middleware/permission";

const createInvitationSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(["admin", "member"]).default("member"),
  })
  .strict();
const invitationActionSchema = z
  .object({ invitation_id: z.string().min(1) })
  .strict();

function invalidRequest(message: string) {
  return errorResponse("InvalidRequest", message);
}

function validationMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const manageMembers = requirePermission("manage", () => "/members");

export const invitationRouter = new Hono<AppEnvironment>()
  .post("/", manageMembers, async (context) => {
    const parsed = createInvitationSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    try {
      const invitation = await context
        .get("services")
        .auth.api.createInvitation({
          body: {
            ...parsed.data,
            organizationId: context.get("orgId"),
          },
          headers: context.req.raw.headers,
        });
      await context.get("audit")(
        "create_invitation",
        "invitation",
        invitation.id,
        { email: parsed.data.email, role: parsed.data.role },
      );
      return context.json(
        {
          status: "ok" as const,
          invitation_id: invitation.id,
          email: parsed.data.email,
          role: parsed.data.role,
        },
        201,
      );
    } catch (error) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          failureMessage(error, "Failed to create invitation"),
        ),
        400,
      );
    }
  })
  .get("/", manageMembers, async (context) => {
    const invitations = await context
      .get("services")
      .prisma.invitation.findMany({
        where: { organizationId: context.get("orgId"), status: "pending" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });
    return context.json({ status: "ok" as const, invitations });
  })
  .post("/accept", async (context) => {
    const parsed = invitationActionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const invitation = await prisma.invitation.findUnique({
      where: { id: parsed.data.invitation_id },
      select: { organizationId: true, role: true, status: true },
    });
    if (
      !invitation ||
      invitation.organizationId !== orgId ||
      invitation.status !== "pending"
    ) {
      return context.json(
        errorResponse("NotFound", "Invitation not found"),
        404,
      );
    }

    try {
      await context.get("services").auth.api.acceptInvitation({
        body: { invitationId: parsed.data.invitation_id },
        headers: context.req.raw.headers,
      });
    } catch (error) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          failureMessage(error, "Failed to accept invitation"),
        ),
        400,
      );
    }

    return context.json({ status: "ok" as const });
  })
  .post("/cancel", manageMembers, async (context) => {
    const parsed = invitationActionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const invitation = await context
      .get("services")
      .prisma.invitation.findUnique({
        where: { id: parsed.data.invitation_id },
        select: { organizationId: true, status: true },
      });
    if (
      !invitation ||
      invitation.organizationId !== orgId ||
      invitation.status !== "pending"
    ) {
      return context.json(
        errorResponse("NotFound", "Invitation not found"),
        404,
      );
    }

    try {
      await context.get("services").auth.api.cancelInvitation({
        body: { invitationId: parsed.data.invitation_id },
        headers: context.req.raw.headers,
      });
    } catch (error) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          failureMessage(error, "Failed to cancel invitation"),
        ),
        400,
      );
    }

    await context.get("audit")(
      "cancel_invitation",
      "invitation",
      parsed.data.invitation_id,
      {},
    );
    return context.json({ status: "ok" as const });
  });
