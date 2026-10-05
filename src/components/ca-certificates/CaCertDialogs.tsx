"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Download } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { CaCertificate } from "@/lib/models/ca-certificates";
import { deleteCaCertificateAction, issueClientCertificateAction } from "@/app/(dashboard)/certificates/ca-actions";

function downloadFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function sanitizeFilenameSegment(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "client";
}

export function IssueClientCertDialog({
  open,
  cert,
  onClose,
}: {
  open: boolean;
  cert: CaCertificate;
  onClose: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [issued, setIssued] = useState<{ pkcs12Base64: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function handleClose() {
    setIssued(null);
    setError(null);
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const formData = new FormData(formRef.current!);
    setError(null);
    startTransition(async () => {
      try {
        const result = await issueClientCertificateAction(cert.id, formData);
        if ("error" in result) {
          setError(result.error);
          return;
        }
        setIssued({
          pkcs12Base64: result.pkcs12Base64,
          name: sanitizeFilenameSegment(String(formData.get("common_name") ?? "client")),
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to issue certificate");
      }
    });
  }

  const actions = issued ? (
    <Button onClick={handleClose}>Done</Button>
  ) : (
    <>
      <Button variant="outline" onClick={handleClose} disabled={isPending}>
        Cancel
      </Button>
      <Button type="submit" form="issue-cert-form" disabled={isPending}>
        {isPending ? "Issuing…" : "Issue certificate"}
      </Button>
    </>
  );

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="Issue client certificate"
      maxWidth="sm"
      actions={actions}
    >
      {issued ? (
        <div className="flex flex-col gap-4">
          <Alert>
            <AlertDescription>
              Download the .p12 bundle now. The private key is not stored, so it cannot be downloaded again.
            </AlertDescription>
          </Alert>
          <Button
            variant="outline"
            onClick={() =>
              downloadFile(
                `${issued.name}.p12`,
                new Blob([decodeBase64(issued.pkcs12Base64)], { type: "application/x-pkcs12" })
              )
            }
          >
            <Download className="mr-2 h-4 w-4" />
            Download client certificate (.p12)
          </Button>
        </div>
      ) : (
        <form id="issue-cert-form" ref={formRef} onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="common_name">Common name (CN)</Label>
              <Input
                id="common_name"
                name="common_name"
                required
                autoFocus
                placeholder="alice"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="validity_days">Validity</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="validity_days"
                  name="validity_days"
                  type="number"
                  defaultValue={365}
                  min={1}
                  max={3650}
                  className="flex-1"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="export_password">Export password</Label>
              <Input
                id="export_password"
                name="export_password"
                type="password"
                required
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="compatibility_mode" name="compatibility_mode" defaultChecked />
              <Label htmlFor="compatibility_mode">Compatibility mode (3DES)</Label>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </form>
      )}
    </AppDialog>
  );
}

export function DeleteCaCertDialog({
  open,
  cert,
  onClose,
}: {
  open: boolean;
  cert: CaCertificate;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteCaCertificateAction(cert.id);
      if (result.success) {
        onClose();
      } else {
        setError(result.error ?? "Failed to delete");
      }
    });
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Delete certificate authority"
      maxWidth="sm"
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Delete the certificate authority <strong className="text-foreground">{cert.name}</strong>? This cannot be undone.
          The client certificates it issued are deleted with it and leave their roles.
        </p>
        <p className="text-sm text-muted-foreground">
          A certificate authority cannot be deleted while a proxy host&apos;s mutual TLS trusts it, one of its client
          certificates or a role holding one: change those hosts first.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </AppDialog>
  );
}
