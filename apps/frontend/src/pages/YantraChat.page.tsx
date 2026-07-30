import { Typography } from "@connected-repo/ui-mui/data-display/Typography";
import { Alert } from "@connected-repo/ui-mui/feedback/Alert";
import { Button } from "@connected-repo/ui-mui/form/Button";
import { Box } from "@connected-repo/ui-mui/layout/Box";
import { Card } from "@connected-repo/ui-mui/layout/Card";
import { Stack } from "@connected-repo/ui-mui/layout/Stack";
import { orpcFetch } from "@frontend/utils/orpc.client";
import {
	CircularProgress,
	Divider,
	Drawer,
	FormControlLabel,
	MenuItem,
	Switch,
	TextField,
	useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useCallback, useEffect, useState } from "react";

/**
 * Yantra Projects — the Claude-like surface (platform P3). A left rail lists the
 * team's projects (a drawer on mobile, a sidebar on desktop); the main pane is
 * the selected project's chat or its settings. Fully responsive.
 *
 * Chat: describe → a free model drafts a spec → queue it as a spec:ready issue.
 * Settings: repo config, mode, per-project autoMergeToMain, GitHub token.
 * Persistence + live monitor + Routines are later slices.
 */

interface Project {
	id: string;
	repo: string;
	baseBranch: string;
	mode: string;
	enabled: boolean;
	ghTokenHint: string;
	autoMergeToMain: boolean;
}

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

const RAIL_WIDTH = 280;

export default function YantraChatPage() {
	const theme = useTheme();
	const isMobile = useMediaQuery(theme.breakpoints.down("md"));
	const [projects, setProjects] = useState<Project[]>([]);
	const [selectedId, setSelectedId] = useState("");
	const [tab, setTab] = useState<"chat" | "settings">("chat");
	const [navOpen, setNavOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadProjects = useCallback(async () => {
		try {
			const rows = await orpcFetch.yantra.listProjects();
			setProjects(rows);
			setSelectedId((cur) => cur || rows[0]?.id || "");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't load projects");
		}
	}, []);

	useEffect(() => {
		void loadProjects();
	}, [loadProjects]);

	const selected = projects.find((p) => p.id === selectedId) ?? null;

	const rail = (
		<ProjectRail
			projects={projects}
			selectedId={selectedId}
			onSelect={(id) => {
				setSelectedId(id);
				setTab("chat");
				setNavOpen(false);
			}}
			onCreated={(p) => {
				setProjects((prev) => [...prev, p]);
				setSelectedId(p.id);
				setNavOpen(false);
			}}
		/>
	);

	return (
		<Box sx={{ display: "flex", height: "100%", minHeight: 0 }}>
			{/* Left rail: permanent sidebar on desktop, temporary drawer on mobile */}
			{isMobile ? (
				<Drawer open={navOpen} onClose={() => setNavOpen(false)}>
					<Box sx={{ width: RAIL_WIDTH, height: "100%" }}>{rail}</Box>
				</Drawer>
			) : (
				<Box
					sx={{
						width: RAIL_WIDTH,
						flexShrink: 0,
						borderRight: "1px solid",
						borderColor: "divider",
						height: "100%",
						overflowY: "auto",
					}}
				>
					{rail}
				</Box>
			)}

			{/* Main pane */}
			<Box
				sx={{
					flex: 1,
					minWidth: 0,
					display: "flex",
					flexDirection: "column",
					height: "100%",
				}}
			>
				<Stack
					direction="row"
					spacing={1}
					alignItems="center"
					sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}
				>
					{isMobile && (
						<Button size="small" variant="outlined" onClick={() => setNavOpen(true)}>
							☰ Projects
						</Button>
					)}
					<Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
						{selected ? selected.repo : "No project selected"}
					</Typography>
					{selected && (
						<Stack direction="row" spacing={1}>
							<Button
								size="small"
								variant={tab === "chat" ? "contained" : "text"}
								onClick={() => setTab("chat")}
							>
								Chat
							</Button>
							<Button
								size="small"
								variant={tab === "settings" ? "contained" : "text"}
								onClick={() => setTab("settings")}
							>
								Settings
							</Button>
						</Stack>
					)}
				</Stack>

				{error && (
					<Alert severity="error" sx={{ m: 2 }}>
						{error}
					</Alert>
				)}

				<Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
					{!selected && (
						<Typography variant="body2" sx={{ p: 3, opacity: 0.7 }}>
							{projects.length === 0
								? "No projects yet — add one from the Projects panel."
								: "Pick a project from the Projects panel."}
						</Typography>
					)}
					{selected && tab === "chat" && (
						<ChatPane key={selected.id} project={selected} />
					)}
					{selected && tab === "settings" && (
						<SettingsPane
							key={selected.id}
							project={selected}
							onSaved={loadProjects}
						/>
					)}
				</Box>
			</Box>
		</Box>
	);
}

function ProjectRail({
	projects,
	selectedId,
	onSelect,
	onCreated,
}: {
	projects: Project[];
	selectedId: string;
	onSelect: (id: string) => void;
	onCreated: (p: Project) => void;
}) {
	const [adding, setAdding] = useState(false);
	const [repo, setRepo] = useState("");
	const [baseBranch, setBaseBranch] = useState("staging");
	const [ghToken, setGhToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const create = async () => {
		setBusy(true);
		setErr(null);
		try {
			const p = await orpcFetch.yantra.createProject({
				repo: repo.trim(),
				baseBranch: baseBranch.trim(),
				ghToken: ghToken.trim(),
			});
			onCreated(p);
			setAdding(false);
			setRepo("");
			setGhToken("");
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Couldn't add project");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Stack sx={{ p: 1.5, height: "100%" }} spacing={1}>
			<Stack direction="row" alignItems="center" justifyContent="space-between">
				<Typography variant="subtitle2" sx={{ fontWeight: 800, opacity: 0.7 }}>
					PROJECTS
				</Typography>
				<Button size="small" onClick={() => setAdding((v) => !v)}>
					{adding ? "Cancel" : "+ New"}
				</Button>
			</Stack>

			{adding && (
				<Card sx={{ p: 1.5 }}>
					<Stack spacing={1}>
						<TextField
							size="small"
							label="repo (owner/name)"
							value={repo}
							onChange={(e) => setRepo(e.target.value)}
						/>
						<TextField
							size="small"
							label="base branch"
							value={baseBranch}
							onChange={(e) => setBaseBranch(e.target.value)}
						/>
						<TextField
							size="small"
							type="password"
							label="GitHub token (PAT)"
							value={ghToken}
							onChange={(e) => setGhToken(e.target.value)}
						/>
						{err && <Alert severity="error">{err}</Alert>}
						<Button
							variant="contained"
							size="small"
							disabled={busy || repo.trim().length < 3 || ghToken.trim().length < 20}
							onClick={() => void create()}
						>
							{busy ? "Adding…" : "Add project"}
						</Button>
					</Stack>
				</Card>
			)}

			<Divider />

			<Stack spacing={0.5} sx={{ overflowY: "auto" }}>
				{projects.length === 0 && (
					<Typography variant="body2" sx={{ opacity: 0.6, p: 1 }}>
						No projects yet.
					</Typography>
				)}
				{projects.map((p) => (
					<Button
						key={p.id}
						fullWidth
						variant={p.id === selectedId ? "contained" : "text"}
						onClick={() => onSelect(p.id)}
						sx={{ justifyContent: "flex-start", textTransform: "none" }}
					>
						<Stack sx={{ minWidth: 0, alignItems: "flex-start" }}>
							<Typography variant="body2" noWrap sx={{ maxWidth: RAIL_WIDTH - 60 }}>
								{p.repo}
							</Typography>
							<Typography variant="caption" sx={{ opacity: 0.6 }}>
								{p.baseBranch} · {p.mode}
							</Typography>
						</Stack>
					</Button>
				))}
			</Stack>
		</Stack>
	);
}

function ChatPane({ project }: { project: Project }) {
	const [messages, setMessages] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const send = useCallback(async () => {
		const idea = input.trim();
		if (idea.length < 4) return;
		setInput("");
		setError(null);
		setMessages((m) => [...m, { id: nextMsgId(), role: "user", text: idea }]);
		setBusy(true);
		try {
			const draft = await orpcFetch.yantra.groom({ idea });
			setMessages((m) => [...m, { id: nextMsgId(), role: "draft", draft }]);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't draft a spec");
		} finally {
			setBusy(false);
		}
	}, [input]);

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
		<Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", p: 2 }}>
			<Box sx={{ flex: 1, overflowY: "auto", mb: 2 }}>
				{messages.length === 0 && (
					<Typography variant="body2" sx={{ opacity: 0.6, p: 1 }}>
						Describe what you want built in plain words — a free model drafts the
						spec, you review and queue it, and the factory picks it up.
					</Typography>
				)}
				<Stack spacing={1.5}>
					{messages.map((m) => (
						<Bubble key={m.id} msg={m} busy={busy} onQueue={queue} />
					))}
					{busy && (
						<Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1 }}>
							<CircularProgress size={16} />
							<Typography variant="body2" sx={{ opacity: 0.7 }}>
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

			<Stack direction="row" spacing={1}>
				<TextField
					fullWidth
					multiline
					maxRows={4}
					size="small"
					placeholder="Describe the work… (Enter to send)"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
					disabled={busy}
				/>
				<Button
					variant="contained"
					onClick={() => void send()}
					disabled={busy || input.trim().length < 4}
				>
					Send
				</Button>
			</Stack>
		</Box>
	);
}

function SettingsPane({
	project,
	onSaved,
}: {
	project: Project;
	onSaved: () => void;
}) {
	const [baseBranch, setBaseBranch] = useState(project.baseBranch);
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
			onSaved();
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Couldn't save settings");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Box sx={{ p: 2, overflowY: "auto" }}>
			<Card sx={{ p: 2, maxWidth: 560 }}>
				<Stack spacing={2}>
					<TextField
						size="small"
						label="Repository"
						value={project.repo}
						disabled
						helperText="Repo is fixed at creation."
					/>
					<TextField
						size="small"
						label="Base branch"
						value={baseBranch}
						onChange={(e) => setBaseBranch(e.target.value)}
					/>
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
						control={
							<Switch
								checked={autoMerge}
								onChange={(e) => setAutoMerge(e.target.checked)}
							/>
						}
						label="Auto-merge passing PRs to main (prod)"
					/>
					<FormControlLabel
						control={
							<Switch
								checked={enabled}
								onChange={(e) => setEnabled(e.target.checked)}
							/>
						}
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
					<Button variant="contained" disabled={busy} onClick={() => void save()}>
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
				<Typography variant="caption" sx={{ opacity: 0.6 }}>
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
					sx={{ mt: 1.5 }}
					disabled={busy}
					onClick={() => onQueue(d)}
				>
					Queue as spec:ready
				</Button>
			</Card>
		</Box>
	);
}
