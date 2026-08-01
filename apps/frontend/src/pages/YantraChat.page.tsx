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
import { useCallback, useState } from "react";

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

export default function YantraChatPage() {
	const { projects, selectedId, loading, reload } = useProjects();
	const [tab, setTab] = useState<"chat" | "settings">("chat");
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
				sx={{ px: { xs: 2, md: 3 }, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}
			>
				<Box sx={{ flex: 1, minWidth: 0 }}>
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
					}}
				>
					{(["chat", "settings"] as const).map((t) => (
						<Button
							key={t}
							size="small"
							disableElevation
							variant={tab === t ? "contained" : "text"}
							onClick={() => setTab(t)}
							sx={{
								borderRadius: 2,
								minWidth: 82,
								color: tab === t ? undefined : "text.secondary",
							}}
						>
							{t === "chat" ? "Chat" : "Settings"}
						</Button>
					))}
				</Box>
			</Stack>

			<Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
				{tab === "chat" ? (
					<ChatPane key={selected.id} project={selected} />
				) : (
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
