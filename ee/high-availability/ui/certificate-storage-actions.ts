// SPDX-License-Identifier: Elastic-2.0
"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/src/lib/auth";
import { ApiClientError } from "@/src/lib/api-errors";
import {
  CertificateStorageApplyError,
  removeCertificateStorage,
  saveCertificateStorage,
  testCertificateStorage,
} from "@/ee/high-availability/service";
import type { CertificateStorageActionResult, CertificateStorageTestActionResult } from "@/ee/high-availability/types";

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof ApiClientError || error instanceof CertificateStorageApplyError) return { ok: false, error: error.message };
  throw error;
}

export async function saveCertificateStorageAction(input: unknown): Promise<CertificateStorageActionResult> {
  const session = await requirePermission("high_availability:write");
  try {
    const view = await saveCertificateStorage(input, Number(session.user.id));
    revalidatePath("/certificates/settings");
    revalidatePath("/high-availability");
    return { ok: true, view };
  } catch (error) {
    return failure(error);
  }
}

export async function removeCertificateStorageAction(): Promise<CertificateStorageActionResult> {
  const session = await requirePermission("high_availability:write");
  try {
    const view = await removeCertificateStorage(Number(session.user.id));
    revalidatePath("/certificates/settings");
    revalidatePath("/high-availability");
    return { ok: true, view };
  } catch (error) {
    return failure(error);
  }
}

export async function testCertificateStorageAction(input: unknown): Promise<CertificateStorageTestActionResult> {
  const session = await requirePermission("high_availability:write");
  try {
    return { ok: true, result: await testCertificateStorage(input, Number(session.user.id)) };
  } catch (error) {
    return failure(error);
  }
}
