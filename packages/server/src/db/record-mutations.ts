import type { RecordMutationEvent } from "@lastsaas/shared";
import { executeRecordTriggers } from "../triggers/execute";
import type { GrantRecord } from "./resource-grants";
import type { UnitOfWork } from "./unit-of-work";
import { appendRecordHistory } from "./record-history-storage";

/** Internal full snapshots, including metadata used by source row conditions. */
export interface MutationSnapshots {
  before: GrantRecord | null;
  after: GrantRecord | null;
}

/** Every publisher joins the source transaction. Never swallow persistence errors. */
export async function publishRecordMutation(
  context: UnitOfWork,
  orgId: string,
  event: RecordMutationEvent,
  snapshots: MutationSnapshots,
  collectionId: string,
  actorId: string,
): Promise<void> {
  await appendRecordHistory(
    context,
    orgId,
    collectionId,
    event.record_id,
    actorId,
    event.event,
    snapshots,
  );
  await executeRecordTriggers(context, orgId, event, snapshots);
}
