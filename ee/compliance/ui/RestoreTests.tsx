// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/components/preferences/PreferencesProvider";
import type { RestoreOutcome, RestoreSource, RestoreTestView } from "../restore-tests";
import { RESTORE_OUTCOME_LABELS, RESTORE_OUTCOME_TONE, RESTORE_SOURCE_LABELS } from "./format";
import { callApi, Field, fromLocalInput, toLocalInput } from "./shared";

const SOURCES: RestoreSource[] = ["backup", "snapshot", "export", "other"];
const OUTCOMES: RestoreOutcome[] = ["success", "partial", "failed"];
const NO_DESTINATION = "none";

type Form = { testedAt: string; source: RestoreSource; outcome: RestoreOutcome; destination: string; objectKey: string; notes: string };

function emptyForm(): Form {
  return { testedAt: toLocalInput(new Date().toISOString()), source: "backup", outcome: "success", destination: NO_DESTINATION, objectKey: "", notes: "" };
}

/** Test restores recorded as evidence that backups can be restored. */
export default function RestoreTests({
  initial,
  destinations,
  canWrite,
}: {
  /** A page of the test restores, newest first (?restorePage=). */
  initial: { tests: RestoreTestView[]; total: number; page: number; perPage: number };
  destinations: { id: number; name: string }[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const format = useFormat();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RestoreTestView | null>(null);
  const { hrefFor } = useUrlPage("restorePage");

  function openForm() {
    setForm(emptyForm());
    setError(null);
    setOpen(true);
  }

  function record() {
    const testedAt = fromLocalInput(form.testedAt);
    if (!testedAt) {
      setError("Enter when the test restore was made.");
      return;
    }
    const body: Record<string, unknown> = { testedAt, source: form.source, outcome: form.outcome };
    if (form.source === "backup" && form.destination !== NO_DESTINATION) body.backupDestinationId = Number(form.destination);
    if (form.objectKey.trim()) body.backupObjectKey = form.objectKey.trim();
    if (form.notes.trim()) body.notes = form.notes.trim();
    startTransition(async () => {
      try {
        await callApi("/restore-tests", "POST", body);
        toast.success("Test restore recorded");
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function remove() {
    const test = deleting;
    if (!test) return;
    startTransition(async () => {
      try {
        await callApi(`/restore-tests/${test.id}`, "DELETE");
        toast.success("Test restore deleted");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setDeleting(null);
      router.refresh();
    });
  }

  return (
    <SectionCard
      id="restore-tests"
      title="Test restores"
      count={initial.total}
      footer={
        initial.total > initial.perPage ? (
          <Pagination page={initial.page} perPage={initial.perPage} total={initial.total} noun="test restores" label="Pages of test restores" hrefFor={hrefFor} />
        ) : undefined
      }
      actions={
        canWrite && (
          <Button variant="secondary" size="sm" onClick={openForm}>
            <Plus />
            Record a test restore
          </Button>
        )
      }
    >
      {initial.tests.length === 0 ? (
        <EmptyState compact title="No test restore recorded yet" description="Restore a backup on a spare instance, then record it here." />
      ) : (
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Tested</TableHead>
              <TableHead scope="col">Restored from</TableHead>
              <TableHead scope="col">Outcome</TableHead>
              <TableHead scope="col">Notes</TableHead>
              <TableHead scope="col">Recorded by</TableHead>
              {canWrite && (
                <TableHead scope="col" className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.tests.map((test) => (
              <TableRow key={test.id} className="align-top">
                <TableCell className="num whitespace-nowrap align-top">{format.dateTime(test.testedAt)}</TableCell>
                <TableCell className="align-top">
                  <span className="flex flex-col gap-0.5">
                    <span>{RESTORE_SOURCE_LABELS[test.source]}</span>
                    {(test.backupDestination || test.backupObjectKey) && (
                      <span className="text-xs text-soft [overflow-wrap:anywhere]">
                        {test.backupDestination ? test.backupDestination.name ?? `Destination #${test.backupDestination.id}` : ""}
                        {test.backupDestination && test.backupObjectKey ? " · " : ""}
                        {test.backupObjectKey && <span className="num">{test.backupObjectKey}</span>}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="align-top">
                  <StatusDot tone={RESTORE_OUTCOME_TONE[test.outcome]} label={RESTORE_OUTCOME_LABELS[test.outcome]} />
                </TableCell>
                <TableCell className="max-w-[360px] align-top whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]">{test.notes ?? "—"}</TableCell>
                <TableCell className="align-top">{test.recordedBy.name ?? (test.recordedBy.userId ? `User #${test.recordedBy.userId}` : "System")}</TableCell>
                {canWrite && (
                  <TableCell className="align-top">
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete the test restore of ${format.dateTime(test.testedAt)}`} title="Delete" onClick={() => setDeleting(test)}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AppDialog open={open} onClose={() => setOpen(false)} title="Record a test restore" maxWidth="md" submitLabel="Record" onSubmit={record} isSubmitting={pending}>
        <div className="flex flex-col gap-4">
          <Field label="Tested at (your time zone)" htmlFor="restore-tested-at">
            <Input id="restore-tested-at" type="datetime-local" value={form.testedAt} onChange={(event) => setForm({ ...form, testedAt: event.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Restored from" htmlFor="restore-source">
              <Select value={form.source} onValueChange={(value) => setForm({ ...form, source: value as RestoreSource })}>
                <SelectTrigger id="restore-source" aria-label="Restored from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {RESTORE_SOURCE_LABELS[source]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Outcome" htmlFor="restore-outcome">
              <Select value={form.outcome} onValueChange={(value) => setForm({ ...form, outcome: value as RestoreOutcome })}>
                <SelectTrigger id="restore-outcome" aria-label="Outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTCOMES.map((outcome) => (
                    <SelectItem key={outcome} value={outcome}>
                      {RESTORE_OUTCOME_LABELS[outcome]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {form.source === "backup" && destinations.length > 0 && (
            <Field label="Backup destination (optional)" htmlFor="restore-destination">
              <Select value={form.destination} onValueChange={(value) => setForm({ ...form, destination: value })}>
                <SelectTrigger id="restore-destination" aria-label="Backup destination">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DESTINATION}>Not named</SelectItem>
                  {destinations.map((destination) => (
                    <SelectItem key={destination.id} value={String(destination.id)}>
                      {destination.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Backup object or file (optional)" htmlFor="restore-object" hint="The object key or file name that was restored.">
            <Input id="restore-object" value={form.objectKey} maxLength={512} onChange={(event) => setForm({ ...form, objectKey: event.target.value })} />
          </Field>
          <Field label="Notes (optional)" htmlFor="restore-notes" hint="What was checked after the restore, and anything that did not work.">
            <Textarea id="restore-notes" rows={3} maxLength={2000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </Field>
          {error && (
            <Banner tone="bad" live>
              {error}
            </Banner>
          )}
        </div>
      </AppDialog>

      <AppDialog open={deleting !== null} onClose={() => setDeleting(null)} title="Delete test restore" submitLabel="Delete" onSubmit={remove} isSubmitting={pending}>
        <p className="text-sm">The backup control then uses the next newest test restore.</p>
      </AppDialog>
    </SectionCard>
  );
}
