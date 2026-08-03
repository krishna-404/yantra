import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Alert } from "@connected-repo/ui-mui/feedback/Alert";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Card } from "@connected-repo/ui-mui/layout/Card";
import { Divider } from "@connected-repo/ui-mui/layout/Divider";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import {
	useProjects,
	type YantraProject,
} from "@frontend/contexts/YantraProjectsContext";
import { orpcFetch } from "@frontend/utils/orpc.client";
import {
	CircularProgress,
	FormControlLabel,
	MenuItem,
	Switch,
	TextField,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";

/**
 * Yantra project pane (P3) — the main content next to the shell sidebar. Shows
 * the selected project's Chat or Settings. Selection + the project list live in
 * the shell (YantraSidebar / YantraProjectsContext); this pane is just content.
 */

interface Draft {
	title: string;
	tier: string;
	body: string;
	groomedBy: string;
}

type Msg = { id: number } & (
	| { role: "user"; text: string }
	| { role: "draft"; draft: Draft }
	| { role: "queued"; issue: number; url: string }
);

let msgSeq = 0;
const nextMsgId = (): number => {
	msgSeq += 1;
	return msgSeq;
};

const TABS = [
	["chat", "Chat"],
	["monitor", "Monitor"],
	["routines", "Routines"],
	["settings", "Settings"],
] as const;

export default function YantraChatPage() {
	const { projects, selectedId, loading, reload } = useProjects();
	const [tab, setTab] = useState<
		"chat" | "monitor" | "routines" | "settings"
	>("chat");
	const selected = projects.find((p) => p.id === selectedId) ?? null;

	if (loading && projects.length === 0) {
		return (
			<Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
				<CircularProgress size={22} />
			</Stack>
		);
	}

	if (!selected) {
		return (
			<Stack alignItems="center" justifyContent="center" sx={{ height: "100%", p: 4 }}>
				<Typography variant="h6" sx={{ fontWeight: 700 }}>
					No project selected
				</Typography>
				<Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
					{projects.length === 0
						? "Add a project from the sidebar to get started."
						: "Pick a project from the sidebar."}
				</Typography>
			</Stack>
		);
	}

	return (
		<Box sx={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
			<Stack
				direction="row"
				spacing={1}
				alignItems="center"
				useFlexGap
				sx={{
					px: { xs: 2, md: 3 },
					py: 1.5,
					borderBottom: "1px solid",
					borderColor: "divider",
					flexWrap: "wrap",
					rowGap: 1,
				}}
			>
				<Box sx={{ flex: "1 1 180px", minWidth: 0 }}>
					<Typography variant="subtitle1" sx={{ fontWeight: 700 }} noWrap>
						{selected.repo}
					</Typography>
					<Typography variant="caption" sx={{ color: "text.secondary" }}>
						{selected.productionBranch || "main"} ← {selected.baseBranch} ·{" "}
						{selected.mode}
						{selected.autoMergeToMain ? " · auto-promote" : ""}
					</Typography>
				</Box>
				<Box
					sx={{
						display: "inline-flex",
						gap: 0.5,
						p: 0.5,
						borderRadius: 2.5,
						bgcolor: "action.hover",
						maxWidth: "100%",
						overflowX: "auto",
					}}
				>
					{TABS.map(([t, label]) => (
						<Button
							key={t}
							size="small"
							disableElevation
							variant={tab === t ? "contained" : "text"}
							onClick={() => setTab(t)}
							sx={{
								borderRadius: 2,
								flexShrink: 0,
								minWidth: { xs: 68, sm: 82 },
								color: tab === t ? undefined : "text.secondary",
							}}
						>
							{label}
						</Button>
					))}
				</Box>
			</Stack>

			<Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
				{tab === "chat" && <ChatPane key={selected.id} project={selected} />}
				{tab === "monitor" && (
					<MonitorPane key={selected.id} project={selected} />
				)}
				{tab === "routines" && (
					<RoutinesPane key={selected.id} project={selected} />
				)}
				{tab === "settings" && (
					<SettingsPane key={selected.id} project={selected} onSaved={reload} />
				)}
			</Box>
		</Box>
	);
}

function ChatPane({ project }: { project: YantraProject }) {
	const [messages, setMessages] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The thread is persisted (#26), so a refresh — or a teammate opening the
	// same project — sees the whole conversation instead of an empty pane.
	useEffect(() => {
		let cancelled = false;
		orpcFetch.yantra
			.listMessages({ projectId: project.id })
			.then((rows) => {
				if (cancelled) return;
				setMessages(
					rows.map((r) => {
						if (r.role === "draft") {
							return {
								id: nextMsgId(),
								role: "draft" as const,
								draft: r.payload as Draft,
							};
						}
						if (r.role === "queued") {
							const p = (r.payload ?? {}) as { issue?: number; url?: string };
							return {
								id: nextMsgId(),
								role: "queued" as const,
								issue: p.issue ?? 0,
								url: p.url ?? "",
							};
						}
						return { id: nextMsgId(), role: "user" as const, text: r.text };
					}),
				);
			})
			.catch(() => {
				// An unreadable thread shouldn't block composing a new message.
			});
		return () => {
			cancelled = true;
		};
	}, [project.id]);

	const send = useCallback(async () => {
		const idea = input.trim();
		if (idea.length < 4) return;
		setInput("");
		setError(null);
		setMessages((m) => [...m, { id: nextMsgId(), role: "user", text: idea }]);
		setBusy(true);
		try {
			const { draft } = await orpcFetch.yantra.sendMessage({
				projectId: project.id,
				idea,
			});
			setMessages((m) => [...m, { id: nextMsgId(), role: "draft", draft }]);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't draft a spec");
		} finally {
			setBusy(false);
		}
	}, [input, project.id]);

	const queue = useCallback(
		async (draft: Draft) => {
			setBusy(true);
			setError(null);
			try {
				const res = await orpcFetch.yantra.queueSpec({
					projectId: project.id,
					title: draft.title,
					body: draft.body,
					tier: draft.tier as "T0" | "T1" | "T2" | "T3",
				});
				setMessages((m) => [
					...m,
					{ id: nextMsgId(), role: "queued", issue: res.issue, url: res.url },
				]);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Couldn't queue the spec");
			} finally {
				setBusy(false);
			}
		},
		[project.id],
	);

	return (
		<Box
			sx={{
				flex: 1,
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
				width: "100%",
				maxWidth: 820,
				mx: "auto",
				px: { xs: 2, md: 3 },
				py: 2,
			}}
		>
			<Box sx={{ flex: 1, overflowY: "auto", mb: 2 }}>
				{messages.length === 0 && (
					<Stack
						alignItems="center"
						justifyContent="center"
						spacing={1}
						sx={{ height: "100%", textAlign: "center", px: 3 }}
					>
						<Typography variant="h5" sx={{ fontWeight: 700 }}>
							What should we build?
						</Typography>
						<Typography
							variant="body2"
							sx={{ color: "text.secondary", maxWidth: 440 }}
						>
							Describe it in plain words — a free model drafts the spec, you
							review and queue it, and the factory ships it.
						</Typography>
					</Stack>
				)}
				<Stack spacing={1.5}>
					{messages.map((m) => (
						<Bubble key={m.id} msg={m} busy={busy} onQueue={queue} />
					))}
					{busy && (
						<Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
							<CircularProgress size={16} />
							<Typography variant="body2" sx={{ color: "text.secondary" }}>
								Thinking…
							</Typography>
						</Stack>
					)}
				</Stack>
			</Box>

			{error && (
				<Alert severity="error" sx={{ mb: 1 }}>
					{error}
				</Alert>
			)}

			<Box
				sx={{
					display: "flex",
					alignItems: "flex-end",
					gap: 1,
					p: 1,
					pl: 2,
					borderRadius: 3.5,
					border: "1px solid",
					borderColor: "divider",
					bgcolor: "background.paper",
					transition: "border-color 0.15s ease, box-shadow 0.15s ease",
					"&:focus-within": {
						borderColor: "primary.main",
						boxShadow: "0 0 0 3px rgba(201, 100, 66, 0.22)",
					},
				}}
			>
				<TextField
					fullWidth
					multiline
					maxRows={8}
					variant="standard"
					placeholder="Describe the work…  (Enter to send, Shift+Enter for newline)"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
					disabled={busy}
					InputProps={{ disableUnderline: true }}
					sx={{ py: 0.75 }}
				/>
				<Button
					variant="contained"
					onClick={() => void send()}
					disabled={busy || input.trim().length < 4}
					sx={{ borderRadius: 2.5, minWidth: 0, px: 2.5, py: 1 }}
				>
					Send
				</Button>
			</Box>
		</Box>
	);
}


/**
 * Live monitor (#27): what the factory is doing on this project right now —
 * queue depth, open PRs (with the promote button when auto-promote is off) and
 * the recent run feed. Polls while the tab is open.
 */
function MonitorPane({ project }: { project: YantraProject }) {
	const [status, setStatus] = useState<{
		runs: {
			run: string;
			issue: number;
			role: string;
			tier: string;
			outcome: string;
			pr: number;
			merged: boolean;
			autoMerged: boolean;
			wallS: number;
			startedAt: number;
		}[];
		openPrs: {
			number: number;
			title: string;
			url: string;
			tier: string;
			draft: boolean;
		}[];
		readyCount: number;
		workingCount: number;
	} | null>(null);
	const [busy, setBusy] = useState<number | null>(null);
	const [msg, setMsg] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setStatus(await orpcFetch.yantra.projectStatus({ projectId: project.id }));
		} catch {
			// Transient GitHub/API failures shouldn't blank the pane.
		}
	}, [project.id]);

	useEffect(() => {
		void load();
		const t = window.setInterval(() => void load(), 30_000);
		return () => window.clearInterval(t);
	}, [load]);

	const promote = async (pr: number) => {
		setBusy(pr);
		setMsg(null);
		try {
			const res = await orpcFetch.yantra.promotePr({
				projectId: project.id,
				pr,
			});
			setMsg(res.message);
			if (res.merged) await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Merge failed");
		} finally {
			setBusy(null);
		}
	};

	if (!status) {
		return (
			<Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
				<CircularProgress size={22} />
			</Stack>
		);
	}

	return (
		<Box sx={{ overflowY: "auto", px: { xs: 2, md: 3 }, py: 2 }}>
			<Stack spacing={2} sx={{ maxWidth: 820 }}>
				<Stack direction="row" spacing={2}>
					<Stat label="Queued" value={status.readyCount} />
					<Stat label="In flight" value={status.workingCount} />
					<Stat label="Open PRs" value={status.openPrs.length} />
				</Stack>

				<Card sx={{ p: 2 }}>
					<Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
						Open pull requests
					</Typography>
					{status.openPrs.length === 0 && (
						<Typography variant="body2" sx={{ color: "text.secondary" }}>
							Nothing open.
						</Typography>
					)}
					<Stack spacing={1}>
						{status.openPrs.map((pr) => (
							<Stack
								key={pr.number}
								direction="row"
								spacing={1}
								alignItems="center"
							>
								<Box sx={{ flex: 1, minWidth: 0 }}>
									<Typography variant="body2" noWrap>
										<a href={pr.url} target="_blank" rel="noreferrer">
											#{pr.number}
										</a>{" "}
										{pr.title}
									</Typography>
									<Typography variant="caption" sx={{ color: "text.secondary" }}>
										{pr.tier || "untiered"}
										{pr.draft ? " · draft" : ""}
									</Typography>
								</Box>
								<Button
									size="small"
									variant="outlined"
									disabled={busy === pr.number}
									onClick={() => void promote(pr.number)}
								>
									{busy === pr.number ? "Merging…" : "Promote"}
								</Button>
							</Stack>
						))}
					</Stack>
					{msg && (
						<Alert severity="info" sx={{ mt: 1.5 }}>
							{msg}
						</Alert>
					)}
				</Card>

				<Card sx={{ p: 2 }}>
					<Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
						Recent runs
					</Typography>
					{status.runs.length === 0 && (
						<Typography variant="body2" sx={{ color: "text.secondary" }}>
							No runs recorded yet.
						</Typography>
					)}
					<Stack spacing={0.75}>
						{status.runs.map((r) => (
							<Stack
								key={r.run}
								direction="row"
								spacing={1}
								alignItems="baseline"
							>
								<Typography variant="caption" sx={{ color: "text.secondary", minWidth: 128 }}>
									{new Date(r.startedAt).toLocaleString()}
								</Typography>
								<Typography variant="body2" sx={{ minWidth: 64 }}>
									{r.role}
								</Typography>
								<Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
									{r.issue ? `#${r.issue} ` : ""}
									{r.outcome}
									{r.autoMerged ? " ⚡" : r.merged ? " ✅" : ""}
								</Typography>
								<Typography variant="caption" sx={{ color: "text.secondary" }}>
									{r.wallS ? `${Math.round(r.wallS / 60)}m` : ""}
								</Typography>
							</Stack>
						))}
					</Stack>
				</Card>
			</Stack>
		</Box>
	);
}

interface Routine {
	id: string;
	projectId: string;
	name: string;
	cron: string | null;
	action: string;
	prompt: string;
	targetReady: number;
	enabled: boolean;
	lastRunAt: number | null;
	nextRunAt: number | null;
}

/**
 * Cron is the storage format, but nobody should have to write it to set up a
 * schedule. These cover the shapes people actually want; "custom" is the escape
 * hatch, and the server validates whatever ends up in the field either way.
 */
const CRON_PRESETS = [
	["0 * * * *", "Every hour"],
	["0 */6 * * *", "Every 6 hours"],
	["0 3 * * *", "Daily · 03:00 UTC"],
	["0 9 * * 1-5", "Weekdays · 09:00 UTC"],
	["0 3 * * 1", "Weekly · Monday 03:00 UTC"],
] as const;

const describeCron = (cron: string | null): string => {
	if (!cron) return "no schedule";
	return CRON_PRESETS.find(([expr]) => expr === cron)?.[1] ?? `cron: ${cron}`;
};

const whenLabel = (ms: number | null): string =>
	ms ? new Date(ms).toLocaleString() : "—";

/**
 * Routines (#18) — the self-sufficiency control. A routine tops the project's
 * backlog back up on a schedule, so the factory keeps shipping after the queue
 * empties instead of going quiet until someone files the next spec.
 */
function RoutinesPane({ project }: { project: YantraProject }) {
	const [routines, setRoutines] = useState<Routine[] | null>(null);
	const [name, setName] = useState("Keep the backlog fed");
	const [cron, setCron] = useState<string>(CRON_PRESETS[2][0]);
	const [customCron, setCustomCron] = useState("");
	const [targetReady, setTargetReady] = useState(3);
	const [prompt, setPrompt] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setRoutines(
				await orpcFetch.yantra.listRoutines({ projectId: project.id }),
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not load routines");
			setRoutines([]);
		}
	}, [project.id]);

	useEffect(() => {
		void load();
	}, [load]);

	const create = async () => {
		setSaving(true);
		setError(null);
		try {
			await orpcFetch.yantra.createRoutine({
				projectId: project.id,
				name: name.trim(),
				cron: (cron === "custom" ? customCron : cron).trim(),
				action: "groom_backlog",
				prompt: prompt.trim(),
				targetReady,
			});
			setPrompt("");
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not create the routine");
		} finally {
			setSaving(false);
		}
	};

	const toggle = async (r: Routine) => {
		// Optimistic: the switch should feel instant; `load` reconciles.
		setRoutines(
			(prev) =>
				prev?.map((x) =>
					x.id === r.id ? { ...x, enabled: !x.enabled } : x,
				) ?? prev,
		);
		try {
			await orpcFetch.yantra.updateRoutine({ id: r.id, enabled: !r.enabled });
		} finally {
			await load();
		}
	};

	const remove = async (r: Routine) => {
		await orpcFetch.yantra.deleteRoutine({ id: r.id });
		await load();
	};

	if (!routines) {
		return (
			<Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
				<CircularProgress size={22} />
			</Stack>
		);
	}

	const cronValid = cron !== "custom" || customCron.trim().split(/\s+/).length === 5;

	return (
		<Box sx={{ overflowY: "auto", px: { xs: 2, md: 3 }, py: 2 }}>
			<Stack spacing={2} sx={{ maxWidth: 820 }}>
				{error && <Alert severity="error">{error}</Alert>}

				<Card sx={{ p: { xs: 2, md: 2.5 } }}>
					<Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
						Active routines
					</Typography>
					<Typography variant="caption" sx={{ color: "text.secondary" }}>
						Each run tops the backlog up to the target, then the factory picks
						the work up on its next tick. Times are UTC.
					</Typography>

					{routines.length === 0 ? (
						<Typography variant="body2" sx={{ color: "text.secondary", mt: 2 }}>
							No routines yet — this project only builds what you queue by hand.
						</Typography>
					) : (
						<Stack divider={<Divider />} sx={{ mt: 1.5 }}>
							{routines.map((r) => (
								<Stack
									key={r.id}
									direction="row"
									spacing={1}
									alignItems="center"
									sx={{ py: 1.25, flexWrap: "wrap", rowGap: 0.5 }}
								>
									<Box sx={{ flex: "1 1 220px", minWidth: 0 }}>
										<Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
											{r.name}
										</Typography>
										<Typography
											variant="caption"
											sx={{ color: "text.secondary", display: "block" }}
										>
											{describeCron(r.cron)} · keep {r.targetReady} queued
										</Typography>
										<Typography
											variant="caption"
											sx={{ color: "text.secondary", display: "block" }}
										>
											last {whenLabel(r.lastRunAt)} · next{" "}
											{r.enabled ? whenLabel(r.nextRunAt) : "paused"}
										</Typography>
									</Box>
									<Switch
										size="small"
										checked={r.enabled}
										onChange={() => void toggle(r)}
										inputProps={{ "aria-label": `Enable ${r.name}` }}
									/>
									<Button
										size="small"
										color="error"
										variant="text"
										onClick={() => void remove(r)}
									>
										Delete
									</Button>
								</Stack>
							))}
						</Stack>
					)}
				</Card>

				<Card sx={{ p: { xs: 2, md: 2.5 } }}>
					<Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
						New routine
					</Typography>
					<Stack spacing={2}>
						<TextField
							size="small"
							label="Name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							fullWidth
						/>
						<Stack
							direction={{ xs: "column", sm: "row" }}
							spacing={2}
							useFlexGap
						>
							<TextField
								select
								size="small"
								label="Schedule"
								value={cron}
								onChange={(e) => setCron(e.target.value)}
								sx={{ flex: 1 }}
							>
								{CRON_PRESETS.map(([expr, label]) => (
									<MenuItem key={expr} value={expr}>
										{label}
									</MenuItem>
								))}
								<MenuItem value="custom">Custom cron…</MenuItem>
							</TextField>
							<TextField
								size="small"
								type="number"
								label="Keep queued"
								value={targetReady}
								onChange={(e) =>
									setTargetReady(
										Math.min(20, Math.max(1, Number(e.target.value) || 1)),
									)
								}
								sx={{ width: { xs: "100%", sm: 140 } }}
							/>
						</Stack>
						{cron === "custom" && (
							<TextField
								size="small"
								label="Cron expression (UTC)"
								placeholder="0 3 * * *"
								value={customCron}
								onChange={(e) => setCustomCron(e.target.value)}
								helperText="Five fields: minute hour day-of-month month day-of-week"
								fullWidth
							/>
						)}
						<TextField
							size="small"
							label="Focus (optional)"
							placeholder="e.g. test coverage, error handling, performance"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							multiline
							minRows={2}
							helperText="What the ideas should be about. Leave blank for whatever is most valuable next."
							fullWidth
						/>
						<Box>
							<Button
								variant="contained"
								disableElevation
								disabled={saving || !name.trim() || !cronValid}
								onClick={() => void create()}
							>
								{saving ? "Creating…" : "Create routine"}
							</Button>
						</Box>
					</Stack>
				</Card>
			</Stack>
		</Box>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<Card sx={{ p: 2, flex: 1 }}>
			<Typography variant="h5" sx={{ fontWeight: 700 }}>
				{value}
			</Typography>
			<Typography variant="caption" sx={{ color: "text.secondary" }}>
				{label}
			</Typography>
		</Card>
	);
}

function SettingsPane({
	project,
	onSaved,
}: {
	project: YantraProject;
	onSaved: () => Promise<void>;
}) {
	const [baseBranch, setBaseBranch] = useState(project.baseBranch);
	const [productionBranch, setProductionBranch] = useState(project.productionBranch);
	const [productionUrl, setProductionUrl] = useState(project.productionUrl);
	const [stagingUrl, setStagingUrl] = useState(project.stagingUrl);
	const [mode, setMode] = useState(project.mode);
	const [enabled, setEnabled] = useState(project.enabled);
	const [autoMerge, setAutoMerge] = useState(project.autoMergeToMain);
	const [newToken, setNewToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const save = async () => {
		setBusy(true);
		setErr(null);
		setMsg(null);
		try {
			await orpcFetch.yantra.updateProject({
				id: project.id,
				baseBranch: baseBranch.trim(),
				productionBranch: productionBranch.trim(),
				productionUrl: productionUrl.trim(),
				stagingUrl: stagingUrl.trim(),
				mode: mode as "shadow" | "live",
				enabled,
				autoMergeToMain: autoMerge,
			});
			if (newToken.trim().length >= 20) {
				await orpcFetch.yantra.setProjectToken({
					id: project.id,
					ghToken: newToken.trim(),
				});
				setNewToken("");
			}
			setMsg("Saved.");
			await onSaved();
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Couldn't save settings");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Box sx={{ overflowY: "auto", px: { xs: 2, md: 3 }, py: 2 }}>
			<Card sx={{ p: 2.5, maxWidth: 560 }}>
				<Stack spacing={2}>
					<TextField size="small" label="Repository" value={project.repo} disabled />
					<Typography variant="overline" sx={{ color: "text.secondary" }}>
						Production
					</Typography>
					<TextField
						size="small"
						label="Production branch"
						value={productionBranch}
						onChange={(e) => setProductionBranch(e.target.value)}
						helperText="Where verified work ships. Feature branches are cut from here and PRs target it."
					/>
					<TextField
						size="small"
						label="Production URL"
						placeholder="https://yantra.c4elabs.com"
						value={productionUrl}
						onChange={(e) => setProductionUrl(e.target.value)}
					/>

					<Typography variant="overline" sx={{ color: "text.secondary" }}>
						Staging
					</Typography>
					<TextField
						size="small"
						label="Staging branch"
						value={baseBranch}
						onChange={(e) => setBaseBranch(e.target.value)}
						helperText="Every feature branch is force-pushed here to be checked before promotion."
					/>
					<TextField
						size="small"
						label="Staging URL"
						placeholder="https://yantra-staging.c4elabs.com"
						value={stagingUrl}
						onChange={(e) => setStagingUrl(e.target.value)}
					/>

					<Divider />
					<TextField
						select
						size="small"
						label="Mode"
						value={mode}
						onChange={(e) => setMode(e.target.value)}
						helperText="shadow = decide only · live = claim issues, open PRs"
					>
						<MenuItem value="shadow">shadow</MenuItem>
						<MenuItem value="live">live</MenuItem>
					</TextField>
					<FormControlLabel
						control={<Switch checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} />}
						label="Auto-promote staging → production (unattended)"
					/>
					<FormControlLabel
						control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />}
						label="Enabled (factory works this project)"
					/>
					<Divider />
					<TextField
						size="small"
						type="password"
						label="Rotate GitHub token"
						placeholder={`current: …${project.ghTokenHint}`}
						value={newToken}
						onChange={(e) => setNewToken(e.target.value)}
						helperText="Leave blank to keep the current token."
					/>
					{msg && <Alert severity="success">{msg}</Alert>}
					{err && <Alert severity="error">{err}</Alert>}
					<Button
						variant="contained"
						disabled={busy}
						onClick={() => void save()}
						sx={{ textTransform: "none", alignSelf: "flex-start" }}
					>
						{busy ? "Saving…" : "Save settings"}
					</Button>
				</Stack>
			</Card>
		</Box>
	);
}

function Bubble({
	msg,
	busy,
	onQueue,
}: {
	msg: Msg;
	busy: boolean;
	onQueue: (d: Draft) => void;
}) {
	if (msg.role === "user") {
		return (
			<Box sx={{ alignSelf: "flex-end", maxWidth: "85%" }}>
				<Card sx={{ p: 1.5, bgcolor: "primary.main", color: "primary.contrastText" }}>
					<Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
						{msg.text}
					</Typography>
				</Card>
			</Box>
		);
	}
	if (msg.role === "queued") {
		return (
			<Alert severity="success">
				Queued as{" "}
				<a href={msg.url} target="_blank" rel="noreferrer">
					#{msg.issue}
				</a>{" "}
				— the factory claims it on the next tick.
			</Alert>
		);
	}
	const d = msg.draft;
	return (
		<Box sx={{ maxWidth: "95%" }}>
			<Card sx={{ p: 2 }}>
				<Typography variant="caption" sx={{ color: "text.secondary" }}>
					Draft spec · groomed by {d.groomedBy}
				</Typography>
				<Typography variant="subtitle1" sx={{ fontWeight: 700, mt: 0.5 }}>
					[{d.tier}] {d.title}
				</Typography>
				<Typography
					variant="body2"
					component="pre"
					sx={{
						whiteSpace: "pre-wrap",
						fontFamily: "monospace",
						mt: 1,
						maxHeight: 260,
						overflowY: "auto",
					}}
				>
					{d.body}
				</Typography>
				<Button
					variant="contained"
					size="small"
					sx={{ mt: 1.5, textTransform: "none" }}
					disabled={busy}
					onClick={() => onQueue(d)}
				>
					Queue as spec:ready
				</Button>
			</Card>
		</Box>
	);
}
