import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Alert } from "@connected-repo/ui-mui/feedback/Alert";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Card } from "@connected-repo/ui-mui/layout/Card";
import { Container } from "@connected-repo/ui-mui/layout/Container";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { env } from "@frontend/configs/env.config";
import { TextField } from "@mui/material";
import { useCallback, useEffect, useState } from "react";

/**
 * H11 (first slice) — the factory cockpit: the Yantra app showing its own
 * harness working on it (tenant-zero). Reads the super-admin yantra.* routes
 * (H10) over plain authed fetch — the super-admin surface is an OpenAPI
 * handler, not the user-app RPC link. 30 s poll; realtime is Phase 4.
 *
 * Gate is server-side: non-super-admins get 401/403 and see the notice below.
 */

const base = `${env.VITE_API_URL || window.location.origin}/super-admin`;

interface Summary {
	totalRuns: number;
	merges: number;
	autoMerges: number;
	byOutcome: { outcome: string; count: number }[];
	byRole: { role: string; count: number }[];
	lastRunAt: number | null;
}

interface RunRow {
	run: string;
	issue: number;
	role: string;
	model: string;
	tier: string;
	taskType: string;
	startedAt: number;
	wallS: number;
	outcome: string;
	pr: number;
	merged: boolean;
	autoMerged: boolean;
}

const get = async <T,>(path: string): Promise<T> => {
	const res = await fetch(`${base}${path}`, { credentials: "include" });
	if (!res.ok) throw new Error(String(res.status));
	return (await res.json()) as T;
};

export default function YantraCockpitPage() {
	const [summary, setSummary] = useState<Summary | null>(null);
	const [runs, setRuns] = useState<RunRow[]>([]);
	const [denied, setDenied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [jsonl, setJsonl] = useState("");
	const [importing, setImporting] = useState(false);
	const [importMsg, setImportMsg] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const [s, r] = await Promise.all([
				get<Summary>("/yantra/summary"),
				get<{ rows: RunRow[] }>("/yantra/runs?limit=50"),
			]);
			setSummary(s);
			setRuns(r.rows);
			setDenied(false);
			setError(null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "failed";
			if (msg === "401" || msg === "403") setDenied(true);
			else setError(`Couldn't load harness state (${msg})`);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const t = window.setInterval(() => void refresh(), 30_000);
		return () => window.clearInterval(t);
	}, [refresh]);

	const handleImport = async () => {
		setImporting(true);
		setImportMsg(null);
		try {
			const res = await fetch(`${base}/yantra/import-telemetry`, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonl }),
			});
			if (!res.ok) throw new Error(String(res.status));
			const out = (await res.json()) as {
				inserted: number;
				skippedDuplicates: number;
				parseErrors: { line: number }[];
			};
			setImportMsg(
				`Imported ${out.inserted} runs (${out.skippedDuplicates} duplicates skipped, ${out.parseErrors.length} bad lines).`,
			);
			setJsonl("");
			await refresh();
		} catch (err) {
			setImportMsg(
				`Import failed (${err instanceof Error ? err.message : "error"}).`,
			);
		} finally {
			setImporting(false);
		}
	};

	if (denied) {
		return (
			<Container maxWidth="md" sx={{ py: 4 }}>
				<Alert severity="warning">
					The Yantra cockpit is super-admin only. Sign in with a super-admin
					account to see the factory.
				</Alert>
			</Container>
		);
	}

	return (
		<Container maxWidth="lg" sx={{ py: 4 }}>
			<Stack spacing={3}>
				<Box>
					<Typography variant="h4" sx={{ fontWeight: 800 }}>
						Yantra Cockpit
					</Typography>
					<Typography variant="body2" color="text.secondary">
						The factory's own flight recorder — every advise / execute / grade
						/ dream run the loop has made improving this app (tenant-zero).
					</Typography>
				</Box>

				{error && <Alert severity="error">{error}</Alert>}

				<Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
					<StatTile label="Total runs" value={summary?.totalRuns ?? "—"} />
					<StatTile label="Merges" value={summary?.merges ?? "—"} />
					<StatTile label="Auto-merges" value={summary?.autoMerges ?? "—"} />
					<StatTile
						label="Last activity"
						value={
							summary?.lastRunAt
								? new Date(summary.lastRunAt).toLocaleString()
								: "—"
						}
					/>
				</Stack>

				<Stack direction={{ xs: "column", md: "row" }} spacing={2}>
					<BreakdownCard title="By outcome" rows={summary?.byOutcome ?? []} nameKey="outcome" />
					<BreakdownCard title="By role" rows={summary?.byRole ?? []} nameKey="role" />
				</Stack>

				<Card sx={{ p: 3, border: "1px solid", borderColor: "divider" }}>
					<Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
						Recent runs
					</Typography>
					<Box sx={{ overflowX: "auto" }}>
						<Box component="table" sx={{ width: "100%", borderCollapse: "collapse", "& th, & td": { textAlign: "left", py: 0.75, px: 1, borderBottom: "1px solid", borderColor: "divider", fontSize: "0.85rem", whiteSpace: "nowrap" } }}>
							<thead>
								<tr>
									<th>When</th>
									<th>Role</th>
									<th>Issue</th>
									<th>PR</th>
									<th>Tier</th>
									<th>Outcome</th>
									<th>Wall</th>
									<th>Model</th>
								</tr>
							</thead>
							<tbody>
								{runs.map((r) => (
									<tr key={r.run}>
										<td>{new Date(r.startedAt).toLocaleString()}</td>
										<td>{r.role}</td>
										<td>{r.issue ? `#${r.issue}` : "—"}</td>
										<td>{r.pr ? `#${r.pr}` : "—"}</td>
										<td>{r.tier}</td>
										<td>
											{r.outcome}
											{r.autoMerged ? " ⚡" : r.merged ? " ✅" : ""}
										</td>
										<td>{r.wallS ? `${Math.round(r.wallS / 60)}m` : "—"}</td>
										<td>{r.model}</td>
									</tr>
								))}
								{runs.length === 0 && (
									<tr>
										<td colSpan={8}>
											No runs yet — import the v0 telemetry below.
										</td>
									</tr>
								)}
							</tbody>
						</Box>
					</Box>
				</Card>

				<Card sx={{ p: 3, border: "1px solid", borderColor: "divider" }}>
					<Typography variant="h6" sx={{ fontWeight: 700 }}>
						Import v0 telemetry
					</Typography>
					<Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
						Paste the contents of <code>/opt/yantra/telemetry/runs.jsonl</code>.
						Idempotent — re-importing skips duplicates.
					</Typography>
					<TextField
						multiline
						minRows={4}
						maxRows={10}
						fullWidth
						value={jsonl}
						onChange={(e) => setJsonl(e.target.value)}
						placeholder='{"run":"01…","role":"execute",…}'
						sx={{ mb: 2, "& textarea": { fontFamily: "monospace", fontSize: "0.75rem" } }}
					/>
					<Stack direction="row" spacing={2} alignItems="center">
						<Button
							variant="contained"
							onClick={handleImport}
							disabled={importing || jsonl.trim().length === 0}
						>
							{importing ? "Importing…" : "Import"}
						</Button>
						{importMsg && (
							<Typography variant="body2" color="text.secondary">
								{importMsg}
							</Typography>
						)}
					</Stack>
				</Card>
			</Stack>
		</Container>
	);
}

function StatTile({ label, value }: { label: string; value: string | number }) {
	return (
		<Card sx={{ p: 2.5, flex: 1, border: "1px solid", borderColor: "divider" }}>
			<Typography variant="overline" color="text.secondary">
				{label}
			</Typography>
			<Typography variant="h5" sx={{ fontWeight: 700 }}>
				{value}
			</Typography>
		</Card>
	);
}

function BreakdownCard({
	title,
	rows,
	nameKey,
}: {
	title: string;
	rows: Record<string, string | number>[];
	nameKey: string;
}) {
	return (
		<Card sx={{ p: 2.5, flex: 1, border: "1px solid", borderColor: "divider" }}>
			<Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
				{title}
			</Typography>
			<Stack spacing={0.5}>
				{rows.map((r) => (
					<Stack key={String(r[nameKey])} direction="row" justifyContent="space-between">
						<Typography variant="body2">{String(r[nameKey])}</Typography>
						<Typography variant="body2" sx={{ fontWeight: 600 }}>
							{String(r.count)}
						</Typography>
					</Stack>
				))}
				{rows.length === 0 && (
					<Typography variant="body2" color="text.secondary">
						—
					</Typography>
				)}
			</Stack>
		</Card>
	);
}
