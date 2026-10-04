// SPDX-License-Identifier: Elastic-2.0
import { logAuditEvent } from "@/src/lib/audit";
import { ChannelSecretsUnavailableError, getChannelRowForTest, recordChannelDelivery, resolveChannel } from "./channels";
import { deliverToChannel, type DeliveryResult } from "./deliver";
import { testNotification } from "./format";
import { CHANNEL_TYPE_LABELS, isChannelType } from "./types";

/**
 * Sends a test notification. Part of setting a channel up, so it needs the
 * license for paid channel types (e-mail channels are Community).
 */
export async function testAlertChannel(id: number, actorUserId: number): Promise<DeliveryResult> {
  const row = await getChannelRowForTest(id);
  let result: DeliveryResult;
  try {
    result = await deliverToChannel(resolveChannel(row), testNotification());
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof ChannelSecretsUnavailableError ? error.message : "The test notification could not be sent",
    };
  }
  await recordChannelDelivery(row.id, result.error);
  await logAuditEvent({
    userId: actorUserId,
    action: "alert_channel_tested",
    entityType: "alert_channel",
    entityId: row.id,
    summary: `Sent a test notification to ${isChannelType(row.type) ? CHANNEL_TYPE_LABELS[row.type] : row.type} alert channel "${row.name}": ${result.ok ? "delivered" : "failed"}`,
    data: { ok: result.ok },
  });
  return result;
}
