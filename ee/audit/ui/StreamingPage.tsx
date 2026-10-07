// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { listAuditSinks } from "@/ee/audit/sinks";
import { getAuditRetention } from "@/ee/audit/retention";
import StreamingClient from "./StreamingClient";

export const metadata = { title: "Audit streaming" };

export default async function AuditStreamingPage() {
  await requirePermission("audit_streaming:read");
  const [sinks, retention] = await Promise.all([listAuditSinks(), getAuditRetention()]);
  return <StreamingClient sinks={sinks} retention={retention} generatedAt={new Date().toISOString()} />;
}
