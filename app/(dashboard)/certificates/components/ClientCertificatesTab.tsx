"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { BadgeCheck, ChevronDown } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { revokeIssuedClientCertificateAction } from "../ca-actions";
import type { CaCertificateView, IssuedClientCertificateView, MtlsRoleView } from "../page";
import { formatDate, formatShortDate, timeLeftText } from "../format";
import { MtlsRoles } from "./MtlsRoles";

const DAY_MS = 86_400_000;

type Props = {
  clientCertificates: IssuedClientCertificateView[];
  roles: MtlsRoleView[];
  caCertificates: CaCertificateView[];
  generatedAt: string;
  canWrite: boolean;
  onIssue: (ca: CaCertificateView) => void;
};

/**
 * The "Issue client certificate" button: a menu of the certificate
 * authorities whose private key is stored (only those can sign).
 */
export function IssueClientCertificateMenu({
  caCertificates,
  onIssue,
  variant = "default",
}: {
  caCertificates: CaCertificateView[];
  onIssue: (ca: CaCertificateView) => void;
  variant?: "default" | "outline";
}) {
  const signers = caCertificates.filter((ca) => ca.hasPrivateKey);
  if (signers.length === 0) {
    return (
      <Button variant={variant} disabled title="Add a certificate authority with a stored private key first">
        Issue client certificate
      </Button>
    );
  }
  if (signers.length === 1) {
    return (
      <Button variant={variant} onClick={() => onIssue(signers[0])}>
        Issue client certificate
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant}>
          Issue client certificate
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Signed by</DropdownMenuLabel>
        {signers.map((ca) => (
          <DropdownMenuItem key={ca.id} onSelect={() => onIssue(ca)}>
            {ca.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ClientCertificatesTab({ clientCertificates, roles, caCertificates, generatedAt, canWrite, onIssue }: Props) {
  const now = new Date(generatedAt).getTime();
  const [revoking, setRevoking] = useState<IssuedClientCertificateView | null>(null);
  // Active first, soonest expiry first; revoked at the end.
  const sorted = [...clientCertificates].sort(
    (a, b) => Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt)) || a.validTo.localeCompare(b.validTo)
  );

  return (
    <div className="flex flex-col gap-4">
      <MtlsRoles roles={roles} clientCertificates={clientCertificates} canWrite={canWrite} />

      <SectionCard title="Client certificates" count={clientCertificates.length}>
        {clientCertificates.length === 0 ? (
          <EmptyState
            compact
            icon={BadgeCheck}
            title="No client certificates yet"
            description="Issue one from a certificate authority whose private key is stored here; the browser downloads it as a .p12 bundle."
            action={
              canWrite ? <IssueClientCertificateMenu caCertificates={caCertificates} onIssue={onIssue} variant="outline" /> : undefined
            }
          />
        ) : (
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Common name</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col">Issued by</TableHead>
                <TableHead scope="col">Expires</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col" className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((cert) => {
                const validTo = new Date(cert.validTo).getTime();
                const expired = validTo <= now;
                const soon = !expired && validTo - now < 90 * DAY_MS;
                return (
                  <TableRow key={cert.id} className={cn(cert.revokedAt && "opacity-70")}>
                    <th scope="row" className="num px-3 py-2.5 text-left align-middle font-normal text-foreground first:pl-4">
                      {cert.commonName}
                    </th>
                    <TableCell className={cn(cert.roles.length === 0 && "text-soft")}>
                      {cert.roles.length > 0 ? cert.roles.join(", ") : "–"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{cert.caName ?? "Unknown"}</TableCell>
                    <TableCell className={cn(cert.revokedAt && "text-soft")}>
                      {soon && !cert.revokedAt ? (
                        <span className="flex flex-col">
                          <span>{formatDate(cert.validTo)}</span>
                          <span className="num text-xs text-soft">{timeLeftText(cert.validTo, now)}</span>
                        </span>
                      ) : (
                        formatDate(cert.validTo)
                      )}
                    </TableCell>
                    <TableCell>
                      {cert.revokedAt ? (
                        <StatusDot tone="off" label={`Revoked ${formatShortDate(cert.revokedAt)}`} />
                      ) : expired ? (
                        <StatusDot tone="bad" label="Expired" />
                      ) : (
                        <StatusDot tone="ok" label="Active" />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canWrite && !cert.revokedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-bad hover:text-bad"
                          aria-label={`Revoke ${cert.commonName}`}
                          onClick={() => setRevoking(cert)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {revoking && <RevokeDialog cert={revoking} onClose={() => setRevoking(null)} />}
    </div>
  );
}

function RevokeDialog({ cert, onClose }: { cert: IssuedClientCertificateView; onClose: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function revoke() {
    setError(null);
    startTransition(async () => {
      try {
        await revokeIssuedClientCertificateAction(cert.id);
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke the certificate");
      }
    });
  }

  return (
    <AppDialog
      open
      onClose={() => {
        if (!isPending) onClose();
      }}
      title="Revoke client certificate"
      maxWidth="sm"
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={revoke} disabled={isPending}>
            {isPending ? "Revoking…" : "Revoke certificate"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm text-muted-foreground">
          Revoke <strong className="num text-foreground">{cert.commonName}</strong>? Proxy hosts stop accepting it at once. This
          cannot be undone; issue a new certificate to let the client back in.
        </p>
        {error && <p className="m-0 text-sm text-bad">{error}</p>}
      </div>
    </AppDialog>
  );
}
