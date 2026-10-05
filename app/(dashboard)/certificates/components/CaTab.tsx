"use client";

import { useState } from "react";
import { KeyRound, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
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
import { DeleteCaCertDialog } from "@/components/ca-certificates/CaCertDialogs";
import { paginate } from "@/src/lib/pagination";
import type { CaCertificateView } from "../page";
import { formatDate, timeLeftText } from "../format";
import { HostsCell, type HostLink } from "./HostsCell";
import { ListSearch } from "./ListSearch";

/** The list gets a search field from this many certificate authorities. */
const SEARCH_FROM = 10;

type Props = {
  caCertificates: CaCertificateView[];
  generatedAt: string;
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (ca: CaCertificateView) => void;
  onIssue: (ca: CaCertificateView) => void;
  /** Opens the client certificates the CA issued. */
  onShowClientCertificates: (ca: CaCertificateView) => void;
};

function trustedByLinks(ca: CaCertificateView): HostLink[] {
  return ca.trustedBy.map((host) => ({
    key: String(host.id),
    name: host.name,
    href: `/proxy-hosts?search=${encodeURIComponent(host.domain ?? host.name)}`,
  }));
}

export function CaTab({ caCertificates, generatedAt, canWrite, onAdd, onEdit, onIssue, onShowClientCertificates }: Props) {
  const now = new Date(generatedAt).getTime();
  const { productName } = useBranding();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [deleting, setDeleting] = useState<CaCertificateView | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = q ? caCertificates.filter((ca) => ca.name.toLowerCase().includes(q)) : caCertificates;
  const slice = paginate(filtered, page);

  const menu = (ca: CaCertificateView) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${ca.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canWrite && ca.hasPrivateKey && <DropdownMenuItem onSelect={() => onIssue(ca)}>Issue client certificate</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => onShowClientCertificates(ca)}>Show client certificates</DropdownMenuItem>
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
  );

  const issuedCell = (ca: CaCertificateView) =>
    ca.issued.active + ca.issued.revoked === 0 ? (
      <span className="text-muted-foreground">{ca.hasPrivateKey ? "None issued yet" : `Issued outside ${productName}`}</span>
    ) : (
      <span className="flex flex-col">
        <button
          type="button"
          onClick={() => onShowClientCertificates(ca)}
          className="w-fit text-left text-brand underline-offset-4 hover:text-foreground hover:underline"
        >
          <span className="num">{ca.issued.active}</span> active
        </button>
        {ca.issued.revoked > 0 && <span className="text-xs text-soft">{ca.issued.revoked} revoked</span>}
      </span>
    );

  return (
    <SectionCard title="Certificate authorities" count={caCertificates.length} divided={caCertificates.length < SEARCH_FROM}>
      {caCertificates.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No certificate authorities yet"
          action={
            canWrite ? (
              <Button onClick={onAdd}>
                <Plus />
                Add certificate authority
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {caCertificates.length >= SEARCH_FROM && (
            <div className="flex border-b border-line px-[18px] pb-3">
              <ListSearch
                label="Search certificate authorities"
                placeholder="Name"
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setPage(1);
                }}
                className="max-w-sm"
              />
            </div>
          )}
          {filtered.length === 0 ? (
            <EmptyState compact icon={null} title="No certificate authority matches this search" />
          ) : (
            <>
              <div className="hidden md:block">
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
                    {slice.items.map((ca) => (
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
                        <TableCell>{issuedCell(ca)}</TableCell>
                        <TableCell>
                          <HostsCell
                            hosts={trustedByLinks(ca)}
                            summary={ca.trustedBy.length === 1 ? ca.trustedBy[0].name : undefined}
                            emptyText="No host yet"
                          />
                        </TableCell>
                        <TableCell className="text-right">{menu(ca)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul aria-label="Certificate authorities" className="m-0 flex list-none flex-col p-0 md:hidden">
                {slice.items.map((ca) => (
                  <li key={ca.id} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
                    <div className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
                      <span className="truncate font-semibold text-foreground">{ca.name}</span>
                      <span className="text-xs text-soft">
                        {ca.hasPrivateKey ? "Private key stored" : "Certificate only"}
                        {ca.validTo ? ` · valid until ${formatDate(ca.validTo)}` : ""}
                      </span>
                      <div className="text-xs">{issuedCell(ca)}</div>
                      <div className="text-xs">
                        <HostsCell hosts={trustedByLinks(ca)} emptyText="Trusted by no host yet" />
                      </div>
                    </div>
                    <div className="shrink-0">{menu(ca)}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {slice.pageCount > 1 && (
            <div className="border-t border-line px-[18px] py-2.5">
              <Pagination
                page={slice.page}
                perPage={slice.perPage}
                total={slice.total}
                noun="certificate authorities"
                label="Pages of certificate authorities"
                onPageChange={setPage}
              />
            </div>
          )}
        </>
      )}

      {deleting && <DeleteCaCertDialog open cert={deleting} onClose={() => setDeleting(null)} />}
    </SectionCard>
  );
}
