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

interface Project {
	id: string;
	repo: string;
	baseBranch: string;
	enabled: boolean;
	ghTokenHint: string;
	createdAt: number;
}

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
	const [projects, setProjects] = useState<Project[]>([]);
	const [denied, setDenied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [jsonl, setJsonl] = useState("");
	const [importing, setImporting] = useState(false);
	const [importMsg, setImportMsg] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const [s, r, p] = await Promise.all([
				get<Summary>("/yantra/summary"),
				get<{ rows: RunRow[] }>("/yantra/runs?limit=50"),
				get<{ projects: Project[] }>("/yantra/projects"),
			]);
			setSummary(s);
			setRuns(r.rows);
			setProjects(p.projects);
			setDenied(false);
			setError(null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "failed";
			if (msg === "401" || msg === "403") setDenied(true);
			else setError(`Couldn't load harness state (${msg})`);
		}
	}, []);

	useEffect(() => {
		// Once the gate says 401/403 the answer won't change without a re-login —
		// stop polling instead of hammering the backend every 30 s.
		if (denied) return;
		void refresh();
		const t = window.setInterval(() => void refresh(), 30_000);
		return () => window.clearInterval(t);
	}, [refresh, denied]);

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

				<ProjectsCard projects={projects} onChanged={refresh} />

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

/**
 * Projects (D23): a project = repo + base branch + its own GitHub PAT, stored
 * encrypted in the app's DB — never in server env. The token is write-only:
 * the API returns a last-4 hint, nothing more. Tenant-zero is this very repo.
 */
function ProjectsCard({
	projects,
	onChanged,
}: {
	projects: Project[];
	onChanged: () => Promise<void>;
}) {
	const [repo, setRepo] = useState("");
	const [baseBranch, setBaseBranch] = useState("staging");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	const post = async (path: string, body: unknown) => {
		const res = await fetch(`${base}${path}`, {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			// oRPC error body: { message, data: { fieldErrors?: {field: [msg]} } }.
			// Surface the specific field message, not just a status code.
			let detail = `HTTP ${res.status}`;
			try {
				const err = (await res.json()) as {
					message?: string;
					data?: { fieldErrors?: Record<string, string[]> };
				};
				const fieldErrors = err.data?.fieldErrors ?? {};
				const firstField = Object.entries(fieldErrors)[0];
				detail = firstField
					? `${firstField[0]}: ${firstField[1].join("; ")}`
					: (err.message ?? detail);
			} catch {
				// Non-JSON body (proxy error page) — keep the status code.
			}
			throw new Error(detail);
		}
	};

	const handleAdd = async () => {
		setBusy(true);
		setMsg(null);
		// Accept a pasted GitHub URL and reduce it to owner/name.
		const normalizedRepo = repo
			.trim()
			.replace(/^https?:\/\/(www\.)?github\.com\//i, "")
			.replace(/\.git$/i, "")
			.replace(/\/+$/, "");
		try {
			await post("/yantra/projects", {
				repo: normalizedRepo,
				baseBranch,
				ghToken: token,
			});
			setRepo("");
			setToken("");
			setMsg("Project added — the harness tick picks it up within 10 minutes.");
			await onChanged();
		} catch (err) {
			setMsg(
				`Couldn't add project — ${err instanceof Error ? err.message : "unknown error"}`,
			);
		} finally {
			setBusy(false);
		}
	};

	const handleToggle = async (p: Project) => {
		setBusy(true);
		try {
			await post("/yantra/projects/set-enabled", {
				id: p.id,
				enabled: !p.enabled,
			});
			await onChanged();
		} catch {
			setMsg("Couldn't update the project.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card sx={{ p: 3, border: "1px solid", borderColor: "divider" }}>
			<Typography variant="h6" sx={{ fontWeight: 700 }}>
				Connected repos
			</Typography>
			<Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
				A project can connect multiple GitHub repos; each connection is one
				repo + base branch + its own token, encrypted in the app's database —
				nothing lives in server env. The harness tick works every enabled
				connection. (Today these belong to the super-admin's own project;
				team-scoped projects come with multi-tenancy in Phase 4.)
			</Typography>

			<Stack spacing={1} sx={{ mb: 2 }}>
				{projects.map((p) => (
					<Stack
						key={p.id}
						direction="row"
						spacing={2}
						alignItems="center"
						justifyContent="space-between"
						sx={{ py: 0.5, borderBottom: "1px solid", borderColor: "divider" }}
					>
						<Box>
							<Typography variant="body2" sx={{ fontWeight: 600 }}>
								{p.repo} @ {p.baseBranch}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								token …{p.ghTokenHint || "????"} ·{" "}
								{p.enabled ? "enabled" : "paused"}
							</Typography>
						</Box>
						<Button size="small" disabled={busy} onClick={() => handleToggle(p)}>
							{p.enabled ? "Pause" : "Enable"}
						</Button>
					</Stack>
				))}
				{projects.length === 0 && (
					<Typography variant="body2" color="text.secondary">
						No projects yet — add this repo as tenant-zero below.
					</Typography>
				)}
			</Stack>

			<Stack direction={{ xs: "column", md: "row" }} spacing={2}>
				<TextField
					label="Repo (owner/name)"
					size="small"
					value={repo}
					onChange={(e) => setRepo(e.target.value)}
					placeholder="krishna-404/yantra"
					sx={{ flex: 1 }}
				/>
				<TextField
					label="Base branch"
					size="small"
					value={baseBranch}
					onChange={(e) => setBaseBranch(e.target.value)}
					sx={{ width: { md: 160 } }}
				/>
				<TextField
					label="GitHub token"
					size="small"
					type="password"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="ghp_…"
					sx={{ flex: 1 }}
				/>
				<Button
					variant="contained"
					onClick={handleAdd}
					disabled={busy || !repo.trim() || !token.trim()}
				>
					Add project
				</Button>
			</Stack>
			<Typography
				variant="caption"
				color="text.secondary"
				sx={{ display: "block", mt: 1.5 }}
			>
				Token: use a fine-grained PAT scoped to just this repo, with
				repository permissions <b>Contents</b>, <b>Issues</b> and{" "}
				<b>Pull requests</b> set to read &amp; write, and <b>Variables</b>{" "}
				read-only (the kill switch is an Actions variable — without it the
				harness fails closed and stays idle). A classic token with{" "}
				<code>repo</code> scope also works but grants far more than needed.
			</Typography>
			{msg && (
				<Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
					{msg}
				</Typography>
			)}
		</Card>
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
