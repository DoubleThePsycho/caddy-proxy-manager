"use client";

import { useState } from "react";
import { KeyRound, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import {
  DeleteCaCertDialog,
  IssueClientCertDialog,
  ManageIssuedClientCertsDialog,
} from "@/components/ca-certificates/CaCertDialogs";
import type { CaCertificateView } from "../page";
import { formatDate, timeLeftText } from "../format";
import { HostsCell } from "./HostsCell";

type Props = {
  caCertificates: CaCertificateView[];
  generatedAt: string;
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (ca: CaCertificateView) => void;
};

export function CaTab({ caCertificates, generatedAt, canWrite, onAdd, onEdit }: Props) {
  const now = new Date(generatedAt).getTime();
  const { productName } = useBranding();
  const [issueFor, setIssueFor] = useState<CaCertificateView | null>(null);
  const [manageFor, setManageFor] = useState<CaCertificateView | null>(null);
  const [deleting, setDeleting] = useState<CaCertificateView | null>(null);

  return (
    <SectionCard
      title="Certificate authorities for client certificates"
      description="Generate a CA here to issue client certificates, or import a CA's certificate so the clients it signs are trusted."
    >
      {caCertificates.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No certificate authorities yet"
          description="A certificate authority signs the client certificates that mutual TLS on a proxy host asks for."
          action={canWrite ? <Button onClick={onAdd}>Add certificate authority</Button> : undefined}
        />
      ) : (
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Private key</TableHead>
              <TableHead scope="col">Valid until</TableHead>
              <TableHead scope="col">Client certificates</TableHead>
              <TableHead scope="col">Trusted by</TableHead>
              <TableHead scope="col" className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {caCertificates.map((ca) => {
              const active = ca.issuedCerts.filter((cert) => !cert.revokedAt).length;
              const revoked = ca.issuedCerts.length - active;
              return (
                <TableRow key={ca.id}>
                  <th scope="row" className="px-3 py-3 text-left align-middle font-normal first:pl-4">
                    <span className="flex flex-col">
                      <span className="font-semibold text-foreground">{ca.name}</span>
                      <span className="text-xs text-soft">Added {formatDate(ca.createdAt)}</span>
                    </span>
                  </th>
                  <TableCell>
                    {ca.hasPrivateKey ? (
                      <StatusDot tone="ok" label="Stored, encrypted" />
                    ) : (
                      <span className="text-muted-foreground">None, certificate only</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {ca.validTo ? (
                      <span className="flex flex-col">
                        <span>{formatDate(ca.validTo)}</span>
                        <span className="num text-xs text-soft">{timeLeftText(ca.validTo, now)}</span>
                      </span>
                    ) : (
                      <span className="text-soft">Unknown</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {ca.issuedCerts.length === 0 ? (
                      <span className="text-muted-foreground">
                        {ca.hasPrivateKey ? "None issued yet" : `Issued outside ${productName}`}
                      </span>
                    ) : (
                      <span className="flex flex-col">
                        <span>
                          <span className="num">{active}</span> active
                        </span>
                        {revoked > 0 && <span className="text-xs text-soft">{revoked} revoked</span>}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <HostsCell
                      hosts={ca.trustedBy.map((host) => ({
                        key: String(host.id),
                        name: host.name,
                        href: `/proxy-hosts?search=${encodeURIComponent(host.domain ?? host.name)}`,
                      }))}
                      summary={ca.trustedBy.length === 1 ? ca.trustedBy[0].name : undefined}
                      emptyText="No host yet"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${ca.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canWrite && ca.hasPrivateKey && (
                          <DropdownMenuItem onSelect={() => setIssueFor(ca)}>Issue client certificate</DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => setManageFor(ca)}>Issued certificates</DropdownMenuItem>
                        {canWrite && (
                          <>
                            <DropdownMenuItem onSelect={() => onEdit(ca)}>Edit</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setDeleting(ca)}>
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {issueFor && <IssueClientCertDialog open cert={issueFor} onClose={() => setIssueFor(null)} />}
      {manageFor && (
        <ManageIssuedClientCertsDialog
          open
          cert={manageFor}
          issuedCerts={caCertificates.find((ca) => ca.id === manageFor.id)?.issuedCerts ?? manageFor.issuedCerts}
          onClose={() => setManageFor(null)}
        />
      )}
      {deleting && <DeleteCaCertDialog open cert={deleting} onClose={() => setDeleting(null)} />}
    </SectionCard>
  );
}
