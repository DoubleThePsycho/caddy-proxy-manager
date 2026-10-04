// SPDX-License-Identifier: Elastic-2.0
import { requirePermission } from "@/src/lib/auth";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { listAuditSinks } from "@/ee/audit/sinks";
import { getAuditRetention } from "@/ee/audit/retention";
import StreamingClient from "./StreamingClient";

export const metadata = { title: "Audit streaming" };

export default async function AuditStreamingPage() {
  await requirePermission("audit_streaming:read");
  const [sinks, retention, licensed] = await Promise.all([
    listAuditSinks(),
    getAuditRetention(),
    isFeatureConfigurable("audit_streaming"),
  ]);
  return <StreamingClient sinks={sinks} retention={retention} licensed={licensed} generatedAt={new Date().toISOString()} />;
}
