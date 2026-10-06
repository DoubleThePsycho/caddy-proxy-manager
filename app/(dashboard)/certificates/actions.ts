"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { assertCanCreateCertificate, assertCertificateWritable } from "@/src/lib/access-scope";
import { createCertificate, deleteCertificate, updateCertificate } from "@/src/lib/models/certificates";
import { ApiClientError } from "@/src/lib/api-errors";

function parseDomains(value: FormDataEntryValue | null): string[] {
  if (!value || typeof value !== "string") {
    return [];
  }
  return value
    .replace(/\n/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function createCertificateAction(formData: FormData) {
  const session = await requirePermission("certificates:write");
  assertCanCreateCertificate(session.access);
  const userId = Number(session.user.id);
  const type = String(formData.get("type") ?? "managed") as "managed" | "imported";
  await createCertificate(
    {
      name: String(formData.get("name") ?? "Certificate"),
      type,
      domainNames: parseDomains(formData.get("domain_names")),
      autoRenew: type === "managed" ? formData.get("auto_renew") === "on" : false,
      certificatePem: type === "imported" ? String(formData.get("certificate_pem") ?? "") : null,
      privateKeyPem: type === "imported" ? String(formData.get("private_key_pem") ?? "") : null
    },
    userId
  );
  revalidatePath("/certificates");
}

export async function updateCertificateAction(id: number, formData: FormData) {
  const session = await requirePermission("certificates:write");
  await assertCertificateWritable(session.access, id);
  const userId = Number(session.user.id);
  const type = formData.get("type") ? (String(formData.get("type")) as "managed" | "imported") : undefined;
  await updateCertificate(
    id,
    {
      name: formData.get("name") ? String(formData.get("name")) : undefined,
      type,
      domainNames: formData.get("domain_names") ? parseDomains(formData.get("domain_names")) : undefined,
      autoRenew: formData.has("auto_renew_present") ? formData.get("auto_renew") === "on" : undefined,
      certificatePem: formData.get("certificate_pem") ? String(formData.get("certificate_pem")) : undefined,
      privateKeyPem: formData.get("private_key_pem") ? String(formData.get("private_key_pem")) : undefined
    },
    userId
  );
  revalidatePath("/certificates");
}

/** Errors the person can act on come back as `error` (a thrown message would not reach the browser in production). */
export async function deleteCertificateAction(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requirePermission("certificates:write");
  await assertCertificateWritable(session.access, id);
  const userId = Number(session.user.id);
  try {
    await deleteCertificate(id, userId);
  } catch (error) {
    if (error instanceof ApiClientError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/certificates");
  return { ok: true };
}
